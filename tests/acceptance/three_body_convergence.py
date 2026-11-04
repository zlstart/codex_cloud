"""Verify real convergence output with independently implemented dynamics."""

import csv
import hashlib
import json
import math
import os
from pathlib import Path

from three_body_numeric import INITIAL, angular, com, energy, rk4

root = Path(os.environ.get("FAMSUN_TEST_OUTPUT", "test-results/three-body")).resolve()
producer = json.loads((root / "followup/convergence.json").read_text())
with (root / "downloads/three_body.csv").open() as f:
    rows = {round(float(r["t"]), 8): {k: float(v) for k, v in r.items()} for r in csv.DictReader(f)}
checks = {}


def check(name, passed, detail=None):
    checks[name] = {"passed": bool(passed), "detail": detail}


check("three_step_sizes", [r["dt"] for r in producer["runs"]] == [0.001, 0.0005, 0.00025])
check("comparison_times", producer["comparison_times"] == [0, 3.16, 6.32, 9.48, 12.65])
check(
    "same_initial_parameters",
    producer["original_run_parameters"]["initial_positions"] == [INITIAL[0:2], INITIAL[2:4], INITIAL[4:6]]
    and producer["original_run_parameters"]["initial_velocities"]
    == [INITIAL[6:8], INITIAL[8:10], INITIAL[10:12]],
)
for name, before in producer["source_files_sha256_before"].items():
    actual = hashlib.sha256((root / "downloads" / name).read_bytes()).hexdigest()
    check("sha256_" + name, actual == before == producer["source_files_sha256_after"][name])
reference_runs = []
for run in producer["runs"]:
    h = run["dt"]
    state = INITIAL[:]
    times = producer["comparison_times"]
    indices = {round(t / h): t for t in times}
    e0 = energy(state)
    l0 = angular(state)
    summary = {
        "dt": h,
        "max_relative_energy_error": 0.0,
        "max_absolute_angular_momentum_error": 0.0,
        "max_center_of_mass_norm": 0.0,
        "per_time": [],
    }
    for step in range(round(12.65 / h) + 1):
        summary["max_relative_energy_error"] = max(
            summary["max_relative_energy_error"], abs(energy(state) - e0) / abs(e0)
        )
        summary["max_absolute_angular_momentum_error"] = max(
            summary["max_absolute_angular_momentum_error"], abs(angular(state) - l0)
        )
        summary["max_center_of_mass_norm"] = max(summary["max_center_of_mass_norm"], com(state))
        if step in indices:
            t = indices[step]
            row = rows[t]
            csvstate = [row[f"{k}{i}"] for i in range(1, 4) for k in ("x", "y")] + [
                row[f"{k}{i}"] for i in range(1, 4) for k in ("vx", "vy")
            ]
            summary["per_time"].append(
                {
                    "t": t,
                    "max_abs_position_diff": max(abs(a - b) for a, b in zip(state[:6], csvstate[:6])),
                    "max_abs_velocity_diff": max(abs(a - b) for a, b in zip(state[6:], csvstate[6:])),
                }
            )
        if step < round(12.65 / h):
            state = rk4(state, h)
    for name in [
        "max_relative_energy_error",
        "max_absolute_angular_momentum_error",
        "max_center_of_mass_norm",
    ]:
        check(
            f"dt_{h}_{name}",
            summary[name] < 1e-10 and abs(summary[name] - run[name]) < 5e-12,
            {"independent": summary[name], "producer": run[name]},
        )
    comp = next(c for c in producer["comparison_summary"]["against_original_csv"] if c["dt"] == h)
    for expected, actual in zip(comp["per_time"], summary["per_time"]):
        for name in ["max_abs_position_diff", "max_abs_velocity_diff"]:
            check(
                f"dt_{h}_t_{actual['t']}_{name}",
                abs(expected[name] - actual[name]) < 1e-12,
                {"independent": actual[name], "producer": expected[name]},
            )
    reference_runs.append(summary)
pairs = producer["comparison_summary"]["between_step_sizes"]
ratios = producer["comparison_summary"]["error_ratio_h_vs_h2_over_h2_vs_h4"]
orders = producer["comparison_summary"]["apparent_order"]
for i, name in enumerate(["max_abs_position_diff", "max_abs_velocity_diff"]):
    ratio = pairs[0][name] / pairs[1][name]
    check("reported_ratio_" + name, abs(ratio - ratios[i]["ratio_h_to_h2_over_h2_to_h4"]) < 0.002)
    check(
        "reported_order_" + name,
        abs(math.log2(ratio) - orders[i]["apparent_order_p_in_diff_scales_like_h_p"]) < 0.001,
    )
result = {
    "independent_method": "pure Python Newtonian-force RK4, all integration steps and all 15 requested comparison states independently recomputed",
    "checks": checks,
    "independent_runs": reference_runs,
    "numeric_pass": all(c["passed"] for c in checks.values()),
    "narrative_issue": {
        "original_json_field": "conclusion.practical_verdict",
        "issue": "The 5.8616e-13 difference belongs to dt=0.0005 vs 0.00025, but this sentence labels it h vs h/4; the numerical tables and final assistant explanation correctly describe adjacent-step differences.",
        "correction_pending": True,
    },
}
(root / "convergence-verification.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(
    json.dumps(
        {
            "numeric_pass": result["numeric_pass"],
            "checks": len(checks),
            "failed": [k for k, v in checks.items() if not v["passed"]],
        }
    )
)
raise SystemExit(0 if result["numeric_pass"] else 1)
