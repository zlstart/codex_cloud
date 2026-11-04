# Production acceptance plan

User goal: exercise real complex agent tasks, inspect every requested artifact format in the product, download and validate original files, keep screenshots and a task-by-task report, and repair defects discovered during testing.

Use the configured third-party Responses model and real per-conversation Docker execution. Use a disposable SQLite database and synthetic manufacturing inputs. Preserve the production defaults of 20 turns, 300-second run timeout, 512 MiB sandbox memory and single API worker for baseline runs. Do not upload the private expected-results oracle to the model.

- [x] Build and probe the actual sandbox; record missing dependencies/fonts before fixes and repeat probes afterwards.
- [x] Create the first administrator through the browser; retain authentication only in private temporary state.
- [x] Ask the model through the UI to generate an offline snake game; inspect original download, embedded preview, interaction, desktop/mobile layout and reload.
- [x] Upload CSV and a three-sheet workbook; ask the model to inspect quality, calculate consistent manufacturing/shipping KPIs and then create HTML/XLSX/DOCX/PDF/PPTX reports in a second turn.
- [x] Validate numerical results against an independent oracle; inspect Office structure, PDF pages/text/font rendering and consistency across all formats.
- [x] Click each product preview and download button in Chromium, save screenshots and downloaded bytes, verify filenames/signatures/size/SHA against authenticated API content.
- [x] Repair reproducible rendering/runtime defects; preserve before/after evidence and retest the same model-generated files.
- [x] Test another user's and unauthenticated access, actual cancellation and container cleanup, plus replay/reload persistence.
- [x] Run regression tests/build; create a self-contained illustrated HTML report, Markdown report and downloadable evidence bundle, with explicit pass/fail/limited results and production recommendations.

Report must distinguish application bugs, model-output defects, environment/setup issues and supported preview limitations. A completed agent run is not proof that an artifact is valid; an HTTP 200 is not proof that a browser downloaded or rendered it.

Final evidence: `docs/reports/2026-11-03/production-acceptance/production-acceptance-2026-11-03.html` with portable evidence ZIP. Regression:200 Python tests and23 frontend unit tests; actual output/download/permission/fullscreen evidence is kept separately from deterministic fixtures. OpenAI trace export remains unverified without a separate tracing credential.
