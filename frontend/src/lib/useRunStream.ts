import { useEffect, useRef, useState } from "react";
import type { Artifact, Run, RunEvent, TimelineState } from "../types";
import { contextNotice, initialTimeline, reduceRunEvent } from "./runTimeline";

const eventTypes = [
  "run.started",
  "run.tracing",
  "text.started",
  "text.delta",
  "text.completed",
  "text.phase",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "artifact.created",
  "artifact.removed",
  "approval.required",
  "approval.resolved",
  "context.trimmed",
  "context.compacted",
  "context.status",
  "plan.updated",
  "run.completed",
  "run.failed",
  "run.cancelled",
];
const emptyTimeline = initialTimeline();

export function useRunStream(
  run: Run | null,
  onTerminal: (status: string, error: string, runId: string) => void,
  onArtifact: (file: Artifact) => void,
  onNotice?: (message: string) => void,
  onArtifactRemoved?: (file: Artifact) => void,
) {
  const [snapshot, setSnapshot] = useState<{
    runId: string | null;
    timeline: TimelineState;
  }>({ runId: null, timeline: emptyTimeline });
  const [disconnectedRun, setDisconnectedRun] = useState<string | null>(null);
  const liveState = useRef<{ runId: string; timeline: TimelineState } | null>(
    null,
  );
  const activeRun = useRef(run?.id);
  activeRun.current = run?.id;
  const callbacks = useRef({
    onTerminal,
    onArtifact,
    onNotice,
    onArtifactRemoved,
  });
  callbacks.current = { onTerminal, onArtifact, onNotice, onArtifactRemoved };

  useEffect(() => {
    if (!run) return;
    const runId = run.id;
    let active = true;
    const current = { runId, timeline: initialTimeline() };
    liveState.current = current;
    setSnapshot({ ...current });
    setDisconnectedRun(null);
    const source = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events?after=0`,
      { withCredentials: true },
    );
    const valid = () => active && activeRun.current === runId;
    const handler = (event: Event) => {
      if (!valid()) return;
      const message = event as MessageEvent;
      const sequence = Number(message.lastEventId);
      if (
        !Number.isSafeInteger(sequence) ||
        sequence <= 0 ||
        current.timeline.seen.has(sequence)
      )
        return;
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(message.data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          return;
        data = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      const entry: RunEvent = {
        sequence,
        run_id: runId,
        type: message.type,
        data,
        created_at: "",
      };
      current.timeline = reduceRunEvent(current.timeline, entry);
      setSnapshot({ ...current });
      setDisconnectedRun(null);
      if (message.type === "artifact.created" && data.artifact)
        callbacks.current.onArtifact(data.artifact as Artifact);
      if (message.type === "artifact.removed" && data.artifact)
        callbacks.current.onArtifactRemoved?.(data.artifact as Artifact);
      const notice = contextNotice(message.type);
      if (notice) callbacks.current.onNotice?.(notice);
      if (
        ["run.completed", "run.failed", "run.cancelled"].includes(message.type)
      ) {
        source.close();
        callbacks.current.onTerminal(
          message.type,
          String(data.error ?? ""),
          runId,
        );
      }
    };
    for (const name of eventTypes) source.addEventListener(name, handler);
    source.onopen = () => {
      if (valid()) setDisconnectedRun(null);
    };
    source.onerror = () => {
      if (valid()) setDisconnectedRun(runId);
    };
    return () => {
      active = false;
      source.close();
    };
  }, [run?.id]);

  const timeline =
    snapshot.runId === run?.id ? snapshot.timeline : emptyTimeline;
  function clearApproval(expectedRunId: string, expectedApprovalId: string) {
    const current = liveState.current;
    if (
      current?.runId !== expectedRunId ||
      activeRun.current !== expectedRunId ||
      current.timeline.approval?.id !== expectedApprovalId
    )
      return;
    current.timeline = { ...current.timeline, approval: null };
    setSnapshot({ ...current });
  }
  return {
    timeline,
    approval: timeline.approval,
    clearApproval,
    connectionLost: disconnectedRun !== null && disconnectedRun === run?.id,
  };
}
