// Live acceptance setup against a disposable local application. No mocked API.
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";

const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8000";
const output = process.env.FAMSUN_TEST_OUTPUT || "../test-results/production-acceptance-2026-11-03";
await mkdir(`${output}/screenshots`, { recursive: true });
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("/");
  const status = await (await context.request.get("/api/auth/status")).json();
  if (status.has_users) throw new Error("Use a fresh disposable DATA_DIR for this setup");
  await page.screenshot({ path: `${output}/screenshots/00-welcome.png`, animations: "disabled" });
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByLabel("姓名", { exact: true }).fill("生产验收测试员");
  await page.getByLabel("邮箱", { exact: true }).fill(`acceptance-${randomUUID().slice(0,8)}@example.test`);
  await page.getByLabel("密码", { exact: true }).fill(randomUUID());
  await page.getByRole("button", { name: "创建账号并进入" }).click();
  await page.getByText("生产验收测试员", { exact: true }).waitFor();
  await context.storageState({ path: "/tmp/famsun-acceptance-admin.json" });
  await chmod("/tmp/famsun-acceptance-admin.json", 0o600);
  await page.screenshot({ path: `${output}/screenshots/01-registered.png`, animations: "disabled" });
  const settings = await (await context.request.get("/api/settings")).json();
  const evidence = {
    started_at: new Date().toISOString(), base_url: baseURL,
    model: settings.provider.model, api_mode: settings.provider.api_mode,
    limits: settings.limits, first_registration: true,
    browser_errors: errors, dataset: "synthetic manufacturing data; no customer data",
    notes: "Fresh SQLite data directory; same production build and sandbox limits. No provider mocks.",
  };
  await writeFile(`${output}/setup.json`, JSON.stringify(evidence, null, 2));
  console.log("PASS: fresh browser registration and private authentication state saved; model", settings.provider.model);
} finally {
  await browser.close();
}
