from types import SimpleNamespace as NS

import pytest
from app import runtime_events


def raw(kind, **kwargs):
    return NS(type="raw_response_event", data={"type": kind, **kwargs})


def item(kind, payload, **kwargs):
    return NS(type="run_item_stream_event", item=NS(type=kind, raw_item=payload, **kwargs))


def message(identity, text, phase=None):
    return {
        "type": "message",
        "id": identity,
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text}],
        "phase": phase,
    }


@pytest.fixture
def recorder():
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    return events, runtime_events.RuntimeEvents(emit)


async def test_interleaves_text_tools_and_keeps_only_final_answer_final(recorder):
    events, adapter = recorder
    await adapter.consume(raw("response.output_item.added", item=message("m1", "")))
    await adapter.consume(raw("response.output_text.delta", item_id="m1", delta="检查文件。"))
    await adapter.consume(raw("response.output_item.done", item=message("m1", "检查文件。")))
    call = {
        "type": "function_call",
        "id": "fc1",
        "call_id": "c1",
        "name": "exec_command",
        "arguments": '{"cmd":"ls"}',
    }
    await adapter.consume(raw("response.output_item.done", item=call))
    await adapter.consume(item("tool_call_item", call))
    await adapter.consume(item("tool_call_output_item", {"call_id": "c1", "output": "report.csv"}))
    await adapter.consume(raw("response.output_text.delta", item_id="m2", delta="文件已检查。"))
    last = message("m2", "文件已检查。")
    await adapter.consume(item("message_output_item", last))
    final = await adapter.finalize(
        NS(
            final_output="文件已检查。",
            new_items=[
                NS(type="message_output_item", raw_item=message("m1", "检查文件。")),
                NS(type="message_output_item", raw_item=last),
            ],
        )
    )
    assert final == ["m2"]
    assert adapter.final_item_ids == ["m2"]
    significant = [
        (name, data.get("item_id"))
        for name, data in events
        if name in {"text.delta", "tool.started", "tool.completed"}
    ]
    assert significant == [
        ("text.delta", "m1"),
        ("tool.started", "fc1"),
        ("tool.completed", "fc1"),
        ("text.delta", "m2"),
    ]
    assert [
        data["item_id"] for name, data in events if name == "text.phase" and data["phase"] == "final"
    ] == ["m2"]


async def test_same_name_parallel_tools_pair_by_call_id(recorder):
    events, adapter = recorder
    for cid in ("c1", "c2"):
        await adapter.consume(
            item(
                "tool_call_item",
                {
                    "type": "function_call",
                    "id": f"f{cid}",
                    "call_id": cid,
                    "name": "exec_command",
                    "arguments": '{"cmd":"pwd"}',
                },
            )
        )
    for cid in ("c2", "c1"):
        await adapter.consume(item("tool_call_output_item", {"call_id": cid, "output": cid}))
    completed = [data for name, data in events if name == "tool.completed"]
    assert [(data["call_id"], data["item_id"], data["output"]) for data in completed] == [
        ("c2", "fc2", "c2"),
        ("c1", "fc1", "c1"),
    ]


async def test_child_invocations_have_distinct_ids_and_never_become_final(recorder):
    events, adapter = recorder
    for parent in ("delegation1", "delegation2"):
        await adapter.consume(
            raw("response.output_text.delta", item_id="shared", delta="child"),
            agent_id="analyst",
            agent_name="分析员",
            parent_call_id=parent,
        )
        await adapter.consume(
            item("message_output_item", message("shared", "child", "final_answer")),
            agent_id="analyst",
            agent_name="分析员",
            parent_call_id=parent,
        )
    root = message("shared", "parent")
    await adapter.consume(item("message_output_item", root))
    await adapter.finalize(
        NS(final_output="parent", new_items=[NS(type="message_output_item", raw_item=root)])
    )
    completions = [data for name, data in events if name == "text.completed"]
    assert len({data["item_id"] for data in completions}) == 3
    assert [data["parent_call_id"] for data in completions[:2]] == ["delegation1", "delegation2"]
    assert [
        data["item_id"] for name, data in events if name == "text.phase" and data["phase"] == "final"
    ] == ["shared"]


async def test_completed_text_is_authoritative_and_duplicate_sources_emit_once(recorder):
    events, adapter = recorder
    await adapter.consume(raw("response.output_text.delta", item_id="m", delta="part"))
    await adapter.consume(raw("response.output_text.done", item_id="m", text="complete"))
    await adapter.consume(raw("response.output_item.done", item=message("m", "complete")))
    await adapter.consume(item("message_output_item", message("m", "complete")))
    assert [data["text"] for name, data in events if name == "text.completed"] == ["complete"]
    assert len([1 for name, _ in events if name == "text.started"]) == 1


