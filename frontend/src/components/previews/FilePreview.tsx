import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Code2,
  Download,
  Eye,
  File,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import DOMPurify from "dompurify";
import type { Artifact } from "../../types";
import { api, errorMessage, formatSize, safeArtifactUrl } from "../../lib/api";
import { Modal } from "../Modal";
import { Markdown } from "../Markdown";
import { SpreadsheetPreview } from "./SpreadsheetPreview";
import {
  boundedBlob,
  kindLabel,
  parseDelimited,
  previewKind,
} from "./previewData";
import type { ParsedPreview } from "./previewData";
import "../../styles/previews.css";

const PdfPreview = lazy(() => import("./PdfPreview"));
const noPreview = () => {};
const noFiles: Artifact[] = [];
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 25 * 1024 * 1024;
const MAX_RENDER_CHARS = 250_000;

function Loading() {
  return (
    <div className="preview-empty" role="status">
      <LoaderCircle className="spin" size={25} />
      <p>正在打开文件…</p>
    </div>
  );
}

export function FilePreview({
  file,
  onClose,
}: {
  file: Artifact;
  onClose: () => void;
}) {
  const kind = previewKind(file);
  const textual = ["text", "markdown", "html", "csv"].includes(kind);
  const parsed = kind === "spreadsheet" || kind === "document";
  const [content, setContent] = useState("");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = useState("");
  const [structured, setStructured] = useState<ParsedPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setLoading(true);
    setError("");
    setContent("");
    setBlob(null);
    setBlobUrl("");
    setStructured(null);
    async function load() {
      try {
        if (kind === "unsupported") return;
        const url = safeArtifactUrl(file.url);
        if (!url) throw new Error("文件链接无效。");
        if (file.size > (textual ? MAX_TEXT_BYTES : MAX_BINARY_BYTES))
          throw new Error("文件较大，请下载后查看完整内容。");
        if (parsed) {
          const preview = await api<ParsedPreview>(
            `/files/${encodeURIComponent(file.id)}/preview`,
            { signal: controller.signal },
          );
          if (preview.kind !== kind)
            throw new Error("服务器返回的预览格式不正确。");
          if (!controller.signal.aborted) setStructured(preview);
          return;
        }
        const response = await fetch(url, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error("无法读取此文件，可能已被删除或无权访问。");
        const data = await boundedBlob(
          response,
          textual ? MAX_TEXT_BYTES : MAX_BINARY_BYTES,
        );
        if (controller.signal.aborted) return;
        if (textual) {
          const text = await data.text();
          if (!controller.signal.aborted)
            setContent(text.replace(/^\uFEFF/, ""));
        } else {
          setBlob(data);
          if (kind !== "pdf") {
            objectUrl = URL.createObjectURL(data);
            setBlobUrl(objectUrl);
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, file.url, file.size, kind, parsed, textual, retry]);
  const renderedContent = content.slice(0, MAX_RENDER_CHARS);
  const csvSheet = useMemo(
    () =>
      kind === "csv"
        ? parseDelimited(content, /\.tsv$/i.test(file.name) ? "\t" : ",")
        : null,
    [kind, content, file.name],
  );
  const secureHtml = useMemo(() => {
    if (kind !== "html" || !content) return "";
    const clean = DOMPurify.sanitize(renderedContent, {
      FORBID_TAGS: [
        "meta",
        "base",
        "form",
        "iframe",
        "object",
        "embed",
        "link",
        "input",
        "button",
        "textarea",
        "select",
      ],
      FORBID_ATTR: [
        "href",
        "xlink:href",
        "srcset",
        "action",
        "formaction",
        "target",
        "ping",
      ],
    });
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none';"><meta name="referrer" content="no-referrer"></head><body>${clean}</body></html>`;
  }, [kind, content, renderedContent]);
  const sourceAvailable =
    kind === "markdown" || kind === "html" || kind === "csv";
  const downloadUrl = safeArtifactUrl(file.url);
  const displayedText = useMemo(() => {
    if (!/\.json$/i.test(file.name) || content.length > MAX_RENDER_CHARS)
      return renderedContent;
    try {
      const formatted = JSON.stringify(JSON.parse(content), null, 2);
      return formatted.length <= MAX_RENDER_CHARS ? formatted : renderedContent;
    } catch {
      return renderedContent;
    }
  }, [content, renderedContent, file.name]);
  return (
    <Modal
      title={file.name}
      description={`${formatSize(file.size)} · ${file.kind === "output" ? "助手生成" : "上传资料"}`}
      onClose={onClose}
      className="preview-modal file-preview-modal"
    >
      <div className="file-preview-toolbar">
        <span className="preview-format">
          <File size={14} />
          {kindLabel[kind]}
        </span>
        {sourceAvailable && !loading && !error && (
          <div className="preview-mode" aria-label="预览模式">
            <button
              type="button"
              aria-pressed={!source}
              onClick={() => setSource(false)}
            >
              <Eye size={14} />
              预览
            </button>
            <button
              type="button"
              aria-pressed={source}
              onClick={() => setSource(true)}
            >
              <Code2 size={14} />
              源文件
            </button>
          </div>
        )}
      </div>
      {content.length > MAX_RENDER_CHARS && (source || kind !== "csv") && (
        <div className="preview-notice" role="status">
          预览显示前 {MAX_RENDER_CHARS.toLocaleString()}{" "}
          个字符，下载文件可查看完整内容。
        </div>
      )}
      <div
        className={`preview-body preview-kind-${kind}${kind === "image" ? " image-preview" : ""}`}
      >
        {loading ? (
          <Loading />
        ) : error ? (
          <div className="preview-empty" role="alert">
            <File size={32} />
            <h3>暂时无法预览</h3>
            <p>{error}</p>
            <button
              className="button secondary"
              onClick={() => setRetry(retry + 1)}
            >
              <RefreshCw size={14} />
              重新加载
            </button>
          </div>
        ) : source ? (
          <pre className="text-preview" tabIndex={0}>
            {renderedContent}
          </pre>
        ) : kind === "spreadsheet" && structured?.kind === "spreadsheet" ? (
          <SpreadsheetPreview
            sheets={structured.sheets}
            truncated={structured.truncated}
          />
        ) : kind === "csv" && csvSheet ? (
          <SpreadsheetPreview sheets={[csvSheet]} />
        ) : kind === "document" && structured?.kind === "document" ? (
          <div className="document-preview">
            <div className="document-page">
              <div className="document-preview-label">文档内容</div>
              {structured.paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
              {!structured.paragraphs.length && <p>文档没有可提取的正文。</p>}
            </div>
            <div className="preview-notice">
              文本预览，原始排版、图片与图表请下载查看。
              {structured.truncated && "内容已截取。"}
            </div>
          </div>
        ) : kind === "markdown" ? (
          <article className="markdown-preview message-content">
            <Markdown
              content={renderedContent}
              files={noFiles}
              onPreview={noPreview}
            />
          </article>
        ) : kind === "html" ? (
          <iframe
            srcDoc={secureHtml}
            title={file.name}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        ) : kind === "pdf" && blob ? (
          <Suspense fallback={<Loading />}>
            <PdfPreview blob={blob} name={file.name} />
          </Suspense>
        ) : kind === "image" ? (
          <img
            src={blobUrl}
            alt={file.name}
            onError={() =>
              setError("图片格式不受支持或文件已损坏，请下载后查看。")
            }
          />
        ) : kind === "audio" ? (
          <div className="media-preview">
            <div className="media-caption">
              <span>音频文件</span>
              <strong>{file.name}</strong>
            </div>
            <audio
              controls
              preload="metadata"
              src={blobUrl}
              aria-label={file.name}
              onError={() =>
                setError("浏览器无法播放此音频，请下载后使用播放器打开。")
              }
            />
          </div>
        ) : kind === "video" ? (
          <div className="media-preview">
            <video
              controls
              preload="metadata"
              playsInline
              src={blobUrl}
              aria-label={file.name}
              onError={() =>
                setError("浏览器无法播放此视频，请下载后使用播放器打开。")
              }
            />
          </div>
        ) : kind === "text" ? (
          <pre className="text-preview" tabIndex={0}>
            {displayedText}
          </pre>
        ) : (
          <div className="preview-empty">
            <File size={36} />
            <h3>文件已就绪</h3>
            <p>此格式可下载后使用对应应用打开。</p>
          </div>
        )}
      </div>
      <footer className="preview-footer">
        <span>
          <ShieldCheck size={13} />
          {kind === "html"
            ? "安全预览 · 已禁用脚本与外部连接"
            : "文件仅对所属账号可见"}
        </span>
        {downloadUrl && (
          <a
            className="button primary"
            href={`${downloadUrl}?download=true`}
            download
          >
            <Download size={16} />
            下载文件
          </a>
        )}
      </footer>
    </Modal>
  );
}
