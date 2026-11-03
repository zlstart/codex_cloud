from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import mimetypes
import os
import shutil
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, select

from .config import Settings
from .db import Database
from .models import (
    AgentRun,
    Approval,
    AppSetting,
    Artifact,
    ChatSession,
    Extension,
    ExtensionPreference,
    Message,
    RunEvent,
    User,
    now,
    uid,
)
from .sandbox import SandboxError, open_safe_file

logger = logging.getLogger(__name__)
ACTIVE = {"queued", "running", "awaiting_approval"}
TERMINAL = {"completed", "failed", "cancelled"}


def session_json(item: ChatSession) -> dict:
    return {key: getattr(item, key) for key in ("id", "title", "created_at", "updated_at", "model", "pinned")}


def run_json(item: AgentRun) -> dict:
    return {
        key: getattr(item, key) for key in ("id", "session_id", "status", "error", "created_at", "updated_at")
    }


def artifact_json(item: Artifact) -> dict:
    return {
        **{
            key: getattr(item, key)
            for key in ("id", "session_id", "name", "mime_type", "size", "kind", "created_at")
        },
        "url": f"/api/files/{item.id}/content",
    }


def owned_session(db, session_id: str, user_id: str) -> ChatSession:
    session = db.get(ChatSession, session_id)
    if not session or session.user_id != user_id:
        raise HTTPException(404, "会话不存在")
    return session


def owned_run(db, run_id: str, user_id: str) -> AgentRun:
    run = db.get(AgentRun, run_id)
    if not run:
        raise HTTPException(404, "任务不存在")
    owned_session(db, run.session_id, user_id)
    return run


def owned_artifact(db, file_id: str, user_id: str) -> Artifact:
    artifact = db.get(Artifact, file_id)
    if not artifact:
        raise HTTPException(404, "文件不存在")
    owned_session(db, artifact.session_id, user_id)
    return artifact


def safe_path(root: Path, relative: str, *, must_exist: bool = True) -> Path:
    path = Path(relative)
    if path.is_absolute() or not path.parts or any(p in {"..", "."} for p in path.parts):
        raise HTTPException(400, "无效的文件路径")
    candidate = root / path
    current = root
    if root.is_symlink():
        raise HTTPException(400, "不支持符号链接")
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise HTTPException(400, "不支持符号链接")
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise HTTPException(400, "文件路径超出会话空间")
    if must_exist and not candidate.is_file():
        raise HTTPException(404, "文件已不存在")
    return candidate


