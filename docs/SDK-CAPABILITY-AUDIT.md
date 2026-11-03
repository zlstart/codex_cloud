# Python Agents SDK reuse audit (0.24.0)

Audit completed against SDK **0.24.0**, starting from commit `3998b92`. Official docs and installed source were checked before implementing agent capabilities. Dependencies are locked; upgrades must repeat native sandbox/protocol checks. Actual validation is recorded in [the SDK verification report](VERIFICATION-SDK-2026-11-02.md).

| Area | Existing implementation | Selected SDK primitive / application boundary |
|---|---|---|
| Model loop | Runner plus bespoke tool wrappers | Runner + SandboxAgent, OpenAIResponsesModel only |
| Shell/Python | Custom Docker command runner | Shell capability: exec_command/write_stdin; Python through native shell |
| File manipulation/images | Custom read/write/image functions | Filesystem capability: apply_patch/view_image; native shell for reading/search |
| Docker isolation | Custom per-command container | DockerSandboxClient lifecycle with narrow trusted creation-policy adapter for missing resource options/root bind |
| Skills | Custom catalog/list_skills/load_skill | Skills with native Skill entries, catalog and on-demand reads of SDK-materialized files; removed custom loaders |
| MCP | MCPServerStreamableHttp | Retain SDK transport and native approval; application owns allowed endpoints/secrets/CRUD |
| Conversation | Reconstructed text-only bounded_history | SQLiteSession outside model workspace; full item persistence and one-time legacy seed |
| Context | Character truncation | Native Compaction + ToolOutputTrimmer; provider compatibility explicit |
| Delegation | Missing | Agent.as_tool + nested streaming; independently configured specialists |
| Plan/Todo | update_plan | Keep small product-specific function; no general SDK todo tool found |
| Approvals | SDK interruptions + app records | Retain SDK RunState flow, application authorizes each decision |
| Streaming | Concatenated text + separate tools | SDK events mapped to ordered durable product events with call/item identities |
| Files/UI/auth | Application-specific | Keep authorization, preview delivery, rendering and capability editors in application |

Implementation and verification notes:

- The empty-installation model default is aligned with SDK 0.24: `gpt-5.6-luna`. Existing administrator/environment model choices retain precedence.

- Native `Filesystem`, `Shell`, `Skills`, `DockerSandboxClient` exercised in real Docker. Python execution now uses native `exec_command`; no custom tool loop or host-execution fallback remains.
- Docker SDK options omit root bind/resource controls. `PolicyContainers.create` adds trusted per-chat mount, read-only uploads/root, nonroot UID/GID, resource limits and executable `/tmp`; the SDK owns exec/PTY/patch/image/lifecycle. Network access is enabled and verified with HTTPS. Application quota monitoring remains necessary.
- SDK 0.24 Docker async lifecycle methods contain synchronous docker-py I/O. `runtime_worker` owns the entire native run in a dedicated worker event loop so slow daemon calls do not block other users' API/SSE requests. Events and approval callbacks bridge to the API loop; cancellation joins native cleanup and thread shutdown. SDK session locks remain on one loop.
- `SQLiteSession` owns complete model history. Each chat has a separate database under `DATA_DIR/history`, outside the sandbox. Existing UI transcripts seed an empty SDK history only once.
- Sandbox `Compaction` and local `ToolOutputTrimmer` are separate operations. The trimmer shortens old tool output; it is not semantic summarization. SDK compaction request/returned-item handling and shortened subsequent context pass protocol tests. Current DashScope `glm-5.3` accepted parameters but returned no compaction item in two live probes; do not claim live compaction support for that provider.
- The alternate `OpenAIResponsesCompactionSession` uses `/responses/compact` and SDK 0.24.0 restricts accepted model names; it is not a transparent fallback for arbitrary third-party Responses models. No silent fallback is installed.
- Subagents use `Agent.as_tool`, separate model histories and selected Skills/MCP, sharing only the authorized chat sandbox. Same-agent concurrent reuse is rejected by SDK; `ToolExecutionConfig(max_function_tool_concurrency=1)` serializes shared-workspace calls. Native child custom patch/exec and artifact delivery passed a live provider run.
- Native SDK interruptions/`RunState` handle MCP approval and resumption, including nested child approval. Product records enforce user ownership; regression checks ensure one execution and no duplicate input on resume.
- `RawResponsesStreamEvent`, `RunItemStreamEvent`, `ResponseOutputMessage` and nested `AgentToolStreamEvent` map to one durable timeline with scoped item/call IDs. Raw+run-item duplicates are reconciled; reasoning/encrypted compaction payloads are not exposed in browser events. Live/replay share one frontend reducer.
- `update_plan` is the remaining product-specific agent tool. Auth, capability CRUD, secure artifact delivery, Office parsing and frontend rendering have no corresponding general SDK product implementation.

Official sources:

- https://openai.github.io/openai-agents-python/sandbox/guide/
- https://openai.github.io/openai-agents-python/models/
- https://openai.github.io/openai-agents-python/sandbox/clients/
- https://openai.github.io/openai-agents-python/ref/sandbox/capabilities/skills/
- https://openai.github.io/openai-agents-python/sessions/
- https://openai.github.io/openai-agents-python/ref/extensions/tool_output_trimmer/
- https://openai.github.io/openai-agents-python/tools/
- https://openai.github.io/openai-agents-python/mcp/
- https://openai.github.io/openai-agents-python/human_in_the_loop/
- https://openai.github.io/openai-agents-python/streaming/
- https://github.com/openai/openai-agents-python/tree/v0.24.0/src/agents/sandbox
- https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/agent.py
- https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/stream_events.py
- https://github.com/openai/openai-agents-python/blob/v0.24.0/src/agents/items.py
- https://developers.openai.com/api/docs/guides/compaction
