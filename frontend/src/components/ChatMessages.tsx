import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  LoaderCircle,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Approval, Artifact, Message, ToolEvent, User } from "../types";
import { FileTile } from "./Artifacts";
import { safeArtifactUrl } from "../lib/api";
import { ExecutionHistory } from "./ExecutionHistory";
export function Markdown({
  content,
  files,
  onPreview,
}: {
  content: string;
  files: Artifact[];
  onPreview: (file: Artifact) => void;
}) {
  function resolveFile(link: string | undefined) {
    if (!link) return undefined;
    const direct = files.find((file) => file.url === link);
    if (direct) return direct;
    if (/^[a-z]+:\/\//i.test(link)) return undefined;
    const relative = link
      .replace(/^sandbox:/, "")
      .replace(/^\/workspace\//, "")
      .replace(/^\/mnt\/data\//, "outputs/");
    if (
      relative.includes("..") ||
      (!relative.startsWith("outputs/") && relative.includes("/"))
    )
      return undefined;
    let name: string;
    try {
      name = decodeURIComponent(relative.split("/").at(-1) ?? "");
    } catch {
      return undefined;
    }
    const candidates = files.filter(
      (file) => file.kind === "output" && file.name === name,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) =>
        resolveFile(url) ? url : defaultUrlTransform(url)
      }
      components={{
        a: ({ href, children }) => {
          const file = resolveFile(href);
          return file ? (
            <button
              className="artifact-inline-link"
              onClick={() => onPreview(file)}
            >
              {children}
            </button>
          ) : (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        img: ({ src, alt }) => {
          const file = typeof src === "string" ? resolveFile(src) : undefined;
          const safe = file
            ? safeArtifactUrl(file.url)
            : typeof src === "string"
              ? safeArtifactUrl(src)
              : "";
          return safe ? (
            <img src={safe} alt={alt ?? "生成图片"} loading="lazy" />
          ) : (
            <span className="external-image-note">
              图片未自动加载{alt ? `：${alt}` : ""}（请从工作空间预览文件）
            </span>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
function CodeBlock({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block" ref={ref}>
      <button
        aria-label="复制代码"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              ref.current?.querySelector("code")?.textContent || "",
            );
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
        {copied ? "已复制" : "复制代码"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}
export function ToolTrace({ tools }: { tools: ToolEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!tools.length) return null;
  const done = tools.every((t) => t.status === "completed");
  return (
    <div className="tool-trace">
      <button className="trace-heading" onClick={() => setExpanded(!expanded)}>
        {done ? (
          <Check size={14} />
        ) : (
          <LoaderCircle size={14} className="spin" />
        )}
        <span>
          {done ? `已完成 ${tools.length} 个执行步骤` : "正在使用工具完成任务"}
        </span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className="trace-steps">
          {tools.map((t) => (
            <details key={t.id} className="trace-step">
              <summary>
                <Terminal size={14} />
                <span>{t.name}</span>
                {t.status === "running" ? (
                  <LoaderCircle size={12} className="spin" />
                ) : (
                  <Check size={12} />
                )}
              </summary>
              <div>
                <span className="trace-label">输入</span>
                <pre>
                  {typeof t.arguments === "string"
                    ? t.arguments
                    : JSON.stringify(t.arguments, null, 2)}
                </pre>
                {t.output !== undefined && (
                  <>
                    <span className="trace-label">结果</span>
                    <pre>
                      {typeof t.output === "string"
                        ? t.output
                        : JSON.stringify(t.output, null, 2)}
                    </pre>
                  </>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
export function ChatMessages({
  messages,
  user,
  liveText,
  tools,
  busy,
  approval,
  onApprove,
  onPreview,
  connectionLost,
  plan,
  files,
}: {
  messages: Message[];
  user: User | null;
  liveText: string;
  tools: ToolEvent[];
  busy: boolean;
  approval: Approval | null;
  onApprove: (approved: boolean) => Promise<void>;
  onPreview: (f: Artifact) => void;
  connectionLost: boolean;
  files: Artifact[];
  plan: { steps: string[]; current_step: number; completed: boolean } | null;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, liveText, tools.length, approval]);
  async function decide(approved: boolean) {
    setApproving(true);
    setApprovalError("");
    try {
      await onApprove(approved);
    } catch (e) {
      setApprovalError(e instanceof Error ? e.message : "授权未能提交");
    } finally {
      setApproving(false);
    }
  }
  return (
    <div className="message-list">
      {messages.map((m) => (
        <article key={m.id} className={`message ${m.role}`}>
          <div className={`message-avatar ${m.role}`}>
            {m.role === "user" ? (
              user?.name[0] || "你"
            ) : (
              <span className="mini-mark">F</span>
            )}
          </div>
          <div className="message-main">
            <div className="message-heading">
              <strong>{m.role === "user" ? "你" : "丰尚助手"}</strong>
              <span>
                {new Date(m.created_at).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            {m.attachments?.length ? (
              <div className="message-attachments">
                {m.attachments.map((f) => (
                  <FileTile key={f.id} file={f} onPreview={onPreview} />
                ))}
              </div>
            ) : null}
            <div className="message-content">
              {m.role === "user" ? (
                <p className="user-content">{m.content}</p>
              ) : (
                <Markdown
                  content={m.content}
                  files={files}
                  onPreview={onPreview}
                />
              )}
            </div>
            {m.role === "assistant" && m.run_id && (
              <ExecutionHistory runId={m.run_id} />
            )}
            {m.role === "assistant" && (
              <div className="message-actions">
                <button
                  className="icon-button"
                  aria-label="复制回复"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(m.content);
                      setCopied(m.id);
                      setTimeout(() => setCopied(null), 1500);
                    } catch {
                      /* browser clipboard unavailable */
                    }
                  }}
                >
                  {copied === m.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            )}
          </div>
        </article>
      ))}
      {busy && (
        <article className="message assistant live-message">
          <div className="message-avatar assistant">
            <span className="mini-mark">F</span>
          </div>
          <div className="message-main">
            <div className="message-heading">
              <strong>丰尚助手</strong>
              <span className="live-label">
                {approval ? "等待你的确认" : "正在处理"}
              </span>
            </div>
            {plan && (
              <div className="task-plan">
                <strong>任务计划</strong>
                <ol>
                  {plan.steps.map((step, index) => (
                    <li
                      className={
                        plan.completed || index < plan.current_step
                          ? "done"
                          : index === plan.current_step
                            ? "current"
                            : ""
                      }
                      key={index}
                    >
                      <span>
                        {plan.completed || index < plan.current_step ? (
                          <Check size={11} />
                        ) : (
                          index + 1
                        )}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <ToolTrace tools={tools} />
            {liveText ? (
              <div className="message-content">
                <Markdown
                  content={liveText}
                  files={files}
                  onPreview={onPreview}
                />
                <span className="stream-cursor" />
              </div>
            ) : (
              !approval && (
                <div className="thinking-indicator">
                  <i />
                  <i />
                  <i />
                  <span>
                    {connectionLost ? "正在重新连接…" : "正在推进你的任务…"}
                  </span>
                </div>
              )
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
                {approvalError && <p className="form-error">{approvalError}</p>}
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
      <div ref={bottom} />
    </div>
  );
}
