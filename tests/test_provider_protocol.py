"""Real SDK and HTTP client, deterministic Responses fixtures; no live model calls.

The test-only SDK local workspace prepares capabilities but never executes model
commands. Production runtime uses Docker exclusively.
"""

import asyncio
import json
from contextlib import asynccontextmanager

import httpx
import pytest
from agents import SQLiteSession
from agents.sandbox import Manifest
from agents.sandbox.sandboxes.unix_local import UnixLocalSandboxClient
from openai import AsyncOpenAI


def response_sse(items, response_id="resp_fixture"):
    response = {
        "id": response_id,
        "object": "response",
        "created_at": 1,
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "instructions": None,
        "metadata": {},
        "model": "fixture-model",
        "output": items,
        "parallel_tool_calls": True,
        "previous_response_id": None,
        "store": False,
        "temperature": 1,
        "text": {"format": {"type": "text"}},
        "tool_choice": "auto",
        "tools": [],
        "top_p": 1,
        "truncation": "disabled",
        "usage": {
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }
    events = [
        {
            "type": "response.created",
            "response": {**response, "output": [], "status": "in_progress", "usage": None},
        }
    ]
    for index, item in enumerate(items):
        events.append(
            {
                "type": "response.output_item.added",
                "output_index": index,
                "item": {**item, "content": []} if item["type"] == "message" else item,
            }
        )
        if item["type"] == "message":
            events.append(
                {
                    "type": "response.output_text.delta",
                    "output_index": index,
                    "content_index": 0,
                    "item_id": item["id"],
                    "delta": item["content"][0]["text"],
                    "logprobs": [],
                }
            )
        events.append({"type": "response.output_item.done", "output_index": index, "item": item})
    events.append({"type": "response.completed", "response": response})
    data = "".join(
        f"data: {json.dumps({**event, 'sequence_number': n})}\n\n" for n, event in enumerate(events)
    )
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=data)


def message(text, identity="msg_final", phase="final_answer"):
    return {
        "id": identity,
        "type": "message",
        "status": "completed",
        "role": "assistant",
        "phase": phase,
        "content": [{"type": "output_text", "text": text, "annotations": [], "logprobs": []}],
    }


def call(name, arguments, identity="call_plan"):
    return {
        "id": f"fc_{identity}",
        "type": "function_call",
        "status": "completed",
        "name": name,
        "arguments": json.dumps(arguments),
        "call_id": identity,
    }


@pytest.fixture
def harness(monkeypatch, tmp_path):
    from app import runtime

    requests, events = [], []

    @asynccontextmanager
    async def sandbox(workspace, **kwargs):
        workspace.mkdir(parents=True, exist_ok=True)
        client = UnixLocalSandboxClient(inherit_host_environment=False)
        session = await client.create(manifest=Manifest(root=str(workspace)))
        async with session:
            yield session

    monkeypatch.setattr(runtime, "open_chat_sandbox", sandbox)

    async def execute(
        handler, *, messages=None, extensions=None, approved=True, cancel_event=None, approval_callback=None
    ):
        async def transport(request):
            assert request.url.path == "/v1/responses"
            body = json.loads(request.content)
            requests.append(body)
            result = handler(body, len(requests))
            return await result if hasattr(result, "__await__") else result

        monkeypatch.setattr(
            runtime,
            "AsyncOpenAI",
            lambda **kwargs: AsyncOpenAI(
                **kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport))
            ),
        )

        async def emit(name, data):
            events.append((name, data))

        async def approve(*args):
            if approval_callback:
                return await approval_callback(*args)
            return approved

        return await runtime.run_agent(
            config=runtime.RuntimeConfig(
                base_url="https://protocol.test/v1",
                api_key="fixture-secret",
                model="fixture-model",
                state_dir=tmp_path / "history",
                user_id="alice",
                session_id="chat",
                run_id="run",
                extensions=extensions or [],
                allowed_mcp_hosts=["mcp.test"],
                compaction_threshold=8000,
            ),
            workspace=tmp_path / "workspace",
            messages=messages or [{"role": "user", "content": "make a plan"}],
            emit=emit,
            cancel_event=cancel_event or asyncio.Event(),
            request_approval=approve,
        )

    return execute, requests, events, tmp_path


