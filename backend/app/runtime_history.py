"""Trusted local SDK history; browser messages are only the legacy migration input.

The SDK owns item serialization, ordering and tool-call pairs. These databases
are deliberately outside the directory mounted into a model's sandbox.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from agents import SQLiteSession


def history_path(state_dir: Path, user_id: str, session_id: str) -> Path:
    if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) for value in (user_id, session_id)):
        raise ValueError("Invalid history identity")
    return Path(state_dir) / user_id / f"{session_id}.sqlite3"


@asynccontextmanager
async def open_history(
    *,
    state_dir: Path,
    workspace: Path,
    user_id: str,
    session_id: str,
    messages: list[dict],
) -> AsyncIterator[tuple[SQLiteSession, str]]:
    path = history_path(state_dir, user_id, session_id)
    if path.resolve().is_relative_to(workspace.resolve()):
        raise ValueError("Conversation history must be outside the model workspace")
    if path.is_symlink() or path.parent.is_symlink() or Path(state_dir).is_symlink():
        raise ValueError("Conversation history cannot use symbolic links")
    legacy = [
        {"role": item["role"], "content": str(item.get("content", ""))}
        for item in messages
        if item.get("role") in {"user", "assistant"}
    ]
    user_indices = [index for index, item in enumerate(legacy) if item["role"] == "user"]
    if not user_indices:
        raise ValueError("A new user message is required")
    current_index = user_indices[-1]
    if current_index != len(legacy) - 1:
        raise ValueError("The latest message must be the new user input")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    session = SQLiteSession(f"{user_id}:{session_id}", path)
    try:
        # One-time migration. Once the SDK has items it is the history authority;
        # replaying the UI transcript would discard tools and duplicate user turns.
        if not await session.get_items(limit=1) and current_index:
            await session.add_items(legacy[:current_index])
        yield session, legacy[current_index]["content"]
    finally:
        await asyncio.to_thread(session.close)
