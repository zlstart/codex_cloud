// Inspect actual live-generated report images in the product, including narrow screens.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { safeError } from "./acceptance-safe-error.mjs";

const output = "../test-results/production-acceptance-2026-11-03/analysis";
await mkdir(`${output}/screenshots`, { recursive: true });
const report = { started_at: new Date().toISOString(), live_files: true, checks: [], errors: [] };
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      baseURL: "http://127.0.0.1:8000", storageState: "/tmp/famsun-acceptance-admin.json",
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(safeError(error)));
    const response = await context.request.get("/api/files");
    assert.equal(response.status(), 200);
    const files = (await response.json()).filter(file => file.kind === "output" && file.name.startsWith("2026年10月") && /\.(html|docx)$/.test(file.name));
    assert.equal(files.length, 2);
    await page.goto("/");
    if (mobile) await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "文件空间", exact: true }).click();
    for (const file of files) {
      await page.getByRole("button", { name: file.name, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: file.name });
      await dialog.locator('.preview-body[aria-busy="false"]').waitFor();
      const html = file.name.endsWith(".html");
      const frame = html ? await (await dialog.locator("iframe").elementHandle()).contentFrame() : null;
      const images = html ? frame.locator("img") : dialog.locator(".document-page img");
      assert.equal(await images.count(), 4);
      for (const [index, image] of (await images.all()).entries()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(node => node.decode());
        const dimensions = await image.evaluate(node => ({
          natural_width: node.naturalWidth, natural_height: node.naturalHeight,
          shown_width: node.getBoundingClientRect().width, shown_height: node.getBoundingClientRect().height,
          viewport_width: window.innerWidth,
        }));
        assert.ok(dimensions.natural_width > 0 && dimensions.shown_width > 0 && dimensions.shown_height > 0);
        assert.ok(dimensions.shown_width <= dimensions.viewport_width + 2, "Chart fits its preview viewport");
        const screenshot = `final-layout-${mobile ? "mobile" : "desktop"}-${html ? "html" : "docx"}-chart-${index + 1}.png`;
        await page.screenshot({ path: `${output}/screenshots/${screenshot}`, animations: "disabled" });
        report.checks.push({ file_id: file.id, file: file.name, mode: mobile ? "mobile" : "desktop", chart: index + 1, status: "pass", dimensions, screenshot });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
      await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    }
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  report.status = "pass";
} catch (error) {
  report.status = "fail";
  report.failure = safeError(error);
  throw new Error(safeError(error));
} finally {
  report.finished_at = new Date().toISOString();
  await writeFile(`${output}/artifact-layout.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`PASS ${report.checks.length} actual HTML/DOCX chart renderings on desktop/mobile`);
