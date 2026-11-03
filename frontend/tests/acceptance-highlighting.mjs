import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { safeError } from "./acceptance-safe-error.mjs";

const output = "../test-results/production-acceptance-2026-11-03/analysis";
const report = { live_files: true, checks: [], started_at: new Date().toISOString() };
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:8000", storageState: "/tmp/famsun-acceptance-admin.json",
    viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "文件空间", exact: true }).click();
  await page.getByRole("button", { name: "snake.html", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "snake.html" });
  await dialog.locator('.preview-body[aria-busy="false"]').waitFor();
  await dialog.getByRole("button", { name: "源文件", exact: true }).click();
  const code = dialog.locator("code.hljs");
  assert.ok(await code.locator('span[class*="hljs-"]').count() > 20);
  const source = await code.textContent();
  await dialog.getByRole("button", { name: "复制代码", exact: true }).click();
  await dialog.getByText("已复制", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);
  await page.screenshot({ path: `${output}/screenshots/live-html-source-highlighting.png`, animations: "disabled" });
  report.checks.push({ name: "Actual generated HTML source is highlighted; Copy returns exact source", status: "pass" });
  await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page.getByRole("button", { name: "2026年10月生产经营分析.xlsx", exact: true }).click();
  const workbook = page.getByRole("dialog", { name: "2026年10月生产经营分析.xlsx" });
  await workbook.locator('.preview-body[aria-busy="false"]').waitFor();
  await workbook.getByRole('tab', { name: '汇总', exact: true }).click();
  const conclusion = workbook.locator('.sheet-table tbody tr').filter({ hasText: '全部达标' }).first();
  await conclusion.scrollIntoViewIfNeeded();
  assert.match(await conclusion.innerText(), /98\.63%/);
  assert.match(await conclusion.innerText(), /26\.43/);
  assert.equal(await workbook.getByRole('cell').filter({ hasText: '=IF(AND(' }).count(), 0);
  await page.screenshot({ path: `${output}/screenshots/final-xlsx-cache-and-format.png`, animations: "disabled" });
  report.checks.push({ name: "Actual XLSX cached conclusions and percentage/decimal formatting are correct", status: "pass" });
  await workbook.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page.locator(".session-select").filter({ hasText: "生产验收·经营分析与五格式报告" }).click();
  const toggle = page.locator(".process-toggle").last();
  await toggle.waitFor();
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const tool = page.locator("details.timeline-tool").filter({ has: page.locator(".timeline-tool-name", { hasText: "exec_command" }) }).last();
  await tool.locator("summary").first().click();
  const input = tool.locator('.code-block[data-language="bash"]').first();
  await input.scrollIntoViewIfNeeded();
  assert.ok(await input.locator('span[class*="hljs-"]').count() > 0);
  const colors = await input.locator('span[class*="hljs-"]').evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).color))]);
  assert.ok(colors.length >= 2);
  await page.screenshot({ path: `${output}/screenshots/live-tool-code-highlighting.png`, animations: "disabled" });
  report.checks.push({ name: "Actual completed exec_command expands with syntax colors and its output", status: "pass", token_colors: colors.length });
  report.status = "pass";
} catch (error) {
  report.status = "fail";
  report.failure = safeError(error);
  throw new Error(safeError(error));
} finally {
  report.finished_at = new Date().toISOString();
  await writeFile(`${output}/highlighting.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log("PASS live HTML source/copy and actual tool code highlighting");
