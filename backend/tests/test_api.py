import json
import sys
import time
import types

import pytest
from app.auth import hash_password, verify_password
from app.config import Settings
from app.main import create_app
from app.models import Artifact, RunEvent
from fastapi.testclient import TestClient
from sqlalchemy import select


@pytest.fixture
def app(tmp_path):
    return create_app(
        Settings(
            data_dir=tmp_path,
            sandbox_backend="disabled",
            registration_enabled=True,
            allowed_mcp_hosts=["mcp.example.com"],
            api_key="",
        )
    )


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        yield client


def register(client, email="admin@example.com"):
    result = client.post(
        "/api/auth/register", json={"email": email, "name": "测试用户", "password": "safe-password-123"}
    )
    assert result.status_code == 201, result.text
    return result.json()


def session(client):
    response = client.post("/api/sessions", json={})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def upload(client, sid, name="sales.csv", data=b"month,sales\nJan,100\n"):
    response = client.post(f"/api/sessions/{sid}/files", files={"file": (name, data, "text/csv")})
    assert response.status_code == 201, response.text
    return response.json()


def wait_status(client, rid, targets):
    end = time.monotonic() + 5
    while time.monotonic() < end:
        result = client.get(f"/api/runs/{rid}").json()
        if result["status"] in targets:
            return result
        time.sleep(0.01)
    raise AssertionError(f"Run did not reach {targets}: {result}")


def test_password_hash_is_salted_and_checked():
    a, b = hash_password("secret password"), hash_password("secret password")
    assert a != b
    assert verify_password("secret password", a)
    assert not verify_password("wrong password", a)
    assert not verify_password("secret password", "invalid")


def test_registration_cookie_logout_and_login(client):
    assert client.get("/api/auth/status").json()["has_users"] is False
    user = register(client)
    assert user["role"] == "admin"
    cookie = client.cookies.get("famsun_session")
    assert cookie and len(cookie) > 40
    assert client.get("/api/auth/me").json()["id"] == user["id"]
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
    assert (
        client.post(
            "/api/auth/login", json={"email": "admin@example.com", "password": "safe-password-123"}
        ).status_code
        == 200
    )


def test_user_and_session_isolation_every_resource(client):
    alice = register(client)
    sid = session(client)
    file = upload(client, sid)
    client.post("/api/auth/logout")
    bob = register(client, "bob@example.com")
    assert alice["id"] != bob["id"] and bob["role"] == "member"
    assert client.get("/api/sessions").json() == []
    assert client.get("/api/files").json() == []
    for method, path in [
        ("get", f"/api/sessions/{sid}"),
        ("delete", f"/api/sessions/{sid}"),
        ("get", file["url"]),
        ("delete", f"/api/files/{file['id']}"),
    ]:
        assert getattr(client, method)(path).status_code == 404
    assert client.patch(f"/api/sessions/{sid}", json={"title": "attack"}).status_code == 404
    assert client.post(f"/api/sessions/{sid}/files", files={"file": ("x.txt", b"attack")}).status_code == 404
    assert client.patch("/api/settings", json={"model": "unauthorized"}).status_code == 403


def test_file_content_download_csp_and_filename_sanitization(client):
    register(client)
    sid = session(client)
    item = upload(client, sid, "../../secret.csv")
    assert item["name"] == "secret.csv"
    content = client.get(item["url"])
    assert content.content == b"month,sales\nJan,100\n"
    assert "sandbox" in content.headers["content-security-policy"]
    assert content.headers["x-content-type-options"] == "nosniff"
    assert "attachment" in client.get(item["url"] + "?download=true").headers["content-disposition"]
    assert client.delete(f"/api/files/{item['id']}").status_code == 200
    assert client.get(item["url"]).status_code == 404


def test_symlink_artifact_is_never_served(client, app, tmp_path):
    user = register(client)
    sid = session(client)
    item = upload(client, sid)
    with app.state.db.session() as db:
        row = db.get(Artifact, item["id"])
        path = app.state.service.workspace(user["id"], sid) / row.path
    path.unlink()
    path.symlink_to(tmp_path / "app.db")
    assert client.get(item["url"]).status_code == 404


def test_long_chinese_filename_preserves_display_name(client):
    register(client)
    sid = session(client)
    name = "丰" * 80 + ".csv"
    item = upload(client, sid, name)
    assert item["name"] == name
    assert client.get(item["url"]).status_code == 200


