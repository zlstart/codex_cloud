"""Independent real-output three-body physics and ordered event acceptance.
No provider mocks; no imports from, or changes to, model-generated code.
"""

import csv
import itertools
import json
import math
import os
import re
from pathlib import Path

from three_body_numeric import HEADERS, INITIAL, angular, com, energy, rk4

ROOT = Path(os.environ.get("FAMSUN_TEST_OUTPUT", "test-results/three-body")).resolve()
FILES = ROOT / "downloads"


report = {
    "source": "downloaded real-provider generated CSV",
    "independent_method": "independent pure Python Newtonian-force RK4; dt=0.0001, tenfold smaller than requested producer dt",
    "checks": {},
    "failures": [],
}


def check(name, passed, detail=None):
    report["checks"][name] = {"passed": bool(passed), "detail": detail}
    if not passed:
        report["failures"].append(name)


with (FILES / "three_body.csv").open() as f:
    reader = csv.DictReader(f)
    check("exact_csv_columns", reader.fieldnames == HEADERS, reader.fieldnames)
    rows = [{k: float(v) for k, v in r.items()} for r in reader]
times = [r["t"] for r in rows]
states = [
    [r[f"{k}{i}"] for i in range(1, 4) for k in ("x", "y")]
    + [r[f"{k}{i}"] for i in range(1, 4) for k in ("vx", "vy")]
    for r in rows
]
check("sample_count_at_least_1000", len(rows) >= 1000, len(rows))
check("finite_csv", all(math.isfinite(v) for r in rows for v in r.values()))
check("time_endpoints", abs(times[0]) < 1e-12 and abs(times[-1] - 12.65) < 1e-10, [times[0], times[-1]])
check("monotonic_time", all(b > a for a, b in itertools.pairwise(times)))
spacing = (times[-1] - times[0]) / (len(times) - 1)
check("uniform_samples", max(abs(b - a - spacing) for a, b in itertools.pairwise(times)) < 1e-9, spacing)
check("specified_initial_conditions", max(abs(a - b) for a, b in zip(states[0], INITIAL)) < 1e-10, states[0])
e0 = energy(INITIAL)
l0 = angular(INITIAL)
energies = [energy(s) for s in states]
summary = {
    "sample_count": len(rows),
    "initial_energy": energies[0],
    "max_relative_energy_error": max(abs(e - e0) / abs(e0) for e in energies),
    "initial_angular_momentum": angular(states[0]),
    "max_absolute_angular_momentum_error": max(abs(angular(s) - l0) for s in states),
    "max_center_of_mass_norm": max(com(s) for s in states),
    "minimum_pair_distance_csv_samples": min(
        math.hypot(s[2 * i] - s[2 * j], s[2 * i + 1] - s[2 * j + 1])
        for s in states
        for i, j in ((0, 1), (0, 2), (1, 2))
    ),
}
report["recomputed_from_csv"] = summary
check(
    "energy_conservation", summary["max_relative_energy_error"] < 1e-7, summary["max_relative_energy_error"]
)
check(
    "angular_momentum_conservation",
    summary["max_absolute_angular_momentum_error"] < 1e-8,
    summary["max_absolute_angular_momentum_error"],
)
check(
    "center_of_mass_conservation",
    summary["max_center_of_mass_norm"] < 1e-8,
    summary["max_center_of_mass_norm"],
)
check(
    "noncollision",
    summary["minimum_pair_distance_csv_samples"] > 0.01,
    summary["minimum_pair_distance_csv_samples"],
)
reference = INITIAL[:]
now = 0.0
errors = []
selected = sorted({round((len(rows) - 1) * i / 50) for i in range(51)})
for idx in selected:
    goal = times[idx]
    while now < goal - 1e-12:
        h = min(0.0001, goal - now)
        reference = rk4(reference, h)
        now += h
    errors.append(
        {
            "sample_index": idx,
            "t": goal,
            "max_position_error": max(abs(a - b) for a, b in zip(reference[:6], states[idx][:6])),
            "max_velocity_error": max(abs(a - b) for a, b in zip(reference[6:], states[idx][6:])),
        }
    )
report["independent_integration_samples"] = errors
maxpos = max(r["max_position_error"] for r in errors)
maxvel = max(r["max_velocity_error"] for r in errors)
check(
    "independent_trajectory_agreement",
    maxpos < 1e-5 and maxvel < 1e-5,
    {
        "sample_count": len(errors),
        "max_position_error": maxpos,
        "max_velocity_error": maxvel,
        "threshold": 1e-5,
    },
)
metrics = json.loads((FILES / "metrics.json").read_text())
report["producer_metrics"] = metrics
for k in [
    "G",
    "masses",
    "method",
    "dt",
    "t_start",
    "t_end",
    "sample_count",
    "initial_positions",
    "initial_velocities",
    "initial_energy",
    "max_relative_energy_error",
    "initial_angular_momentum",
    "max_absolute_angular_momentum_error",
    "max_center_of_mass_norm",
    "minimum_pair_distance",
]:
    check("metric_field_" + k, k in metrics)
