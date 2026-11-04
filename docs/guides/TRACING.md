# OpenAI Traces

FAMSUN uses the tracing built into **OpenAI Python Agents SDK 0.24.0**. The Responses model can remain on a third-party provider. Trace export goes separately to OpenAI's tracing service; it does not change the model URL, model name, Responses protocol, model credentials or conversation history storage.

## Configuration

Set these server environment variables and restart the service:

```dotenv
AGENT_TRACING_ENABLED=true
OPENAI_TRACING_API_KEY=<an OpenAI project API key>
AGENT_TRACING_WORKFLOW_NAME=FAMSUN conversation
AGENT_TRACING_INCLUDE_SENSITIVE_DATA=false
```

`AGENT_TRACING_ENABLED` defaults to `false`. An empty `OPENAI_TRACING_API_KEY` falls back to `OPENAI_API_KEY`; it **never** falls back to `AGENT_API_KEY`. Keep a third-party provider's credentials in `AGENT_API_KEY`. Tracing enabled without an OpenAI tracing key produces `missing_key` status and the agent still runs normally. `OPENAI_AGENTS_DISABLE_TRACING=1` or `true` also disables tracing. The SDK's programmatic `set_tracing_disabled(True)` is respected.

These options are server configuration, not editable model settings. Keys are not included in API settings, run events, trace metadata or the model's Docker workspace. Do not place a real key in the example file or commit it. Configure the key for the OpenAI project whose dashboard your operators can access.

## Data and lifecycle

Each application run gets one stable `trace_<32 hex characters>` ID, derived from its opaque run ID. The SDK trace's `group_id` is the conversation ID. Metadata contains only `run_id`, `session_id` and `user_id`, which are application IDs rather than names or email addresses. The outer SDK `trace()` scope covers the main runner, specialist calls, approval waiting/resumption, and native cleanup. Multiple messages in the same conversation have separate traces sharing the conversation group.

`trace_include_sensitive_data=False` is passed explicitly to the main and child `RunConfig`. Model and function-tool inputs/outputs are omitted by default. Structural information, such as agent/tool names, timings, span types and application IDs, is still exported. Enable `AGENT_TRACING_INCLUDE_SENSITIVE_DATA=true` only when intentionally sharing model and tool content with OpenAI Traces. The app's opt-in is independent of the SDK's environment default for sensitive capture.

SDK 0.24 Responses spans export response correlation IDs and usage rather than copying full model input/output into the OpenAI ingest payload. For third-party Responses endpoints, OpenAI cannot retrieve the model response from that provider. With sensitive capture disabled, the SDK also omits the third-party response ID. The dashboard can still show native workflow, timing, usage and tool spans; enabling sensitive capture does not guarantee third-party prompt/answer text will appear there. Native function-tool input/output capture follows the opt-in. No custom exporter is added to work around this SDK behavior.

The existing runtime uses a dedicated **thread and event loop per active run**, not a subprocess. The trace scope is created inside that worker and closes after native cleanup on success, failure or cancellation. The default SDK `BatchTraceProcessor` exports periodically on its own background thread and flushes on process exit, with the SDK's bounded five-second shutdown. Per-trace SDK export credentials avoid global key changes when workers overlap. No custom processor or exporter is required in production.

Export is best effort. The SDK logs delivery failures without changing a model result. We deliberately do not call synchronous `flush_traces()` at the end of each run: it has no deadline and could delay completion/cancellation for minutes during an OpenAI outage. Periodic background export and the SDK's process-exit flush preserve prompt task completion. Abrupt process termination can lose buffered spans. The app does not persist resumable run state across server restarts: its existing restart recovery marks active runs failed.

## Run status and dashboard links

The existing owner-authorized SSE endpoint `/api/runs/{id}/events` and replay endpoint `/api/runs/{id}/timeline` include one durable `run.tracing` event:

```json
{
  "provider": "openai",
  "status": "enabled",
  "trace_id": "trace_0123456789abcdef0123456789abcdef",
  "url": "https://platform.openai.com/traces/trace?trace_id=trace_0123456789abcdef0123456789abcdef",
  "workflow_name": "FAMSUN conversation",
  "sensitive_data": false
}
```

`status` is `enabled`, `disabled` or `missing_key`. Disabled and missing-key events have `null` ID and URL. `enabled` means SDK recording/export is configured, **not** confirmation that OpenAI received the trace: the native exporter does not return delivery acknowledgements. The dashboard link requires the viewer's own OpenAI project access and may take time to populate. The event contains no credentials. Runs that fail initial model/runtime policy validation before execution may not create a tracing event; older runs have none.

## Verification and sources

Tests replace the SDK exporter with in-memory capture to verify native spans, one trace through approval resume, sensitive-data defaults and opt-in, separate model/export credentials, disabled/missing-key behavior and trace cleanup. API tests exercise the actual worker bridge and verify owner-only live/replayed links. Deterministic Responses fixtures do not constitute live provider or live OpenAI trace-delivery validation.

- [Official tracing guide](https://openai.github.io/openai-agents-python/tracing/)
- [SDK 0.24 RunConfig](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/run_config.py)
- [SDK trace creation and scoped export key](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/tracing/create.py)
- [SDK batch processor and OpenAI exporter](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/tracing/processors.py)
- [SDK tracing setup and process-exit cleanup](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/tracing/setup.py)
- [SDK Responses tracing/redaction](https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/models/openai_responses.py)
