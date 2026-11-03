import assert from "node:assert/strict";
import test from "node:test";
import * as preview from "../src/components/previews/previewData.ts";

const file = (name, mime_type = "application/octet-stream") => ({
  name,
  mime_type,
});

test("routes MIME-only structured text and common source filenames", () => {
  for (const [name, mime, expected] of [
    ["report", "text/markdown; charset=utf-8", "markdown"],
    ["page", "text/html", "html"],
    ["rows", "text/tab-separated-values", "csv"],
    ["response", "application/problem+json", "text"],
    ["schema", "application/xml", "text"],
    ["App.vue", "application/octet-stream", "text"],
    ["index.mjs", "application/octet-stream", "text"],
    ["Main.kt", "application/octet-stream", "text"],
    ["Dockerfile", "application/octet-stream", "text"],
    [".env.local", "application/octet-stream", "text"],
    ["report.MD", "application/octet-stream", "markdown"],
    [
      "report.PPTX",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "presentation",
    ],
    ["archive.zip", "application/zip", "unsupported"],
  ])
    assert.equal(preview.previewKind(file(name, mime)), expected, name);
});

test("decodes UTF-8 and UTF-16 BOM text without replacement characters", async () => {
  const value = "名称\t值\n中文\t42";
  assert.equal(
    await preview.decodePreviewText(new Blob(["\ufeff", value])),
    value,
  );
  assert.equal(
    await preview.decodePreviewText(
      new Blob([Buffer.from(`\ufeff${value}`, "utf16le")]),
    ),
    value,
  );
});

test("rejects binary and invalid UTF-8 masquerading as text", async () => {
  await assert.rejects(
    preview.decodePreviewText(new Blob([new Uint8Array([80, 75, 0, 0, 1, 2])])),
    /二进制/,
  );
  await assert.rejects(
    preview.decodePreviewText(new Blob([new Uint8Array([0xff, 0x80, 0x81])])),
    /编码/,
  );
});

test("preserves quoted empty CSV records and quotes within unquoted values", () => {
  assert.deepEqual(preview.parseDelimited('""').rows, [[""]]);
  assert.deepEqual(preview.parseDelimited('name,value\n5" screen,42').rows, [
    ["name", "value"],
    ['5" screen', "42"],
  ]);
  assert.deepEqual(
    preview.parseDelimited('"a,b","line 1\nline 2"\r\n"quoted ""value""",3')
      .rows,
    [
      ["a,b", "line 1\nline 2"],
      ['quoted "value"', "3"],
    ],
  );
});

test("bounds CSV rows, columns and cell lengths with a visible truncation flag", () => {
  const result = preview.parseDelimited(
    Array.from({ length: 1002 }, () =>
      Array.from({ length: 52 }, () => "x").join(","),
    ).join("\n"),
  );
  assert.equal(result.rows.length, 1000);
  assert.equal(result.rows[0].length, 50);
  assert.equal(result.total_rows, 1002);
  assert.equal(result.total_columns, 52);
  assert.equal(result.truncated, true);
  const longCell = preview.parseDelimited("x".repeat(4001));
  assert.equal(longCell.rows[0][0].length, 4000);
  assert.equal(longCell.truncated, true);
  assert.equal(
    preview.parseDelimited(`"${"x".repeat(4000)}"""`).truncated,
    true,
  );
});

test("bounded download cancels a response that exceeds the preview limit", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(preview.boundedBlob(response, 5), /文件较大/);
  assert.equal(cancelled, true);
});
