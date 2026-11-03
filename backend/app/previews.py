"""Bounded, read-only Office previews; parser runs outside the API process.

The worker receives one already-authorized file descriptor and no application
credentials. It never evaluates spreadsheet formulas, macros, or document links.
"""

from __future__ import annotations

import asyncio
import base64
import datetime
import io
import json
import math
import os
import re
import sys
import zipfile
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext
from itertools import islice
from pathlib import Path

MAX_ROWS, MAX_COLUMNS, MAX_SHEETS = 1000, 50, 20
MAX_TEXT = 2_000_000
MAX_CELLS = 50_000
MAX_OFFICE_CELLS = 20_000
MAX_DOCUMENT_BLOCKS = 2000
MAX_SLIDES, MAX_SLIDE_SHAPES = 30, 200
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_SINGLE_IMAGE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_IMAGE_PIXELS = 64_000_000
MAX_IMAGES = 64


class _OfficeBudget:
    """One global budget covers every block/slide, including repeated images."""

    def __init__(self):
        self.text_remaining = MAX_TEXT
        self.cells_remaining = MAX_OFFICE_CELLS
        self.image_remaining = MAX_IMAGE_BYTES
        self.image_pixels_remaining = MAX_TOTAL_IMAGE_PIXELS
        self.images_remaining = MAX_IMAGES
        self.paragraphs_remaining = MAX_DOCUMENT_BLOCKS
        self.truncated = False

    def text(self, value, limit=4096):
        value = str(value or "")
        result = value[:min(limit, max(0, self.text_remaining))]
        self.text_remaining -= len(result)
        self.truncated |= len(result) < len(value)
        return result

    def pixels(self, value, *, dimension=False):
        raw = int(value)
        bounded = min(8192 * 9525, max(0 if dimension else -8192 * 9525, raw))
        self.truncated |= raw != bounded
        return round(bounded / 9525, 3)

    def table(self, table):
        rows = []
        for index, row in enumerate(table.rows):
            if index >= MAX_ROWS or self.cells_remaining <= 0 or self.text_remaining <= 0:
                self.truncated = True
                break
            values = []
            for column, cell in enumerate(row.cells):
                if column >= MAX_COLUMNS or self.cells_remaining <= 0 or self.text_remaining <= 0:
                    self.truncated = True
                    break
                values.append(self.text(cell.text))
                self.cells_remaining -= 1
                # Nested tables and embedded drawings are not flattened silently.
                if getattr(cell, "tables", None) or cell._tc.xpath(".//a:blip"):
                    self.truncated = True
            rows.append(values)
        return rows

    def image(self, blob):
        if not blob or self.images_remaining <= 0 or len(blob) > min(MAX_SINGLE_IMAGE_BYTES, self.image_remaining):
            self.truncated = True
            return None
        from PIL import Image

        try:
            with Image.open(io.BytesIO(blob)) as image:
                mime = {"PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif", "WEBP": "image/webp"}.get(
                    image.format
                )
                pixels = image.width * image.height
                if (
                    not mime or max(image.size) > 8192 or pixels > min(16_000_000, self.image_pixels_remaining)
                    or getattr(image, "is_animated", False)
                ):
                    self.truncated = True
                    return None
                image.verify()
        except Exception:  # noqa: BLE001 - omit invalid embedded media, never expose parser details.
            self.truncated = True
            return None
        self.image_remaining -= len(blob)
        self.image_pixels_remaining -= pixels
        self.images_remaining -= 1
        return f"data:{mime};base64,{base64.b64encode(blob).decode('ascii')}"


