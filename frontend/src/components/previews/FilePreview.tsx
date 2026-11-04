import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Code2,
  Download,
  Eye,
  File,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { Artifact } from "../../types";
import { api, errorMessage, formatSize, safeArtifactUrl } from "../../lib/api";
import { Modal } from "../Modal";
import { Markdown } from "../Markdown";
import { CodeBlock } from "../CodeBlock";
import { SpreadsheetPreview } from "./SpreadsheetPreview";
import { DocumentPreview } from "./DocumentPreview";
import { PresentationPreview } from "./PresentationPreview";
import { isolatedHtmlDocument } from "./htmlPreview";
import {
  boundedBlob,
  decodePreviewText,
  kindLabel,
  parseDelimited,
  previewKind,
  previewLanguage,
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

function HtmlFrame({ html, name }: { html: string; name: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    // Loading srcdoc during DOM insertion can run app initialization before
    // the iframe has a viewport. Wait for layout so responsive canvases measure
    // their real size on the first execution, without rewriting app scripts.
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
      observer.disconnect();
      node.srcdoc = html;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [html]);
  return (
    <iframe
      ref={frame}
      title={name}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
    />
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
  const parsed =
    kind === "spreadsheet" || kind === "document" || kind === "presentation";
  const [content, setContent] = useState("");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = useState("");
  const [structured, setStructured] = useState<ParsedPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadedVersion, setLoadedVersion] = useState(0);
  const requestLoad = useRef<(nextFile: Artifact) => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    let pendingFile: Artifact | null = null;
    let inFlight = false;
    let hasPreview = false;
    setLoading(true);
    setError("");
    setContent("");
    setBlob(null);
    setBlobUrl("");
    setStructured(null);
    async function load() {
      if (inFlight) return;
      inFlight = true;
      while (pendingFile && !controller.signal.aborted) {
        const nextFile = pendingFile;
        pendingFile = null;
        if (!hasPreview) setLoading(true);
        setError("");
        try {
          if (kind === "unsupported") continue;
          const url = safeArtifactUrl(nextFile.url);
          if (!url) throw new Error("文件链接无效。");
          if (nextFile.size > (textual ? MAX_TEXT_BYTES : MAX_BINARY_BYTES))
            throw new Error("文件较大，请下载后查看完整内容。");
          if (parsed) {
            const preview = await api<ParsedPreview>(
              `/files/${encodeURIComponent(nextFile.id)}/preview`,
              { signal: controller.signal },
            );
            if (preview.kind !== kind)
              throw new Error("服务器返回的预览格式不正确。");
            if (!controller.signal.aborted) {
              setStructured(preview);
              setLoadedVersion((version) => version + 1);
              hasPreview = true;
            }
            continue;
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
          if (controller.signal.aborted) break;
          if (textual) {
            const text = await decodePreviewText(data);
            if (!controller.signal.aborted) setContent(text);
          } else {
            setBlob(data);
            if (kind !== "pdf") {
              if (objectUrl) URL.revokeObjectURL(objectUrl);
              objectUrl = URL.createObjectURL(data);
              setBlobUrl(objectUrl);
            }
          }
          if (!controller.signal.aborted)
            setLoadedVersion((version) => version + 1);
          hasPreview = true;
        } catch (cause) {
          if (!controller.signal.aborted) setError(errorMessage(cause));
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      }
      inFlight = false;
    }
    // Let the current read finish even when the model keeps revising this file.
    // Coalesce those revisions into one follow-up read, keeping the last preview.
    requestLoad.current = (nextFile) => {
      pendingFile = nextFile;
      void load();
    };
    return () => {
      requestLoad.current = () => {};
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, file.url, kind, parsed, textual]);
  useEffect(() => {
    requestLoad.current(file);
  }, [
    file.id,
    file.url,
    file.size,
    file.created_at,
    kind,
    parsed,
    textual,
    retry,
  ]);
  const renderedContent = content.slice(0, MAX_RENDER_CHARS);
  const csvSheet = useMemo(
    () =>
      kind === "csv"
        ? parseDelimited(
            content,
            /\.tsv$/i.test(file.name) ||
              file.mime_type.split(";")[0].trim().toLowerCase() ===
                "text/tab-separated-values"
              ? "\t"
              : ",",
          )
        : null,
    [kind, content, file.name, file.mime_type],
  );
  // Render complete, byte-bounded HTML. Slicing markup can break embedded
  // images or executable apps; only the source-code view is character-limited.
  const secureHtml = useMemo(
    () => (kind === "html" && content ? isolatedHtmlDocument(content) : ""),
    [kind, content],
  );
  const sourceAvailable =
    kind === "markdown" || kind === "html" || kind === "csv";
  const downloadUrl = safeArtifactUrl(file.url);
  const displayedText = useMemo(() => {
    const isJson =
      /\.(json|ipynb)$/i.test(file.name) || previewLanguage(file) === "json";
    const isJsonLines =
      /\.(jsonl|ndjson)$/i.test(file.name) ||
      file.mime_type.startsWith("application/x-ndjson");
    if (!isJson || isJsonLines || content.length > MAX_RENDER_CHARS)
      return renderedContent;
    try {
      const formatted = JSON.stringify(JSON.parse(content), null, 2);
      return formatted.length <= MAX_RENDER_CHARS ? formatted : renderedContent;
    } catch {
      return renderedContent;
    }
  }, [content, renderedContent, file]);
  return (
    <Modal
      title={file.name}
      description={`${formatSize(file.size)} · ${file.kind === "output" ? "助手生成" : "上传资料"}`}
      onClose={onClose}
      className="preview-modal file-preview-modal"
      allowFullscreen
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
      {kind === "html" && !source && (
        <div className="preview-notice">
          如需使用网页内的导出功能，请先下载 HTML 文件，再用浏览器打开。
        </div>
      )}
      {content.length > MAX_RENDER_CHARS &&
        (source || (kind !== "csv" && kind !== "html")) && (
          <div className="preview-notice" role="status">
            预览显示前 {MAX_RENDER_CHARS.toLocaleString()}{" "}
            个字符，下载文件可查看完整内容。
          </div>
        )}
      <div
        key={loadedVersion}
        className={`preview-body preview-kind-${kind}${kind === "image" ? " image-preview" : ""}`}
        aria-busy={loading}
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
          <CodeBlock
            code={renderedContent}
            filename={file.name}
            language={
              kind === "markdown"
                ? "markdown"
                : kind === "html"
                  ? "html"
                  : undefined
            }
            className="file-code-preview"
            maxHeight="none"
          />
        ) : kind === "spreadsheet" && structured?.kind === "spreadsheet" ? (
          <SpreadsheetPreview
            sheets={structured.sheets}
            truncated={structured.truncated}
            showFormatNotice
          />
        ) : kind === "csv" && csvSheet ? (
          <SpreadsheetPreview sheets={[csvSheet]} />
        ) : kind === "document" && structured?.kind === "document" ? (
          <DocumentPreview document={structured} />
        ) : kind === "presentation" && structured?.kind === "presentation" ? (
          <PresentationPreview presentation={structured} />
        ) : kind === "markdown" ? (
          <article className="markdown-preview message-content">
            <Markdown
              content={renderedContent}
              files={noFiles}
              onPreview={noPreview}
            />
          </article>
        ) : kind === "html" ? (
          <HtmlFrame html={secureHtml} name={file.name} />
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
          <CodeBlock
            code={displayedText}
            filename={file.name}
            language={previewLanguage(file)}
            className="file-code-preview"
            maxHeight="none"
          />
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
            ? "隔离预览 · 已禁用外部连接"
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
