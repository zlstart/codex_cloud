export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}
export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  model: string;
  pinned: boolean;
}
export interface Artifact {
  id: string;
  session_id: string;
  name: string;
  mime_type: string;
  size: number;
  kind: "upload" | "output";
  created_at: string;
  url: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  run_id?: string;
  attachments?: Artifact[];
}
export interface Run {
  id: string;
  session_id: string;
  status:
    | "queued"
    | "running"
    | "awaiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
  error?: string;
  created_at: string;
  updated_at: string;
}
export interface SessionDetail {
  session: Session;
  messages: Message[];
  files: Artifact[];
  runs: Run[];
}
export interface Settings {
  provider: {
    base_url: string;
    model: string;
    api_mode: "responses";
    compaction_threshold?: number;
    configured: boolean;
  };
  sandbox: { backend: string; available: boolean };
  limits: { max_upload_mb: number; max_turns: number };
  registration_enabled: boolean;
}
export interface Extension {
  id: string;
  name: string;
  description: string;
  type: "skill" | "mcp" | "subagent";
  enabled: boolean;
  status?: string;
  content?: string;
  url?: string;
  token_env?: string | null;
  builtin?: boolean;
  editable?: boolean;
  config?: {
    instructions: string;
    model?: string | null;
    max_turns: number;
    skill_ids: string[];
    mcp_server_ids: string[];
  };
}
export interface ToolEvent {
  id: string;
  name: string;
  arguments: unknown;
  output?: unknown;
  status: "running" | "completed";
}
export interface Approval {
  id: string;
  tool: string;
  arguments: unknown;
}
export type View = "chat" | "files" | "capabilities";

export interface RunEvent {
  sequence: number;
  run_id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}
export interface TimelinePage {
  events: RunEvent[];
  next_cursor: number;
  has_more: boolean;
  status: Run["status"];
}
interface TimelineIdentity {
  id: string;
  sequence: number;
  agent_id?: string;
  agent_name?: string;
  parent_call_id?: string;
}
export interface TextTimelineItem extends TimelineIdentity {
  kind: "text";
  text: string;
  phase: "pending" | "intermediate" | "final";
}
export interface ToolTimelineItem extends TimelineIdentity {
  kind: "tool";
  call_id?: string;
  name: string;
  arguments: unknown;
  output?: unknown;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
}
export interface PlanTimelineItem extends TimelineIdentity {
  kind: "plan";
  steps: string[];
  current_step: number;
  completed: boolean;
}
export interface NoticeTimelineItem extends TimelineIdentity {
  kind: "notice";
  text: string;
}
export interface ContextTimelineItem extends TimelineIdentity {
  kind: "context";
  response_id?: string;
  status: "compacted" | "threshold_exceeded" | "not_observed";
  input_tokens: number | null;
  threshold: number;
  compaction_count: number;
}
export type TimelineItem =
  | TextTimelineItem
  | ToolTimelineItem
  | PlanTimelineItem
  | NoticeTimelineItem
  | ContextTimelineItem;
export interface TimelineState {
  items: TimelineItem[];
  seen: ReadonlySet<number>;
  cursor: number;
  status: Run["status"];
  error?: string;
  approval: Approval | null;
  tracing?: RunTracing;
}

export interface RunTracing {
  provider: "openai";
  status: "enabled" | "disabled" | "missing_key";
  trace_id: string | null;
  workflow_name: string;
  sensitive_data: boolean;
}
