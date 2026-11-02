from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


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
    model: str = field(default_factory=lambda: os.getenv("AGENT_MODEL", "gpt-4.1"))
    api_mode: str = field(default_factory=lambda: os.getenv("AGENT_API_MODE", "chat_completions"))
    sandbox_backend: str = field(default_factory=lambda: os.getenv("SANDBOX_BACKEND", "docker"))
    registration_enabled: bool = field(default_factory=lambda: flag("ALLOW_REGISTRATION"))
    cookie_secure: bool = field(default_factory=lambda: flag("COOKIE_SECURE"))
    session_days: int = 7
    max_upload_mb: int = field(default_factory=lambda: int(os.getenv("MAX_UPLOAD_MB", "25")))
    max_session_mb: int = field(default_factory=lambda: int(os.getenv("MAX_SESSION_MB", "250")))
    max_turns: int = field(default_factory=lambda: int(os.getenv("AGENT_MAX_TURNS", "20")))
    max_runtime_seconds: int = field(default_factory=lambda: int(os.getenv("AGENT_TIMEOUT_SECONDS", "300")))
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
        self.data_dir = self.data_dir.resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.database_url:
            self.database_url = f"sqlite:///{self.data_dir / 'app.db'}"
        if self.database_url.startswith("postgres://"):
            self.database_url = self.database_url.replace("postgres://", "postgresql+psycopg://", 1)
        elif self.database_url.startswith("postgresql://"):
            self.database_url = self.database_url.replace("postgresql://", "postgresql+psycopg://", 1)