async def test_compaction_has_no_encrypted_content_and_reasoning_is_not_rendered(recorder):
    events, adapter = recorder
    payload = {"type": "compaction", "id": "compact1", "encrypted_content": "SECRET-OPAQUE"}
    await adapter.consume(raw("response.output_item.done", item=payload))
    await adapter.consume(item("compaction_item", payload))
    await adapter.consume(raw("response.reasoning_text.delta", item_id="r1", delta="PRIVATE-REASONING"))
    assert [name for name, _ in events] == ["context.compacted"]
    assert "SECRET" not in str(events) and "PRIVATE" not in str(events)


@pytest.mark.parametrize(
    ("input_tokens", "expected_status"),
    [(1023, "not_observed"), (1024, "not_observed"), (1025, "threshold_exceeded"),
     (None, "not_observed")],
)
async def test_context_status_reports_observed_usage_without_claiming_compaction(input_tokens, expected_status):
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    adapter = runtime_events.RuntimeEvents(emit, compaction_threshold=1024)
    completed = raw("response.completed", response={
        "id": "response1", "output": [message("m", "done")],
        "usage": {"input_tokens": input_tokens} if input_tokens is not None else None,
    })
    await adapter.consume(completed)
    await adapter.consume(completed)
    assert events == [("context.status", {
        "item_id": "response1", "agent_id": "main", "agent_name": "Assistant", "parent_call_id": None,
        "response_id": "response1", "status": expected_status,
        "input_tokens": input_tokens, "threshold": 1024, "compaction_count": 0,
    })]


async def test_context_status_counts_real_compaction_and_keeps_nested_responses_separate():
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    adapter = runtime_events.RuntimeEvents(emit, compaction_threshold=1024)
    payload = {"type": "compaction", "id": "cmp", "encrypted_content": "PRIVATE-OPAQUE"}
    completed = raw("response.completed", response={
        "id": "same-response", "output": [payload], "usage": {"input_tokens": 500},
    })
    for parent in ("child1", "child2"):
        await adapter.consume(raw("response.output_item.done", item=payload),
                              agent_id="analyst", parent_call_id=parent)
        await adapter.consume(completed, agent_id="analyst", parent_call_id=parent)
        await adapter.consume(completed, agent_id="analyst", parent_call_id=parent)
    statuses = [data for kind, data in events if kind == "context.status"]
    assert [data["item_id"] for data in statuses] == ["child1::same-response", "child2::same-response"]
    assert all(data["status"] == "compacted" and data["compaction_count"] == 1 for data in statuses)
    assert sum(kind == "context.compacted" for kind, _ in events) == 2
    assert "PRIVATE" not in str(events)


async def test_artifacts_discovered_once_after_completed_tool():
    observed = []

    async def emit(kind, data):
        observed.append(kind)

    async def artifacts():
        observed.append("scan")

    adapter = runtime_events.RuntimeEvents(emit, artifacts=artifacts)
    output = item("tool_call_output_item", {"call_id": "c", "output": "done"})
    await adapter.consume(output)
    await adapter.consume(output)
    assert observed == ["tool.started", "tool.completed", "scan"]


async def test_multiple_content_parts_keep_their_order_after_done_events(recorder):
    events, adapter = recorder
    for index, text in ((0, "First"), (1, " second"), (2, " third")):
        await adapter.consume(raw("response.output_text.delta", item_id="m", content_index=index, delta=text))
        await adapter.consume(raw("response.output_text.done", item_id="m", content_index=index, text=text))
    await adapter.consume(raw("response.output_text.done", item_id="m", content_index=2, text=" third"))
    assert [data["text"] for name, data in events if name == "text.completed"][-1] == "First second third"


async def test_duplicate_raw_sequence_is_ignored_but_equal_distinct_deltas_are_kept(recorder):
    events, adapter = recorder
    first = raw("response.output_text.delta", item_id="m", sequence_number=1, delta="哈")
    await adapter.consume(first)
    await adapter.consume(first)
    await adapter.consume(raw("response.output_text.delta", item_id="m", sequence_number=2, delta="哈"))
    assert [data["delta"] for name, data in events if name == "text.delta"] == ["哈", "哈"]


async def test_actual_sdk_events_work_without_provider_calls(recorder):
    from agents import Agent
    from agents.items import MessageOutputItem
    from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent
    from openai.types.responses import ResponseOutputMessage, ResponseTextDeltaEvent

    events, adapter = recorder
    await adapter.consume(
        RawResponsesStreamEvent(
            data=ResponseTextDeltaEvent(
                type="response.output_text.delta",
                item_id="m",
                output_index=0,
                content_index=0,
                delta="实测",
                sequence_number=1,
                logprobs=[],
            )
        )
    )
    output = MessageOutputItem(
        agent=Agent(name="Test"),
        raw_item=ResponseOutputMessage(
            id="m",
            type="message",
            role="assistant",
            status="completed",
            phase="final_answer",
            content=[{"type": "output_text", "text": "实测", "annotations": [], "logprobs": []}],
        ),
    )
    await adapter.consume(RunItemStreamEvent(name="message_output_created", item=output))
    assert await adapter.finalize(NS(new_items=[output], final_output="实测")) == ["m"]
    assert [name for name, _ in events] == ["text.started", "text.delta", "text.completed", "text.phase"]


