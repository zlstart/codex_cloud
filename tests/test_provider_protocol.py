"""Protocol contract tests through the actual Agents SDK and OpenAI HTTP client.

HTTP is a deterministic in-memory fixture, never an external model service.
"""
import asyncio
import json

import httpx
import pytest
from app import runtime
from openai import AsyncOpenAI


def sse(payloads, done=False):
    data = "".join(f"data: {json.dumps(item)}\n\n" for item in payloads)
    return httpx.Response(200, headers={"content-type": "text/event-stream"},
                          content=data + ("data: [DONE]\n\n" if done else ""))


def chunk(delta, finish=None):
    return {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1,
            "model": "fixture-model", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


async def run_fixture(monkeypatch, tmp_path, handler, mode):
    requests = []

    def transport(request):
        body = json.loads(request.content)
        requests.append(body)
        assert request.url.host == "protocol.test"
        assert request.headers["authorization"] == "Bearer local-fixture-only"
        return handler(request, body, len(requests))

    def client_factory(**kwargs):
        return AsyncOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)))

    monkeypatch.setattr(runtime, "AsyncOpenAI", client_factory)
    events = []

    async def emit(name, data):
        events.append((name, data))

    async def approve(*args):
        raise AssertionError("This fixture has no remote MCP tools")

    text = await runtime.run_agent(
        config=runtime.RuntimeConfig(base_url="https://protocol.test/v1", api_key="local-fixture-only",
                                     model="fixture-model", api_mode=mode, sandbox_backend="disabled"),
        workspace=tmp_path, messages=[{"role": "user", "content": "生成一份可下载报告"}],
        emit=emit, cancel_event=asyncio.Event(), request_approval=approve,
    )
    return text, requests, events


@pytest.mark.asyncio
async def test_chat_completions_stream_executes_real_workspace_tool(monkeypatch, tmp_path):
    def handler(request, body, sequence):
        assert request.url.path == "/v1/chat/completions"
        assert body["stream"] is True and body["model"] == "fixture-model"
        if sequence == 1:
            assert "write_file" in [tool["function"]["name"] for tool in body["tools"]]
            args = json.dumps({"path": "outputs/report.md", "content": "# 协议验证\n数据已经保存。"}, ensure_ascii=False)
            return sse([
                chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": "call_report", "type": "function",
                                                             "function": {"name": "write_file", "arguments": args}}]}),
                chunk({}, "tool_calls"),
            ], done=True)
        assert sequence == 2, "SDK loop exceeded fixture expectations"
        assert any(item.get("role") == "tool" for item in body["messages"])
        return sse([chunk({"role": "assistant", "content": "报告已保存。"}), chunk({}, "stop")], done=True)

    text, requests, events = await run_fixture(monkeypatch, tmp_path, handler, "chat_completions")
    assert text == "报告已保存。"
    assert len(requests) == 2
    assert (tmp_path / "outputs/report.md").read_text() == "# 协议验证\n数据已经保存。"
    assert any(name == "text.delta" and data["delta"] == text for name, data in events)
    assert any(name == "artifact.discovered" and data["path"] == "outputs/report.md" for name, data in events)


@pytest.mark.asyncio
async def test_responses_api_stream_contract(monkeypatch, tmp_path):
    message = {"id": "msg_fixture", "type": "message", "status": "completed", "role": "assistant",
               "content": [{"type": "output_text", "text": "Responses 协议已连接。", "annotations": [], "logprobs": []}]}
    response = {
        "id": "resp_fixture", "object": "response", "created_at": 1, "status": "completed",
        "error": None, "incomplete_details": None, "instructions": None, "max_output_tokens": None,
        "metadata": {}, "model": "fixture-model", "output": [message], "parallel_tool_calls": False,
        "previous_response_id": None, "reasoning": {"effort": None, "summary": None}, "store": False,
        "temperature": 1, "text": {"format": {"type": "text"}}, "tool_choice": "auto", "tools": [],
        "top_p": 1, "truncation": "disabled", "user": None,
        "usage": {"input_tokens": 10, "input_tokens_details": {"cached_tokens": 0},
                  "output_tokens": 5, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 15},
    }

    def handler(request, body, sequence):
        assert request.url.path == "/v1/responses" and sequence == 1
        assert body["stream"] is True
        empty = {**response, "output": [], "status": "in_progress", "usage": None}
        return sse([
            {"type": "response.created", "sequence_number": 0, "response": empty},
            {"type": "response.output_item.added", "sequence_number": 1, "output_index": 0,
             "item": {**message, "status": "in_progress", "content": []}},
            {"type": "response.content_part.added", "sequence_number": 2, "output_index": 0,
             "content_index": 0, "item_id": message["id"], "part": {"type": "output_text", "text": "", "annotations": [], "logprobs": []}},
            {"type": "response.output_text.delta", "sequence_number": 3, "output_index": 0,
             "content_index": 0, "item_id": message["id"], "delta": "Responses 协议已连接。", "logprobs": []},
            {"type": "response.output_item.done", "sequence_number": 4, "output_index": 0, "item": message},
            {"type": "response.completed", "sequence_number": 5, "response": response},
        ])

    text, requests, events = await run_fixture(monkeypatch, tmp_path, handler, "responses")
    assert text == "Responses 协议已连接。" and len(requests) == 1
    assert any(name == "text.delta" for name, _ in events)
