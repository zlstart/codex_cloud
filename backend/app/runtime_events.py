"""Translate SDK stream events into the application's ordered, replayable timeline.

The SDK owns execution; this adapter only assigns product event identities. It consumes
the public RawResponsesStreamEvent / RunItemStreamEvent interfaces from Agents 0.24.
Opaque compaction payloads and private reasoning never enter browser event storage.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from agents.mcp import MCPToolCustomDataContext

Emit = Callable[[str, dict], Awaitable[None]]
_DISPLAY_LIMIT = 30_000
_TRUNCATION_NOTICE = "\n\n[内容过长，显示已截断。]"


def mcp_tool_display_data(context: MCPToolCustomDataContext) -> dict:
    """Retain the SDK's MCP error signal without copying server metadata."""
    return {"famsun_tool_status": "failed"} if context.is_error is True else {}


def _bounded_text(text: str) -> str:
    if len(text) <= _DISPLAY_LIMIT:
        return text
    return text[: _DISPLAY_LIMIT - len(_TRUNCATION_NOTICE)] + _TRUNCATION_NOTICE


def _get(value: Any, key: str, default: Any = None) -> Any:
    return value.get(key, default) if isinstance(value, dict) else getattr(value, key, default)


def _message_text(raw: Any) -> str:
    return "".join(
        str(_get(part, "text", _get(part, "refusal", "")) or "")
        for part in (_get(raw, "content", []) or [])
        if _get(part, "type") in {"output_text", "refusal"}
    )


def _arguments(value: Any) -> Any:
    if not isinstance(value, str):
        return value if value is not None else {}
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return {"raw": _bounded_text(value)}


def _shell_chunk(part: Any) -> str:
    outcome = _get(part, "outcome", {})
    sections = []
    if _get(outcome, "type") == "exit":
        sections.append(f"Process exited with code {_get(outcome, 'exit_code')}")
    elif _get(outcome, "type") == "timeout":
        sections.append("Process stopped: timeout")
    for stream in ("stdout", "stderr"):
        content = _get(part, stream)
        if content:
            sections.append(f"{stream}:\n{content}")
    return "\n".join(sections)


def _output(value: Any, *, shell: bool = False) -> str:
    """Use model-facing text, without dumping inline image/file data into the UI."""
    if isinstance(value, str):
        return _bounded_text(value)
    if isinstance(value, list):
        texts = []
        for part in value:
            kind = _get(part, "type", "")
            if shell:
                texts.append(_shell_chunk(part))
            elif kind == "input_file":
                metadata = ["[文件内容已交给模型]"]
                for key, label in (("filename", "文件名"), ("file_id", "文件 ID")):
                    identifier = _get(part, key)
                    if isinstance(identifier, str) and identifier:
                        metadata.append(f"{label}: {identifier}")
                texts.append("\n".join(metadata))
            elif kind in {"input_image", "image"}:
                texts.append("[图片或文件内容已交给模型]")
            else:
                texts.append(str(_get(part, "text", "")))
        return _bounded_text("\n".join(texts))
    return _bounded_text(json.dumps(value, ensure_ascii=False, default=str))


@dataclass
class _Text:
    metadata: dict
    parts: dict[int, str] = field(default_factory=dict)
    completed_text: str | None = None
    phase: str = "intermediate"

    @property
    def text(self) -> str:
        return "".join(self.parts[index] for index in sorted(self.parts))


