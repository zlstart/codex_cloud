import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import DOMPurify from "dompurify";
import { codeLanguage, highlightedCode } from "../lib/highlighting";
import "../styles/code.css";

export function CodeBlock({
  code,
  language,
  filename,
  className = "",
  maxHeight = 420,
}: {
  code: string;
  language?: string;
  filename?: string;
  className?: string;
  maxHeight?: number | string;
}) {
  const resolved = codeLanguage(language, filename);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const html = useMemo(() => {
    const highlighted = highlightedCode(code, resolved);
    return highlighted === null
      ? null
      : DOMPurify.sanitize(highlighted, {
          ALLOWED_TAGS: ["span"],
          ALLOWED_ATTR: ["class"],
        });
  }, [code, resolved]);
  return (
    <div className={`code-block ${className}`} data-language={resolved}>
      <div className="code-block-header">
        <span className="code-block-language">
          {resolved === "plaintext" ? "纯文本" : resolved}
        </span>
        {filename && (
          <span className="code-block-filename" title={filename}>
            {filename}
          </span>
        )}
        <button
          type="button"
          aria-label="复制代码"
          onClick={async () => {
            clearTimeout(timer.current);
            try {
              await navigator.clipboard.writeText(code);
              setCopyState("copied");
            } catch {
              setCopyState("failed");
            }
            timer.current = setTimeout(() => setCopyState("idle"), 1800);
          }}
        >
          {copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
          <span aria-live="polite">
            {copyState === "copied"
              ? "已复制"
              : copyState === "failed"
                ? "复制失败"
                : "复制"}
          </span>
        </button>
      </div>
      <pre
        style={{ maxHeight }}
        tabIndex={0}
        aria-label={`${filename ?? resolved} 代码`}
      >
        {html === null ? (
          <code>{code}</code>
        ) : (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
      {code.length > 100_000 && resolved !== "plaintext" && (
        <div className="code-block-note">内容较长，以纯文本显示。</div>
      )}
    </div>
  );
}
