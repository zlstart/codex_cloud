import { useEffect, useState } from "react";
import { ArrowRight, LoaderCircle, LockKeyhole } from "lucide-react";
import { Modal } from "./Modal";
import { api, errorMessage } from "../lib/api";
import type { User } from "../types";
export function AuthModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (user: User) => void;
}) {
  const [register, setRegister] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [first, setFirst] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ has_users: boolean; registration_enabled: boolean }>("/auth/status")
      .then((s) => {
        setAllowed(!s.has_users || s.registration_enabled);
        if (!s.has_users) {
          setFirst(true);
          setRegister(true);
        }
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await api<User>(
        register ? "/auth/register" : "/auth/login",
        {
          method: "POST",
          body: JSON.stringify(
            register ? { email, password, name } : { email, password },
          ),
        },
      );
      onSuccess(user);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        first
          ? "开启丰尚智能工作台"
          : register
            ? "创建你的账号"
            : "欢迎回到丰尚"
      }
      description={
        first
          ? "创建首个管理员账号，开始配置你的智能工作空间。"
          : "你的对话、资料与成果，始终归属于你。"
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      className="auth-modal"
    >
      <div className="auth-emblem">
        <LockKeyhole size={28} />
      </div>
      <form onSubmit={submit} className="stack-form">
        {register && (
          <label className="field">
            姓名
            <input
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              placeholder="怎么称呼你"
            />
          </label>
        )}
        <label className="field">
          邮箱
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={254}
            placeholder="name@famsun.com"
          />
        </label>
        <label className="field">
          密码
          <input
            type="password"
            autoComplete={register ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={register ? 10 : 1}
            maxLength={128}
            placeholder={register ? "至少 10 位字符" : "输入你的密码"}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary auth-submit"
          disabled={busy}
          type="submit"
        >
          {busy ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <>
              {register ? "创建账号并进入" : "登录工作台"}
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>
      {allowed && !first && (
        <p className="auth-switch">
          {register ? "已有账号？" : "还没有账号？"}
          <button
            className="text-button"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register ? "立即登录" : "创建账号"}
          </button>
        </p>
      )}
      <p className="auth-note">安全登录 · 独立会话 · 专属文件空间</p>
    </Modal>
  );
}
