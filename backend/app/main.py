from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import re
import shutil
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote, urlsplit

from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from starlette.background import BackgroundTask

from .auth import (
    COOKIE,
    admin_user,
    current_user,
    hash_password,
    set_login,
    token_hash,
    user_json,
    verify_password,
)
from .config import Settings
from .db import Database
from .extensions import validate_mcp_url
from .models import (
    AgentRun,
    Approval,
    AppSetting,
    Artifact,
    ChatSession,
    Extension,
    ExtensionPreference,
    Login,
    Message,
    RunEvent,
    User,
    now,
    uid,
)
from .sandbox import SandboxError, cleanup_orphaned_containers, open_safe_file
from .schemas import (
    ApproveRun,
    CreateMCP,
    CreateRun,
    CreateSession,
    CreateSkill,
    LoginInput,
    PatchSession,
    PatchSettings,
    RegisterInput,
    ToggleExtension,
)
from .service import (
    ACTIVE,
    TERMINAL,
    RunService,
    artifact_json,
    owned_artifact,
    owned_run,
    owned_session,
    run_json,
    safe_path,
    session_json,
)


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or Settings()
    database = Database(config.database_url)
    service = RunService(database, config)

    @asynccontextmanager
    async def lifespan(app):
        database.initialize()
        if config.sandbox_backend == "docker":
            await cleanup_orphaned_containers(config.data_dir)
        service.recover()
        app.state.sandbox_available = False
        if config.sandbox_backend == "docker" and shutil.which("docker"):
            try:
                process = await asyncio.create_subprocess_exec(
                    "docker",
                    "info",
                    "--format",
                    "{{.ServerVersion}}",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                app.state.sandbox_available = await asyncio.wait_for(process.wait(), 3) == 0
            except (OSError, TimeoutError):
                if "process" in locals() and process.returncode is None:
                    process.kill()
                    await process.wait()
        yield
        await service.shutdown()
        database.engine.dispose()

    app = FastAPI(
        title="FAMSUN Agent Workspace",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.state.settings, app.state.db, app.state.service = config, database, service
    app.state.sandbox_available = False
    login_attempts: dict[str, deque] = defaultdict(deque)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        issue = exc.errors()[0]
        field = ".".join(str(part) for part in issue.get("loc", ()) if part not in {"body", "query", "path"})
        return JSONResponse({"detail": f"请求参数无效：{field} {issue.get('msg', '')}"}, status_code=422)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        length = request.headers.get("content-length", "0")
        if (
            request.method == "POST"
            and re.fullmatch(r"/api/sessions/[^/]+/files", request.url.path)
            and "content-length" not in request.headers
        ):
            return JSONResponse({"detail": "文件上传需要 Content-Length 请求头"}, status_code=411)
        if length.isdigit() and int(length) > (config.max_upload_mb + 1) * 1024 * 1024:
            return JSONResponse({"detail": "请求体超过文件上传限制"}, status_code=413)
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("origin", "").rstrip("/")
            expected = str(request.base_url).rstrip("/")
            if (
                origin and origin != expected and origin not in config.allowed_origins
            ) or request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"detail": "请求来源不受信任"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def rate_limit(request: Request):
        ip = request.client.host if request.client else "unknown"
        current = time.monotonic()
        if len(login_attempts) > 10000:
            login_attempts.clear()
        attempts = login_attempts[ip]
        while attempts and attempts[0] < current - 60:
            attempts.popleft()
        if len(attempts) >= 10:
            raise HTTPException(429, "尝试过于频繁，请一分钟后重试", headers={"Retry-After": "60"})
        attempts.append(current)

    @app.get("/health")
    async def health():
        with database.session() as db:
            db.scalar(select(func.count()).select_from(User))
        return {"status": "ok", "version": "1.0.0"}

    @app.get("/api/auth/status")
    def auth_status():
        with database.session() as db:
            exists = bool(db.scalar(select(func.count()).select_from(User)))
        return {"has_users": exists, "registration_enabled": not exists or config.registration_enabled}

    @app.post("/api/auth/register", status_code=201)
    async def register(payload: RegisterInput, request: Request, response: Response):
        rate_limit(request)
        hashed = await asyncio.to_thread(hash_password, payload.password)
        async with service.mutation_lock:
            with database.session() as db:
                exists = bool(db.scalar(select(func.count()).select_from(User)))
                if exists and not config.registration_enabled:
                    raise HTTPException(403, "当前未开放注册，请联系管理员")
                user = User(
                    email=payload.email,
                    name=payload.name,
                    password_hash=hashed,
                    role="member" if exists else "admin",
                )
                db.add(user)
                try:
                    db.commit()
                except IntegrityError:
                    raise HTTPException(409, "该邮箱已注册")
        set_login(request, response, user)
        return user_json(user)

    @app.post("/api/auth/login")
    async def login(payload: LoginInput, request: Request, response: Response):
        rate_limit(request)
        with database.session() as db:
            user = db.scalar(select(User).where(User.email == payload.email))
        encoded = user.password_hash if user else "scrypt$" + "0" * 32 + "$" + "0" * 64
        valid = await asyncio.to_thread(verify_password, payload.password, encoded)
        if not user or not valid:
            raise HTTPException(401, "邮箱或密码不正确")
        set_login(request, response, user)
        return user_json(user)

    @app.get("/api/auth/me")
    def me(user: User = Depends(current_user)):
        return user_json(user)

    @app.post("/api/auth/logout")
    def logout(request: Request, response: Response):
        token = request.cookies.get(COOKIE)
        if token:
            with database.session() as db:
                db.execute(delete(Login).where(Login.token_hash == token_hash(token)))
                db.commit()
        response.delete_cookie(COOKIE, path="/", secure=config.cookie_secure, httponly=True, samesite="lax")
        return {"ok": True}

    @app.get("/api/settings")
    def get_settings():
        return {
            "provider": {**service.provider(), "configured": bool(config.api_key)},
            "sandbox": {"backend": config.sandbox_backend, "available": app.state.sandbox_available},
            "limits": {"max_upload_mb": config.max_upload_mb, "max_turns": config.max_turns},
            "registration_enabled": config.registration_enabled,
        }

    @app.patch("/api/settings")
    def patch_settings(payload: PatchSettings, user: User = Depends(admin_user)):
        values = payload.model_dump(exclude_none=True)
        if "base_url" in values:
            url = urlsplit(values["base_url"])
            if (
                not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
                or (
                    url.scheme != "https"
                    and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"})
                )
            ):
                raise HTTPException(400, "API 地址须为 HTTPS 地址；本机服务可使用 HTTP")
            values["base_url"] = values["base_url"].rstrip("/")
        with database.session() as db:
            for key, value in values.items():
                setting = db.get(AppSetting, key)
                if setting:
                    setting.value = value
                else:
                    db.add(AppSetting(key=key, value=value))
            db.commit()
        return get_settings()

    @app.get("/api/sessions")
    def list_sessions(user: User = Depends(current_user)):
        with database.session() as db:
            return [
                session_json(s)
                for s in db.scalars(
                    select(ChatSession)
                    .where(ChatSession.user_id == user.id)
                    .order_by(ChatSession.pinned.desc(), ChatSession.updated_at.desc())
                )
            ]

    @app.post("/api/sessions", status_code=201)
    def create_session(payload: CreateSession, user: User = Depends(current_user)):
        with database.session() as db:
            session = ChatSession(user_id=user.id, title=payload.title, model=service.provider()["model"])
            db.add(session)
            db.commit()
            return session_json(session)

    @app.get("/api/sessions/{session_id}")
    def get_session(session_id: str, user: User = Depends(current_user)):
        with database.session() as db:
            session = owned_session(db, session_id, user.id)
            files = list(
                db.scalars(
                    select(Artifact).where(Artifact.session_id == session_id).order_by(Artifact.created_at)
                )
            )
            file_map = {f.id: artifact_json(f) for f in files}
            messages = [
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "created_at": m.created_at,
                    "run_id": m.run_id,
                    "attachments": [file_map[f] for f in m.attachment_ids if f in file_map],
                }
                for m in db.scalars(
                    select(Message).where(Message.session_id == session_id).order_by(Message.created_at)
                )
            ]
            runs = [
                run_json(r)
                for r in db.scalars(
                    select(AgentRun).where(AgentRun.session_id == session_id).order_by(AgentRun.created_at)
                )
            ]
            return {
                "session": session_json(session),
                "messages": messages,
                "files": list(file_map.values()),
                "runs": runs,
            }

    @app.patch("/api/sessions/{session_id}")
    def patch_session(session_id: str, payload: PatchSession, user: User = Depends(current_user)):
        with database.session() as db:
            session = owned_session(db, session_id, user.id)
            for key, value in payload.model_dump(exclude_none=True).items():
                setattr(session, key, value)
            session.updated_at = now()
            db.commit()
            return session_json(session)

    @app.delete("/api/sessions/{session_id}")
    async def delete_session(session_id: str, user: User = Depends(current_user)):
        async with service.mutation_lock:
            with database.session() as db:
                owned_session(db, session_id, user.id)
                runs = list(
                    db.scalars(
                        select(AgentRun.id).where(
                            AgentRun.session_id == session_id, AgentRun.status.in_(ACTIVE)
                        )
                    )
                )
            for run_id in runs:
                await service.cancel(run_id)
            with database.session() as db:
                db.delete(owned_session(db, session_id, user.id))
                db.commit()
            await service.delete_workspace(user.id, session_id)
        return {"ok": True}

    @app.get("/api/files")
    def list_files(user: User = Depends(current_user)):
        with database.session() as db:
            return [
                artifact_json(f)
                for f in db.scalars(
                    select(Artifact)
                    .join(ChatSession)
                    .where(ChatSession.user_id == user.id)
                    .order_by(Artifact.created_at.desc())
                )
            ]

    @app.post("/api/sessions/{session_id}/files", status_code=201)
    async def upload_file(session_id: str, file: UploadFile = File(...), user: User = Depends(current_user)):
        with database.session() as db:
            owned_session(db, session_id, user.id)
            if db.scalar(
                select(AgentRun.id).where(AgentRun.session_id == session_id, AgentRun.status.in_(ACTIVE))
            ):
                raise HTTPException(409, "任务执行期间暂不能修改文件，请先停止任务")
        original = (file.filename or "未命名文件").replace("\\", "/").split("/")[-1]
        name = re.sub(r"[\x00-\x1f\x7f]", "", original).strip(". ")[:180] or "未命名文件"
        file_id = uid()
        workspace = service.workspace(user.id, session_id)
        # Linux limits filename bytes, not Unicode characters. Preserve a useful
        # extension while keeping UUID + UTF-8 name within NAME_MAX (255 bytes).
        suffix = Path(name).suffix
        suffix = suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,12}", suffix) else ""
        stem = name[: -len(suffix)] if suffix else name
        stored_name = stem.encode("utf-8")[: 220 - len(suffix)].decode("utf-8", errors="ignore") + suffix
        relative = f"uploads/{file_id}_{stored_name}"
        path = safe_path(workspace, relative, must_exist=False)
        size = 0
        try:
            fd = open_safe_file(workspace, relative, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            with os.fdopen(fd, "wb") as handle:
                os.fchmod(handle.fileno(), 0o600)
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > config.max_upload_mb * 1024 * 1024:
                        raise HTTPException(413, f"单个文件不能超过 {config.max_upload_mb} MB")
                    handle.write(chunk)
            async with service.mutation_lock:
                with database.session() as db:
                    session = owned_session(db, session_id, user.id)
                    if db.scalar(
                        select(AgentRun.id).where(
                            AgentRun.session_id == session_id, AgentRun.status.in_(ACTIVE)
                        )
                    ):
                        raise HTTPException(409, "任务已开始，请停止后上传")
                    total = db.scalar(
                        select(func.coalesce(func.sum(Artifact.size), 0)).where(
                            Artifact.session_id == session_id
                        )
                    )
                    if total + size > config.max_session_mb * 1024 * 1024:
                        raise HTTPException(413, "会话文件空间已满，请删除部分文件")
                    artifact = Artifact(
                        id=file_id,
                        session_id=session_id,
                        name=name,
                        path=relative,
                        mime_type=mimetypes.guess_type(name)[0] or "application/octet-stream",
                        size=size,
                        kind="upload",
                    )
                    db.add(artifact)
                    session.updated_at = now()
                    db.commit()
                    return artifact_json(artifact)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        finally:
            await file.close()

    @app.get("/api/files/{file_id}/content")
    def file_content(file_id: str, download: bool = False, user: User = Depends(current_user)):
        with database.session() as db:
            artifact = owned_artifact(db, file_id, user.id)
            workspace = service.workspace(user.id, artifact.session_id)
            try:
                descriptor = open_safe_file(workspace, artifact.path)
            except (OSError, ValueError, SandboxError):
                raise HTTPException(404, "文件不存在或路径不安全")
            stream = os.fdopen(descriptor, "rb")

            def chunks():
                with stream as handle:
                    while chunk := handle.read(65536):
                        yield chunk

            # Generated HTML/SVG/PDF are always restricted even when directly opened.
            disposition = "attachment" if download else "inline"
            return StreamingResponse(
                chunks(),
                media_type=artifact.mime_type,
                background=BackgroundTask(stream.close),
                headers={
                    "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(artifact.name)}",
                    "Content-Security-Policy": "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'",
                },
            )

    @app.delete("/api/files/{file_id}")
    async def delete_file(file_id: str, user: User = Depends(current_user)):
        async with service.mutation_lock:
            with database.session() as db:
                artifact = owned_artifact(db, file_id, user.id)
                if db.scalar(
                    select(AgentRun.id).where(
                        AgentRun.session_id == artifact.session_id, AgentRun.status.in_(ACTIVE)
                    )
                ):
                    raise HTTPException(409, "任务执行期间暂不能修改文件，请先停止任务")
                path = safe_path(
                    service.workspace(user.id, artifact.session_id), artifact.path, must_exist=False
                )
                path.unlink(missing_ok=True)
                db.delete(artifact)
                db.commit()
        return {"ok": True}

    @app.post("/api/sessions/{session_id}/runs", status_code=201)
    async def create_run(session_id: str, payload: CreateRun, user: User = Depends(current_user)):
        async with service.mutation_lock:
            with database.session() as db:
                session = owned_session(db, session_id, user.id)
                previous = db.scalar(
                    select(AgentRun).where(
                        AgentRun.session_id == session_id,
                        AgentRun.client_request_id == payload.client_request_id,
                    )
                )
                if previous:
                    message = db.scalar(
                        select(Message).where(Message.run_id == previous.id, Message.role == "user")
                    )
                    if (
                        not message
                        or message.content != payload.content
                        or message.attachment_ids != payload.attachment_ids
                    ):
                        raise HTTPException(409, "请求标识已用于不同的消息")
                    return run_json(previous)
                if not config.api_key:
                    raise HTTPException(
                        503, "尚未配置模型服务密钥，请管理员设置 AGENT_API_KEY 或 OPENAI_API_KEY 后重启服务。"
                    )
                if db.scalar(
                    select(AgentRun.id).where(AgentRun.session_id == session_id, AgentRun.status.in_(ACTIVE))
                ):
                    raise HTTPException(409, "当前会话有任务正在执行")
                active = db.scalar(
                    select(func.count())
                    .select_from(AgentRun)
                    .join(ChatSession)
                    .where(ChatSession.user_id == user.id, AgentRun.status.in_(ACTIVE))
                )
                total_active = db.scalar(
                    select(func.count()).select_from(AgentRun).where(AgentRun.status.in_(ACTIVE))
                )
                if active >= 3 or total_active >= 16:
                    raise HTTPException(429, "并行任务已达到上限，请等待当前任务完成")
                for file_id in payload.attachment_ids:
                    artifact = owned_artifact(db, file_id, user.id)
                    if artifact.session_id != session_id:
                        raise HTTPException(400, "附件不属于当前会话")
                run = AgentRun(session_id=session_id, client_request_id=payload.client_request_id)
                db.add(run)
                db.flush()
                db.add(
                    Message(
                        session_id=session_id,
                        role="user",
                        content=payload.content,
                        run_id=run.id,
                        attachment_ids=payload.attachment_ids,
                    )
                )
                if session.title == "新对话":
                    session.title = payload.content.replace("\n", " ")[:40]
                session.updated_at = now()
                session.model = service.provider()["model"]
                db.commit()
                result = run_json(run)
            service.launch(run.id)
            return result

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str, user: User = Depends(current_user)):
        with database.session() as db:
            return run_json(owned_run(db, run_id, user.id))

    @app.get("/api/runs/{run_id}/events")
    async def events(run_id: str, request: Request, after: int = 0, user: User = Depends(current_user)):
        with database.session() as db:
            owned_run(db, run_id, user.id)
        try:
            cursor = max(0, after, int(request.headers.get("last-event-id", "0")))
        except ValueError:
            raise HTTPException(400, "无效的事件游标")

        async def stream():
            nonlocal cursor
            last_ping = time.monotonic()
            while not await request.is_disconnected():
                with database.session() as db:
                    run = db.get(AgentRun, run_id)
                    rows = list(
                        db.scalars(
                            select(RunEvent)
                            .where(RunEvent.run_id == run_id, RunEvent.id > cursor)
                            .order_by(RunEvent.id)
                            .limit(200)
                        )
                    )
                    status = run.status if run else "failed"
                for event in rows:
                    cursor = event.id
                    yield f"id: {event.id}\nevent: {event.event}\ndata: {json.dumps(event.data, ensure_ascii=False)}\n\n"
                if not rows and status in TERMINAL:
                    break
                if time.monotonic() - last_ping > 15:
                    yield ": keepalive\n\n"
                    last_ping = time.monotonic()
                await asyncio.sleep(0.15 if rows else 0.35)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
        )

    @app.post("/api/runs/{run_id}/cancel")
    async def cancel_run(run_id: str, user: User = Depends(current_user)):
        with database.session() as db:
            owned_run(db, run_id, user.id)
        await service.cancel(run_id)
        with database.session() as db:
            return run_json(owned_run(db, run_id, user.id))

    @app.post("/api/runs/{run_id}/approve")
    async def approve_run(run_id: str, payload: ApproveRun, user: User = Depends(current_user)):
        with database.session() as db:
            run = owned_run(db, run_id, user.id)
            approval = db.get(Approval, payload.approval_id)
            if not approval or approval.run_id != run_id:
                raise HTTPException(404, "审批请求不存在")
            if approval.approved is not None:
                raise HTTPException(409, "该请求已经处理")
            future = service.approvals.get(payload.approval_id)
            if run.status not in ACTIVE or not future or future.done():
                raise HTTPException(409, "审批请求已经过期")
            approval.approved = payload.approved
            db.commit()
            future.set_result(payload.approved)
        await service.emit(
            run_id, "approval.resolved", {"id": payload.approval_id, "approved": payload.approved}
        )
        return {"ok": True}

    @app.get("/api/extensions")
    def get_extensions(user: User = Depends(current_user)):
        values = service.extensions(user.id)
        return {
            "skills": [v for v in values if v["type"] == "skill"],
            "mcp_servers": [v for v in values if v["type"] == "mcp"],
        }

    @app.post("/api/extensions/skills", status_code=201)
    def add_skill(payload: CreateSkill, user: User = Depends(admin_user)):
        with database.session() as db:
            extension = Extension(**payload.model_dump(), type="skill")
            db.add(extension)
            db.commit()
            extension_id = extension.id
        return next(v for v in service.extensions(user.id) if v["id"] == extension_id)

    @app.post("/api/extensions/mcp", status_code=201)
    def add_mcp(payload: CreateMCP, user: User = Depends(admin_user)):
        try:
            validate_mcp_url(payload.url, config.allowed_mcp_hosts)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        with database.session() as db:
            extension = Extension(**payload.model_dump(), type="mcp")
            db.add(extension)
            db.commit()
            extension_id = extension.id
        return next(v for v in service.extensions(user.id) if v["id"] == extension_id)

    @app.get("/api/extensions/skills/{extension_id}")
    def get_skill(extension_id: str, user: User = Depends(current_user)):
        value = next(
            (
                v
                for v in service.extensions(user.id, include_content=True)
                if v["id"] == extension_id and v["type"] == "skill"
            ),
            None,
        )
        if not value:
            raise HTTPException(404, "Skill 不存在")
        return value

    @app.patch("/api/extensions/{extension_id}")
    def toggle_extension(extension_id: str, payload: ToggleExtension, user: User = Depends(current_user)):
        with database.session() as db:
            if not db.get(Extension, extension_id):
                raise HTTPException(404, "能力不存在")
            preference = db.get(ExtensionPreference, (user.id, extension_id))
            if preference:
                preference.enabled = payload.enabled
            else:
                db.add(
                    ExtensionPreference(user_id=user.id, extension_id=extension_id, enabled=payload.enabled)
                )
            db.commit()
        return next(v for v in service.extensions(user.id) if v["id"] == extension_id)

    @app.delete("/api/extensions/{extension_id}")
    def remove_extension(extension_id: str, user: User = Depends(admin_user)):
        with database.session() as db:
            item = db.get(Extension, extension_id)
            if not item:
                raise HTTPException(404, "能力不存在")
            if item.builtin:
                raise HTTPException(400, "内置能力可关闭，无需删除")
            db.delete(item)
            db.commit()
        return {"ok": True}

    if config.frontend_dist.is_dir():
        if (config.frontend_dist / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=config.frontend_dist / "assets"), name="assets")

        @app.get("/{path:path}")
        async def frontend(path: str):
            if path.startswith("api/"):
                raise HTTPException(404, "接口不存在")
            candidate = config.frontend_dist / path
            if (
                path
                and candidate.resolve().is_relative_to(config.frontend_dist.resolve())
                and candidate.is_file()
            ):
                return FileResponse(candidate)
            return FileResponse(config.frontend_dist / "index.html")

    return app


app = create_app()
