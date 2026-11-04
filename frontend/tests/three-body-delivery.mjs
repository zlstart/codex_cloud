// Read-only final delivery acceptance: real answer links, previews and UI downloads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
const root = path.resolve(
  process.env.FAMSUN_TEST_OUTPUT || "../test-results/three-body",
);
const prefix = process.env.FAMSUN_DELIVERY_PREFIX || "";
const pngName = process.env.FAMSUN_THREE_BODY_PNG || "three_body_final.png";
const stage = process.env.FAMSUN_DELIVERY_STAGE || "convergence-final";
const out = path.join(root, prefix + "final-delivery-downloads");
await mkdir(out, { recursive: true });
const run = JSON.parse(
  await readFile(path.join(root, stage, "report.json"), "utf8"),
);
const evidence = {
  source: "final assistant message links through production UI",
  checks: [],
  browser_errors: [],
  preview_rendering_is_separately_verified: true,
};
const hash = (b) => createHash("sha256").update(b).digest("hex");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const ctx = await browser.newContext({
  baseURL: process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8000",
  storageState:
    process.env.FAMSUN_TEST_STORAGE_STATE ||
    "/tmp/famsun-acceptance-admin.json",
  acceptDownloads: true,
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => evidence.browser_errors.push(e.message));
try {
  await page.goto("/");
  evidence.page_identity = { url: page.url(), title: await page.title() };
  const res = await ctx.request.get(`/api/sessions/${run.session_id}`);
  assert.equal(res.status(), 200);
  const detail = await res.json();
  await page
    .locator(".session-select")
    .filter({ hasText: detail.session.title })
    .first()
    .click();
  const answer = page
    .locator(".message-content.final-answer")
    .filter({ has: page.getByRole("button", { name: pngName, exact: true }) })
    .last();
  await answer.waitFor();
  evidence.final_visible_text = await answer.innerText();
  await answer.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(
      root,
      "screenshots",
      prefix + "10-production-final-links.png",
    ),
    fullPage: false,
  });
  for (const name of [
    "three_body.csv",
    "metrics.json",
    "three_body_final.html",
    pngName,
    "convergence_final.json",
  ]) {
    const f = detail.files.find((f) => f.name === name);
    assert.ok(f, name);
    await answer.getByRole("button", { name, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector(".preview-body")?.getAttribute("aria-busy") ===
        "false",
    );
    const check = {
      name,
      file_id: f.id,
      preview_class: await dialog
        .locator(".preview-body")
        .getAttribute("class"),
      alerts: await dialog.getByRole("alert").allTextContents(),
    };
    if (name === pngName) {
      const renderedImage = dialog.locator(".preview-body img").first();
      await renderedImage.evaluate((image) => image.decode());
      check.rendered_image = await renderedImage.evaluate((image) => ({
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        loaded: image.complete,
      }));
      await page.screenshot({
        path: path.join(root, "screenshots", prefix + "12-png-preview.png"),
        fullPage: false,
      });
    }
    const wait = page.waitForEvent("download");
    await dialog.getByRole("link", { name: "下载文件", exact: true }).click();
    const dl = await wait;
    await dl.saveAs(path.join(out, name));
    const bytes = await readFile(path.join(out, name));
    const api = await ctx.request.get(f.url);
    assert.equal(api.status(), 200);
    const actual = await api.body();
    Object.assign(check, {
      bytes: bytes.length,
      sha256: hash(bytes),
      identical_to_api: bytes.equals(actual),
      matches_metadata_size: bytes.length === f.size,
    });
    assert.ok(check.identical_to_api && check.matches_metadata_size);
    evidence.checks.push(check);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }
  evidence.passed =
    evidence.checks.length === 5 &&
    evidence.checks.every(
      (c) => c.identical_to_api && c.matches_metadata_size && !c.alerts.length,
    ) &&
    !evidence.browser_errors.length;
  console.log(
    JSON.stringify({
      passed: evidence.passed,
      files: evidence.checks.length,
      browser_errors: evidence.browser_errors,
    }),
  );
  if (!evidence.passed) process.exitCode = 1;
} catch (e) {
  evidence.error = e.message;
  process.exitCode = 1;
  console.error(e.message);
} finally {
  await writeFile(
    path.join(root, prefix + "final-delivery-verification.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await browser.close();
}
