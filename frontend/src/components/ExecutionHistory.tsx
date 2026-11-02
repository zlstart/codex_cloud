import { useEffect, useRef, useState } from "react";
import { ChevronRight, History, LoaderCircle, RotateCcw } from "lucide-react";
import type { Artifact, Run, TimelinePage, TimelineState } from "../types";
import { api, errorMessage } from "../lib/api";
import { initialTimeline, replayEvents } from "../lib/runTimeline";
import { RunTimeline } from "./RunTimeline";

export function ExecutionHistory({
  runId,
  files,
  onPreview,
  finalContent,
  status,
}: {
  runId: string;
  files: Artifact[];
  onPreview: (file: Artifact) => void;
  finalContent?: string;
  status?: Run["status"];
}) {
  const [timeline, setTimeline] = useState<TimelineState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), [runId]);
  async function load() {
    if (loading) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setLoading(true);
    setError("");
    let next = initialTimeline();
    try {
      let after = 0;
      for (;;) {
        const page = await api<TimelinePage>(
          `/runs/${encodeURIComponent(runId)}/timeline?after=${after}&limit=500`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!Array.isArray(page.events))
          throw new Error("执行记录格式无效，请刷新后重试。");
        next = replayEvents(page.events, next);
        next = { ...next, status: page.status ?? status ?? next.status };
        if (!page.has_more) break;
        if (
          !Number.isSafeInteger(page.next_cursor) ||
          page.next_cursor <= after
        )
          throw new Error("执行记录分页未能继续，请重试。");
        after = page.next_cursor;
      }
      setTimeline(next);
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <div className="execution-history">
      {timeline ? (
        <RunTimeline
          key={runId}
          timeline={timeline}
          files={files}
          onPreview={onPreview}
          finalContent={finalContent ?? ""}
          history
          initiallyExpanded
        />
      ) : (
        <button
          className="process-toggle history-toggle"
          onClick={() => void load()}
          disabled={loading}
          aria-label={error ? "重试读取执行记录" : "执行记录"}
        >
          {loading ? (
            <LoaderCircle size={14} className="spin" />
          ) : error ? (
            <RotateCcw size={14} />
          ) : (
            <History size={14} />
          )}
          <span>
            {loading
              ? "正在读取执行记录…"
              : error
                ? "重试读取执行记录"
                : "执行记录"}
          </span>
          <ChevronRight size={13} />
        </button>
      )}
      {error && (
        <p className="timeline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
