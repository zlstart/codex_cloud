import { safeError } from "./acceptance-safe-error.mjs";
// Real file browser acceptance; no API or model responses are mocked.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const root = "../test-results/production-acceptance-2026-11-03/fullscreen";
await mkdir(root, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
let results = [];
try {
  results =
    JSON.parse(await readFile(`${root}/report.json`, "utf8")).checks || [];
} catch {
  /* First pass. */
}
let failure;
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      baseURL: "http://127.0.0.1:8000",
      storageState: "/tmp/famsun-acceptance-admin.json",
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
    });
    // Explicitly exercise the unsupported-API fallback used by some mobile browsers.
    if (mobile)
      await context.addInitScript(() =>
        Object.defineProperty(Element.prototype, "requestFullscreen", {
          value: undefined,
          configurable: true,
        }),
      );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(safeError(error)));
    const allFiles = await (await context.request.get("/api/files")).json();
    const formats = new Set();
    const files = allFiles
      .sort((a, b) => Number(b.kind === "output") - Number(a.kind === "output"))
      .filter((file) => {
        const ext = file.name.split(".").pop().toLowerCase();
        if (
          !["html", "xlsx", "docx", "pdf", "pptx", "csv"].includes(ext) ||
          formats.has(ext)
        )
          return false;
        formats.add(ext);
        return true;
      });
    await page.goto("/");
    if (mobile)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "文件空间", exact: true }).click();
    for (const file of files) {
      await page
        .getByRole("button", { name: file.name, exact: true })
        .first()
        .click();
      const dialog = page.getByRole("dialog", { name: file.name });
      await dialog.locator('.preview-body[aria-busy="false"]').waitFor();
      if (file.name.toLowerCase().endsWith(".pdf"))
        await page.waitForFunction(() => {
          const canvas = document.querySelector(".pdf-preview canvas");
          return canvas?.width > 0 && !document.querySelector(".pdf-busy");
        });
      const frameBefore = (await dialog.locator("iframe").count())
        ? await dialog.locator("iframe").elementHandle()
        : null;
      await dialog
        .getByRole("button", { name: "全屏预览", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.querySelector(".modal-fullscreen"),
      );
      if (!mobile)
        await page.waitForFunction(() => document.fullscreenElement !== null);
      const box = await dialog.boundingBox(),
        size = page.viewportSize();
      assert.ok(
        Math.abs(box.width - size.width) < 2 &&
          Math.abs(box.height - size.height) < 2,
      );
      if (frameBefore)
        assert.ok(
          await dialog
            .locator("iframe")
            .evaluate((node, previous) => node === previous, frameBefore),
          "Fullscreen preserves the running iframe",
        );
      const evidence = `${mobile ? "mobile-fallback" : "desktop-native"}-${file.id}.png`;
      await page.screenshot({
        path: `${root}/${evidence}`,
        animations: "disabled",
      });
      await dialog
        .getByRole("button", { name: "退出全屏", exact: true })
        .focus();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector(".modal-fullscreen"),
      );
      assert.equal(
        await dialog.count(),
        1,
        "First Escape exits fullscreen and keeps preview open",
      );
      await dialog
        .getByRole("button", { name: "全屏预览", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "退出全屏", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(
        await page.evaluate(() => document.fullscreenElement === null),
        true,
      );
      const mode = mobile
        ? "mobile viewport fallback"
        : "desktop native fullscreen";
      results = results.filter(
        (result) => result.file_id !== file.id || result.mode !== mode,
      );
      results.push({
        file: file.name,
        file_id: file.id,
        mode,
        status: "pass",
        screenshot: evidence,
        escape_preserves_preview: true,
        iframe_preserved: !!frameBefore,
      });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} catch (error) {
  failure = safeError(error);
  throw new Error(safeError(error));
} finally {
  await writeFile(
    `${root}/report.json`,
    JSON.stringify(
      {
        status: failure ? "fail" : "pass",
        failure,
        checks: results,
        live_files: true,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
console.log(
  `PASS: ${results.length} real-file fullscreen/restore/Escape checks`,
);
