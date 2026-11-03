import pytest


async def test_sdk_history_seeds_legacy_once_and_preserves_tool_pairs(tmp_path):
    from app import runtime_history

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    messages = [
        {"role": "system", "content": "not trusted"},
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "new question"},
    ]
    async with runtime_history.open_history(
        state_dir=tmp_path / "history",
        workspace=workspace,
        user_id="alice",
        session_id="chat",
        messages=messages,
    ) as (session, current):
        assert current == "new question"
        assert await session.get_items() == messages[1:3]
        await session.add_items(
            [
                {"role": "user", "content": current},
                {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "call_1", "output": "actual result"},
                {"role": "assistant", "content": "done"},
            ]
        )
    messages += [{"role": "assistant", "content": "done"}, {"role": "user", "content": "follow up"}]
    async with runtime_history.open_history(
        state_dir=tmp_path / "history",
        workspace=workspace,
        user_id="alice",
        session_id="chat",
        messages=messages,
    ) as (session, current):
        assert current == "follow up"
        items = await session.get_items()
        assert len(items) == 6
        assert items[-2]["output"] == "actual result"
        assert sum(item.get("content") == "old question" for item in items) == 1


async def test_history_isolated_by_both_user_and_chat(tmp_path):
    from app import runtime_history

    async def history(user, chat):
        return runtime_history.open_history(
            state_dir=tmp_path / "history",
            workspace=tmp_path / "workspace",
            user_id=user,
            session_id=chat,
            messages=[{"role": "user", "content": "hello"}],
        )

    async with await history("alice", "chat") as (session, _):
        await session.add_items([{"role": "assistant", "content": "private"}])
    for user, chat in [("bob", "chat"), ("alice", "other")]:
        async with await history(user, chat) as (session, _):
            assert await session.get_items() == []
    assert not (tmp_path / "workspace").exists()


@pytest.mark.parametrize(
    "state,user,chat",
    [
        ("workspace/history", "alice", "chat"),
        ("history", "../alice", "chat"),
        ("history", "alice", "../chat"),
    ],
)
async def test_history_rejects_model_visible_storage_and_path_escape(tmp_path, state, user, chat):
    from app import runtime_history

    with pytest.raises(ValueError):
        async with runtime_history.open_history(
            state_dir=tmp_path / state,
            workspace=tmp_path / "workspace",
            user_id=user,
            session_id=chat,
            messages=[{"role": "user", "content": "hello"}],
        ):
            pytest.fail("unsafe history store was opened")
