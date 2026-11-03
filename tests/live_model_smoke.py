"""Opt-in real model acceptance against an isolated, already deployed application.

Run after frontend test:deployment. Uses its local-only authentication state.
No mocked provider, no credentials or authentication state in the output report.
"""
import io
import json
import os
import struct
import time
import uuid
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import httpx


def main():
    assert os.getenv("FAMSUN_LIVE_MODEL_TEST") == "1", "Explicit live-call opt-in required"
    root = Path("test-results/deployment")
    state = json.loads((root / "admin-state.json").read_text())
    client = httpx.Client(base_url=os.getenv("FAMSUN_TEST_BASE_URL", "http://127.0.0.1:8080"), timeout=30)
    for cookie in state["cookies"]:
        client.cookies.set(cookie["name"], cookie["value"])
    evidence = []

    def request(method, path, **kwargs):
        response = client.request(method, path, **kwargs)
        response.raise_for_status()
        return response

    def run(sid, prompt, attachments=None):
        result = request("POST", f"/api/sessions/{sid}/runs", json={
            "content": prompt, "attachment_ids": attachments or [], "client_request_id": uuid.uuid4().hex,
        }).json()
        deadline = time.monotonic() + 310
        while time.monotonic() < deadline:
            current = request("GET", f"/api/runs/{result['id']}").json()
            if current["status"] in {"completed", "failed", "cancelled"}:
                break
            time.sleep(1)
        assert current["status"] == "completed", current
        detail = request("GET", f"/api/sessions/{sid}").json()
        answer = [m["content"] for m in detail["messages"] if m["role"] == "assistant"][-1]
        events = request("GET", f"/api/runs/{result['id']}/events").text
        assert "event: text.delta" in events
        evidence.append({"input": prompt, "output": answer, "status": current["status"]})
        print("PASS:", prompt[:70], flush=True)
        return detail, events, answer

    sid = request("POST", "/api/sessions", json={"title": "真实模型端到端验收"}).json()["id"]
    run(sid, "请记住本次验收口令是 FAMSUN-7319。仅回答已记住。")
    _, _, answer = run(sid, "上一条消息的验收口令是什么？请准确复述。")
    assert "FAMSUN-7319" in answer
    uploaded = request("POST", f"/api/sessions/{sid}/files", files={
        "file": ("production.csv", b"line,output\nA,120\nB,100\nA,240\n", "text/csv"),
    }).json()
    detail, events, answer = run(sid,
        "使用 Python 工具分析上传的 production.csv，按 line 汇总 output，报告总量。"
        "生成 outputs/summary.xlsx（列名 line,output，只有 A、B 两行汇总数据）和 outputs/production.png 柱状图。"
        "必须实际执行并检查文件，最后列出汇总结果与文件名。", [uploaded["id"]])
    assert '"name":"exec_command"' in events.replace(" ", "")
    assert "460" in answer
    files = {f["name"]: f for f in detail["files"] if f["kind"] == "output"}
    workbook = request("GET", files["summary.xlsx"]["url"] + "?download=true").content
    png = request("GET", files["production.png"]["url"] + "?download=true").content
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = struct.unpack(">II", png[16:24])
    assert width >= 300 and height >= 200
    with zipfile.ZipFile(io.BytesIO(workbook)) as archive:
        sheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        numeric = [float(c.find("s:v", ns).text) for c in sheet.findall(".//s:c", ns)
                   if c.get("t", "n") == "n" and c.find("s:v", ns) is not None]
        assert sorted(numeric) == [100, 360], numeric
    print("PASS: authorized Excel download values [100,360], total 460; PNG", width, height, flush=True)
    second = request("POST", "/api/sessions", json={"title": "真实 Excel 分析"}).json()["id"]
    excel = request("POST", f"/api/sessions/{second}/files", files={
        "file": ("summary.xlsx", workbook, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    }).json()
    _, _, answer = run(second, "实际使用 Python 读取上传的 Excel，报告各产线数值、总量和最大产线。", [excel["id"]])
    assert all(value in answer for value in ["360", "100", "460"])
    (root / "live-model-results.json").write_text(json.dumps({
        "evidence": evidence, "excel_values": numeric, "png_dimensions": [width, height],
        "session_ids": [sid, second], "artifacts": files,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
