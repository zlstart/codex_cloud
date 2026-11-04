"""Current workspace inventory follows missing outputs; durable run events remain."""

import asyncio
import sys
import threading
import types

import pytest
from app.models import AgentRun, Artifact, RunEvent
from sqlalchemy import select
from test_api import app as app  # noqa: PLC0414
from test_api import client as client  # noqa: PLC0414
from test_api import register, session, upload, wait_status


def install_runtime(monkeypatch, runtime):
    monkeypatch.setitem(sys.modules, "app.runtime", types.SimpleNamespace(
        RuntimeConfig=lambda **kwargs: kwargs, run_agent=runtime,
    ))


def start(client, app, sid):
    app.state.settings.api_key = "fixture-no-provider"
    response = client.post(f"/api/sessions/{sid}/runs", json={
        "content": "Generate then move an intermediate file", "client_request_id": "remove-output",
    })
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_moved_output_is_removed_while_running_without_erasing_audit(client, app, monkeypatch):
    ready, release = threading.Event(), threading.Event()

    async def runtime(*, workspace, emit, **_):
        output = workspace / "outputs/report_payload.json"
        output.write_text('{"intermediate":true}')
        await emit("artifact.discovered", {"path": "outputs/report_payload.json"})
        (workspace / "build").mkdir()
        output.rename(workspace / "build/report_payload.json")
        await emit("artifacts.scanned", {})
        await emit("artifacts.scanned", {})
        ready.set()
        while not release.is_set():
            await asyncio.sleep(0.01)
        return "Finished"

    install_runtime(monkeypatch, runtime)
    register(client)
    sid = session(client)
    attachment = upload(client, sid)
    rid = start(client, app, sid)
    try:
        assert ready.wait(5)
        assert client.get(f"/api/runs/{rid}").json()["status"] == "running"
        assert client.get(f"/api/sessions/{sid}").json()["files"] == [attachment]
        assert client.get("/api/files").json() == [attachment]
        with app.state.db.session() as db:
            events = list(db.scalars(select(RunEvent).where(RunEvent.run_id == rid).order_by(RunEvent.id)))
        created = next(event.data["artifact"] for event in events if event.event == "artifact.created")
        removed = [event.data["artifact"] for event in events if event.event == "artifact.removed"]
        assert removed == [created]
        assert client.get(created["url"]).status_code == 404
        assert client.get(attachment["url"]).status_code == 200
        assert not any(event.event == "artifacts.scanned" for event in events)
    finally:
        release.set()
        wait_status(client, rid, {"completed", "failed"})
    replay = client.get(f"/api/runs/{rid}/events").text
    assert "event: artifact.created" in replay and "event: artifact.removed" in replay


def test_temporary_missing_output_is_not_removed(client, app, monkeypatch):
    async def runtime(*, workspace, emit, **_):
        output = workspace / "outputs/live.txt"
        output.write_text("initial")
        await emit("artifact.discovered", {"path": "outputs/live.txt"})
        output.rename(workspace / "temporary.txt")
        await emit("artifacts.scanned", {})
        (workspace / "temporary.txt").rename(output)
        await emit("artifacts.scanned", {})
        output.write_text("")  # A writer truncating an existing file is not a deletion.
        await emit("artifacts.scanned", {})
        await emit("artifacts.scanned", {})
        output.write_text("updated")
        return "Finished"

    install_runtime(monkeypatch, runtime)
    register(client)
    sid = session(client)
    rid = start(client, app, sid)
    assert wait_status(client, rid, {"completed", "failed"})["status"] == "completed"
    files = client.get(f"/api/sessions/{sid}").json()["files"]
    assert len(files) == 1
    assert client.get(files[0]["url"]).text == "updated"
    assert "event: artifact.removed" not in client.get(f"/api/runs/{rid}/events").text


