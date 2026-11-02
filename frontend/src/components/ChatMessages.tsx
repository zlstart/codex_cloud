import { Fragment, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  Check,
  CircleAlert,
  Copy,
  LoaderCircle,
  ShieldCheck,
  WifiOff,
  X,
} from "lucide-react";
import type {
  Approval,
  Artifact,
  Message,
  Run,
  TimelineState,
  User,
} from "../types";
import { FileTile } from "./Artifacts";
import { Markdown } from "./Markdown";
import { ExecutionHistory } from "./ExecutionHistory";
import { RunTimeline } from "./RunTimeline";
export { Markdown } from "./Markdown";

export function ChatMessages({
  messages,
  runs,
  activeRunId,
  conversationId,
  user,
  timeline,
  busy,
  approval,
  onApprove,
  onPreview,
  connectionLost,
  files,
}: {
  messages: Message[];
  runs: Run[];
  activeRunId?: string;
  conversationId?: string;
  user: User | null;
  timeline: TimelineState;
  busy: boolean;
  approval: Approval | null;
  onApprove: (approved: boolean) => Promise<void>;
  onPreview: (file: Artifact) => void;
  connectionLost: boolean;
  files: Artifact[];
}) {
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const approvalIdentity = useRef<string | null>(null);
  approvalIdentity.current = approval
    ? `${conversationId}:${activeRunId}:${approval.id}`
    : null;
  useEffect(
    () => () => {
      approvalIdentity.current = null;
    },
    [],
  );
  useEffect(() => {
    const scroll = list.current?.closest<HTMLElement>(".chat-scroll");
    if (!scroll) return;
    follow.current = true;
    setShowLatest(false);
    const onScroll = () => {
      const nearBottom =
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
      follow.current = nearBottom;
      setShowLatest(!nearBottom);
    };
    const resize = new ResizeObserver(() => {
      if (follow.current) scroll.scrollTop = scroll.scrollHeight;
      else if (
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <
        100
      ) {
        follow.current = true;
        setShowLatest(false);
      }
    });
    if (list.current) resize.observe(list.current);
    scroll.addEventListener("scroll", onScroll, { passive: true });
    scroll.scrollTop = scroll.scrollHeight;
    return () => {
      resize.disconnect();
      scroll.removeEventListener("scroll", onScroll);
    };
  }, [conversationId]);
  useEffect(() => {
    if (!follow.current) return;
    const scroll = list.current?.closest<HTMLElement>(".chat-scroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [messages.length, timeline.cursor, approval]);
  useEffect(() => {
    setApprovalError("");
    setApproving(false);
  }, [approval?.id]);

  async function decide(approved: boolean) {
    const expected = approvalIdentity.current;
    if (!expected) return;
    setApproving(true);
    setApprovalError("");
    try {
      await onApprove(approved);
    } catch (e) {
      if (approvalIdentity.current === expected)
        setApprovalError(e instanceof Error ? e.message : "授权未能提交");
    } finally {
      if (approvalIdentity.current === expected) setApproving(false);
    }
  }
  const completedMessageRuns = new Set(
    messages.filter((m) => m.role === "assistant").map((m) => m.run_id),
  );
  const orphanedRuns = new Map(
    runs
      .filter(
        (r) =>
          r.id !== activeRunId &&
          !completedMessageRuns.has(r.id) &&
          ["failed", "cancelled"].includes(r.status),
      )
      .map((r) => [r.id, r]),
  );
  const active =
    busy && !["completed", "failed", "cancelled"].includes(timeline.status);

  return (
    <>
      <div className="message-list" ref={list}>
        {messages.map((message) => {
          const incomplete =
            message.role === "user" && message.run_id
              ? orphanedRuns.get(message.run_id)
              : undefined;
          return (
            <Fragment key={message.id}>
              <article className={`message ${message.role}`}>
                <div className={`message-avatar ${message.role}`}>
                  {message.role === "user" ? (
                    user?.name[0] || "你"
                  ) : (
                    <span className="mini-mark">F</span>
                  )}
                </div>
                <div className="message-main">
                  <div className="message-heading">
                    <strong>
                      {message.role === "user" ? "你" : "丰尚助手"}
                    </strong>
                    <span>
                      {new Date(message.created_at).toLocaleTimeString(
                        "zh-CN",
                        { hour: "2-digit", minute: "2-digit" },
                      )}
                    </span>
                  </div>
                  {!!message.attachments?.length && (
                    <div className="message-attachments">
                      {message.attachments.map((file) => (
                        <FileTile
                          key={file.id}
                          file={file}
                          onPreview={onPreview}
                        />
                      ))}
                    </div>
                  )}
                  {message.role === "assistant" && message.run_id && (
                    <ExecutionHistory
                      key={message.run_id}
                      runId={message.run_id}
                      files={files}
                      onPreview={onPreview}
                      finalContent={message.content}
                    />
                  )}
                  <div
                    className={`message-content ${message.role === "assistant" ? "final-answer" : ""}`}
                    data-final-answer={
                      message.role === "assistant" ? "true" : undefined
                    }
                  >
                    {message.role === "user" ? (
                      <p className="user-content">{message.content}</p>
                    ) : (
                      <Markdown
                        content={message.content}
                        files={files}
                        onPreview={onPreview}
                      />
                    )}
                  </div>
                  {message.role === "assistant" && (
                    <div className="message-actions">
                      <button
                        className="icon-button"
                        aria-label="复制回复"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              message.content,
                            );
                            setCopied(message.id);
                            setTimeout(() => setCopied(null), 1500);
                          } catch {
                            /* Clipboard access can be unavailable in embedded browsers. */
                          }
                        }}
                      >
                        {copied === message.id ? (
                          <Check size={14} />
                        ) : (
                          <Copy size={14} />
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </article>
              {incomplete && (
                <article className="message assistant incomplete-message">
                  <div className="message-avatar assistant">
                    <span className="mini-mark">F</span>
                  </div>
                  <div className="message-main">
                    <div className="message-heading">
                      <strong>丰尚助手</strong>
                      <span>
                        {incomplete.status === "failed"
                          ? "执行未完成"
                          : "已停止"}
                      </span>
                    </div>
                    <p className="run-result-notice">
                      <CircleAlert size={15} />
                      {incomplete.error ||
                        (incomplete.status === "cancelled"
                          ? "任务已停止，已完成的步骤仍可查看。"
                          : "本次任务未完成，你可以查看执行过程后重试。")}
                    </p>
                    <ExecutionHistory
                      key={incomplete.id}
                      runId={incomplete.id}
                      files={files}
                      onPreview={onPreview}
                      status={incomplete.status}
                    />
                  </div>
                </article>
              )}
            </Fragment>
          );
        })}
        {busy && (
          <article className="message assistant live-message">
            <div className="message-avatar assistant">
              <span className="mini-mark">F</span>
            </div>
            <div className="message-main">
              <div className="message-heading">
                <strong>丰尚助手</strong>
                <span className="live-label">
                  {approval
                    ? "等待你的确认"
                    : active
                      ? "正在处理"
                      : timeline.status === "completed"
                        ? "已完成"
                        : "已停止"}
                </span>
              </div>
              <RunTimeline
                key={activeRunId}
                timeline={timeline}
                files={files}
                onPreview={onPreview}
                busy
              />
              {connectionLost && (
                <div className="stream-connection" role="status">
                  <WifiOff size={14} />
                  连接暂时中断，正在恢复执行记录…
                </div>
              )}
              {!timeline.items.length && !approval && (
                <div className="thinking-indicator">
                  <i />
                  <i />
                  <i />
                  <span>
                    {connectionLost ? "正在重新连接…" : "正在推进你的任务…"}
                  </span>
                </div>
              )}
              {approval && (
                <div className="approval-card">
                  <header>
                    <ShieldCheck size={20} />
                    <div>
                      <strong>这一步，需要你的确认</strong>
                      <p>助手准备调用外部工具，请确认操作内容。</p>
                    </div>
                  </header>
                  <span className="approval-tool">{approval.tool}</span>
                  <pre>
                    {typeof approval.arguments === "string"
                      ? approval.arguments
                      : JSON.stringify(approval.arguments, null, 2)}
                  </pre>
                  {approvalError && (
                    <p className="form-error" role="alert">
                      {approvalError}
                    </p>
                  )}
                  <div className="approval-actions">
                    <button
                      className="button secondary"
                      onClick={() => void decide(false)}
                      disabled={approving}
                    >
                      <X size={15} />
                      拒绝
                    </button>
                    <button
                      className="button primary"
                      onClick={() => void decide(true)}
                      disabled={approving}
                    >
                      {approving ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <Check size={15} />
                      )}
                      允许本次操作
                    </button>
                  </div>
                </div>
              )}
            </div>
          </article>
        )}
      </div>
      {showLatest && (
        <div className="jump-latest-wrap">
          <button
            className="jump-latest"
            onClick={() => {
              follow.current = true;
              setShowLatest(false);
              const scroll = list.current?.closest<HTMLElement>(".chat-scroll");
              if (scroll) scroll.scrollTop = scroll.scrollHeight;
            }}
          >
            <ArrowDown size={15} />
            回到最新内容
          </button>
        </div>
      )}
    </>
  );
}
