import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact } from "../types";
import { safeArtifactUrl } from "../lib/api";
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
