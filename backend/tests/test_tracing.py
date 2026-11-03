"""Actual SDK tracing and Responses protocol fixtures; no network trace export."""

import asyncio
import json
from contextlib import asynccontextmanager

import httpx
import pytest
from agents import Agent, OpenAIResponsesModel, RunConfig, Runner, function_tool
from agents.sandbox import Manifest
from agents.sandbox.sandboxes.unix_local import UnixLocalSandboxClient
from agents.tracing import TracingProcessor, function_span, get_current_trace
from agents.tracing import setup as tracing_setup
from agents.tracing.provider import DefaultTraceProvider
from app import runtime, tracing
from app.config import Settings
from app.runtime import RuntimeConfig
from openai import AsyncOpenAI


class CaptureProcessor(TracingProcessor):
    def __init__(self):
        self.traces = []
        self.spans = []
        self.lifecycle = []

    def on_trace_start(self, trace):
        self.traces.append(trace)
        self.lifecycle.append("trace.start")

    def on_trace_end(self, trace):
        self.lifecycle.append("trace.end")

    def on_span_start(self, span):
        pass

    def on_span_end(self, span):
        self.spans.append(span)
        self.lifecycle.append("span.end")

    def force_flush(self):
        self.lifecycle.append("flush")

    def shutdown(self):
        pass


@pytest.fixture
def capture(monkeypatch):
    # Replace the entire provider, so the default network exporter cannot run.
    monkeypatch.delenv("OPENAI_AGENTS_DISABLE_TRACING", raising=False)
    provider = DefaultTraceProvider()
    processor = CaptureProcessor()
    provider.set_processors([processor])
    monkeypatch.setattr(tracing_setup, "GLOBAL_TRACE_PROVIDER", provider)
    return processor


def config(**overrides):
    values = {
        "base_url": "https://third-party.test/v1",
        "api_key": "fixture-third-party-key",
        "model": "third-party-model",
        "user_id": "user-opaque-id",
        "session_id": "conversation-opaque-id",
        "run_id": "run-opaque-id",
        "tracing_enabled": True,
        "tracing_api_key": "fixture-openai-tracing-key",
    }
    return RuntimeConfig(**(values | overrides))


