import { useEffect, useState } from "react";
import {
  Check,
  CircleHelp,
  Cpu,
  KeyRound,
  LoaderCircle,
  Server,
  ShieldCheck,
} from "lucide-react";
import type { Settings, User } from "../types";
import { api } from "../lib/api";
import { Modal } from "./Modal";
import "../styles/admin.css";

interface Props {
  user: User | null;
  settings: Settings | null;
  onClose: () => void;
  onSave: (settings: Settings) => void;
  onAuth: () => void;
}

export function SettingsModal({
  user,
  settings,
  onClose,
  onSave,
  onAuth,
}: Props) {
  const [data, setData] = useState(settings);
  const [baseUrl, setBaseUrl] = useState(settings?.provider.base_url ?? "");
  const [model, setModel] = useState(settings?.provider.model ?? "");
  const [mode, setMode] = useState<"responses" | "chat_completions">(
    settings?.provider.api_mode ?? "chat_completions",
  );
  const [loading, setLoading] = useState(!!user && !settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const isAdmin = user?.role === "admin";

  useEffect(() => {
    if (!user || settings) return;
    let live = true;
    api<Settings>("/settings")
      .then((next) => {
        if (!live) return;
        setData(next);
        setBaseUrl(next.provider.base_url);
        setModel(next.provider.model);
        setMode(next.provider.api_mode);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [user, settings]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const next = await api<Settings>("/settings", {
        method: "PATCH",
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          model: model.trim(),
          api_mode: mode,
        }),
      });
      setData(next);
      onSave(next);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="工作台设置"
      description="连接适合你团队的模型，掌握每一次执行。"
      onClose={onClose}
      className="settings-modal"
    >
      {!user ? (
        <div className="admin-login-state">
          <ShieldCheck size={34} />
          <h3>登录后管理你的工作台</h3>
          <p>模型配置、执行环境与能力偏好将在这里呈现。</p>
          <button className="button primary" onClick={onAuth}>
            登录工作台
          </button>
        </div>
      ) : loading ? (
        <div className="admin-loading">
          <LoaderCircle className="spin" size={22} />
          正在读取配置
        </div>
      ) : (
        <form onSubmit={save}>
          <section className="admin-settings-section">
            <div className="admin-section-title">
              <Cpu size={18} />
              <h3>模型连接</h3>
              <span
                className={`admin-status ${data?.provider.configured ? "is-ready" : ""}`}
              >
                <i />
                {data?.provider.configured ? "密钥已配置" : "等待配置密钥"}
              </span>
            </div>
            <p className="admin-section-description">
              支持 OpenAI 与兼容 OpenAI 协议的模型服务。
            </p>
            <label className="admin-field">
              API 地址
              <input
                className="input"
                type="url"
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setSaved(false);
                }}
                placeholder="https://api.example.com/v1"
                required
                disabled={!isAdmin || saving}
                autoComplete="off"
              />
            </label>
            <p className="admin-section-description">
              填写 API 根地址（通常以 /v1 结尾），不要附加 /responses 或
              /chat/completions；请求路径由所选 API 模式自动添加。
            </p>
            <div className="admin-field-row">
              <label className="admin-field">
                模型名称
                <input
                  className="input"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setSaved(false);
                  }}
                  placeholder="服务商提供的模型 ID"
                  required
                  maxLength={200}
                  disabled={!isAdmin || saving}
                />
              </label>
              <label className="admin-field">
                接口协议
                <select
                  className="input"
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value as typeof mode);
                    setSaved(false);
                  }}
                  disabled={!isAdmin || saving}
                >
                  <option value="chat_completions">Chat Completions</option>
                  <option value="responses">Responses API</option>
                </select>
              </label>
            </div>
            <div className="admin-note">
              <KeyRound size={17} />
              <div>
                <strong>密钥由服务器安全管理</strong>
                <p>
                  请在服务器环境变量中配置 AGENT_API_KEY 或
                  OPENAI_API_KEY。密钥不会发送到浏览器。
                </p>
              </div>
            </div>
            {!isAdmin && (
              <p className="admin-muted">
                <CircleHelp size={14} />
                只有管理员可以修改团队的模型连接。
              </p>
            )}
          </section>
          <section className="admin-settings-section environment-section">
            <div className="admin-section-title">
              <Server size={18} />
              <h3>执行环境</h3>
            </div>
            <div className="admin-setting-row">
              <div>
                <strong>会话独立环境</strong>
                <p>每个会话拥有专属文件目录与执行空间</p>
              </div>
              <span
                className={`admin-status ${data?.sandbox.available ? "is-ready" : ""}`}
              >
                <i />
                {data?.sandbox.available ? "可用" : "未就绪"}
              </span>
            </div>
            <div className="admin-setting-meta">
              <span>
                运行后端{" "}
                <b>
                  {data?.sandbox.backend === "docker"
                    ? "Docker 容器"
                    : (data?.sandbox.backend ?? "—")}
                </b>
              </span>
              <span>
                单文件上限 <b>{data?.limits.max_upload_mb ?? "—"} MB</b>
              </span>
              <span>
                工具调用轮数 <b>{data?.limits.max_turns ?? "—"}</b>
              </span>
            </div>
          </section>
          {error && (
            <div className="admin-error" role="alert">
              {error}
            </div>
          )}
          <div className="admin-modal-footer">
            <span className="admin-save-state" aria-live="polite">
              {saved && (
                <>
                  <Check size={16} />
                  设置已保存
                </>
              )}
            </span>
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              关闭
            </button>
            {isAdmin && (
              <button
                type="submit"
                className="button primary"
                disabled={saving || !baseUrl.trim() || !model.trim()}
              >
                {saving ? <LoaderCircle size={16} className="spin" /> : null}
                {saving ? "保存中" : "保存设置"}
              </button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