@pytest.mark.parametrize("fail", [False, True])
def test_terminal_run_reconciles_missing_files_even_without_a_final_scan(client, app, monkeypatch, fail):
    async def runtime(*, workspace, emit, **_):
        output = workspace / "outputs/intermediate.txt"
        output.write_text("temporary")
        await emit("artifact.discovered", {"path": "outputs/intermediate.txt"})
        output.unlink()
        if fail:
            raise ValueError("fixture failure")
        return "Finished"

    install_runtime(monkeypatch, runtime)
    register(client)
    sid = session(client)
    rid = start(client, app, sid)
    expected = "failed" if fail else "completed"
    assert wait_status(client, rid, {"completed", "failed"})["status"] == expected
    with app.state.db.session() as db:
        assert not list(db.scalars(select(Artifact).where(Artifact.session_id == sid)))
        events = list(db.scalars(select(RunEvent).where(RunEvent.run_id == rid).order_by(RunEvent.id)))
    names = [event.event for event in events]
    assert names.index("artifact.created") < names.index("artifact.removed") < names.index(f"run.{expected}")


def test_idle_inventory_reconciles_legacy_missing_outputs_after_authorization(client, app):
    user = register(client)
    sid = session(client)
    with app.state.db.session() as db:
        run = AgentRun(session_id=sid, client_request_id="legacy", status="completed")
        output = Artifact(session_id=sid, name="missing.json", path="outputs/missing.json",
                          mime_type="application/json", size=2, kind="output")
        db.add_all([run, output])
        db.flush()
        rid, fid = run.id, output.id
        db.add(RunEvent(run_id=rid, event="artifact.created", data={"artifact": {"id": fid}}))
        db.commit()
    client.post("/api/auth/logout")
    register(client, "other@example.com")
    assert client.get(f"/api/sessions/{sid}").status_code == 404
    assert client.get("/api/files").json() == []
    with app.state.db.session() as db:
        assert db.get(Artifact, fid) is not None, "Another user must not reconcile this session"
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"email": user["email"], "password": "safe-password-123"}).status_code == 200
    assert client.get(f"/api/sessions/{sid}").json()["files"] == []
    assert client.get("/api/files").json() == []
    replay = client.get(f"/api/runs/{rid}/events").text
    assert replay.count("event: artifact.created") == 1
    assert replay.count("event: artifact.removed") == 1


@pytest.mark.parametrize("replacement", ["dangling_symlink", "regular_file"])
def test_unsafe_output_directory_cannot_block_completion_or_erase_metadata(client, app, replacement):
    user = register(client)
    sid = session(client)
    workspace = app.state.service.workspace(user["id"], sid)
    with app.state.db.session() as db:
        run = AgentRun(session_id=sid, client_request_id="unsafe-directory", status="running")
        artifact = Artifact(session_id=sid, name="report.txt", path="outputs/report.txt",
                            mime_type="text/plain", size=4, kind="output")
        db.add_all([run, artifact])
        db.flush()
        rid, fid = run.id, artifact.id
        db.commit()
    output_directory = workspace / "outputs"
    output_directory.rmdir()
    if replacement == "dangling_symlink":
        output_directory.symlink_to(workspace / "missing-target")
    else:
        output_directory.write_text("not a directory")
    try:
        client.portal.call(app.state.service.finish, rid, "completed")
    except OSError as exc:
        pytest.fail(f"Unsafe output directories must not abort terminal persistence: {type(exc).__name__}")
    assert client.get(f"/api/runs/{rid}").json()["status"] == "completed"
    assert [file["id"] for file in client.get(f"/api/sessions/{sid}").json()["files"]] == [fid]
    assert [file["id"] for file in client.get("/api/files").json()] == [fid]
    with app.state.db.session() as db:
        assert db.get(Artifact, fid) is not None
        assert not list(db.scalars(select(RunEvent).where(
            RunEvent.run_id == rid, RunEvent.event == "artifact.removed",
        )))
