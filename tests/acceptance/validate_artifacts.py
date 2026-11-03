"""Validate downloaded, live-generated manufacturing reports against independent results.

Run with the repository virtual environment. Parser dependencies are test-only:
openpyxl, python-docx, python-pptx, and pypdf. Missing dependencies are failures,
never successful skips. This checks file structure and reported values; it does
not replace the browser review of layout, charts, or the live generation flow.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import re
import sys
import unicodedata
import zipfile
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

FORMATS = {"html", "xlsx", "docx", "pdf", "pptx"}
PARSERS = {
    "xlsx": ("openpyxl", "openpyxl"),
    "docx": ("docx", "python-docx"),
    "pptx": ("pptx", "python-pptx"),
    "pdf": ("pypdf", "pypdf"),
}
OOXML_PARTS = {
    "xlsx": "xl/workbook.xml",
    "docx": "word/document.xml",
    "pptx": "ppt/presentation.xml",
}
CJK = re.compile(r"[\u3400-\u9fff]")
NUMBER = re.compile(r"(?<![\d.])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*%?(?![\d.])")


def normalize(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value))).strip()


def table_units(rows: list[list[str]]) -> list[str]:
    """Keep row context and also pair multi-column table headers with their values."""
    nonempty = [row for row in rows if any(row)]
    units = [" | ".join(row) for row in nonempty]
    if len(nonempty) > 1:
        headers = nonempty[0]
        for row in nonempty[1:]:
            units.extend(f"{heading}: {value}" for heading, value in zip(headers, row) if heading and value)
    return units


class ReportHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: set[str] = set()
        self.closed: set[str] = set()
        self.units: list[str] = []
        self.tables: list[list[list[str]]] = []
        self._text: list[str] = []
        self._table: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell: list[str] | None = None
        self._hidden = 0
        self.resources: list[str] = []
        self.styles: list[str] = []

    def flush(self) -> None:
        value = normalize(" ".join(self._text))
        if value:
            self.units.append(value)
        self._text = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.add(tag)
        attributes = dict(attrs)
        if attributes.get("src"):
            self.resources.append(attributes["src"])
        if tag == "link" and "stylesheet" in (attributes.get("rel") or "") and attributes.get("href"):
            self.resources.append(attributes["href"])
        if attributes.get("style"):
            self.styles.append(attributes["style"])
        if tag in {"script", "style"}:
            self._hidden += 1
        if tag == "table":
            self.flush()
            self._table = []
        elif tag == "tr":
            self._row = []
        elif tag in {"th", "td"}:
            self._cell = []
        elif tag in {"p", "div", "h1", "h2", "h3", "h4", "li", "br"}:
            self.flush()

    def handle_endtag(self, tag: str) -> None:
        self.closed.add(tag)
        if tag in {"script", "style"}:
            self._hidden = max(0, self._hidden - 1)
        if tag in {"th", "td"} and self._cell is not None:
            if self._row is not None:
                self._row.append(normalize(" ".join(self._cell)))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._table is not None:
                self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None
            self.flush()
        elif tag in {"p", "div", "h1", "h2", "h3", "h4", "li"}:
            self.flush()

    def handle_data(self, data: str) -> None:
        if self._hidden:
            self.styles.append(data)
            return
        if self._cell is not None:
            self._cell.append(data)
        else:
            self._text.append(data)


def check_zip(path: Path, kind: str) -> dict[str, Any]:
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > 10000 or sum(item.file_size for item in members) > 100 * 1024 * 1024:
            raise ValueError("OOXML archive exceeds the 100 MiB / 10,000-entry acceptance limit")
        corrupt = archive.testzip()
        if corrupt:
            raise ValueError(f"OOXML ZIP CRC failure: {corrupt}")
        required = ["[Content_Types].xml", "_rels/.rels", OOXML_PARTS[kind]]
        for part in required:
            if part not in archive.namelist():
                raise ValueError(f"Missing required OOXML part: {part}")
            ElementTree.fromstring(archive.read(part))
    return {"zip_crc": "pass", "required_xml_parts": required}


def extract_html(path: Path) -> tuple[list[str], dict[str, Any]]:
    parser = ReportHTMLParser()
    parser.feed(path.read_text(encoding="utf-8-sig"))
    parser.close()
    parser.flush()
    if not {"html", "body", "table"}.issubset(parser.tags):
        raise ValueError("HTML must contain html, body, and a report table")
    if not {"html", "body", "table"}.issubset(parser.closed):
        raise ValueError("HTML document/table is incomplete")
    if not any(parser.tables):
        raise ValueError("HTML has no populated table rows")
    for source in parser.resources:
        if source.startswith(("https:", "http:", "//")):
            raise ValueError(f"HTML depends on an external resource: {source}")
        if not source.startswith(("data:", "#")) and not (path.parent / source).is_file():
            raise ValueError(f"HTML local resource is missing: {source}")
    if re.search(r"(?:@import\s|url\s*\(\s*['\"]?(?:https?:|//))", "\n".join(parser.styles), re.IGNORECASE):
        raise ValueError("HTML styles require external resources")
    units = parser.units + [unit for table in parser.tables for unit in table_units(table)]
    return units, {"tables": len(parser.tables), "encoding": "UTF-8"}


def extract_xlsx(path: Path) -> tuple[list[str], dict[str, Any]]:
    import openpyxl

    workbook = openpyxl.load_workbook(path, data_only=True, read_only=True)
    formulas = openpyxl.load_workbook(path, data_only=False, read_only=True)
    units: list[str] = []
    try:
        if len(workbook.sheetnames) < 3:
            raise ValueError("Excel report must contain at least three worksheets")
        sheets = []
        numeric_cells = 0
        for sheet in workbook:
            rows = []
            for row, formula_row in zip(sheet.iter_rows(), formulas[sheet.title].iter_rows(), strict=True):
                values = []
                for cell, formula_cell in zip(row, formula_row, strict=True):
                    if (
                        formula_cell.data_type == "f"
                        and isinstance(cell.value, str)
                        and cell.value.startswith("=")
                    ):
                        raise ValueError(
                            f"Excel formula cache contains a formula string instead of a displayable value "
                            f"at {sheet.title}!{cell.coordinate}"
                        )
                    if cell.data_type == "e":
                        raise ValueError(
                            f"Excel error value at {sheet.title}!{cell.coordinate}: {cell.value}"
                        )
                    if isinstance(cell.value, (int, float)) and not isinstance(cell.value, bool):
                        numeric_cells += 1
                        value = str(cell.value)
                        # Percent-formatted numeric cells store fractions in OOXML.
                        if "%" in cell.number_format:
                            decimals = re.search(r"\.([0#]+)[^;]*%", cell.number_format)
                            precision = len(decimals[1]) if decimals else 0
                            rounded = (Decimal(str(cell.value)) * 100).quantize(Decimal(1).scaleb(-precision))
                            value = f"{rounded}%"
                        elif decimals := re.search(r"\.([0#]+)", cell.number_format):
                            value = str(
                                Decimal(str(cell.value)).quantize(Decimal(1).scaleb(-len(decimals[1])))
                            )
                    else:
                        value = "" if cell.value is None else normalize(cell.value)
                    values.append(value)
                rows.append(values)
            units.extend(table_units(rows))
            sheets.append({"name": sheet.title, "rows": len(rows)})
        if not numeric_cells:
            raise ValueError("Excel report has no usable numeric cells (uncached formulas are not values)")
        return units, {"sheets": sheets, "numeric_cells": numeric_cells}
    finally:
        workbook.close()
        formulas.close()


def extract_docx(path: Path) -> tuple[list[str], dict[str, Any]]:
    from docx import Document

    document = Document(path)
    units = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
    for table in document.tables:
        units.extend(table_units([[cell.text for cell in row.cells] for row in table.rows]))
    for section in document.sections:
        units.extend(paragraph.text for paragraph in section.header.paragraphs if paragraph.text.strip())
        units.extend(paragraph.text for paragraph in section.footer.paragraphs if paragraph.text.strip())
    return units, {"paragraphs": len(document.paragraphs), "tables": len(document.tables)}


def extract_pptx(path: Path) -> tuple[list[str], dict[str, Any]]:
    from pptx import Presentation

    presentation = Presentation(path)
    if len(presentation.slides) < 5:
        raise ValueError("PowerPoint report must contain at least five slides")
    units = []
    slides = []
    for index, slide in enumerate(presentation.slides, 1):
        slide_units = []
        for shape in slide.shapes:
            tolerance = 914400 * 1e-4  # 0.0001 inch; permit harmless EMU rounding only.
            right, bottom = shape.left + shape.width, shape.top + shape.height
            if (
                shape.left < -tolerance
                or shape.top < -tolerance
                or right > presentation.slide_width + tolerance
                or bottom > presentation.slide_height + tolerance
            ):
                raise ValueError(
                    f"PowerPoint slide {index} shape {shape.name!r} exceeds slide bounds: "
                    f"left={shape.left / 914400:.4f}, top={shape.top / 914400:.4f}, "
                    f"right={right / 914400:.4f}, bottom={bottom / 914400:.4f} inches; "
                    f"canvas={presentation.slide_width / 914400:.4f} × "
                    f"{presentation.slide_height / 914400:.4f} inches"
                )
            if shape.has_text_frame:
                slide_units.extend(paragraph.text for paragraph in shape.text_frame.paragraphs)
            if shape.has_table:
                slide_units.extend(
                    table_units([[cell.text for cell in row.cells] for row in shape.table.rows])
                )
        if not normalize(" ".join(slide_units)):
            raise ValueError(f"PowerPoint slide {index} has no extractable text")
        units.extend(slide_units)
        slides.append({"slide": index, "text_characters": len(" ".join(slide_units))})
    return units, {"slides": slides}


def extract_pdf(path: Path) -> tuple[list[str], dict[str, Any]]:
    from pypdf import PdfReader

    if not path.read_bytes().startswith(b"%PDF-"):
        raise ValueError("Missing PDF header")
    reader = PdfReader(path, strict=True)
    if reader.is_encrypted:
        raise ValueError("PDF report is encrypted")
    if not reader.pages:
        raise ValueError("PDF report has no pages")
    units = []
    pages = []
    for index, page in enumerate(reader.pages, 1):
        content = page.extract_text() or ""
        if not normalize(content):
            raise ValueError(f"PDF page {index} is empty or lacks extractable text")
        if not CJK.search(content):
            raise ValueError(f"PDF page {index} has no extractable Chinese text")
        units.extend(content.splitlines())
        units.extend((page.extract_text(extraction_mode="layout") or "").splitlines())
        pages.append(
            {"page": index, "text_characters": len(content), "cjk_characters": len(CJK.findall(content))}
        )
    return units, {"pages": pages}


EXTRACTORS = {
    "html": extract_html,
    "xlsx": extract_xlsx,
    "docx": extract_docx,
    "pptx": extract_pptx,
    "pdf": extract_pdf,
}


def numeric_token(value: str) -> tuple[Decimal, bool] | None:
    normalized = normalize(value).replace(",", "").replace(" ", "")
    percent = normalized.endswith("%")
    try:
        return Decimal(normalized.removesuffix("%")), percent
    except InvalidOperation:
        return None


def match_metric(check: dict[str, Any], units: list[str], all_aliases: list[str]) -> dict[str, Any]:
    aliases = sorted(
        {normalize(check["label"]), *(normalize(alias) for alias in check.get("aliases", []))},
        key=len,
        reverse=True,
    )
    formats = [str(value) for value in check.get("formats", [check["value"]])]
    numeric = numeric_token(str(check["value"])) is not None
    percentage = "率" in check["label"] or check["key"].endswith("_pct")
    targets = (
        {token[0] for value in formats if (token := numeric_token(value)) is not None} if numeric else set()
    )
    candidates = []
    for index, unit in enumerate(units):
        for alias in aliases:
            position = unit.find(alias)
            if position < 0:
                continue
            tail = unit[position + len(alias) :]
            # A label alone can be followed by its value on the next text line.
            if not NUMBER.search(tail) and len(tail.strip(" :：|()吨万元%")) < 8 and index + 1 < len(units):
                tail += " " + units[index + 1]
            next_labels = [tail.find(other) for other in all_aliases if tail.find(other) >= 0]
            if next_labels:
                tail = tail[: min(next_labels)]
            tail = tail[:180]
            if numeric:
                values = [token.group() for token in NUMBER.finditer(tail)]
                token = numeric_token(values[0]) if values else None
                matched = token is not None and token[0] in targets and (percentage or not token[1])
                candidates.extend(values[:4])
            else:
                matched = any(normalize(value) in normalize(tail) for value in formats)
                candidates.append(tail.strip())
            if matched:
                return {
                    "key": check["key"],
                    "label": check["label"],
                    "status": "pass",
                    "expected": check["value"],
                    "evidence": normalize(alias + tail)[:220],
                }
    return {
        "key": check["key"],
        "label": check["label"],
        "status": "fail",
        "expected": check["value"],
        "accepted_formats": formats,
        "observed_near_label": list(dict.fromkeys(candidates))[:12],
        "reason": "Expected value not found beside its report label",
    }


def validate_file(path: Path, checks: list[dict[str, Any]]) -> dict[str, Any]:
    kind = path.suffix.lower().lstrip(".")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    result: dict[str, Any] = {
        "file": str(path.resolve()),
        "format": kind,
        "bytes": path.stat().st_size,
        "sha256": digest,
    }
    try:
        if not path.stat().st_size:
            raise ValueError("Artifact is empty")
        structure = check_zip(path, kind) if kind in OOXML_PARTS else {}
        units, details = EXTRACTORS[kind](path)
        units = [normalize(unit) for unit in units if normalize(unit)]
        text = "\n".join(units)
        if not CJK.search(text):
            raise ValueError("Report has no extractable Chinese text")
        aliases = [
            normalize(alias) for check in checks for alias in [check["label"], *check.get("aliases", [])]
        ]
        metrics = [match_metric(check, units, aliases) for check in checks]
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError(
                "Artifact changed while it was being validated; repeat on stable downloaded bytes"
            )
        result.update(
            {
                "structure": structure | details,
                "metrics": metrics,
                "text_characters": len(text),
                "text_preview": text[:600],
                "status": "pass" if all(item["status"] == "pass" for item in metrics) else "fail",
            }
        )
    except Exception as error:  # noqa: BLE001 - malformed files must fail the report without aborting the batch.
        result.update({"status": "fail", "error": f"{type(error).__name__}: {error}"})
    return result


def run(expected_path: Path, artifacts: Path, report_path: Path, allow_partial: bool = False) -> int:
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    checks = expected.get("report_checks", [])
    if not checks:
        raise ValueError("Expected-results JSON must contain a nonempty report_checks list")
    for check in checks:
        if not {"key", "label", "value"}.issubset(check):
            raise ValueError("Every report_check requires key, label, and value")
    paths = sorted(
        path for path in artifacts.rglob("*") if path.is_file() and path.suffix.lower()[1:] in FORMATS
    )
    found = {path.suffix.lower()[1:] for path in paths}
    required = found if allow_partial else FORMATS
    dependencies = {}
    for kind in sorted(required & PARSERS.keys()):
        module, package = PARSERS[kind]
        try:
            importlib.import_module(module)
            dependencies[package] = {"status": "available", "version": importlib.metadata.version(package)}
        except (ImportError, importlib.metadata.PackageNotFoundError) as error:
            dependencies[package] = {"status": "missing", "error": str(error)}
    results = [validate_file(path, checks) for path in paths]
    missing = sorted(required - found)
    passed = (
        bool(paths) and not missing and all(item["status"] == "available" for item in dependencies.values())
    )
    passed = passed and all(result["status"] == "pass" for result in results)
    report = {
        "schema_version": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "expected_results": str(expected_path.resolve()),
        "artifacts_directory": str(artifacts.resolve()),
        "status": "pass" if passed else "fail",
        "allow_partial": allow_partial,
        "required_formats": sorted(required),
        "missing_formats": missing,
        "dependencies": dependencies,
        "artifacts": results,
        "limitations": [
            "Structural and text/value validation does not assess visual layout or chart accuracy.",
            "Uncached Excel formulas and image-only PDF pages cannot satisfy value/text checks.",
        ],
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{report['status'].upper()}: {len(results)} artifacts; report: {report_path}")
    if missing:
        print("Missing formats: " + ", ".join(missing))
    for package, dependency in dependencies.items():
        if dependency["status"] == "missing":
            print(f"Missing parser {package}: {dependency['error']}")
    for result in results:
        if result["status"] == "fail":
            failed = [item["label"] for item in result.get("metrics", []) if item["status"] == "fail"]
            print(f"FAIL {Path(result['file']).name}: {result.get('error') or ', '.join(failed)}")
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected", required=True, type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument(
        "--allow-partial", action="store_true", help="Validate present types; do not waive file failures"
    )
    args = parser.parse_args()
    try:
        return run(args.expected, args.artifacts, args.report, args.allow_partial)
    except (OSError, ValueError, KeyError) as error:
        print(f"Validation configuration error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
