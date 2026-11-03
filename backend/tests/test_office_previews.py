"""Real Office packages exercise ordered rendering, safe images, and resource bounds."""

import io
import json
import os
import zipfile

from app import previews
from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches
from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE
from pptx.util import Inches as SlideInches
from pptx.util import Pt
from test_api import register, session, upload

pytest_plugins = ["test_api"]


def png():
    stream = io.BytesIO()
    Image.new("RGB", (32, 16), "#225588").save(stream, format="PNG")
    stream.seek(0)
    return stream


def saved(document):
    stream = io.BytesIO()
    document.save(stream)
    stream.seek(0)
    return stream


def test_docx_preserves_body_order_tables_and_embedded_image():
    document = Document()
    document.add_heading("经营报告", 1)
    paragraph = document.add_paragraph()
    paragraph.add_run("图片之前")
    paragraph.add_run().add_picture(png(), width=Inches(1))
    paragraph.add_run("图片之后")
    table = document.add_table(rows=2, cols=2)
    for row, values in zip(table.rows, [["部门", "产量"], ["A", "120"]], strict=True):
        for cell, value in zip(row.cells, values, strict=True):
            cell.text = value
    document.add_paragraph("结论")
    preview = previews.parse_document(saved(document), ".docx")
    assert [block["type"] for block in preview["blocks"]] == [
        "paragraph", "paragraph", "image", "paragraph", "table", "paragraph",
    ]
    assert preview["blocks"][0] == {"type": "paragraph", "text": "经营报告", "heading": 1}
    assert preview["blocks"][1]["text"] == "图片之前"
    assert preview["blocks"][3]["text"] == "图片之后"
    assert preview["blocks"][4]["rows"] == [["部门", "产量"], ["A", "120"]]
    assert preview["blocks"][2]["src"].startswith("data:image/png;base64,")
    assert preview["blocks"][2]["width"] == 96
    assert preview["blocks"][2]["height"] == 48
    assert "结论" in preview["paragraphs"]
    assert preview["truncated"] is False


def test_docx_external_image_is_not_followed_or_exposed():
    document = Document()
    paragraph = document.add_paragraph("外部图片")
    relation = document.part.relate_to(
        "https://private.invalid/secret?token=DO_NOT_EXPOSE", RELATIONSHIP_TYPE.IMAGE, is_external=True,
    )
    drawing = OxmlElement("w:drawing")
    blip = OxmlElement("a:blip")
    blip.set(qn("r:link"), relation)
    drawing.append(blip)
    paragraph.add_run()._r.append(drawing)
    preview = previews.parse_document(saved(document), ".docx")
    assert not any(block["type"] == "image" for block in preview["blocks"])
    assert preview["truncated"] is True
    assert "DO_NOT_EXPOSE" not in json.dumps(preview)
    assert "private.invalid" not in json.dumps(preview)


def test_docx_tables_share_a_global_cell_budget_and_flag_omissions(monkeypatch):
    monkeypatch.setattr(previews, "MAX_OFFICE_CELLS", 3)
    document = Document()
    table = document.add_table(rows=2, cols=2)
    for index, cell in enumerate(cell for row in table.rows for cell in row.cells):
        cell.text = f"cell-{index}"
    preview = previews.parse_document(saved(document), ".docx")
    assert sum(len(row) for row in preview["blocks"][0]["rows"]) == 3
    assert "cell-3" not in json.dumps(preview)
    assert preview["truncated"] is True


def sample_presentation():
    presentation = Presentation()
    presentation.slide_width = SlideInches(10)
    presentation.slide_height = SlideInches(5)
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = RGBColor.from_string("112233")
    textbox = slide.shapes.add_textbox(SlideInches(1), SlideInches(0.5), SlideInches(4), SlideInches(1))
    paragraph = textbox.text_frame.paragraphs[0]
    run = paragraph.add_run()
    run.text = "真实经营分析"
    run.font.size = Pt(24)
    run.font.bold = True
    run.font.color.rgb = RGBColor.from_string("ABCDEF")
    table = slide.shapes.add_table(2, 2, SlideInches(1), SlideInches(2), SlideInches(3), SlideInches(1)).table
    for row, values in zip(table.rows, [["月份", "产量"], ["十月", "240"]], strict=True):
        for cell, value in zip(row.cells, values, strict=True):
            cell.text = value
    slide.shapes.add_picture(png(), SlideInches(6), SlideInches(1), width=SlideInches(2))
    return presentation


