"""SQLite persistence and upgrade checks run with disposable local files in every test run."""

from app.config import Settings
from app.db import Base, Database
from app.main import create_app
from app.models import Extension, ExtensionPreference, User
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text


def test_sqlite_auth_artifacts_preferences_and_restart(tmp_path):
    url = f"sqlite:///{tmp_path / 'app.db'}"
    settings = Settings(
        data_dir=tmp_path, database_url=url, sandbox_backend="disabled",
        registration_enabled=True, api_key="",
    )
    app = create_app(settings)
    with TestClient(app) as client:
        registered = client.post("/api/auth/register", json={
            "email": "sqlite-qa@example.com", "name": "持久化验证", "password": "test-password-12345",
        })
        assert registered.status_code == 201, registered.text
        assert registered.json()["role"] == "admin"
        session = client.post("/api/sessions", json={"title": "数据库持久化验证"}).json()
        sid = session["id"]
        response = client.post(f"/api/sessions/{sid}/files", files={
            "file": ("中文.csv", "设备,产量\nA,100\n".encode(), "text/csv"),
        })
        assert response.status_code == 201, response.text
        artifact = response.json()
        assert "A,100" in client.get(artifact["url"]).text
        client.patch(f"/api/sessions/{sid}", json={"pinned": True})
        created = client.post("/api/extensions/skills", json={
            "name": "SQLite Skill", "description": "JSON + unicode persistence", "content": "# 数据库验证\n读取文件",
        }).json()
        assert client.patch(f"/api/extensions/{created['id']}", json={"enabled": False}).status_code == 200

    # The second app uses entirely new DB sessions, as after a process restart.
    app = create_app(settings)
    with TestClient(app) as client:
        result = client.post("/api/auth/login", json={"email": "sqlite-qa@example.com", "password": "test-password-12345"})
        assert result.status_code == 200, result.text
        detail = client.get(f"/api/sessions/{sid}").json()
        assert detail["session"]["pinned"] is True
        assert detail["files"][0]["name"] == "中文.csv"
        assert client.get(artifact["url"]).status_code == 200
        assert client.get(f"/api/extensions/skills/{created['id']}").json()["enabled"] is False
        assert client.delete(f"/api/sessions/{sid}").status_code == 200
        assert client.get(artifact["url"]).status_code == 404


def test_sqlite_additive_extension_migration_preserves_existing_data(tmp_path):
    """A pre-subagent schema gains config without resetting edits or preferences."""
    url = f"sqlite:///{tmp_path / 'app.db'}"
    database = Database(url)
    try:
        Base.metadata.create_all(database.engine)
        with database.session.begin() as session:
            session.add(User(id="legacy-user", email="legacy@example.com", name="旧用户",
                             password_hash="retained-password-hash", role="admin"))
            session.add(Extension(id="legacy-skill", name="用户修改的技能", type="skill",
                                  description="保留自定义描述", content="# 已修改\n不能被重置",
                                  builtin=True))
            session.flush()
            session.add(ExtensionPreference(user_id="legacy-user", extension_id="legacy-skill",
                                             enabled=False))
        # Reproduce the deployed schema before the additive config migration.
        with database.engine.begin() as connection:
            connection.execute(text("ALTER TABLE extensions DROP COLUMN config"))
        assert "config" not in {column["name"] for column in inspect(database.engine).get_columns("extensions")}

        database.initialize()
        with database.session.begin() as session:
            legacy = session.get(Extension, "legacy-skill")
            assert legacy.content == "# 已修改\n不能被重置"
            assert legacy.name == "用户修改的技能" and legacy.config == {}
            assert session.get(User, "legacy-user").password_hash == "retained-password-hash"
            assert session.get(ExtensionPreference, ("legacy-user", "legacy-skill")).enabled is False
            session.add(Extension(id="new-specialist", name="分析专家", type="subagent", config={
                "instructions": "分析真实资料", "skill_ids": ["legacy-skill"], "max_turns": 7,
            }))

        # Restart-style initialization must preserve newly stored JSON too.
        database.initialize()
        with database.session() as session:
            assert session.get(Extension, "new-specialist").config == {
                "instructions": "分析真实资料", "skill_ids": ["legacy-skill"], "max_turns": 7,
            }
            assert session.get(Extension, "legacy-skill").config == {}
    finally:
        database.engine.dispose()
