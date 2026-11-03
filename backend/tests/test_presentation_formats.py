"""Native PPTX layout properties must survive the bounded preview parser."""
import io

from app import previews
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.util import Inches, Pt


def parse(presentation):
    stream = io.BytesIO()
    presentation.save(stream)
    stream.seek(0)
    return previews.parse_document(stream, ".pptx")


def test_table_retains_native_grid_cell_fonts_and_cell_margins():
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    table = slide.shapes.add_table(2, 3, 0, 0, Inches(10), Inches(1)).table
    for column, width in zip(table.columns, [0.8, 2.2, 7], strict=True):
        column.width = Inches(width)
    table.rows[0].height = Inches(0.3)
    table.rows[1].height = Inches(0.7)
    target = table.cell(1, 2)
    target.text = "按原始列宽显示较长的说明，不应被等宽列压成多行。"
    target.margin_top = target.margin_bottom = Pt(2)
    target.margin_left = target.margin_right = Pt(4)
    target.vertical_anchor = MSO_ANCHOR.MIDDLE
    target.fill.solid()
    target.fill.fore_color.rgb = RGBColor.from_string("F1F2F3")
    paragraph = target.text_frame.paragraphs[0]
    paragraph.alignment = PP_ALIGN.RIGHT
    run = paragraph.runs[0]
    run.font.name = "微软雅黑"
    run.font.size = Pt(11)
    run.font.bold = True
    run.font.color.rgb = RGBColor.from_string("223344")
    result = parse(presentation)
    element = result["slides"][0]["elements"][0]
    assert element["column_widths"] == [76.8, 211.2, 672]
    assert element["row_heights"] == [28.8, 67.2]
    cell = element["cells"][1][2]
    assert cell["text_frame"]["margins"] == {"top": 2.667, "right": 5.333, "bottom": 2.667, "left": 5.333}
    assert cell["text_frame"]["vertical_align"] == "middle"
    assert cell["fill"] == "#f1f2f3"
    assert cell["paragraphs"][0] == {
        "text": target.text, "font_size": 14.667, "font_family": "微软雅黑", "bold": True,
        "color": "#223344", "align": "right",
    }
    assert element["rows"][1][2] == target.text
    assert result["truncated"] is False


def test_text_frame_margins_spacing_and_inherited_paragraph_font():
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    shape = slide.shapes.add_textbox(0, 0, Inches(5), Inches(2))
    frame = shape.text_frame
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = Pt(1)
    frame.vertical_anchor = MSO_ANCHOR.BOTTOM
    frame.word_wrap = False
    frame.auto_size = MSO_AUTO_SIZE.SHAPE_TO_FIT_TEXT
    paragraph = frame.paragraphs[0]
    paragraph.text = "第一段"
    paragraph.font.size = Pt(12)
    paragraph.font.name = "Arial"
    paragraph.space_before = Pt(3)
    paragraph.space_after = Pt(6)
    paragraph.line_spacing = 1.32
    second = frame.add_paragraph()
    second.text = "固定行距"
    second.line_spacing = Pt(18)
    result = parse(presentation)["slides"][0]["elements"][0]
    assert result["text_frame"] == {
        "margins": {"top": 1.333, "right": 1.333, "bottom": 1.333, "left": 1.333},
        "vertical_align": "bottom", "word_wrap": False, "auto_size": "shape_to_fit_text",
    }
    first, second = result["paragraphs"]
    assert first["font_size"] == 16 and first["font_family"] == "Arial"
    assert first["space_before"] == 4 and first["space_after"] == 8
    assert first["line_spacing"] == {"kind": "multiple", "value": 1.32}
    assert second["line_spacing"] == {"kind": "pixels", "value": 24}


def test_presentation_format_metadata_and_paragraphs_remain_bounded(monkeypatch):
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    table = slide.shapes.add_table(1, 2, 0, 0, Inches(2), Inches(1)).table
    target = table.cell(0, 0)
    target.text = "bounded"
    target.margin_left = Inches(1000)
    paragraph = target.text_frame.paragraphs[0]
    paragraph.runs[0].font.size = Pt(1000)
    paragraph.line_spacing = 100.0
    paragraph.space_after = Pt(1000)
    table.cell(0, 1).text = "omitted"
    monkeypatch.setattr(previews, "MAX_DOCUMENT_BLOCKS", 1)
    result = parse(presentation)
    element = result["slides"][0]["elements"][0]
    cell = element["cells"][0][0]
    assert cell["text_frame"]["margins"]["left"] <= 8192
    assert cell["paragraphs"][0]["font_size"] <= 256
    assert cell["paragraphs"][0]["line_spacing"]["value"] <= 10
    assert cell["paragraphs"][0]["space_after"] <= 8192
    assert "omitted" not in str(element)
    assert result["truncated"] is True
