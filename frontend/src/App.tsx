import {
  ArrowRight,
  BarChart3,
  ChevronDown,
  Code2,
  Command,
  FileText,
  LoaderCircle,
  Menu,
  MessageSquare,
  PanelRight,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { Composer } from "./components/Composer";
import { ChatMessages } from "./components/ChatMessages";
import { ArtifactPreview, FilesView, Workspace } from "./components/Artifacts";
import { AuthModal } from "./components/AuthModal";
import { SettingsModal } from "./components/SettingsModal";
import { CapabilitiesView } from "./components/CapabilitiesView";
import { Modal } from "./components/Modal";
import { useWorkspace } from "./lib/useWorkspace";
const suggestions = [
  {
    title: "数据分析",
    description: "从数据中发现问题",
    Icon: BarChart3,
    prompt:
      "我想分析一份数据，请先了解我的分析目标，并在我上传文件后帮我清洗数据、发现规律，生成可视化和报告。",
  },
  {
    title: "文档创作",
    description: "让每一个想法成形",
    Icon: FileText,
    prompt:
      "帮我创作一份专业文档。请先了解文档的主题、目标读者与使用场景，再一起确定结构。",
  },
  {
    title: "研究检索",
    description: "连接信息与新洞察",
    Icon: Search,
    prompt:
      "我想开展一项研究。请先明确研究问题，基于我提供的资料和已连接的工具进行分析，并注明依据与不确定性。",
  },
  {
    title: "代码与自动化",
    description: "把重复工作交给助手",
    Icon: Code2,
    prompt:
      "帮我完成一个代码与自动化任务。请先了解我当前的工作流程，设计方案，并在隔离工作空间中编写和验证代码。",
  },
];
function App() {
  const {
    user,
    sessions,
    detail,
    settings,
    setSettings,
    view,
    workspace,
    setWorkspace,
    sidebar,
    setSidebar,
    auth,
    setAuth,
    settingOpen,
    setSettingOpen,
    shortcuts,
    setShortcuts,
    sessionSearch,
    setSessionSearch,
    query,
    setQuery,
    draft,
    setDraft,
    pending,
    setPending,
    run,
    uploading,
    sending,
    stopping,
    loading,
    toast,
    setToast,
    notice,
    runSyncError,
    retryRunSync,
    setNotice,
    preview,
    setPreview,
    rename,
    setRename,
    renameValue,
    setRenameValue,
    deleting,
    setDeleting,
    fileDeleting,
    setFileDeleting,
    mutating,
    stream,
    handleAuthenticated,
    resetChat,
    selectSession,
    send,
    upload,
    approve,
    logout,
    pin,
    saveRename,
    deleteSession,
    deleteFile,
    navigate,
  } = useWorkspace();
  const populated = !!detail?.messages.length || !!run;
  const runBusy =
    !!run && ["queued", "running", "awaiting_approval"].includes(run.status);
  return (
    <div className="app-shell">
      <Sidebar
        user={user}
        sessions={sessions}
        activeId={detail?.session.id ?? null}
        view={view}
        open={sidebar}
        query={query}
        onQuery={setQuery}
        onNew={resetChat}
        onNavigate={navigate}
        onSelect={(s) => void selectSession(s)}
        onSettings={() => setSettingOpen(true)}
        onAuth={() => setAuth(true)}
        onLogout={() => void logout()}
        onClose={() => setSidebar(false)}
        onRename={(s) => {
          setRename(s);
          setRenameValue(s.title);
        }}
        onDelete={setDeleting}
        onPin={(s) => void pin(s)}
      />
      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </button>
            <button
              className="assistant-name"
              onClick={() => setSettingOpen(true)}
            >
              丰尚助手
              <ChevronDown size={13} />
            </button>
            <span className="breadcrumb-slash">/</span>
            <span className="breadcrumb-title">
              {view === "chat"
                ? detail?.session.title || "新建对话"
                : view === "files"
                  ? "文件空间"
                  : "能力中心"}
            </span>
          </div>
          <div className="topbar-actions">
            {view === "chat" && (
              <button
                className={`button workspace-toggle ${workspace ? "active" : ""}`}
                aria-label="工作空间"
                aria-expanded={workspace}
                onClick={() => setWorkspace(!workspace)}
              >
                <PanelRight size={16} />
                <span>工作空间</span>
              </button>
            )}
            <button
              className="shortcut-button"
              aria-label="快捷键"
              onClick={() => setShortcuts(true)}
            >
              <Command size={14} />
              <span>/</span>
            </button>
          </div>
        </header>
        <div className="app-content">
          <section
            className={`main-content ${view === "chat" ? "chat-content" : ""}`}
          >
            {view === "chat" ? (
              <>
                {loading ? (
                  <div className="loading-session">
                    <LoaderCircle size={25} className="spin" />
                    <span>正在打开你的对话…</span>
                  </div>
                ) : populated ? (
                  <>
                    <div className="chat-scroll">
                      <ChatMessages
                        messages={detail?.messages ?? []}
                        runs={detail?.runs ?? []}
                        activeRunId={run?.id}
                        conversationId={detail?.session.id}
                        files={detail?.files ?? []}
                        user={user}
                        timeline={stream.timeline}
                        busy={!!run}
                        approval={stream.approval}
                        onApprove={approve}
                        onPreview={setPreview}
                        connectionLost={stream.connectionLost}
                      />
                    </div>
                    <div className="chat-composer-wrap">
                      {runSyncError && (
                        <div className="inline-notice" role="status">
                          <span>{runSyncError}</span>
                          <button onClick={() => void retryRunSync()}>
                            重试同步
                          </button>
                        </div>
                      )}
                      {notice && (
                        <div className="inline-notice" role="alert">
                          <span>{notice}</span>
                          <button
                            aria-label="关闭提示"
                            onClick={() => setNotice("")}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      )}
                      <Composer
                        compact
                        value={draft}
                        onChange={setDraft}
                        onSend={() => void send()}
                        onUpload={(f) => void upload(f)}
                        attachments={pending}
                        onRemove={(id) =>
                          setPending((p) => p.filter((f) => f.id !== id))
                        }
                        busy={runBusy}
                        stopping={stopping}
                        uploading={uploading || sending}
                        onCapabilities={() => navigate("capabilities")}
                      />
                      <div className="chat-disclaimer">
                        助手也可能出错，请核实重要信息。
                        <button onClick={() => setSettingOpen(true)}>
                          {settings?.provider.model || "自定义模型"}
                          <ChevronDown size={11} />
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="welcome-screen">
                    <div className="welcome-content">
                      <div className="orb-wrap" aria-hidden="true">
                        <div className="orb-glow" />
                        <div className="orb">
                          <div className="orb-ribbon" />
                          <div className="orb-gloss" />
                        </div>
                      </div>
                      <h1>让灵感，成为生产力。</h1>
                      <p className="welcome-description">
                        从一个问题到一份成果，丰尚助手与你一起完成。
                      </p>
                      {notice && (
                        <div className="inline-notice" role="alert">
                          <span>{notice}</span>
                          <button
                            aria-label="关闭提示"
                            onClick={() => setNotice("")}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      )}
                      <Composer
                        value={draft}
                        onChange={setDraft}
                        onSend={() => void send()}
                        onUpload={(f) => void upload(f)}
                        attachments={pending}
                        onRemove={(id) =>
                          setPending((p) => p.filter((f) => f.id !== id))
                        }
                        busy={false}
                        uploading={uploading || sending}
                        onCapabilities={() => navigate("capabilities")}
                      />
                      <div className="suggestions">
                        {suggestions.map(
                          ({ title, description, Icon, prompt }) => (
                            <button
                              key={title}
                              onClick={() => {
                                setDraft(prompt);
                                document
                                  .querySelector<HTMLTextAreaElement>(
                                    ".composer textarea",
                                  )
                                  ?.focus();
                              }}
                            >
                              <span className="suggestion-icon">
                                <Icon size={20} strokeWidth={1.6} />
                              </span>
                              <div>
                                <strong>{title}</strong>
                                <small>{description}</small>
                              </div>
                              <ArrowRight size={13} />
                            </button>
                          ),
                        )}
                      </div>
                    </div>
                    <div className="welcome-footer">
                      <button
                        className="model-select"
                        onClick={() => setSettingOpen(true)}
                      >
                        <Sparkles size={16} />
                        <span>{settings?.provider.model || "自定义模型"}</span>
                        <ChevronDown size={12} />
                      </button>
                      <span>
                        {user && settings && !settings.provider.configured
                          ? "模型密钥待配置 · 可先整理文件与能力"
                          : "你的每个想法，都有独立的工作空间"}
                      </span>
                    </div>
                  </div>
                )}
              </>
            ) : view === "files" ? (
              <FilesView
                key={`files-${user?.id}`}
                user={user}
                onAuth={() => setAuth(true)}
                onPreview={setPreview}
                onOpenSession={(id) => void selectSession(id)}
              />
            ) : (
              <CapabilitiesView user={user} onAuth={() => setAuth(true)} />
            )}
          </section>
          {view === "chat" && workspace && (
            <Workspace
              files={detail?.files ?? []}
              onClose={() => setWorkspace(false)}
              onUpload={(f) => void upload(f)}
              onPreview={setPreview}
              onDelete={setFileDeleting}
              uploading={uploading}
            />
          )}
        </div>
      </main>
      {auth && (
        <AuthModal
          onClose={() => setAuth(false)}
          onSuccess={(u) => void handleAuthenticated(u)}
        />
      )}
      {settingOpen && (
        <SettingsModal
          user={user}
          settings={settings}
          onClose={() => setSettingOpen(false)}
          onSave={setSettings}
          onAuth={() => {
            setSettingOpen(false);
            setAuth(true);
          }}
        />
      )}
      {preview && (
        <ArtifactPreview file={preview} onClose={() => setPreview(null)} />
      )}
      {shortcuts && (
        <Modal
          title="让操作，更流畅"
          description="一点快捷，让你专注于手上的工作。"
          onClose={() => setShortcuts(false)}
          className="shortcuts-modal"
        >
          <div className="shortcut-row">
            <span>新建对话</span>
            <kbd>⌘ / Ctrl</kbd>
            <kbd>K</kbd>
          </div>
          <div className="shortcut-row">
            <span>搜索对话</span>
            <kbd>⌘ / Ctrl</kbd>
            <kbd>P</kbd>
          </div>
          <div className="shortcut-row">
            <span>查看快捷键</span>
            <kbd>⌘ / Ctrl</kbd>
            <kbd>/</kbd>
          </div>
          <div className="shortcut-row">
            <span>发送消息</span>
            <kbd>Enter</kbd>
          </div>
          <div className="shortcut-row">
            <span>消息内换行</span>
            <kbd>Shift</kbd>
            <kbd>Enter</kbd>
          </div>
        </Modal>
      )}
      {sessionSearch && (
        <Modal
          title="搜索你的对话"
          onClose={() => setSessionSearch(false)}
          className="search-modal"
        >
          <label className="search-field">
            <Search size={17} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="输入关键词…"
            />
          </label>
          <div className="search-results">
            {sessions
              .filter((s) =>
                s.title.toLowerCase().includes(query.toLowerCase()),
              )
              .map((s) => (
                <button key={s.id} onClick={() => void selectSession(s)}>
                  <MessageSquare size={16} />
                  <span>{s.title}</span>
                  <ArrowRight size={15} />
                </button>
              ))}
            {sessions.filter((s) => s.title.includes(query)).length === 0 && (
              <p>没有找到相关对话</p>
            )}
          </div>
        </Modal>
      )}
      {rename && (
        <Modal title="重命名对话" onClose={() => setRename(null)}>
          <form onSubmit={saveRename} className="stack-form">
            <label className="field">
              对话名称
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                required
                maxLength={120}
              />
            </label>
            <div className="modal-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setRename(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={mutating || !renameValue.trim()}
              >
                {mutating ? "保存中…" : "保存名称"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="删除这段对话？"
          description={`“${deleting.title}”及其文件将被永久删除，此操作无法撤销。`}
          onClose={() => setDeleting(null)}
        >
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDeleting(null)}
            >
              保留对话
            </button>
            <button
              className="button danger-button"
              onClick={() => void deleteSession()}
              disabled={mutating}
            >
              {mutating ? "正在删除…" : "删除对话"}
            </button>
          </div>
        </Modal>
      )}
      {fileDeleting && (
        <Modal
          title="删除这份文件？"
          description={`“${fileDeleting.name}”将从当前会话移除，此操作无法撤销。`}
          onClose={() => setFileDeleting(null)}
        >
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setFileDeleting(null)}
            >
              取消
            </button>
            <button
              className="button danger-button"
              onClick={() => void deleteFile()}
              disabled={mutating}
            >
              {mutating ? "正在删除…" : "删除文件"}
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button aria-label="关闭通知" onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
export default App;
