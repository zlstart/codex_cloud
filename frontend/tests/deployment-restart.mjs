// Run after restarting the API, following deployment.mjs. No model requests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
assert.equal(process.env.FAMSUN_DISPOSABLE_DEPLOYMENT, "1");
const output = process.env.FAMSUN_TEST_OUTPUT || "../test-results/deployment";
const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8000";
const { sid, file, skillId } = JSON.parse(
  await readFile(`${output}/restart-target.json`, "utf8"),
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  const context = await browser.newContext({
    baseURL,
    storageState: `${output}/admin-state.json`,
    viewport: { width: 1440, height: 1000 },
  });
  assert.equal((await context.request.get("/health")).status(), 200);
  assert.equal((await context.request.get("/api/auth/me")).status(), 200);
  const detail = await (
    await context.request.get(`/api/sessions/${sid}`)
  ).json();
  assert.equal(detail.session.pinned, true);
  assert.ok(detail.files.some((f) => f.id === file.id));
  assert.match(await (await context.request.get(file.url)).text(), /A,240/);
  assert.equal(
    (
      await (
        await context.request.get(`/api/extensions/skills/${skillId}`)
      ).json()
    ).enabled,
    false,
  );
  const page = await context.newPage();
  await page.goto(baseURL);
  await page
    .getByRole("button", { name: /部署验收会话/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: "预览 生产验收.csv", exact: true })
    .click();
  await page.getByRole("dialog").getByText("240", { exact: true }).waitFor();
  await page.screenshot({
    animations: "disabled",
    path: `${output}/restart-preview.png`,
  });
  console.log(
    "PASS: process restart preserves login cookie, pinned session, file bytes, skill preference and browser preview",
  );
} finally {
  await browser.close();
}