class RunService:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self.tasks: dict[str, asyncio.Task] = {}
        self.cancellations: dict[str, asyncio.Event] = {}
        self.approvals: dict[str, asyncio.Future] = {}
        self.mutation_lock = asyncio.Lock()

    def workspace(self, user_id: str, session_id: str) -> Path:
        if any(
            not value or any(c not in "0123456789abcdef" for c in value) for value in (user_id, session_id)
        ):
            raise ValueError("Invalid workspace identity")
        root = self.settings.data_dir / "workspaces" / user_id / session_id
        for directory in (root, root / "uploads", root / "outputs"):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        return root

    def provider(self) -> dict:
        values = {
            "base_url": self.settings.base_url,
            "model": self.settings.model,
            "compaction_threshold": self.settings.compaction_threshold,
        }
        with self.db.session() as db:
            for row in db.scalars(select(AppSetting)).all():
                if row.key in values:
                    values[row.key] = int(row.value) if row.key == "compaction_threshold" else row.value
        return {**values, "api_mode": "responses"}

    def extensions(self, user_id: str, *, include_content: bool = False) -> list[dict]:
        with self.db.session() as db:
            user = db.get(User, user_id)
            preferences = {
                p.extension_id: p.enabled
                for p in db.scalars(select(ExtensionPreference).where(ExtensionPreference.user_id == user_id))
            }
            result = []
            for item in db.scalars(select(Extension).order_by(Extension.type, Extension.name)):
                value = {
                    "id": item.id,
                    "name": item.name,
                    "description": item.description,
                    "type": item.type,
                    "enabled": preferences.get(item.id, True),
                    "status": "available",
                    "builtin": item.builtin,
                    "editable": bool(user and user.role == "admin"),
                }
                if item.type == "subagent":
                    value["config"] = {
                        key: entry for key, entry in (item.config or {}).items() if key != "instructions"
                    }
                if include_content:
                    value.update(
                        content=item.content, url=item.url, token_env=item.token_env, config=item.config or {}
                    )
                result.append(value)
            return result

    def recover(self):
        with self.db.session() as db:
            obsolete_mode = db.get(AppSetting, "api_mode")
            if obsolete_mode:
                obsolete_mode.value = "responses"
            for run in db.scalars(select(AgentRun).where(AgentRun.status.in_(ACTIVE))):
                run.status = "failed"
                run.error = "服务已重启，此任务已中断。请重新发送消息。"
                run.updated_at = now()
                db.add(RunEvent(run_id=run.id, event="run.failed", data={"error": run.error}))
            db.commit()
        try:
            from .extensions import BUILTIN_SKILLS, BUILTIN_SUBAGENTS
        except ImportError:
            BUILTIN_SKILLS = []
            BUILTIN_SUBAGENTS = []
        with self.db.session() as db:
            for item in BUILTIN_SKILLS:
                existing = db.get(Extension, item["id"])
                if not existing:
                    db.add(
                        Extension(
                            id=item["id"],
                            name=item["name"],
                            description=item.get("description", ""),
                            content=item["content"],
                            type="skill",
                            builtin=True,
                            config={"bundle_version": 2},
                        )
                    )
                elif not (existing.config or {}).get("bundle_version") and not (existing.config or {}).get(
                    "user_modified"
                ):
                    existing.content = item["content"]
                    existing.config = {**(existing.config or {}), "bundle_version": 2}
            for item in BUILTIN_SUBAGENTS:
                if not db.get(Extension, item["id"]):
                    db.add(Extension(**item, type="subagent", builtin=True))
            db.commit()

    async def shutdown(self):
        for event in self.cancellations.values():
            event.set()
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def emit(self, run_id: str, event: str, data: dict):
        # Bound untrusted tool output before durable storage and SSE delivery.
        encoded = json.dumps(data, ensure_ascii=False, default=str)
        if len(encoded) > 200000:
            data = dict(data)
            for field in ("arguments", "output", "text", "delta"):
                if field not in data:
                    continue
                value = data[field]
                rendered = (
                    value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
                )
                if len(rendered) > 45000:
                    preview = rendered[:45000] + "\n[内容已截断]"
                    data[field] = (
                        {"preview": preview, "truncated": True}
                        if field == "arguments" and isinstance(value, dict)
                        else preview
                    )
            data["truncated"] = True
            encoded = json.dumps(data, ensure_ascii=False, default=str)
        if len(encoded) > 200000:
            identity = {
                key: data[key]
                for key in (
                    "item_id",
                    "id",
                    "tool",
                    "call_id",
                    "agent_id",
                    "agent_name",
                    "parent_call_id",
                    "phase",
                    "name",
                    "status",
                )
                if key in data
            }
            data = {**identity, "output": encoded[:180000] + "\n[输出已截断]", "truncated": True}
        with self.db.session() as db:
            if db.get(AgentRun, run_id):
                db.add(RunEvent(run_id=run_id, event=event, data=data))
                db.commit()

    async def register_output(self, run_id: str, workspace: Path, relative: str):
        if not relative.startswith("outputs/"):
            return
        path = safe_path(workspace, relative)
        fd = open_safe_file(workspace, relative, output_only=True)
        try:
            size = os.fstat(fd).st_size
        finally:
            os.close(fd)
        if size > self.settings.max_upload_mb * 1024 * 1024:
            raise ValueError("生成文件超过单文件大小限制")
        with self.db.session() as db:
            run = db.get(AgentRun, run_id)
            if not run:
                return
            existing = db.scalar(
                select(Artifact).where(Artifact.session_id == run.session_id, Artifact.path == relative)
            )
            total = db.scalar(
                select(func.coalesce(func.sum(Artifact.size), 0)).where(Artifact.session_id == run.session_id)
            )
            if total - (existing.size if existing else 0) + size > self.settings.max_session_mb * 1024 * 1024:
                raise ValueError("会话文件空间已达到容量限制")
            if existing:
                existing.size = size
                existing.created_at = now()
                artifact = existing
            else:
                artifact = Artifact(
                    session_id=run.session_id,
                    name=path.name,
                    path=relative,
                    mime_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                    size=size,
                    kind="output",
                )
                db.add(artifact)
            db.commit()
            data = artifact_json(artifact)
        await self.emit(run_id, "artifact.created", {"artifact": data})

    async def approval(self, run_id: str, tool: str, arguments: dict) -> bool:
        approval_id = uid()
        future = asyncio.get_running_loop().create_future()
        self.approvals[approval_id] = future
        with self.db.session() as db:
            db.add(Approval(id=approval_id, run_id=run_id, tool=tool, arguments=arguments))
            run = db.get(AgentRun, run_id)
            run.status = "awaiting_approval"
            run.updated_at = now()
            db.commit()
        await self.emit(
            run_id, "approval.required", {"id": approval_id, "tool": tool, "arguments": arguments}
        )
        try:
            approved = await asyncio.wait_for(future, timeout=self.settings.max_runtime_seconds)
            return bool(approved)
        finally:
            self.approvals.pop(approval_id, None)
            with self.db.session() as db:
                run = db.get(AgentRun, run_id)
                if run and run.status == "awaiting_approval":
                    run.status = "running"
                    run.updated_at = now()
                    db.commit()

    def launch(self, run_id: str):
        cancel_event = asyncio.Event()
        self.cancellations[run_id] = cancel_event
        self.tasks[run_id] = asyncio.create_task(self.execute(run_id, cancel_event))

    async def finish(
        self,
        run_id: str,
        status: str,
        error: str | None = None,
        content: str | None = None,
        final_item_ids: list[str] | None = None,
    ):
        with self.db.session() as db:
            run = db.get(AgentRun, run_id)
            if not run or run.status in TERMINAL:
                return
            run.status, run.error, run.updated_at = status, error, now()
            payload = {"error": error} if error else {}
            if content is not None:
                message = Message(session_id=run.session_id, run_id=run_id, role="assistant", content=content)
                db.add(message)
                db.flush()
                payload.update(message_id=message.id, final_item_ids=final_item_ids or [])
            session = db.get(ChatSession, run.session_id)
            session.updated_at = now()
            db.add(RunEvent(run_id=run_id, event=f"run.{status}", data=payload))
            db.commit()

    async def execute(self, run_id: str, cancel_event: asyncio.Event):
        try:
            from .runtime import RuntimeConfig
            from .runtime_worker import run_agent_in_worker

            with self.db.session() as db:
                run = db.get(AgentRun, run_id)
                if not run or run.status != "queued":
                    return
                session = db.get(ChatSession, run.session_id)
                user_id = session.user_id
                messages = []
                for message in db.scalars(
                    select(Message).where(Message.session_id == session.id).order_by(Message.created_at)
                ):
                    content = message.content
                    for file_id in message.attachment_ids:
                        artifact = db.get(Artifact, file_id)
                        if artifact and artifact.session_id == session.id:
                            content += f"\n[附件: {artifact.name}; 工作区路径: {artifact.path}]"
                    messages.append({"role": message.role, "content": content})
                run.status, run.updated_at = "running", now()
                db.commit()
                workspace = self.workspace(user_id, session.id)
            await self.emit(run_id, "run.started", {})
            final_item_ids = []

            async def emit(event: str, data: dict):
                if cancel_event.is_set():
                    raise asyncio.CancelledError
                if event == "artifact.discovered":
                    await self.register_output(run_id, workspace, data["path"])
                else:
                    if event == "text.phase" and data.get("phase") == "final" and data.get("item_id"):
                        final_item_ids.append(data["item_id"])
                    await self.emit(run_id, event, data)

            config = RuntimeConfig(
                **self.provider(),
                api_key=self.settings.api_key,
                sandbox_backend=self.settings.sandbox_backend,
                max_turns=self.settings.max_turns,
                max_runtime_seconds=self.settings.max_runtime_seconds,
                extensions=[e for e in self.extensions(user_id, include_content=True) if e["enabled"]],
                allowed_mcp_hosts=self.settings.allowed_mcp_hosts,
                state_dir=self.settings.data_dir / "history",
                user_id=user_id,
                session_id=session.id,
                run_id=run_id,
                tracing_enabled=self.settings.tracing_enabled,
                tracing_api_key=self.settings.tracing_api_key,
                tracing_workflow_name=self.settings.tracing_workflow_name,
                tracing_include_sensitive_data=self.settings.tracing_include_sensitive_data,
            )
            async with asyncio.timeout(self.settings.max_runtime_seconds):
                result = await run_agent_in_worker(
                    config=config,
                    workspace=workspace,
                    messages=messages,
                    emit=emit,
                    cancel_event=cancel_event,
                    request_approval=lambda tool, args: self.approval(run_id, tool, args),
                )
            if cancel_event.is_set():
                raise asyncio.CancelledError
            await self.finish(run_id, "completed", content=str(result), final_item_ids=final_item_ids)
        except asyncio.CancelledError:
            await self.finish(run_id, "cancelled")
        except TimeoutError:
            await self.finish(run_id, "failed", "任务执行超时，请缩小任务范围后重试。")
        except Exception as exc:
            # Never persist SDK exception repr/body: upstream errors may contain credentials.
            name = type(exc).__name__
            safe = {
                "AuthenticationError": "模型服务认证失败，请管理员检查 API 密钥。",
                "PermissionDeniedError": "模型服务拒绝访问，请检查模型权限。",
                "RateLimitError": "模型服务请求过于频繁或配额不足，请稍后重试。",
                "APIConnectionError": "无法连接模型服务，请检查 API 地址和网络。",
                "BadRequestError": "模型服务拒绝了 Responses 请求。请确认支持自定义工具、流式工具往返及 context_management 上下文压缩。",
                "MaxTurnsExceeded": "任务达到最大工具轮数，请拆分任务后继续。",
                "ModelBehaviorError": "模型返回了无法执行的工具请求或响应格式。已保留工作空间文件，请重试或调整模型。",
            }.get(name, "任务执行失败，请检查模型配置及沙箱服务。")
            if name == "AgentRuntimeError" or isinstance(exc, SandboxError):
                safe = str(exc)
            logger.warning("Agent run %s failed (%s)", run_id, name)
            await self.finish(run_id, "failed", safe)
        finally:
            self.tasks.pop(run_id, None)
            self.cancellations.pop(run_id, None)

    async def cancel(self, run_id: str):
        event = self.cancellations.get(run_id)
        if event:
            event.set()
        task = self.tasks.get(run_id)
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self.finish(run_id, "cancelled")

    async def delete_workspace(self, user_id: str, session_id: str):
        root = self.settings.data_dir / "workspaces" / user_id / session_id
        if root.exists():
            await asyncio.to_thread(shutil.rmtree, root)
        # SDK histories are deliberately outside the model-visible workspace.
        history = self.settings.data_dir / "history" / user_id / f"{session_id}.sqlite3"
        for suffix in ("", "-wal", "-shm", "-journal"):
            history.with_name(history.name + suffix).unlink(missing_ok=True)
