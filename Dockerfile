# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --strict-ssl=true
COPY frontend/ ./
RUN npm run build

FROM ghcr.io/astral-sh/uv:0.8.22 AS uv
FROM docker:28-cli AS docker-cli
FROM python:3.12-slim-bookworm AS application
WORKDIR /app
COPY --from=uv /uv /usr/local/bin/uv
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/app/.venv/bin:$PATH \
    UV_CACHE_DIR=/tmp/uv-cache \
    UV_LINK_MODE=copy \
    DATA_DIR=/data \
    PORT=8000
COPY --chown=1000:1000 pyproject.toml uv.lock ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    uv sync --frozen --no-dev
COPY --chown=1000:1000 backend/ ./backend/
COPY --from=frontend --chown=1000:1000 /build/frontend/dist ./frontend/dist
# Local workspaces can use a restrictive umask (0700 directories / 0600 files).
# Ship immutable code readable by the default user and by a Compose UID override.
RUN chmod -R a+rX /app/backend /app/frontend \
    && chmod a+r /app/pyproject.toml /app/uv.lock \
    && groupadd --gid 1000 famsun \
    && useradd --uid 1000 --gid 1000 --no-create-home famsun \
    && mkdir /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8000')+'/health', timeout=2)"
CMD ["sh", "-c", "exec uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 1"]
