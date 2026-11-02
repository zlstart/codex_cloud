import type { Artifact } from "../../types";

export type PreviewKind =
  | "spreadsheet"
  | "document"
  | "markdown"
  | "html"
  | "csv"
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "text"
  | "unsupported";
export type Cell = string | number | boolean | null;
export interface PreviewSheet {
  name: string;
  rows: Cell[][];
  total_rows: number;
  total_rows_known?: boolean;
  total_columns: number;
  truncated: boolean;
}
export type ParsedPreview =
  | { kind: "spreadsheet"; sheets: PreviewSheet[]; truncated: boolean }
  | { kind: "document"; paragraphs: string[]; truncated: boolean };

export function previewKind(file: Artifact): PreviewKind {
  const name = file.name.toLowerCase();
  if (/\.(xlsx|xls|xlsm)$/.test(name)) return "spreadsheet";
  if (/\.docx$/.test(name)) return "document";
  if (/\.(md|markdown|mdown)$/.test(name)) return "markdown";
  if (/\.html?$/.test(name)) return "html";
  if (/\.(csv|tsv)$/.test(name)) return "csv";
  if (/\.pdf$/.test(name) || file.mime_type === "application/pdf") return "pdf";
  if (file.mime_type.startsWith("image/")) return "image";
  if (file.mime_type.startsWith("audio/")) return "audio";
  if (file.mime_type.startsWith("video/")) return "video";
  if (
    file.mime_type.startsWith("text/") ||
    /\.(json|jsonl|py|js|ts|tsx|jsx|yaml|yml|xml|sql|sh|log|css|toml|ini|conf|r|go|rs|java|c|cpp|h)$/.test(
      name,
    )
  )
    return "text";
  return "unsupported";
}

export const kindLabel: Record<PreviewKind, string> = {
  spreadsheet: "电子表格",
  document: "文档",
  markdown: "Markdown",
  html: "网页",
  csv: "数据表格",
  pdf: "PDF 文档",
  image: "图片",
  audio: "音频",
  video: "视频",
  text: "文本",
  unsupported: "文件",
};

// Keep both the download and the DOM bounded. Quoted newlines and escaped quotes
// are parsed as data, and excess columns are counted without storing their cells.
export function parseDelimited(content: string, delimiter = ","): PreviewSheet {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let columnCount = 0;
  let totalRows = 0;
  let totalColumns = 0;
  let truncated = false;
  const pushField = () => {
    if (columnCount < 50) row.push(field);
    columnCount++;
    field = "";
  };
  const pushRow = () => {
    pushField();
    totalRows++;
    totalColumns = Math.max(totalColumns, columnCount);
    if (rows.length < 1000) rows.push(row);
    if (columnCount > 50 || totalRows > 1000) truncated = true;
    row = [];
    columnCount = 0;
  };
  const text = content.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        if (field.length < 4000) field += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) pushField();
    else if ((char === "\r" || char === "\n") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else if (field.length < 4000) field += char;
    else truncated = true;
  }
  if (field || row.length || columnCount) pushRow();
  return {
    name: "数据",
    rows,
    total_rows: totalRows,
    total_columns: totalColumns,
    truncated,
  };
}

export async function boundedBlob(
  response: Response,
  maxBytes: number,
): Promise<Blob> {
  if (Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("文件较大，请下载后查看完整内容。");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("浏览器无法读取此文件，请下载后查看。");
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("文件较大，请下载后查看完整内容。");
      }
      parts.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(parts, {
    type: response.headers.get("content-type") || "application/octet-stream",
  });
}
