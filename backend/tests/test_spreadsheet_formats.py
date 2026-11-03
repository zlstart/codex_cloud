"""Real XLSX files verify display formatting without changing their cached values."""
import datetime
import io

import pytest
from app import previews
from openpyxl import Workbook


def workbook_preview(cells):
    book = Workbook()
    sheet = book.active
    for row, (value, number_format) in enumerate(cells, 1):
        sheet.cell(row, 1, value).number_format = number_format
    stream = io.BytesIO()
    book.save(stream)
    stream.seek(0)
    return previews.parse_document(stream, ".xlsx")["sheets"][0]


@pytest.mark.parametrize(("value", "number_format", "expected"), [
    (0.9863481228668942, "0.00%", "98.63%"),
    (8664, '#,##0" 吨"', "8,664 吨"),
    (23023425, '#,##0" 元"', "23,023,425 元"),
    (96, '0" 条"', "96 条"),
    (2.675, "0.00", "2.68"),
    (-2.675, "0.00", "-2.68"),
    (-0.00001, "0.00", "0.00"),
    (1234.5, "#,##0.00", "1,234.50"),
    (0, "0.00%", "0.00%"),
    (0.25, '0.00"%"', "0.25%"),
    (0.25, r"0.00\%", "0.25%"),
    (1234.5, '"￥"#,##0.00" 元"', "￥1,234.50 元"),
    (7, "0000", "0007"),
])
def test_common_formats_preserve_raw_number_and_render_excel_rounding(value, number_format, expected):
    result = workbook_preview([(value, number_format)])
    assert result["rows"] == [[value]]
    assert result["display_rows"] == [[expected]]
    assert result["number_format_fallback"] is False


@pytest.mark.parametrize("number_format", [
    "0.00;[Red]-0.00", "+0.00;-0.00", "[>=100]0.0", "[$-409]0.00", "0.00E+00",
    "# ?/?", "0,", "0,,", "0%%", "0.0##", "0.0000000000000", '0"' + "x" * 129 + '"',
    "0_)", "0* ", '0"broken',
])
def test_unsupported_formats_are_honestly_raw(number_format):
    result = workbook_preview([(1234.567, number_format)])
    assert result["rows"] == [[1234.567]]
    assert result["display_rows"] == [[None]]
    assert result["number_format_fallback"] is True


def test_non_numeric_values_and_dates_keep_existing_values():
    day = datetime.datetime(2026, 11, 3)
    result = workbook_preview([
        ("literal <script>text</script>", "0.00%"), (True, "0.00%"),
        (None, "0.00%"), (day, "yyyy-mm-dd"), (0.986348122, "General"),
    ])
    assert result["rows"] == [["literal <script>text</script>"], [True], [None], [day.isoformat()], [0.986348122]]
    assert result["display_rows"] == [[None]] * 5
    assert result["number_format_fallback"] is True


def test_formatted_cells_share_text_budget_without_cutting_numbers(monkeypatch):
    monkeypatch.setattr(previews, "MAX_TEXT", 11)
    result = workbook_preview([("label", "General"), (2.675, "0.00"), (0.99, "0.00%")])
    assert result["rows"] == [["label"], [2.675], [0.99]]
    assert result["display_rows"] == [[None], ["2.68"], [None]]
    assert result["number_format_fallback"] is True
    assert result["truncated"] is True


def test_numeric_format_expansion_is_bounded():
    result = workbook_preview([(1e200, "0.00"), (1.234, '"' + "x" * 40 + '"0.00')])
    assert result["rows"] == [[1e200], [1.234]]
    assert result["display_rows"] == [[None], [None]]
    assert result["number_format_fallback"] is True
