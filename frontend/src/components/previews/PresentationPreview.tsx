import { useState } from "react";
import { ChevronLeft, ChevronRight, Presentation } from "lucide-react";
import type {
  ParsedPreview,
  SlideElement,
  SlideParagraph,
  SlideTextFrame,
} from "./previewData";

function framePadding(frame?: SlideTextFrame) {
  if (!frame) return undefined;
  const { top, right, bottom, left } = frame.margins;
  return `${top}px ${right}px ${bottom}px ${left}px`;
}

function SlideParagraphs({
  paragraphs,
  frame,
  defaultSize = 24,
}: {
  paragraphs: SlideParagraph[];
  frame?: SlideTextFrame;
  defaultSize?: number;
}) {
  return (
    <div className="slide-paragraphs">
      {paragraphs.map((paragraph, index) => (
        <p
          key={index}
          style={{
            fontSize: paragraph.font_size ?? defaultSize,
            fontFamily: paragraph.font_family
              ? `"${paragraph.font_family.replace(/["\\]/g, "\\$&")}", Arial, "Microsoft YaHei", sans-serif`
              : undefined,
            color: paragraph.color,
            fontWeight:
              paragraph.bold === undefined
                ? undefined
                : paragraph.bold
                  ? 700
                  : 400,
            fontStyle:
              paragraph.italic === undefined
                ? undefined
                : paragraph.italic
                  ? "italic"
                  : "normal",
            textAlign: paragraph.align ?? "left",
            marginTop: paragraph.space_before ?? 0,
            marginBottom: paragraph.space_after ?? 0,
            lineHeight: paragraph.line_spacing
              ? paragraph.line_spacing.kind === "pixels"
                ? `${paragraph.line_spacing.value}px`
                : paragraph.line_spacing.value
              : "normal",
            whiteSpace: frame?.word_wrap === false ? "pre" : "pre-wrap",
          }}
        >
          {paragraph.text || "\u00a0"}
        </p>
      ))}
    </div>
  );
}

function ShapeBackground({
  element,
}: {
  element: Extract<SlideElement, { type: "shape" | "text" }>;
}) {
  const { x, y, width, height, fill, stroke, shape } = element;
  if (shape === "ellipse")
    return (
      <ellipse
        cx={x + width / 2}
        cy={y + height / 2}
        rx={width / 2}
        ry={height / 2}
        fill={fill || "none"}
        stroke={stroke || "none"}
      />
    );
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      rx={shape === "roundRect" ? Math.min(width, height) * 0.15 : undefined}
      fill={fill || "none"}
      stroke={stroke || "none"}
    />
  );
}

function SlideShape({ element }: { element: SlideElement }) {
  const { x, y, width, height } = element;
  if (element.type === "image")
    return (
      <image
        x={x}
        y={y}
        width={width}
        height={height}
        href={element.src}
        preserveAspectRatio="xMidYMid meet"
      >
        <title>{element.alt || "幻灯片内嵌图片"}</title>
      </image>
    );
  if (element.type === "shape") return <ShapeBackground element={element} />;
  if (element.type === "table")
    return (
      <foreignObject x={x} y={y} width={width} height={height}>
        <div className="slide-table-container">
          <table
            className={`slide-table${element.cells ? " slide-table-formatted" : ""}`}
          >
            {element.column_widths && (
              <colgroup>
                {element.column_widths.map((columnWidth, index) => (
                  <col key={index} style={{ width: columnWidth }} />
                ))}
              </colgroup>
            )}
            <tbody>
              {element.rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  style={{ height: element.row_heights?.[rowIndex] }}
                >
                  {row.map((cell, column) => {
                    const format = element.cells?.[rowIndex]?.[column];
                    return (
                      <td
                        key={column}
                        style={{
                          padding: framePadding(format?.text_frame),
                          verticalAlign: format?.text_frame?.vertical_align,
                          backgroundColor: format?.fill,
                        }}
                      >
                        {format ? (
                          <SlideParagraphs
                            paragraphs={format.paragraphs}
                            frame={format.text_frame}
                            defaultSize={16}
                          />
                        ) : (
                          cell
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </foreignObject>
    );
  return (
    <g>
      {(element.fill || element.stroke) && (
        <ShapeBackground element={element} />
      )}
      <foreignObject
        x={x}
        y={y}
        width={width}
        height={height}
        style={{
          overflow:
            element.text_frame?.auto_size === "shape_to_fit_text"
              ? "visible"
              : undefined,
        }}
      >
        <div
          className="slide-text"
          data-auto-size={element.text_frame?.auto_size}
          style={{
            padding: framePadding(element.text_frame),
            justifyContent:
              element.text_frame?.vertical_align === "middle"
                ? "center"
                : element.text_frame?.vertical_align === "bottom"
                  ? "flex-end"
                  : "flex-start",
          }}
        >
          <SlideParagraphs
            paragraphs={element.paragraphs}
            frame={element.text_frame}
          />
        </div>
      </foreignObject>
    </g>
  );
}

export function PresentationPreview({
  presentation,
}: {
  presentation: Extract<ParsedPreview, { kind: "presentation" }>;
}) {
  const [page, setPage] = useState(0);
  const slide = presentation.slides[page];
  if (!slide)
    return (
      <div className="preview-empty">
        <Presentation size={30} />
        <p>此演示文稿没有可预览的幻灯片。</p>
      </div>
    );
  return (
    <div className="presentation-preview">
      <div className="presentation-toolbar">
        <div>
          <button
            className="icon-button"
            aria-label="上一张幻灯片"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span aria-live="polite">
            {page + 1} / {presentation.total_slides} 页
          </span>
          <button
            className="icon-button"
            aria-label="下一张幻灯片"
            disabled={page + 1 >= presentation.slides.length}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <span title={slide.title}>{slide.title}</span>
      </div>
      <div className="preview-notice" role="note">
        预览保留文字、表格、图片及其位置；主题、动画与复杂图形请下载查看。
        {presentation.truncated && "部分内容超出预览范围，已省略。"}
      </div>
      <div className="presentation-scroll" tabIndex={0} aria-label="幻灯片预览">
        <svg
          className="presentation-slide"
          viewBox={`0 0 ${Math.max(1, presentation.width)} ${Math.max(1, presentation.height)}`}
          role="group"
          aria-label={`第 ${page + 1} 页：${slide.title}`}
        >
          <rect
            width={presentation.width}
            height={presentation.height}
            fill={slide.background || "#ffffff"}
          />
          {slide.elements.map((element, index) => (
            <SlideShape key={index} element={element} />
          ))}
        </svg>
      </div>
    </div>
  );
}
