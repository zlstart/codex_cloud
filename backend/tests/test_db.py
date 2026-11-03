from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from threading import Barrier

import pytest
from app.config import Settings
from app.db import Database
from app.models import ExtensionPreference, User
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError


def test_default_database_stays_in_data_dir(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    settings = Settings(data_dir=tmp_path)
    assert settings.database_url == f"sqlite:///{tmp_path / 'app.db'}"
    database = Database(settings.database_url)
    try:
        database.initialize()
        assert (tmp_path / "app.db").is_file()
    finally:
        database.engine.dispose()


@pytest.mark.parametrize("driver", ["sqlite", "sqlite+pysqlite"])
def test_explicit_sqlite_file_url_is_preserved(tmp_path, driver):
    url = f"{driver}:///{tmp_path / 'existing.db'}"
    settings = Settings(data_dir=tmp_path, database_url=url)
    assert settings.database_url == url
    database = Database(settings.database_url)
    try:
        database.initialize()
        assert (tmp_path / "existing.db").is_file()
    finally:
        database.engine.dispose()


@pytest.mark.parametrize(
    "url",
    [
        "postgres://user:secret-value@localhost/app",
        "postgresql://user:secret-value@localhost/app",
        "postgresql+psycopg://user:secret-value@localhost/app",
        "mysql://user:secret-value@localhost/app",
        "sqlite+aiosqlite:///app.db",
        "sqlite-not-a-driver:///app.db",
        "sqlite://user:secret-value@localhost/app.db",
        "sqlite://localhost/app.db",
        "sqlite://localhost:invalid-port/app.db",
        "not-a-database-url",
    ],
)
@pytest.mark.parametrize("entrypoint", ["settings", "database"])
def test_invalid_database_url_fails_clearly_without_credentials(tmp_path, url, entrypoint):
    with pytest.raises(ValueError, match="DATABASE_URL must be a SQLite URL") as error:
        if entrypoint == "settings":
            Settings(data_dir=tmp_path, database_url=url)
        else:
            Database(url)
    assert "secret-value" not in str(error.value)


def test_sqlite_connections_enforce_foreign_keys_and_support_concurrent_writes(tmp_path):
    url = f"sqlite:///{tmp_path / 'concurrent.db'}"
    database = Database(url)
    try:
        database.initialize()
        # Hold multiple connections concurrently so every pooled connection is checked.
        with ExitStack() as stack:
            for _ in range(4):
                connection = stack.enter_context(database.engine.connect())
                assert connection.scalar(text("PRAGMA foreign_keys")) == 1
                assert connection.scalar(text("PRAGMA journal_mode")) == "wal"
                assert connection.scalar(text("PRAGMA busy_timeout")) == 30000

        with pytest.raises(IntegrityError), database.session.begin() as session:
            session.add(ExtensionPreference(user_id="missing", extension_id="missing"))

        ready = Barrier(4)

        def write_users(worker):
            ready.wait(timeout=5)
            for index in range(10):
                with database.session.begin() as session:
                    session.add(User(
                        id=f"{worker}-{index}", email=f"{worker}-{index}@example.com",
                        name="并发用户", password_hash="test-hash",
                    ))

        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(write_users, range(4)))
    finally:
        database.engine.dispose()

    reopened = Database(url)
    try:
        reopened.initialize()
        with reopened.session() as session:
            assert session.scalar(select(func.count()).select_from(User)) == 40
    finally:
        reopened.engine.dispose()
