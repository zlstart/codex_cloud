import type {
  RunEvent,
  TextTimelineItem,
  TimelineItem,
  TimelineState,
  ToolTimelineItem,
} from "../types";

export function initialTimeline(): TimelineState {
  return {
    items: [],
    seen: new Set(),
    cursor: 0,
    status: "queued",
    approval: null,
  };
}

function value(data: Record<string, unknown>, key: string): string | undefined {
  return typeof data[key] === "string" && data[key]
    ? (data[key] as string)
    : undefined;
}

function identity(event: RunEvent) {
  return {
    id:
      value(event.data, "item_id") ??
      value(event.data, "call_id") ??
      `event-${event.sequence}`,
    sequence: event.sequence,
    agent_id: value(event.data, "agent_id"),
    agent_name: value(event.data, "agent_name"),
    parent_call_id: value(event.data, "parent_call_id"),
  };
}

function isChild(item: TimelineItem) {
  return (
    !!item.parent_call_id ||
    (!!item.agent_id && !["main", "root"].includes(item.agent_id))
  );
}

export function partitionTimeline(items: TimelineItem[]) {
  const final: TextTimelineItem[] = [];
  const process: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind === "text" && item.phase === "final" && !isChild(item))
      final.push(item);
    else process.push(item);
  }
  return { process, final };
}

/** Every persisted event passes through this reducer, both SSE and JSON history. */
export function reduceRunEvent(
  state: TimelineState,
  event: RunEvent,
): TimelineState {
  if (state.seen.has(event.sequence)) return state;
  const seen = new Set(state.seen);
  seen.add(event.sequence);
  const next: TimelineState = {
    ...state,
    seen,
    cursor: Math.max(state.cursor, event.sequence),
  };
  const data = event.data;
  const meta = identity(event);
  const mergedIdentity = (existing?: TimelineItem) => ({
    ...meta,
    id: existing?.id ?? meta.id,
    sequence: existing?.sequence ?? meta.sequence,
    agent_id: meta.agent_id ?? existing?.agent_id,
    agent_name: meta.agent_name ?? existing?.agent_name,
    parent_call_id: meta.parent_call_id ?? existing?.parent_call_id,
  });
  const items = [...state.items];
  const upsert = (item: TimelineItem, index: number) => {
    if (index < 0) items.push(item);
    else items[index] = item;
    next.items = items.sort((a, b) => a.sequence - b.sequence);
  };

  if (
    ["text.started", "text.delta", "text.completed", "text.phase"].includes(
      event.type,
    )
  ) {
    const itemId = value(data, "item_id");
    // Legacy events had no message identities: only adjacent text deltas can safely join.
    const last = items.at(-1);
    const index = itemId
      ? items.findIndex((item) => item.id === itemId && item.kind === "text")
      : last?.kind === "text" && last.id.startsWith("event-")
        ? items.length - 1
        : -1;
    const existing =
      index >= 0 ? (items[index] as TextTimelineItem) : undefined;
    const phase = ["pending", "intermediate", "final"].includes(
      String(data.phase),
    )
      ? (data.phase as TextTimelineItem["phase"])
      : (existing?.phase ?? "pending");
    const text =
      event.type === "text.completed" && typeof data.text === "string"
        ? data.text
        : (existing?.text ?? "") +
          (event.type === "text.delta" ? String(data.delta ?? "") : "");
    upsert(
      { ...existing, ...mergedIdentity(existing), kind: "text", text, phase },
      index,
    );
  } else if (
    ["tool.started", "tool.completed", "tool.failed"].includes(event.type)
  ) {
    const callId = value(data, "call_id");
    const index = items.findIndex(
      (item) =>
        item.kind === "tool" &&
        (callId
          ? item.call_id === callId
          : value(data, "item_id")
            ? item.id === data.item_id
            : event.type !== "tool.started" &&
              !item.call_id &&
              item.name === data.name &&
              item.status === "running"),
    );
    const existing =
      index >= 0 ? (items[index] as ToolTimelineItem) : undefined;
    const status =
      event.type === "tool.started"
        ? "running"
        : event.type === "tool.failed" ||
            data.status === "failed" ||
            data.status === "error"
          ? "failed"
          : data.status === "cancelled"
            ? "cancelled"
            : "completed";
    upsert(
      {
        ...existing,
        ...mergedIdentity(existing),
        kind: "tool",
        call_id: callId ?? existing?.call_id,
        name: value(data, "name") ?? existing?.name ?? "工具",
        arguments: data.arguments ?? existing?.arguments ?? {},
        output: data.output ?? existing?.output,
        status,
      },
      index,
    );
  } else if (event.type === "plan.updated" && Array.isArray(data.steps)) {
    const id = value(data, "item_id") ?? `plan-${meta.agent_id ?? "main"}`;
    const index = items.findIndex((item) => item.id === id);
    upsert(
      {
        ...meta,
        id,
        sequence: index < 0 ? event.sequence : items[index].sequence,
        kind: "plan",
        steps: data.steps.map(String),
        current_step: Number(data.current_step ?? 0),
        completed: !!data.completed,
      },
      index,
    );
  } else if (
    event.type === "context.trimmed" ||
    event.type === "context.compacted"
  ) {
    upsert(
      {
        ...meta,
        kind: "notice",
        text: "已整理较早的对话上下文，工作空间文件仍然保留。",
      },
      -1,
    );
  } else if (event.type === "approval.required") {
    next.approval = {
      id: String(data.id),
      tool: String(data.tool),
      arguments: data.arguments,
    };
    next.status = "awaiting_approval";
  } else if (event.type === "approval.resolved") {
    if (next.approval?.id === data.id) next.approval = null;
    next.status = "running";
  } else if (event.type === "run.started") {
    next.status = "running";
  } else if (
    ["run.completed", "run.failed", "run.cancelled"].includes(event.type)
  ) {
    next.status = event.type.slice(4) as TimelineState["status"];
    next.error = value(data, "error");
    next.approval = null;
    const finalIds = Array.isArray(data.final_item_ids)
      ? data.final_item_ids
      : [];
    next.items = items.map((item) => {
      if (item.kind === "text")
        return {
          ...item,
          phase:
            next.status === "completed" &&
            !isChild(item) &&
            (finalIds.includes(item.id) || item.phase === "final")
              ? "final"
              : "intermediate",
        };
      if (item.kind === "tool" && item.status === "running")
        return {
          ...item,
          status: next.status === "cancelled" ? "cancelled" : "interrupted",
        };
      return item;
    });
  }
  return next;
}

export function replayEvents(
  events: RunEvent[],
  state = initialTimeline(),
): TimelineState {
  return [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .reduce(reduceRunEvent, state);
}
