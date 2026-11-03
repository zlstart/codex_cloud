import type { Artifact } from "../../types";

export type PreviewKind =
  | "spreadsheet"
  | "document"
  | "presentation"
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
  display_rows?: (string | null)[][];
  number_format_fallback?: boolean;
  total_rows: number;
  total_rows_known?: boolean;
  total_columns: number;
  truncated: boolean;
}
export type DocumentBlock =
  | { type: "paragraph"; text: string; heading?: number }
  | { type: "table"; rows: string[][] }
  | {
      type: "image";
      src: string;
      alt?: string;
      width?: number;
      height?: number;
    };
export interface SlideParagraph {
  text: string;
  font_size?: number;
  font_family?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right" | "justify";
  space_before?: number;
  space_after?: number;
  line_spacing?: { kind: "multiple" | "pixels"; value: number };
}
export interface SlideTextFrame {
  margins: { top: number; right: number; bottom: number; left: number };
  vertical_align: "top" | "middle" | "bottom";
  word_wrap?: boolean;
  auto_size?: "shape_to_fit_text";
}
export interface SlideTableCell {
  paragraphs: SlideParagraph[];
  text_frame?: SlideTextFrame;
  fill?: string;
}
interface SlideGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type SlideElement = SlideGeometry &
  (
    | {
        type: "text";
        paragraphs: SlideParagraph[];
        text_frame?: SlideTextFrame;
        fill?: string;
        stroke?: string;
        shape?: "rect" | "ellipse" | "roundRect";
      }
    | {
        type: "shape";
        fill?: string;
        stroke?: string;
        shape?: "rect" | "ellipse" | "roundRect";
      }
    | {
        type: "table";
        rows: string[][];
        column_widths?: number[];
        row_heights?: number[];
        cells?: SlideTableCell[][];
      }
    | { type: "image"; src: string; alt?: string }
  );
export interface PreviewSlide {
  title: string;
  background?: string;
  elements: SlideElement[];
}
export type ParsedPreview =
  | { kind: "spreadsheet"; sheets: PreviewSheet[]; truncated: boolean }
  | {
      kind: "document";
      paragraphs: string[];
      blocks?: DocumentBlock[];
      truncated: boolean;
    }
  | {
      kind: "presentation";
      width: number;
      height: number;
      total_slides: number;
      slides: PreviewSlide[];
      truncated: boolean;
    };

export function previewKind(file: Artifact): PreviewKind {
  const name = file.name.toLowerCase();
  const mime = file.mime_type.split(";")[0].trim().toLowerCase();
  if (/\.(xlsx|xls|xlsm)$/.test(name)) return "spreadsheet";
  if (/\.docx$/.test(name)) return "document";
  if (/\.pptx$/.test(name)) return "presentation";
  if (
    /\.(md|markdown|mdown)$/.test(name) ||
    /^(text\/)(x-)?markdown$/.test(mime)
  )
    return "markdown";
  if (
    /\.(html?|xhtml)$/.test(name) ||
    ["text/html", "application/xhtml+xml"].includes(mime)
  )
    return "html";
  if (
    /\.(csv|tsv)$/.test(name) ||
    ["text/csv", "text/tab-separated-values"].includes(mime)
  )
    return "csv";
  if (/\.pdf$/.test(name) || mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (
    mime.startsWith("text/") ||
    /(?:\/|\+)(?:json|xml)$/.test(mime) ||
    [
      "application/javascript",
      "application/x-javascript",
      "application/typescript",
      "application/x-yaml",
      "application/yaml",
      "application/toml",
      "application/x-sh",
      "application/sql",
      "application/x-ndjson",
    ].includes(mime) ||
    /\.(txt|text|json|jsonl|ndjson|py|pyi|js|mjs|cjs|ts|mts|cts|tsx|jsx|vue|svelte|yaml|yml|xml|sql|sh|bash|zsh|fish|ps1|bat|cmd|log|css|scss|sass|less|toml|ini|conf|cfg|properties|r|go|rs|java|kt|kts|scala|swift|c|cc|cpp|cxx|h|hpp|cs|rb|php|pl|lua|ex|exs|erl|hrl|hs|clj|cljs|dart|diff|patch|graphql|gql|proto|ipynb)$/.test(
      name,
    ) ||
    /(?:^|\/)(?:dockerfile(?:\.[^/]+)?|makefile|cmakelists\.txt|\.(?:env(?:\.[^/]+)?|gitignore|dockerignore|editorconfig|npmrc|nvmrc))$/.test(
      name,
    )
  )
    return "text";
  return "unsupported";
}

export const kindLabel: Record<PreviewKind, string> = {
  spreadsheet: "电子表格",
  document: "文档",
  presentation: "演示文稿",
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

export function previewLanguage(file: Artifact): string | undefined {
  const mime = file.mime_type.split(";")[0].trim().toLowerCase();
  if (/(?:\/|\+)json$/.test(mime)) return "json";
  if (mime === "application/x-ndjson") return "json";
  if (/(?:\/|\+)xml$/.test(mime)) return "xml";
  if (/javascript$/.test(mime)) return "javascript";
  if (/typescript$/.test(mime)) return "typescript";
  if (/(?:x-)?yaml$/.test(mime)) return "yaml";
  if (/toml$/.test(mime)) return "toml";
  if (/\/(?:x-)?(?:sh|shellscript)$/.test(mime)) return "bash";
  if (/\/sql$/.test(mime)) return "sql";
  return undefined;
}

export async function decodePreviewText(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : /charset=["']?([^;"'\s]+)/i.exec(blob.type)?.[1] || "utf-8";
  let content: string;
  try {
    content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error("无法识别此文件的文本编码，请下载后使用编辑器打开。");
  }
  const controls =
    content.match(/[\u0001-\u0008\u000e-\u001a\u001c-\u001f]/g)?.length || 0;
  if (content.includes("\0") || controls > Math.max(2, content.length * 0.02))
    throw new Error("此文件包含二进制内容，请下载后使用对应应用打开。");
  return content.replace(/^\uFEFF/, "");
}

// Keep both the download and the DOM bounded. Quoted newlines and escaped quotes
// are parsed as data, and excess columns are counted without storing their cells.
export function parseDelimited(content: string, delimiter = ","): PreviewSheet {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let rowStarted = false;
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
    rowStarted = false;
  };
  const text = content.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if ((char !== "\r" && char !== "\n") || quoted) rowStarted = true;
    if (char === '"' && (quoted || field.length === 0)) {
      if (quoted && text[i + 1] === '"') {
        if (field.length < 4000) field += '"';
        else truncated = true;
        i++;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) pushField();
    else if ((char === "\r" || char === "\n") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else if (field.length < 4000) field += char;
    else truncated = true;
  }
  if (rowStarted || field || row.length || columnCount) pushRow();
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
