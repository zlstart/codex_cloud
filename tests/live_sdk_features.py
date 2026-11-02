"""Opt-in real provider + Docker acceptance for native delegation/custom tools."""

import json
import os
import time
from pathlib import Path
from uuid import uuid4

import httpx


def main():
    assert os.getenv("FAMSUN_LIVE_MODEL_TEST") == "1", "Explicit live-call opt-in required"
    output = Path("test-results/deployment")
    state = json.loads((output / "admin-state.json").read_text())
    with httpx.Client(
        base_url=os.getenv("FAMSUN_TEST_BASE_URL", "http://127.0.0.1:8000"), timeout=30
    ) as client:
        for cookie in state["cookies"]:
            client.cookies.set(cookie["name"], cookie["value"])

        def request(method, path, **kwargs):
            result = client.request(method, path, **kwargs)
            result.raise_for_status()
            return result

        sid = request("POST", "/api/sessions", json={"title": "SDK 原生子代理与补丁验收"}).json()["id"]
        rid = request(
            "POST",
            f"/api/sessions/{sid}/runs",
            json={
                "content": "必须委派给数据分析助手完成以下独立任务：使用 apply_patch 工具创建 outputs/delegated-check.txt，内容为 NATIVE_SUBAGENT_OK，然后用 exec_command 读取确认。主助手不要自己执行子任务，最后简短报告该标记和文件名。",
                "client_request_id": uuid4().hex,
            },
        ).json()["id"]
        deadline = time.monotonic() + 310
        while time.monotonic() < deadline:
            run = request("GET", f"/api/runs/{rid}").json()
            if run["status"] in {"completed", "failed", "cancelled"}:
                break
            time.sleep(1)
        assert run["status"] == "completed", run
        events, cursor = [], 0
        while True:
            page = request("GET", f"/api/runs/{rid}/timeline?after={cursor}").json()
            events.extend(page["events"])
            cursor = page["next_cursor"]
            if not page["has_more"]:
                break
        tools = [event["data"] for event in events if event["type"] == "tool.completed"]
        assert any(tool["name"].startswith("delegate_") for tool in tools), tools
        assert any(tool["name"] == "apply_patch" and tool.get("parent_call_id") for tool in tools), tools
        assert any(tool["name"] == "exec_command" and tool.get("parent_call_id") for tool in tools), tools
        detail = request("GET", f"/api/sessions/{sid}").json()
        artifact = next(file for file in detail["files"] if file["name"] == "delegated-check.txt")
        assert request("GET", artifact["url"]).text.strip() == "NATIVE_SUBAGENT_OK"
        assert "NATIVE_SUBAGENT_OK" in detail["messages"][-1]["content"]
        report = {
            "session_id": sid,
            "run_id": rid,
            "tool_names": [tool["name"] for tool in tools],
            "child_events": sum(bool(event["data"].get("parent_call_id")) for event in events),
            "file_verified": True,
            "status": "passed",
        }
        (output / "native-sdk-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(
            "PASS: real Responses delegation, child custom apply_patch, native exec, ordered child events and file bytes",
            flush=True,
        )


if __name__ == "__main__":
    main()
