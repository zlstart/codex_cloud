"""Native SDK sandbox lifecycle with the application's Docker launch policy.

The SDK owns execution, PTYs, patches, image reads and Skills. Its Docker options
do not expose resource limits or bind mounts at the workspace root, so the only
Docker adaptation here adds those settings at ``containers.create``. Each run
gets a fresh container; the authenticated chat's host directory keeps its files.
"""
from __future__ import annotations

import asyncio
import math
import os
import shutil
import stat
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

import docker
from agents.sandbox import Manifest
from agents.sandbox.capabilities import Skill, Skills
from agents.sandbox.sandboxes.docker import DockerSandboxClient, DockerSandboxClientOptions
from agents.sandbox.session import SandboxSession
from docker.types import Mount, Ulimit
from requests.exceptions import ConnectionError, RequestException, Timeout

from .sandbox import SandboxError, deployment_label, safe_path, workspace_usage

SKILLS_DIRECTORY = ".famsun-skills"


def _positive_integer(name: str, value: str | int, *, maximum: int = 2**31 - 1) -> int:
    try:
        parsed = int(value)
        if isinstance(value, bool) or parsed != float(value) or not 1 <= parsed <= maximum:
            raise ValueError
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{name} must be an integer between 1 and {maximum}") from None
    return parsed


@dataclass(frozen=True)
class SandboxPolicy:
    workspace: Path
    uid: int
    gid: int
    ca_bundle: Path | None = None
    memory_mb: int = 2048
    cpus: float = 2
    pids_limit: int = 256
    nofile: int = 4096
    file_mb: int = 100
    tmp_mb: int = 512

    @classmethod
    def from_environment(cls, workspace: Path) -> SandboxPolicy:
        uid = int(os.getenv("FAMSUN_SANDBOX_UID", str(os.getuid() or 1000)))
        gid = int(os.getenv("FAMSUN_SANDBOX_GID", str(os.getgid() or 1000)))
        if uid <= 0 or gid <= 0 or max(uid, gid) > 2**31 - 1:
            raise ValueError("Sandbox must use a non-root UID and GID")
        bundle = os.getenv("FAMSUN_SANDBOX_CA_BUNDLE")
        ca_bundle = Path(bundle).resolve(strict=True) if bundle else None
        if ca_bundle is not None and not ca_bundle.is_file():
            raise ValueError("Sandbox CA bundle must be an ordinary certificate file")
        try:
            cpus = float(os.getenv("FAMSUN_SANDBOX_CPUS", "2"))
            if not math.isfinite(cpus) or not 0.001 <= cpus <= 1024:
                raise ValueError
        except ValueError:
            raise ValueError("FAMSUN_SANDBOX_CPUS must be between 0.001 and 1024") from None
        resources = {
            name: _positive_integer(env, os.getenv(env, str(default)))
            for name, env, default in (
                ("memory_mb", "FAMSUN_SANDBOX_MEMORY_MB", 2048),
                ("pids_limit", "FAMSUN_SANDBOX_PIDS_LIMIT", 256),
                ("nofile", "FAMSUN_SANDBOX_NOFILE", 4096),
                ("file_mb", "FAMSUN_SANDBOX_FILE_MB", 100),
                ("tmp_mb", "FAMSUN_SANDBOX_TMP_MB", 512),
            )
        }
        return cls(workspace=safe_path(workspace, "."), uid=uid, gid=gid,
                   ca_bundle=ca_bundle, cpus=cpus, **resources)


