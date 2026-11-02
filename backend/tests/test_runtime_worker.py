"""The API loop must remain responsive across native Docker lifecycle I/O."""

import asyncio
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from app import runtime_worker
from app.runtime_worker import run_agent_in_worker


def install(monkeypatch, runtime):
    monkeypatch.setitem(sys.modules, "app.runtime", SimpleNamespace(run_agent=runtime))


async def invoke(tmp_path, **overrides):
    async def emit(*_):
        pass

    async def approve(*_):
        return True

    arguments = {
        "config": SimpleNamespace(), "workspace": tmp_path, "messages": [], "emit": emit,
        "request_approval": approve, "cancel_event": asyncio.Event(),
    }
    return await run_agent_in_worker(**(arguments | overrides))


@pytest.mark.asyncio
async def test_blocking_native_startup_and_cleanup_leave_api_heartbeat_running(monkeypatch, tmp_path):
    phase = [""]
    ticks = {"startup": 0, "cleanup": 0}
    api_thread = threading.get_ident()

    async def runtime(**_):
        assert threading.get_ident() != api_thread
        phase[0] = "startup"
        time.sleep(0.25)  # noqa: ASYNC251 - reproduce the SDK's synchronous Docker I/O.
        await asyncio.sleep(0)
        phase[0] = "cleanup"
        time.sleep(0.25)  # noqa: ASYNC251 - reproduce blocking native cleanup.
        return "done"

    install(monkeypatch, runtime)
    task = asyncio.create_task(invoke(tmp_path))
    while not task.done():
        await asyncio.sleep(0.01)
        if phase[0]:
            ticks[phase[0]] += 1
    assert await task == "done"
    assert ticks["startup"] >= 5 and ticks["cleanup"] >= 5


@pytest.mark.asyncio
async def test_long_runtime_does_not_starve_api_default_executor(monkeypatch, tmp_path):
    ready = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    loop.set_default_executor(ThreadPoolExecutor(max_workers=1))

    async def runtime(*, emit, **_):
        await emit("ready", {})
        while not release.is_set():
            await asyncio.sleep(0.01)
        return "done"

    async def emit(*_):
        ready.set()

    install(monkeypatch, runtime)
    task = asyncio.create_task(invoke(tmp_path, emit=emit))
    try:
        await asyncio.wait_for(ready.wait(), 2)
        result = await asyncio.wait_for(asyncio.to_thread(lambda: "auth hash can run"), 0.5)
        assert result == "auth hash can run"
    finally:
        release.set()
        assert await task == "done"


@pytest.mark.asyncio
async def test_callbacks_run_on_api_loop_and_approval_resumes_once(monkeypatch, tmp_path):
    api_loop = asyncio.get_running_loop()
    api_event = asyncio.Event()
    approval_ready = asyncio.Event()
    approval = api_loop.create_future()
    calls = []

    async def runtime(*, emit, request_approval, cancel_event, **_):
        assert asyncio.get_running_loop() is not api_loop
        assert cancel_event is not api_event
        await emit("tool.started", {"call_id": "one"})
        assert await request_approval("mcp.send", {"text": "review"}) is True
        await emit("tool.completed", {"call_id": "one"})
        return "approved"

    async def emit(event, data):
        assert asyncio.get_running_loop() is api_loop
        calls.append(event)

    async def approve(tool, arguments):
        assert asyncio.get_running_loop() is api_loop
        calls.append(tool)
        approval_ready.set()
        return await approval

    install(monkeypatch, runtime)
    task = asyncio.create_task(invoke(tmp_path, emit=emit, request_approval=approve, cancel_event=api_event))
    await asyncio.wait_for(approval_ready.wait(), 2)
    assert calls == ["tool.started", "mcp.send"]
    approval.set_result(True)
    assert await task == "approved"
    assert calls == ["tool.started", "mcp.send", "tool.completed"]


@pytest.mark.asyncio
async def test_caller_cancellation_joins_native_and_approval_cleanup_once(monkeypatch, tmp_path):
    ready = asyncio.Event()
    cleanup_started = threading.Event()
    cleanup = []

    async def runtime(*, request_approval, **_):
        try:
            await request_approval("mcp.send", {})
        finally:
            cleanup_started.set()
            time.sleep(0.25)  # noqa: ASYNC251 - cleanup must finish despite repeated cancellation.
            await asyncio.sleep(0.01)
            cleanup.append("native")

    async def approve(*_):
        ready.set()
        try:
            await asyncio.Future()
        finally:
            await asyncio.sleep(0.02)
            cleanup.append("approval")

    install(monkeypatch, runtime)
    task = asyncio.create_task(invoke(tmp_path, request_approval=approve))
    await asyncio.wait_for(ready.wait(), 2)
    task.cancel()
    while not cleanup_started.is_set():
        await asyncio.sleep(0.005)
    assert not task.done()
    task.cancel()  # A repeated HTTP/shutdown cancellation must not interrupt cleanup.
    with pytest.raises(asyncio.CancelledError):
        await task
    assert sorted(cleanup) == ["approval", "native"]


@pytest.mark.asyncio
async def test_cancellation_before_worker_starts_does_not_orphan_a_later_run(monkeypatch, tmp_path):
    release = threading.Event()
    entered = []

    async def runtime(**_):
        entered.append(True)
        return "should not run"

    install(monkeypatch, runtime)
    with ThreadPoolExecutor(max_workers=1) as executor:
        executor.submit(release.wait)
        monkeypatch.setattr(runtime_worker, "_RUNTIME_EXECUTOR", executor)
        task = asyncio.create_task(invoke(tmp_path))
        try:
            await asyncio.sleep(0)  # The worker is queued behind the blocking job.
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
    assert entered == []


@pytest.mark.asyncio
async def test_api_cancel_event_reaches_worker_and_errors_propagate(monkeypatch, tmp_path):
    api_event, ready = asyncio.Event(), asyncio.Event()
    cleaned = []

    async def runtime(*, emit, cancel_event, **_):
        try:
            await emit("ready", {})
            await cancel_event.wait()
            await asyncio.Future()
        finally:
            cleaned.append(True)

    async def emit(*_):
        ready.set()

    install(monkeypatch, runtime)
    task = asyncio.create_task(invoke(tmp_path, cancel_event=api_event, emit=emit))
    await asyncio.wait_for(ready.wait(), 2)
    api_event.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cleaned == [True]

    error = RuntimeError("provider details stay for service redaction")

    async def failed(**_):
        raise error

    install(monkeypatch, failed)
    with pytest.raises(RuntimeError) as captured:
        await invoke(tmp_path)
    assert captured.value is error