def _docx_preview(handle):
    from docx import Document
    from docx.oxml.ns import qn
    from docx.table import Table

    document = Document(handle)
    budget = _OfficeBudget()
    blocks, paragraphs = [], []

    def append(block):
        if len(blocks) >= MAX_DOCUMENT_BLOCKS:
            budget.truncated = True
            return False
        blocks.append(block)
        if block["type"] == "paragraph":
            paragraphs.append(block["text"])
        elif block["type"] == "table":
            paragraphs.extend(" | ".join(row) for row in block["rows"])
        return True

    for block in document.iter_inner_content():
        if len(blocks) >= MAX_DOCUMENT_BLOCKS or budget.text_remaining <= 0:
            budget.truncated = True
            break
        if isinstance(block, Table):
            append({"type": "table", "rows": budget.table(block)})
            continue
        heading = re.match(r"Heading\s*([1-6])$", block.style.name if block.style else "", re.IGNORECASE)
        text_parts = []
        emitted = False

        def flush_text(parts=text_parts, paragraph_heading=heading):
            nonlocal emitted
            if parts:
                paragraph = {"type": "paragraph", "text": budget.text("".join(parts))}
                if paragraph_heading:
                    paragraph["heading"] = int(paragraph_heading[1])
                append(paragraph)
                parts.clear()
                emitted = True

        # XML order preserves inline images between text runs and hyperlink labels.
        for node in block._p.iter():
            if node.tag == qn("w:t"):
                text_parts.append(node.text or "")
            elif node.tag == qn("w:tab"):
                text_parts.append("\t")
            elif node.tag in {qn("w:br"), qn("w:cr")}:
                text_parts.append("\n")
            elif node.tag == qn("a:blip"):
                flush_text()
                relation_id = node.get(qn("r:embed"))
                relation = document.part.rels.get(relation_id) if relation_id else None
                if relation is None or relation.is_external:
                    budget.truncated = True
                    continue
                source = budget.image(relation.target_part.blob)
                if source is None:
                    continue
                image = {"type": "image", "src": source, "alt": "文档内嵌图片"}
                parent = node.getparent()
                while parent is not None and parent.tag not in {qn("wp:inline"), qn("wp:anchor")}:
                    parent = parent.getparent()
                if parent is not None:
                    extent = parent.find(qn("wp:extent"))
                    if extent is not None:
                        image.update(width=budget.pixels(extent.get("cx", 0), dimension=True),
                                     height=budget.pixels(extent.get("cy", 0), dimension=True))
                append(image)
                emitted = True
        flush_text()
        if not emitted and not text_parts:
            append({"type": "paragraph", "text": ""})
    return {"kind": "document", "paragraphs": paragraphs, "blocks": blocks, "truncated": budget.truncated}


def _rgb(color):
    try:
        value = color.rgb
        return f"#{str(value).lower()}" if value is not None else None
    except (AttributeError, TypeError, ValueError):
        return None


def _solid_fill(fill):
    from pptx.enum.dml import MSO_FILL_TYPE

    return _rgb(fill.fore_color) if fill.type == MSO_FILL_TYPE.SOLID else None


def _pptx_text_frame(frame, budget, *, cell=None):
    from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE

    # Table insets live on tcPr; text-frame bodyPr exposes different defaults.
    owner = cell if cell is not None else frame
    result = {
        "margins": {side: budget.pixels(getattr(owner, f"margin_{side}"), dimension=True)
                    for side in ("top", "right", "bottom", "left")},
        "vertical_align": {MSO_ANCHOR.MIDDLE: "middle", MSO_ANCHOR.BOTTOM: "bottom"}.get(
            owner.vertical_anchor, "top"
        ),
    }
    if frame.word_wrap is not None:
        result["word_wrap"] = frame.word_wrap
    if frame.auto_size == MSO_AUTO_SIZE.SHAPE_TO_FIT_TEXT:
        result["auto_size"] = "shape_to_fit_text"
    elif frame.auto_size == MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE:
        # Native font fitting is not approximated by silently shrinking text.
        budget.truncated = True
    return result


def _pptx_paragraphs(frame, budget):
    from pptx.enum.text import PP_ALIGN

    paragraphs = []
    for paragraph in frame.paragraphs:
        if budget.paragraphs_remaining <= 0 or budget.text_remaining <= 0:
            budget.truncated = True
            break
        budget.paragraphs_remaining -= 1
        value = {"text": budget.text(paragraph.text.replace("\v", "\n"))}
        font = paragraph.runs[0].font if paragraph.runs else paragraph.font
        size = font.size or paragraph.font.size
        if size is not None:
            pixels = round(size.pt * 4 / 3, 3)
            value["font_size"] = min(256, max(1, pixels))
            budget.truncated |= value["font_size"] != pixels
        family = font.name or paragraph.font.name
        if family:
            value["font_family"] = budget.text(family, 128)
        color = _rgb(font.color) or _rgb(paragraph.font.color)
        if color:
            value["color"] = color
        for name in ("bold", "italic"):
            actual = getattr(font, name)
            if actual is None:
                actual = getattr(paragraph.font, name)
            if actual is not None:
                value[name] = actual
        align = {PP_ALIGN.LEFT: "left", PP_ALIGN.CENTER: "center", PP_ALIGN.RIGHT: "right",
                 PP_ALIGN.JUSTIFY: "justify"}.get(paragraph.alignment)
        if align:
            value["align"] = align
        for name in ("space_before", "space_after"):
            spacing = getattr(paragraph, name)
            if spacing is not None:
                value[name] = budget.pixels(spacing, dimension=True)
        spacing = paragraph.line_spacing
        if spacing is not None:
            if isinstance(spacing, float):
                bounded = min(10, max(0, spacing))
                budget.truncated |= bounded != spacing
                value["line_spacing"] = {"kind": "multiple", "value": bounded}
            else:
                value["line_spacing"] = {"kind": "pixels", "value": budget.pixels(spacing, dimension=True)}
        paragraphs.append(value)
    return paragraphs


