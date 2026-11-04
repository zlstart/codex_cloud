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
  ContextTimelineItem,
  TimelineItem,
  TimelineState,
  ToolTimelineItem,
} from "../types";
import { Markdown } from "./Markdown";
import { CodeBlock } from "./CodeBlock";
import { TraceStatus } from "./TraceStatus";
import {
  toolInput,
  toolOutput,
  type ToolPresentation,
} from "../lib/toolPresentation";
import { partitionTimeline } from "../lib/runTimeline";
import "../styles/timeline.css";

function ToolPayload({
  payload,
  empty,
}: {
  payload: ToolPresentation;
  empty: string;
}) {
  return (
    <>
      {payload.metadata.length > 0 && (
        <dl className="tool-metadata">
          {payload.metadata.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {payload.blocks.map((block, index) => (
        <div className="tool-payload" key={index}>
          <span className="trace-label">{block.label}</span>
          <CodeBlock
            code={block.code}
            language={block.language}
            maxHeight={280}
          />
        </div>
      ))}
      {payload.extra && (
        <details className="tool-extra">
          <summary>其他参数与元数据</summary>
          <CodeBlock
            code={JSON.stringify(payload.extra, null, 2)}
            language="json"
            maxHeight={200}
          />
        </details>
      )}
      {!payload.blocks.length && !payload.metadata.length && !payload.extra && (
        <p className="timeline-empty">{empty}</p>
      )}
    </>
  );
}

function ToolStep({ item }: { item: ToolTimelineItem }) {
  const running = item.status === "running";
  const input = toolInput(item.name, item.arguments);
  const output = toolOutput(item.name, item.output);
  const failed =
    item.status === "failed" || (item.status === "completed" && output.failed);
  const returned = item.status === "completed" && !failed;
  const processRunning = returned && output.processRunning;
  const status = running
    ? "执行中"
    : failed
      ? "执行失败"
      : processRunning
        ? "已转入后台"
        : returned
          ? output.exitCode === 0
            ? "已完成"
            : "已返回"
          : item.status === "cancelled"
            ? "已取消"
            : item.status === "interrupted"
              ? "已中断"
              : "执行失败";
  const summary =
    input.blocks[0]?.language === "bash"
      ? input.blocks[0].code.split("\n")[0]
      : undefined;
  return (
    <details
      className={`timeline-tool ${failed ? "failed" : processRunning ? "running" : returned ? "" : item.status}`}
      data-call-id={item.call_id}
    >
      <summary>
        <Terminal size={15} aria-hidden="true" />
        <span className="timeline-tool-name">{item.name}</span>
        {summary && (
          <span className="timeline-tool-command" title={summary}>
            {summary}
          </span>
        )}
        <span className="timeline-tool-status">
          {running ? (
            <LoaderCircle size={12} className="spin" />
          ) : returned && !processRunning ? (
            <Check size={12} />
          ) : processRunning ? (
            <Terminal size={12} />
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
        <ToolPayload payload={input} empty="无输入参数。" />
        {item.output !== undefined && (
          <div className="tool-result">
            <ToolPayload payload={output} empty="工具未返回文本结果。" />
          </div>
        )}
      </div>
    </details>
  );
}

function ContextStatus({ item }: { item: ContextTimelineItem }) {
  const exceeded = item.status === "threshold_exceeded";
  const compacted = item.status === "compacted";
  const number = new Intl.NumberFormat("en-US");
  return (
    <div className="context-status" data-context-status={item.status}>
      <div className="context-status-heading">
        {exceeded ? (
          <CircleAlert size={14} aria-hidden="true" />
        ) : compacted ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Workflow size={14} aria-hidden="true" />
        )}
        <strong>
          {compacted
            ? "已观测到原生压缩"
            : exceeded
              ? "输入超过阈值，未观测到压缩"
              : "尚未观测到原生压缩"}
        </strong>
      </div>
      <p>
        本轮输入：
        {item.input_tokens === null
          ? "提供方未提供"
          : `${number.format(item.input_tokens)} tokens`}
        {" · "}压缩阈值：{number.format(item.threshold)} tokens
      </p>
      {(compacted || exceeded) && (
        <p>
          {compacted
            ? `本轮收到 ${number.format(item.compaction_count)} 个原生压缩结果。`
            : "提供方报告的输入量已超过配置阈值，本轮未返回原生压缩结果。"}
        </p>
      )}
    </div>
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
      ) : item.kind === "context" ? (
        <ContextStatus item={item} />
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
      {(process.length > 0 || history || timeline.tracing) && (
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
              <TraceStatus tracing={timeline.tracing} />
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
