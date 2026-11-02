import { useEffect, useRef, useState } from "react";
import type { Approval, Artifact, Run, ToolEvent } from "../types";
export function useRunStream(
  run: Run | null,
  onTerminal: (status: string, error?: string) => void,
  onArtifact: (file: Artifact) => void,
  onNotice?: (message: string) => void,
) {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<{
    steps: string[];
    current_step: number;
    completed: boolean;
  } | null>(null);
  const [tools, setTools] = useState<ToolEvent[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const terminalRef = useRef(onTerminal);
  const artifactRef = useRef(onArtifact);
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  terminalRef.current = onTerminal;
  artifactRef.current = onArtifact;
  useEffect(() => {
    setText("");
    setPlan(null);
    setTools([]);
    setApproval(null);
    setConnectionLost(false);
    if (!run) return;
    const source = new EventSource(`/api/runs/${run.id}/events?after=0`, {
      withCredentials: true,
    });
    const seen = new Set<string>();
    const events = [
      "run.started",
      "text.delta",
      "tool.started",
      "tool.completed",
      "artifact.created",
      "approval.required",
      "approval.resolved",
      "context.trimmed",
      "plan.updated",
      "run.completed",
      "run.failed",
      "run.cancelled",
    ];
    const handler = (event: Event) => {
      const e = event as MessageEvent;
      const key = e.lastEventId;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      setConnectionLost(false);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (e.type) {
        case "text.delta":
          setText((t) => t + String(data.delta ?? ""));
          break;
        case "tool.started":
          setTools((items) => [
            ...items,
            {
              id: key || crypto.randomUUID(),
              name: String(data.name ?? "工具"),
              arguments: data.arguments,
              status: "running",
            },
          ]);
          break;
        case "tool.completed":
          setTools((items) => {
            const index = items.findIndex(
              (i) => i.name === data.name && i.status === "running",
            );
            return index < 0
              ? [
                  ...items,
                  {
                    id: key || crypto.randomUUID(),
                    name: String(data.name ?? "工具"),
                    arguments: {},
                    output: data.output,
                    status: "completed",
                  },
                ]
              : items.map((t, i) =>
                  i === index
                    ? { ...t, status: "completed", output: data.output }
                    : t,
                );
          });
          break;
        case "artifact.created":
          if (data.artifact) artifactRef.current(data.artifact as Artifact);
          break;
        case "approval.required":
          setApproval({
            id: String(data.id),
            tool: String(data.tool),
            arguments: data.arguments,
          });
          break;
        case "plan.updated":
          if (Array.isArray(data.steps))
            setPlan({
              steps: data.steps.map(String),
              current_step: Number(data.current_step ?? 0),
              completed: !!data.completed,
            });
          break;
        case "approval.resolved":
          setApproval((current) =>
            current?.id === String(data.id) ? null : current,
          );
          break;
        case "context.trimmed":
          noticeRef.current?.(
            "当前对话较长，助手已缩减较早的消息以继续任务。工作空间文件仍然保留。",
          );
          break;
        case "run.completed":
        case "run.failed":
        case "run.cancelled":
          source.close();
          setApproval(null);
          terminalRef.current(e.type, String(data.error ?? ""));
          break;
      }
    };
    for (const event of events) source.addEventListener(event, handler);
    source.onopen = () => setConnectionLost(false);
    source.onerror = () => setConnectionLost(true);
    return () => source.close();
  }, [run?.id]);
  return { liveText: text, tools, approval, setApproval, connectionLost, plan };
}
