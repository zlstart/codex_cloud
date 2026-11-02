import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Code2,
  FileText,
  LoaderCircle,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { Extension, User } from "../types";
import { api } from "../lib/api";
import { Modal } from "./Modal";
import "../styles/admin.css";

interface Props {
  user: User | null;
  onAuth: () => void;
}
interface ExtensionData {
  skills: Extension[];
  mcp_servers: Extension[];
}
type Kind = "skill" | "mcp";

export function CapabilitiesView({ user, onAuth }: Props) {
  const [data, setData] = useState<ExtensionData>({
    skills: [],
    mcp_servers: [],
  });
  const [tab, setTab] = useState<Kind>("skill");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<
    (Extension & { content?: string }) | null
  >(null);
  const [deleting, setDeleting] = useState<Extension | null>(null);
  const isAdmin = user?.role === "admin";

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setData(await api<ExtensionData>("/extensions"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "能力列表加载失败。");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!user) {
      setData({ skills: [], mcp_servers: [] });
      return;
    }
    let live = true;
    setLoading(true);
    setError("");
    api<ExtensionData>("/extensions")
      .then((next) => {
        if (live) setData(next);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [user]);

  async function toggle(item: Extension) {
    setBusy(item.id);
    setError("");
    try {
      await api(`/extensions/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !item.enabled }),
      });
      setData((previous) => ({
        skills: previous.skills.map((x) =>
          x.id === item.id ? { ...x, enabled: !item.enabled } : x,
        ),
        mcp_servers: previous.mcp_servers.map((x) =>
          x.id === item.id ? { ...x, enabled: !item.enabled } : x,
        ),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "状态更新失败。");
    } finally {
      setBusy(null);
    }
  }

  async function view(item: Extension) {
    if (item.type !== "skill") {
      setViewing(item);
      return;
    }
    setBusy(item.id);
    setError("");
    try {
      setViewing(
        await api<Extension & { content: string }>(
          `/extensions/skills/${item.id}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "技能内容加载失败。");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(deleting.id);
    setError("");
    try {
      await api(`/extensions/${deleting.id}`, { method: "DELETE" });
      setData((previous) => ({
        skills: previous.skills.filter((x) => x.id !== deleting.id),
        mcp_servers: previous.mcp_servers.filter((x) => x.id !== deleting.id),
      }));
      setDeleting(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败。");
    } finally {
      setBusy(null);
    }
  }

  const items = (tab === "skill" ? data.skills : data.mcp_servers).filter((x) =>
    `${x.name} ${x.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="capabilities-view">
      <header className="capabilities-header">
        <div>
          <div className="capabilities-emblem">
            <Sparkles size={24} strokeWidth={1.5} />
          </div>
          <h1>让助手，拥有更多可能。</h1>
          <p>连接业务工具，沉淀专业方法，让每一次协作更进一步。</p>
        </div>
        {isAdmin && (
          <button className="button primary" onClick={() => setAdding(true)}>
            <Plus size={17} />
            {tab === "skill" ? "添加技能" : "连接 MCP"}
          </button>
        )}
      </header>
      <div className="capabilities-toolbar">
        <div className="capabilities-tabs" role="tablist" aria-label="能力类型">
          <button
            role="tab"
            aria-selected={tab === "skill"}
            className={tab === "skill" ? "active" : ""}
            onClick={() => {
              setTab("skill");
              setQuery("");
            }}
          >
            <BookOpen size={17} />
            技能 <span>{data.skills.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === "mcp"}
            className={tab === "mcp" ? "active" : ""}
            onClick={() => {
              setTab("mcp");
              setQuery("");
            }}
          >
            <Plug size={17} />
            MCP 连接 <span>{data.mcp_servers.length}</span>
          </button>
        </div>
        <label className="capabilities-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索能力…"
            aria-label="搜索能力"
          />
          {query && (
            <button
              className="icon-button"
              onClick={() => setQuery("")}
              aria-label="清除搜索"
            >
              <X size={14} />
            </button>
          )}
        </label>
      </div>
      {error && (
        <div className="admin-error" role="alert">
          {error}
          <button className="admin-error-retry" onClick={refresh}>
            重试
          </button>
        </div>
      )}
      {!user ? (
        <div className="capabilities-empty">
          <div className="capabilities-empty-icon">
            <ShieldCheck size={36} strokeWidth={1.4} />
          </div>
          <h2>你的能力，随工作而生</h2>
          <p>登录后启用团队技能与工具连接，构建属于你的工作方式。</p>
          <button className="button primary" onClick={onAuth}>
            登录工作台
            <ArrowUpRight size={16} />
          </button>
        </div>
      ) : loading ? (
        <div className="admin-loading">
          <LoaderCircle className="spin" size={23} />
          正在加载能力
        </div>
      ) : items.length === 0 ? (
        <div className="capabilities-empty">
          <div className="capabilities-empty-icon">
            {tab === "skill" ? (
              <BookOpen size={37} strokeWidth={1.35} />
            ) : (
              <Plug size={37} strokeWidth={1.35} />
            )}
          </div>
          <h2>
            {query
              ? "没有找到匹配的能力"
              : tab === "skill"
                ? "把专业经验，变成助手的技能"
                : "连接工具，延伸助手的能力"}
          </h2>
          <p>
            {query
              ? "试试其他关键词，或清除搜索条件。"
              : tab === "skill"
                ? "将工作方法与任务规范写成技能，助手会在合适的时机使用。"
                : "通过 MCP 接入企业系统与数据服务，在对话中完成更多工作。"}
          </p>
          {query ? (
            <button className="button secondary" onClick={() => setQuery("")}>
              清除搜索
            </button>
          ) : isAdmin ? (
            <button className="button primary" onClick={() => setAdding(true)}>
              <Plus size={16} />
              {tab === "skill" ? "添加第一个技能" : "添加 MCP 连接"}
            </button>
          ) : (
            <span className="admin-muted">请联系管理员添加团队能力</span>
          )}
        </div>
      ) : (
        <div className="capabilities-list">
          {items.map((item) => (
            <article className="capability-row" key={item.id}>
              <div className={`capability-icon ${item.type}`}>
                {item.type === "skill" ? (
                  <FileText size={22} strokeWidth={1.5} />
                ) : (
                  <Plug size={22} strokeWidth={1.5} />
                )}
              </div>
              <button
                className="capability-description"
                onClick={() => view(item)}
              >
                <h3>
                  {item.name}
                  <ChevronRight size={15} />
                </h3>
                <p>
                  {item.description ||
                    (item.type === "skill"
                      ? "为助手提供专业工作指引"
                      : "通过 MCP 扩展工具与数据能力")}
                </p>
                <span>
                  {item.type === "skill" ? "专业技能" : "MCP 工具连接"} ·{" "}
                  {item.enabled ? "已启用" : "未启用"}
                </span>
              </button>
              <div className="capability-actions">
                <button
                  className={`capability-switch ${item.enabled ? "enabled" : ""}`}
                  role="switch"
                  aria-checked={item.enabled}
                  aria-label={`${item.enabled ? "停用" : "启用"} ${item.name}`}
                  disabled={busy === item.id}
                  onClick={() => toggle(item)}
                >
                  <span />
                </button>
                {isAdmin && (
                  <button
                    className="icon-button capability-delete"
                    aria-label={`删除 ${item.name}`}
                    onClick={() => setDeleting(item)}
                    disabled={busy === item.id}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <footer className="capabilities-footnote">
        <ShieldCheck size={16} />
        <span>能力按你的偏好启用。外部工具执行前，助手会请求你的确认。</span>
      </footer>
      {adding && (
        <AddExtensionModal
          kind={tab}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}
      {viewing && (
        <Modal
          title={viewing.name}
          description={viewing.description}
          onClose={() => setViewing(null)}
          className="extension-detail-modal"
        >
          <div className="extension-detail-meta">
            <span>
              {viewing.type === "skill" ? (
                <BookOpen size={16} />
              ) : (
                <Plug size={16} />
              )}
              {viewing.type === "skill" ? "技能指引" : "MCP 工具连接"}
            </span>
            <span
              className={`admin-status ${viewing.enabled ? "is-ready" : ""}`}
            >
              <i />
              {viewing.enabled ? "已启用" : "已停用"}
            </span>
          </div>
          {viewing.type === "skill" ? (
            <pre className="extension-content">
              {viewing.content ?? "暂无技能内容。"}
            </pre>
          ) : (
            <div className="admin-note">
              <ShieldCheck size={18} />
              <div>
                <strong>由你确认的工具执行</strong>
                <p>
                  此连接启用后，助手可以按任务需要调用服务提供的工具。调用前会展示工具名称与参数，等待你的批准。
                </p>
              </div>
            </div>
          )}
          <div className="admin-modal-footer">
            <button
              className="button secondary"
              onClick={() => setViewing(null)}
            >
              关闭
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={`删除${deleting.type === "skill" ? "技能" : "连接"}`}
          description={`“${deleting.name}”将从团队能力中心移除。此操作不会删除已有对话。`}
          onClose={() => setDeleting(null)}
        >
          <div className="admin-modal-footer">
            <button
              className="button secondary"
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button
              className="button admin-danger"
              onClick={remove}
              disabled={busy === deleting.id}
            >
              {busy === deleting.id ? "删除中…" : "确认删除"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AddExtensionModal({
  kind,
  onClose,
  onCreated,
}: {
  kind: Kind;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [tokenEnv, setTokenEnv] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/extensions/${kind === "skill" ? "skills" : "mcp"}`, {
        method: "POST",
        body: JSON.stringify(
          kind === "skill"
            ? { name: name.trim(), description: description.trim(), content }
            : {
                name: name.trim(),
                description: description.trim(),
                url: url.trim(),
                ...(tokenEnv.trim() ? { token_env: tokenEnv.trim() } : {}),
              },
        ),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "添加失败，请检查配置。");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={kind === "skill" ? "添加团队技能" : "连接 MCP 服务"}
      description={
        kind === "skill"
          ? "把可复用的方法交给助手，让专业经验持续发挥作用。"
          : "连接你信任的工具服务，将能力带入对话。"
      }
      onClose={onClose}
      className="extension-editor-modal"
    >
      <form onSubmit={submit}>
        <label className="admin-field">
          {kind === "skill" ? "技能名称" : "连接名称"}
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              kind === "skill" ? "例如：生产数据分析" : "例如：企业知识库"
            }
            required
            maxLength={100}
            autoFocus
            disabled={saving}
          />
        </label>
        <label className="admin-field">
          用途描述
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述适用场景，帮助助手在合适的时候使用"
            maxLength={1000}
            disabled={saving}
            required={kind === "skill"}
          />
        </label>
        {kind === "skill" ? (
          <label className="admin-field">
            技能内容
            <span className="admin-field-help">
              支持 Markdown，可直接粘贴 SKILL.md 中的工作指引
            </span>
            <textarea
              className="input extension-content-input"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={
                "# 工作目标\n描述这项技能要完成的任务。\n\n## 执行步骤\n1. 读取输入资料\n2. 分析与验证\n3. 生成交付文件"
              }
              required
              rows={11}
              disabled={saving}
            />
          </label>
        ) : (
          <>
            <label className="admin-field">
              MCP 服务地址
              <input
                className="input"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://tools.example.com/mcp"
                required
                disabled={saving}
              />
            </label>
            <label className="admin-field">
              访问令牌环境变量（可选）
              <span className="admin-field-help">
                只填写服务器环境变量名称，不要填写令牌或密钥。服务无需认证时留空。
              </span>
              <input
                className="input"
                value={tokenEnv}
                onChange={(e) => setTokenEnv(e.target.value)}
                placeholder="MCP_ERP_TOKEN"
                pattern="^MCP_[A-Z0-9_]+_TOKEN$"
                title="使用 MCP_ 开头、_TOKEN 结尾的大写环境变量名称，例如 MCP_ERP_TOKEN"
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
              />
            </label>
            <div className="admin-note">
              <Code2 size={18} />
              <div>
                <strong>Streamable HTTP 协议</strong>
                <p>
                  服务需要使用 HTTPS，且主机名已加入服务器的 MCP
                  允许列表。工具调用将在确认后执行。
                </p>
              </div>
            </div>
          </>
        )}
        {error && (
          <div className="admin-error" role="alert">
            {error}
          </div>
        )}
        <div className="admin-modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}
            {saving ? "添加中" : kind === "skill" ? "添加技能" : "添加连接"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
