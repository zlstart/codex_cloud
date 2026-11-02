#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

command -v uv >/dev/null || { echo 'Install uv first: https://docs.astral.sh/uv/' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Node.js 22+ and npm are required.' >&2; exit 1; }
uv sync --frozen
if [[ ! -d frontend/node_modules ]]; then
  (cd frontend && npm ci)
fi

backend_pid=''
frontend_pid=''
cleanup() {
  trap - EXIT INT TERM
  [[ -z "$backend_pid" ]] || kill "$backend_pid" 2>/dev/null || true
  [[ -z "$frontend_pid" ]] || kill "$frontend_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo 'FAMSUN development: http://localhost:5173'
echo 'API: http://localhost:8000 · Ctrl+C stops both processes.'
env_option=()
[[ ! -f .env ]] || env_option=(--env-file .env)
uv run "${env_option[@]}" uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --reload &
backend_pid=$!
(cd frontend && exec npm run dev -- --host 127.0.0.1) &
frontend_pid=$!
wait -n "$backend_pid" "$frontend_pid"
