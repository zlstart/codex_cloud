import assert from "node:assert/strict";
import test from "node:test";
import {
  initialTimeline,
  reduceRunEvent,
  replayEvents,
  partitionTimeline,
} from "../src/lib/runTimeline.ts";

const event = (sequence, type, data = {}) => ({
  sequence,
  run_id: "run-1",
  type,
  data,
  created_at: "2026-11-02T00:00:00Z",
});

test("preserves text/tool chronology and pairs concurrent identical tools by call ID", () => {
  const state = replayEvents([
    event(1, "text.delta", { item_id: "intro", delta: "Checking files." }),
    event(2, "tool.started", {
      item_id: "tool-a",
      call_id: "call-a",
      name: "shell",
      arguments: { command: "a" },
    }),
    event(3, "text.delta", {
      item_id: "progress",
      delta: "Also checking totals.",
    }),
    event(4, "tool.started", {
      item_id: "tool-b",
      call_id: "call-b",
      name: "shell",
      arguments: { command: "b" },
    }),
    event(5, "tool.completed", {
      call_id: "call-b",
      name: "shell",
      output: "B",
    }),
    event(6, "tool.completed", {
      call_id: "call-a",
      name: "shell",
      output: "A",
    }),
  ]);
  assert.deepEqual(
    state.items.map((item) => item.id),
    ["intro", "tool-a", "progress", "tool-b"],
  );
  assert.equal(state.items[1].output, "A");
  assert.equal(state.items[3].output, "B");
});

test("duplicate replay is idempotent and complete text replaces streamed chunks", () => {
  const events = [
    event(1, "text.delta", { item_id: "answer", delta: "Hel" }),
    event(2, "text.completed", { item_id: "answer", text: "Hello" }),
  ];
  const once = replayEvents(events);
  const twice = events.reduce(reduceRunEvent, once);
  assert.equal(twice.items[0].text, "Hello");
  assert.equal(twice, once);
});

test("root final answer is separate and child final output remains process activity", () => {
  const state = replayEvents([
    event(1, "text.delta", { item_id: "progress", delta: "Working." }),
    event(2, "text.completed", {
      item_id: "child",
      text: "Child answer",
      agent_id: "analyst",
      parent_call_id: "delegate-1",
      phase: "final",
    }),
    event(3, "text.completed", { item_id: "answer", text: "Final answer" }),
    event(4, "text.phase", { item_id: "answer", phase: "final" }),
    event(5, "run.completed", { final_item_ids: ["answer", "child"] }),
  ]);
  const result = partitionTimeline(state.items);
  assert.deepEqual(
    result.process.map((item) => item.id),
    ["progress", "child"],
  );
  assert.deepEqual(
    result.final.map((item) => item.id),
    ["answer"],
  );
  assert.equal(state.status, "completed");
});

test("failure preserves partial text and marks unresolved tool execution interrupted", () => {
  const state = replayEvents([
    event(1, "text.delta", { item_id: "partial", delta: "Collected evidence" }),
    event(2, "tool.started", {
      call_id: "call-a",
      name: "shell",
      arguments: {},
    }),
    event(3, "run.failed", { error: "Provider unavailable" }),
  ]);
  assert.equal(state.items[0].text, "Collected evidence");
  assert.equal(state.items[1].status, "interrupted");
  assert.equal(state.error, "Provider unavailable");
});

test("legacy events remain ordered without inventing stable provider IDs", () => {
  const state = replayEvents([
    event(1, "text.delta", { delta: "First " }),
    event(2, "text.delta", { delta: "note" }),
    event(3, "tool.started", { name: "python", arguments: {} }),
    event(4, "tool.completed", { name: "python", output: "ok" }),
    event(5, "text.delta", { delta: "Second note" }),
  ]);
  assert.deepEqual(
    state.items.map((item) => item.kind),
    ["text", "tool", "text"],
  );
  assert.equal(state.items[0].text, "First note");
  assert.equal(state.items[1].output, "ok");
});

test("a phase received before text and approval replay survive hydration", () => {
  const state = replayEvents([
    event(1, "text.phase", { item_id: "answer", phase: "final" }),
    event(2, "text.delta", { item_id: "answer", delta: "Ready" }),
    event(3, "approval.required", {
      id: "approval-1",
      tool: "send",
      arguments: {},
    }),
  ]);
  assert.equal(state.items[0].phase, "final");
  assert.equal(state.approval.id, "approval-1");
  assert.equal(initialTimeline().items.length, 0);
});

test("later identity metadata keeps child output out of the main final answer", () => {
  const state = replayEvents([
    event(1, "text.started", { item_id: "child" }),
    event(2, "text.completed", {
      item_id: "child",
      text: "Child result",
      phase: "final",
      agent_id: "analyst",
      parent_call_id: "parent",
    }),
  ]);
  assert.equal(partitionTimeline(state.items).final.length, 0);
  assert.equal(state.items[0].parent_call_id, "parent");
});

test("cancelling during the final answer preserves its partial text in the process", () => {
  const state = replayEvents([
    event(1, "text.delta", { item_id: "answer", delta: "Partial conclusion" }),
    event(2, "text.phase", { item_id: "answer", phase: "final" }),
    event(3, "run.cancelled"),
  ]);
  assert.equal(
    partitionTimeline(state.items).process[0]?.text,
    "Partial conclusion",
  );
  assert.equal(partitionTimeline(state.items).final.length, 0);
});

test("trace metadata survives replay and terminal events without accepting arbitrary URLs", () => {
  const traceId = `trace_${"a".repeat(32)}`;
  const events = [
    event(1, "run.started"),
    event(2, "run.tracing", {
      provider: "openai",
      status: "enabled",
      trace_id: traceId,
      workflow_name: "FAMSUN conversation",
      sensitive_data: false,
      url: "javascript:alert(1)",
    }),
    event(3, "run.completed"),
  ];
  const state = replayEvents(events);
  assert.equal(state.tracing.trace_id, traceId);
  assert.equal(state.tracing.status, "enabled");
  assert.equal(state.tracing.sensitive_data, false);
  assert.equal(state.tracing.url, undefined);
  assert.deepEqual(replayEvents(events, state), state);
});

test("tracing config states and invalid trace IDs remain safe during hydration", () => {
  assert.equal(initialTimeline().tracing, undefined);
  for (const status of ["disabled", "missing_key"]) {
    const state = replayEvents([
      event(1, "run.tracing", {
        provider: "openai",
        status,
        trace_id: null,
      }),
    ]);
    assert.equal(state.tracing.status, status);
    assert.equal(state.tracing.trace_id, null);
  }
  const invalid = replayEvents([
    event(1, "run.tracing", {
      provider: "openai",
      status: "enabled",
      trace_id: "../../evil",
      sensitive_data: "false",
    }),
  ]);
  assert.equal(invalid.tracing.trace_id, null);
  assert.equal(invalid.tracing.sensitive_data, false);
  assert.equal(
    replayEvents([
      event(1, "run.tracing", {
        provider: "other",
        status: "enabled",
      }),
    ]).tracing,
    undefined,
  );
});

test("failed tools retain error payload for readable execution history", () => {
  const state = replayEvents([
    event(1, "tool.started", {
      call_id: "call-error",
      name: "exec_command",
      arguments: {},
    }),
    event(2, "tool.failed", {
      call_id: "call-error",
      error: "Permission denied",
    }),
  ]);
  assert.equal(state.items[0].status, "failed");
  assert.equal(state.items[0].output, "Permission denied");
});