def _pptx_table(table, budget):
    rows, cells, heights = [], [], []
    widths = [budget.pixels(column.width, dimension=True) for column in islice(table.columns, MAX_COLUMNS)]
    for index, row in enumerate(table.rows):
        if (index >= MAX_ROWS or budget.cells_remaining <= 0 or budget.text_remaining <= 0
                or budget.paragraphs_remaining <= 0):
            budget.truncated = True
            break
        values, styles = [], []
        for column, cell in enumerate(row.cells):
            if (column >= MAX_COLUMNS or budget.cells_remaining <= 0 or budget.text_remaining <= 0
                    or budget.paragraphs_remaining <= 0):
                budget.truncated = True
                break
            budget.cells_remaining -= 1
            paragraphs = _pptx_paragraphs(cell.text_frame, budget)
            # Keep the original string rows contract; styled paragraphs carry
            # the same bounded text and never include raw OOXML or relationships.
            values.append("\n".join(paragraph["text"] for paragraph in paragraphs))
            style = {"paragraphs": paragraphs, "text_frame": _pptx_text_frame(cell.text_frame, budget, cell=cell)}
            fill = _solid_fill(cell.fill)
            if fill:
                style["fill"] = fill
            if cell.is_merge_origin or cell.is_spanned:
                budget.truncated = True
            styles.append(style)
        rows.append(values)
        cells.append(styles)
        heights.append(budget.pixels(row.height, dimension=True))
    return {"rows": rows, "cells": cells, "column_widths": widths, "row_heights": heights}


def _pptx_preview(handle):
    from pptx import Presentation
    from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE, MSO_SHAPE_TYPE

    presentation = Presentation(handle)
    budget = _OfficeBudget()
    slides = []
    budget.truncated = len(presentation.slides) > MAX_SLIDES
    for index, slide in enumerate(presentation.slides):
        if index >= MAX_SLIDES:
            break
        result = {"title": budget.text(slide.shapes.title.text if slide.shapes.title else f"幻灯片 {index + 1}"),
                  "elements": []}
        background = _solid_fill(slide.background.fill)
        if background:
            result["background"] = background
        for shape_index, shape in enumerate(slide.shapes):
            if shape_index >= MAX_SLIDE_SHAPES or budget.text_remaining <= 0:
                budget.truncated = True
                break
            geometry = {"x": budget.pixels(shape.left), "y": budget.pixels(shape.top),
                        "width": budget.pixels(shape.width, dimension=True),
                        "height": budget.pixels(shape.height, dimension=True)}
            if shape.has_table:
                result["elements"].append({"type": "table", **geometry, **_pptx_table(shape.table, budget)})
            elif shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                try:
                    source = budget.image(shape.image.blob)
                except (AttributeError, KeyError, ValueError):
                    source = None
                    budget.truncated = True
                if source:
                    result["elements"].append({"type": "image", **geometry, "src": source,
                                               "alt": budget.text(shape.name, 300)})
                if any((shape.crop_left, shape.crop_right, shape.crop_top, shape.crop_bottom)):
                    budget.truncated = True
            elif shape.has_text_frame:
                shape_kind = "rect"
                if shape.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE:
                    shape_kind = {
                        MSO_AUTO_SHAPE_TYPE.RECTANGLE: "rect",
                        MSO_AUTO_SHAPE_TYPE.OVAL: "ellipse",
                        MSO_AUTO_SHAPE_TYPE.ROUNDED_RECTANGLE: "roundRect",
                    }.get(shape.auto_shape_type)
                    if shape_kind is None:
                        budget.truncated = True
                        if not shape.text:
                            continue
                fill = _solid_fill(shape.fill) if shape_kind else None
                stroke = _rgb(shape.line.color) if shape_kind else None
                element = {"type": "text" if shape.text else "shape", **geometry}
                if shape_kind:
                    element["shape"] = shape_kind
                if fill:
                    element["fill"] = fill
                if stroke:
                    element["stroke"] = stroke
                if shape.text:
                    element["paragraphs"] = _pptx_paragraphs(shape.text_frame, budget)
                    element["text_frame"] = _pptx_text_frame(shape.text_frame, budget)
                result["elements"].append(element)
            else:
                # Charts, OLE, media and groups are not rendered as misleading rectangles.
                budget.truncated = True
            if shape.rotation:
                budget.truncated = True
        slides.append(result)
    return {"kind": "presentation", "width": max(1, budget.pixels(presentation.slide_width, dimension=True)),
            "height": max(1, budget.pixels(presentation.slide_height, dimension=True)),
            "total_slides": len(presentation.slides),
            "slides": slides, "truncated": budget.truncated}