class PolicyContainers:
    """Adapt creation only; delegate every operation to docker-py's collection."""

    def __init__(self, containers: Any, policy: SandboxPolicy):
        self._containers = containers
        self._policy = policy
        self._attempt = uuid.uuid4().hex
        self._creation_name: str | None = None
        self._creation_returned = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._containers, name)

    def create(self, **kwargs: Any) -> Any:
        if kwargs.get("mounts") or kwargs.get("volumes") or kwargs.get("devices"):
            raise ValueError("Unexpected sandbox mount or device configuration")
        policy = self._policy
        root = safe_path(policy.workspace, ".")
        uploads = safe_path(root, "uploads")
        mounts = [
            Mount(target="/workspace", source=str(root), type="bind"),
            Mount(target="/workspace/uploads", source=str(uploads), type="bind", read_only=True),
        ]
        # This is an explicit allowlist, not a copy of the API host environment.
        environment = {
            "HOME": "/tmp", "MPLCONFIGDIR": "/tmp/matplotlib", "MPLBACKEND": "Agg",
            "PYTHONDONTWRITEBYTECODE": "1", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
        }
        if policy.ca_bundle is not None:
            mounts.append(Mount(target="/run/famsun-ca.pem", source=str(policy.ca_bundle),
                                type="bind", read_only=True))
            environment.update({key: "/run/famsun-ca.pem" for key in
                                ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "PIP_CERT")})
        self._creation_name = f"famsun-sandbox-{self._attempt}"
        kwargs.update(
            name=self._creation_name,
            labels={**(kwargs.get("labels") or {}), "famsun.attempt": self._attempt},
            user=f"{policy.uid}:{policy.gid}", working_dir="/workspace",
            read_only=True, cap_drop=["ALL"], security_opt=["no-new-privileges:true"],
            mem_limit=f"{policy.memory_mb}m", memswap_limit=f"{policy.memory_mb}m",
            nano_cpus=round(policy.cpus * 1_000_000_000), pids_limit=policy.pids_limit,
            ulimits=[Ulimit(name="nofile", soft=policy.nofile, hard=policy.nofile),
                     Ulimit(name="fsize", soft=policy.file_mb * 1024 * 1024,
                            hard=policy.file_mb * 1024 * 1024)],
            # Native SDK path-validation helpers execute from /tmp/openai-agents/bin.
            tmpfs={"/tmp": f"rw,exec,nosuid,nodev,size={policy.tmp_mb}m,mode=1777"},
            mounts=mounts, environment=environment,
            # docker-py applies the administrator's Docker proxy defaults, if present.
            use_config_proxy=True,
        )
        container = self._containers.create(**kwargs)
        self._creation_returned = True
        return container

    async def reconcile_failed_creation(self, *, timeout: float) -> bool:
        """Remove only this attempt, including a late daemon create response.

        docker-py can time out after POST create but before returning a container
        to the SDK. A known name and unguessable attempt label let us reconcile
        that narrow gap without retrying creation or touching another run.
        """
        if self._creation_name is None:
            return True
        deadline = time.monotonic() + timeout
        while True:
            try:
                container = await asyncio.to_thread(self._containers.get, self._creation_name)
            except docker.errors.NotFound:
                if self._creation_returned:
                    return True
                if time.monotonic() >= deadline:
                    return False
                await asyncio.sleep(0.25)
                continue
            except RequestException:
                return False
            labels = container.labels or {}
            if labels.get("app") != "famsun-agent" or labels.get("famsun.attempt") != self._attempt:
                return False
            try:
                await asyncio.to_thread(container.remove, force=True)
            except docker.errors.NotFound:
                pass
            except RequestException:
                return False
            return True


class PolicyDockerClient:
    def __init__(self, client: Any, policy: SandboxPolicy):
        self._client = client
        self.containers = PolicyContainers(client.containers, policy)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


