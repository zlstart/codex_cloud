import { useState } from "react";
import {
  Plus,
  MessageSquare,
  Files,
  Blocks,
  Search,
  Settings2,
  ChevronDown,
  PanelLeftClose,
  MoreHorizontal,
  Pin,
  Pencil,
  Trash2,
  LogOut,
  ArrowUpRight,
} from "lucide-react";
import { formatDate } from "../lib/api";
import type { Session, User, View } from "../types";
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <svg className="brand-mark" viewBox="0 0 42 46" aria-hidden="true">
        <defs>
          <linearGradient id="brandGradient" x2="0" y2="1">
            <stop stopColor="#ffb735" />
            <stop offset="1" stopColor="#ff6d00" />
          </linearGradient>
        </defs>
        <path
          d="M10 3H40L37 12H10C3 12 0 12 3 7Q5 3 10 3ZM13 17H32L29 25H15Q11 25 11 29V40Q11 44 6 44Q1 44 1 40V30Q1 17 13 17Z"
          fill="url(#brandGradient)"
        />
      </svg>
      {!compact && (
        <div>
          <strong>
            FAMSUN <span>丰尚</span>
          </strong>
          <small>智能工作台</small>
        </div>
      )}
    </div>
  );
}
export function Sidebar({
  user,
  sessions,
  activeId,
  view,
  open,
  query,
  onQuery,
  onNew,
  onNavigate,
  onSelect,
  onSettings,
  onAuth,
  onLogout,
  onClose,
  onRename,
  onDelete,
  onPin,
}: {
  user: User | null;
  sessions: Session[];
  activeId: string | null;
  view: View;
  open: boolean;
  query: string;
  onQuery: (q: string) => void;
  onNew: () => void;
  onNavigate: (v: View) => void;
  onSelect: (s: Session) => void;
  onSettings: () => void;
  onAuth: () => void;
  onLogout: () => void;
  onClose: () => void;
  onRename: (s: Session) => void;
  onDelete: (s: Session) => void;
  onPin: (s: Session) => void;
}) {
  const [search, setSearch] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const filtered = sessions
    .filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return (
    <>
      {open && <div className="sidebar-scrim" onClick={onClose} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <Brand />
          <button
            className="sidebar-collapse"
            aria-label="收起导航"
            onClick={onClose}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <button className="new-chat" onClick={onNew}>
          <Plus size={20} />
          <span>新建对话</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav className="main-nav" aria-label="主导航">
          {(
            [
              { id: "chat", label: "对话", Icon: MessageSquare },
              { id: "files", label: "文件空间", Icon: Files },
              { id: "capabilities", label: "能力中心", Icon: Blocks },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => onNavigate(id)}
            >
              <Icon size={20} strokeWidth={1.6} />
              {label}
              {view === id && <i />}
            </button>
          ))}
        </nav>
        <div className="recent-heading">
          <span>最近对话</span>
          <button
            aria-label="搜索对话"
            onClick={() => {
              setSearch(!search);
              onQuery("");
            }}
          >
            <Search size={16} />
          </button>
        </div>
        {search && (
          <div className="session-search">
            <Search size={14} />
            <input
              autoFocus
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="搜索对话…"
              aria-label="搜索对话"
            />
          </div>
        )}
        <div className="session-list">
          {filtered.length ? (
            filtered.map((s) => (
              <div
                key={s.id}
                className={`session-row ${activeId === s.id && view === "chat" ? "selected" : ""}`}
              >
                <button className="session-select" onClick={() => onSelect(s)}>
                  {s.pinned ? <Pin size={14} /> : <MessageSquare size={15} />}
                  <span>{s.title}</span>
                  <small>{formatDate(s.updated_at)}</small>
                </button>
                <button
                  className="session-more"
                  aria-label={`管理对话 ${s.title}`}
                  onClick={() => setMenu(menu === s.id ? null : s.id)}
                >
                  <MoreHorizontal size={16} />
                </button>
                {menu === s.id && (
                  <>
                    <div
                      className="menu-dismiss"
                      onClick={() => setMenu(null)}
                    />
                    <div className="session-menu">
                      <button
                        onClick={() => {
                          onPin(s);
                          setMenu(null);
                        }}
                      >
                        <Pin size={14} />
                        {s.pinned ? "取消置顶" : "置顶对话"}
                      </button>
                      <button
                        onClick={() => {
                          onRename(s);
                          setMenu(null);
                        }}
                      >
                        <Pencil size={14} />
                        重命名
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          onDelete(s);
                          setMenu(null);
                        }}
                      >
                        <Trash2 size={14} />
                        删除对话
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
          ) : (
            <div className="history-empty">
              <MessageSquare size={23} strokeWidth={1.2} />
              <p>{query ? "没有找到相关对话" : "一个想法，就是新的开始"}</p>
              <span>
                {query
                  ? "试试其他关键词"
                  : user
                    ? "你的对话会保存在这里"
                    : "登录后保存你的每一次探索"}
              </span>
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className="workspace-link"
            onClick={() => onNavigate("files")}
          >
            <div className="workspace-symbol">F</div>
            <span>丰尚工作空间</span>
            <ArrowUpRight size={15} />
          </button>
          <div className="profile-row">
            <button className="profile" onClick={user ? onSettings : onAuth}>
              <span className="avatar">
                {user ? user.name.charAt(0).toUpperCase() : <span>F</span>}
              </span>
              <div>
                <strong>{user ? user.name : "登录工作台"}</strong>
                <small>
                  {user
                    ? user.role === "admin"
                      ? "工作空间管理员"
                      : "工作空间成员"
                    : "开启你的专属智能空间"}
                </small>
              </div>
            </button>
            {user ? (
              <button
                className="bottom-icon"
                onClick={onLogout}
                aria-label="退出登录"
              >
                <LogOut size={17} />
              </button>
            ) : (
              <button
                className="bottom-icon"
                onClick={onAuth}
                aria-label="登录"
              >
                <ChevronDown size={17} />
              </button>
            )}
            <button
              className="bottom-icon"
              onClick={onSettings}
              aria-label="设置"
            >
              <Settings2 size={18} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
