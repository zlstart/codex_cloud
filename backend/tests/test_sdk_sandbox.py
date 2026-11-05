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
    assert result["mem_limit"] == result["memswap_limit"] == "2048m"
    assert result["nano_cpus"] == 2_000_000_000 and result["pids_limit"] == 256
    assert result.get("network_mode") != "none"
    assert "noexec" not in result["tmpfs"]["/tmp"]
    assert "must-not-enter-container" not in str(result)
    assert "OPENAI_API_KEY" not in result["environment"]


def test_resource_environment_overrides_reach_docker_creation(tmp_path, monkeypatch):
    for name, value in {
        "FAMSUN_SANDBOX_MEMORY_MB": "3072",
        "FAMSUN_SANDBOX_CPUS": "1.5",
        "FAMSUN_SANDBOX_PIDS_LIMIT": "384",
        "FAMSUN_SANDBOX_NOFILE": "8192",
        "FAMSUN_SANDBOX_FILE_MB": "160",
        "FAMSUN_SANDBOX_TMP_MB": "768",
    }.items():
        monkeypatch.setenv(name, value)
    (tmp_path / "uploads").mkdir()

    class Containers:
        def create(self, **kwargs):
            return kwargs

    policy = sdk().SandboxPolicy.from_environment(tmp_path)
    result = sdk().PolicyContainers(Containers(), policy).create(image="test")
    assert result["mem_limit"] == result["memswap_limit"] == "3072m"
    assert result["nano_cpus"] == 1_500_000_000
    assert result["pids_limit"] == 384
    limits = {limit["Name"]: limit for limit in result["ulimits"]}
    assert limits["nofile"]["Soft"] == limits["nofile"]["Hard"] == 8192
    assert limits["fsize"]["Soft"] == limits["fsize"]["Hard"] == 160 * 1024 * 1024
    assert result["tmpfs"]["/tmp"] == "rw,exec,nosuid,nodev,size=768m,mode=1777"