def test_settings_tracing_requires_explicit_enable_and_never_uses_provider_key(monkeypatch, tmp_path):
    for name in (
        "AGENT_TRACING_ENABLED", "OPENAI_TRACING_API_KEY", "OPENAI_API_KEY",
        "AGENT_TRACING_WORKFLOW_NAME", "AGENT_TRACING_INCLUDE_SENSITIVE_DATA",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AGENT_API_KEY", "fixture-third-party-key")
    monkeypatch.setenv("OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA", "true")
    settings = Settings(data_dir=tmp_path)
    assert settings.api_key == "fixture-third-party-key"
    assert settings.tracing_api_key == ""
    assert settings.tracing_enabled is False
    assert settings.tracing_include_sensitive_data is False
    assert settings.tracing_workflow_name == "FAMSUN conversation"

    monkeypatch.setenv("OPENAI_API_KEY", "fixture-openai-fallback")
    assert Settings(data_dir=tmp_path).tracing_api_key == "fixture-openai-fallback"
    monkeypatch.setenv("OPENAI_TRACING_API_KEY", "fixture-openai-dedicated")
    monkeypatch.setenv("AGENT_TRACING_ENABLED", "true")
    monkeypatch.setenv("AGENT_TRACING_INCLUDE_SENSITIVE_DATA", "true")
    monkeypatch.setenv("AGENT_TRACING_WORKFLOW_NAME", "Tenant assistant")
    explicit = Settings(data_dir=tmp_path)
    assert explicit.tracing_api_key == "fixture-openai-dedicated"
    assert explicit.tracing_enabled is True
    assert explicit.tracing_include_sensitive_data is True
    assert explicit.tracing_workflow_name == "Tenant assistant"
    assert explicit.api_key == "fixture-third-party-key"


@pytest.mark.parametrize(
    "overrides,sdk_disabled,expected",
    [
        ({"tracing_enabled": False}, None, "disabled"),
        ({"tracing_api_key": ""}, None, "missing_key"),
        ({}, "true", "disabled"),
        ({}, "1", "disabled"),
    ],
)
def test_disabled_or_missing_key_creates_no_trace_or_export(
    capture, monkeypatch, overrides, sdk_disabled, expected
):
    if sdk_disabled:
        monkeypatch.setenv("OPENAI_AGENTS_DISABLE_TRACING", sdk_disabled)
    with tracing.run_trace(config(**overrides)) as active:
        event = active.event()
        assert event["provider"] == "openai"
        assert event["status"] == expected
        assert event["url"] is None and event["trace_id"] is None
        assert active.run_config()["tracing_disabled"] is True
        with function_span("must-not-export", input="private input"):
            pass
    assert capture.traces == [] and capture.spans == []
    assert capture.lifecycle == []


def test_trace_identity_is_stable_per_run_and_grouped_by_conversation(capture):
    events = []
    for run_id in ("run-one", "run-one", "run-two"):
        with tracing.run_trace(config(run_id=run_id)) as active:
            event = active.event()
            events.append(event)
            current = get_current_trace()
            assert current.trace_id == event["trace_id"]
            assert current.group_id == "conversation-opaque-id"
            assert current.metadata == {
                "run_id": run_id,
                "session_id": "conversation-opaque-id",
                "user_id": "user-opaque-id",
            }
            assert current.tracing_api_key == "fixture-openai-tracing-key"
            assert event["url"].endswith(event["trace_id"])
            assert event["sensitive_data"] is False
            assert "key" not in json.dumps(event)
    assert events[0]["trace_id"] == events[1]["trace_id"]
    assert events[0]["trace_id"] != events[2]["trace_id"]
    assert capture.lifecycle == ["trace.start", "trace.end"] * 3


def test_sdk_manual_disable_overrides_application_enable(capture):
    tracing_setup.get_trace_provider().set_disabled(True)
    with tracing.run_trace(config()) as active:
        assert active.event()["status"] == "disabled"
        assert active.event()["trace_id"] is None and active.event()["url"] is None
        assert active.run_config()["tracing_disabled"] is True
        with function_span("disabled-operation"):
            pass
    assert capture.traces == [] and capture.spans == []


async def test_concurrent_runs_isolate_trace_identity_and_export_credentials(capture):
    ready = asyncio.Event()
    entered = []

    async def run(identity):
        with tracing.run_trace(config(
            run_id=identity, session_id=f"conversation-{identity}",
            tracing_api_key=f"fixture-trace-key-{identity}",
        )) as active, function_span(f"parent-{identity}"):
            entered.append(identity)
            if len(entered) == 2:
                ready.set()
            await ready.wait()
            with function_span(f"child-{identity}"):
                assert get_current_trace().trace_id == active.event()["trace_id"]
            return active.event()

    first, second = await asyncio.wait_for(asyncio.gather(run("one"), run("two")), 5)
    assert first["trace_id"] != second["trace_id"]
    assert len(capture.traces) == 2 and len(capture.spans) == 4
    traces = {item.trace_id: item for item in capture.traces}
    for span in capture.spans:
        native = traces[span.trace_id]
        identity = native.metadata["run_id"]
        assert span.span_data.name.endswith(identity)
        assert span.tracing_api_key == native.tracing_api_key == f"fixture-trace-key-{identity}"
    assert capture.lifecycle.count("trace.end") == 2
    assert "flush" not in capture.lifecycle


def response(items, identity):
    return httpx.Response(200, json={
        "id": identity, "object": "response", "created_at": 1, "status": "completed",
        "model": "third-party-model", "output": items, "parallel_tool_calls": True,
        "tool_choice": "auto", "tools": [], "temperature": 1, "top_p": 1,
        "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
    })


@pytest.mark.parametrize("sensitive", [False, True])
@pytest.mark.parametrize("approved", [False, True])
async def test_real_sdk_approval_resume_uses_one_trace_and_respects_sensitive_opt_in(
    capture, sensitive, approved
):
    requests, executions = [], []

    @function_tool(needs_approval=True)
    def publish_report(title: str) -> str:
        """Publish a report with the supplied title."""
        executions.append(title)
        return "private-tool-output"

    def transport(request):
        assert request.url == httpx.URL("https://third-party.test/v1/responses")
        assert request.headers["authorization"] == "Bearer fixture-third-party-key"
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            return response([{
                "id": "fc_publish", "type": "function_call", "status": "completed",
                "name": "publish_report", "arguments": '{"title":"private-tool-input"}',
                "call_id": "call_publish",
            }], "resp_private_first")
        return response([{
            "id": "msg_final", "type": "message", "status": "completed", "role": "assistant",
            "content": [{"type": "output_text", "text": "private-final-answer", "annotations": []}],
        }], "resp_private_second")

    async with AsyncOpenAI(
        api_key="fixture-third-party-key", base_url="https://third-party.test/v1",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)),
    ) as client:
        agent = Agent(
            name="Report assistant", model=OpenAIResponsesModel("third-party-model", client),
            tools=[publish_report],
        )
        with tracing.run_trace(config(tracing_include_sensitive_data=sensitive)) as active:
            run_config = RunConfig(**active.run_config())
            initial = await asyncio.wait_for(
                Runner.run(agent, "private-user-input", run_config=run_config), 5
            )
            assert len(initial.interruptions) == 1
            assert executions == []
            state = initial.to_state()
            if approved:
                state.approve(initial.interruptions[0])
            else:
                state.reject(initial.interruptions[0])
            final = await asyncio.wait_for(Runner.run(agent, state, run_config=run_config), 5)
            assert final.final_output == "private-final-answer"
            assert capture.lifecycle.count("trace.start") == 1
            assert "trace.end" not in capture.lifecycle
            event = active.event()

    assert executions == (["private-tool-input"] if approved else [])
    assert len(requests) == 2
    assert capture.lifecycle[-1] == "trace.end"
    assert "flush" not in capture.lifecycle
    assert len(capture.traces) == 1
    assert capture.spans
    assert all(span.trace_id == event["trace_id"] for span in capture.spans)
    assert all(span.tracing_api_key == "fixture-openai-tracing-key" for span in capture.spans)
    exported = json.dumps([item.export() for item in capture.traces + capture.spans])
    assert "fixture-third-party-key" not in exported
    assert "fixture-openai-tracing-key" not in exported
    response_spans = [span.span_data for span in capture.spans if span.span_data.type == "response"]
    assert len(response_spans) == 2
    captured_model_data = json.dumps([
        {"input": span.input, "response": span.response.model_dump() if span.response else None}
        for span in response_spans
    ])
    assert ("private-user-input" in captured_model_data) is sensitive
    assert ("private-final-answer" in captured_model_data) is sensitive
    assert ("private-tool-input" in exported) is sensitive
    assert ("private-tool-output" in exported) is (sensitive and approved)
    assert ("resp_private_first" in exported) is sensitive
    assert event["sensitive_data"] is sensitive


