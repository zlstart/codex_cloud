import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
export function Modal({
  title,
  description,
  onClose,
  children,
  className = "",
  allowFullscreen = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  allowFullscreen?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const expanded = useRef(false);
  const nativeFullscreen = useRef(false);
  const expand = (next: boolean) => {
    expanded.current = next;
    setFullscreen(next);
  };
  const leaveFullscreen = () => {
    expand(false);
    if (document.fullscreenElement === ref.current)
      void document.exitFullscreen().catch(() => {});
  };
  const toggleFullscreen = async () => {
    if (expanded.current) return leaveFullscreen();
    expand(true);
    // Mobile browsers without this API still get a full-viewport preview.
    try {
      await ref.current?.requestFullscreen?.();
    } catch {
      /* viewport fallback */
    }
  };
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]',
        ) ?? [],
      );
    focusables()[0]?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (expanded.current) {
          e.preventDefault();
          leaveFullscreen();
          return;
        }
        closeRef.current();
      }
      if (e.key === "Tab") {
        const items = focusables();
        if (!items.length) {
          e.preventDefault();
          return;
        }
        if (e.shiftKey && document.activeElement === items[0]) {
          e.preventDefault();
          items.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
          e.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    const onFullscreenChange = () => {
      if (document.fullscreenElement === node) {
        nativeFullscreen.current = true;
        expand(true);
      } else if (nativeFullscreen.current) {
        nativeFullscreen.current = false;
        expand(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", listener);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement === node)
        void document.exitFullscreen().catch(() => {});
      document.body.style.overflow = prior;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${className}${fullscreen ? " modal-fullscreen" : ""}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <div className="modal-header-actions">
            {allowFullscreen && (
              <button
                type="button"
                className="icon-button"
                aria-label={fullscreen ? "退出全屏" : "全屏预览"}
                title={fullscreen ? "退出全屏（Esc）" : "全屏预览"}
                aria-pressed={fullscreen}
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="关闭弹窗"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
