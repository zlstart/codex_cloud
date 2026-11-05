import io
import json
import sys
import types

from app.db import Database
from app.models import RunEvent
from openpyxl import Workbook
from sqlalchemy import text
from test_api import register, session, upload, wait_status

pytest_plugins = ["test_api"]


def test_responses_only_and_compaction_settings(client):
    register(client)
    assert client.patch("/api/settings", json={"api_mode": "chat_completions"}).status_code == 422
    response = client.patch("/api/settings", json={"compaction_threshold": 48000})
    assert response.status_code == 200
    assert response.json()["provider"]["api_mode"] == "responses"
    assert response.json()["compaction"]["threshold"] == 48000


def test_capability_edits_subagents_and_member_permissions(client):
    register(client)
    skill = client.post("/api/extensions/skills", json={"name": "原始", "content": "# old"}).json()
    sid = skill["id"]
    edited = client.patch(f"/api/extensions/skills/{sid}", json={"name": "新名称", "content": "# new"})
    assert edited.status_code == 200
    assert client.get(f"/api/extensions/{sid}").json()["content"] == "# new"
    mcp = client.post(
        "/api/extensions/mcp", json={"name": "MCP", "url": "https://mcp.example.com/mcp"}
    ).json()
    assert (
        client.patch(f"/api/extensions/mcp/{mcp['id']}", json={"url": "https://evil.example/mcp"}).status_code
        == 400
    )
    response = client.post(
        "/api/extensions/subagents",
        json={
            "name": "分析师",
            "description": "分析表格",
            "instructions": "检查数据并返回事实。",
            "max_turns": 8,
            "skill_ids": [sid],
            "mcp_server_ids": [mcp["id"]],
        },
    )
    assert response.status_code == 201, response.text
    child = response.json()
    detail = client.get(f"/api/extensions/{child['id']}").json()
    assert detail["config"]["skill_ids"] == [sid]
    assert (
        client.patch(f"/api/extensions/subagents/{child['id']}", json={"skill_ids": [mcp["id"]]}).status_code
        == 400
    )
    assert client.patch(f"/api/extensions/subagents/{child['id']}", json={"max_turns": 12}).status_code == 200
    client.post("/api/auth/logout")
    register(client, "member@example.com")
    assert client.get(f"/api/extensions/{sid}").json()["editable"] is False
    assert client.patch(f"/api/extensions/skills/{sid}", json={"content": "bad"}).status_code == 403
    assert client.patch(f"/api/extensions/{child['id']}", json={"enabled": False}).json()["enabled"] is False


def test_subagent_defaults_inherit_and_explicit_large_limits_can_be_reset(client):
    register(client)
    response = client.post(
        "/api/extensions/subagents", json={"name": "Long task", "instructions": "Complete the task."}
    )
    assert response.status_code == 201, response.text
    item = response.json()
    assert item["config"]["max_turns"] is None
    endpoint = f"/api/extensions/subagents/{item['id']}"
    assert client.patch(endpoint, json={"max_turns": 200}).json()["config"]["max_turns"] == 200
    assert client.patch(endpoint, json={"max_turns": None}).json()["config"]["max_turns"] is None
    assert client.patch(endpoint, json={"max_turns": 0}).status_code == 422
    assert client.patch(endpoint, json={"max_turns": 10001}).status_code == 422


def test_upload_quota_counts_unregistered_workspace_files(client, app):
    from pathlib import Path

    user = register(client)
    sid = session(client)
    workspace = app.state.service.workspace(user["id"], sid)
    Path(workspace / "outputs" / "unregistered.bin").write_bytes(b"x" * (1024 * 1024))
    app.state.settings.max_session_mb = 1
    response = client.post(f"/api/sessions/{sid}/files", files={"file": ("small.txt", b"x")})
    assert response.status_code == 413
    assert not list((workspace / "uploads").iterdir())


def test_upload_entry_limit_is_configurable_and_enforced(client, app):
    register(client)
    sid = session(client)
    app.state.settings.max_workspace_entries = 2  # uploads/ and outputs/ already occupy two entries.
    response = client.post(f"/api/sessions/{sid}/files", files={"file": ("small.txt", b"x")})
    assert response.status_code == 413
    app.state.settings.max_workspace_entries = 3
    assert upload(client, sid, "small.txt", b"x")["size"] == 1


