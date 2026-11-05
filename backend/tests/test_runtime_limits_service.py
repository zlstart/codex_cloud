import copy

from app.extensions import BUILTIN_SUBAGENTS
from app.models import Extension
from test_api import register, session, wait_status

pytest_plugins = ["test_api"]


def test_runtime_budgets_reach_worker(client, app, monkeypatch):
    from app import runtime_worker

    budgets = {
        "max_turns": 321,
        "max_runtime_seconds": 5400,
        "max_session_mb": 3072,
        "max_workspace_entries": 12345,
        "model_timeout_seconds": 420,
        "mcp_timeout_seconds": 180,
        "mcp_session_timeout_seconds": 480,
        "mcp_max_list_pages": 123,
        "max_plan_steps": 35,
    }
    received = {}

    async def worker(*, config, **kwargs):
        received.update({key: getattr(config, key) for key in budgets})
        return "Configured worker completed"

    monkeypatch.setattr(runtime_worker, "run_agent_in_worker", worker)
    for key, value in budgets.items():
        setattr(app.state.settings, key, value)
    app.state.settings.api_key = "test"
    register(client)
    sid = session(client)
    response = client.post(f"/api/sessions/{sid}/runs", json={
        "content": "Check configuration", "client_request_id": "runtime-budgets-001",
    })
    assert response.status_code == 201
    wait_status(client, response.json()["id"], {"completed"})
    assert received == budgets


def test_legacy_builtin_budget_migration_preserves_customization(client, app):
    original, customized = BUILTIN_SUBAGENTS
    with app.state.db.session() as db:
        first = db.get(Extension, original["id"])
        first.config = {**copy.deepcopy(original["config"]), "max_turns": 12}
        second = db.get(Extension, customized["id"])
        second.config = {**copy.deepcopy(customized["config"]), "max_turns": 12,
                         "instructions": "Administrator's custom instructions"}
        db.commit()
    app.state.service.recover()
    app.state.service.recover()  # Idempotent across restarts.
    with app.state.db.session() as db:
        assert db.get(Extension, original["id"]).config["max_turns"] is None
        custom = db.get(Extension, customized["id"]).config
        assert custom["max_turns"] == 12
        assert custom["instructions"] == "Administrator's custom instructions"
