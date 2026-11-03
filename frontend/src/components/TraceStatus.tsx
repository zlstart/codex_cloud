import { ExternalLink, Activity } from "lucide-react";
import type { RunTracing } from "../types";
import "../styles/tracing.css";

export function TraceStatus({ tracing }: { tracing?: RunTracing }) {
  if (!tracing) return null;
  const enabled = tracing.status === "enabled";
  const traceId =
    enabled && /^trace_[a-zA-Z0-9]{32}$/.test(tracing.trace_id ?? "")
      ? tracing.trace_id
      : null;
  return (
    <div className="run-tracing" data-tracing-status={tracing.status}>
      <Activity size={14} aria-hidden="true" />
      {traceId ? (
        <a
          href={`https://platform.openai.com/traces/trace?trace_id=${traceId}`}
          target="_blank"
          rel="noopener noreferrer"
          title="使用有权限的 OpenAI 项目账号查看；追踪上传可能稍有延迟"
        >
          查看 OpenAI 追踪
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      ) : (
        <span>
          {tracing.status === "missing_key"
            ? "追踪未配置"
            : enabled
              ? "追踪已启用"
              : "追踪未启用"}
        </span>
      )}
      {enabled && (
        <span className="run-tracing-detail">
          正文采集：{tracing.sensitive_data ? "开启" : "关闭"}
        </span>
      )}
    </div>
  );
}
