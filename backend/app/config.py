from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .db import sqlite_url


def flag(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).lower() in {"1", "true", "yes"}


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("DATA_DIR", "./data")).resolve())
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", ""))
    api_key: str = field(
        default_factory=lambda: os.getenv("AGENT_API_KEY") or os.getenv("OPENAI_API_KEY", "")
    )
    base_url: str = field(
        default_factory=lambda: os.getenv(
            "AGENT_BASE_URL", os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
        )
    )
    model: str = field(default_factory=lambda: os.getenv("AGENT_MODEL", "gpt-5.6-luna"))
    api_mode: str = "responses"
    tracing_enabled: bool = field(default_factory=lambda: flag("AGENT_TRACING_ENABLED"))
    tracing_api_key: str = field(
        default_factory=lambda: os.getenv("OPENAI_TRACING_API_KEY") or os.getenv("OPENAI_API_KEY", ""),
        repr=False,
    )
    tracing_workflow_name: str = field(
        default_factory=lambda: os.getenv("AGENT_TRACING_WORKFLOW_NAME", "FAMSUN conversation")
    )
    tracing_include_sensitive_data: bool = field(
        default_factory=lambda: flag("AGENT_TRACING_INCLUDE_SENSITIVE_DATA")
    )
    compaction_threshold: int = field(
        default_factory=lambda: int(os.getenv("AGENT_COMPACTION_THRESHOLD", "32000"))
    )
    sandbox_backend: str = field(default_factory=lambda: os.getenv("SANDBOX_BACKEND", "docker"))
    registration_enabled: bool = field(default_factory=lambda: flag("ALLOW_REGISTRATION"))
    cookie_secure: bool = field(default_factory=lambda: flag("COOKIE_SECURE"))
    session_days: int = 7
    max_upload_mb: int = field(default_factory=lambda: int(os.getenv("MAX_UPLOAD_MB", "100")))
    max_session_mb: int = field(default_factory=lambda: int(os.getenv("MAX_SESSION_MB", "2048")))
    max_workspace_entries: int = field(
        default_factory=lambda: int(os.getenv("MAX_WORKSPACE_ENTRIES", "10000"))
    )
    max_turns: int = field(default_factory=lambda: int(os.getenv("AGENT_MAX_TURNS", "200")))
    max_runtime_seconds: int = field(default_factory=lambda: int(os.getenv("AGENT_TIMEOUT_SECONDS", "7200")))
    model_timeout_seconds: int = field(
        default_factory=lambda: int(os.getenv("AGENT_MODEL_TIMEOUT_SECONDS", "300"))
    )
    mcp_timeout_seconds: int = field(default_factory=lambda: int(os.getenv("MCP_TIMEOUT_SECONDS", "120")))
    mcp_session_timeout_seconds: int = field(
        default_factory=lambda: int(os.getenv("MCP_SESSION_TIMEOUT_SECONDS", "300"))
    )
    mcp_max_list_pages: int = field(default_factory=lambda: int(os.getenv("MCP_MAX_LIST_PAGES", "100")))
    max_plan_steps: int = field(default_factory=lambda: int(os.getenv("AGENT_MAX_PLAN_STEPS", "50")))
    allowed_origins: list[str] = field(
        default_factory=lambda: [
            x.strip().rstrip("/")
            for x in os.getenv(
                "ALLOWED_ORIGINS",
                "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000",
            ).split(",")
            if x.strip()
        ]
    )
    allowed_mcp_hosts: list[str] = field(
        default_factory=lambda: [
            x.strip().lower() for x in os.getenv("ALLOWED_MCP_HOSTS", "").split(",") if x.strip()
        ]
    )
    frontend_dist: Path = field(
        default_factory=lambda: Path(__file__).resolve().parents[2] / "frontend" / "dist"
    )

    def __post_init__(self):
        for name in (
            "max_upload_mb", "max_session_mb", "max_workspace_entries", "max_turns",
            "max_runtime_seconds", "model_timeout_seconds", "mcp_timeout_seconds",
            "mcp_session_timeout_seconds", "mcp_max_list_pages", "max_plan_steps",
        ):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        self.api_mode = "responses"
        # Accept legacy environment URLs that named the full Responses endpoint.
        self.base_url = self.base_url.rstrip("/").removesuffix("/responses")
        self.data_dir = self.data_dir.resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.database_url:
            self.database_url = f"sqlite:///{self.data_dir / 'app.db'}"
        sqlite_url(self.database_url)