def test_pptx_preserves_slide_geometry_text_table_and_raster_image():
    preview = previews.parse_document(saved(sample_presentation()), ".pptx")
    assert preview["kind"] == "presentation"
    assert preview["width"] == 960 and preview["height"] == 480
    assert preview["total_slides"] == 1
    slide = preview["slides"][0]
    assert slide["background"] == "#112233"
    text, table, image = slide["elements"]
    assert [text["type"], table["type"], image["type"]] == ["text", "table", "image"]
    assert (text["x"], text["y"], text["width"], text["height"]) == (96, 48, 384, 96)
    assert text["paragraphs"][0]["text"] == "真实经营分析"
    assert text["paragraphs"][0]["font_size"] == 32
    assert text["paragraphs"][0]["color"] == "#abcdef"
    assert text["paragraphs"][0]["bold"] is True
    assert table["rows"] == [["月份", "产量"], ["十月", "240"]]
    assert image["src"].startswith("data:image/png;base64,")
    assert image["width"] == 192 and image["height"] == 96
    assert preview["truncated"] is False


def test_pptx_slide_and_shape_limits_are_visible(monkeypatch):
    monkeypatch.setattr(previews, "MAX_SLIDES", 1)
    monkeypatch.setattr(previews, "MAX_SLIDE_SHAPES", 2)
    presentation = sample_presentation()
    presentation.slides.add_slide(presentation.slide_layouts[6])
    preview = previews.parse_document(saved(presentation), ".pptx")
    assert preview["total_slides"] == 2
    assert len(preview["slides"]) == 1
    assert len(preview["slides"][0]["elements"]) == 2
    assert preview["truncated"] is True


def test_pptx_preserves_basic_shape_geometry_and_flags_unknown_presets():
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    for index, preset in enumerate([
        MSO_AUTO_SHAPE_TYPE.RECTANGLE, MSO_AUTO_SHAPE_TYPE.OVAL, MSO_AUTO_SHAPE_TYPE.ROUNDED_RECTANGLE,
        MSO_AUTO_SHAPE_TYPE.RIGHT_ARROW,
    ]):
        shape = slide.shapes.add_shape(preset, SlideInches(index), 0, SlideInches(1), SlideInches(1))
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor.from_string("123456")
        if preset == MSO_AUTO_SHAPE_TYPE.RIGHT_ARROW:
            shape.text = "Keep this label"
    preview = previews.parse_document(saved(presentation), ".pptx")
    rectangle, ellipse, rounded, arrow = preview["slides"][0]["elements"]
    assert rectangle["shape"] == "rect"
    assert ellipse["shape"] == "ellipse"
    assert rounded["shape"] == "roundRect"
    assert ellipse["fill"] == "#123456"
    assert arrow["paragraphs"][0]["text"] == "Keep this label"
    assert "fill" not in arrow and "stroke" not in arrow
    assert preview["truncated"] is True


def test_embedded_images_share_a_byte_budget(monkeypatch):
    monkeypatch.setattr(previews, "MAX_IMAGE_BYTES", 1)
    preview = previews.parse_document(saved(sample_presentation()), ".pptx")
    assert not any(element["type"] == "image" for element in preview["slides"][0]["elements"])
    assert preview["truncated"] is True


def test_embedded_images_share_a_decoded_pixel_budget(monkeypatch):
    monkeypatch.setattr(previews, "MAX_TOTAL_IMAGE_PIXELS", 700)
    presentation = sample_presentation()
    presentation.slides[0].shapes.add_picture(png(), 0, 0)
    preview = previews.parse_document(saved(presentation), ".pptx")
    images = [element for element in preview["slides"][0]["elements"] if element["type"] == "image"]
    assert len(images) == 1  # Each real fixture image is 32 * 16 = 512 decoded pixels.
    assert preview["truncated"] is True


