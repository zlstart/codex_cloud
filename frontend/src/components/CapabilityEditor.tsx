import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Bot,
  Check,
  Code2,
  Eye,
  LoaderCircle,
  Pencil,
  Plug,
  ShieldCheck,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Extension } from "../types";
import { api, errorMessage } from "../lib/api";
import { Modal } from "./Modal";

export type CapabilityKind = "skill" | "mcp" | "subagent";
export interface CapabilityData {
  skills: Extension[];
  mcp_servers: Extension[];
  subagents: Extension[];
}
export const capabilityKinds = {
  skill: {
    label: "技能",
    singular: "技能",
    add: "添加技能",
    empty: "把专业经验，变成助手的技能",
    description: "把工作方法与任务规范写成技能，助手会在需要时读取并使用。",
    endpoint: "skills",
  },
  mcp: {
    label: "MCP 连接",
    singular: "连接",
    add: "连接 MCP",
    empty: "连接工具，延伸助手的能力",
    description: "接入团队的业务系统与数据服务，在对话中完成更多工作。",
    endpoint: "mcp",
  },
  subagent: {
    label: "子代理",
    singular: "子代理",
    add: "添加子代理",
    empty: "让专业任务，有专属的协作者",
    description: "为独立任务指定专业助手，完成后将结果交回主助手继续处理。",
    endpoint: "subagents",
  },
} as const;