async def test_responses_native_tools_compaction_and_full_history(harness):
    execute, requests, events, tmp_path = harness

    def first(body, sequence):
        assert body["store"] is False and body["stream"] is True
        assert not body.get("conversation") and not body.get("previous_response_id")
        assert body["context_management"] == [{"type": "compaction", "compact_threshold": 8000}]
        names = {tool.get("name") for tool in body["tools"]}
        assert {"exec_command", "write_stdin", "apply_patch", "view_image", "update_plan"} <= names
        assert not {"python", "shell", "read_file", "write_file", "list_skills"} & names
        if sequence == 1:
            return response_sse(
                [
                    message("我先制定计划。", "msg_process", "commentary"),
                    call("update_plan", {"steps": ["检查资料"], "current_step": 0, "completed": False}),
                ]
            )
        assert any(item.get("type") == "function_call_output" for item in body["input"])
        return response_sse([message("计划已准备。")], "resp_final")

    assert await execute(first) == "计划已准备。"
    assert len(requests) == 2
    native = SQLiteSession("alice:chat", tmp_path / "history" / "alice" / "chat.sqlite3")
    try:
        items = await native.get_items()
        assert any(item.get("type") == "function_call" for item in items)
        assert any(item.get("type") == "function_call_output" for item in items)
        assert sum(item.get("role") == "user" for item in items) == 1
    finally:
        native.close()
    assert any(
        name == "text.phase" and data["item_id"] == "msg_final" and data["phase"] == "final"
        for name, data in events
    )
    assert "fixture-secret" not in str(events)

    def second(body, _):
        assert any(item.get("type") == "function_call_output" for item in body["input"])
        assert sum(item.get("role") == "user" for item in body["input"]) == 2
        return response_sse([message("继续完成。", "msg_followup")], "resp_followup")

    assert (
        await execute(
            second,
            messages=[
                {"role": "user", "content": "make a plan"},
                {"role": "assistant", "content": "计划已准备。"},
                {"role": "user", "content": "continue"},
            ],
        )
        == "继续完成。"
    )


async def test_native_compaction_persists_and_trims_next_model_input(harness):
    execute, _, events, _ = harness
    compact = {"id": "cmp_1", "type": "compaction", "encrypted_content": "opaque-fixture"}
    await execute(lambda *_: response_sse([compact, message("压缩后继续。")]))

    def followup(body, _):
        assert any(item.get("type") == "compaction" for item in body["input"])
        assert not any(
            item.get("role") == "user" and item.get("content") == "make a plan" for item in body["input"]
        )
        return response_sse([message("新的回答。", "msg_next")], "resp_next")

    await execute(followup, messages=[{"role": "user", "content": "next"}])
    assert any(name == "context.compacted" for name, _ in events)
    assert "opaque-fixture" not in str(events)


async def test_subagent_native_as_tool_independent_history_and_attribution(harness):
    execute, _, events, _ = harness
    definition = {
        "id": "researcher",
        "name": "研究员",
        "type": "subagent",
        "enabled": True,
        "description": "Investigate",
        "config": {
            "instructions": "Return a research note.",
            "model": "child-model",
            "max_turns": 4,
            "skill_ids": [],
            "mcp_server_ids": [],
        },
    }

    def handler(body, sequence):
        if sequence == 1:
            tool = next(tool for tool in body["tools"] if tool.get("name", "").startswith("delegate_"))
            return response_sse([call(tool["name"], {"input": "Inspect the hypothesis."}, "call_child")])
        if body["model"] == "child-model":
            assert not any(tool.get("name", "").startswith("delegate_") for tool in body["tools"])
            assert "make a plan" not in json.dumps(body["input"])
            return response_sse([message("子代理证据。", "msg_child")], "resp_child")
        assert any(
            item.get("type") == "function_call_output" and "子代理证据" in str(item.get("output"))
            for item in body["input"]
        )
        return response_sse([message("主代理结论。", "msg_parent")], "resp_parent")

    assert await execute(handler, extensions=[definition]) == "主代理结论。"
    children = [
        data for name, data in events if name == "text.delta" and data.get("agent_id") == "researcher"
    ]
    assert children and children[0]["parent_call_id"] == "call_child"
    assert not any(
        name == "text.phase" and data.get("agent_id") == "researcher" and data["phase"] == "final"
        for name, data in events
    )


async def test_unsupported_compaction_explicit_without_fallback(harness):
    from app.runtime import AgentRuntimeError

    execute, requests, _, _ = harness
    with pytest.raises(AgentRuntimeError, match="压缩"):
        await execute(
            lambda *_: httpx.Response(
                400,
                json={
                    "error": {
                        "message": "Unsupported parameter: context_management",
                        "type": "invalid_request_error",
                        "param": "context_management",
                        "code": "unsupported_parameter",
                    }
                },
            )
        )
    assert len(requests) == 1


