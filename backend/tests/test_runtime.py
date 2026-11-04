import asyncio
import json

import pytest
from agents.tool_context import ToolContext
from app import runtime
from app.extensions import mcp_headers, validate_mcp_url


@pytest.mark.parametrize("completed", [None, False, True])
async def test_plan_tool_accepts_provider_omitting_completion_flag(completed):
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    arguments = {"steps": ["检查", "生成"], "current_step": 0}
    if completed is not None:
        arguments["completed"] = completed
    raw = json.dumps(arguments)
    context = ToolContext(None, tool_name="update_plan", tool_call_id="plan-1", tool_arguments=raw)
    result = json.loads(await runtime._plan_tool(emit).on_invoke_tool(context, raw))
    assert result["completed"] is (completed or False)
    assert events == [("plan.updated", result)]
    assert result["call_id"] == "plan-1"


@pytest.mark.parametrize("arguments", ["{", '{"steps":[],"current_step":0}',
                                      '{"steps":["检查"],"current_step":2}'])
async def test_invalid_plan_returns_actionable_safe_error_without_updating_ui(arguments):
    async def forbidden(*args):
        pytest.fail("invalid plan must not be persisted")

    context = ToolContext(None, tool_name="update_plan", tool_call_id="bad-plan", tool_arguments=arguments)
    result = json.loads(await runtime._plan_tool(forbidden).on_invoke_tool(context, arguments))
    assert result["isError"] is True
    assert "current_step" in result["error"]
    assert "completed" in result["error"]


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
        ({"max_turns": 0}, "执行限制"),
        ({"model_timeout_seconds": -1}, "执行限制"),
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


async def test_plan_limit_is_enforced_by_actual_tool():
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    tool = runtime._plan_tool(emit, max_steps=16)
    for size, accepted in [(16, True), (17, False)]:
        raw = json.dumps({"steps": [f"Step {index}" for index in range(size)], "current_step": 0})
        context = ToolContext(None, tool_name="update_plan", tool_call_id=str(size), tool_arguments=raw)
        result = json.loads(await tool.on_invoke_tool(context, raw))
        assert ("steps" in result) is accepted
        if not accepted:
            assert "16" in result["error"]
    assert len(events) == 1


def test_invalid_resource_settings_fail_at_startup(tmp_path):
    from app.config import Settings

    for name in ("max_turns", "max_runtime_seconds", "max_session_mb", "max_workspace_entries",
                 "model_timeout_seconds", "mcp_timeout_seconds", "mcp_session_timeout_seconds",
                 "mcp_max_list_pages", "max_plan_steps"):
        with pytest.raises(ValueError, match=name):
            Settings(data_dir=tmp_path, **{name: 0})


def test_environment_runtime_limits_are_loaded(tmp_path, monkeypatch):
    from app.config import Settings

    overrides = {
        "MAX_UPLOAD_MB": ("max_upload_mb", 128),
        "MAX_SESSION_MB": ("max_session_mb", 3072),
        "MAX_WORKSPACE_ENTRIES": ("max_workspace_entries", 12000),
        "AGENT_MAX_TURNS": ("max_turns", 333),
        "AGENT_TIMEOUT_SECONDS": ("max_runtime_seconds", 9000),
        "AGENT_MODEL_TIMEOUT_SECONDS": ("model_timeout_seconds", 450),
        "MCP_TIMEOUT_SECONDS": ("mcp_timeout_seconds", 150),
        "MCP_SESSION_TIMEOUT_SECONDS": ("mcp_session_timeout_seconds", 470),
        "MCP_MAX_LIST_PAGES": ("mcp_max_list_pages", 111),
        "AGENT_MAX_PLAN_STEPS": ("max_plan_steps", 60),
    }
    for name, (_, value) in overrides.items():
        monkeypatch.setenv(name, str(value))
    settings = Settings(data_dir=tmp_path)
    assert {field: getattr(settings, field) for field, _ in overrides.values()} == {
        field: value for field, value in overrides.values()
    }