@pytest.mark.parametrize("error", [RuntimeError("fixture failure"), asyncio.CancelledError()])
def test_trace_closes_after_errors_and_cancellation(capture, error):
    with pytest.raises(type(error)), tracing.run_trace(config()), function_span("operation"):
        raise error
    assert capture.lifecycle[-1] == "trace.end"
    assert "flush" not in capture.lifecycle
    assert get_current_trace() is None


def test_run_cleanup_does_not_wait_for_background_export(capture, monkeypatch):
    def forbidden_flush():
        pytest.fail("A long-lived worker must not block on a synchronous trace export")

    monkeypatch.setattr(capture, "force_flush", forbidden_flush)
    with tracing.run_trace(config()):
        pass
    assert capture.lifecycle[-1] == "trace.end"


@pytest.mark.parametrize(
    "overrides,expected",
    [({}, "enabled"), ({"tracing_api_key": ""}, "missing_key"), ({"tracing_enabled": False}, "disabled")],
)
async def test_runtime_stream_preserves_provider_and_emits_owner_safe_trace_event(
    capture, monkeypatch, tmp_path, overrides, expected
):
    events, requests = [], []

    @asynccontextmanager
    async def sandbox(workspace, **kwargs):
        # Test-only capability preparation; no model commands are executed here.
        workspace.mkdir(parents=True, exist_ok=True)
        client = UnixLocalSandboxClient(inherit_host_environment=False)
        session = await client.create(manifest=Manifest(root=str(workspace)))
        async with session:
            yield session

    def transport(request):
        assert request.url == httpx.URL("https://third-party.test/v1/responses")
        assert request.headers["authorization"] == "Bearer fixture-third-party-key"
        body = json.loads(request.content)
        assert body["model"] == "third-party-model" and body["stream"] is True
        requests.append(body)
        item = {
            "id": "msg_final", "type": "message", "status": "completed", "role": "assistant",
            "phase": "final_answer",
            "content": [{"type": "output_text", "text": "private-runtime-answer", "annotations": []}],
        }
        completed = response([item], "resp_runtime").json()
        stream = [
            {"type": "response.created", "response": {**completed, "output": [], "status": "in_progress"}},
            {"type": "response.output_item.added", "output_index": 0, "item": {**item, "content": []}},
            {"type": "response.output_text.delta", "output_index": 0, "content_index": 0,
             "item_id": "msg_final", "delta": "private-runtime-answer"},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": completed},
        ]
        content = "".join(
            f"data: {json.dumps(event | {'sequence_number': index})}\n\n"
            for index, event in enumerate(stream)
        )
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=content)

    monkeypatch.setattr(runtime, "open_chat_sandbox", sandbox)
    monkeypatch.setattr(
        runtime, "AsyncOpenAI",
        lambda **kwargs: AsyncOpenAI(
            **kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport))
        ),
    )

    async def emit(name, data):
        events.append((name, data))

    async def approve(*args):
        pytest.fail("No approval expected for a text-only response")

    result = await asyncio.wait_for(runtime.run_agent(
        config=config(state_dir=tmp_path / "history", **overrides),
        workspace=tmp_path / "workspace", messages=[{"role": "user", "content": "private-runtime-input"}],
        emit=emit, cancel_event=asyncio.Event(), request_approval=approve,
    ), 10)
    assert result == "private-runtime-answer"
    assert len(requests) == 1
    trace_events = [data for name, data in events if name == "run.tracing"]
    assert len(trace_events) == 1
    event = trace_events[0]
    assert event["status"] == expected
    assert "fixture-" not in json.dumps(event)
    if expected == "enabled":
        assert len(capture.traces) == 1
        assert capture.traces[0].trace_id == event["trace_id"]
        response_spans = [span.span_data for span in capture.spans if span.span_data.type == "response"]
        assert len(response_spans) == 1
        assert response_spans[0].input is None and response_spans[0].response is None
        assert capture.lifecycle[-1] == "trace.end"
    else:
        assert event["url"] is None
        assert capture.traces == [] and capture.spans == []
