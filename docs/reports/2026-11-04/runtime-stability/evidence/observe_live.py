"""Read-only live-run evidence collection; stores no cookies or authentication state."""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import hashlib
import json
import math
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tests/acceptance"))
from three_body_numeric import HEADERS, INITIAL, angular, com, energy, rk4


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


def seconds(value):
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError, TypeError):
        return None


def duration(start, end):
    a, b = seconds(start), seconds(end)
    return round(b - a, 6) if a is not None and b is not None else None


def safe(value):
    text = str(value)
    text = re.sub(r"(?i)(authorization|cookie|api[_-]?key)(\s*[:=]\s*)([^\r\n]+)", r"\1\2[redacted]", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}", "[redacted key]", text)
    return text


def quantile(values, q):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, math.ceil(q * len(values)) - 1)]


def summarize_health(samples):
    def group(rows):
        latencies = [r["latency_ms"] for r in rows if r.get("ok")]
        return {
            "samples": len(rows), "successes": len(latencies), "failures": len(rows) - len(latencies),
            "min_ms": min(latencies, default=None), "median_ms": statistics.median(latencies) if latencies else None,
            "p95_ms": quantile(latencies, .95), "p99_ms": quantile(latencies, .99),
            "max_ms": max(latencies, default=None),
            "over_100_ms": sum(v > 100 for v in latencies), "over_500_ms": sum(v > 500 for v in latencies),
        }
    return {
        "started_at": samples[0]["at"] if samples else None,
        "ended_at": samples[-1]["at"] if samples else None,
        "overall": group(samples),
        "by_observed_run_state": {state: group([r for r in samples if r["run_state"] == state]) for state in sorted({r["run_state"] for r in samples})},
        "by_run_id": {run_id: group([r for r in samples if r.get("run_id") == run_id]) for run_id in sorted({r.get("run_id") for r in samples if r.get("run_id")})},
        "failed_samples": [r for r in samples if not r.get("ok")],
        "sampling_gaps_over_two_seconds": [{"from_at": a["at"], "to_at": b["at"], "seconds": duration(a["at"], b["at"])} for a, b in zip(samples, samples[1:]) if (duration(a["at"], b["at"]) or 0) > 2],
        "slowest_samples": sorted(samples, key=lambda r: r["latency_ms"], reverse=True)[:12],
        "limitations": ["Independent local unauthenticated /health requests; includes database read.", "Run state is observed from the browser harness report and may lag by its polling interval.", "Latency includes local client overhead and does not measure remote users or a deployment reverse proxy."],
    }


def monitor(args):
    args.root.mkdir(parents=True, exist_ok=True)
    samples = []
    started = time.monotonic()
    terminal_since = None
    next_log = started
    target = args.root / "health-samples.jsonl"
    if target.exists() and not args.resume:
        raise SystemExit(f"Refusing to overwrite existing evidence: {target}")
    if target.exists():
        samples = [json.loads(line) for line in target.read_text().splitlines() if line.strip()]
    with target.open("a" if args.resume else "w", buffering=1) as stream:
        while time.monotonic() - started < args.max_seconds:
            if (args.root / "stop-observer").exists():
                break
            reports = [(path, read_json(path / "report.json", {})) for path in [args.run, *args.follow_run]]
            source, report = max(reports, key=lambda pair: seconds(pair[1].get("submitted_at")) or 0.)
            status = report.get("status", "submitted" if report.get("run_id") else "before_submission")
            sample = {"at": utc(), "run_state": status, "run_id": report.get("run_id"), "observed_event_count": report.get("event_count"), "report_source": str(source)}
            before = time.perf_counter()
            try:
                with urllib.request.urlopen(args.url.rstrip("/") + "/health", timeout=args.timeout) as response:
                    body = json.loads(response.read(4096))
                    sample.update(http_status=response.status, ok=response.status == 200 and body.get("status") == "ok")
            except Exception as exc:
                sample.update(ok=False, error=safe(exc))
            sample["latency_ms"] = round((time.perf_counter() - before) * 1000, 3)
            stream.write(json.dumps(sample, ensure_ascii=False) + "\n")
            samples.append(sample)
            if time.monotonic() >= next_log:
                write_json(args.root / "health-summary.json", summarize_health(samples))
                print(json.dumps({"observer": "health", "samples": len(samples), "failures": sum(not s["ok"] for s in samples), "latest_ms": sample["latency_ms"], "state": status}), flush=True)
                next_log = time.monotonic() + 30
            if not args.keep_running and status in {"completed", "failed", "cancelled"}:
                terminal_since = terminal_since or time.monotonic()
                if time.monotonic() - terminal_since >= args.terminal_grace:
                    break
            remaining = args.interval - (time.perf_counter() - before)
            if remaining > 0:
                time.sleep(remaining)
    summary = summarize_health(samples)
    write_json(args.root / "health-summary.json", summary)
    print(json.dumps({"observer": "health_finished", **summary["overall"]}), flush=True)


