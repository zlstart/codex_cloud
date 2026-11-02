"""Optional production-database integration, enabled by FAMSUN_TEST_DATABASE_URL.

The supplied database must be disposable and its name end in _test or _qa.
"""
import os
from urllib.parse import urlsplit

import pytest
from app.config import Settings
from app.db import Base
from app.main import create_app
from fastapi.testclient import TestClient


@pytest.mark.skipif(not os.getenv("FAMSUN_TEST_DATABASE_URL"), reason="PostgreSQL integration is opt-in")
def test_postgres_auth_artifacts_preferences_and_restart(tmp_path):
    url = os.environ["FAMSUN_TEST_DATABASE_URL"]
    assert urlsplit(url).path.endswith(("_test", "_qa")), "Use a disposable test database"
    settings = Settings(
        data_dir=tmp_path, database_url=url, sandbox_backend="disabled",
        registration_enabled=True, api_key="",
    )
    app = create_app(settings)
    # The explicit opt-in URL above must designate an expendable database.
    Base.metadata.drop_all(app.state.db.engine)
    with TestClient(app) as client:
        registered = client.post("/api/auth/register", json={
            "email": "postgres-qa@example.com", "name": "持久化验证", "password": "test-password-12345",
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
            "name": "Postgres Skill", "description": "JSON + unicode persistence", "content": "# 数据库验证\n读取文件",
        }).json()
        assert client.patch(f"/api/extensions/{created['id']}", json={"enabled": False}).status_code == 200

    # The second app uses entirely new DB sessions, as after a process restart.
    app = create_app(settings)
    with TestClient(app) as client:
        result = client.post("/api/auth/login", json={"email": "postgres-qa@example.com", "password": "test-password-12345"})
        assert result.status_code == 200, result.text
        detail = client.get(f"/api/sessions/{sid}").json()
        assert detail["session"]["pinned"] is True
        assert detail["files"][0]["name"] == "中文.csv"
        assert client.get(artifact["url"]).status_code == 200
        assert client.get(f"/api/extensions/skills/{created['id']}").json()["enabled"] is False
        assert client.delete(f"/api/sessions/{sid}").status_code == 200
        assert client.get(artifact["url"]).status_code == 404