def _check_archive(handle):
    with zipfile.ZipFile(handle) as archive:
        entries = archive.infolist()
        if len(entries) > 5000 or sum(entry.file_size for entry in entries) > 100 * 1024 * 1024:
            raise ValueError("文档解压后过大，无法预览")
        if any(
            entry.file_size > 1024 * 1024 and entry.file_size > max(entry.compress_size, 1) * 250
            for entry in entries
        ):
            raise ValueError("文档压缩比例异常，无法预览")
    handle.seek(0)


_FORMAT_LITERAL = r'(?:"[^"\r\n]*"|\\[^\r\n])'
_NUMBER_FORMAT = re.compile(
    rf'(?P<prefix>{_FORMAT_LITERAL}*)(?P<integer>0{{1,16}}|#,##0)'
    rf'(?:\.(?P<decimals>0{{1,12}}))?(?P<percent>%)?(?P<suffix>{_FORMAT_LITERAL}*)'
)


def _display_number(value, number_format):
    """Return optional display text and an honest fallback flag; never evaluate formulas.

    Only one fixed-decimal numeric section is supported. Sections, conditions,
    colors, locales, dates, fractions, scientific notation and scaling fall back.
    Format size, precision, literals and generated output are separately bounded.
    """
    if value is None or isinstance(value, (bool, str)):
        return None, False
    number_format = number_format or "General"
    if number_format in {"General", "@"}:
        return None, False
    if not isinstance(value, (int, float)) or len(number_format) > 128:
        return None, True
    if isinstance(value, float) and not math.isfinite(value):
        return None, False
    match = _NUMBER_FORMAT.fullmatch(number_format)
    if match is None:
        return None, True

    def literal(part):
        return "".join(token[1:-1] if token.startswith('"') else token[1:]
                       for token in re.findall(_FORMAT_LITERAL, part))

    prefix, suffix = literal(match["prefix"]), literal(match["suffix"])
    if len(prefix) + len(suffix) > 32:
        return None, True
    precision = len(match["decimals"] or "")
    try:
        with localcontext() as context:
            context.prec = 128
            decimal = Decimal(str(value))
            if decimal.adjusted() > 100:
                return None, True
            if match["percent"]:
                decimal *= 100
            rounded = decimal.quantize(Decimal(1).scaleb(-precision), rounding=ROUND_HALF_UP)
            sign = "-" if rounded < 0 else ""
            grouped = "," if match["integer"] == "#,##0" else ""
            digits = format(abs(rounded), f"{grouped}.{precision}f")
            if not grouped:
                whole, dot, fraction = digits.partition(".")
                digits = whole.zfill(len(match["integer"])) + dot + fraction
            display = sign + prefix + digits + ("%" if match["percent"] else "") + suffix
    except (InvalidOperation, ValueError, OverflowError):
        return None, True
    return (display, False) if len(display) <= 160 else (None, True)