@pytest.mark.parametrize("approved", [True, False])
async def test_native_mcp_approval_resume_persists_input_once(harness, monkeypatch, approved):
    from agents.mcp import MCPServerStreamableHttp
    from app import runtime
    from mcp.types import CallToolResult, TextContent, Tool

    executed, approvals = [], []

    class FakeMCP(MCPServerStreamableHttp):
        async def connect(self):
            pass

        async def cleanup(self):
            pass

        async def list_tools(self, run_context=None, agent=None):
            return [
                Tool(
                    name="publish_report",
                    description="Publish",
                    inputSchema={
                        "type": "object",
                        "properties": {"title": {"type": "string"}},
                        "required": ["title"],
                        "additionalProperties": False,
                    },
                )
            ]

        async def call_tool(self, tool_name, arguments, **kwargs):
            executed.append((tool_name, arguments))
            return CallToolResult(content=[TextContent(type="text", text="Published")])

    monkeypatch.setattr(runtime, "MCPServerStreamableHttp", FakeMCP)
    execute, _requests, events, tmp_path = harness

    async def approve(name, args):
        assert not executed
        approvals.append((name, args))
        return approved

    def handler(body, sequence):
        if sequence == 1:
            name = next(
                tool["name"] for tool in body["tools"] if tool.get("name", "").endswith("publish_report")
            )
            return response_sse([call(name, {"title": "Quarterly"}, "call_mcp")])
        return response_sse([message("审批已处理。")], "resp_after_approval")

    result = await execute(
        handler,
        extensions=[{"id": "research", "name": "Research", "type": "mcp", "url": "https://mcp.test/mcp"}],
        approval_callback=approve,
    )
    assert result == "审批已处理。" and len(approvals) == 1
    assert len(executed) == int(approved)
    native = SQLiteSession("alice:chat", tmp_path / "history" / "alice" / "chat.sqlite3")
    try:
        items = await native.get_items()
        assert sum(item.get("role") == "user" for item in items) == 1
        assert sum(item.get("type") == "function_call" for item in items) == 1
        assert sum(item.get("type") == "function_call_output" for item in items) == 1
    finally:
        native.close()
    assert sum(name == "tool.completed" for name, _ in events) == 1


async def test_cancellation_drains_pending_model_request(harness):
    execute, _, _, _ = harness
    pending, interrupted, cancel = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def handler(*args):
        pending.set()
        try:
            await asyncio.Event().wait()
        finally:
            interrupted.set()

    task = asyncio.create_task(execute(handler, cancel_event=cancel))
    await asyncio.wait_for(pending.wait(), 5)
    cancel.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    assert interrupted.is_set()


async def test_native_skills_show_only_selected_catalog_without_loading_disabled_content(harness):
    execute, _, _, tmp_path = harness
    extensions = [
        {
            "id": "alpha",
            "name": "Alpha",
            "type": "skill",
            "description": "Alpha summary",
            "content": "Alpha body",
        },
        {
            "id": "beta",
            "name": "Beta",
            "type": "skill",
            "description": "Beta summary",
            "content": "Beta body",
        },
        {
            "id": "disabled",
            "name": "Disabled",
            "type": "skill",
            "enabled": False,
            "description": "disabled secret summary",
            "content": "disabled secret body",
        },
        {
            "id": "specialist",
            "name": "Specialist",
            "type": "subagent",
            "config": {
                "instructions": "Use the selected skill",
                "model": "child-model",
                "skill_ids": ["alpha", "disabled"],
                "mcp_server_ids": [],
                "max_turns": 4,
            },
        },
    ]

    def handler(body, sequence):
        prompt = str(body.get("instructions", ""))
        assert "disabled secret" not in prompt
        if sequence == 1:
            assert "Alpha summary" in prompt and "Beta summary" in prompt
            delegate = next(
                tool["name"] for tool in body["tools"] if tool.get("name", "").startswith("delegate_")
            )
            return response_sse([call(delegate, {"input": "Use the selected skill"}, "call_selected")])
        if body["model"] == "child-model":
            assert "Alpha summary" in prompt and "Beta summary" not in prompt
            return response_sse([message("Selected skill ready", "msg_selected")], "resp_selected")
        return response_sse([message("done", "msg_done")], "resp_done")

    assert await execute(handler, extensions=extensions) == "done"
    files = list((tmp_path / "workspace" / ".famsun-skills").rglob("SKILL.md"))
    assert files and all("disabled secret" not in path.read_text() for path in files)


