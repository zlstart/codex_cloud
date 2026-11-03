from __future__ import annotations

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.orm import DeclarativeBase, sessionmaker


class Base(DeclarativeBase):
    pass


def sqlite_url(url: str) -> URL:
    """Validate before loading a driver, without including credentials in errors."""
    message = (
        "DATABASE_URL must be a SQLite URL using sqlite:/// or sqlite+pysqlite:/// "
        "(for example sqlite:////srv/famsun/data/app.db). "
        "Leave DATABASE_URL empty to use DATA_DIR/app.db."
    )
    try:
        parsed = make_url(url)
    except (ArgumentError, ValueError):
        raise ValueError(message) from None
    if parsed.drivername not in {"sqlite", "sqlite+pysqlite"} or any(
        value is not None for value in (parsed.username, parsed.password, parsed.host, parsed.port)
    ):
        raise ValueError(message)
    return parsed


class Database:
    def __init__(self, url: str):
        self.engine = create_engine(
            sqlite_url(url),
            pool_pre_ping=True,
            connect_args={"check_same_thread": False, "timeout": 30},
        )

        @event.listens_for(self.engine, "connect")
        def configure_sqlite(connection, _):
            cursor = connection.cursor()
            try:
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.execute("PRAGMA journal_mode=WAL")
            finally:
                cursor.close()

        self.session = sessionmaker(self.engine, expire_on_commit=False)

    def initialize(self):
        Base.metadata.create_all(self.engine)
        # Additive migration for installations created before native subagents.
        # Keep user-managed capability content intact in existing SQLite files.
        columns = {column["name"] for column in inspect(self.engine).get_columns("extensions")}
        if "config" not in columns:
            with self.engine.begin() as connection:
                connection.execute(
                    text("ALTER TABLE extensions ADD COLUMN config JSON NOT NULL DEFAULT '{}'")
                )
