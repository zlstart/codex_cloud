#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
uv run ruff check backend tests
uv run pytest -q
(cd frontend && npm run typecheck && npm run build)
