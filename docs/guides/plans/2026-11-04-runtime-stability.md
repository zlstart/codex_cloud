# Runtime stability implementation plan

Goal: prevent generated artifacts from restarting the API, give complex tasks configurable execution headroom, repair HTML downloads, and validate a live three-body task from startup to delivery.

Architecture: keep SDK-native Runner, Docker sandbox, streaming and authentication. Restrict development reload to backend/app; carry configured limits through the service into the SDK runtime and sandbox. Keep downloads distinct from sandboxed inline previews.

- [x] Restrict development reload and verify both output-file exclusion and source-file reload.
- [x] Quote the tracing workflow name in .env.example and local .env; validate shell parsing without printing credentials.
- [x] Increase and expose finite runtime/provider/MCP/workspace/container limits; verify overrides reach enforcement.
- [x] Reproduce HTML download failure in Chromium, fix the responsible boundary, verify authorized downloads and isolation.
- [x] Run backend checks, frontend checks, Docker smoke, and live authenticated three-body browser task.
- [x] Capture startup logs, every model round and tool outcome, responsiveness, generated artifacts, downloads and simulation metrics.
- [x] Archive a separate report batch, review changes, and prepare the repair branch for a PR against main.

Review focus: generated Python files, large and many artifacts, long provider calls, inherited subagent limits, unauthenticated or cross-user downloads, cancellation cleanup, HTML sandboxing.

The user has authorized implementation and live deployment/testing in this environment. main starts at 4a0bcf5ddc562b821ccc0d84d23391c63745c50b. GitHub default-branch administration is currently denied by the integration (403).