def health_summary(args):
    samples = [json.loads(line) for line in (args.root / "health-samples.jsonl").read_text().splitlines() if line.strip()]
    result = summarize_health(samples)
    write_json(args.root / "health-summary.json", result)
    print(json.dumps(result["overall"]))


def analyze(args):
    report_path = args.report_file or args.run / "report.json"
    report = read_json(report_path, {})
    events = read_json(args.run / "events.json", [])
    run_state = read_json(args.run / "run-state.json", {})
    calls = {}
    errors = []
    completed_without_start = []
    duplicate_starts = []
    duplicate_completions = []
    text_parts = collections.defaultdict(str)
    for e in events:
        kind, data = e["type"], e.get("data", {})
        if kind == "tool.started":
            key = data.get("call_id")
            if key in calls:
                duplicate_starts.append(key)
            calls[key] = {
                "call_id": key, "name": data.get("name"), "agent_id": data.get("agent_id"),
                "parent_call_id": data.get("parent_call_id"), "started_at": e.get("created_at"),
                "start_sequence": e["sequence"], "arguments": data.get("arguments"),
            }
        elif kind == "tool.completed":
            key = data.get("call_id")
            if key not in calls:
                completed_without_start.append(key)
                calls[key] = {"call_id": key, "name": data.get("name")}
            call = calls[key]
            if call.get("completed_at"):
                duplicate_completions.append(key)
            output = safe(data.get("output", ""))
            call.update(completed_at=e.get("created_at"), complete_sequence=e["sequence"], explicit_status=data.get("status"), output=output)
            call["duration_seconds"] = duration(call.get("started_at"), call.get("completed_at"))
            codes = [int(n) for n in re.findall(r"Process exited with code (-?\d+)", output)]
            call["shell_exit_codes"] = codes
            call["reported_inner_exit_codes"] = [int(n) for n in re.findall(r"(?:^|\n)EXIT=(-?\d+)", output)]
            call["failed_assertion_lines"] = [line for line in output.splitlines() if re.match(r"FAIL\s", line)]
            call["status"] = data.get("status") or ("failed" if any(c != 0 for c in codes) else "completed")
            call["status_basis"] = "explicit event status" if data.get("status") else "completion event and shell output"
            call["has_traceback"] = "Traceback (most recent call last):" in output
            call["diagnostic_signals"] = [label for label, pattern in (("python_traceback", r"Traceback \(most recent call last\):"), ("missing_python_module", r"ModuleNotFoundError:"), ("syntax_error", r"SyntaxError:"), ("font_fallback_warning", r"findfont: Failed to find font")) if re.search(pattern, output)]
            if any(n != 0 for n in call["reported_inner_exit_codes"]):
                call["diagnostic_signals"].append("reported_inner_exit_nonzero")
            if call["failed_assertion_lines"]:
                call["diagnostic_signals"].append("failed_assertion_output")
        elif kind == "text.delta":
            text_parts[data.get("item_id")] += data.get("delta", "")
        elif kind == "text.completed":
            text_parts[data.get("item_id")] = data.get("text", "")
        if kind in {"run.failed", "error", "run.error"}:
            errors.append({"sequence": e["sequence"], "type": kind, "created_at": e.get("created_at"), "data": data})
    scopes = collections.defaultdict(list)
    for e in events:
        if e["type"] == "context.status":
            scopes[(e.get("data", {}).get("agent_id"), e.get("data", {}).get("parent_call_id"))].append(e)
    rounds = []
    for scope, boundaries in scopes.items():
        previous_sequence = 0
        previous_at = next((e.get("created_at") for e in events if e["type"] == "run.started"), events[0].get("created_at") if events else None)
        for i, e in enumerate(boundaries, 1):
            data = e["data"]
            relevant = [item for item in events if previous_sequence < item["sequence"] <= e["sequence"] and (item.get("data", {}).get("agent_id"), item.get("data", {}).get("parent_call_id")) == scope]
            round_calls = [c for c in calls.values() if previous_sequence < c.get("start_sequence", -1) <= e["sequence"] and (c.get("agent_id"), c.get("parent_call_id")) == scope]
            texts = [safe(item["data"].get("text", "")) for item in relevant if item["type"] == "text.completed"]
            rounds.append({
                "round": i, "agent_id": scope[0], "parent_call_id": scope[1], "response_id": data.get("response_id"),
                "context_status_sequence": e["sequence"], "response_completed_at": e.get("created_at"),
                "since_previous_response_seconds": duration(previous_at, e.get("created_at")),
                "input_tokens": data.get("input_tokens"), "threshold": data.get("threshold"),
                "context_status": data.get("status"), "compaction_count": data.get("compaction_count"),
                "event_count": len(relevant), "texts": texts, "tools": round_calls,
            })
            previous_sequence, previous_at = e["sequence"], e.get("created_at")
    sequences = [e["sequence"] for e in events]
    artifacts = [{"sequence": e["sequence"], "at": e.get("created_at"), "data": e.get("data")} for e in events if e["type"].startswith("artifact.")]
    missing = [c for c in calls.values() if not c.get("complete_sequence")]
    final_events = [e for e in events if e["type"] in {"text.finalized", "run.completed", "run.failed", "run.cancelled"} or (e["type"] == "text.phase" and e.get("data", {}).get("phase") == "final")]
    gaps = [{"from_sequence": a["sequence"], "from_type": a["type"], "from_at": a.get("created_at"), "to_sequence": b["sequence"], "to_type": b["type"], "to_at": b.get("created_at"), "seconds": duration(a.get("created_at"), b.get("created_at"))} for a, b in zip(events, events[1:])]
    merged_tool_spans = []
    for start, end in sorted((seconds(c["started_at"]), seconds(c["completed_at"])) for c in calls.values() if c.get("started_at") and c.get("completed_at")):
        if merged_tool_spans and start <= merged_tool_spans[-1][1]:
            merged_tool_spans[-1][1] = max(merged_tool_spans[-1][1], end)
        else:
            merged_tool_spans.append([start, end])
    tool_union = sum(end-start for start,end in merged_tool_spans)
    data = {
        "generated_at": utc(), "run_id": report.get("run_id"), "session_id": report.get("session_id"),
        "source_evidence": {"report": str(report_path), "events": str(args.run / "events.json"), "run_state": str(args.run / "run-state.json")},
        "provider": report.get("provider"), "status": run_state.get("status", report.get("status")),
        "duration_seconds": report.get("duration_seconds"), "event_count": len(events),
        "event_type_counts": dict(collections.Counter(e["type"] for e in events)),
        "longest_event_gaps": sorted([g for g in gaps if g["seconds"] is not None], key=lambda g: g["seconds"], reverse=True)[:10],
        "ordered_unique_sequences": all(a < b for a, b in zip(sequences, sequences[1:])),
        "round_count": len(rounds), "rounds": sorted(rounds, key=lambda r: r["context_status_sequence"]),
        "observed_usage": {"sum_response_input_tokens": sum(r["input_tokens"] or 0 for r in rounds), "max_response_input_tokens": max((r["input_tokens"] or 0 for r in rounds), default=0), "threshold_exceeded_response_count": sum(r["context_status"] == "threshold_exceeded" for r in rounds), "compaction_items_count": sum(r["compaction_count"] or 0 for r in rounds), "output_tokens_available": False},
        "timing": {"event_span_seconds": duration(events[0].get("created_at"), events[-1].get("created_at")) if events else None, "sum_completed_tool_event_durations_seconds": round(sum(c.get("duration_seconds") or 0 for c in calls.values()), 6), "union_completed_tool_intervals_seconds": round(tool_union, 6), "note": "Tool intervals can overlap; their union avoids double counting. Remaining event span includes model processing, streaming, and uninstrumented overhead; it is not a direct provider-latency measurement."},
        "tool_count": len(calls), "tools": list(calls.values()), "unpaired_starts": missing,
        "completions_without_starts": completed_without_start, "duplicate_starts": duplicate_starts,
        "duplicate_completions": duplicate_completions,
        "failed_tools": [c for c in calls.values() if c.get("status") in {"failed", "error", "cancelled"}],
        "tools_with_diagnostic_signals": [c for c in calls.values() if c.get("diagnostic_signals")],
        "errors": errors, "artifact_events": artifacts, "files": report.get("files", []),
        "final_events": final_events, "answer": safe(report.get("answer", "")),
        "browser_errors": report.get("browser_errors", []), "console_errors": report.get("console_errors", []),
        "harness_error": report.get("harness_error"), "previews": report.get("previews", []),
        "limitations": ["A round ends at context.status, emitted after response.completed. Inter-round elapsed time includes previous tool execution and current model generation; it is not pure provider latency.", "Tool duration measures persisted application event timestamps, not CPU time.", "Function tool completions may omit status; inferred completion alone does not prove semantic correctness."],
    }
    write_json(args.root / "agent-loop-analysis.json", data)
    lines = ["# Real three-body run: every observed agent round", "", f"Run `{data['run_id']}` · status `{data['status']}` · {len(events)} ordered events · {len(rounds)} responses · {len(calls)} tools.", "", "Round boundaries are `context.status` events, observed after provider `response.completed`. Inter-round elapsed time includes tool execution and generation.", "", "| Round | Agent | Input tokens | Since previous response (s) | Context | Tools |", "| --- | --- | ---: | ---: | --- | --- |"]
    for r in data["rounds"]:
        lines.append(f"| {r['round']} | {r['agent_id']} | {r['input_tokens']} | {r['since_previous_response_seconds']} | {r['context_status']} | {', '.join(c.get('name') or '?' for c in r['tools']) or '—'} |")
    for r in data["rounds"]:
        lines += ["", f"## Round {r['round']} · {r['agent_id']}", "", f"Response `{r['response_id']}` completed {r['response_completed_at']}, sequence {r['context_status_sequence']}. Input tokens: {r['input_tokens']}; context status: {r['context_status']}."]
        for t in r["texts"]:
            lines += ["", t]
        for c in r["tools"]:
            lines += ["", f"### {c['name']} · {c.get('status', 'incomplete')} · {c.get('duration_seconds')} s", "", f"Call `{c['call_id']}`, events {c.get('start_sequence')} → {c.get('complete_sequence')}.", "", "Arguments:", "", "```json", safe(json.dumps(c.get("arguments"), ensure_ascii=False, indent=2)), "```", "", "Output:", "", "```text", c.get("output", "[not completed]"), "```"]
    lines += ["", "## Integrity and errors", "", f"Ordered unique sequences: {data['ordered_unique_sequences']}; unpaired starts: {len(missing)}; orphan completions: {len(completed_without_start)}; failed tools: {len(data['failed_tools'])}; run error events: {len(errors)}.", "", "## Final answer", "", data["answer"]]
    (args.root / "agent-loop-report.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({k: data[k] for k in ("status", "event_count", "round_count", "tool_count", "ordered_unique_sequences")}, ensure_ascii=False))


def physics(args):
    files = args.files or args.run / "downloads"
    checks = {}
    def check(name, passed, detail=None):
        checks[name] = {"passed": bool(passed), "detail": detail}
    with (files / "three_body.csv").open() as stream:
        reader = csv.DictReader(stream)
        check("exact_csv_columns", reader.fieldnames == HEADERS, reader.fieldnames)
        rows = [{k: float(v) for k, v in row.items()} for row in reader]
    metrics = read_json(files / "metrics.json", {})
    times = [r["t"] for r in rows]
    states = [[r[f"{k}{i}"] for i in range(1, 4) for k in ("x", "y")] + [r[f"{k}{i}"] for i in range(1, 4) for k in ("vx", "vy")] for r in rows]
    check("sample_count_at_least_1000", len(rows) >= 1000, len(rows))
    check("finite_csv", all(math.isfinite(v) for row in rows for v in row.values()))
    check("time_endpoints", abs(times[0]) < 1e-12 and abs(times[-1] - 12.65) < 1e-10, [times[0], times[-1]])
    check("monotonic_time", all(a < b for a, b in zip(times, times[1:])))
    spacing = (times[-1] - times[0]) / (len(times) - 1)
    check("uniform_samples", max(abs(b - a - spacing) for a, b in zip(times, times[1:])) < 1e-9, spacing)
    check("specified_initial_conditions", max(abs(a - b) for a, b in zip(states[0], INITIAL)) < 1e-10)
    e0, l0 = energy(INITIAL), angular(INITIAL)
    sampled = {
        "sample_count": len(rows), "initial_energy": energy(states[0]), "initial_angular_momentum": angular(states[0]),
        "max_relative_energy_error": max(abs(energy(s) - e0) / abs(e0) for s in states),
        "max_absolute_angular_momentum_error": max(abs(angular(s) - l0) for s in states),
        "max_center_of_mass_norm": max(com(s) for s in states),
        "minimum_pair_distance": min(math.hypot(s[2*i] - s[2*j], s[2*i+1] - s[2*j+1]) for s in states for i,j in ((0,1),(0,2),(1,2))),
    }
    for name, limit in (("max_relative_energy_error", 1e-7), ("max_absolute_angular_momentum_error", 1e-8), ("max_center_of_mass_norm", 1e-8)):
        check("conservation_" + name, sampled[name] < limit, sampled[name])
    check("noncollision", sampled["minimum_pair_distance"] > .01, sampled["minimum_pair_distance"])
    full = {"max_relative_energy_error": 0., "max_absolute_angular_momentum_error": 0., "max_center_of_mass_norm": 0., "minimum_pair_distance": math.inf}
    state = INITIAL[:]
    for step in range(12651):
        full["max_relative_energy_error"] = max(full["max_relative_energy_error"], abs(energy(state) - e0) / abs(e0))
        full["max_absolute_angular_momentum_error"] = max(full["max_absolute_angular_momentum_error"], abs(angular(state) - l0))
        full["max_center_of_mass_norm"] = max(full["max_center_of_mass_norm"], com(state))
        full["minimum_pair_distance"] = min(full["minimum_pair_distance"], *(math.hypot(state[2*i] - state[2*j], state[2*i+1] - state[2*j+1]) for i,j in ((0,1),(0,2),(1,2))))
        if step < 12650:
            state = rk4(state, .001)
    reference = INITIAL[:]
    now = 0.
    comparisons = []
    for idx in sorted({round((len(rows)-1)*i/50) for i in range(51)}):
        goal = times[idx]
        while now < goal - 1e-12:
            h = min(.0001, goal - now)
            reference = rk4(reference, h)
            now += h
        comparisons.append({"sample_index": idx, "t": goal, "max_position_error": max(abs(a-b) for a,b in zip(reference[:6], states[idx][:6])), "max_velocity_error": max(abs(a-b) for a,b in zip(reference[6:], states[idx][6:]))})
    maxpos = max(c["max_position_error"] for c in comparisons)
    maxvel = max(c["max_velocity_error"] for c in comparisons)
    check("independent_trajectory_agreement_dt_0_0001", maxpos < 1e-5 and maxvel < 1e-5, {"max_position_error": maxpos, "max_velocity_error": maxvel, "sample_count": len(comparisons)})
    required = ["G", "masses", "method", "dt", "t_start", "t_end", "sample_count", "initial_positions", "initial_velocities", "initial_energy", "max_relative_energy_error", "initial_angular_momentum", "max_absolute_angular_momentum_error", "max_center_of_mass_norm", "minimum_pair_distance"]
    for field in required:
        check("metric_field_" + field, field in metrics)
    for field, expected in (("G", 1), ("masses", [1,1,1]), ("dt", .001), ("t_start", 0), ("t_end", 12.65), ("sample_count", len(rows)), ("initial_positions", [INITIAL[0:2], INITIAL[2:4], INITIAL[4:6]]), ("initial_velocities", [INITIAL[6:8], INITIAL[8:10], INITIAL[10:12]])):
        check("metric_value_" + field, metrics.get(field) == expected, metrics.get(field))
    check("metric_method_rk4", bool(re.search(r"rk.?4|runge.?kutta", str(metrics.get("method", "")), re.I)), metrics.get("method"))
    for name, value, tol in [("initial_energy", e0, 1e-10), ("initial_angular_momentum", l0, 1e-10), *[(k,v,1e-10 if k == "minimum_pair_distance" else 5e-12) for k,v in full.items()]]:
        observed = metrics.get(name)
        passed = isinstance(observed, (float,int)) and math.isfinite(observed) and abs(observed-value) < tol
        check("full_precision_metric_" + name, passed, {"reported": observed, "independent_full_step": value, "tolerance": tol})
    artifacts = []
    for name in ("three_body.csv", "metrics.json", "three_body.png", "three_body.html", "simulate_three_body.py"):
        file = files / name
        check("artifact_" + name, file.is_file() and file.stat().st_size > 0)
        if file.is_file():
            artifacts.append({"name": name, "size": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
    html = (files / "three_body.html").read_text()
    embedded_match = re.search(r'<script\b[^>]*\bid=["\']sim-data["\'][^>]*>(.*?)</script>', html, re.S | re.I)
    check("html_embedded_sim_data", embedded_match is not None)
    if embedded_match:
        embedded = json.loads(embedded_match.group(1))
        erows = embedded.get("samples", [])
        check("html_embedded_sample_count", len(erows) == len(rows), len(erows))
        same_shapes = len(erows) == len(rows) and all(len(row) == len(HEADERS) for row in erows)
        error = max((abs(v-row[k]) for erow,row in zip(erows,rows) for k,v in zip(HEADERS,erow)), default=math.inf)
        check("html_all_embedded_samples_match_csv", same_shapes and error < 1e-12, {"maximum_absolute_error": error, "tolerance": 1e-12})
    check("html_no_external_resource_references", not re.search(r'(?:src|href)\s*=\s*["\'](?:https?:)?//', html, re.I))
    result = {"generated_at": utc(), "source": "downloaded real-provider generated CSV and metrics; model script not executed", "independent_method": "existing independent pure-Python Newtonian-force RK4; all producer-size dt=.001 steps plus 51 reference states at dt=.0001", "overall_pass": all(c["passed"] for c in checks.values()), "checks": checks, "failures": [k for k,v in checks.items() if not v["passed"]], "recomputed_from_csv": sampled, "independent_full_precision_producer_step_metrics": full, "independent_integration_samples": comparisons, "producer_metrics": metrics, "artifacts": artifacts}
    write_json(args.root / "physics-verification.json", result)
    print(json.dumps({"overall_pass": result["overall_pass"], "checks": len(checks), "failures": result["failures"], "recomputed": sampled, "max_reference_position_error": maxpos, "max_reference_velocity_error": maxvel}, ensure_ascii=False))
    return 0 if result["overall_pass"] else 1


parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["monitor", "analyze", "physics", "health-summary"])
parser.add_argument("--root", type=Path, default=Path(__file__).parent)
parser.add_argument("--run", type=Path, default=Path(__file__).parent / "three-body")
parser.add_argument("--files", type=Path)
parser.add_argument("--report-file", type=Path)
parser.add_argument("--url", default="http://127.0.0.1:8000")
parser.add_argument("--interval", type=float, default=.5)
parser.add_argument("--timeout", type=float, default=2.)
parser.add_argument("--max-seconds", type=float, default=1800)
parser.add_argument("--terminal-grace", type=float, default=20)
parser.add_argument("--resume", action="store_true")
parser.add_argument("--keep-running", action="store_true")
parser.add_argument("--follow-run", type=Path, action="append", default=[])
args = parser.parse_args()
raise SystemExit({"monitor": monitor, "analyze": analyze, "physics": physics, "health-summary": health_summary}[args.mode](args) or 0)
