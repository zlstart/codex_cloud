import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact } from "../types";
import { safeArtifactUrl } from "../lib/api";
import { resolveArtifactLink } from "../lib/artifactLinks";
import { CodeBlock } from "./CodeBlock";
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
    return resolveArtifactLink(link, files);
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
        pre: ({ node, children }) => {
          const code = node?.children.find(
            (child) => child.type === "element" && child.tagName === "code",
          );
          if (!code || code.type !== "element") return <pre>{children}</pre>;
          const classes = code.properties.className;
          const language = Array.isArray(classes)
            ? classes
                .find((name) => String(name).startsWith("language-"))
                ?.toString()
                .slice(9)
            : undefined;
          const source = code.children
            .map((child) => (child.type === "text" ? child.value : ""))
            .join("");
          return <CodeBlock code={source} language={language} />;
        },
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
