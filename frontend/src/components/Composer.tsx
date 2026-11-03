import { useRef, useState } from "react";
import {
  Paperclip,
  ArrowUp,
  Square,
  SlidersHorizontal,
  ChevronDown,
  X,
  FileText,
  LoaderCircle,
  Terminal,
  BookOpen,
  Plug,
} from "lucide-react";
import type { Artifact } from "../types";
export function Composer({
  value,
  onChange,
  onSend,
  onUpload,
  attachments,
  onRemove,
  busy,
  stopping = false,
  uploading,
  onCapabilities,
  compact = false,
}: {
  value: string;
  onChange: (s: string) => void;
  onSend: () => void;
  onUpload: (files: File[]) => void;
  attachments: Artifact[];
  onRemove: (id: string) => void;
  busy: boolean;
  stopping?: boolean;
  uploading: boolean;
  onCapabilities: () => void;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [tools, setTools] = useState(false);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`composer ${compact ? "composer-compact" : ""} ${dragging ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!busy) onUpload(Array.from(e.dataTransfer.files));
      }}
    >
      {attachments.length > 0 && (
        <div className="attachment-chips">
          {attachments.map((f) => (
            <div className="attachment-chip" key={f.id}>
              <FileText size={15} />
              <span>{f.name}</span>
              <button
                aria-label={`移除附件 ${f.name}`}
                onClick={() => onRemove(f.id)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={area}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          e.currentTarget.style.height = "auto";
          e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 190)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!uploading && (busy || value.trim())) onSend();
          }
        }}
        placeholder={compact ? "继续你的想法…" : "有什么想一起完成的？"}
        aria-label="发送给丰尚助手的消息"
        rows={compact ? 2 : 3}
        maxLength={50000}
      />
      <div className="composer-bottom">
        <div className="composer-controls">
          <button
            className="icon-button attach-button"
            aria-label="上传文件"
            onClick={() => input.current?.click()}
            disabled={busy || uploading}
          >
            {uploading ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <Paperclip size={19} />
            )}
          </button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) onUpload(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          <div className="tool-picker">
            <button
              className={`button subtle ${tools ? "is-open" : ""}`}
              onClick={() => setTools(!tools)}
              aria-expanded={tools}
            >
              <SlidersHorizontal size={16} />
              工具
              <ChevronDown size={13} />
            </button>
            {tools && (
              <>
                <div className="menu-dismiss" onClick={() => setTools(false)} />
                <div className="tool-popover">
                  <strong>助手的工作方式</strong>
                  <div>
                    <Terminal size={17} />
                    <span>
                      代码与文件执行<small>在会话独立环境中运行</small>
                    </span>
                  </div>
                  <div>
                    <BookOpen size={17} />
                    <span>
                      Skills<small>按任务自动加载专业方法</small>
                    </span>
                  </div>
                  <div>
                    <Plug size={17} />
                    <span>
                      MCP 工具<small>调用前由你确认授权</small>
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      setTools(false);
                      onCapabilities();
                    }}
                  >
                    管理能力与连接 <span>↗</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="send-controls">
          <span className="enter-hint" role={stopping ? "status" : undefined}>
            {stopping ? "正在停止并清理任务…" : "Enter 发送"}
          </span>
          <button
            className={`send-button ${busy ? "stop-button" : ""}`}
            aria-label={stopping ? "正在停止" : busy ? "停止生成" : "发送消息"}
            onClick={onSend}
            disabled={stopping || uploading || (!busy && !value.trim())}
          >
            {stopping ? (
              <LoaderCircle className="spin" size={17} />
            ) : busy ? (
              <Square size={16} fill="currentColor" />
            ) : (
              <ArrowUp size={21} strokeWidth={2.3} />
            )}
          </button>
        </div>
      </div>
      {dragging && (
        <div className="drop-overlay">
          <Paperclip size={23} />
          松开以上传文件
        </div>
      )}
    </div>
  );
}
