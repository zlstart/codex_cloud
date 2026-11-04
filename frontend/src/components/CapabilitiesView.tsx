import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  LoaderCircle,
  Pencil,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { Extension, User } from "../types";
import { api, errorMessage } from "../lib/api";
import { Modal } from "./Modal";
import {
  CapabilityEditor,
  capabilityKinds,
  type CapabilityData,
  type CapabilityKind,
} from "./CapabilityEditor";
import "../styles/admin.css";
import "../styles/capabilities.css";

interface Props {
  user: User | null;
  onAuth: () => void;
}
const emptyData = (): CapabilityData => ({
  skills: [],
  mcp_servers: [],
  subagents: [],
});
const icons = { skill: BookOpen, mcp: Plug, subagent: Bot };
const collection = {
  skill: "skills",
  mcp: "mcp_servers",
  subagent: "subagents",
} as const;

export function CapabilitiesView({ user, onAuth }: Props) {
  const [data, setData] = useState<CapabilityData>(emptyData);
  const [tab, setTab] = useState<CapabilityKind>("skill");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(!!user);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    kind: CapabilityKind;
    item?: Extension;
    readOnly?: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState<Extension | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const userId = useRef(user?.id);
  userId.current = user?.id;
  const requestId = useRef(0);
  const isAdmin = user?.role === "admin";

  async function refresh() {
    const owner = user?.id;
    if (!owner) return;
    const request = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const next = await api<CapabilityData>("/extensions");
      if (userId.current === owner && requestId.current === request)
        setData({ ...emptyData(), ...next });
    } catch (e) {
      if (userId.current === owner && requestId.current === request)
        setError(errorMessage(e));
    } finally {
      if (userId.current === owner && requestId.current === request)
        setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const request = ++requestId.current;
    setData(emptyData());
    setEditor(null);
    setDeleting(null);
    setBusy(null);
    setError("");
    setNotice("");
    setLoading(!!user);
    if (user) {
      api<CapabilityData>("/extensions", { signal: controller.signal })
        .then((next) => {
          if (request === requestId.current)
            setData({ ...emptyData(), ...next });
        })
        .catch((e) => {
          if (!controller.signal.aborted && request === requestId.current)
            setError(errorMessage(e));
        })
        .finally(() => {
          if (!controller.signal.aborted && request === requestId.current)
            setLoading(false);
        });
    }
    return () => {
      controller.abort();
      requestId.current++;
    };
  }, [user?.id]);

  async function toggle(item: Extension) {
    const owner = user?.id;
    setBusy(item.id);
    setError("");
    try {
      await api(`/extensions/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !item.enabled }),
      });
      if (userId.current !== owner) return;
      setData((previous) => ({
        ...previous,
        [collection[item.type]]: previous[collection[item.type]].map((x) =>
          x.id === item.id ? { ...x, enabled: !item.enabled } : x,
        ),
      }));
    } catch (e) {
      if (userId.current === owner) setError(errorMessage(e));
    } finally {
      if (userId.current === owner) setBusy(null);
    }
  }

  async function view(item: Extension, edit = false) {
    const owner = user?.id;
    setBusy(item.id);
    setError("");
    try {
      const detail = await api<Extension>(`/extensions/${item.id}`);
      if (userId.current === owner)
        setEditor({ kind: item.type, item: detail, readOnly: !edit });
    } catch (e) {
      if (userId.current === owner) setError(errorMessage(e));
    } finally {
      if (userId.current === owner) setBusy(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    const owner = user?.id;
    const item = deleting;
    setBusy(item.id);
    setDeleteError("");
    try {
      await api(`/extensions/${item.id}`, { method: "DELETE" });
      if (userId.current !== owner) return;
      setData((previous) => ({
        ...previous,
        [collection[item.type]]: previous[collection[item.type]].filter(
          (x) => x.id !== item.id,
        ),
      }));
      setDeleting(null);
      setNotice(`已删除「${item.name}」`);
    } catch (e) {
      if (userId.current === owner) setDeleteError(errorMessage(e));
    } finally {
      if (userId.current === owner) setBusy(null);
    }
  }

  const info = capabilityKinds[tab];
  const items = data[collection[tab]].filter((x) =>
    `${x.name} ${x.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const selectedIndex = Object.keys(capabilityKinds).indexOf(tab);
  return (
    <div className="capabilities-view">
      <header className="capabilities-header">
        <div>
          <div className="capabilities-emblem">
            <Sparkles size={24} strokeWidth={1.5} />
            <span>团队能力</span>
          </div>
          <h1>让助手，拥有更多可能。</h1>
          <p>沉淀专业技能，连接业务工具，让子代理分工协作。</p>
        </div>
        {isAdmin && (
          <button
            className="button primary"
            disabled={busy !== null}
            onClick={() => setEditor({ kind: tab })}
          >
            <Plus size={17} />
            {info.add}
          </button>
        )}
      </header>
      <div className="capabilities-toolbar">
        <div
          className="capabilities-tabs"
          role="tablist"
          aria-label="能力类型"
          onKeyDown={(event) => {
            const keys = Object.keys(capabilityKinds) as CapabilityKind[];
            const index =
              event.key === "ArrowRight"
                ? (selectedIndex + 1) % keys.length
                : event.key === "ArrowLeft"
                  ? (selectedIndex + keys.length - 1) % keys.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? keys.length - 1
                      : -1;
            if (index < 0) return;
            event.preventDefault();
            setTab(keys[index]);
            setQuery("");
            document.getElementById(`capability-tab-${keys[index]}`)?.focus();
          }}
        >
          {(Object.keys(capabilityKinds) as CapabilityKind[]).map((kind) => {
            const Icon = icons[kind];
            return (
              <button
                key={kind}
                id={`capability-tab-${kind}`}
                role="tab"
                aria-controls="capabilities-panel"
                tabIndex={tab === kind ? 0 : -1}
                aria-selected={tab === kind}
                className={tab === kind ? "active" : ""}
                onClick={() => {
                  setTab(kind);
                  setQuery("");
                }}
              >
                <Icon size={17} />
                {capabilityKinds[kind].label}
                <span>{data[collection[kind]].length}</span>
              </button>
            );
          })}
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
      <div className="capability-tab-description">
        <span>{info.description}</span>
        <span>启用偏好仅对你生效</span>
      </div>
      {error && (
        <div className="admin-error" role="alert">
          {error}
          <button className="admin-error-retry" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      )}
      {notice && (
        <div className="capability-notice" role="status">
          <Check size={15} />
          {notice}
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <section
        id="capabilities-panel"
        role="tabpanel"
        aria-labelledby={`capability-tab-${tab}`}
        className="capabilities-panel"
      >
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
          <div className="admin-loading" role="status">
            <LoaderCircle className="spin" size={23} />
            正在加载能力
          </div>
        ) : items.length === 0 ? (
          <div className="capabilities-empty">
            <div className="capabilities-empty-icon">
              {tab === "skill" ? (
                <BookOpen size={37} />
              ) : tab === "mcp" ? (
                <Plug size={37} />
              ) : (
                <Bot size={37} />
              )}
            </div>
            <h2>{query ? "没有找到匹配的能力" : info.empty}</h2>
            <p>
              {query ? "试试其他关键词，或清除搜索条件。" : info.description}
            </p>
            {query ? (
              <button className="button secondary" onClick={() => setQuery("")}>
                清除搜索
              </button>
            ) : isAdmin ? (
              <button
                className="button primary"
                disabled={busy !== null}
                onClick={() => setEditor({ kind: tab })}
              >
                <Plus size={16} />
                {info.add}
              </button>
            ) : (
              <span className="admin-muted">请联系管理员添加团队能力</span>
            )}
          </div>
        ) : (
          <div className="capabilities-list">
            {items.map((item) => {
              const Icon = icons[item.type];
              return (
                <article
                  className={`capability-row ${item.enabled ? "" : "capability-disabled"}`}
                  key={item.id}
                >
                  <div className={`capability-icon ${item.type}`}>
                    <Icon size={22} strokeWidth={1.5} />
                  </div>
                  <button
                    className="capability-description"
                    onClick={() => void view(item)}
                    disabled={busy !== null}
                    aria-label={`查看 ${item.name}`}
                  >
                    <h3>
                      {item.name}
                      {item.builtin && (
                        <span className="capability-builtin">内置</span>
                      )}
                      <ChevronRight size={15} />
                    </h3>
                    <p>{item.description || info.description}</p>
                    <span>
                      {item.enabled ? "已启用" : "未启用"}
                      {item.type === "subagent" &&
                        ` · ${item.config?.model || "跟随主模型"} · ${item.config?.max_turns == null ? "轮数跟随主助手" : `最多 ${item.config.max_turns} 轮`}`}
                    </span>
                  </button>
                  <div className="capability-actions">
                    {isAdmin && item.editable !== false && (
                      <button
                        className="icon-button capability-edit"
                        aria-label={`编辑 ${item.name}`}
                        disabled={busy !== null}
                        onClick={() => void view(item, true)}
                      >
                        <Pencil size={16} />
                      </button>
                    )}
                    <button
                      className={`capability-switch ${item.enabled ? "enabled" : ""}`}
                      role="switch"
                      aria-checked={item.enabled}
                      aria-label={`${item.enabled ? "停用" : "启用"} ${item.name}`}
                      disabled={busy !== null}
                      onClick={() => void toggle(item)}
                    >
                      <span />
                    </button>
                    {isAdmin && !item.builtin && (
                      <button
                        className="icon-button capability-delete"
                        aria-label={`删除 ${item.name}`}
                        disabled={busy !== null}
                        onClick={() => {
                          setDeleteError("");
                          setDeleting(item);
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      <footer className="capabilities-footnote">
        <ShieldCheck size={16} />
        <span>
          团队定义由管理员维护。MCP
          工具调用需要你的确认；子代理与主助手共享当前会话文件。
        </span>
      </footer>
      {editor && (
        <CapabilityEditor
          key={`${user?.id}:${editor.item?.id ?? editor.kind}`}
          kind={editor.kind}
          item={editor.item}
          readOnly={editor.readOnly}
          canEdit={isAdmin && editor.item?.editable !== false}
          data={data}
          onClose={() => setEditor(null)}
          onSaved={(name) => {
            setEditor(null);
            setNotice(`已保存「${name}」`);
            void refresh();
          }}
        />
      )}
      {deleting && (
        <Modal
          title={`删除${capabilityKinds[deleting.type].singular}`}
          description={`「${deleting.name}」将从团队能力中心移除。已有对话会保留。`}
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
        >
          {deleteError && (
            <div className="admin-error" role="alert">
              {deleteError}
            </div>
          )}
          <div className="admin-modal-footer">
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button
              className="button admin-danger"
              onClick={() => void remove()}
              disabled={!!busy}
            >
              {busy ? <LoaderCircle size={16} className="spin" /> : null}
              {busy ? "删除中…" : "确认删除"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
