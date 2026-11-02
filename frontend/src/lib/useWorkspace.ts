import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { useRunStream } from "./useRunStream";
import type {
  Artifact,
  Run,
  Session,
  SessionDetail,
  Settings,
  User,
  View,
} from "../types";

/** Owns the authenticated workspace and guards async writes against account/session switches. */
export function useWorkspace() {
  const [user, setUser] = useState<User | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [view, setView] = useState<View>("chat");
  const [workspace, setWorkspace] = useState(
    () => window.matchMedia("(min-width: 1081px)").matches,
  );
  const [sidebar, setSidebar] = useState(false);
  const [auth, setAuth] = useState(false);
  const [settingOpen, setSettingOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [sessionSearch, setSessionSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Artifact[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Artifact | null>(null);
  const [rename, setRename] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [fileDeleting, setFileDeleting] = useState<Artifact | null>(null);
  const [mutating, setMutating] = useState(false);
  const activeId = useRef<string | null>(null);
  const loadId = useRef(0);
  const identity = useRef(0);
  const navigation = useRef(0);
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1081px)");
    const onChange = (event: MediaQueryListEvent) => {
      if (!event.matches) setWorkspace(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  const refreshSessions = useCallback(async () => {
    const actor = identity.current;
    const next = await api<Session[]>("/sessions");
    if (actor === identity.current) setSessions(next);
    return next;
  }, []);
  const reloadDetail = useCallback(async (id: string) => {
    const ticket = ++loadId.current;
    const actor = identity.current;
    const next = await api<SessionDetail>(`/sessions/${id}`);
    if (
      ticket !== loadId.current ||
      activeId.current !== id ||
      actor !== identity.current
    )
      return;
    setDetail(next);
    const active = next.runs.find((r) =>
      ["queued", "running", "awaiting_approval"].includes(r.status),
    );
    setRun(active ?? null);
  }, []);
  useEffect(() => {
    let live = true;
    const actor = identity.current;
    api<User>("/auth/me")
      .then(async (u) => {
        if (!live || actor !== identity.current) return;
        setUser(u);
        const result = await Promise.allSettled([
          api<Session[]>("/sessions"),
          api<Settings>("/settings"),
        ]);
        if (!live || actor !== identity.current) return;
        if (result[0].status === "fulfilled") setSessions(result[0].value);
        if (result[1].status === "fulfilled") setSettings(result[1].value);
      })
      .catch((e) => {
        if (
          live &&
          actor === identity.current &&
          !(e instanceof ApiError && e.status === 401)
        )
          notify("暂时无法连接服务，请确认后端服务已启动。");
      });
    return () => {
      live = false;
    };
  }, [notify]);
  async function handleAuthenticated(next: User) {
    const actor = ++identity.current;
    if (user && user.id !== next.id) resetChat();
    setSessions([]);
    setSettings(null);
    setPreview(null);
    setUser(next);
    setAuth(false);
    try {
      const [ss, config] = await Promise.all([
        api<Session[]>("/sessions"),
        api<Settings>("/settings"),
      ]);
      if (actor !== identity.current) return;
      setSessions(ss);
      setSettings(config);
    } catch (e) {
      notify(errorMessage(e));
    }
  }
  function resetChat() {
    navigation.current++;
    loadId.current++;
    setLoading(false);
    activeId.current = null;
    setDetail(null);
    setRun(null);
    setDraft("");
    setPending([]);
    setNotice("");
    setView("chat");
    setSidebar(false);
    setSessionSearch(false);
  }
  async function selectSession(session: Session | string) {
    const id = typeof session === "string" ? session : session.id;
    navigation.current++;
    activeId.current = id;
    setView("chat");
    setSidebar(false);
    setSessionSearch(false);
    setRun(null);
    setDetail(null);
    setPending([]);
    setDraft("");
    setNotice("");
    setLoading(true);
    try {
      await reloadDetail(id);
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      if (activeId.current === id) setLoading(false);
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        resetChat();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setShortcuts((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setSessionSearch((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const stream = useRunStream(
    run,
    (status, error) => {
      if (status === "run.failed")
        setNotice(error || "任务执行失败，请检查模型连接或稍后重试。");
      if (status === "run.cancelled")
        setNotice("任务已停止。你可以补充要求，继续这段对话。");
      if (activeId.current)
        void reloadDetail(activeId.current).catch((e) =>
          notify(errorMessage(e)),
        );
      void refreshSessions().catch(() => {});
    },
    (file) =>
      setDetail((current) =>
        current && current.session.id === file.session_id
          ? {
              ...current,
              files: current.files.some((f) => f.id === file.id)
                ? current.files
                : [...current.files, file],
            }
          : current,
      ),
    setNotice,
  );
  async function ensureSession(actor: number, page: number) {
    if (actor !== identity.current || page !== navigation.current) return null;
    if (activeId.current) return activeId.current;
    const session = await api<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "新对话" }),
    });
    if (actor !== identity.current || page !== navigation.current) return null;
    activeId.current = session.id;
    setDetail({ session, messages: [], files: [], runs: [] });
    setSessions((ss) => [session, ...ss]);
    return session.id;
  }
  async function send() {
    if (run) {
      try {
        await api(`/runs/${run.id}/cancel`, { method: "POST" });
      } catch (e) {
        notify(errorMessage(e));
      }
      return;
    }
    if (sending || uploading || !draft.trim()) return;
    if (!user) {
      setAuth(true);
      return;
    }
    setSending(true);
    setNotice("");
    const actor = identity.current;
    const page = navigation.current;
    const content = draft.trim();
    const attachments = [...pending];
    try {
      const id = await ensureSession(actor, page);
      if (!id) return;
      const next = await api<Run>(`/sessions/${id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          content,
          attachment_ids: attachments.map((f) => f.id),
          client_request_id: crypto.randomUUID(),
        }),
      });
      if (actor === identity.current) void refreshSessions().catch(() => {});
      if (
        actor !== identity.current ||
        page !== navigation.current ||
        activeId.current !== id
      )
        return;
      setDraft("");
      setPending([]);
      setDetail((d) =>
        d && d.session.id === id
          ? {
              ...d,
              messages: [
                ...d.messages,
                {
                  id: `pending-${next.id}`,
                  role: "user",
                  content,
                  attachments,
                  created_at: new Date().toISOString(),
                  run_id: next.id,
                },
              ],
            }
          : d,
      );
      setRun(next);
      void refreshSessions().catch(() => {});
    } catch (e) {
      if (actor !== identity.current || page !== navigation.current) return;
      setNotice(errorMessage(e));
      if (e instanceof ApiError && e.status === 401) setAuth(true);
    } finally {
      if (actor === identity.current) setSending(false);
    }
  }
  async function upload(files: File[]) {
    if (!files.length) return;
    if (!user) {
      setAuth(true);
      return;
    }
    if (uploading || run) {
      notify(run ? "任务运行期间请稍候再上传文件。" : "文件正在上传，请稍候。");
      return;
    }
    const max = settings?.limits.max_upload_mb ?? 25;
    const tooLarge = files.find((f) => f.size > max * 1024 * 1024);
    if (tooLarge) {
      notify(`${tooLarge.name} 超出单文件 ${max} MB 的限制。`);
      return;
    }
    setUploading(true);
    setNotice("");
    const actor = identity.current;
    const page = navigation.current;
    try {
      const id = await ensureSession(actor, page);
      if (!id) return;
      for (const file of files) {
        if (actor !== identity.current || page !== navigation.current) return;
        const data = new FormData();
        data.append("file", file);
        const artifact = await api<Artifact>(`/sessions/${id}/files`, {
          method: "POST",
          body: data,
        });
        if (actor !== identity.current || page !== navigation.current) return;
        setDetail((d) =>
          d?.session.id === id ? { ...d, files: [...d.files, artifact] } : d,
        );
        if (activeId.current === id) setPending((p) => [...p, artifact]);
      }
      setWorkspace(true);
      notify(`已上传 ${files.length} 个文件，可以开始提问了。`);
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      if (actor === identity.current) setUploading(false);
    }
  }
  async function approve(approved: boolean) {
    if (!run || !stream.approval) return;
    await api(`/runs/${run.id}/approve`, {
      method: "POST",
      body: JSON.stringify({ approval_id: stream.approval.id, approved }),
    });
    stream.setApproval(null);
  }
  async function logout() {
    const actor = ++identity.current;
    try {
      await api("/auth/logout", { method: "POST" });
      if (actor !== identity.current) return;
      setUser(null);
      setPreview(null);
      setSettingOpen(false);
      setRename(null);
      setDeleting(null);
      setFileDeleting(null);
      setSending(false);
      setUploading(false);
      setSessions([]);
      setSettings(null);
      resetChat();
      notify("已安全退出登录");
    } catch (e) {
      notify(errorMessage(e));
    }
  }
  async function pin(session: Session) {
    try {
      const next = await api<Session>(`/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned: !session.pinned }),
      });
      setSessions((ss) => ss.map((s) => (s.id === next.id ? next : s)));
    } catch (e) {
      notify(errorMessage(e));
    }
  }
  async function saveRename(e: React.FormEvent) {
    e.preventDefault();
    if (!rename) return;
    setMutating(true);
    try {
      const next = await api<Session>(`/sessions/${rename.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: renameValue.trim() }),
      });
      setSessions((ss) => ss.map((s) => (s.id === next.id ? next : s)));
      setDetail((d) =>
        d?.session.id === next.id ? { ...d, session: next } : d,
      );
      setRename(null);
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setMutating(false);
    }
  }
  async function deleteSession() {
    if (!deleting) return;
    setMutating(true);
    try {
      await api(`/sessions/${deleting.id}`, { method: "DELETE" });
      setSessions((ss) => ss.filter((s) => s.id !== deleting.id));
      if (activeId.current === deleting.id) resetChat();
      setDeleting(null);
      notify("对话及关联文件已删除");
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setMutating(false);
    }
  }
  async function deleteFile() {
    if (!fileDeleting) return;
    setMutating(true);
    try {
      await api(`/files/${fileDeleting.id}`, { method: "DELETE" });
      setDetail((d) =>
        d
          ? { ...d, files: d.files.filter((f) => f.id !== fileDeleting.id) }
          : d,
      );
      setPending((p) => p.filter((f) => f.id !== fileDeleting.id));
      setFileDeleting(null);
      notify("文件已删除");
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setMutating(false);
    }
  }
  function navigate(v: View) {
    setView(v);
    setSidebar(false);
  }

  return {
    user,
    setUser,
    sessions,
    setSessions,
    detail,
    setDetail,
    settings,
    setSettings,
    view,
    setView,
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
    setRun,
    uploading,
    sending,
    loading,
    toast,
    setToast,
    notice,
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
  };
}