async def test_child_mcp_approval_propagates_to_root_and_resumes_once(harness, monkeypatch):
    from agents.mcp import MCPServerStreamableHttp
    from app import runtime
    from mcp.types import CallToolResult, TextContent, Tool

    invoked, approvals = [], []

    class FakeMCP(MCPServerStreamableHttp):
        async def connect(self):
            pass

        async def cleanup(self):
            pass

        async def list_tools(self, run_context=None, agent=None):
            return [
                Tool(
                    name="save_note",
                    description="Save",
                    inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
                )
            ]

        async def call_tool(self, name, arguments, **kwargs):
            invoked.append(name)
            return CallToolResult(content=[TextContent(type="text", text="saved")])

    monkeypatch.setattr(runtime, "MCPServerStreamableHttp", FakeMCP)
    execute, _, events, _ = harness

    async def approve(name, arguments):
        assert not invoked
        approvals.append(name)
        return True

    def handler(body, sequence):
        if sequence == 1:
            delegate = next(
                tool["name"] for tool in body["tools"] if tool.get("name", "").startswith("delegate_")
            )
            return response_sse([call(delegate, {"input": "Save the note"}, "call_delegate")])
        if sequence == 2:
            name = next(tool["name"] for tool in body["tools"] if tool.get("name", "").endswith("save_note"))
            return response_sse([call(name, {}, "call_nested")], "resp_child_tool")
        if body["model"] == "child-model":
            return response_sse([message("Saved note", "msg_child_done")], "resp_child_done")
        return response_sse([message("Finished", "msg_root_done")], "resp_root_done")

    definitions = [
        {"id": "notes", "name": "Notes", "type": "mcp", "url": "https://mcp.test/mcp"},
        {
            "id": "writer",
            "name": "Writer",
            "type": "subagent",
            "config": {
                "instructions": "Save notes",
                "model": "child-model",
                "skill_ids": [],
                "mcp_server_ids": ["notes"],
                "max_turns": 4,
            },
        },
    ]
    assert await execute(handler, extensions=definitions, approval_callback=approve) == "Finished"
    assert len(invoked) == len(approvals) == 1
    assert any(
        name == "tool.completed" and data["call_id"] == "call_delegate::call_nested" for name, data in events
    )


async def test_two_calls_to_same_specialist_are_safe_and_keep_distinct_ids(harness):
    execute, _, events, _ = harness
    definition = {
        "id": "specialist",
        "name": "Specialist",
        "type": "subagent",
        "config": {"instructions": "Inspect the assigned case", "model": "child-model", "max_turns": 4},
    }

    async def handler(body, sequence):
        if sequence == 1:
            name = next(
                tool["name"] for tool in body["tools"] if tool.get("name", "").startswith("delegate_")
            )
            return response_sse(
                [call(name, {"input": "Case one"}, "call_one"), call(name, {"input": "Case two"}, "call_two")]
            )
        if body["model"] == "child-model":
            await asyncio.sleep(0.01)
            return response_sse([message("Child result", "msg_same")], f"resp_child_{sequence}")
        assert sum(item.get("type") == "function_call_output" for item in body["input"]) == 2
        return response_sse([message("Both inspected", "msg_both")], "resp_both")

    assert await execute(handler, extensions=[definition]) == "Both inspected"
    assert {
        data["item_id"]
        for name, data in events
        if name == "text.delta" and data.get("agent_id") == "specialist"
    } == {"call_one::msg_same", "call_two::msg_same"}


async def test_native_freeform_apply_patch_executes_and_discovers_artifact(harness):
    execute, _, events, tmp_path = harness
    patch = "*** Begin Patch\n*** Add File: outputs/report.md\n+# Verified report\n+Actual native patch output.\n*** End Patch\n"

    def handler(body, sequence):
        if sequence == 1:
            tool = next(tool for tool in body["tools"] if tool.get("name") == "apply_patch")
            assert tool["type"] == "custom" and tool["format"]["type"] == "grammar"
            return response_sse(
                [
                    {
                        "id": "ctc_patch",
                        "type": "custom_tool_call",
                        "call_id": "call_patch",
                        "name": "apply_patch",
                        "input": patch,
                    }
                ]
            )
        assert any(
            item.get("type") == "custom_tool_call_output" and item.get("call_id") == "call_patch"
            for item in body["input"]
        )
        return response_sse([message("report.md 已生成。")], "resp_patched")

    assert await execute(handler) == "report.md 已生成。"
    assert (tmp_path / "workspace" / "outputs" / "report.md").read_text().splitlines() == [
        "# Verified report",
        "Actual native patch output.",
    ]
    assert (
        sum(name == "artifact.discovered" and data["path"] == "outputs/report.md" for name, data in events)
        == 1
    )
    assert any(name == "tool.completed" and data["call_id"] == "call_patch" for name, data in events)