def test_upload_and_session_quotas_enforced(client, app):
    register(client)
    sid = session(client)
    app.state.settings.max_upload_mb = 1
    response = client.post(
        f"/api/sessions/{sid}/files", files={"file": ("large.csv", b"x" * (1024 * 1024 + 1))}
    )
    assert response.status_code == 413
    assert client.get(f"/api/sessions/{sid}").json()["files"] == []


def test_csrf_cross_origin_is_rejected(client):
    response = client.post(
        "/api/auth/register",
        headers={"Origin": "https://attacker.example"},
        json={"email": "x@example.com", "name": "X", "password": "safe-password-123"},
    )
    assert response.status_code == 403
    assert not client.get("/api/auth/status").json()["has_users"]


def test_no_provider_key_fails_without_fake_message(client):
    register(client)
    sid = session(client)
    response = client.post(
        f"/api/sessions/{sid}/runs", json={"content": "hello", "client_request_id": "request-0001"}
    )
    assert response.status_code == 503
    assert client.get(f"/api/sessions/{sid}").json()["messages"] == []


def test_provider_settings_and_mcp_allowlist(client):
    register(client)
    assert client.patch("/api/settings", json={"base_url": "http://evil.example/v1"}).status_code == 400
    response = client.patch(
        "/api/settings",
        json={
            "base_url": "https://compatible.example/v1",
            "model": "my-model",
            "api_mode": "chat_completions",
        },
    )
    assert response.status_code == 200
    assert response.json()["provider"]["model"] == "my-model"
    assert "api_key" not in json.dumps(response.json())
    assert (
        client.post(
            "/api/extensions/mcp", json={"name": "Blocked", "url": "https://evil.example/mcp"}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/extensions/mcp", json={"name": "Query", "url": "https://mcp.example.com/mcp?token=123"}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/extensions/mcp",
            json={"name": "Allowed", "url": "https://mcp.example.com/mcp", "token_env": "OPENAI_API_KEY"},
        ).status_code
        == 422
    )
    result = client.post(
        "/api/extensions/mcp",
        json={"name": "Allowed", "url": "https://mcp.example.com/mcp", "token_env": "MCP_TEST_TOKEN"},
    )
    assert result.status_code == 201, result.text


def test_skills_persist_and_user_preferences_are_independent(client):
    register(client)
    result = client.post(
        "/api/extensions/skills",
        json={
            "name": "设备说明",
            "description": "设备资料整理",
            "content": "# 设备说明\n根据上传文件生成说明。",
        },
    )
    assert result.status_code == 201
    sid = result.json()["id"]
    assert client.patch(f"/api/extensions/{sid}", json={"enabled": False}).json()["enabled"] is False
    client.post("/api/auth/logout")
    register(client, "member@example.com")
    assert client.get(f"/api/extensions/skills/{sid}").json()["enabled"] is True
    assert client.post("/api/extensions/skills", json={"name": "x", "content": "x"}).status_code == 403


def test_run_idempotency_and_cross_session_attachments(client, app, monkeypatch):
    register(client)
    sid, other = session(client), session(client)
    file = upload(client, other)
    app.state.settings.api_key = "test-only-not-a-provider-key"
    monkeypatch.setattr(app.state.service, "launch", lambda _: None)
    body = {"content": "Analyze", "client_request_id": "request-0001", "attachment_ids": [file["id"]]}
    assert client.post(f"/api/sessions/{sid}/runs", json=body).status_code == 400
    body["attachment_ids"] = []
    first = client.post(f"/api/sessions/{sid}/runs", json=body)
    second = client.post(f"/api/sessions/{sid}/runs", json=body)
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert len(client.get(f"/api/sessions/{sid}").json()["messages"]) == 1
    assert client.post(f"/api/sessions/{sid}/runs", json={**body, "content": "different"}).status_code == 409
    assert (
        client.post(
            f"/api/sessions/{sid}/runs", json={**body, "client_request_id": "request-0002"}
        ).status_code
        == 409
    )
    assert client.post(f"/api/sessions/{sid}/files", files={"file": ("x.csv", b"x")}).status_code == 409


