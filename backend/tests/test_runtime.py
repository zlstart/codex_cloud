import asyncio

import pytest
from app import runtime
from app.extensions import mcp_headers, validate_mcp_url


@pytest.mark.parametrize(
    "url",
    [
        "http://trusted.test/mcp",
        "https://trusted.test.evil/mcp",
        "https://user:secret@trusted.test/mcp",
        "https://trusted.test/mcp?token=secret",
        "https://trusted.test:8443/mcp",
        "https://127.0.0.1/mcp",
    ],
)
def test_mcp_allowlist_rejects_unsafe_destinations(url):
    with pytest.raises(ValueError):
        validate_mcp_url(url, ["trusted.test"])


def test_mcp_exact_host_and_token_boundary(monkeypatch):
    assert validate_mcp_url("https://trusted.test/mcp", ["trusted.test"]) == "https://trusted.test/mcp"
    monkeypatch.setenv("MCP_RESEARCH_TOKEN", "test-only-secret")
    assert mcp_headers("research", "MCP_RESEARCH_TOKEN") == {"Authorization": "Bearer test-only-secret"}
    with pytest.raises(ValueError):
        mcp_headers("research", "OPENAI_API_KEY")
    with pytest.raises(ValueError, match="尚未配置"):
        mcp_headers("research", "MCP_MISSING_TOKEN")


@pytest.mark.parametrize(
    "options,match",
    [
        ({"api_mode": "chat_completions"}, "仅支持 Responses"),
        ({"sandbox_backend": "disabled"}, "需要 Docker"),
        ({"state_dir": None}, "历史存储"),
        ({"compaction_threshold": 0}, "阈值"),
    ],
)
async def test_invalid_runtime_policy_fails_before_any_provider_or_sandbox(
    tmp_path, options, match, monkeypatch
):
    def forbidden(*args, **kwargs):
        pytest.fail("invalid policy reached provider or sandbox")

    monkeypatch.setattr(runtime, "AsyncOpenAI", forbidden)
    monkeypatch.setattr(runtime, "open_chat_sandbox", forbidden)
    config = runtime.RuntimeConfig(
        base_url="https://provider.test/v1",
        api_key="fixture",
        model="test",
        state_dir=tmp_path / "history",
        user_id="alice",
        session_id="chat",
    )
    for key, value in options.items():
        setattr(config, key, value)

    async def noop(*args):
        pass

    with pytest.raises(runtime.AgentRuntimeError, match=match):
        await runtime.run_agent(
            config=config,
            workspace=tmp_path / "workspace",
            messages=[{"role": "user", "content": "hello"}],
            emit=noop,
            cancel_event=asyncio.Event(),
            request_approval=noop,
        )