@pytest.mark.parametrize("name,value", [
    ("FAMSUN_SANDBOX_MEMORY_MB", "0"),
    ("FAMSUN_SANDBOX_PIDS_LIMIT", "-1"),
    ("FAMSUN_SANDBOX_NOFILE", "many"),
    ("FAMSUN_SANDBOX_FILE_MB", "1.5"),
    ("FAMSUN_SANDBOX_TMP_MB", "2147483648"),
    ("FAMSUN_SANDBOX_CPUS", "nan"),
    ("FAMSUN_SANDBOX_CPUS", "inf"),
    ("FAMSUN_SANDBOX_CPUS", "0"),
    ("FAMSUN_SANDBOX_CPUS", "1025"),
])
def test_resource_environment_requires_positive_finite_limits(tmp_path, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        sdk().SandboxPolicy.from_environment(tmp_path)


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


async def test_daemon_timeout_allows_observed_slow_native_container_creation(tmp_path, monkeypatch):
    module = sdk()
    observed = {}

    class Docker:
        containers = object()
        def close(self):
            pass

    class Session:
        async def start(self):
            pass
        async def aclose(self):
            pass

    class Client:
        def __init__(self, docker):
            pass
        async def create(self, **kwargs):
            # The real vfs daemon needed 22.281 seconds for this request.
            if observed["timeout"] < 23:
                from requests.exceptions import ReadTimeout
                raise ReadTimeout("daemon create response not ready")
            return Session()
        async def delete(self, session):
            pass

    def factory(**kwargs):
        observed.update(kwargs)
        return Docker()

    monkeypatch.delenv("FAMSUN_DOCKER_TIMEOUT_SECONDS", raising=False)
    monkeypatch.setattr(module.docker, "from_env", factory)
    monkeypatch.setattr(module, "DockerSandboxClient", Client)
    async with module.open_chat_sandbox(tmp_path, chat_id="slow", user_id="u"):
        pass
    assert 23 <= observed["timeout"] <= 3600


@pytest.fixture
def fake_native_client(monkeypatch):
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
            calls.append("create")
            return Session()
        async def delete(self, session):
            calls.append("delete")

    def factory(**kwargs):
        calls.append(kwargs)
        return Docker()

    monkeypatch.setattr(module.docker, "from_env", factory)
    monkeypatch.setattr(module, "DockerSandboxClient", Client)
    return calls


async def test_configured_daemon_timeout_reaches_docker_client(tmp_path, monkeypatch, fake_native_client):
    monkeypatch.setenv("FAMSUN_DOCKER_TIMEOUT_SECONDS", "600")
    async with sdk().open_chat_sandbox(tmp_path, chat_id="chat", user_id="user"):
        pass
    assert fake_native_client[0] == {"timeout": 600}


@pytest.mark.parametrize("name,value", [
    ("MAX_SESSION_MB", "0"),
    ("MAX_WORKSPACE_ENTRIES", "-1"),
    ("FAMSUN_DOCKER_TIMEOUT_SECONDS", "3601"),
    ("FAMSUN_DOCKER_TIMEOUT_SECONDS", "0"),
])
async def test_invalid_session_limits_fail_before_docker(
    tmp_path, monkeypatch, fake_native_client, name, value,
):
    from app.sandbox import SandboxError

    monkeypatch.setenv(name, value)
    with pytest.raises(SandboxError, match=name):
        async with sdk().open_chat_sandbox(tmp_path, chat_id="chat", user_id="user"):
            pytest.fail("invalid limits must fail before opening the sandbox")
    assert fake_native_client == []


async def test_explicit_entry_quota_overrides_environment_before_creation(
    tmp_path, monkeypatch, fake_native_client,
):
    from app.sandbox import SandboxError

    monkeypatch.setenv("MAX_WORKSPACE_ENTRIES", "10000")
    (tmp_path / "input.txt").write_text("input")
    with pytest.raises(SandboxError, match="文件数量"):
        async with sdk().open_chat_sandbox(
            tmp_path, chat_id="chat", user_id="user", max_workspace_entries=3,
        ):
            pytest.fail("existing workspace entries must count against the configured quota")
    assert fake_native_client == []


async def test_explicit_byte_quota_overrides_environment_at_final_check(
    tmp_path, monkeypatch, fake_native_client,
):
    from app.sandbox import SandboxError

    monkeypatch.setenv("MAX_SESSION_MB", "2048")
    with pytest.raises(SandboxError, match="容量"):
        async with sdk().open_chat_sandbox(
            tmp_path, chat_id="chat", user_id="user", max_session_mb=1,
        ):
            with (tmp_path / "outputs/large.bin").open("wb") as stream:
                stream.truncate(2 * 1024 * 1024)
    assert fake_native_client[-3:] == ["aclose", "delete", "close"]


async def test_explicit_entry_quota_interrupts_live_work_and_deletes_session(
    tmp_path, monkeypatch, fake_native_client,
):
    import asyncio

    from app.sandbox import SandboxError

    monkeypatch.setenv("MAX_WORKSPACE_ENTRIES", "10000")
    with pytest.raises(SandboxError, match="容量"):
        async with asyncio.timeout(2):
            async with sdk().open_chat_sandbox(
                tmp_path, chat_id="chat", user_id="user", max_workspace_entries=4,
            ):
                (tmp_path / "outputs/one.txt").write_text("one")
                (tmp_path / "outputs/two.txt").write_text("two")
                await asyncio.Event().wait()
    assert fake_native_client[-3:] == ["aclose", "delete", "close"]


async def test_ambiguous_create_timeout_cleans_only_its_delayed_attempt(tmp_path, monkeypatch):
    from app.sandbox import SandboxError
    from docker.errors import NotFound
    from requests.exceptions import ReadTimeout

    module = sdk()
    calls = []

    class Container:
        def __init__(self):
            self.labels = {}
        def remove(self, force=False):
            calls.append(("remove", force))

    class Containers:
        attempts = 0
        created = None
        def create(self, **kwargs):
            self.created = kwargs
            raise ReadTimeout("PRIVATE-DOCKER-REQUEST")
        def get(self, name):
            assert name == self.created["name"]
            self.attempts += 1
            if self.attempts == 1:
                raise NotFound("creation still in progress")
            container = Container()
            container.labels = self.created["labels"]
            return container

    containers = Containers()
    class Docker:
        def __init__(self):
            self.containers = containers
        def close(self):
            calls.append("close")

    class Client:
        def __init__(self, docker):
            self.docker = docker
        async def create(self, **kwargs):
            return self.docker.containers.create(image="test", labels=kwargs["options"].labels)

    monkeypatch.setattr(module.docker, "from_env", lambda **kwargs: Docker())
    monkeypatch.setattr(module, "DockerSandboxClient", Client)
    with pytest.raises(SandboxError, match="Docker.*超时") as error:
        async with module.open_chat_sandbox(tmp_path, chat_id="slow", user_id="u"):
            pass
    assert "PRIVATE" not in str(error.value)
    assert containers.created["labels"]["famsun.attempt"]
    assert containers.attempts == 2
    assert calls == [("remove", True), "close"]


async def test_failed_creation_reconciliation_never_removes_another_owner(tmp_path):
    module = sdk()
    (tmp_path / "uploads").mkdir()
    class Other:
        def __init__(self):
            self.labels = {"app": "famsun-agent", "famsun.attempt": "different-attempt"}
        def remove(self, **kwargs):
            pytest.fail("another attempt must never be removed")
    class Containers:
        def create(self, **kwargs):
            return Other()
        def get(self, name):
            return Other()
    adapter = module.PolicyContainers(Containers(), module.SandboxPolicy.from_environment(tmp_path))
    adapter.create(image="test", labels={"app": "famsun-agent"})
    assert not await adapter.reconcile_failed_creation(timeout=1)


async def test_missing_container_after_ambiguous_create_is_not_claimed_clean(tmp_path):
    from docker.errors import NotFound
    from requests.exceptions import ReadTimeout

    module = sdk()
    (tmp_path / "uploads").mkdir()
    class Containers:
        def create(self, **kwargs):
            raise ReadTimeout("daemon may still finish creating")
        def get(self, name):
            raise NotFound("not visible yet")
    adapter = module.PolicyContainers(Containers(), module.SandboxPolicy.from_environment(tmp_path))
    with pytest.raises(ReadTimeout):
        adapter.create(image="test", labels={"app": "famsun-agent"})
    assert not await adapter.reconcile_failed_creation(timeout=0)