def test_background_execution_artifacts_and_event_replay(client, app, monkeypatch):
    async def fake_runtime(*, workspace, emit, **kwargs):
        await emit("text.delta", {"delta": "真实服务路径测试"})
        (workspace / "outputs" / "result.csv").write_text("result\n42\n")
        await emit("artifact.discovered", {"path": "outputs/result.csv"})
        return "真实服务路径测试"

    monkeypatch.setitem(
        sys.modules,
        "app.runtime",
        types.SimpleNamespace(RuntimeConfig=lambda **kwargs: kwargs, run_agent=fake_runtime),
    )
    register(client)
    sid = session(client)
    app.state.settings.api_key = "test-only-not-a-provider-key"
    result = client.post(
        f"/api/sessions/{sid}/runs", json={"content": "Analyze", "client_request_id": "request-0001"}
    )
    rid = result.json()["id"]
    assert wait_status(client, rid, {"completed", "failed"})["status"] == "completed"
    detail = client.get(f"/api/sessions/{sid}").json()
    assert detail["messages"][-1]["role"] == "assistant"
    assert client.get(detail["files"][0]["url"]).text == "result\n42\n"
    events = client.get(f"/api/runs/{rid}/events").text
    assert (
        "event: text.delta" in events
        and "event: artifact.created" in events
        and "event: run.completed" in events
    )
    ids = [int(line[4:]) for line in events.splitlines() if line.startswith("id: ")]
    replay = client.get(f"/api/runs/{rid}/events?after={ids[-2]}").text
    assert "event: run.completed" in replay and "event: text.delta" not in replay


def test_approval_required_and_cancelled_run(client, app, monkeypatch):
    async def approval_runtime(*, request_approval, **kwargs):
        approved = await request_approval("mcp.send", {"text": "Review me"})
        return "approved" if approved else "denied"

    monkeypatch.setitem(
        sys.modules,
        "app.runtime",
        types.SimpleNamespace(RuntimeConfig=lambda **kwargs: kwargs, run_agent=approval_runtime),
    )
    register(client)
    sid = session(client)
    app.state.settings.api_key = "test-only-not-a-provider-key"
    rid = client.post(
        f"/api/sessions/{sid}/runs", json={"content": "Send", "client_request_id": "request-0001"}
    ).json()["id"]
    wait_status(client, rid, {"awaiting_approval"})
    with app.state.db.session() as db:
        event = db.scalar(
            select(RunEvent).where(RunEvent.run_id == rid, RunEvent.event == "approval.required")
        )
        aid = event.data["id"]
    assert (
        client.post(f"/api/runs/{rid}/approve", json={"approval_id": aid, "approved": False}).status_code
        == 200
    )
    assert wait_status(client, rid, {"completed"})["status"] == "completed"
    assert client.get(f"/api/sessions/{sid}").json()["messages"][-1]["content"] == "denied"
    second = client.post(
        f"/api/sessions/{sid}/runs", json={"content": "Again", "client_request_id": "request-0002"}
    ).json()["id"]
    wait_status(client, second, {"awaiting_approval"})
    assert client.post(f"/api/runs/{second}/cancel").json()["status"] == "cancelled"


def test_restart_marks_abandoned_run_failed(client, app, monkeypatch):
    register(client)
    sid = session(client)
    app.state.settings.api_key = "test-only-not-a-provider-key"
    monkeypatch.setattr(app.state.service, "launch", lambda _: None)
    rid = client.post(
        f"/api/sessions/{sid}/runs", json={"content": "Wait", "client_request_id": "request-0001"}
    ).json()["id"]
    app.state.service.recover()
    assert client.get(f"/api/runs/{rid}").json()["status"] == "failed"
    assert "服务已重启" in client.get(f"/api/runs/{rid}").json()["error"]


def test_deleting_session_cascades_records_and_files(client, app):
    user = register(client)
    sid = session(client)
    item = upload(client, sid)
    workspace = app.state.service.workspace(user["id"], sid)
    assert client.delete(f"/api/sessions/{sid}").status_code == 200
    assert not workspace.exists()
    assert client.get(item["url"]).status_code == 404


def test_closed_registration_keeps_first_admin_bootstrap(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, sandbox_backend="disabled", registration_enabled=False))
    with TestClient(app) as client:
        assert register(client)["role"] == "admin"
        response = client.post(
            "/api/auth/register",
            json={"email": "second@example.com", "name": "Second", "password": "safe-password-123"},
        )
        assert response.status_code == 403
