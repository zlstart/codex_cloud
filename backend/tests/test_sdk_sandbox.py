"""Application policy around the SDK's own Docker execution implementation."""
import importlib
from pathlib import Path

import pytest


def sdk():
    return importlib.import_module("app.sdk_sandbox")


def test_container_policy_scopes_mounts_and_never_inherits_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("FAMSUN_SANDBOX_UID", "1000")
    monkeypatch.setenv("FAMSUN_SANDBOX_GID", "1000")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-enter-container")
    workspace = tmp_path / "chat-a"
    workspace.mkdir()
    (workspace / "uploads").mkdir()

    class Containers:
        def create(self, **kwargs):
            return kwargs

    policy = sdk().SandboxPolicy.from_environment(workspace)
    result = sdk().PolicyContainers(Containers(), policy).create(
        image="test-image", command=["-f", "/dev/null"], environment={"LANG": "C.UTF-8"},
    )
    mounts = {mount["Target"]: mount for mount in result["mounts"]}
    assert set(mounts) == {"/workspace", "/workspace/uploads"}
    assert mounts["/workspace"]["Source"] == str(workspace)
    assert mounts["/workspace/uploads"]["ReadOnly"] is True
    assert result["user"] == "1000:1000"
    assert result["read_only"] is True
    assert result["cap_drop"] == ["ALL"]
    assert result["security_opt"] == ["no-new-privileges:true"]
    assert result["mem_limit"] == result["memswap_limit"] == "512m"
    assert result["nano_cpus"] == 1_000_000_000 and result["pids_limit"] == 64
    assert result.get("network_mode") != "none"
    assert "noexec" not in result["tmpfs"]["/tmp"]
    assert "must-not-enter-container" not in str(result)
    assert "OPENAI_API_KEY" not in result["environment"]


def test_policy_rejects_root_and_unexpected_extra_mounts(tmp_path, monkeypatch):
    monkeypatch.setenv("FAMSUN_SANDBOX_UID", "0")
    with pytest.raises(ValueError, match="root"):
        sdk().SandboxPolicy.from_environment(tmp_path)
    monkeypatch.setenv("FAMSUN_SANDBOX_UID", "1000")
    policy = sdk().SandboxPolicy.from_environment(tmp_path)
    with pytest.raises(ValueError, match="mount"):
        sdk().PolicyContainers(None, policy).create(mounts=[{"Target": "/etc", "Source": "/etc"}])


def test_skill_reset_preserves_user_files_and_does_not_follow_symlinks(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "outputs").mkdir()
    (workspace / "outputs/report.md").write_text("keep")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "private.md").write_text("private")
    (workspace / ".famsun-skills").symlink_to(outside, target_is_directory=True)
    sdk().prepare_workspace(workspace)
    assert (outside / "private.md").read_text() == "private"
    assert (workspace / "outputs/report.md").read_text() == "keep"
    assert not (workspace / ".famsun-skills").is_symlink()
    assert list((workspace / ".famsun-skills").iterdir()) == []
    (workspace / ".famsun-skills/obsolete.md").write_text("old")
    sdk().prepare_workspace(workspace)
    assert list((workspace / ".famsun-skills").iterdir()) == []


def test_native_skills_only_materialize_enabled_definitions():
    from agents.sandbox import Manifest

    capability = sdk().build_skills([
        {"id": "analysis", "type": "skill", "name": "Analysis", "description": "Inspect data",
         "content": "# Analysis\nRead real data."},
        {"id": "disabled", "type": "skill", "enabled": False, "content": "do not expose"},
        {"id": "remote", "type": "mcp", "content": "not a skill"},
    ], skills_path=".famsun-skills/child")
    manifest = capability.process_manifest(Manifest())
    assert {str(path) for path in manifest.entries} == {".famsun-skills/child/analysis"}
    entry = manifest.entries[Path(".famsun-skills/child/analysis")]
    assert b"Read real data." in entry.children["SKILL.md"].content
    assert sdk().build_skills([]) is None


def test_skills_reject_escaping_staging_namespace():
    with pytest.raises(ValueError):
        sdk().build_skills([{"id": "x", "type": "skill", "content": "x"}], skills_path="outputs")


async def test_native_session_is_deleted_after_cancel(tmp_path, monkeypatch):
    import asyncio

    module = sdk()
    calls = []

    class Docker:
        containers = object()
        def close(self):
            calls.append("close")

    class Session:
        async def start(self):
            calls.append("start")
        async def aclose(self):
            calls.append("aclose")

    class Client:
        def __init__(self, docker):
            pass
        async def create(self, **kwargs):
            return Session()
        async def delete(self, session):
            calls.append("delete")

    monkeypatch.setattr(module.docker, "from_env", lambda **kwargs: Docker())
    monkeypatch.setattr(module, "DockerSandboxClient", Client)
    with pytest.raises(asyncio.CancelledError):
        async with module.open_chat_sandbox(tmp_path, chat_id="a", user_id="u"):
            raise asyncio.CancelledError
    assert calls == ["start", "aclose", "delete", "close"]


async def test_aggregate_quota_interrupts_run_and_deletes_native_session(tmp_path, monkeypatch):
    import asyncio

    from app.sandbox import SandboxError

    module = sdk()
    calls = []
    class Docker:
        containers = object()
        def close(self):
            calls.append("close")
    class Session:
        async def start(self):
            pass
        async def aclose(self):
            calls.append("aclose")
    class Client:
        def __init__(self, docker):
            pass
        async def create(self, **kwargs):
            return Session()
        async def delete(self, session):
            calls.append("delete")
    monkeypatch.setattr(module.docker, "from_env", lambda **kwargs: Docker())
    monkeypatch.setattr(module, "DockerSandboxClient", Client)
    monkeypatch.setenv("MAX_SESSION_MB", "1")
    with pytest.raises(SandboxError, match="容量"):
        async with asyncio.timeout(2):
            async with module.open_chat_sandbox(tmp_path, chat_id="a", user_id="u"):
                with (tmp_path / "outputs/large.bin").open("wb") as stream:
                    stream.truncate(2 * 1024 * 1024)
                await asyncio.Event().wait()
    assert calls == ["aclose", "delete", "close"]
