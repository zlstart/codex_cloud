"""Exercise native SDK patch error metadata, not text-based error guessing."""

from test_provider_protocol import harness as harness  # noqa: PLC0414 -- re-export pytest fixture
from test_provider_protocol import message, response_sse


async def test_native_patch_failure_is_marked_and_can_recover(harness):
    execute, requests, events, root = harness

    def patch(raw, identity):
        return {"type": "custom_tool_call", "name": "apply_patch", "input": raw,
                "id": identity, "call_id": identity, "status": "completed"}

    def provider(body, sequence):
        if sequence == 1:
            return response_sse([patch("*** Add File: outputs/recovered.txt\n+text", "bad-patch")])
        if sequence == 2:
            output = next(item for item in body["input"] if item.get("call_id") == "bad-patch"
                          and item.get("type") == "custom_tool_call_output")
            assert "must start" in output["output"]
            return response_sse([patch(
                "*** Begin Patch\n*** Add File: outputs/recovered.txt\n+recovered\n*** End Patch",
                "good-patch",
            )])
        return response_sse([message("恢复成功")])

    assert await execute(provider) == "恢复成功"
    completed = {data["call_id"]: data for kind, data in events if kind == "tool.completed"}
    assert completed["bad-patch"].get("status") == "failed"
    assert completed["good-patch"].get("status") != "failed"
    assert (root / "workspace/outputs/recovered.txt").read_text().strip() == "recovered"
    assert len(requests) == 3
