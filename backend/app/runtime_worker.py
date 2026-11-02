"""Keep SDK Docker lifecycle I/O off the API event loop.

SDK 0.24 uses synchronous docker-py calls inside async lifecycle methods. Each
run therefore owns a worker event loop for its entire native session lifetime;
only application callbacks cross back to the API loop. Cancellation joins that
lifetime, including native cleanup and executor shutdown, before returning.
"""

from __future__ import annotations

import asyncio
import contextvars
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .runtime import Approval, Emit, RuntimeConfig


# Long model runs must not occupy the API loop's default executor, which serves
# password hashing and other short application operations.
_RUNTIME_EXECUTOR = ThreadPoolExecutor(max_workers=16, thread_name_prefix="famsun-runtime")


class _Cancellation:
    def __init__(self):
        self.lock = threading.Lock()
        self.requested = False
        self.target = None

    def bind(self, loop, task, event) -> bool:
        with self.lock:
            self.target = (loop, task, event)
            return self.requested

    def request(self):
        with self.lock:
            if self.requested:
                return
            self.requested = True
            target = self.target
        if target is None:
            return
        loop, task, event = target

        def cancel():
            event.set()
            if not task.done():
                task.cancel()

        try:
            loop.call_soon_threadsafe(cancel)
        except RuntimeError:
            pass  # The worker finished and closed its loop before cancellation.


async def run_agent_in_worker(
    *, config: RuntimeConfig, workspace: Path, messages: list[dict], emit: Emit,
    cancel_event: asyncio.Event, request_approval: Approval,
) -> str:
    caller_loop = asyncio.get_running_loop()
    cancellation = _Cancellation()
    callbacks: set[asyncio.Task] = set()

    async def on_caller(callback, *args):
        async def invoke():
            task = asyncio.current_task()
            callbacks.add(task)
            try:
                return await callback(*args)
            finally:
                callbacks.discard(task)

        future = asyncio.run_coroutine_threadsafe(invoke(), caller_loop)
        return await asyncio.wrap_future(future)

    async def run():
        # Import here also preserves service tests' runtime replacement boundary.
        from .runtime import run_agent

        worker_cancel = asyncio.Event()
        if cancellation.bind(asyncio.get_running_loop(), asyncio.current_task(), worker_cancel):
            raise asyncio.CancelledError
        return await run_agent(
            config=config, workspace=workspace, messages=messages,
            emit=lambda *args: on_caller(emit, *args), cancel_event=worker_cancel,
            request_approval=lambda *args: on_caller(request_approval, *args),
        )

    async def watch_cancellation():
        await cancel_event.wait()
        cancellation.request()

    if cancel_event.is_set():
        cancellation.request()
    context = contextvars.copy_context()
    worker = caller_loop.run_in_executor(_RUNTIME_EXECUTOR, context.run, lambda: asyncio.run(run()))
    watcher = asyncio.create_task(watch_cancellation())

    async def shutdown():
        # Await the actual thread's return, not just the worker coroutine. The
        # shield at our caller prevents cancellation from abandoning the worker.
        await asyncio.gather(worker, return_exceptions=True)
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
        pending = tuple(callbacks)
        for callback in pending:
            if not callback.cancelling():
                callback.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        cancellation.request()
        raise
    finally:
        cleanup = asyncio.create_task(shutdown())
        interrupted = False
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                interrupted = True
                cancellation.request()
        cleanup.result()
        if interrupted:
            raise asyncio.CancelledError