def test_animated_images_are_omitted_from_office_previews():
    stream = io.BytesIO()
    Image.new("RGB", (32, 16), "red").save(
        stream, format="GIF", save_all=True, append_images=[Image.new("RGB", (32, 16), "blue")],
        duration=100, loop=0,
    )
    stream.seek(0)
    presentation = sample_presentation()
    presentation.slides[0].shapes.add_picture(stream, 0, 0)
    preview = previews.parse_document(saved(presentation), ".pptx")
    images = [element for element in preview["slides"][0]["elements"] if element["type"] == "image"]
    assert len(images) == 1
    assert images[0]["src"].startswith("data:image/png")
    assert preview["truncated"] is True


def test_office_rejects_non_raster_bytes_disguised_as_png():
    source = saved(sample_presentation())
    changed = io.BytesIO()
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(changed, "w") as result:
        for member in original.infolist():
            data = original.read(member)
            if member.filename.startswith("ppt/media/"):
                data = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
            result.writestr(member, data)
    changed.seek(0)
    preview = previews.parse_document(changed, ".pptx")
    assert not any(element["type"] == "image" for element in preview["slides"][0]["elements"])
    assert "<svg" not in json.dumps(preview)
    assert preview["truncated"] is True


def test_pptx_extreme_geometry_is_bounded_and_flagged():
    presentation = sample_presentation()
    presentation.slides[0].shapes[0].width = SlideInches(1000)
    presentation.slides[0].shapes[0].text_frame.paragraphs[0].runs[0].font.size = Pt(1000)
    preview = previews.parse_document(saved(presentation), ".pptx")
    text = preview["slides"][0]["elements"][0]
    assert text["width"] <= 8192
    assert text["paragraphs"][0]["font_size"] <= 256
    assert preview["truncated"] is True


def test_pptx_empty_paragraphs_consume_a_global_block_budget(monkeypatch):
    monkeypatch.setattr(previews, "MAX_DOCUMENT_BLOCKS", 2)
    presentation = sample_presentation()
    frame = presentation.slides[0].shapes[0].text_frame
    for _ in range(5):
        frame.add_paragraph()
    preview = previews.parse_document(saved(presentation), ".pptx")
    paragraphs = preview["slides"][0]["elements"][0]["paragraphs"]
    assert len(paragraphs) == 2
    assert preview["truncated"] is True


async def test_pptx_preview_runs_in_restricted_worker(tmp_path):
    path = tmp_path / "report.pptx"
    sample_presentation().save(path)
    descriptor = os.open(path, os.O_RDONLY)
    try:
        preview = await previews.preview_document(descriptor, path.name)
    finally:
        os.close(descriptor)
    assert preview["kind"] == "presentation"
    assert preview["slides"][0]["elements"][0]["paragraphs"][0]["text"] == "真实经营分析"


def test_pptx_api_previews_stay_owned_and_parser_errors_are_redacted(client):
    register(client)
    sid = session(client)
    artifact = upload(client, sid, "report.pptx", saved(sample_presentation()).getvalue())
    url = f"/api/files/{artifact['id']}/preview"
    response = client.get(url)
    assert response.status_code == 200
    assert response.json()["slides"][0]["elements"][1]["rows"][1] == ["十月", "240"]
    invalid = upload(client, sid, "broken.pptx", b"PRIVATE-UNTRUSTED-PARSER-CONTENT")
    failure = client.get(f"/api/files/{invalid['id']}/preview")
    assert failure.status_code == 422
    assert "PRIVATE" not in failure.text
    assert "Traceback" not in failure.text
    client.post("/api/auth/logout")
    assert client.get(url).status_code == 401
    register(client, "other-preview@example.com")
    assert client.get(url).status_code == 404