@pytest.mark.parametrize("output", ["a" * 30_001, [{"type": "input_text", "text": "a" * 30_001}]])
async def test_long_tool_output_explicitly_marks_bounded_preview(recorder, output):
    events, adapter = recorder
    await adapter.consume(item("tool_call_output_item", {"call_id": "long", "output": output}))
    displayed = events[-1][1]["output"]
    assert len(displayed) <= 30_000
    assert displayed.startswith("a" * 100)
    assert "已截断" in displayed


async def test_large_custom_patch_input_is_marked_as_truncated(recorder):
    events, adapter = recorder
    await adapter.consume(
        item(
            "tool_call_item",
            {
                "type": "custom_tool_call",
                "id": "patch",
                "call_id": "patch-call",
                "name": "apply_patch",
                "input": "*** Begin Patch\n" + "a" * 30_001,
            },
        )
    )
    displayed = events[-1][1]["arguments"]["raw"]
    assert len(displayed) <= 30_000
    assert displayed.startswith("*** Begin Patch")
    assert "已截断" in displayed


@pytest.mark.parametrize("status", ["failed", "error", "cancelled"])
async def test_tool_output_retains_explicit_terminal_status(recorder, status):
    events, adapter = recorder
    await adapter.consume(
        item(
            "tool_call_output_item",
            {
                "type": "apply_patch_call_output",
                "call_id": "patch",
                "status": status,
                "output": "Permission denied",
            },
        )
    )
    assert events[-1][1]["status"] == status
    assert events[-1][1]["output"] == "Permission denied"


async def test_sdk_shell_chunks_preserve_both_streams_and_outcomes(recorder):
    from agents import Agent
    from agents.items import ToolCallOutputItem
    from agents.stream_events import RunItemStreamEvent

    events, adapter = recorder
    chunks = [
        {"stdout": "partial report", "stderr": "missing column", "outcome": {"type": "exit", "exit_code": 7}},
        {"stdout": "retry started", "stderr": "", "outcome": {"type": "timeout"}},
    ]
    output = ToolCallOutputItem(
        agent=Agent(name="Test"),
        output=chunks,
        raw_item={"type": "shell_call_output", "call_id": "shell", "output": chunks},
    )
    await adapter.consume(RunItemStreamEvent(name="tool_output", item=output))
    displayed = events[-1][1]["output"]
    assert "partial report" in displayed and "missing column" in displayed
    assert "Process exited with code 7" in displayed
    assert "retry started" in displayed and "timeout" in displayed.lower()
    assert events[-1][1]["status"] == "failed"


async def test_successful_shell_ignores_error_like_stdout(recorder):
    events, adapter = recorder
    await adapter.consume(
        item(
            "tool_call_output_item",
            {
                "type": "shell_call_output",
                "call_id": "shell",
                "status": "completed",
                "output": [
                    {
                        "stdout": "Process exited with code 7",
                        "stderr": "",
                        "outcome": {"type": "exit", "exit_code": 0},
                    }
                ],
            },
        )
    )
    assert events[-1][1]["status"] == "completed"


async def test_input_file_retains_identity_without_inline_file_bytes(recorder):
    events, adapter = recorder
    await adapter.consume(
        item(
            "tool_call_output_item",
            {
                "call_id": "file",
                "output": [
                    {
                        "type": "input_file",
                        "filename": "report.pdf",
                        "file_id": "file-report",
                        "file_data": "PRIVATE-BASE64-CONTENT",
                    }
                ],
            },
        )
    )
    displayed = events[-1][1]["output"]
    assert "report.pdf" in displayed and "file-report" in displayed
    assert "PRIVATE-BASE64-CONTENT" not in displayed


async def test_mcp_error_metadata_is_allowlisted_and_reaches_sdk_output_status(recorder):
    from agents import Agent, RunContextWrapper
    from agents.items import ToolCallOutputItem
    from agents.mcp import MCPToolCustomDataContext
    from agents.stream_events import RunItemStreamEvent

    context = MCPToolCustomDataContext(
        run_context=RunContextWrapper(context=None),
        server_name="reports",
        tool_name="export",
        tool_display_name="reports_export",
        arguments={},
        is_error=True,
        result_meta={"secret": "PRIVATE-META"},
        structured_content={"secret": "PRIVATE-STRUCTURE"},
        tool_output="Export failed",
    )
    metadata = runtime_events.mcp_tool_display_data(context)
    assert metadata == {"famsun_tool_status": "failed"}
    assert runtime_events.mcp_tool_display_data(NS(is_error=False)) == {}
    events, adapter = recorder
    output = ToolCallOutputItem(
        agent=Agent(name="Test"),
        output="Export failed",
        custom_data=metadata,
        raw_item={"type": "function_call_output", "call_id": "export", "output": "Export failed"},
    )
    await adapter.consume(RunItemStreamEvent(name="tool_output", item=output))
    assert events[-1][1]["status"] == "failed"
    assert "PRIVATE" not in str(events)