def test_spreadsheet_preview_is_bounded_and_owned(client):
    register(client)
    sid = session(client)
    book = Workbook()
    sheet = book.active
    sheet.title = "销售"
    sheet.append(["月份", "销售额"])
    for i in range(1005):
        sheet.append([i, i * 2])
    stream = io.BytesIO()
    book.save(stream)
    artifact = upload(client, sid, "sales.xlsx", stream.getvalue())
    response = client.get(f"/api/files/{artifact['id']}/preview")
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["kind"] == "spreadsheet"
    assert preview["sheets"][0]["name"] == "销售"
    assert len(preview["sheets"][0]["rows"]) == 1000
    assert preview["sheets"][0]["truncated"] is True
    client.post("/api/auth/logout")
    register(client, "other@example.com")
    assert client.get(f"/api/files/{artifact['id']}/preview").status_code == 404


def test_streaming_excel_without_dimension_preserves_cells():
    from app.previews import parse_document

    book = Workbook(write_only=True)
    sheet = book.create_sheet("流式导出")
    sheet.append(["月份", "产量"])
    sheet.append(["十一月", 460])
    stream = io.BytesIO()
    book.save(stream)
    stream.seek(0)
    preview = parse_document(stream, ".xlsx")["sheets"][0]
    assert preview["rows"] == [["月份", "产量"], ["十一月", 460]]
    assert preview["total_rows"] == 2
    assert preview["truncated"] is False


def test_large_approval_preserves_actionable_identity(client, app, monkeypatch):
    async def runtime(*, request_approval, **kwargs):
        return "approved" if await request_approval("mcp_write", {"body": "x" * 210000}) else "denied"

    monkeypatch.setitem(
        sys.modules,
        "app.runtime",
        types.SimpleNamespace(RuntimeConfig=lambda **kwargs: kwargs, run_agent=runtime),
    )
    register(client)
    sid = session(client)
    app.state.settings.api_key = "test"
    rid = client.post(
        f"/api/sessions/{sid}/runs", json={"content": "Review", "client_request_id": "approval-large-01"}
    ).json()["id"]
    wait_status(client, rid, {"awaiting_approval"})
    events = client.get(f"/api/runs/{rid}/timeline").json()["events"]
    approval = next(event["data"] for event in events if event["type"] == "approval.required")
    assert approval["id"] and approval["tool"] == "mcp_write"
    assert approval["arguments"]["truncated"] is True
    assert (
        client.post(
            f"/api/runs/{rid}/approve", json={"approval_id": approval["id"], "approved": False}
        ).status_code
        == 200
    )
    assert wait_status(client, rid, {"completed"})["status"] == "completed"


def test_timeline_is_paginated_ordered_and_owned(client, app, monkeypatch):
    register(client)
    sid = session(client)
    app.state.settings.api_key = "test"
    monkeypatch.setattr(app.state.service, "launch", lambda _: None)
    rid = client.post(
        f"/api/sessions/{sid}/runs", json={"content": "x", "client_request_id": "timeline-0001"}
    ).json()["id"]
    with app.state.db.session() as db:
        for item_id in ["text-a", "tool-b", "text-c"]:
            db.add(RunEvent(run_id=rid, event="text.delta", data={"item_id": item_id, "delta": item_id}))
        db.commit()
    first = client.get(f"/api/runs/{rid}/timeline?limit=2").json()
    assert first["has_more"] is True
    second = client.get(f"/api/runs/{rid}/timeline?after={first['next_cursor']}&limit=2").json()
    assert second["has_more"] is False
    events = first["events"] + second["events"]
    assert [e["data"]["item_id"] for e in events] == ["text-a", "tool-b", "text-c"]
    assert [e["sequence"] for e in events] == sorted(e["sequence"] for e in events)
    client.post("/api/auth/logout")
    register(client, "other@example.com")
    assert client.get(f"/api/runs/{rid}/timeline").status_code == 404


def test_legacy_extension_config_migration_is_idempotent(tmp_path):
    database = Database(f"sqlite:///{tmp_path / 'old.db'}")
    with database.engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE extensions (id VARCHAR(80) PRIMARY KEY, name VARCHAR(100), description VARCHAR(1000), type VARCHAR(20), content TEXT, url TEXT, token_env VARCHAR(100), builtin BOOLEAN)"
            )
        )
        connection.execute(
            text("INSERT INTO extensions VALUES ('old', 'Original', '', 'skill', 'Keep me', '', NULL, 0)")
        )
    database.initialize()
    database.initialize()
    with database.engine.connect() as connection:
        row = connection.execute(text("SELECT content, config FROM extensions WHERE id='old'")).one()
        assert row.content == "Keep me"
        assert json.loads(row.config) == {}