check("metrics_sample_count", metrics.get("sample_count") == len(rows), metrics.get("sample_count"))
check(
    "metrics_dt",
    isinstance(metrics.get("dt"), (int, float)) and 0 < metrics["dt"] <= 0.001,
    metrics.get("dt"),
)
check(
    "metrics_energy_matches_csv",
    abs(metrics.get("initial_energy", math.inf) - e0) < 1e-9,
    {"reported": metrics.get("initial_energy"), "csv": e0},
)
for name, tol in [
    ("max_relative_energy_error", 5e-8),
    ("max_absolute_angular_momentum_error", 5e-9),
    ("max_center_of_mass_norm", 1e-9),
]:
    val = metrics.get(name, math.inf)
    check(
        "metrics_" + name + "_consistent",
        math.isfinite(val) and abs(val - summary[name]) <= tol,
        {
            "reported": val,
            "csv": summary[name],
            "absolute_tolerance": tol,
            "note": "CSV is sampled and rounded to 9 decimal places; strict full-precision metric verification follows separately",
        },
    )
check(
    "metrics_minimum_distance_consistent",
    abs(metrics.get("minimum_pair_distance", math.inf) - summary["minimum_pair_distance_csv_samples"])
    < 0.001,
    {"producer": metrics.get("minimum_pair_distance"), "csv": summary["minimum_pair_distance_csv_samples"]},
)
# Recompute every production-size integration step independently, before rounding,
# so precision tolerances above cannot conceal incorrect metrics.json claims.
full_state = INITIAL[:]
full_metrics = {
    "max_relative_energy_error": 0.0,
    "max_absolute_angular_momentum_error": 0.0,
    "max_center_of_mass_norm": 0.0,
    "minimum_pair_distance": math.inf,
}
for step in range(12651):
    full_metrics["max_relative_energy_error"] = max(
        full_metrics["max_relative_energy_error"], abs(energy(full_state) - e0) / abs(e0)
    )
    full_metrics["max_absolute_angular_momentum_error"] = max(
        full_metrics["max_absolute_angular_momentum_error"], abs(angular(full_state) - l0)
    )
    full_metrics["max_center_of_mass_norm"] = max(full_metrics["max_center_of_mass_norm"], com(full_state))
    full_metrics["minimum_pair_distance"] = min(
        full_metrics["minimum_pair_distance"],
        *(
            math.hypot(full_state[2 * i] - full_state[2 * j], full_state[2 * i + 1] - full_state[2 * j + 1])
            for i, j in ((0, 1), (0, 2), (1, 2))
        ),
    )
    if step < 12650:
        full_state = rk4(full_state, 0.001)
report["independent_full_precision_producer_step_metrics"] = full_metrics
for name, value in full_metrics.items():
    tolerance = 1e-10 if name == "minimum_pair_distance" else 5e-12
    check(
        "full_precision_metric_" + name,
        abs(metrics.get(name, math.inf) - value) < tolerance,
        {"reported": metrics.get(name), "independent": value, "tolerance": tolerance},
    )
html = (FILES / "three_body.html").read_text()
embedded_data_match = re.search(r"const DATA = (.+);\nconst METRICS = ", html)
check("html_embedded_data_present", embedded_data_match is not None)
if embedded_data_match:
    embedded = json.loads(embedded_data_match.group(1))
    check("html_csv_columns_match", embedded.get("columns") == HEADERS)
    embedded_rows = embedded.get("rows", [])
    check("html_csv_sample_count_match", len(embedded_rows) == len(rows), len(embedded_rows))
    embedded_error = max(
        (
            abs(value - row[column])
            for erow, row in zip(embedded_rows, rows)
            for column, value in zip(HEADERS, erow)
        ),
        default=math.inf,
    )
    check("html_embedded_values_match_csv", embedded_error == 0, embedded_error)
check(
    "html_self_contained_resources",
    not re.search(r"(?:src|href)\s*=\s*[\"\'](?:https?:)?//", html, re.IGNORECASE),
)
check("producer_script_retained", (FILES / "simulate_three_body.py").is_file())
report["overall_pass"] = not report["failures"]
(ROOT / "physics-verification.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
print(
    json.dumps(
        {
            "overall_pass": report["overall_pass"],
            "failures": report["failures"],
            "recomputed": summary,
            "max_reference_position_error": maxpos,
            "max_reference_velocity_error": maxvel,
        },
        ensure_ascii=False,
    )
)
raise SystemExit(0 if report["overall_pass"] else 1)