def prepare_workspace(workspace: Path) -> None:
    """Reset only the app-owned skill namespace, without following symlinks."""
    workspace.mkdir(parents=True, exist_ok=True)
    root = safe_path(workspace, ".")
    for folder in ("uploads", "outputs"):
        safe_path(root, folder).mkdir(exist_ok=True)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            info = os.stat(SKILLS_DIRECTORY, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            if stat.S_ISDIR(info.st_mode):
                shutil.rmtree(SKILLS_DIRECTORY, dir_fd=root_fd)
            else:
                os.unlink(SKILLS_DIRECTORY, dir_fd=root_fd)
        os.mkdir(SKILLS_DIRECTORY, mode=0o700, dir_fd=root_fd)
    finally:
        os.close(root_fd)


def build_skills(extensions: list[dict], *, skills_path: str = SKILLS_DIRECTORY) -> Skills | None:
    """Convert enabled product definitions into the SDK's native skill entries."""
    path = PurePosixPath(skills_path)
    if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != SKILLS_DIRECTORY:
        raise ValueError("Skills must stay within the application skill staging namespace")
    skills = [Skill(name=entry["id"], description=entry.get("description") or entry.get("name", ""),
                    content=str(entry.get("content", "")))
              for entry in extensions if entry.get("type") == "skill" and entry.get("enabled", True)]
    return Skills(skills=skills, skills_path=path.as_posix()) if skills else None


@asynccontextmanager
async def open_chat_sandbox(
    workspace: Path, *, chat_id: str, user_id: str,
    max_session_mb: int | None = None, max_workspace_entries: int | None = None,
) -> AsyncIterator[SandboxSession]:
    """Yield a native session; always stop/delete it, keeping the chat's files.

    The caller must authorize the workspace and serialize runs for this chat.
    No history database, parent directory, Docker socket or model key is mounted.
    """
    prepare_workspace(workspace)
    policy = SandboxPolicy.from_environment(workspace)
    try:
        max_bytes = _positive_integer(
            "MAX_SESSION_MB", os.getenv("MAX_SESSION_MB", "2048")
            if max_session_mb is None else max_session_mb,
        ) * 1024 * 1024
        max_entries = _positive_integer(
            "MAX_WORKSPACE_ENTRIES", os.getenv("MAX_WORKSPACE_ENTRIES", "10000")
            if max_workspace_entries is None else max_workspace_entries,
        )
    except ValueError as exc:
        raise SandboxError(str(exc)) from None

    def check_quota() -> None:
        count, size = workspace_usage(workspace, max_entries=max_entries)
        if count > max_entries or size > max_bytes:
            raise SandboxError("会话工作空间达到文件数量或容量限制，任务已停止。")

    await asyncio.to_thread(check_quota)
    try:
        docker_timeout = _positive_integer(
            "FAMSUN_DOCKER_TIMEOUT_SECONDS", os.getenv("FAMSUN_DOCKER_TIMEOUT_SECONDS", "180"),
            maximum=3600,
        )
    except ValueError:
        raise SandboxError("FAMSUN_DOCKER_TIMEOUT_SECONDS 必须为 1 至 3600 秒。") from None
    try:
        raw_client = docker.from_env(timeout=docker_timeout)
    except RequestException as exc:
        raise SandboxError("无法连接 Docker 沙箱服务，请检查 Docker 服务状态。") from exc
    policy_client = PolicyDockerClient(raw_client, policy)
    client = DockerSandboxClient(policy_client)
    session = None
    failed = False
    monitor = None
    quota_error: SandboxError | None = None
    owner = asyncio.current_task()

    async def watch_quota() -> None:
        nonlocal quota_error
        while True:
            try:
                await asyncio.to_thread(check_quota)
            except (OSError, SandboxError):
                quota_error = SandboxError("会话工作空间达到容量限制或无法安全检查，任务已停止。")
                if owner is not None:
                    owner.cancel()
                return
            await asyncio.sleep(0.25)

    try:
        try:
            session = await client.create(
                manifest=Manifest(root="/workspace"),
                options=DockerSandboxClientOptions(
                    image=os.getenv("FAMSUN_SANDBOX_IMAGE", "famsun-sandbox:latest"),
                    labels={"app": "famsun-agent", "famsun.chat": chat_id, "famsun.user": user_id,
                            "famsun.deployment": deployment_label(
                                workspace.parents[2] if len(workspace.parents) > 2 else workspace.parent)},
                ),
            )
            await session.start()
        except RequestException as exc:
            if session is None and isinstance(exc, (Timeout, ConnectionError)):
                reconciliation = asyncio.create_task(
                    policy_client.containers.reconcile_failed_creation(timeout=max(60, docker_timeout))
                )
                try:
                    reconciled = await asyncio.shield(reconciliation)
                except asyncio.CancelledError:
                    await reconciliation
                    raise
                if not reconciled:
                    raise SandboxError("Docker 沙箱启动失败且清理未完成，请管理员检查 Docker 服务。") from exc
            if isinstance(exc, Timeout):
                raise SandboxError(
                    "Docker 沙箱启动超时，请检查 Docker 负载、镜像和 FAMSUN_DOCKER_TIMEOUT_SECONDS 设置。"
                ) from exc
            raise SandboxError("Docker 沙箱启动失败，请检查 Docker 服务和沙箱镜像。") from exc
        monitor = asyncio.create_task(watch_quota())
        yield session
        if quota_error is not None:
            raise quota_error
        await asyncio.to_thread(check_quota)
    except asyncio.CancelledError:
        failed = True
        if quota_error is not None:
            if owner is not None:
                owner.uncancel()
            raise quota_error from None
        raise
    except BaseException:
        failed = True
        raise
    finally:
        if monitor is not None:
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)

        async def cleanup() -> None:
            try:
                if session is not None:
                    try:
                        await session.aclose()
                    finally:
                        await client.delete(session)
            finally:
                raw_client.close()

        task = asyncio.create_task(cleanup())
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise
        except Exception as exc:
            if not failed:
                raise SandboxError("会话沙箱清理失败，请检查 Docker 服务。") from exc
