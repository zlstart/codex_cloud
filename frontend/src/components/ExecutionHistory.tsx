import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  History,
  LoaderCircle,
  Check,
} from "lucide-react";
import type { ToolEvent } from "../types";

export function ExecutionHistory({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<ToolEvent[] | null>(null);
  const [error, setError] = useState("");
  async function toggle() {
    setOpen(!open);
    if (open || steps || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/events?after=0`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error("暂时无法读取执行记录。");
      const text = await response.text();
      const results: ToolEvent[] = [];
      for (const block of text.split(/\r?\n\r?\n/)) {
        const event = block
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const dataText = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!dataText) continue;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataText) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event === "tool.started")
          results.push({
            id: String(results.length),
            name: String(data.name ?? "工具"),
            arguments: data.arguments,
            status: "running",
          });
        if (event === "tool.completed") {
          const step = results.find(
            (item) => item.name === data.name && item.status === "running",
          );
          if (step) {
            step.status = "completed";
            step.output = data.output;
          } else
            results.push({
              id: String(results.length),
              name: String(data.name ?? "工具"),
              arguments: {},
              status: "completed",
              output: data.output,
            });
        }
      }
      setSteps(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="execution-history">
      <button className="history-toggle" onClick={() => void toggle()}>
        <History size={13} />
        <span>执行记录</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="history-content">
          {loading ? (
            <span className="history-loading">
              <LoaderCircle size={13} className="spin" />
              正在读取…
            </span>
          ) : error ? (
            <p>{error}</p>
          ) : steps?.length ? (
            steps.map((step) => (
              <details className="trace-step" key={step.id}>
                <summary>
                  <Check size={12} />
                  <span>{step.name}</span>
                  <ChevronDown size={12} />
                </summary>
                <div>
                  <span className="trace-label">输入</span>
                  <pre>
                    {typeof step.arguments === "string"
                      ? step.arguments
                      : JSON.stringify(step.arguments, null, 2)}
                  </pre>
                  {step.output !== undefined && (
                    <>
                      <span className="trace-label">结果</span>
                      <pre>
                        {typeof step.output === "string"
                          ? step.output
                          : JSON.stringify(step.output, null, 2)}
                      </pre>
                    </>
                  )}
                </div>
              </details>
            ))
          ) : (
            <p>本次回复没有调用工具。</p>
          )}
        </div>
      )}
    </div>
  );
}
