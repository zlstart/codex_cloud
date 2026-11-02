import asyncio
import os

import pytest
from app.sandbox import (
    DockerSandbox,
    SandboxError,
    open_safe_file,
    read_text_file,
    regular_files,
    safe_path,
    workspace_usage,
    write_text_file,
)


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "workspace"
    (root / "uploads").mkdir(parents=True)
    (root / "outputs").mkdir()
    return root


@pytest.mark.parametrize("path", ["../secret", "/etc/passwd", "outputs/../../secret", "outputs\\bad", "\x00"])
def test_rejects_traversal(workspace, path):
    with pytest.raises(SandboxError):
        safe_path(workspace, path)


def test_host_file_operations_reject_links(workspace, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("outside")
    (workspace / "outputs" / "link.txt").symlink_to(secret)
    (workspace / "outputs" / "directory").symlink_to(tmp_path, target_is_directory=True)
    for path in ("outputs/link.txt", "outputs/directory/secret.txt"):
        with pytest.raises(SandboxError):
            read_text_file(workspace, path)
        with pytest.raises(SandboxError):
            write_text_file(workspace, path, "changed")
    assert secret.read_text() == "outside"
    assert regular_files(workspace) == []


def test_does_not_truncate_hardlink_target(workspace, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("preserve")
    os.link(secret, workspace / "outputs" / "linked.txt")
    with pytest.raises(SandboxError):
        write_text_file(workspace, "outputs/linked.txt", "erase")
    assert secret.read_text() == "preserve"


def test_quota_counts_hardlinks_and_stops_on_directory_budget(workspace):
    file = workspace / "outputs" / "data.bin"
    file.write_bytes(b"x" * 4096)
    os.link(file, workspace / "outputs" / "linked.bin")
    assert regular_files(workspace) == []
    count, size = workspace_usage(workspace)
    assert count == 4 and size >= 4096
    for index in range(25):
        (workspace / "outputs" / f"empty{index}").mkdir()
    count, _ = workspace_usage(workspace, max_entries=10)
    assert count == 11


def test_file_descriptor_stays_bound_when_directory_is_swapped(workspace, tmp_path):
    folder = workspace / "outputs" / "documents"
    folder.mkdir()
    (folder / "report.txt").write_text("owned file")
    opened = open_safe_file(workspace, "outputs/documents/report.txt")
    folder.rename(workspace / "outputs" / "old")
    folder.symlink_to(tmp_path, target_is_directory=True)
    (tmp_path / "report.txt").write_text("outside secret")
    with os.fdopen(opened) as file:
        assert file.read() == "owned file"


def test_read_write_nested_and_binary_limit(workspace):
    written = write_text_file(workspace, "outputs/reports/brief.md", "# 报告\n数据已核实")
    assert written == "outputs/reports/brief.md"
    assert read_text_file(workspace, "/workspace/" + written).startswith("# 报告")
    with pytest.raises(SandboxError):
        write_text_file(workspace, "uploads/changed.txt", "forbidden")
    (workspace / "uploads" / "big.txt").write_bytes(b"x" * 100)
    assert "截断" in read_text_file(workspace, "uploads/big.txt", max_bytes=10)


def test_command_enforces_isolation(workspace, monkeypatch):
    monkeypatch.setenv("FAMSUN_SANDBOX_UID", "1000")
    monkeypatch.setenv("FAMSUN_SANDBOX_GID", "1000")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-pass")
    command = DockerSandbox(workspace, timeout=30).command("test-container", ["python", "-c", "print(1)"])
    for flag in ("--network=none", "--read-only", "--cap-drop=ALL", "--memory=512m", "--cpus=1", "--pids-limit=64", "--pull=never"):
        assert flag in command
    assert "--security-opt=no-new-privileges:true" in command
    assert command[command.index("--user") + 1] == "1000:1000"
    assert any("dst=/workspace/uploads,readonly" in item for item in command)
    assert "must-not-pass" not in str(command)
    assert "HTTP_PROXY=" in command and "HTTPS_PROXY=" in command
    assert command[-7:] == ["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "30s", "python", "-c", "print(1)"]


async def test_disabled_backend_never_starts_host_process(workspace, monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("No process should start when sandbox is disabled")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    with pytest.raises(SandboxError, match="尚未启用"):
        await DockerSandbox(workspace, backend="disabled").python("print('no')", asyncio.Event())


async def test_already_cancelled_never_starts_process(workspace, monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("No process should start for cancelled run")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    event = asyncio.Event()
    event.set()
    with pytest.raises(asyncio.CancelledError):
        await DockerSandbox(workspace).python("print('no')", event)
