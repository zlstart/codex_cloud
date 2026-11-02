"""Bounded, read-only Office previews; parser runs outside the API process.

The worker receives one already-authorized file descriptor and no application
credentials. It never evaluates spreadsheet formulas, macros, or document links.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import math
import os
import sys
import zipfile
from pathlib import Path

MAX_ROWS, MAX_COLUMNS, MAX_SHEETS = 1000, 50, 20
MAX_TEXT = 2_000_000
MAX_CELLS = 50_000


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


def parse_document(handle, suffix: str) -> dict:
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
                rows, observed_rows = [], 0
                limited = False
                for row in sheet.iter_rows(values_only=True):
                    observed_rows += 1
                    column_count = max(column_count, len(row))
                    width = min(len(row), MAX_COLUMNS)
                    if len(rows) >= MAX_ROWS or cells_used + width > MAX_CELLS or budget <= 0:
                        limited = True
                        break
                    rows.append([cell(value) for value in row[:MAX_COLUMNS]])
                    limited |= len(row) > MAX_COLUMNS
                known_total = bool(row_count) or observed_rows == len(rows)
                row_count = max(row_count, observed_rows)
                limited |= row_count > len(rows) or column_count > MAX_COLUMNS or budget <= 0
                sheets.append(
                    {
                        "name": sheet.title,
                        "rows": rows,
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
    elif suffix == ".docx":
        _check_archive(handle)
        from docx import Document

        document = Document(handle)
        paragraphs = []
        from docx.table import Table

        for block in document.iter_inner_content():
            if len(paragraphs) >= 2000 or budget <= 0:
                truncated = True
                break
            if isinstance(block, Table):
                for row in block.rows[:MAX_ROWS]:
                    if len(paragraphs) >= 2000 or budget <= 0:
                        truncated = True
                        break
                    paragraphs.append(cell(" | ".join(item.text for item in row.cells[:MAX_COLUMNS])))
            else:
                paragraphs.append(cell(block.text))
        return {"kind": "document", "paragraphs": paragraphs, "truncated": truncated}
    else:
        raise ValueError("此文件格式不支持文档预览")
    return {"kind": "spreadsheet", "sheets": sheets, "truncated": truncated}


async def preview_document(descriptor: int, name: str) -> dict:
    from fastapi import HTTPException

    suffix = Path(name).suffix.lower()
    if suffix not in {".xlsx", ".xlsm", ".xls", ".docx"}:
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
