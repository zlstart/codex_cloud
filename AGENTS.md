# Project engineering conventions

- Before implementing or changing any agent capability, consult the current official **OpenAI Python Agents SDK** documentation and the installed SDK source. Record the chosen SDK primitive and source in `docs/guides/SDK-CAPABILITY-AUDIT.md`.
- Prefer SDK implementations for the runner, sandbox filesystem/shell, Skills, MCP, sessions, compaction, delegation, approvals, streaming and usage. Write application code only for product-specific responsibilities or documented SDK gaps.
- Use the **Responses API only**. Do not add Chat Completions compatibility or silently fall back to it.
- Authorize every conversation, file, run, event stream and approval against the authenticated user. Model-visible workspaces must never contain API credentials or conversation/session databases.
- Run model commands only in a Docker sandbox scoped to the conversation. Networking is enabled by default; resource and filesystem boundaries remain enforced. Never silently fall back to host execution.
- Persist ordered execution events with stable item/call IDs. Live streaming and history replay must use the same frontend reducer. Intermediate text/tools remain ordered and collapsible; final answers remain independently visible.
- Verify behavior with meaningful API/runtime tests and actual browser workflows. Do not describe mocked model responses as live provider validation.
- Keep explanatory documents, designs, and plans under `docs/guides/`. Archive reviewed test reports under `docs/reports/YYYY-MM-DD/<batch>/` with a README and update the report index; use separate batches for tests on the same date. Keep transient test outputs in `test-results/` and never overwrite historical screenshots during routine tests. Do not archive credentials or authentication state.