export function CapabilityEditor({
  kind,
  item,
  readOnly = false,
  canEdit,
  data,
  onClose,
  onSaved,
}: {
  kind: CapabilityKind;
  item?: Extension;
  readOnly?: boolean;
  canEdit: boolean;
  data: CapabilityData;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [viewOnly, setViewOnly] = useState(readOnly || !canEdit);
  const [preview, setPreview] = useState(false);
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [content, setContent] = useState(item?.content ?? "");
  const [url, setUrl] = useState(item?.url ?? "");
  const [tokenEnv, setTokenEnv] = useState(item?.token_env ?? "");
  const [instructions, setInstructions] = useState(
    item?.config?.instructions ?? "",
  );
  const [model, setModel] = useState(item?.config?.model ?? "");
  const [maxTurns, setMaxTurns] = useState<number | "">(
    item?.config?.max_turns ?? "",
  );
  const [skillIds, setSkillIds] = useState(item?.config?.skill_ids ?? []);
  const [mcpIds, setMcpIds] = useState(item?.config?.mcp_server_ids ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const info = capabilityKinds[kind];
  const Icon = kind === "skill" ? BookOpen : kind === "mcp" ? Plug : Bot;
  const locked = saving || viewOnly;
  const text = kind === "skill" ? content : instructions;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (viewOnly || saving || !canEdit) return;
    setSaving(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    const common = { name: name.trim(), description: description.trim() };
    const payload =
      kind === "skill"
        ? { ...common, content }
        : kind === "mcp"
          ? { ...common, url: url.trim(), token_env: tokenEnv.trim() || null }
          : {
              ...common,
              instructions,
              model: model.trim() || null,
              max_turns: maxTurns === "" ? null : maxTurns,
              skill_ids: skillIds,
              mcp_server_ids: mcpIds,
            };
    try {
      await api(`/extensions/${info.endpoint}${item ? `/${item.id}` : ""}`, {
        method: item ? "PATCH" : "POST",
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      if (!abort.signal.aborted) onSaved(name.trim());
    } catch (e) {
      if (!abort.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!abort.signal.aborted) setSaving(false);
    }
  }

  return (
    <Modal
      title={
        viewOnly
          ? (item?.name ?? info.singular)
          : `${item ? "编辑" : "添加"}${info.singular}`
      }
      description={viewOnly ? description : "保存后的配置将用于新的执行任务。"}
      onClose={() => {
        if (!saving) onClose();
      }}
      className="extension-editor-modal capability-editor"
    >
      <form onSubmit={submit}>
        <div className="capability-editor-heading">
          <span>
            <Icon size={16} />
            {info.label}
            {item?.builtin && <b>团队内置</b>}
          </span>
          {item && (
            <span className={`admin-status ${item.enabled ? "is-ready" : ""}`}>
              <i />
              {item.enabled ? "已启用" : "未启用"}
            </span>
          )}
        </div>
        {!viewOnly && (
          <>
            <label className="admin-field">
              {kind === "skill"
                ? "技能名称"
                : kind === "mcp"
                  ? "连接名称"
                  : "子代理名称"}
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  kind === "subagent"
                    ? "例如：数据分析师"
                    : kind === "skill"
                      ? "例如：生产数据分析"
                      : "例如：企业知识库"
                }
                required
                maxLength={100}
                disabled={locked}
              />
            </label>
            <label className="admin-field">
              用途描述
              <input
                className="input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="描述适用场景，帮助助手选择合适的能力"
                maxLength={1000}
                disabled={locked}
                required={kind !== "mcp"}
              />
            </label>
          </>
        )}
        {kind === "mcp" ? (
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
                maxLength={2048}
                readOnly={viewOnly}
                disabled={saving}
              />
            </label>
            <label className="admin-field">
              访问令牌环境变量（可选）
              <input
                className="input"
                value={tokenEnv}
                onChange={(e) => setTokenEnv(e.target.value)}
                placeholder="MCP_ERP_TOKEN"
                pattern="^MCP_[A-Z0-9_]+_TOKEN$"
                maxLength={100}
                title="使用 MCP_ 开头、_TOKEN 结尾的大写环境变量名称"
                autoComplete="off"
                spellCheck={false}
                readOnly={viewOnly}
                disabled={saving}
              />
              <span className="admin-field-help">
                只保存服务器环境变量名称，访问令牌不会显示或保存在浏览器中。
              </span>
            </label>
            <div className="admin-note">
              <Code2 size={18} />
              <div>
                <strong>Streamable HTTP 连接</strong>
                <p>
                  使用已加入服务器允许列表的 HTTPS
                  服务。工具调用会展示参数，并等待你的确认。
                </p>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="capability-content-toolbar">
              <label htmlFor="capability-content">
                {kind === "skill" ? "技能内容" : "任务指引"}
              </label>
              <div className="capability-view-toggle" aria-label="内容显示方式">
                <button
                  type="button"
                  className={!preview ? "selected" : ""}
                  aria-pressed={!preview}
                  onClick={() => setPreview(false)}
                >
                  <Code2 size={13} />
                  源码
                </button>
                <button
                  type="button"
                  className={preview ? "selected" : ""}
                  aria-pressed={preview}
                  onClick={() => setPreview(true)}
                >
                  <Eye size={13} />
                  预览
                </button>
              </div>
            </div>
            {preview ? (
              <div className="capability-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  components={{
                    img: ({ alt }) => (
                      <span className="admin-muted">
                        [图片：{alt || "未命名"}]
                      </span>
                    ),
                    a: ({ children }) => (
                      <span className="capability-preview-link">
                        {children}
                      </span>
                    ),
                  }}
                >
                  {text || "尚未填写内容。"}
                </ReactMarkdown>
              </div>
            ) : (
              <textarea
                id="capability-content"
                className="input extension-content-input"
                value={text}
                onChange={(e) =>
                  kind === "skill"
                    ? setContent(e.target.value)
                    : setInstructions(e.target.value)
                }
                placeholder={
                  kind === "skill"
                    ? "# 工作目标\n描述任务与工作方法。\n\n## 执行步骤\n1. 读取输入资料\n2. 分析与验证\n3. 生成交付文件"
                    : "说明这个子代理擅长的任务、工作步骤，以及需要交回主助手的结果。"
                }
                required
                maxLength={100000}
                rows={viewOnly ? 12 : 9}
                readOnly={viewOnly}
                disabled={saving}
                aria-label={kind === "skill" ? "技能内容" : "任务指引"}
              />
            )}
            {!viewOnly && (
              <p className="capability-input-caption">
                支持 Markdown · {text.length.toLocaleString()} / 100,000 字符
              </p>
            )}
          </>
        )}
        {kind === "subagent" && (
          <>
            <div className="admin-field-row capability-agent-settings">
              <label className="admin-field">
                使用模型
                <input
                  className="input"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="留空以跟随主助手"
                  maxLength={200}
                  readOnly={viewOnly}
                  disabled={saving}
                />
              </label>
              <label className="admin-field">
                最大执行轮数
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={10000}
                  step={1}
                  value={maxTurns}
                  placeholder="留空以跟随主助手"
                  onChange={(e) =>
                    setMaxTurns(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  readOnly={viewOnly}
                  disabled={saving}
                />
              </label>
            </div>
            <CapabilitySelection
              title="可用技能"
              items={data.skills}
              selected={skillIds}
              setSelected={setSkillIds}
              disabled={locked}
            />
            <CapabilitySelection
              title="可用 MCP 连接"
              items={data.mcp_servers}
              selected={mcpIds}
              setSelected={setMcpIds}
              disabled={locked}
            />
            <div className="admin-note">
              <Bot size={18} />
              <div>
                <strong>独立完成任务，交回结果</strong>
                <p>
                  子代理使用当前会话的工作区。只有选中且对当前用户已启用的技能和连接可以使用；不再继续委派其他子代理。
                </p>
              </div>
            </div>
          </>
        )}
        {!canEdit && (
          <p className="admin-muted">
            <ShieldCheck size={14} />
            团队能力由管理员维护，你可以调整自己的启用偏好。
          </p>
        )}
        {error && (
          <div className="admin-error" role="alert">
            {error}
          </div>
        )}
        <div className="admin-modal-footer">
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={onClose}
          >
            {viewOnly ? "关闭" : "取消"}
          </button>
          {viewOnly ? (
            canEdit && (
              <button
                type="button"
                className="button primary"
                onClick={(event) => {
                  event.preventDefault();
                  setViewOnly(false);
                }}
              >
                <Pencil size={15} />
                编辑配置
              </button>
            )
          ) : (
            <button
              type="submit"
              className="button primary"
              disabled={
                saving || !name.trim() || (kind !== "mcp" && !text.trim())
              }
            >
              {saving ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Check size={16} />
              )}
              {saving ? "保存中…" : "保存配置"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function CapabilitySelection({
  title,
  items,
  selected,
  setSelected,
  disabled,
}: {
  title: string;
  items: Extension[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  disabled: boolean;
}) {
  const missing = selected.filter(
    (id) => !items.some((item) => item.id === id),
  );
  return (
    <fieldset className="capability-selection" disabled={disabled}>
      <legend>
        {title}
        <span>{selected.length} 项已选择</span>
      </legend>
      {items.length === 0 && !missing.length ? (
        <p className="admin-muted">暂无可用能力，可先在能力中心添加。</p>
      ) : (
        <div className="capability-selection-list">
          {items.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, item.id]
                      : selected.filter((id) => id !== item.id),
                  )
                }
              />
              <span>
                {item.name}
                <small>{item.enabled ? "已启用" : "你尚未启用"}</small>
              </span>
            </label>
          ))}
          {missing.map((id) => (
            <label key={id}>
              <input
                type="checkbox"
                checked
                onChange={() => setSelected(selected.filter((x) => x !== id))}
              />
              <span>
                已移除的能力<small>{id} · 取消勾选以清理引用</small>
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