class RuntimeEvents:
    def __init__(self, emit: Emit, artifacts: Callable[[], Awaitable[None]] | None = None):
        self.emit = emit
        self.artifacts = artifacts
        self.final_item_ids: list[str] = []
        self._texts: dict[str, _Text] = {}
        self._calls: dict[str, dict] = {}
        self._completed_calls: set[str] = set()
        self._compactions: set[str] = set()
        self._raw_sequences: set[tuple[str, str, int]] = set()
        # Root and nested callbacks can arrive concurrently. One durable emit path
        # preserves observed order and keeps duplicate checks atomic across awaits.
        self._lock = asyncio.Lock()

    @staticmethod
    def _scope(identity: str, parent_call_id: str | None) -> str:
        return f"{parent_call_id}::{identity}" if parent_call_id else identity

    def _metadata(self, identity: str, agent_id: str, agent_name: str, parent_call_id: str | None) -> dict:
        return {
            "item_id": self._scope(identity, parent_call_id),
            "agent_id": agent_id,
            "agent_name": agent_name,
            "parent_call_id": parent_call_id,
        }

    async def _text(self, identity: str, agent_id: str, agent_name: str, parent_call_id: str | None) -> _Text:
        key = self._scope(identity, parent_call_id)
        if key not in self._texts:
            metadata = self._metadata(identity, agent_id, agent_name, parent_call_id)
            self._texts[key] = _Text(metadata)
            await self.emit("text.started", {**metadata, "phase": "intermediate"})
        return self._texts[key]

    async def _complete_text(
        self,
        identity: str,
        text: str,
        agent_id: str,
        agent_name: str,
        parent_call_id: str | None,
        *,
        preserve_parts: bool = False,
    ) -> None:
        state = await self._text(identity, agent_id, agent_name, parent_call_id)
        if state.completed_text != text:
            if not preserve_parts:
                state.parts = {0: text}
            state.completed_text = text
            await self.emit("text.completed", {**state.metadata, "text": text, "phase": state.phase})

    async def _start_tool(
        self,
        raw: Any,
        agent_id: str,
        agent_name: str,
        parent_call_id: str | None,
        resolved_name: str | None = None,
    ) -> None:
        raw_call_id = str(_get(raw, "call_id") or _get(raw, "id") or "")
        if not raw_call_id:
            return
        call_id = self._scope(raw_call_id, parent_call_id)
        if call_id in self._calls:
            return
        identity = str(_get(raw, "id") or raw_call_id)
        payload = {
            **self._metadata(identity, agent_id, agent_name, parent_call_id),
            "call_id": call_id,
            "name": resolved_name or _get(raw, "name") or "工具",
            "arguments": _arguments(_get(raw, "arguments", _get(raw, "input", {}))),
        }
        self._calls[call_id] = payload
        await self.emit("tool.started", payload)

    async def _complete_tool(
        self,
        raw: Any,
        agent_id: str,
        agent_name: str,
        parent_call_id: str | None,
        custom_data: Any = None,
    ) -> None:
        raw_call_id = str(_get(raw, "call_id") or _get(raw, "id") or "")
        if not raw_call_id:
            return
        call_id = self._scope(raw_call_id, parent_call_id)
        if call_id in self._completed_calls:
            return
        if call_id not in self._calls:
            await self._start_tool(raw, agent_id, agent_name, parent_call_id)
        self._completed_calls.add(call_id)
        payload = {
            **self._calls[call_id],
            "output": _output(_get(raw, "output", ""), shell=_get(raw, "type") == "shell_call_output"),
        }
        status = _get(raw, "status")
        if _get(raw, "type") == "shell_call_output" and status in (None, "completed"):
            for chunk in _get(raw, "output", []) or []:
                outcome = _get(chunk, "outcome", {})
                exit_code = _get(outcome, "exit_code")
                if _get(outcome, "type") == "timeout" or (
                    _get(outcome, "type") == "exit" and isinstance(exit_code, int) and exit_code != 0
                ):
                    status = "failed"
                    break
        if _get(custom_data, "famsun_tool_status") == "failed":
            status = "failed"
        if status in ("completed", "failed", "error", "cancelled"):
            payload["status"] = status
        await self.emit("tool.completed", payload)
        if self.artifacts:
            await self.artifacts()

    async def _compacted(self, raw: Any, agent_id: str, agent_name: str, parent_call_id: str | None) -> None:
        identity = str(_get(raw, "id") or "compaction")
        key = self._scope(identity, parent_call_id)
        if key not in self._compactions:
            self._compactions.add(key)
            await self.emit(
                "context.compacted", self._metadata(identity, agent_id, agent_name, parent_call_id)
            )

    async def consume(
        self,
        event: Any,
        *,
        agent_id: str = "main",
        agent_name: str = "Assistant",
        parent_call_id: str | None = None,
    ) -> None:
        async with self._lock:
            event_type = _get(event, "type")
            if event_type == "raw_response_event":
                await self._raw(_get(event, "data"), agent_id, agent_name, parent_call_id)
            elif event_type == "run_item_stream_event":
                item = _get(event, "item")
                raw = _get(item, "raw_item")
                kind = _get(item, "type")
                if kind == "message_output_item":
                    await self._complete_text(
                        str(_get(raw, "id")), _message_text(raw), agent_id, agent_name, parent_call_id
                    )
                elif kind in {"tool_call_item", "tool_search_call_item"}:
                    await self._start_tool(raw, agent_id, agent_name, parent_call_id, _get(item, "tool_name"))
                elif kind in {"tool_call_output_item", "tool_search_output_item"}:
                    await self._complete_tool(
                        raw, agent_id, agent_name, parent_call_id, _get(item, "custom_data")
                    )
                elif kind == "compaction_item":
                    await self._compacted(raw, agent_id, agent_name, parent_call_id)

    async def _raw(self, data: Any, agent_id: str, agent_name: str, parent_call_id: str | None) -> None:
        kind = _get(data, "type", "")
        raw = _get(data, "item")
        identity = str(_get(data, "item_id") or _get(raw, "id") or "")
        sequence = _get(data, "sequence_number")
        if isinstance(sequence, int) and identity:
            key = (self._scope(identity, parent_call_id), kind, sequence)
            if key in self._raw_sequences:
                return
            self._raw_sequences.add(key)
        if kind == "response.output_item.added" and _get(raw, "type") == "message":
            await self._text(identity, agent_id, agent_name, parent_call_id)
        elif kind in {"response.output_text.delta", "response.refusal.delta"} and identity:
            state = await self._text(identity, agent_id, agent_name, parent_call_id)
            delta = str(_get(data, "delta", ""))
            index = int(_get(data, "content_index", 0))
            state.parts[index] = state.parts.get(index, "") + delta
            await self.emit("text.delta", {**state.metadata, "delta": delta, "phase": state.phase})
        elif kind in {"response.output_text.done", "response.refusal.done"} and identity:
            state = await self._text(identity, agent_id, agent_name, parent_call_id)
            index = int(_get(data, "content_index", 0))
            state.parts[index] = str(_get(data, "text", _get(data, "refusal", "")))
            await self._complete_text(
                identity, state.text, agent_id, agent_name, parent_call_id, preserve_parts=True
            )
        elif kind == "response.output_item.done":
            item_type = _get(raw, "type")
            if item_type == "message":
                await self._complete_text(identity, _message_text(raw), agent_id, agent_name, parent_call_id)
            elif item_type in {"function_call", "custom_tool_call", "tool_search_call", "mcp_call"}:
                await self._start_tool(raw, agent_id, agent_name, parent_call_id)
            elif item_type == "compaction":
                await self._compacted(raw, agent_id, agent_name, parent_call_id)

    async def finalize(self, result: Any) -> list[str]:
        """Mark only the root result's final answer, never a specialist's answer."""
        async with self._lock:
            output = _get(result, "final_output")
            if output is None:
                return []
            final_text = str(output)
            candidates: list[tuple[str, str]] = []
            for item in _get(result, "new_items", []) or []:
                if _get(item, "type") != "message_output_item":
                    continue
                raw = _get(item, "raw_item")
                identity = str(_get(raw, "id") or "")
                # Nested stream IDs are scoped and cannot claim a root result.
                state = self._texts.get(identity)
                if state and state.metadata["parent_call_id"] is None:
                    candidates.append((identity, _message_text(raw)))
            matched = [identity for identity, text in candidates if text == final_text]
            if matched:
                identities = [matched[-1]]
            elif candidates and candidates[-1][1] == final_text:
                identities = [candidates[-1][0]]
            elif final_text:
                # Structured final outputs or providers without item events still
                # receive a stable final block instead of disappearing from replay.
                identity = "final-answer"
                await self._complete_text(identity, final_text, "main", "Assistant", None)
                identities = [identity]
            else:
                identities = []
            for identity in identities:
                state = self._texts[identity]
                if state.phase != "final":
                    state.phase = "final"
                    await self.emit("text.phase", {**state.metadata, "phase": "final"})
            self.final_item_ids = identities
            return list(identities)
