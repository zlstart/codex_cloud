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
    api_mode: "responses" | "chat_completions";
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
  type: "skill" | "mcp";
  enabled: boolean;
  status?: string;
  content?: string;
  url?: string;
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
