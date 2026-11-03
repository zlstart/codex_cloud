"""Application policy around the SDK's native OpenAI trace/export lifecycle.

Model credentials and trace credentials are deliberately separate. The SDK owns
span creation, batching and delivery; the application owns opt-in, identity and
the durable browser event. No prompt, file content or credential enters metadata.
"""

from __future__ import annotations

import hashlib
import os
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from agents import trace
from agents.tracing import gen_trace_id
from agents.tracing.traces import NoOpTrace

if TYPE_CHECKING:
    from .runtime import RuntimeConfig

@dataclass
class RunTrace:
    status: str
    trace_id: str | None
    workflow_name: str
    group_id: str
    metadata: dict[str, str]
    sensitive_data: bool = False
    api_key: str = field(default="", repr=False)

    def event(self) -> dict:
        """Safe for the existing owner-authorized event stream and history API."""
        return {
            "provider": "openai",
            "status": self.status,
            "trace_id": self.trace_id,
            "url": f"https://platform.openai.com/traces/trace?trace_id={self.trace_id}"
            if self.trace_id else None,
            "workflow_name": self.workflow_name,
            "sensitive_data": self.sensitive_data,
        }

    def run_config(self) -> dict:
        """Use identical SDK policy for the main runner and delegated agents."""
        return {
            "tracing_disabled": self.status != "enabled",
            "trace_include_sensitive_data": self.sensitive_data,
            "workflow_name": self.workflow_name,
            "trace_id": self.trace_id,
            "group_id": self.group_id,
            "trace_metadata": self.metadata,
            "tracing": {"api_key": self.api_key} if self.status == "enabled" else None,
        }


@contextmanager
def run_trace(config: RuntimeConfig):
    """Keep one native trace across approval pauses, resumes and child runners.

    The SDK batch processor exports on its own thread and flushes at process
    exit. Do not call blocking flush_traces() here: it has no deadline and can
    delay the result or cancellation of this run behind other workers' exports.
    The SDK does not acknowledge successful export to callers.
    """
    disabled = not config.tracing_enabled or os.getenv("OPENAI_AGENTS_DISABLE_TRACING", "").lower() in {
        "true", "1",
    }
    status = "disabled" if disabled else "enabled" if config.tracing_api_key else "missing_key"
    identity = (
        "trace_" + hashlib.sha256(f"famsun:run:{config.run_id}".encode()).hexdigest()[:32]
        if config.run_id else gen_trace_id()
    ) if status == "enabled" else None
    policy = RunTrace(
        status=status,
        trace_id=identity,
        workflow_name=config.tracing_workflow_name.strip() or "FAMSUN conversation",
        group_id=config.session_id,
        metadata={"run_id": config.run_id, "session_id": config.session_id, "user_id": config.user_id},
        sensitive_data=config.tracing_include_sensitive_data,
        api_key=config.tracing_api_key,
    )
    native = trace(
        policy.workflow_name,
        trace_id=identity,
        group_id=policy.group_id,
        metadata=policy.metadata,
        tracing={"api_key": policy.api_key} if status == "enabled" else None,
        disabled=status != "enabled",
    )
    if status == "enabled" and isinstance(native, NoOpTrace):
        # Also respect an administrator's SDK set_tracing_disabled(True).
        policy.status, policy.trace_id = "disabled", None
    with native:
        yield policy
