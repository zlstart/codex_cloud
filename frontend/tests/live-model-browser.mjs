// Read-only browser verification of artifacts from tests/live_model_smoke.py.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const output = "../test-results/deployment";
const data = JSON.parse(
  await readFile(`${output}/live-model-results.json`, "utf8"),
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  const context = await browser.newContext({
    baseURL: process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8080",
    storageState: `${output}/admin-state.json`,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: /真实模型端到端验收/ }).click();
  await page
    .getByRole("button", { name: "预览 production.png", exact: true })
    .first()
    .click();
  const img = page.getByRole("dialog").locator("img");
  await img.waitFor();
  await img.evaluate((el) => el.decode());
  assert.equal(
    await img.evaluate((el) => el.naturalWidth),
    data.png_dimensions[0],
  );
  await page.screenshot({
    path: `${output}/live-model-chart.png`,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: /真实模型端到端验收/ }).click();
  await page
    .getByRole("button", { name: "预览 production.png", exact: true })
    .first()
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real model conversation and authenticated PNG preview survive reload, no browser errors",
  );
} finally {
  await browser.close();
}
