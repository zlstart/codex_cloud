"""SDK native tool completions trigger current-output inventory reconciliation."""

from test_provider_protocol import harness as harness  # noqa: PLC0414
from test_provider_protocol import message, response_sse


async def test_native_patch_deletion_triggers_scan_and_rediscovery(harness):
    execute, _, events, root = harness

    def patch(text, call_id):
        return {"type": "custom_tool_call", "name": "apply_patch", "input": text,
                "id": call_id, "call_id": call_id, "status": "completed"}

    def provider(body, sequence):
        if sequence in (1, 3):
            text = "*** Begin Patch\n*** Add File: outputs/recreated.txt\n+same bytes\n*** End Patch"
            return response_sse([patch(text, f"create-{sequence}")], f"response-{sequence}")
        if sequence == 2:
            text = "*** Begin Patch\n*** Delete File: outputs/recreated.txt\n*** End Patch"
            return response_sse([patch(text, "delete")], "response-delete")
        return response_sse([message("Done")], "response-final")

    assert await execute(provider) == "Done"
    deleted = next(i for i, (name, data) in enumerate(events)
                   if name == "tool.completed" and data["call_id"] == "delete")
    recreated = next(i for i, (name, data) in enumerate(events)
                     if name == "tool.started" and data["call_id"] == "create-3")
    assert any(name == "artifacts.scanned" for name, _ in events[deleted:recreated])
    assert (root / "workspace/outputs/recreated.txt").read_text().strip() == "same bytes"
    assert sum(name == "artifact.discovered" for name, _ in events) == 2
