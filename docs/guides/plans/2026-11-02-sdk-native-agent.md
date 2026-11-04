# SDK-native FAMSUN Agent Implementation Plan

> **For agentic workers:** Execute independent tasks with scoped file ownership; use the SDK-first convention and meaningful test-first verification.

**Goal:** Replace duplicate agent harness implementations with SDK-native components and deliver editable capabilities, rich previews and an ordered conversation experience.

**Architecture:** FastAPI owns authorization, product persistence and file delivery. The Python Agents SDK owns agent runs, sandbox tools, skills, model history, compaction and delegation. React consumes a single durable event contract for live and replay.

**Tech Stack:** Python 3.12, openai-agents 0.24.x, Docker, FastAPI/SQLAlchemy, React 19/TypeScript/Vite.

**Spec:** `docs/guides/specs/2026-11-02-sdk-native-agent-design.md`

## Global constraints

- Responses only; no Chat Completions fallback.
- Consult official SDK docs/source before each agent feature; record reuse/gaps.
- Per-user/chat isolated workspace, networking enabled, no host execution fallback, no credentials/history inside sandbox.
- Preserve data and authorization; stable event identities; final answer outside collapsed process.
- No secrets in traces, browser responses, commits or test artifacts.

## Review focus

- Cross-user file/history access, symlink escape and sandbox mounts.
- Same-name concurrent tool calls, replay duplicates and child/root text mixups.
- Legacy chat and extension migration without duplicating input or losing edits.
- Malicious/large document previews and keyboard/mobile behavior.
- Cancellation, unsupported provider compaction and cleanup after execution failure.

## Task 1: Native sandbox and skills integration

Own `backend/app/sdk_sandbox.py`, `backend/app/sandbox.py`, sandbox image/compose policy and sandbox tests. Expose a documented async context manager returning native SandboxSession plus a native Skills factory. Test isolated persistence, networking, limits, cancellation and native helper compatibility. Retain safe application file-access helpers; remove duplicate command runners once consumers migrate.

## Task 2: Native runtime, history, compression and subagents

Own `backend/app/runtime.py`, new runtime event/history helpers and runtime/protocol tests. Consume native sandbox helper. Preserve run_agent signature; add RuntimeConfig state_dir/session_id and compaction settings. Migrate old messages only once, use native Session thereafter; expose ordered tool/text/subagent events; keep final output independent. Implement native as_tool and selected enabled extensions. Test Responses request shape, history, compaction and event attribution.

## Task 3: Product API, configuration and migration

Root owns `backend/app/main.py`, `service.py`, `models.py`, `schemas.py`, `config.py`, `extensions.py`, `db.py`, API tests and dependency/lock files. Add typed extension editing/subagents, safe config migration, authenticated timeline and spreadsheet/document preview endpoints as needed. Pass history state outside workspace to runtime. Add immutable source-backed SDK audit. Verify admin/member permissions and restart persistence.

## Task 4: Unified chat timeline

Own frontend timeline types/reducer, useRunStream, ChatMessages, ExecutionHistory and App call-site. Share reducer between live SSE and paginated JSON replay; key by call/item identity. Retain legacy compatibility, approvals, plan, cancellation, partial failures and reader-controlled scrolling. Test replay/dedupe/out-of-order completion and final separation.

## Task 5: File preview workspace

Own Artifacts and new preview components/styles. Render XLSX/XLS/CSV/TSV, PDF, MD/HTML, images, text/code/JSON and audio/video as supported; bounded resources, safe HTML, visible failures and downloads. Coordinate any new API/dependencies with root. Verify actual files and mobile sizing.

## Task 6: Editable capability center and UI finishing

Own CapabilitiesView, capability editors, SettingsModal and scoped styles. View/edit skills, MCP and subagent configuration using new API; show admin authorization and per-user enabled state. Responses-only settings. Preserve FAMSUN design and responsive accessible interactions.

## Task 7: Integration, review and delivery

- Run Python suite/lint, TS check/build and focused browser regression.
- Exercise native Docker tools and real provider Responses capabilities separately.
- Review ownership, network boundary, persistent session semantics, replay order and unsafe previews.
- Record actual commands/results and unresolved environment/provider limitations. Deliver reviewable branch and verified screenshots; do not claim production readiness from unit tests alone.
