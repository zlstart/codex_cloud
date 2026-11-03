import { createElement } from "react";
import type { DocumentBlock, ParsedPreview } from "./previewData";

export function DocumentPreview({
  document,
}: {
  document: Extract<ParsedPreview, { kind: "document" }>;
}) {
  const blocks: DocumentBlock[] =
    document.blocks ??
    document.paragraphs.map((text) => ({ type: "paragraph" as const, text }));
  return (
    <div className="document-preview">
      <div className="preview-notice" role="note">
        已保留正文、表格与内嵌图片；页眉页脚、分页和复杂排版请下载查看。
        {document.truncated && "部分内容超出预览范围，已省略。"}
      </div>
      <article className="document-page">
        <div className="document-preview-label">文档内容</div>
        {blocks.map((block, index) => {
          if (block.type === "paragraph")
            return block.heading ? (
              createElement(
                `h${Math.max(1, Math.min(6, block.heading))}`,
                { key: index },
                block.text,
              )
            ) : (
              <p key={index}>{block.text || "\u00a0"}</p>
            );
          if (block.type === "image")
            return (
              <figure className="document-figure" key={index}>
                <img
                  src={block.src}
                  alt={block.alt || "文档内嵌图片"}
                  loading="lazy"
                  style={{
                    width: block.width ? `${block.width}px` : undefined,
                    aspectRatio:
                      block.width && block.height
                        ? `${block.width} / ${block.height}`
                        : undefined,
                  }}
                />
              </figure>
            );
          return (
            <div
              key={index}
              className="document-table-scroll"
              tabIndex={0}
              aria-label={`文档表格 ${index + 1}`}
            >
              <table className="document-table">
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, column) => (
                        <td key={column}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
        {!blocks.length && <p>文档没有可提取的正文。</p>}
      </article>
    </div>
  );
}
