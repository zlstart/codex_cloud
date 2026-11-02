from __future__ import annotations

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker


class Base(DeclarativeBase):
    pass


class Database:
    def __init__(self, url: str):
        options = (
            {"connect_args": {"check_same_thread": False, "timeout": 30}} if url.startswith("sqlite") else {}
        )
        self.engine = create_engine(url, pool_pre_ping=True, **options)
        if url.startswith("sqlite"):

            @event.listens_for(self.engine, "connect")
            def configure_sqlite(connection, _):
                connection.execute("PRAGMA foreign_keys=ON")
                connection.execute("PRAGMA journal_mode=WAL")

        self.session = sessionmaker(self.engine, expire_on_commit=False)

    def initialize(self):
        Base.metadata.create_all(self.engine)
        # Additive migration for installations created before native subagents.
        # Keep user-managed capability content intact; works on SQLite/PostgreSQL.
        columns = {column["name"] for column in inspect(self.engine).get_columns("extensions")}
        if "config" not in columns:
            with self.engine.begin() as connection:
                connection.execute(
                    text("ALTER TABLE extensions ADD COLUMN config JSON NOT NULL DEFAULT '{}'")
                )
