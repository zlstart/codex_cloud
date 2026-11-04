import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { errorMessage, safeArtifactUrl } from "../lib/api";
import type { Artifact } from "../types";

export function ArtifactDownloadLink({
  file,
  className,
  iconOnly = false,
  onError,
}: {
  file: Artifact;
  className: string;
  iconOnly?: boolean;
  onError: (message: string) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const url = safeArtifactUrl(file.url);
  useEffect(() => {
    mounted.current = true;
    return () => {
      // A requested download continues if its preview closes or row disappears.
      mounted.current = false;
    };
  }, []);

  return (
    <a
      className={className}
      aria-label={iconOnly ? `下载 ${file.name}` : "下载文件"}
      aria-busy={downloading}
      aria-disabled={downloading || !url}
      href={url ? `${url}?download=true` : undefined}
      download={file.name}
      onClick={async (event) => {
        // Preserve native link actions such as opening a new tab or Save As.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        if (pending.current) return;
        if (!url) {
          onError("文件链接无效。");
          return;
        }
        pending.current = true;
        setDownloading(true);
        onError("");
        try {
          const response = await fetch(`${url}?download=true`, {
            credentials: "include",
          });
          if (!response.ok) {
            let message = "下载失败，请稍后重试。";
            try {
              const body = await response.json();
              if (typeof body.detail === "string") message = body.detail;
            } catch {
              /* Keep a useful fallback for non-JSON proxy errors. */
            }
            throw new Error(message);
          }
          const body = await response.blob();
          // Keep the exact file bytes, but never create an executable HTML blob
          // on the application's origin if a browser ignores `download`.
          const objectUrl = URL.createObjectURL(
            new Blob([body], { type: "application/octet-stream" }),
          );
          const anchor = document.createElement("a");
          anchor.href = objectUrl;
          anchor.download = file.name;
          document.body.append(anchor);
          try {
            anchor.click();
          } finally {
            anchor.remove();
            // Some browsers consume the URL asynchronously after the click.
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
          }
        } catch (cause) {
          if (mounted.current) onError(errorMessage(cause));
        } finally {
          pending.current = false;
          if (mounted.current) setDownloading(false);
        }
      }}
    >
      {downloading ? (
        <LoaderCircle size={16} className="spin" />
      ) : (
        <Download size={16} />
      )}
      {!iconOnly && (downloading ? "正在下载…" : "下载文件")}
    </a>
  );
}
