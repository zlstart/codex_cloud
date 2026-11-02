"""Opt-in real Docker smoke: PYTHONPATH=backend python tests/docker_smoke.py.

No model or API credential is needed. Outputs are placed in a temporary
workspace and removed afterwards. This exercises the application's real adapter.
"""
import asyncio
import json
import tempfile
from pathlib import Path

from app.sandbox import DockerSandbox, SandboxError


async def main():
    with tempfile.TemporaryDirectory(prefix="famsun-docker-smoke-") as directory:
        workspace = Path(directory)
        (workspace / "uploads").mkdir()
        (workspace / "outputs").mkdir()
        (workspace / "uploads" / "production.csv").write_text(
            "line,output,energy\nA,120,50\nB,100,48\nA,130,52\nB,110,46\n"
        )
        runner = DockerSandbox(workspace, timeout=60)
        result = await runner.python('''
import json, os
from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
assert os.getuid() != 0
assert not os.getenv("AGENT_API_KEY") and not os.getenv("OPENAI_API_KEY")
assert "0000000000000000" in next(x for x in Path("/proc/self/status").read_text().splitlines() if x.startswith("CapEff:"))
assert set(Path("/sys/class/net").iterdir()) == {Path("/sys/class/net/lo")}
try:
    Path("/usr/readonly-proof").write_text("must fail")
    raise AssertionError("root filesystem writable")
except OSError:
    pass
try:
    Path("uploads/production.csv").write_text("must fail")
    raise AssertionError("uploaded input writable")
except OSError:
    pass
data = pd.read_csv("uploads/production.csv")
summary = data.groupby("line").sum()
summary.to_excel("outputs/analysis.xlsx")
summary["output"].plot.bar(color="#ff8614")
plt.tight_layout()
plt.savefig("outputs/chart.png")
Path("outputs/summary.json").write_text(summary.to_json())
print(json.dumps({"rows": len(data), "total": int(data.output.sum()), "isolated": True}))
''', asyncio.Event())
        assert result.exit_code == 0, result.stderr
        assert json.loads(result.stdout)["total"] == 460, result.stdout
        assert (workspace / "outputs/chart.png").read_bytes().startswith(b"\x89PNG")
        assert (workspace / "outputs/analysis.xlsx").read_bytes().startswith(b"PK")
        print("PASS: actual pandas analysis, Excel output, PNG chart, non-root, read-only inputs/root, no network, no API keys")

        cancellation = asyncio.Event()
        task = asyncio.create_task(runner.python("import time; time.sleep(90)", cancellation))
        await asyncio.sleep(1)
        cancellation.set()
        try:
            await task
            raise AssertionError("Cancellation did not interrupt execution")
        except asyncio.CancelledError:
            print("PASS: running container cancellation")

        limited = DockerSandbox(workspace, timeout=1)
        try:
            await limited.python("import time; time.sleep(90)", asyncio.Event())
            raise AssertionError("Timeout did not interrupt execution")
        except SandboxError as exc:
            assert "超过" in str(exc), str(exc)
            print("PASS: execution deadline")


if __name__ == "__main__":
    asyncio.run(main())
