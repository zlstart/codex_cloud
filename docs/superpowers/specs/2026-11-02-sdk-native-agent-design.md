# SDK-native FAMSUN agent refactor

## Intent and requirements

Refactor the existing application at base `3998b92`, retaining its account/session data and application contracts. The user requests a production-oriented general agent, prioritizing official Python Agents SDK implementations rather than maintaining duplicate harness code. Use Responses only. Add context compaction, subagents, editable Skills/MCP/subagents, per-user per-chat network-enabled sandbox workspaces, rich common-file previews and chronological collapsible execution activity separate from the final answer.

## Decisions

- Retain React 19 + TypeScript + Vite and FastAPI. Their existing separation and authenticated SSE transport fit this workspace application. Improve components and data contracts instead of introducing an unrelated framework migration.
- Retain application authentication, ownership checks, file registry, ordered durable RunEvent table and server-side approval decisions.
- Replace ordinary Agent and custom Python/shell/file/skill tools with SandboxAgent, Filesystem, Shell, Skills and native DockerSandboxClient. Keep update_plan because the SDK has no general plan-list tool.
- Native Docker options do not expose all resource limits, and root workspace grants prohibit overlap. Use a narrowly scoped Docker client creation-policy adapter for the trusted per-chat bind mount and resource/hardening settings; all command, patch, PTY, skills and lifecycle execution remains SDK-owned. Validate this on real Docker.
- Sandbox workspace persists on host under the existing user/chat directory; no other chat, SDK history or key is mounted. Network is enabled. Use a nonroot runtime user, limited resources and private temporary storage compatible with native executable helpers.
- Use SDK SQLiteSession at a trusted history path outside the workspace. Seed legacy text history once; thereafter persist complete SDK items and only append new input. Do not truncate arbitrary tool pairs.
- Use Sandbox Compaction as the single native semantic compaction mechanism with configurable threshold; additionally use ToolOutputTrimmer. No fallback to Chat Completions or disguised truncation. Unsupported provider capabilities must be reported clearly.
- Subagents use Agent.as_tool, independent model histories and the current conversation's sandbox. Admin-editable name/instructions/model/turn limit/skill IDs/MCP IDs; users enable or disable shared definitions. No recursive delegation by default.
- Extension definitions remain organization-wide/admin-editable; members can inspect and configure their enable preferences, preserving the existing authorization model.

## Alternatives considered

1. Keep custom harness and replace only model adapter: smaller diff, fails SDK reuse requirement.
2. SDK-native runtime with thin product integrations: selected because it removes duplicated execution behavior while retaining established account/file/UI functionality.
3. Hosted Agents API or complete new frontend/backend: conflicts with local execution scope or introduces unrelated migration risk.

## Event contract

Persist existing event names and ordered RunEvent.id, enriching payloads with item_id, call_id, agent_id/name and parent_call_id. text.delta includes item_id and delta; text.completed includes authoritative text; text.phase identifies final/intermediate membership. Tools pair strictly by call_id. Child messages are process activity. run.completed includes final_item_ids when available. JSON history endpoint replays the same events as SSE. Final Message.content remains authoritative for finished final answers and legacy history.

## Product UI

Preserve navy/orange FAMSUN identity. Chat shows interleaved assistant commentary and tool activity in order, with a collapsible execution section and an independently visible final answer. Maintain user-controlled scrolling, cancellation, approvals, reconnect and partial failed-run activity. File previews have consistent toolbar, loading/error/download states, tabs and bounded rendering. Support spreadsheets, PDF, Markdown, HTML, images, CSV/TSV, JSON/text/code and browser-supported audio/video. Capability center supports view/create/edit/delete with validation and clear role-based controls.

## Verification and operational boundary

Test ownership and cross-chat isolation, native tool execution and networking, resource policy, complete history persistence/compaction, Responses-only requests, ordered event replay, subagent attribution, CRUD persistence, malicious document rendering and bounded previews. Exercise desktop/mobile browser workflows and live provider calls if the configured endpoint supports required Responses features. Preserve honest limitations: multi-user is required; horizontal multi-worker execution is not assumed to exist merely because a database is shared. Document deployment topology and any remaining limitation.
