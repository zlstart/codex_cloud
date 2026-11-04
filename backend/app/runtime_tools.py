"""Keep SDK tool execution intact while exposing its errors to the product timeline."""

from agents.sandbox.capabilities.filesystem import FilesystemToolSet
from agents.tool import CustomToolCustomDataContext
from agents.tool_context import ToolContext


def configure_filesystem_tools(toolset: FilesystemToolSet) -> None:
    # SDK 0.24 catches CustomTool exceptions but returns only their text, without
    # an outcome field. Observe the exception before that catch, then use its
    # public metadata hook; never guess failure from user-controlled output text.
    patch = toolset.apply_patch
    invoke = patch.on_invoke_tool
    failed_calls: set[str] = set()

    async def observed_invoke(context: ToolContext, raw_input: str) -> str:
        try:
            return await invoke(context, raw_input)
        except Exception:
            failed_calls.add(context.tool_call_id)
            raise

    def display_data(context: CustomToolCustomDataContext) -> dict:
        call_id = context.tool_context.tool_call_id
        if call_id in failed_calls:
            failed_calls.remove(call_id)
            return {"famsun_tool_status": "failed"}
        return {}

    patch.on_invoke_tool = observed_invoke
    patch.custom_data_extractor = display_data
