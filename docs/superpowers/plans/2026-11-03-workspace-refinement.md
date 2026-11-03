# Workspace refinement implementation plan

**Goal:** Support SQLite only, add uploaded-file filtering, integrate native OpenAI Traces, and make tool/file/code displays readable and consistent.

**Architecture:** Keep FastAPI, SQLAlchemy, React and the existing Agents SDK 0.24 Responses runner. Share one highlighted code component between Markdown, file previews and tool details. Carry trace metadata through the same authorized, durable event stream used for live runs and history.

**Confirmed requirements:** SQLite is the only database. The workspace needs an “已上传” filter. The user selected OpenAI Traces; third-party model configuration remains separate.

**Implementation decisions:** Keep existing SQLite databases and additive migrations. Trace input/output capture is opt-in. Use highlight.js with explicit languages and safe plaintext fallback. Existing UI styling and artifact authorization remain in place.

- [x] SQLite: remove PostgreSQL runtime/deployment dependencies, reject unsupported URLs without disclosing credentials, verify migrations, persistence and concurrent writes.
- [x] Workspace and previews: add accessible uploaded/output/all filters with counts and distinct empty states; correct code/text MIME routing and preview overflow; test desktop/mobile upload and preview workflows.
- [x] Code/tool rendering: share language-aware highlighting, copy controls and bounded scroll; render shell/diff/JSON/text appropriately and expose failed-tool errors without losing chronology or replay.
- [x] Tracing: use SDK primitives for trace identity, conversation grouping and run/user metadata, isolate model and tracing credentials, honor disable settings, close traces on cleanup, retain native background export/process-exit flushing, and test with an in-memory SDK processor.
- [x] Frontend trace access: replay safe trace metadata, expose OpenAI trace links inside execution history, and keep disabled/missing-key states truthful.
- [x] Integration: run Python tests/lint, frontend typecheck/build and browser regressions; inspect screenshots and record exact checks and external verification limits.

Review focus: existing SQLite data; overlapping runs and approval resume; trace export failure; untrusted code/URLs; unsupported and large files; long tool outputs and narrow screens.
