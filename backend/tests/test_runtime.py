import asyncio
import json
from typing import ClassVar

import httpx
import pytest
from agents.mcp import MCPServerStreamableHttp
from agents.tool_context import ToolContext
from app import runtime
from app.extensions import load_skill_content, mcp_headers, skill_catalog, validate_mcp_url
from mcp.types import CallToolResult, TextContent, Tool
from openai import AsyncOpenAI


@pytest.fixture
def workspace(tmp_path):
    (tmp_path / "uploads").mkdir()
    (tmp_path / "outputs").mkdir()
    return tmp_path


def test_history_bounds_and_filters_system_roles():
    messages = [{"role": "system", "content": "untrusted override"}] + [
        {"role": "user", "content": str(i) * 10} for i in range(20)]
    result, shortened = runtime.bounded_history(messages, max_characters=50, max_messages=5)
    assert shortened
    assert sum(len(m["content"]) for m in result) <= 50
    assert result[-1]["content"] == "19" * 10
    assert all(m["role"] == "user" for m in result)


@pytest.mark.parametrize("url", ["http://trusted.test/mcp", "https://trusted.test.evil/mcp", "https://user:secret@trusted.test/mcp", "https://trusted.test/mcp?token=secret", "https://trusted.test:8443/mcp", "https://127.0.0.1/mcp"])
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


def test_skill_discovery_does_not_load_disabled_content():
    skills = [{"id": "a", "name": "A", "type": "skill", "content": "enabled"},
              {"id": "b", "name": "B", "type": "skill", "content": "disabled", "enabled": False}]
    assert [item["id"] for item in skill_catalog(skills)] == ["a"]
    assert load_skill_content(skills, "a") == "enabled"
    with pytest.raises(ValueError):
        load_skill_content(skills, "b")


async def test_actual_sdk_function_tool_creates_file_and_events(workspace):
    events = []
    async def emit(event, payload):
        events.append((event, payload))
    config = runtime.RuntimeConfig(base_url="", api_key="unit-test", model="test", sandbox_backend="disabled")
    tools = {tool.name: tool for tool in runtime.build_tools(config, workspace, emit, asyncio.Event())}
    args = json.dumps({"path": "outputs/result.md", "content": "verified"})
    output = await tools["write_file"].on_invoke_tool(ToolContext(None, tool_name="write_file", tool_call_id="test-write", tool_arguments=args), args)
    assert output == "outputs/result.md"
    assert (workspace / "outputs" / "result.md").read_text() == "verified"
    assert [event for event, _ in events] == ["tool.started", "tool.completed", "artifact.discovered"]
    args = '{"code":"print(1)"}'
    python_output = await tools["python"].on_invoke_tool(ToolContext(None, tool_name="python", tool_call_id="test-python", tool_arguments=args), args)
    assert "尚未启用" in python_output


class FakeMCP(MCPServerStreamableHttp):
    calls: ClassVar[list] = []

    async def connect(self):
        pass

    async def cleanup(self):
        pass

    async def list_tools(self, run_context=None, agent=None):
        return [Tool(name="publish_report", description="Publish a report externally", inputSchema={
            "type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"],
            "additionalProperties": False})]

    async def call_tool(self, tool_name, arguments, **kwargs):
        self.calls.append((tool_name, arguments))
        return CallToolResult(content=[TextContent(type="text", text="Published")])


def chat_chunk(delta, finish=None):
    return {"id": "chat-test", "object": "chat.completion.chunk", "created": 1, "model": "test-model",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


@pytest.mark.parametrize("approved", [True, False])
async def test_real_sdk_mcp_interruption_approval_or_denial(workspace, monkeypatch, approved):
    FakeMCP.calls = []
    events, requests, decisions = [], [], []
    async def emit(event, payload):
        events.append((event, payload))
    async def approve(name, arguments):
        # Native SDK must interrupt BEFORE a remote tool is invoked.
        assert FakeMCP.calls == []
        decisions.append((name, arguments))
        return approved
    def transport(request):
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            name = next(tool["function"]["name"] for tool in body["tools"]
                        if tool["function"]["name"].endswith("publish_report"))
            chunks = [chat_chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": "call_mcp_1",
                "type": "function", "function": {"name": name, "arguments": '{"title":"Quarterly"}'}}]}),
                chat_chunk({}, "tool_calls")]
        else:
            chunks = [chat_chunk({"role": "assistant", "content": "已处理审批结果。"}), chat_chunk({}, "stop")]
        data = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=data)
    monkeypatch.setattr(runtime, "MCPServerStreamableHttp", FakeMCP)
    monkeypatch.setattr(runtime, "AsyncOpenAI", lambda **kwargs: AsyncOpenAI(
        **kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport))))
    config = runtime.RuntimeConfig(base_url="https://provider.test/v1", api_key="test-key", model="test-model",
        sandbox_backend="disabled", max_runtime_seconds=10, extensions=[{"id": "research", "name": "Research", "type": "mcp",
        "url": "https://mcp.test/mcp"}], allowed_mcp_hosts=["mcp.test"])
    result = await runtime.run_agent(config=config, workspace=workspace,
        messages=[{"role": "user", "content": "Publish quarterly report"}], emit=emit,
        cancel_event=asyncio.Event(), request_approval=approve)
    assert result == "已处理审批结果。"
    assert len(decisions) == 1 and decisions[0][1] == {"title": "Quarterly"}
    assert len(FakeMCP.calls) == (1 if approved else 0)
    assert any(event == "text.delta" for event, _ in events)
    assert any(event == "tool.completed" and payload["name"].endswith("publish_report")
               for event, payload in events)
    assert "test-key" not in str(events)


async def test_cancellation_stops_pending_provider(workspace, monkeypatch):
    pending, cancelled = asyncio.Event(), asyncio.Event()
    async def transport(request):
        pending.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    monkeypatch.setattr(runtime, "AsyncOpenAI", lambda **kwargs: AsyncOpenAI(
        **kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport))))
    async def emit(*args):
        pass
    async def approve(*args):
        pytest.fail("No approval expected")
    cancel = asyncio.Event()
    task = asyncio.create_task(runtime.run_agent(
        config=runtime.RuntimeConfig(base_url="https://provider.test/v1", api_key="test-key", model="test"),
        workspace=workspace, messages=[{"role": "user", "content": "hello"}], emit=emit,
        cancel_event=cancel, request_approval=approve))
    await asyncio.wait_for(pending.wait(), 5)
    cancel.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    assert cancelled.is_set()