def parse_document(handle, suffix: str) -> dict:
    if suffix in {".docx", ".pptx"}:
        _check_archive(handle)
        return _docx_preview(handle) if suffix == ".docx" else _pptx_preview(handle)
    budget = MAX_TEXT
    cells_used = 0
    truncated = False

    def cell(value):
        nonlocal budget, truncated, cells_used
        cells_used += 1
        if value is None or isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value if not isinstance(value, float) or math.isfinite(value) else None
        if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
            value = value.isoformat()
        value = str(value)
        limit = min(4096, max(0, budget))
        clipped = value[:limit]
        truncated |= len(clipped) < len(value)
        budget -= len(clipped)
        return clipped

    sheets = []
    if suffix in {".xlsx", ".xlsm"}:
        _check_archive(handle)
        from openpyxl import load_workbook

        book = load_workbook(handle, read_only=True, data_only=True, keep_links=False)
        try:
            truncated |= len(book.worksheets) > MAX_SHEETS
            for sheet in book.worksheets[:MAX_SHEETS]:
                row_count, column_count = sheet.max_row or 0, sheet.max_column or 0
                # Streaming writers can omit (or understate) the dimension tag.
                # Iterate real XML rows, bounded by row/cell/text/worker limits.
                sheet.reset_dimensions()
                rows, display_rows, observed_rows = [], [], 0
                limited = False
                format_fallback = False
                for row in sheet.iter_rows():
                    observed_rows += 1
                    column_count = max(column_count, len(row))
                    width = min(len(row), MAX_COLUMNS)
                    if len(rows) >= MAX_ROWS or cells_used + width > MAX_CELLS or budget <= 0:
                        limited = True
                        break
                    values, displays = [], []
                    for source in row[:MAX_COLUMNS]:
                        values.append(cell(source.value))
                        display, fallback = _display_number(source.value, source.number_format)
                        if display is not None:
                            if len(display) <= budget:
                                budget -= len(display)
                            else:
                                # Never show a partially clipped number or unit.
                                display, fallback, limited = None, True, True
                        displays.append(display)
                        format_fallback |= fallback
                    rows.append(values)
                    display_rows.append(displays)
                    limited |= len(row) > MAX_COLUMNS
                known_total = bool(row_count) or observed_rows == len(rows)
                row_count = max(row_count, observed_rows)
                limited |= row_count > len(rows) or column_count > MAX_COLUMNS or budget <= 0
                sheets.append(
                    {
                        "name": sheet.title,
                        "rows": rows,
                        "display_rows": display_rows,
                        "number_format_fallback": format_fallback,
                        "total_rows": row_count,
                        "total_rows_known": known_total,
                        "total_columns": column_count,
                        "truncated": limited,
                    }
                )
                truncated |= limited
        finally:
            book.close()
    elif suffix == ".xls":
        import xlrd

        book = xlrd.open_workbook(file_contents=handle.read(25 * 1024 * 1024 + 1), on_demand=True)
        try:
            truncated |= book.nsheets > MAX_SHEETS
            for index in range(min(book.nsheets, MAX_SHEETS)):
                sheet = book.sheet_by_index(index)
                rows = []
                visible_columns = min(sheet.ncols, MAX_COLUMNS)
                visible_rows = min(sheet.nrows, MAX_ROWS, (MAX_CELLS - cells_used) // max(visible_columns, 1))
                for r in range(visible_rows if budget > 0 else 0):
                    row = []
                    for c in range(visible_columns):
                        value = sheet.cell(r, c)
                        actual = value.value
                        if value.ctype == xlrd.XL_CELL_DATE:
                            actual = xlrd.xldate_as_datetime(actual, book.datemode)
                        elif value.ctype == xlrd.XL_CELL_BOOLEAN:
                            actual = bool(actual)
                        row.append(cell(actual))
                    rows.append(row)
                limited = sheet.nrows > visible_rows or sheet.ncols > visible_columns or budget <= 0
                sheets.append(
                    {
                        "name": sheet.name,
                        "rows": rows,
                        "total_rows": sheet.nrows,
                        "total_columns": sheet.ncols,
                        "truncated": limited,
                    }
                )
                truncated |= limited
        finally:
            book.release_resources()
    else:
        raise ValueError("此文件格式不支持文档预览")
    return {"kind": "spreadsheet", "sheets": sheets, "truncated": truncated}


async def preview_document(descriptor: int, name: str) -> dict:
    from fastapi import HTTPException

    suffix = Path(name).suffix.lower()
    if suffix not in {".xlsx", ".xlsm", ".xls", ".docx", ".pptx"}:
        raise HTTPException(415, "此文件格式请使用浏览器预览或下载")
    if os.fstat(descriptor).st_size > 25 * 1024 * 1024:
        raise HTTPException(413, "文件超过 25 MB 预览上限，请下载查看")
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).resolve()),
        suffix,
        str(descriptor),
        pass_fds=(descriptor,),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env={"PATH": os.defpath, "LANG": "C.UTF-8", "OPENBLAS_NUM_THREADS": "1"},
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 15)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
        await process.wait()
        if asyncio.current_task().cancelling():
            raise
        raise HTTPException(422, "文件过于复杂，预览超时；请下载查看")
    if process.returncode or not output:
        raise HTTPException(422, "文件损坏、加密或超出预览资源限制，请下载查看")
    result = json.loads(output)
    if "error" in result:
        raise HTTPException(422, result["error"])
    return result


if __name__ == "__main__":
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    try:
        with os.fdopen(int(sys.argv[2]), "rb") as file:
            result = parse_document(file, sys.argv[1])
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except Exception:  # noqa: BLE001 - worker boundary redacts untrusted parser errors.
        print(json.dumps({"error": "文件损坏、加密或超出预览资源限制，请下载查看"}))
