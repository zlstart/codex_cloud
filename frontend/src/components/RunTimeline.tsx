import { useId, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Terminal,
  Users,
  Workflow,
} from "lucide-react";
import type {
  Artifact,
  TimelineItem,
  TimelineState,
  ToolTimelineItem,
} from "../types";
import { Markdown } from "./Markdown";
import { partitionTimeline } from "../lib/runTimeline";
import "../styles/timeline.css";

function printable(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

function ToolStep({ item }: { item: ToolTimelineItem }) {
  const running = item.status === "running";
  const success = item.status === "completed";
  const status = running
    ? "执行中"
    : success
      ? "已完成"
      : item.status === "cancelled"
        ? "已取消"
        : item.status === "interrupted"
          ? "已中断"
          : "执行失败";
  const args = printable(item.arguments);
  const output = printable(item.output);
  return (
    <details
      className={`timeline-tool ${success ? "" : item.status}`}
      data-call-id={item.call_id}
    >
      <summary>
        <Terminal size={15} aria-hidden="true" />
        <span className="timeline-tool-name">{item.name}</span>
        <span className="timeline-tool-status">
          {running ? (
            <LoaderCircle size={12} className="spin" />
          ) : success ? (
            <Check size={12} />
          ) : (
            <CircleAlert size={12} />
          )}
          {status}
        </span>
        <ChevronDown
          size={13}
          className="timeline-tool-chevron"
          aria-hidden="true"
        />
      </summary>
      <div className="timeline-tool-detail">
        <span className="trace-label">输入</span>
        <pre>{args.slice(0, 16000)}</pre>
        {args.length > 16000 && (
          <p className="timeline-truncation">
            输入较长，仅显示前 16,000 个字符。
          </p>
        )}
        {item.output !== undefined && (
          <>
            <span className="trace-label">结果</span>
            <pre>{output.slice(0, 24000)}</pre>
            {output.length > 24000 && (
              <p className="timeline-truncation">
                结果较长，仅显示前 24,000 个字符。
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function ProcessItem({
  item,
  files,
  onPreview,
}: {
  item: TimelineItem;
  files: Artifact[];
  onPreview: (file: Artifact) => void;
}) {
  return (
    <li
      className={`timeline-item timeline-${item.kind} ${item.parent_call_id ? "timeline-child" : ""}`}
      data-item-id={item.id}
    >
      {(item.parent_call_id ||
        (item.agent_id &&
          item.agent_id !== "main" &&
          item.agent_id !== "root")) && (
        <div className="timeline-agent">
          <Users size={12} />
          {item.agent_name ?? item.agent_id ?? "子助手"}
        </div>
      )}
      {item.kind === "text" ? (
        <div className="message-content timeline-commentary">
          <Markdown content={item.text} files={files} onPreview={onPreview} />
        </div>
      ) : item.kind === "tool" ? (
        <ToolStep item={item} />
      ) : item.kind === "notice" ? (
        <p className="timeline-notice">{item.text}</p>
      ) : (
        <div className="task-plan">
          <strong>任务计划</strong>
          <ol>
            {item.steps.map((step, i) => (
              <li
                key={i}
                className={
                  item.completed || i < item.current_step
                    ? "done"
                    : i === item.current_step
                      ? "current"
                      : ""
                }
              >
                <span>
                  {item.completed || i < item.current_step ? (
                    <Check size={11} />
                  ) : (
                    i + 1
                  )}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

export function RunTimeline({
  timeline,
  files,
  onPreview,
  busy = false,
  finalContent,
  history = false,
  initiallyExpanded = false,
}: {
  timeline: TimelineState;
  files: Artifact[];
  onPreview: (file: Artifact) => void;
  busy?: boolean;
  finalContent?: string;
  history?: boolean;
  initiallyExpanded?: boolean;
}) {
  const contentId = useId();
  const [choice, setChoice] = useState<boolean | null>(
    initiallyExpanded ? true : null,
  );
  const expanded =
    choice ??
    (busy && !["completed", "failed", "cancelled"].includes(timeline.status));
  const parts = partitionTimeline(timeline.items);
  const process = parts.process.filter(
    (item) =>
      item.kind !== "text" ||
      (item.text.trim() &&
        !(finalContent && item.text.trim() === finalContent.trim())),
  );
  const toolCount = process.filter((item) => item.kind === "tool").length;
  const pending =
    busy && !["completed", "failed", "cancelled"].includes(timeline.status);
  const status = pending
    ? "正在处理"
    : timeline.status === "failed"
      ? "执行未完成"
      : timeline.status === "cancelled"
        ? "已停止"
        : "执行过程";
  return (
    <>
      {(process.length > 0 || history) && (
        <section className="run-process">
          <button
            className="process-toggle"
            onClick={() => setChoice(!expanded)}
            aria-expanded={expanded}
            aria-controls={contentId}
          >
            {pending ? (
              <LoaderCircle className="spin" size={15} />
            ) : timeline.status === "failed" ? (
              <CircleAlert size={15} />
            ) : (
              <Workflow size={15} />
            )}
            <span>{status}</span>
            {toolCount > 0 && (
              <span className="process-count">{toolCount} 个步骤</span>
            )}
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {expanded && (
            <div id={contentId} className="process-content">
              <ol className="timeline-list">
                {process.map((item) => (
                  <ProcessItem
                    key={item.id}
                    item={item}
                    files={files}
                    onPreview={onPreview}
                  />
                ))}
              </ol>
              {!process.length && (
                <p className="timeline-empty">本次回复没有额外执行记录。</p>
              )}
            </div>
          )}
        </section>
      )}
      {finalContent === undefined && parts.final.length > 0 && (
        <div className="message-content final-answer" data-final-answer="true">
          <Markdown
            content={parts.final.map((item) => item.text).join("\n\n")}
            files={files}
            onPreview={onPreview}
          />
          {pending && <span className="stream-cursor" />}
        </div>
      )}
    </>
  );
}
