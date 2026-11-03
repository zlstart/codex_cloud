import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Minus,
  Plus,
} from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { errorMessage } from "../../lib/api";

export default function PdfPreview({
  blob,
  name,
}: {
  blob: Blob;
  name: string;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [width, setWidth] = useState(720);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | undefined;
    async function load() {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const task = pdfjs.getDocument({
          data: await blob.arrayBuffer(),
          useSystemFonts: true,
          disableFontFace: true,
          maxImageSize: 20_000_000,
          canvasMaxAreaInBytes: 20_000_000,
        });
        destroy = () => task.destroy();
        if (cancelled) {
          await destroy();
          return;
        }
        const loaded = await task.promise;
        if (!cancelled) setDocument(loaded);
      } catch (cause) {
        if (!cancelled) {
          setError(`无法打开 PDF：${errorMessage(cause)}`);
          setBusy(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      void destroy?.().catch(() => {});
    };
  }, [blob]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(160, entry.contentRect.width - 40)),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    setBusy(true);
    setError("");
    async function draw() {
      try {
        const pdfPage = await document!.getPage(page);
        if (cancelled || !canvas.current) return;
        const unit = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(width / unit.width, 1.5) * zoom;
        const viewport = pdfPage.getViewport({ scale });
        const pixelRatio = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(5_000_000 / (viewport.width * viewport.height)),
        );
        const rendered = pdfPage.getViewport({ scale: scale * pixelRatio });
        const node = canvas.current;
        node.width = Math.ceil(rendered.width);
        node.height = Math.ceil(rendered.height);
        node.style.width = `${viewport.width}px`;
        node.style.height = `${viewport.height}px`;
        render = pdfPage.render({ canvas: node, viewport: rendered });
        await render.promise;
      } catch (cause) {
        if (!cancelled) setError(`无法渲染此页：${errorMessage(cause)}`);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void draw();
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [document, page, zoom, width]);
  return (
    <div className="pdf-preview">
      <div className="pdf-toolbar">
        <div>
          <button
            className="icon-button"
            aria-label="上一页 PDF"
            disabled={!document || page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span aria-live="polite">
            {document ? `${page} / ${document.numPages} 页` : "载入文档"}
          </span>
          <button
            className="icon-button"
            aria-label="下一页 PDF"
            disabled={!document || page >= document.numPages}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div>
          <button
            className="icon-button"
            aria-label="缩小 PDF"
            disabled={zoom <= 0.5}
            onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
          >
            <Minus size={15} />
          </button>
          <button
            className="pdf-zoom"
            onClick={() => setZoom(1)}
            aria-label="适合页面宽度"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="icon-button"
            aria-label="放大 PDF"
            disabled={zoom >= 2}
            onClick={() => setZoom(Math.min(2, zoom + 0.25))}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      <div
        className="pdf-canvas-scroll"
        ref={container}
        tabIndex={0}
        aria-label="PDF 页面预览"
      >
        {busy && (
          <div className="pdf-busy" role="status">
            <LoaderCircle className="spin" size={18} />
            <span>正在渲染…</span>
          </div>
        )}
        {error && (
          <div className="preview-notice" role="alert">
            {error}。可下载后使用 PDF 阅读器打开。
          </div>
        )}
        <canvas ref={canvas} role="img" aria-label={`${name}，第 ${page} 页`} />
      </div>
    </div>
  );
}
