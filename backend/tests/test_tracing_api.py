"""Trace policy travels through the worker; durable links remain owner-only."""

import json
import sys
import types

from agents.tracing import get_trace_provider, set_trace_provider
from agents.tracing.provider import DefaultTraceProvider
from app.runtime import RuntimeConfig
from app.tracing import run_trace
from test_api import register, session, wait_status

pytest_plugins = ["test_api"]


def test_trace_configuration_and_owner_authorized_event_replay(client, app, monkeypatch):
    # An isolated native provider with no exporters guarantees no live delivery.
    previous = get_trace_provider()
    provider = DefaultTraceProvider()
    provider.set_disabled(False)
    set_trace_provider(provider)
    observed = []

    async def runtime(*, config, emit, **_):
        observed.append(config)
        with run_trace(config) as tracing:
            await emit("run.tracing", tracing.event())
        return "done"

    monkeypatch.setitem(
        sys.modules, "app.runtime", types.SimpleNamespace(RuntimeConfig=RuntimeConfig, run_agent=runtime)
    )
    monkeypatch.delenv("OPENAI_AGENTS_DISABLE_TRACING", raising=False)
    settings = app.state.settings
    settings.api_key = "third-party-model-fixture"
    settings.tracing_enabled = True
    settings.tracing_api_key = "openai-trace-fixture"
    settings.tracing_workflow_name = "Trace policy integration"
    try:
        owner = register(client)
        sid = session(client)
        rid = client.post(
            f"/api/sessions/{sid}/runs", json={"content": "hello", "client_request_id": "tracing-test-01"}
        ).json()["id"]
        assert wait_status(client, rid, {"completed", "failed"})["status"] == "completed"
        assert observed[0].api_key == "third-party-model-fixture"
        assert observed[0].tracing_api_key == "openai-trace-fixture"
        assert observed[0].tracing_include_sensitive_data is False
        assert observed[0].user_id == owner["id"]
        assert observed[0].session_id == sid
        assert observed[0].run_id == rid

        timeline = client.get(f"/api/runs/{rid}/timeline").json()
        event = next(event for event in timeline["events"] if event["type"] == "run.tracing")
        assert event["data"]["status"] == "enabled"
        assert event["data"]["workflow_name"] == settings.tracing_workflow_name
        assert event["data"]["url"].endswith(event["data"]["trace_id"])
        assert event["data"]["sensitive_data"] is False
        stream = client.get(f"/api/runs/{rid}/events").text
        assert "event: run.tracing" in stream
        assert event["data"]["trace_id"] in stream
        exported = json.dumps(timeline) + stream + client.get("/api/settings").text
        assert "third-party-model-fixture" not in exported
        assert "openai-trace-fixture" not in exported

        client.post("/api/auth/logout")
        register(client, "trace-other@example.com")
        assert client.get(f"/api/runs/{rid}/timeline").status_code == 404
        assert client.get(f"/api/runs/{rid}/events").status_code == 404
        assert client.get(f"/api/runs/{rid}").status_code == 404
    finally:
        set_trace_provider(previous)
