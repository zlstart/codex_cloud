"""Build a portable Chinese acceptance report from real, evolving evidence.

The report never promotes a completed model run to an artifact/interaction pass.
Authentication state, raw session dumps, raw tool logs, and private files are not
packaged. Only curated facts, reviewed screenshots, synthetic inputs, and actual
browser downloads are copied into the delivery bundle.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import mimetypes
import re
import shutil
import struct
import zipfile
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RESULTS = ROOT / "test-results/production-acceptance-2026-11-03"
DEFAULT_OUTPUT = ROOT / "docs/reports/production-acceptance-2026-11-03"
FORMATS = ("html", "xlsx", "docx", "pdf", "pptx")
LABELS = {
    "pass": "通过",
    "passed": "通过",
    "completed": "运行完成",
    "fail": "未通过",
    "failed": "未通过",
    "pending": "待验收",
    "running": "进行中",
    "queued": "排队中",
    "cancelled": "已取消",
    "limited": "有限支持",
    "unknown": "待核实",
    "ready": "就绪",
    "partial": "部分完成",
}
SENSITIVE_KEY = re.compile(
    r"password|cookie|authorization|credential|api[_-]?key|secret|(?:access|refresh|session|auth)[_-]?token|famsun[_-]?session|storage[_-]?state|^headers$",
    re.IGNORECASE,
)
SENSITIVE_NAME = re.compile(
    r"(?:^|[/_.-])(?:private|auth|cookie|credential|secret|storage-state)(?:$|[/_.-])", re.IGNORECASE
)
SECRET_PATTERN = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})\b", re.IGNORECASE)
HEADER_CREDENTIAL = re.compile(
    r"(?P<prefix>(?<![\w-])[\"']?(?:authorization|proxy-authorization|cookie|set-cookie)[\"']?\s*:\s*)"
    r"(?P<value>\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^\r\n]+)",
    re.IGNORECASE,
)
NAMED_CREDENTIAL = re.compile(
    r"(?P<prefix>\b(?:famsun_session|(?:session|auth|access|refresh)[_-]?token|"
    r"[a-z0-9_]*api[_-]?key|password|client_secret)\b[\"']?\s*[:=]\s*)"
    r"(?P<quote>[\"']?)(?P<value>[^\"'\s;,<>&}]+)(?P=quote)",
    re.IGNORECASE,
)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clean(value: Any) -> Any:
    if isinstance(value, dict):
        if (
            str(value.get("name", value.get("key", ""))).lower()
            in {
                "famsun_session",
                "session_token",
                "auth_token",
                "authorization",
                "cookie",
                "set-cookie",
            }
            and "value" in value
        ):
            value = value | {"value": "[已移除凭据]"}
        return {
            key: clean(item)
            for key, item in value.items()
            if not SENSITIVE_KEY.search(str(key)) and key != "buildx_state"
        }
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, str):
        if value.lstrip().startswith(("{", "[")):
            try:
                structured = json.loads(value)
            except ValueError:
                pass
            else:
                if isinstance(structured, (dict, list)):
                    return json.dumps(clean(structured), ensure_ascii=False)
        value = HEADER_CREDENTIAL.sub(lambda match: match["prefix"] + '"[已移除请求凭据]"', value)
        value = NAMED_CREDENTIAL.sub(lambda match: match["prefix"] + '"[已移除凭据]"', value)
        value = SECRET_PATTERN.sub("[已移除敏感值]", value)
        value = re.sub(r"(https?://)[^/\s:@]+:[^/@\s]+@", r"\1[已移除凭据]@", value)
        value = re.sub(r"\x1b\[[0-9;]*m", "", value)
        return re.sub(r"/tmp/[^\s\"'<>]+", "[临时路径已省略]", value)
    return value


def selected(data: dict, keys: tuple[str, ...] | list[str]) -> dict:
    return clean({key: data[key] for key in keys if key in data})


def safe_file(path: Path, root: Path) -> bool:
    return (
        path.is_file()
        and not path.is_symlink()
        and path.resolve().is_relative_to(root.resolve())
        and not SENSITIVE_NAME.search(str(path.relative_to(root)))
    )


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed
    except ValueError:
        return None


def server_run_states(results: Path) -> dict[str, dict]:
    """Read only timestamp/status fields; never load account/session databases."""
    states = {}
    for path in sorted(results.rglob("*run-state.json")):
        if not safe_file(path, results):
            continue
        try:
            record = read_json(path)
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict) or not record.get("id"):
            continue
        candidate = selected(record, ["id", "status", "created_at", "updated_at", "error"])
        candidate["source"] = path.relative_to(results).as_posix()
        previous = states.get(record["id"], {})
        current_time = parse_time(candidate.get("updated_at"))
        prior_time = parse_time(previous.get("updated_at"))
        if not previous or current_time and (not prior_time or current_time >= prior_time):
            states[record["id"]] = candidate
    return states


def text(value: Any) -> str:
    if value is None or value == "":
        return "—"
    if isinstance(value, (list, dict)):
        return json.dumps(clean(value), ensure_ascii=False)
    return str(clean(value))


def status(value: Any) -> str:
    return LABELS.get(str(value), str(value or "待验收"))


def phase_status(data: dict, *, cancellation: bool = False) -> str:
    if not data:
        return "pending"
    if data.get("failures"):
        return "fail"
    if cancellation:
        ending = data.get("cancellation", {})
        if (
            data.get("observed_process", {}).get("process_confirmed")
            and ending.get("status") == "cancelled"
            and ending.get("remaining_containers") == []
            and data.get("finished_at")
        ):
            return "pass"
        return "pending"
    return "pass" if data.get("checks") and data.get("finished_at") else "pending"


def collect(results: Path, notes_path: Path | None) -> dict:
    documents: dict[str, Any] = {}
    sources = []
    unreadable = []
    for path in sorted(results.rglob("*.json")):
        relative = path.relative_to(results).as_posix()
        if not safe_file(path, results) or "downloads" in path.parts or relative.startswith("report-"):
            continue
        if any(word in path.name for word in ("session", "events", "run-state")):
            continue
        try:
            data = read_json(path)
        except (OSError, ValueError) as error:
            unreadable.append({"source": relative, "reason": type(error).__name__})
            continue
        documents[relative] = data
        sources.append(
            {
                "source": relative,
                "sha256": sha(path),
                "updated_at": datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(),
            }
        )
    notes = clean(read_json(notes_path)) if notes_path and notes_path.exists() else {}
    setup = documents.get("setup.json", {})
    infrastructure = documents.get("infrastructure.json", {})
    oracle = documents.get("inputs/expected-results.json", {})
    canonical_states = server_run_states(results)
    for source in sorted({item["source"] for item in canonical_states.values()}):
        path = results / source
        sources.append(
            {
                "source": source,
                "sha256": sha(path),
                "updated_at": datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(),
                "scope": "仅提取匹配运行 ID 的服务端时间戳、状态和错误",
            }
        )
    runs: dict[str, dict] = {}
    previews = []
    download_metadata = []
    validations = []
    analysis_quality = []
    content_reviews = []
    resilience_history = {}
    other_checks = []
    for source, document in documents.items():
        if not isinstance(document, dict):
            continue
        if document.get("phase") in {"security", "cancellation"} and "resilience" in source:
            phase = document["phase"]
            history_key = (phase, document.get("run_id", document.get("started_at", source)))
            resilience_history[history_key] = {
                "source": source,
                "status": phase_status(document, cancellation=phase == "cancellation"),
                **selected(
                    document, ["phase", "run_id", "started_at", "finished_at", "failures", "cancellation"]
                ),
            }
        candidate_runs = []
        if document.get("scenario") == "snake" and document.get("run_id"):
            candidate_runs = [document]
        if isinstance(document.get("runs"), list) and "analysis" in source:
            candidate_runs = document["runs"]
        for record in candidate_runs:
            if not isinstance(record, dict) or not record.get("run_id"):
                continue
            entry = selected(
                record,
                [
                    "run_id",
                    "stage",
                    "attempt",
                    "submitted_at",
                    "completed_at",
                    "finished_at",
                    "duration_seconds",
                    "status",
                    "error",
                    "prompt",
                    "answer",
                    "superseded",
                    "event_count",
                    "browser_errors",
                    "limits",
                    "runtime_timeout_seconds",
                    "api_mode",
                ],
            )
            entry.update(
                {
                    "source": source,
                    "task": "snake" if "snake" in source else record.get("stage", "analysis"),
                    "model": record.get("model", setup.get("model", "未记录")),
                }
            )
            entry["observation_duration_seconds"] = entry.pop("duration_seconds", None)
            state = canonical_states.get(entry["run_id"])
            if state:
                entry["canonical_state_source"] = state["source"]
                entry["server_created_at"] = state.get("created_at")
                entry["server_updated_at"] = state.get("updated_at")
                entry["observation_status"] = entry.get("status")
                entry["status"] = state.get("status", entry.get("status"))
                started = parse_time(state.get("created_at"))
                ended = parse_time(state.get("updated_at"))
                if entry["status"] in {"completed", "failed", "cancelled"} and started and ended:
                    elapsed = (ended - started).total_seconds()
                    if elapsed >= 0:
                        entry["server_duration_seconds"] = elapsed
                if state.get("error"):
                    entry["error"] = state["error"]
            entry["output_files"] = [
                selected(item, ["id", "name", "size", "kind"])
                for item in record.get("files", [])
                if item.get("kind") == "output"
            ]
            event_path = (
                results
                / Path(source).parent
                / (
                    "events.json"
                    if entry["task"] == "snake"
                    else f"{record.get('stage', 'analysis')}-events.json"
                )
            )
            if event_path.exists():
                try:
                    events = read_json(event_path)
                    if isinstance(events, list) and any(
                        isinstance(item, dict) and item.get("run_id") == entry["run_id"] for item in events
                    ):
                        events = [
                            item
                            for item in events
                            if isinstance(item, dict) and item.get("run_id") == entry["run_id"]
                        ]
                        entry["event_summary"] = dict(
                            Counter(
                                item.get("type", item.get("event", "unknown"))
                                for item in events
                                if isinstance(item, dict)
                            )
                        )
                        entry["event_count"] = len(events)
                except (ValueError, OSError):
                    pass
            previous = runs.get(entry["run_id"], {})
            runs[entry["run_id"]] = previous | entry
        if "analysis" in source and isinstance(document.get("previews"), list):
            for preview in document["previews"]:
                entry = selected(
                    preview,
                    [
                        "label",
                        "file_id",
                        "file_name",
                        "kind",
                        "started_at",
                        "finished_at",
                        "preview_kind",
                        "alerts",
                        "limitation",
                        "sheet_tabs",
                        "screenshot",
                        "error",
                        "download_error",
                        "download",
                        "pdf_pages",
                        "ppt_slides",
                        "document",
                        "sheets",
                        "format_notices",
                    ],
                )
                entry["source"] = source
                entry["html"] = selected(
                    preview.get("html", {}), ["scripts", "tables", "images", "canvases", "sandbox"]
                )
                previews.append(entry)
                if preview.get("download"):
                    download_metadata.append(
                        {
                            "source": source,
                            "name": preview.get("file_name"),
                            "kind": preview.get("kind"),
                            **preview["download"],
                        }
                    )
        if isinstance(document.get("download"), dict):
            download_metadata.append(
                {
                    "source": source,
                    "name": document.get("artifact", {}).get("name", "snake.html"),
                    "kind": "output",
                    **document["download"],
                }
            )
        if isinstance(document.get("downloads"), list):
            download_metadata.extend(
                {"source": source, "kind": "output" if "analysis" in source else "unknown", **entry}
                for entry in document["downloads"]
                if isinstance(entry, dict)
            )
        if "artifacts" in document and "required_formats" in document:
            validations.append(
                {
                    "source": source,
                    **selected(
                        document,
                        [
                            "created_at",
                            "status",
                            "allow_partial",
                            "required_formats",
                            "missing_formats",
                            "dependencies",
                            "artifacts",
                            "limitations",
                        ],
                    ),
                }
            )
        if "analysis" in source and "overall_analysis_pass" in document:
            analysis_quality.append(
                {
                    "source": source,
                    "evidence_updated_at": next(
                        item["updated_at"] for item in sources if item["source"] == source
                    ),
                    **selected(
                        document,
                        [
                            "run_id",
                            "basis",
                            "core_metrics_pass",
                            "cleaning_pass",
                            "line_ranking_and_target_comparison_pass",
                            "overall_analysis_pass",
                            "confirmed",
                            "issues",
                            "decision",
                            "created_at",
                            "summary",
                        ],
                    ),
                }
            )
        if (
            isinstance(document.get("artifacts"), list)
            and "findings" in document
            and "reviewed_at" in document
        ):
            content_reviews.append(
                {
                    "source": source,
                    **selected(
                        document,
                        [
                            "reviewed_at",
                            "scope",
                            "artifacts",
                            "findings",
                            "limitations",
                            "overall_content_pass",
                        ],
                    ),
                }
            )
        if "snake" in source and any(
            key in document
            for key in ("checks", "interaction", "remote_requests", "script_and_control_stripping_observed")
        ):
            other_checks.append(
                {
                    "source": source,
                    **selected(
                        document,
                        [
                            "status",
                            "checks",
                            "failures",
                            "browser_errors",
                            "remote_requests",
                            "script_and_control_stripping_observed",
                            "iframe_sandbox",
                            "raw_script_count",
                            "scripts",
                            "buttons",
                            "interaction",
                        ],
                    ),
                }
            )
    for source in (
        "native-pptx-layout-review.json", "pdf-page-bounds.json", "analysis/artifact-layout.json",
        "analysis/highlighting.json",
        "frontend-regression.json", "independent-preview-security-review.json",
        "office-viewport-review-production.json", "docker-startup-60s-diagnostic.json",
    ):
        if isinstance(documents.get(source), dict):
            other_checks.append({"source": source, **clean(documents[source])})
    preview_map = {}
    for item in previews:
        preview_map[(item.get("file_id"), item.get("label"), item.get("started_at"))] = item
    previews = sorted(preview_map.values(), key=lambda item: item.get("started_at", ""))
    downloads = []
    for path in sorted(results.rglob("*")):
        if not safe_file(path, results) or not (
            "downloads" in path.relative_to(results).parts
            or path.name.startswith("downloaded-")
            and path.suffix.lower() in {".html", ".xlsx", ".docx", ".pdf", ".pptx"}
        ):
            continue
        candidates = [
            item
            for item in download_metadata
            if item.get("path") and Path(item["path"]).resolve() == path.resolve()
        ]
        if not candidates:
            candidates = [
                item
                for item in download_metadata
                if path.name == item.get("name", item.get("file_name"))
                or path.name.endswith("-" + str(item.get("name", item.get("file_name", "\0"))))
            ]
        metadata = candidates[-1] if candidates else {}
        digest = sha(path)
        recorded = [
            metadata[key]
            for key in ("sha256", "api_sha256", "browser_sha256", "original_upload_sha256")
            if metadata.get(key)
        ]
        matching = bool(recorded) and all(value == digest for value in recorded)
        download_status = "pass" if matching else "fail" if recorded else "limited"
        if metadata.get("identical_to_api") is False or metadata.get("matches_metadata_size") is False:
            download_status = "fail"
        downloads.append(
            {
                "source": path.relative_to(results).as_posix(),
                "name": metadata.get(
                    "name", metadata.get("file_name", metadata.get("suggested_filename", path.name))
                ),
                "kind": metadata.get("kind", "output" if "snake" in path.parts else "unknown"),
                "bytes": path.stat().st_size,
                "sha256": digest,
                "recorded_sha256": recorded,
                "status": download_status,
                "browser_filename": metadata.get("browser_filename", metadata.get("suggested_filename")),
                "evidence": metadata.get("source"),
                "version": "修正前原件（历史）" if "initial-generated" in path.parts else "当前保存原件",
            }
        )
    screenshots = []
    for path in sorted(results.rglob("*.png")):
        relative = path.relative_to(results)
        if (
            not safe_file(path, results)
            or "downloads" in relative.parts
            or "infrastructure-probes" in relative.parts
        ):
            continue
        if not any(
            part in relative.parts
            for part in ("screenshots", "snake", "analysis", "resilience", "fullscreen")
        ):
            continue
        data = path.read_bytes()
        width, height = struct.unpack(">II", data[16:24]) if data[:8] == b"\x89PNG\r\n\x1a\n" else (0, 0)
        caption = notes.get("screenshot_captions", {}).get(
            relative.as_posix(), screenshot_caption(relative.as_posix())
        )
        screenshots.append(
            {
                "source": relative.as_posix(),
                "caption": caption,
                "width": width,
                "height": height,
                "viewport": "手机 / 窄屏" if 0 < width <= 600 else "桌面",
                "sha256": sha(path),
            }
        )
    security = documents.get("resilience/security.json", {})
    cancellation = documents.get("resilience/cancellation.json", {})
    return clean(
        {
            "schema_version": 1,
            "generated_at": datetime.now(UTC).isoformat(),
            "evidence_root": results.name,
            "environment": selected(
                setup, ["started_at", "model", "api_mode", "limits", "first_registration", "dataset", "notes"]
            ),
            "infrastructure": selected(
                infrastructure,
                [
                    "updated_at",
                    "build",
                    "findings",
                    "runtime_limits_changed",
                    "status",
                    "sdk_docker_smoke",
                    "model_called_for_infrastructure_probes",
                    "node_runtime",
                    "startup_timeout",
                ],
            ),
            "runs": sorted(runs.values(), key=lambda item: item.get("submitted_at", "")),
            "previews": previews,
            "validations": sorted(validations, key=lambda item: item.get("created_at", "")),
            "analysis_quality": sorted(
                analysis_quality,
                key=lambda item: (
                    runs.get(item.get("run_id"), {}).get("submitted_at", item["evidence_updated_at"]),
                    item["evidence_updated_at"],
                ),
            ),
            "resilience_history": sorted(
                resilience_history.values(), key=lambda item: item.get("started_at", "")
            ),
            "other_checks": other_checks,
            "content_reviews": sorted(content_reviews, key=lambda item: item.get("reviewed_at", "")),
            "fullscreen": selected(
                documents.get("fullscreen/report.json", {}), ["status", "checks", "live_files"]
            ),
            "security": {
                "status": phase_status(security),
                **selected(
                    security,
                    [
                        "started_at",
                        "finished_at",
                        "checks",
                        "failures",
                        "browser_errors",
                        "live_model_mocked",
                    ],
                ),
            },
            "cancellation": {
                "status": phase_status(cancellation, cancellation=True),
                **selected(
                    cancellation,
                    [
                        "started_at",
                        "finished_at",
                        "checks",
                        "failures",
                        "observed_process",
                        "cancellation",
                        "browser_errors",
                        "failure_cleanup",
                    ],
                ),
            },
            "oracle": oracle,
            "downloads": downloads,
            "screenshots": screenshots,
            "notes": notes,
            "sources": sources,
            "unreadable_sources": unreadable,
            "evidence_policy": "只打包整理后的事实、截图、合成输入及浏览器下载原件；不包含认证状态、Cookie、密钥、原始会话/工具日志或临时目录文件。",
        }
    )


def screenshot_caption(path: str) -> str:
    captions = {
        "00-welcome": "首次访问与注册入口",
        "01-registered": "注册后工作台",
        "preview-upload-csv": "上传的生产 CSV：表格预览",
        "preview-upload-xlsx": "上传的工作簿：工作表切换",
        "member-empty-files": "第二账号的文件空间",
        "member-forbidden-content": "跨账号访问文件的拒绝结果",
        "owner-files-downloads": "所属账号查看与下载原件",
        "cancellation-running": "取消前：实际工具进程正在运行",
        "cancellation-recovered": "取消后：输入和上传恢复",
        "cancellation-replayed": "刷新后：取消状态回放",
        "preview-baseline": "HTML 预览基线",
        "downloaded-initial-desktop": "下载的原始 HTML：桌面打开",
    }
    for token, caption in captions.items():
        if token in path:
            return caption
    kind = "贪吃蛇" if path.startswith("snake/") else "经营分析" if path.startswith("analysis/") else "验收"
    if "failure" in path:
        return f"{kind}：失败现场（保留基线证据）"
    if "mobile" in path:
        return f"{kind}：手机布局与交互"
    if "final" in path:
        return f"{kind}：任务结束后的真实界面"
    if "preview" in path:
        return f"{kind}：文件预览 · {Path(path).stem}"
    return f"{kind}：{Path(path).stem}"


def content_verdict(data: dict, digest: str) -> tuple[str, str]:
    matches = [
        (review, artifact)
        for review in data.get("content_reviews", [])
        for artifact in review.get("artifacts", [])
        if artifact.get("sha256") == digest
    ]
    if not matches:
        return "pending", "当前 SHA 尚无独立内容审阅"
    review, artifact = matches[-1]
    findings = [item for item in review.get("findings", []) if item.get("sha256") == digest]
    reasons = []
    if artifact.get("unsupported_missing_downtime_percentage"):
        reasons.append("缺失停机数据被赋予无依据的影响百分比")
    if artifact.get("formula_review", {}).get("mismatches"):
        reasons.append("存在公式缓存与实际显示结果差异")
    for finding in findings:
        reason = finding.get("issue", "待修正项")
        if "Missing downtime" in reason:
            reason = "缺失停机数据被赋予无依据的影响百分比"
        elif "formula" in reason.lower() and "cache" in reason.lower():
            reason = "存在公式缓存与实际显示结果差异"
        elif any(word in reason.lower() for word in ("off-slide", "slide bounds", "clipped")):
            reason = "PPTX 对象超出页面边界，存在裁切"
        reasons.append(reason)
    if reasons:
        return "fail", "；".join(dict.fromkeys(reasons))
    explicit = artifact.get("business_content_pass", review.get("overall_content_pass"))
    if explicit is True:
        return "pass", "同 SHA 独立内容审阅通过"
    if explicit is False:
        return "fail", "同 SHA 独立内容审阅未通过"
    return "pending", "独立审阅未给出最终内容通过结论"


def format_rows(data: dict) -> list[list[str]]:
    # Bind every claim to current browser-downloaded bytes, never just a filename.
    validated = {}
    for validation in data["validations"]:
        for artifact in validation.get("artifacts", []):
            if artifact.get("sha256"):
                validated[(artifact.get("format"), artifact["sha256"])] = artifact
    rows = []
    for kind in FORMATS:
        current = [
            item
            for item in data["downloads"]
            if item.get("kind") == "output"
            and item["source"].startswith("analysis/downloads/")
            and item["name"].lower().endswith("." + kind)
        ]
        hashes = {item["sha256"] for item in current}
        verified = [validated.get((kind, item["sha256"])) for item in current]
        present = [item for item in verified if item is not None]
        if any(item.get("status") == "fail" for item in present):
            original_status = "fail"
        elif (
            current and len(present) == len(current) and all(item.get("status") == "pass" for item in present)
        ):
            original_status = "pass"
        else:
            original_status = "pending"
        metrics = [metric for item in present for metric in item.get("metrics", [])]
        numerical = (
            f"{sum(item.get('status') == 'pass' for item in metrics)}/{len(metrics)} 项"
            if metrics
            else "未执行 / 结构检查先失败"
        )
        content = [content_verdict(data, digest) for digest in hashes]
        content_status = (
            "fail"
            if any(item[0] == "fail" for item in content)
            else "pass"
            if content and all(item[0] == "pass" for item in content)
            else "pending"
        )
        previews = [
            item
            for item in data["previews"]
            if item.get("kind") == "output" and item.get("download", {}).get("sha256") in hashes
        ]
        preview = previews[-1] if previews else {}
        if preview.get("error") or preview.get("alerts") or any(
            slide.get("content_overflows") for slide in preview.get("ppt_slides", [])
        ):
            preview_status = "未通过"
        elif preview.get("limitation"):
            preview_status = "有限支持；可下载原件"
        elif preview.get("finished_at"):
            preview_status = "已检查（同 SHA）"
        else:
            preview_status = "待验收"
        download_status = (
            "fail"
            if any(item["status"] == "fail" for item in current)
            else "pass"
            if current and all(item["status"] == "pass" for item in current)
            else "pending"
        )
        reasons = [item["error"] for item in present if item.get("error")]
        reasons.extend(item[1] for item in content if item[0] == "fail")
        if not current:
            reasons.append("尚无当前成果浏览器原件")
        elif len(present) < len(current):
            reasons.append("当前原件尚无同 SHA 验证记录；旧版通过不沿用")
        if content_status == "pending":
            reasons.append("业务内容仍待同 SHA 审阅结论")
        rows.append(
            [
                kind.upper(),
                status(original_status),
                numerical,
                status(content_status),
                preview_status,
                status(download_status),
                "；".join(reasons) or "数值、内容、预览和下载分别见同 SHA 证据",
            ]
        )
    return rows


class Report:
    def __init__(self) -> None:
        self.sections: list[dict] = []

    def section(self, identifier: str, title: str, lead: str = "") -> list[dict]:
        blocks: list[dict] = []
        self.sections.append({"id": identifier, "title": title, "lead": lead, "blocks": blocks})
        return blocks


def table(headers: list[str], rows: list[list[Any]]) -> dict:
    return {"type": "table", "headers": headers, "rows": [[text(value) for value in row] for row in rows]}


def paragraph(value: str, tone: str = "") -> dict:
    return {"type": "paragraph", "text": value, "tone": tone}


def compose(data: dict) -> Report:
    report = Report()
    blocks = report.section(
        "scope",
        "验收范围与判定口径",
        "使用真实配置的 Responses 模型、实际 Docker 沙箱、真实 Chromium 操作和独立数据标准。",
    )
    blocks.append(
        table(
            ["项目", "实际记录"],
            [
                [
                    "模型 / 协议",
                    f"{data['environment'].get('model', '未记录')} / {data['environment'].get('api_mode', '未记录')}",
                ],
                [
                    "基线任务预算",
                    "验收计划保留 20 轮、300 秒任务上限；512 MiB 沙箱、单 API worker。运行实况见各次记录。",
                ],
                ["当前项目默认预算", "40 轮、900 秒；环境变量可以覆盖。512 MiB 沙箱与单 API worker 保持不变。"],
                ["输入", "全部为合成制造业数据；预期结果未上传到模型工作区。"],
                ["判定原则", "任务完成、格式有效、数值正确、网页可预览、原件可下载分别检查。"],
                ["证据时间", data["generated_at"]],
                ["资料处理", data["evidence_policy"]],
            ],
        )
    )
    for item in data["notes"].get("summary", []):
        blocks.append(paragraph(item, "note"))
    expanded = [
        run
        for run in data["runs"]
        if (run.get("runtime_timeout_seconds") or 0) > 300
        or (run.get("limits", {}).get("max_turns") or 0) > 20
    ]
    if expanded:
        blocks.append(
            paragraph(
                "后续复验扩展了部分任务的轮数或运行时间预算。每次实际记录的预算见任务明细；扩展预算后的结果不能计为原始 20 轮 / 300 秒基线配置已经通过。",
                "note",
            )
        )
    if data["unreadable_sources"]:
        blocks.append(
            paragraph("部分证据仍在写入或无法读取；这些记录未计为通过。请完成测试后重新生成报告。", "warning")
        )
    blocks = report.section(
        "runs",
        "真实任务：提示词、耗时与实际结果",
        "保留失败基线和每次复验。服务端耗时按任务 created_at → updated_at 计算，包含启动、执行和清理；观察耗时是测试程序提交到观察终态的间隔，可能包含轮询或测试暂停。两者均不是纯模型生成时长。",
    )
    run_rows = []
    for index, run in enumerate(data["runs"], 1):
        title = {
            "snake": "贪吃蛇制作",
            "analysis": "经营数据分析",
            "deliverables": "五格式成果制作",
            "deliverables-completion": "五格式成果补全",
            "artifact-content-correction": "成果内容与版式修正",
            "artifacts": "五格式成果制作",
            "reports": "五格式成果制作",
            "analysis-correction": "经营分析纠正复验",
            "correction": "经营分析纠正复验",
            "correction-2": "经营分析二次纠正复验",
        }.get(run["task"], run["task"])
        quality_checks = [item for item in data["analysis_quality"] if item.get("run_id") == run["run_id"]]
        run_result = status(run.get("status"))
        if quality_checks:
            run_result += "；业务质检" + ("通过" if quality_checks[-1]["overall_analysis_pass"] else "未通过")
        duration = (
            f"{run['server_duration_seconds']:.3f} 秒"
            if isinstance(run.get("server_duration_seconds"), (int, float))
            else "进行中"
            if run.get("status") in {"running", "queued"}
            else "缺少服务端时间戳"
        )
        observed = (
            f"{run['observation_duration_seconds']:.3f} 秒"
            if isinstance(run.get("observation_duration_seconds"), (int, float))
            else "未记录终态观察"
        )
        run_rows.append(
            [
                f"{index:02d} · {title}",
                run.get("model"),
                duration,
                observed,
                run_result,
                len(run["output_files"]),
                run.get("submitted_at"),
            ]
        )
        detail = f"运行 ID：{run['run_id']}\n模型：{run['model']}\n状态：{status(run.get('status'))}\n服务端运行周期：{duration}\n测试程序观察间隔：{observed}\n服务端创建 / 最终更新：{run.get('server_created_at', '未记录')} / {run.get('server_updated_at', '未记录')}\n服务端时间戳证据：{run.get('canonical_state_source', '未记录')}\n来源：{run['source']}\n"
        detail += f"该次记录的预算：轮数 {run.get('limits', {}).get('max_turns', '未记录')}；最长运行秒数 {run.get('runtime_timeout_seconds', '未记录')}\n"
        if run.get("error"):
            detail += f"实际错误：{run['error']}\n"
        if quality_checks:
            detail += "业务内容结果：" + run_result + "\n"
        detail += "\n实际提交的提示词\n" + run.get("prompt", "未记录提示词")
        detail += "\n\n实际最终答复\n" + (run.get("answer") or "本次未形成最终答复。")
        if run.get("event_summary"):
            detail += "\n\n事件计数\n" + text(run["event_summary"])
        blocks.append(
            {
                "type": "details",
                "title": f"{index:02d} · {title} · {status(run.get('status'))} · 查看完整提示词和结果",
                "text": detail,
            }
        )
    blocks.insert(
        0,
        table(
            ["任务 / 次序", "模型", "服务端耗时", "观察耗时", "运行结果", "生成文件数", "提交时间 UTC"],
            run_rows or [["暂无运行记录", "—", "—", "待验收", "0", "—", "—"]],
        ),
    )
    if any(
        run.get("task") == "snake" and run.get("observation_duration_seconds") == 317.673
        for run in data["runs"]
    ):
        blocks.insert(
            1,
            paragraph(
                "贪吃蛇基线测试端观察为 317.673 秒；服务端记录约为 315.862 秒。300 秒预算之外还包含启动、取消 / 清理和状态观测等开销，不能把观察间隔全部归为清理时间，也不能据此反推任务上限。",
                "note",
            ),
        )
    blocks = report.section(
        "analysis-quality",
        "经营分析：数字正确与判断可靠分别验收",
        "运行完成只代表模型执行结束。合计、清洗、排序和业务因果解释必须分别通过独立复核。原始分析与纠正复验均保留。",
    )
    quality_rows = []
    for check in data["analysis_quality"]:
        result = "通过" if check["overall_analysis_pass"] else "未通过"
        quality_rows.append(
            [
                check.get("run_id"),
                "通过" if check.get("core_metrics_pass") else "待核实 / 未通过",
                "通过" if check.get("cleaning_pass") else "待核实 / 未通过",
                "通过" if check.get("line_ranking_and_target_comparison_pass") else "待核实 / 未通过",
                result,
                check["source"],
            ]
        )
        if check.get("issues"):
            observations = []
            for issue in check["issues"]:
                severity = issue.get("severity", "")
                finding = issue.get("finding", "")
                if severity == "material narrative error":
                    finding = "停机可解释产量缺口，却不能据此解释产线排名：即使按计划补足零产量记录，该产线仍落后于上一名。"
                elif severity == "secondary numerical error":
                    finding = "缺失电耗填零的敏感性计算又混入零产量记录的电耗，混淆了两种处理错误；须按独立口径重新计算。"
                elif severity == "unsupported operational claim":
                    finding = (
                        "输入只有停机分钟和班次标签，没有班次时长或计划停机表，不能直接判断整班或计划外停机。"
                    )
                observations.append([issue.get("claim"), finding])
            blocks.append(table(["模型原结论", "独立质检发现"], observations))
        blocks.append(
            {
                "type": "details",
                "title": f"业务内容质检 · {result} · {check['source']}",
                "text": json.dumps(check, ensure_ascii=False, indent=2),
            }
        )
    blocks.insert(
        0,
        table(
            ["运行 ID", "核心指标", "清洗", "排名 / 目标", "业务内容总判定", "证据"],
            quality_rows or [["尚无独立业务内容质检", "待验收", "待验收", "待验收", "待验收", "—"]],
        ),
    )
    blocks = report.section(
        "formats",
        "五种成果：独立验证、网页预览和下载",
        "结构、数值、业务内容、网页预览和下载分别判定，并绑定当前浏览器原件的 SHA-256。更换原件后不沿用旧版通过；历史修正前原件仍保留在下载清单和证据包中。",
    )
    blocks.append(
        table(
            ["格式", "原件验证", "数值检查", "业务内容", "网页预览", "下载 SHA", "实际结果 / 缺口"],
            format_rows(data),
        )
    )
    for validation in data["validations"]:
        blocks.append(
            {
                "type": "details",
                "title": f"验证明细 · {status(validation.get('status'))} · {validation['source']}",
                "text": json.dumps(validation, ensure_ascii=False, indent=2),
            }
        )
    if not data["validations"]:
        blocks.append(
            paragraph("当前还没有五格式真实成果的独立验证记录，因此不能确认这些交付物合格。", "warning")
        )
    blocks = report.section(
        "artifact-content",
        "成果内容与显示质检：按原件 SHA 保留修正前后",
        "可读取、指标出现、网页可预览均不代表业务内容正确。原件中的无依据结论、公式缓存错误和越界形状单独记录，旧版发现不会被新版文件名覆盖。",
    )
    content_rows = []
    for review in data.get("content_reviews", []):
        for artifact in review.get("artifacts", []):
            verdict, reason = content_verdict({"content_reviews": [review]}, artifact.get("sha256", ""))
            content_rows.append(
                [
                    artifact.get("name"),
                    artifact.get("sha256"),
                    status(verdict),
                    reason,
                    review["source"],
                ]
            )
        blocks.append(
            {
                "type": "details",
                "title": "独立原件内容审阅 · " + review["source"],
                "text": json.dumps(review, ensure_ascii=False, indent=2),
            }
        )
    blocks.insert(
        0,
        table(
            ["文件", "审阅原件 SHA-256", "业务 / 显示结论", "依据或待修正项", "证据"],
            content_rows
            or [["尚无真实原件内容审阅", "—", "待验收", "等待与实际下载 SHA 绑定的内容检查", "—"]],
        ),
    )
    blocks = report.section(
        "issues",
        "基线问题、修复与复验",
        "区分应用缺陷、模型产物缺陷、环境问题和已知预览边界。基础设施探针通过不等于真实模型任务通过。",
    )
    issues = []
    for item in data["infrastructure"].get("findings", []):
        finding = item.get("finding")
        fix = item.get("fix")
        if "python-pptx import unavailable" in str(finding):
            finding = "基线沙箱缺少 python-pptx，无法使用该库制作 PowerPoint。"
            fix = "补充 python-pptx 并锁定依赖；在沙箱中重新生成并读取 PPTX。"
        elif "PostScript outlines" in str(finding):
            finding = "现有 Noto CJK 字体采用 ReportLab TTFont 不支持的轮廓格式，中文 PDF 字体嵌入受阻。"
            fix = "增加文泉驿正黑 TrueType 中文字体，保留 Noto；复验中文 PDF 生成和文本提取。"
        elif "could not execute node" in str(finding):
            finding = "真实贪吃蛇任务无法执行 Node；基线镜像检查返回退出码 127。"
            fix = "安装 Node.js 供脚本检查与本地执行；复验合法 / 非法语法检查和执行结果。"
        issues.append(
            [
                item.get("format"),
                "环境 / 沙箱",
                finding,
                fix,
                "基础设施探针"
                + status(data["infrastructure"].get("status", "pending"))
                + "；模型任务另行检查",
                "infrastructure.json",
            ]
        )
    for item in data["notes"].get("issues", []):
        issues.append(
            [
                item.get("title"),
                item.get("category"),
                item.get("before"),
                item.get("fix"),
                f"{status(item.get('status'))}：{item.get('retest', '未记录复验')}",
                item.get("evidence", []),
            ]
        )
    blocks.append(
        table(
            ["项目", "归类", "基线现象", "采取的修复", "复验 / 当前状态", "证据"],
            issues or [["暂无整理后的缺陷记录", "—", "—", "—", "待核实", "—"]],
        )
    )
    diagnostics = [item["source"] for item in data["sources"] if "docker-startup" in item["source"]]
    if diagnostics:
        blocks.append(
            paragraph(
                "保留了 Docker 启动诊断："
                + "、".join(diagnostics)
                + "。启动阶段失败需结合这些诊断定位，不能仅凭通用错误提示认定为模型供应商故障。",
                "note",
            )
        )
    blocks = report.section(
        "security",
        "账号隔离、取消和恢复",
        "授权拒绝、浏览器下载和实际进程清理均独立记录。取消前没有观察到睡眠工具进程的尝试不计为取消通过。",
    )
    blocks.append(
        table(
            ["检查", "当前结果", "证据数量 / 实测", "失败或待补充项"],
            [
                [
                    "所属用户 / 其他用户 / 未登录访问",
                    status(data["security"]["status"]),
                    f"{len(data['security'].get('checks', []))} 条检查",
                    data["security"].get("failures") or "见逐项证据",
                ],
                [
                    "实际运行中取消与清理",
                    status(data["cancellation"]["status"]),
                    data["cancellation"].get("cancellation", "未记录完成的取消"),
                    data["cancellation"].get("failures") or "见逐项证据",
                ],
            ],
        )
    )
    for key, label in (("security", "权限与下载检查"), ("cancellation", "取消与恢复检查")):
        blocks.append(
            {"type": "details", "title": label, "text": json.dumps(data[key], ensure_ascii=False, indent=2)}
        )
    if data["resilience_history"]:
        blocks.append(
            table(
                ["尝试", "开始时间 UTC", "该次结果", "失败 / 清理结果", "证据"],
                [
                    [
                        "取消 / 恢复" if item["phase"] == "cancellation" else "权限 / 下载",
                        item.get("started_at"),
                        status(item["status"]),
                        item.get("failures") or item.get("cancellation") or "见当前检查明细",
                        item["source"],
                    ]
                    for item in data["resilience_history"]
                ],
            )
        )
    if data["other_checks"]:
        blocks.append(
            {
                "type": "details",
                "title": "补充证据：游戏交互、图表、隔离检查与原生布局诊断",
                "text": json.dumps(data["other_checks"], ensure_ascii=False, indent=2),
            }
        )
    blocks = report.section(
        "fullscreen",
        "文件全屏验收",
        "桌面使用浏览器原生全屏；手机用关闭原生 API 的真实页面验证铺满视口的兼容方案。首次 Esc 退出全屏并保留文件，普通模式下再次 Esc 关闭预览；HTML 游戏不会因切换全屏而重新挂载。",
    )
    blocks.append(
        table(
            ["实际文件", "显示方式", "全屏 / 恢复 / Esc", "截图"],
            [
                [item.get("file"), item.get("mode"), status(item.get("status")), item.get("screenshot")]
                for item in data.get("fullscreen", {}).get("checks", [])
            ]
            or [["尚无真实文件全屏证据", "—", "待验收", "—"]],
        )
    )
    blocks = report.section(
        "oracle",
        "独立标准结果",
        "先生成输入，再独立读取 CSV / 工作簿计算标准；生产总量与排名另用 SQLite SQL 交叉复核。以下是验收标准，不是模型成绩。",
    )
    oracle = data["oracle"]
    blocks.append(
        table(
            ["核心指标", "独立预期"],
            [[item["label"], item["value"]] for item in oracle.get("report_checks", [])],
        )
    )
    production = oracle.get("production", {})
    blocks.append(
        paragraph(
            f"数据质量基准：原始 {production.get('source_rows', '—')} 行；有效 {production.get('unique_rows', '—')} 行；重复 {production.get('duplicate_rows', '—')} 行；缺失字段 {text(production.get('missing_after_dedup', {}))}；零产量记录 {text(production.get('zero_output_ids', []))}。"
        )
    )
    blocks.append(
        table(
            ["排名", "产线", "实际产量 / 吨", "加权良品率", "计划达成率"],
            [
                [
                    index,
                    item["line"],
                    item["actual_tonnes"],
                    str(item["weighted_quality_pct"]) + "%",
                    str(item["attainment_pct"]) + "%",
                ]
                for index, item in enumerate(production.get("line_ranking", []), 1)
            ],
        )
    )
    blocks = report.section(
        "downloads",
        "实际下载原件与 SHA-256",
        "这里列出浏览器保存的真实字节。上传资料和模型生成成果明确区分；哈希与既有 API / 浏览器记录比对。",
    )
    blocks.append(
        table(
            ["文件", "类别 / 版本", "字节", "比对", "SHA-256"],
            [
                [
                    item["name"],
                    {"upload": "上传资料", "output": "生成成果"}.get(item["kind"], "待确认")
                    + " · "
                    + item.get("version", "当前保存原件"),
                    f"{item['bytes']:,}",
                    status(item["status"]),
                    item["sha256"],
                ]
                for item in data["downloads"]
            ],
        )
    )
    for item in data["downloads"]:
        blocks.append({"type": "download", **item})
    if not data["downloads"]:
        blocks.append(paragraph("当前未发现浏览器下载原件。", "warning"))
    blocks = report.section(
        "screenshots",
        "现场截图",
        "点击截图可放大。图片来自本次验收，不使用历史演示图替代。尺寸标签表示截图实际像素。",
    )
    if not any(item["viewport"] == "手机 / 窄屏" for item in data["screenshots"]):
        blocks.append(paragraph("当前尚未收集手机视口截图，移动端验收仍待完成。", "warning"))
    key_screenshots = data["notes"].get("key_screenshots", [])
    screenshot_by_source = {item["source"]: item for item in data["screenshots"]}
    visible_screenshots = ([screenshot_by_source[source] for source in key_screenshots if source in screenshot_by_source]
                           if key_screenshots else data["screenshots"])
    if key_screenshots:
        blocks.append(paragraph(f"正文展示 {len(visible_screenshots)} 张关键截图；证据 ZIP 保留全部 {len(data['screenshots'])} 张截图，包含逐页检查和历史失败。"))
    blocks.extend({"type": "figure", **item} for item in visible_screenshots)
    blocks = report.section(
        "limits",
        "回归结果与生产剩余边界",
        "本节依据本轮新增证据更新；以前日期的测试结果不会自动计入本次实时验收。",
    )
    regressions = data["notes"].get("regressions", [])
    blocks.append(
        table(
            ["检查", "结果", "实际范围", "证据"],
            [
                [item.get("name"), status(item.get("status")), item.get("detail"), item.get("evidence", [])]
                for item in regressions
            ]
            or [["本轮代码回归", "待记录", "最终修复后需重新运行并记录", "—"]],
        )
    )
    defaults = [
        "这是一套合成数据、单次部署的功能验收；不代表目标业务规模的吞吐、长期稳定性或并发容量压测。",
        "使用单 API worker、单应用副本；跨进程任务队列、分布式调度和高可用不在本次范围。",
        "Office 结构 / 数值检查和 PDF 文本检查不能代替全部视觉排版检查；网页预览与原始文件能力分别报告。",
        "通过的基础设施脚本不使用模型；真实模型任务仅以本报告中的运行与下载记录为依据。",
        "真实 OpenAI Traces 上报、企业 SSO、企业 MCP 实例及生产恢复演练需要各自的独立验收。",
    ]
    blocks.extend(paragraph(item) for item in data["notes"].get("limitations", defaults))
    blocks.append(
        {
            "type": "details",
            "title": "证据来源清单与原始文件哈希",
            "text": json.dumps(data["sources"], ensure_ascii=False, indent=2),
        }
    )
    return report


CSS = """
:root{--ink:#152b3a;--muted:#526678;--line:#dbe5eb;--paper:#fff;--bg:#f2f5f7;--brand:#125f72;--accent:#d9a444;--fail:#9f3440;--pass:#226e50;--warn:#98640c}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:var(--bg);font:16px/1.7 Inter,"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",system-ui,sans-serif}a{color:#12677c}button{font:inherit}.shell{max-width:1320px;margin:auto;padding:36px 28px 80px}.hero{padding:46px 48px;border-radius:20px;background:linear-gradient(125deg,#133d52,#176575);color:#fff;box-shadow:0 18px 48px #133d5214}.eyebrow{font-size:12px;letter-spacing:.16em;font-weight:700;opacity:.8}.hero h1{font-size:40px;line-height:1.3;margin:14px 0 16px;font-weight:750;letter-spacing:-.02em}.hero p{max-width:860px;opacity:.9;margin:8px 0}.hero .meta{font-size:13px;opacity:.76;margin-top:24px}.hero a{color:#fff}.hero-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}.button{display:inline-flex;align-items:center;border:1px solid #ffffff6b;padding:10px 17px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600}.hero-state{display:inline-block;margin-top:12px;background:#ffffff1d;border:1px solid #ffffff44;border-radius:99px;padding:5px 14px;font-size:13px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0 28px}.kpi{padding:21px 23px;border:1px solid var(--line);border-radius:12px;background:white}.kpi .value{font-size:28px;line-height:1.3;font-weight:750;letter-spacing:-.02em}.kpi .label{font-size:13px;color:var(--muted);margin-top:7px}.layout{display:grid;grid-template-columns:205px minmax(0,1fr);gap:26px}.toc{align-self:start;position:sticky;top:20px;font-size:13px}.toc .label{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.1em;margin:3px 0 12px}.toc a{display:block;color:var(--muted);text-decoration:none;padding:9px 12px;border-left:2px solid var(--line)}.toc a:hover{color:var(--brand);border-color:var(--brand);background:#e6eef1}.content{min-width:0}section{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:32px;margin-bottom:22px;scroll-margin-top:20px}h2{font-size:25px;line-height:1.4;margin:0 0 10px;letter-spacing:-.02em}.section-index{display:block;font-size:11px;color:var(--brand);font-weight:750;letter-spacing:.12em;margin-bottom:8px}.lead{color:var(--muted);margin:0 0 22px;font-size:15px}p{margin:15px 0}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.6}#formats table{min-width:860px}#formats td:not(:last-child){white-space:nowrap;overflow-wrap:normal}thead{background:#eaf1f4}th{text-align:left;font-weight:700;white-space:normal}td,th{padding:12px 13px;border-bottom:1px solid var(--line);vertical-align:top}td{overflow-wrap:anywhere}td:first-child{font-weight:600}tbody tr:last-child td{border-bottom:0}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:9px;margin:16px 0}.table-wrap table{min-width:560px}.note,.warning{padding:14px 18px;border-left:3px solid var(--brand);background:#eef6f8;font-size:14px}.warning{border-color:var(--accent);background:#fff6e8;color:#705322}details{border:1px solid var(--line);border-radius:9px;margin:13px 0;overflow:hidden}summary{padding:13px 16px;cursor:pointer;font-size:14px;font-weight:650;background:#f7fafb}pre{font:12px/1.75 ui-monospace,SFMono-Regular,Consolas,"Microsoft YaHei",monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:18px;max-height:660px;overflow:auto;background:#fcfdfe}.shot{margin:24px 0 30px}.shot button{display:block;width:100%;padding:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;cursor:zoom-in;background:#edf2f4}.shot img{display:block;width:100%;height:auto;max-height:760px;object-fit:contain;object-position:top;background:#edf2f4}.shot.mobile button{max-width:420px;margin:auto}.shot figcaption{font-size:14px;margin-top:11px;font-weight:600}.shot small{display:block;color:var(--muted);font-size:11px;margin-top:3px;font-weight:400;overflow-wrap:anywhere}.download-link{display:flex;gap:12px;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:8px;padding:12px 15px;margin:10px 0;font-size:13px;text-decoration:none}.download-link span:last-child{font-weight:700;white-space:nowrap}.footer{margin-top:26px;color:var(--muted);font-size:12px}.badge{font-weight:700;white-space:nowrap}.badge.pass{color:var(--pass)}.badge.fail{color:var(--fail)}.badge.pending,.badge.limited{color:var(--warn)}dialog{border:0;background:#102332ed;max-width:98vw;max-height:98vh;width:fit-content;padding:56px 14px 14px;border-radius:10px}dialog::backdrop{background:#07141abf}dialog img{display:block;max-width:94vw;max-height:85vh;object-fit:contain}dialog button{position:absolute;top:10px;right:14px;border:1px solid #ffffff88;border-radius:6px;background:none;color:white;padding:6px 13px;cursor:pointer}.dialog-caption{position:absolute;top:14px;left:20px;right:110px;color:white;font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}@media(max-width:950px){.layout{grid-template-columns:1fr}.toc{position:static;display:flex;flex-wrap:wrap;gap:5px}.toc .label{width:100%}.toc a{padding:5px 9px;border:1px solid var(--line);border-radius:99px;font-size:12px}.kpis{grid-template-columns:repeat(2,1fr)}.hero h1{font-size:34px}}@media(max-width:600px){body{font-size:15px}.shell{padding:16px 12px 40px}.hero{padding:28px 23px;border-radius:14px}.hero h1{font-size:28px}.hero p{font-size:14px}.kpis{gap:9px;margin:15px 0 20px}.kpi{padding:15px}.kpi .value{font-size:23px}.kpi .label{font-size:12px}section{padding:22px 17px;border-radius:12px}h2{font-size:22px}.lead{font-size:14px}.table-wrap table{min-width:540px}.shot img{max-height:none}.download-link{align-items:flex-start;overflow-wrap:anywhere}}@media print{body{background:#fff;font-size:11px}.shell{padding:0}.hero{color:#102f40;background:#eef5f7;box-shadow:none;border:1px solid #ccdce3;padding:25px}.hero a{color:#102f40}.hero h1{font-size:28px}.toc,.hero-actions,dialog{display:none}.layout{display:block}.kpis{gap:8px}.kpi{padding:12px}.kpi .value{font-size:21px}section{break-inside:auto;padding:20px 0;border:0;border-top:1px solid #ccdce3;border-radius:0}h2{font-size:20px;break-after:avoid}.shot{break-inside:avoid}.shot img{max-height:440px}.table-wrap{overflow:visible}table{min-width:0!important;font-size:10px}th,td{padding:7px}details:not([open]){display:none}.footer{font-size:9px}}
"""


def render(report: Report, data: dict, results: Path, output: Path) -> tuple[str, str]:
    asset_name = output.name + ".assets"
    images = {}
    for image in data["screenshots"]:
        images[image["source"]] = (
            "data:image/png;base64," + base64.b64encode((results / image["source"]).read_bytes()).decode()
        )
    badges = {"通过": "pass", "未通过": "fail", "待验收": "pending", "有限支持；可下载原件": "limited"}

    def cell(value: Any) -> str:
        escaped = html.escape(text(value))
        return (
            f'<span class="badge {badges[value]}">{escaped}</span>'
            if isinstance(value, str) and value in badges
            else escaped
        )

    chunks = []
    markdown = [
        "# 真实生产任务验收报告",
        "",
        f"生成时间：{data['generated_at']}。报告来自本次实际证据，未完成项保留待验收状态。",
        "",
        f"[离线图文 HTML]({quote(output.name)}.html) · [证据与原件 ZIP]({quote(output.name)}-evidence.zip)",
        "",
    ]
    for index, section in enumerate(report.sections, 1):
        chunks.append(
            f'<section id="{section["id"]}"><span class="section-index">{index:02d} / ACCEPTANCE EVIDENCE</span><h2>{html.escape(section["title"])}</h2><p class="lead">{html.escape(section["lead"])}</p>'
        )
        markdown.extend([f"## {section['title']}", "", section["lead"], ""])
        for block in section["blocks"]:
            kind = block["type"]
            if kind == "paragraph":
                chunks.append(f'<p class="{block["tone"]}">{html.escape(block["text"])}</p>')
                markdown.extend([block["text"], ""])
            elif kind == "table":
                chunks.append(
                    '<div class="table-wrap"><table><thead><tr>'
                    + "".join(f"<th>{html.escape(value)}</th>" for value in block["headers"])
                    + "</tr></thead><tbody>"
                )
                chunks.extend(
                    "<tr>" + "".join(f"<td>{cell(value)}</td>" for value in row) + "</tr>"
                    for row in block["rows"]
                )
                chunks.append("</tbody></table></div>")
                markdown.extend(
                    [
                        "| " + " | ".join(block["headers"]) + " |",
                        "| " + " | ".join("---" for _ in block["headers"]) + " |",
                    ]
                )
                markdown.extend(
                    "| " + " | ".join(value.replace("|", "\\|").replace("\n", "<br>") for value in row) + " |"
                    for row in block["rows"]
                )
                markdown.append("")
            elif kind == "details":
                chunks.append(
                    f"<details><summary>{html.escape(block['title'])}</summary><pre>{html.escape(block['text'])}</pre></details>"
                )
                markdown.extend(
                    [
                        "<details>",
                        f"<summary>{html.escape(block['title'])}</summary>",
                        "",
                        "````text",
                        block["text"],
                        "````",
                        "",
                        "</details>",
                        "",
                    ]
                )
            elif kind == "figure":
                label = f"{block['viewport']} · {block['width']} × {block['height']} · {block['source']}"
                class_name = " mobile" if block["viewport"] == "手机 / 窄屏" else ""
                chunks.append(
                    f'<figure class="shot{class_name}"><button type="button" class="zoom" aria-label="放大：{html.escape(block["caption"])}"><img loading="lazy" src="{images[block["source"]]}" alt="{html.escape(block["caption"])}"></button><figcaption>{html.escape(block["caption"])}<small>{html.escape(label)}</small></figcaption></figure>'
                )
                markdown.extend(
                    [
                        f"![{block['caption']}]({quote(asset_name + '/screenshots/' + block['source'])})",
                        "",
                        f"{block['caption']} · {label}",
                        "",
                    ]
                )
            elif kind == "download":
                path = results / block["source"]
                mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                encoded = base64.b64encode(path.read_bytes()).decode()
                chunks.append(
                    f'<a class="download-link" download="{html.escape(block["name"])}" href="data:{mime};base64,{encoded}"><span>{html.escape(block["name"])} · {html.escape(block.get("version", "当前保存原件"))} · {block["bytes"]:,} 字节</span><span>下载原件 ↗</span></a>'
                )
                markdown.extend(
                    [
                        f"[下载原件：{block['name']} · {block.get('version', '当前保存原件')}]({quote(asset_name + '/downloads/' + block['source'])})",
                        "",
                    ]
                )
        chunks.append("</section>")
    formats = format_rows(data)
    passed_formats = sum(row[1] == "通过" for row in formats)
    successful_runs = sum(run.get("status") == "completed" for run in data["runs"])
    failed_runs = sum(run.get("status") == "failed" for run in data["runs"])
    summary = "当前快照：仍有待验收项目" if passed_formats < 5 else "当前快照：五格式原件已完成独立验证"
    if data["analysis_quality"] and not data["analysis_quality"][-1]["overall_analysis_pass"]:
        summary = "当前快照：经营分析内容未通过，等待纠正复验"
    elif any(row[3] == "未通过" for row in formats):
        summary = "当前快照：成果内容或显示仍需修正，保留修正前原件"
    navigation = "".join(
        f'<a href="#{section["id"]}">{html.escape(section["title"])}</a>' for section in report.sections
    )
    cards = "".join(
        f'<div class="kpi"><div class="value">{value}</div><div class="label">{label}</div></div>'
        for value, label in [
            (f"{passed_formats} / 5", "格式原件独立验证通过"),
            (str(successful_runs), "真实模型运行完成次数"),
            (str(failed_runs), "保留的失败运行记录"),
            (str(len(data["screenshots"])), "本次现场截图"),
        ]
    )
    script = """const viewer=document.getElementById('viewer');document.querySelectorAll('.zoom').forEach(button=>button.addEventListener('click',()=>{const img=button.querySelector('img');viewer.querySelector('img').src=img.src;viewer.querySelector('img').alt=img.alt;viewer.querySelector('.dialog-caption').textContent=img.alt;viewer.showModal()}));viewer.querySelector('button').addEventListener('click',()=>viewer.close());viewer.addEventListener('click',event=>{if(event.target===viewer)viewer.close()});"""
    page = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>真实生产任务验收报告 · 2026-11-03</title><style>{CSS}</style></head><body><div class="shell"><header class="hero"><div class="eyebrow">FAMSUN · LIVE PRODUCTION ACCEPTANCE · 2026.11.03</div><h1>真实任务，逐项验收。<br>从模型执行到可交付原件</h1><p>覆盖离线贪吃蛇、制造业数据分析、HTML / Excel / Word / PDF / PowerPoint 成果，保留基线失败、修复动作和复验依据。</p><div class="hero-state">{summary}</div><div class="hero-actions"><a class="button" href="{quote(output.name)}-evidence.zip" download>下载证据与真实原件 ZIP</a><a class="button" href="#formats">查看五格式结果</a><a class="button" href="#screenshots">查看现场截图</a></div><div class="meta">模型：{html.escape(data["environment"].get("model", "未记录"))} · 协议：Responses · 生成于 {html.escape(data["generated_at"])}</div></header><div class="kpis">{cards}</div><div class="layout"><nav class="toc" aria-label="报告目录"><div class="label">报告目录 / CONTENTS</div>{navigation}</nav><main class="content">{"".join(chunks)}</main></div><footer class="footer">依据实际保存的证据生成。未完成、失败与有限支持均明确标注；离线打开本 HTML 可查看全部截图和下载已嵌入的真实原件。</footer></div><dialog id="viewer" aria-label="放大截图"><span class="dialog-caption"></span><button type="button">关闭 ×</button><img alt=""></dialog><script>{script}</script></body></html>'''
    return page, "\n".join(markdown)


def build(results: Path, output: Path, notes: Path | None) -> dict:
    results = results.resolve()
    output = output.resolve()
    if not results.is_dir():
        raise ValueError(f"Evidence directory does not exist: {results}")
    data = collect(results, notes)
    report = compose(data)
    page, markdown = render(report, data, results, output)
    output.parent.mkdir(parents=True, exist_ok=True)
    html_path = output.with_suffix(".html")
    markdown_path = output.with_suffix(".md")
    data_path = output.with_suffix(".json")
    html_path.write_text(page, encoding="utf-8")
    markdown_path.write_text(markdown, encoding="utf-8")
    data_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    assets = output.parent / (output.name + ".assets")
    copied = []
    for kind, entries in (("screenshots", data["screenshots"]), ("downloads", data["downloads"])):
        for entry in entries:
            source = results / entry["source"]
            target = assets / kind / entry["source"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            copied.append(target)
    bundle_path = output.parent / (output.name + "-evidence.zip")
    manifest = []
    with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in [html_path, markdown_path, data_path, *copied]:
            member = path.relative_to(output.parent).as_posix()
            archive.write(path, member)
            manifest.append({"path": member, "bytes": path.stat().st_size, "sha256": sha(path)})
        oracle = data.get("oracle", {})
        names = list(oracle.get("inputs", {}).values()) + ["expected-results.json", "prompts.json"]
        for name in names:
            path = results / "inputs" / Path(name).name
            if not safe_file(path, results):
                continue
            member = "inputs/" + path.name
            archive.write(path, member)
            manifest.append({"path": member, "bytes": path.stat().st_size, "sha256": sha(path)})
        archive.writestr(
            "MANIFEST.json",
            json.dumps(
                {
                    "generated_at": data["generated_at"],
                    "evidence_policy": data["evidence_policy"],
                    "files": manifest,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
        )
    with zipfile.ZipFile(bundle_path) as archive:
        assert archive.testzip() is None
        assert not any(SENSITIVE_NAME.search(name) for name in archive.namelist())
    return {
        "html": str(html_path),
        "markdown": str(markdown_path),
        "data": str(data_path),
        "bundle": str(bundle_path),
        "screenshots": len(data["screenshots"]),
        "downloads": len(data["downloads"]),
        "runs": len(data["runs"]),
        "format_validation_reports": len(data["validations"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument(
        "--output", type=Path, default=DEFAULT_OUTPUT, help="Output basename without an extension"
    )
    parser.add_argument(
        "--notes",
        type=Path,
        help="Optional reviewed report-notes.json; defaults to results/report-notes.json",
    )
    args = parser.parse_args()
    notes = args.notes or args.results / "report-notes.json"
    print(json.dumps(build(args.results, args.output, notes), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
