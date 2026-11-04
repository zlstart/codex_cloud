import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowUpRight,
  Download,
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  LoaderCircle,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  api,
  errorMessage,
  formatDate,
  formatSize,
  safeArtifactUrl,
} from "../lib/api";
import type { Artifact, User } from "../types";
import { FilePreview } from "./previews/FilePreview";
import { previewKind } from "./previews/previewData";
export function FileIcon({
  file,
  size = 20,
}: {
  file: Artifact;
  size?: number;
}) {
  const kind = previewKind(file);
  if (kind === "image") return <FileImage size={size} />;
  if (kind === "csv" || kind === "spreadsheet")
    return <FileSpreadsheet size={size} />;
  if (
    kind === "html" ||
    (kind === "text" && !/\.(txt|text|log)$/i.test(file.name))
  )
    return <FileCode2 size={size} />;
  return <FileText size={size} />;
}
export function FileTile({
  file,
  onPreview,
  onDelete,
}: {
  file: Artifact;
  onPreview: (f: Artifact) => void;
  onDelete?: (f: Artifact) => void;
}) {
  return (
    <div className="file-tile">
      <button
        className={`file-type ${file.kind}`}
        onClick={() => onPreview(file)}
        aria-label={`预览 ${file.name}`}
      >
        <FileIcon file={file} />
      </button>
      <button className="file-tile-info" onClick={() => onPreview(file)}>
        <strong title={file.name}>{file.name}</strong>
        <small>
          {formatSize(file.size)} ·{" "}
          {file.kind === "output" ? "助手生成" : "已上传"}
        </small>
      </button>
      {onDelete && (
        <button
          className="icon-button file-remove"
          aria-label={`删除 ${file.name}`}
          onClick={() => onDelete(file)}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}
export function Workspace({
  files,
  onClose,
  onUpload,
  onPreview,
  onDelete,
  uploading,
}: {
  files: Artifact[];
  onClose: () => void;
  onUpload: (files: File[]) => void;
  onPreview: (f: Artifact) => void;
  onDelete: (f: Artifact) => void;
  uploading: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const tabId = useId();
  const [drag, setDrag] = useState(false);
  const [filter, setFilter] = useState<"all" | "upload" | "output">("all");
  const shown = files.filter((f) => filter === "all" || f.kind === filter);
  const tabs = [
    { key: "all", label: "全部文件", count: files.length },
    {
      key: "upload",
      label: "已上传",
      count: files.filter((f) => f.kind === "upload").length,
    },
    {
      key: "output",
      label: "生成成果",
      count: files.filter((f) => f.kind === "output").length,
    },
  ] as const;
  return (
    <aside className="workspace-panel">
      <header>
        <div>
          <FolderOpen size={18} />
          <h2>工作空间</h2>
          {files.length > 0 && <span className="count">{files.length}</span>}
        </div>
        <button
          className="icon-button"
          aria-label="关闭工作空间"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <div className="workspace-scroll">
        <div className="file-tabs" role="tablist" aria-label="工作空间文件来源">
          {tabs.map((tab, index) => (
            <button
              key={tab.key}
              id={`${tabId}-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={filter === tab.key}
              aria-controls={`${tabId}-panel`}
              aria-label={`${tab.label}（${tab.count}）`}
              tabIndex={filter === tab.key ? 0 : -1}
              className={filter === tab.key ? "active" : ""}
              onClick={() => setFilter(tab.key)}
              onKeyDown={(event) => {
                let next = index;
                if (event.key === "ArrowRight")
                  next = (index + 1) % tabs.length;
                else if (event.key === "ArrowLeft")
                  next = (index - 1 + tabs.length) % tabs.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = tabs.length - 1;
                else return;
                event.preventDefault();
                setFilter(tabs[next].key);
                document.getElementById(`${tabId}-${tabs[next].key}`)?.focus();
              }}
            >
              {tab.label}
              <span aria-hidden="true">{tab.count}</span>
            </button>
          ))}
        </div>
        <div
          id={`${tabId}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-${filter}`}
          tabIndex={0}
        >
          {files.length > 0 || filter !== "all" ? (
            <div className="workspace-files">
              {shown.map((f) => (
                <FileTile
                  key={f.id}
                  file={f}
                  onPreview={onPreview}
                  onDelete={onDelete}
                />
              ))}
              {!shown.length && (
                <p className="small-empty" role="status">
                  {filter === "upload"
                    ? "还没有上传文件。上传的资料会出现在这里。"
                    : "助手生成的成果会出现在这里。"}
                </p>
              )}
            </div>
          ) : (
            <div className="workspace-empty">
              <div className="folder-art" aria-hidden="true">
                <div className="folder-paper">
                  <i />
                  <i />
                  <i />
                </div>
                <div className="folder-back" />
                <div className="folder-front">
                  <div>
                    <Upload size={27} strokeWidth={1.5} />
                  </div>
                </div>
              </div>
              <h3>让文件成为思考的起点</h3>
              <p>
                上传资料，或在对话中
                <br />
                生成新的成果。
              </p>
            </div>
          )}
        </div>
        <button
          className={`upload-drop ${drag ? "drag-over" : ""} ${files.length ? "upload-drop-small" : ""}`}
          onClick={() => input.current?.click()}
          disabled={uploading}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!uploading && e.dataTransfer.files.length)
              onUpload(Array.from(e.dataTransfer.files));
          }}
        >
          {uploading ? (
            <LoaderCircle size={23} className="spin" />
          ) : (
            <Upload size={23} strokeWidth={1.5} />
          )}
          <strong>{uploading ? "正在上传…" : "拖拽文件到这里"}</strong>
          <span>或点击选择文件</span>
          <small>文档、表格、图片、代码</small>
        </button>
        <input
          type="file"
          multiple
          hidden
          ref={input}
          onChange={(e) => {
            if (e.target.files) onUpload(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
      <footer>
        <ShieldCheck size={15} />
        <span>会话独立 · 文件私有</span>
        <span className="status-dot" />
      </footer>
    </aside>
  );
}
export function FilesView({
  user,
  removedArtifactIds,
  onAuth,
  onPreview,
  onOpenSession,
}: {
  user: User | null;
  removedArtifactIds?: ReadonlySet<string>;
  onAuth: () => void;
  onPreview: (f: Artifact) => void;
  onOpenSession: (id: string) => void;
}) {
  const [loadedFiles, setLoadedFiles] = useState<{
    userId: string;
    files: Artifact[];
  } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "upload" | "output">("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const files =
    loadedFiles?.userId === user?.id ? (loadedFiles?.files ?? []) : [];
  useEffect(() => {
    const controller = new AbortController();
    setLoadedFiles(null);
    setError("");
    if (!user) return;
    setLoading(true);
    api<Artifact[]>("/files", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted)
          setLoadedFiles({ userId: user.id, files: result });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [user]);
  const shown = files.filter(
    (f) =>
      !removedArtifactIds?.has(f.id) &&
      (filter === "all" || f.kind === filter) &&
      f.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="page-view files-view">
      <div className="page-heading">
        <div>
          <span className="page-overline">YOUR WORK, ORGANIZED</span>
          <h1>每一份成果，都在这里。</h1>
          <p>汇集你的会话资料与助手生成的文件，随时查看与继续探索。</p>
        </div>
        <div className="page-heading-icon">
          <FolderOpen size={31} strokeWidth={1.2} />
        </div>
      </div>
      <div className="list-toolbar">
        <div className="segmented" role="group" aria-label="文件来源">
          {(
            [
              { key: "all", label: "全部文件" },
              { key: "upload", label: "已上传" },
              { key: "output", label: "生成成果" },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              className={filter === t.key ? "active" : ""}
              aria-pressed={filter === t.key}
              onClick={() => setFilter(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件…"
            aria-label="搜索文件"
          />
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="empty-state">
          <LoaderCircle className="spin" />
          <p>正在整理你的文件…</p>
        </div>
      ) : !user ? (
        <div className="empty-state">
          <div className="empty-symbol">
            <FolderOpen size={36} strokeWidth={1.2} />
          </div>
          <h3>你的专属文件空间</h3>
          <p>登录后，查看上传资料和助手生成的成果。</p>
          <button className="button primary" onClick={onAuth}>
            登录工作台
            <ArrowUpRight size={16} />
          </button>
        </div>
      ) : shown.length ? (
        <div className="file-table">
          <div className="file-table-head">
            <span>文件名称</span>
            <span>来源</span>
            <span>大小</span>
            <span>创建时间</span>
            <span />
          </div>
          {shown.map((f) => (
            <div className="file-table-row" key={f.id}>
              <button className="table-file-name" onClick={() => onPreview(f)}>
                <span className={`file-type ${f.kind}`}>
                  <FileIcon file={f} />
                </span>
                <span>{f.name}</span>
              </button>
              <span className={`file-kind ${f.kind}`}>
                {f.kind === "output" ? "助手生成" : "已上传"}
              </span>
              <span className="muted">{formatSize(f.size)}</span>
              <span className="muted">{formatDate(f.created_at)}</span>
              <div className="table-actions">
                <button
                  className="icon-button"
                  aria-label={`前往 ${f.name} 所在对话`}
                  title="前往对话"
                  onClick={() => onOpenSession(f.session_id)}
                >
                  <ArrowUpRight size={16} />
                </button>
                <a
                  className="icon-button"
                  aria-label={`下载 ${f.name}`}
                  href={`${safeArtifactUrl(f.url)}?download=true`}
                  download
                >
                  <Download size={16} />
                </a>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-symbol">
            <File size={34} strokeWidth={1.2} />
          </div>
          <h3>{query ? "没有找到这个文件" : "下一份成果，从一次对话开始"}</h3>
          <p>
            {query
              ? "换一个关键词试试看。"
              : "在对话中上传资料，让助手与你一起分析、创作。"}
          </p>
        </div>
      )}
    </section>
  );
}
export function ArtifactPreview({
  file,
  onClose,
}: {
  file: Artifact;
  onClose: () => void;
}) {
  return <FilePreview key={file.id} file={file} onClose={onClose} />;
}
