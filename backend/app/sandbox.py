"""Safe application file delivery and deployment-owned orphan reconciliation.

Model execution is provided by the native Agents SDK in sdk_sandbox.py. These
helpers protect upload/download endpoints and bounded artifact/quota scanning.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import stat
from pathlib import Path, PurePosixPath


class SandboxError(RuntimeError):
    """A safe-to-display workspace or container error."""


def deployment_label(data_dir: Path) -> str:
    configured = os.getenv("FAMSUN_DEPLOYMENT_ID")
    return configured or hashlib.sha256(str(data_dir.absolute()).encode()).hexdigest()[:20]


async def cleanup_orphaned_containers(data_dir: Path) -> None:
    """Reconcile only containers belonging to this single-worker deployment."""
    try:
        process = await asyncio.create_subprocess_exec(
            "docker", "ps", "-aq", "--filter", "label=app=famsun-agent", "--filter",
            f"label=famsun.deployment={deployment_label(data_dir)}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        output, _ = await asyncio.wait_for(process.communicate(), 5)
        ids = [line for line in output.decode().splitlines() if line.isalnum() and len(line) <= 64]
        if ids:
            remove = await asyncio.create_subprocess_exec(
                "docker", "rm", "-f", *ids, stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(remove.wait(), 5)
    except (OSError, TimeoutError):
        return


def safe_path(workspace: Path, path: str, *, output_only: bool = False) -> Path:
    """Resolve a relative workspace path without following any symlink.

    Paths from models are POSIX paths. Absolute /workspace/... is accepted to
    match paths visible inside the container, but never an arbitrary host path.
    """
    if not isinstance(path, str) or not path or "\x00" in path or "\\" in path:
        raise SandboxError("文件路径无效。")
    path = path.removeprefix("/workspace/")
    pure = PurePosixPath(path)
    if pure.is_absolute() or ".." in pure.parts:
        raise SandboxError("只允许访问当前会话工作空间中的文件。")
    if output_only and (not pure.parts or pure.parts[0] != "outputs"):
        raise SandboxError("生成文件必须保存到 outputs/ 目录。")
    root = workspace.absolute()
    if root.is_symlink() or root.resolve() != root:
        raise SandboxError("工作空间不能包含符号链接。")
    candidate = root
    for part in pure.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise SandboxError("不允许访问符号链接。")
    if candidate != root and root not in candidate.parents:
        raise SandboxError("文件路径超出当前会话。")
    return candidate


def _workspace_entries(workspace: Path, *, max_entries: int):
    """Bounded descriptor-based traversal, including links and directories."""
    root = safe_path(workspace, ".")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    stack = [(fd, os.scandir(fd), "")]
    visited = 0
    try:
        while stack and visited < max_entries:
            parent_fd, iterator, prefix = stack[-1]
            try:
                entry = next(iterator)
            except StopIteration:
                iterator.close()
                os.close(parent_fd)
                stack.pop()
                continue
            visited += 1
            path = f"{prefix}/{entry.name}" if prefix else entry.name
            try:
                info = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            yield path, info
            if stat.S_ISDIR(info.st_mode) and len(stack) < 64:
                try:
                    child_fd = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                       dir_fd=parent_fd)
                    stack.append((child_fd, os.scandir(child_fd), path))
                except OSError:
                    continue
    finally:
        for directory_fd, iterator, _ in stack:
            iterator.close()
            os.close(directory_fd)


def regular_files(workspace: Path, *, limit: int = 500) -> list[dict]:
    """List ordinary files only, with bounded total traversal work."""
    result: list[dict] = []
    iterator = _workspace_entries(workspace, max_entries=max(2000, limit * 2))
    try:
        for path, info in iterator:
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                result.append({"path": path, "size": info.st_size, "modified_ns": info.st_mtime_ns})
                if len(result) >= limit:
                    break
    finally:
        iterator.close()
    return sorted(result, key=lambda item: item["path"])


def workspace_usage(workspace: Path, *, max_entries: int = 1000) -> tuple[int, int]:
    """Count every directory entry; account each file inode even when hardlinked.

    Returning max_entries + 1 denotes an exceeded entry budget. The scan stops
    there, so malicious directory trees cannot turn quota checks into unbounded
    host work. This is monitoring, not a filesystem-enforced disk quota.
    """
    count, total = 0, 0
    seen: set[tuple[int, int]] = set()
    for path, info in _workspace_entries(workspace, max_entries=max_entries + 1):
        count += 1
        inode = (info.st_dev, info.st_ino)
        if inode not in seen:
            total += info.st_size
            seen.add(inode)
        # Deep trees exceed our supported traversal depth and fail closed.
        if path.count("/") >= 62 and stat.S_ISDIR(info.st_mode):
            return max_entries + 1, total
    return count, total


def open_safe_file(workspace: Path, path: str, flags: int = os.O_RDONLY, *,
                   output_only: bool = False, create_parents: bool = False) -> int:
    """Open a regular file using dir-fds, safe against intermediate symlink swaps.

    The caller owns the returned descriptor. Every component is opened relative
    to a held parent descriptor with O_NOFOLLOW. In particular a model-controlled
    directory renamed during a read cannot redirect the read outside the mount.
    """
    full = safe_path(workspace, path, output_only=output_only)
    parts = full.relative_to(workspace.absolute()).parts
    if not parts:
        raise SandboxError("必须指定普通文件路径。")
    directory_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in parts[:-1]:
            if create_parents:
                with contextlib.suppress(FileExistsError):
                    os.mkdir(component, 0o700, dir_fd=directory_fd)
            child_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                               dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = child_fd
        file_fd = os.open(parts[-1], (flags & ~os.O_TRUNC) | os.O_NOFOLLOW | os.O_NONBLOCK,
                          0o600, dir_fd=directory_fd)
        info = os.fstat(file_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            os.close(file_fd)
            raise SandboxError("只能访问未链接的普通文件。")
        if flags & os.O_TRUNC:
            os.ftruncate(file_fd, 0)
        return file_fd
    except OSError as exc:
        raise SandboxError("文件不存在或无法安全访问。") from exc
    finally:
        os.close(directory_fd)


def read_text_file(workspace: Path, path: str, *, max_bytes: int = 128_000) -> str:
    try:
        fd = open_safe_file(workspace, path)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise SandboxError("只能读取普通文件。")
            if info.st_size > 8 * 1024 * 1024:
                raise SandboxError("文件较大，请使用 Python 分块处理。")
            content = stream.read(max_bytes + 1)
    except (OSError, ValueError) as exc:
        raise SandboxError("文件不存在或无法安全读取。") from exc
    suffix = "\n[文件内容已截断，请用 Python 分块读取]" if len(content) > max_bytes else ""
    return content[:max_bytes].decode("utf-8", errors="replace") + suffix


def write_text_file(workspace: Path, path: str, content: str, *, max_bytes: int = 2_000_000) -> str:
    full = safe_path(workspace, path, output_only=True)
    data = content.encode("utf-8")
    if len(data) > max_bytes:
        raise SandboxError("单次文本写入不能超过 2 MB。")
    try:
        fd = open_safe_file(workspace, path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                            output_only=True, create_parents=True)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
    except OSError as exc:
        raise SandboxError("文件写入失败。") from exc
    return full.relative_to(workspace).as_posix()
