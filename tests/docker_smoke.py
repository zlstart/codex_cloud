"""Real SDK Docker smoke: PYTHONPATH=backend python tests/docker_smoke.py.

No model is called. Build sandbox/Dockerfile first. Verifies native tools,
isolation, persistent files, cancellation and outbound HTTPS with TLS.
"""
import asyncio
import io
import os
import re
import tempfile
import uuid
from pathlib import Path

import docker
from agents import RunContextWrapper
from agents.sandbox.capabilities import Filesystem, Shell
from agents.sandbox.capabilities.tools import ExecCommandArgs, ViewImageArgs, WriteStdinArgs
from app.sandbox import SandboxError
from app.sdk_sandbox import build_skills, open_chat_sandbox


def assert_removed(client, *chat_ids):
    for chat_id in chat_ids:
        assert client.containers.list(all=True, filters={"label": f"famsun.chat={chat_id}"}) == []


async def main():
    if os.getenv("CODEX_PROXY_CERT"):
        os.environ.setdefault("FAMSUN_SANDBOX_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt")
    token = uuid.uuid4().hex
    chat_a, chat_b = f"smoke-a-{token}", f"smoke-b-{token}"
    client = docker.from_env()
    try:
        with tempfile.TemporaryDirectory(prefix="famsun-native-smoke-") as directory:
            root = Path(directory)
            first, second = root / "chat-a", root / "chat-b"
            for workspace in (first, second):
                (workspace / "uploads").mkdir(parents=True)
                (workspace / "outputs").mkdir()
            (first / "uploads/production.csv").write_text(
                "line,output,energy\nA,120,50\nB,100,48\nA,130,52\nB,110,46\n"
            )
            (second / "outputs/private.txt").write_text("other chat private")
            async with open_chat_sandbox(first, chat_id=chat_a, user_id="smoke-user") as session:
                shell = Shell()
                shell.bind(session)
                tools = {tool.name: tool for tool in shell.tools()}
                files = Filesystem()
                files.bind(session)
                file_tools = {tool.name: tool for tool in files.tools()}
                container = client.containers.get(session.state.container_id)
                host = container.attrs["HostConfig"]
                assert host["Memory"] == 512 * 1024 * 1024
                assert host["NanoCpus"] == 1_000_000_000 and host["PidsLimit"] == 64
                assert host["ReadonlyRootfs"] and host["NetworkMode"] != "none"
                assert "no-new-privileges:true" in host["SecurityOpt"]
                assert "ALL" in host["CapDrop"]
                assert container.attrs["Config"]["User"] != "0"
                await session.write(Path("outputs/native.txt"), io.BytesIO(b"native SDK file IO"))
                with await session.read(Path("outputs/native.txt")) as stream:
                    assert stream.read() == b"native SDK file IO"
                patch = "*** Begin Patch\n*** Add File: outputs/patch.txt\n+native patch\n*** End Patch"
                patch_result = await file_tools["apply_patch"].on_invoke_tool(RunContextWrapper(None), patch)
                assert "patch.txt" in patch_result
                assert (first / "outputs/patch.txt").read_text().rstrip("\n") == "native patch"
                skill = build_skills([{"id": "data", "type": "skill", "name": "Data",
                                       "description": "Analyze files", "content": "# Data\nInspect inputs."}])
                session.state.manifest = skill.process_manifest(session.state.manifest)
                await session.apply_manifest()
                skill.bind(session)
                assert "Analyze files" in await skill.instructions(session.state.manifest)
                script = '''
import json, os, urllib.request
from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
assert os.getuid() != 0
assert not os.getenv("AGENT_API_KEY") and not os.getenv("OPENAI_API_KEY")
assert "0000000000000000" in next(x for x in Path("/proc/self/status").read_text().splitlines() if x.startswith("CapEff:"))
assert len(list(Path("/sys/class/net").iterdir())) > 1
for path in ("/usr/readonly-proof", "/workspace/uploads/production.csv"):
    try:
        Path(path).write_text("must fail")
    except OSError:
        pass
    else:
        raise AssertionError("protected path writable: " + path)
assert not Path("/var/run/docker.sock").exists()
data = pd.read_csv("uploads/production.csv")
summary = data.groupby("line").sum()
summary.to_excel("outputs/analysis.xlsx")
summary["output"].plot.bar(color="#ff8614")
plt.tight_layout()
plt.savefig("outputs/chart.png")
with urllib.request.urlopen("https://example.com", timeout=20) as response:
    assert response.status == 200
print(json.dumps({"rows": len(data), "total": int(data.output.sum()), "network": "HTTPS verified"}))
'''
                await session.write(Path("outputs/analyze.py"), io.BytesIO(script.encode()))
                execution = await tools["exec_command"].run(ExecCommandArgs(
                    cmd="python outputs/analyze.py", yield_time_ms=10000, max_output_tokens=1000,
                ))
                process = re.search(r"Process running with session ID (\d+)", execution)
                while process:
                    execution = await tools["write_stdin"].run(WriteStdinArgs(
                        session_id=int(process.group(1)), chars="", yield_time_ms=1000, max_output_tokens=1000,
                    ))
                    process = re.search(r"Process running with session ID (\d+)", execution)
                assert '"total": 460' in execution and "code 0" in execution, execution
                image = await file_tools["view_image"].run(ViewImageArgs(path="outputs/chart.png"))
                assert image.image_url.startswith("data:image/png;base64,")
                assert (first / "outputs/analysis.xlsx").read_bytes().startswith(b"PK")
                async with open_chat_sandbox(second, chat_id=chat_b, user_id="smoke-other") as other:
                    isolated = await other.exec("test ! -e /workspace/outputs/native.txt", shell=True)
                    assert isolated.exit_code == 0
                    host_path = await session.exec("test", "!", "-e", str(second), shell=False)
                    assert host_path.exit_code == 0
                print("PASS: native exec/patch/file/image/Skills, limits, isolated chats, outbound HTTPS")
            assert_removed(client, chat_a, chat_b)
            async with open_chat_sandbox(first, chat_id=chat_a, user_id="smoke-user") as session:
                with await session.read(Path("outputs/native.txt")) as stream:
                    assert stream.read() == b"native SDK file IO"
                assert list((first / ".famsun-skills").iterdir()) == []
            assert_removed(client, chat_a)
            print("PASS: persistent files, refreshed skill staging, removed containers")
            started = asyncio.Event()
            async def running_task():
                async with open_chat_sandbox(first, chat_id=chat_a, user_id="smoke-user") as session:
                    await session.pty_exec_start("sleep 90", yield_time_s=0.1)
                    started.set()
                    await asyncio.Event().wait()
            task = asyncio.create_task(running_task())
            await asyncio.wait_for(started.wait(), 15)
            task.cancel()
            try:
                await asyncio.wait_for(task, 25)
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("Expected cancellation")
            assert_removed(client, chat_a)
            print("PASS: cancellation terminates native PTY and removes container")
            old_limit = os.environ.get("MAX_SESSION_MB")
            os.environ["MAX_SESSION_MB"] = "1"
            try:
                async with asyncio.timeout(25):
                    try:
                        async with open_chat_sandbox(first, chat_id=chat_a, user_id="smoke-user") as session:
                            await session.pty_exec_start(
                                "python -c 'import time; "
                                'open("outputs/quota.bin", "wb").truncate(2 * 1024 * 1024); '
                                "time.sleep(90)'", yield_time_s=0.1,
                            )
                            await asyncio.Event().wait()
                    except SandboxError as exc:
                        assert "容量" in str(exc)
                    else:
                        raise AssertionError("Workspace quota did not interrupt the running command")
                assert_removed(client, chat_a)
                print("PASS: aggregate quota stops native execution and removes container")
            finally:
                if old_limit is None:
                    os.environ.pop("MAX_SESSION_MB", None)
                else:
                    os.environ["MAX_SESSION_MB"] = old_limit
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
