# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib \
    HOME=/tmp
COPY requirements.txt /tmp/requirements.txt
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi; \
    pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt
# Native SDK shell/path/PTY tools use standard Unix commands. Include rg for
# file discovery, procps for timeout cleanup and curl for network-enabled work.
# Node validates and executes generated JavaScript without a package manager.
# WenQuanYi provides TrueType CJK outlines that ReportLab can embed in PDFs;
# Noto CJK remains available for charts and other font consumers.
RUN apt-get update && apt-get install -y --no-install-recommends \
        fonts-noto-cjk fonts-wqy-zenhei nodejs ripgrep procps curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* /tmp/requirements.txt \
    && groupadd --gid 1000 sandbox \
    && useradd --uid 1000 --gid 1000 --no-create-home sandbox \
    && mkdir /workspace && chown sandbox:sandbox /workspace
WORKDIR /workspace
USER 1000:1000
CMD ["python"]
