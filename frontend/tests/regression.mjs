import { chromium } from "playwright";
import { existsSync } from "node:fs";
const baseUrl = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173";
const executablePath =
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox"],
});
const user = {
  id: "u1",
  email: "qa@example.com",
  name: "测试用户",
  role: "admin",
};
const settings = {
  provider: {
    base_url: "https://api.example.com/v1",
    model: "test-model",
    api_mode: "responses",
    configured: true,
  },
  sandbox: { backend: "docker", available: true },
  limits: { max_upload_mb: 25, max_turns: 20 },
  registration_enabled: true,
};
const now = new Date().toISOString();
const session = (id, title) => ({
  id,
  title,
  created_at: now,
  updated_at: now,
  model: "test-model",
  pinned: false,
});
const sessions = [session("a", "会话甲"), session("b", "会话乙")];
const file = {
  id: "file1",
  session_id: "b",
  name: "chart.png",
  mime_type: "image/png",
  size: 68,
  kind: "output",
  created_at: now,
  url: "/api/files/file1/content",
};
const json = (route, data, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
let releaseRun;
const runGate = new Promise((r) => (releaseRun = r));
let runPosted = false;
let badRequests = 0;
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("request", (r) => {
  if (r.url().includes("private-exfil.example")) badRequests++;
});
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/auth/me") return json(route, user);
  if (path === "/api/settings") return json(route, settings);
  if (path === "/api/sessions") return json(route, sessions);
  if (path === "/api/sessions/a")
    return json(route, {
      session: sessions[0],
      messages: [],
      files: [],
      runs: [],
    });
  if (path === "/api/sessions/b")
    return json(route, {
      session: sessions[1],
      messages: [
        {
          id: "m1",
          role: "assistant",
          created_at: now,
          run_id: "finished",
          content:
            "分析完成。\n\n![私有](https://private-exfil.example/secret)\n\n![图表](outputs/chart.png)\n\n[查看图表](sandbox:/workspace/outputs/chart.png)",
        },
      ],
      files: [file],
      runs: [],
    });
  if (path === "/api/sessions/a/runs") {
    runPosted = true;
    await runGate;
    return json(route, {
      id: "r1",
      session_id: "a",
      status: "running",
      created_at: now,
      updated_at: now,
    });
  }
  if (path === "/api/files/file1/content")
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  if (path === "/api/runs/finished/timeline")
    return json(route, {
      events: [
        {
          sequence: 1,
          run_id: "finished",
          type: "tool.started",
          data: { name: "python", arguments: { code: "print(1)" } },
          created_at: now,
        },
        {
          sequence: 2,
          run_id: "finished",
          type: "tool.completed",
          data: { name: "python", output: "1" },
          created_at: now,
        },
        {
          sequence: 3,
          run_id: "finished",
          type: "run.completed",
          data: {},
          created_at: now,
        },
      ],
      next_cursor: 3,
      has_more: false,
      status: "completed",
    });
  return json(route, []);
});
await page.goto(baseUrl);
await page.getByRole("button", { name: "会话甲" }).click();
await page
  .getByRole("textbox", { name: "发送给丰尚助手的消息" })
  .fill("在会话甲运行");
await page.getByRole("button", { name: "发送消息", exact: true }).click();
await page.waitForTimeout(100);
assert.equal(runPosted, true);
await page.getByRole("button", { name: "会话乙" }).click();
await page
  .getByRole("textbox", { name: "发送给丰尚助手的消息" })
  .fill("乙会话保留草稿");
releaseRun();
await page.waitForTimeout(350);
assert.equal(await page.locator(".breadcrumb-title").textContent(), "会话乙");
assert.equal(
  await page
    .getByRole("textbox", { name: "发送给丰尚助手的消息" })
    .inputValue(),
  "乙会话保留草稿",
);
assert.equal(await page.getByRole("button", { name: "停止生成" }).count(), 0);
assert.equal(badRequests, 0);
assert.equal(await page.locator(".message-content img").count(), 1);
assert.equal(
  await page.locator(".message-content img").getAttribute("src"),
  "/api/files/file1/content",
);
await page.getByRole("button", { name: "执行记录" }).click();
await page.getByText("python", { exact: true }).waitFor();
await page.getByRole("button", { name: "查看图表", exact: true }).click();
await page.getByRole("dialog", { name: "chart.png" }).waitFor();
await page.close();
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.route("**/api/auth/me", (route) =>
  json(route, { detail: "未登录" }, 401),
);
await mobile.goto(baseUrl);
await mobile.getByRole("heading", { name: "让灵感，成为生产力。" }).waitFor();
assert.equal(await mobile.locator(".workspace-panel").count(), 0);
assert.equal(
  await mobile
    .getByRole("textbox", { name: "发送给丰尚助手的消息" })
    .isVisible(),
  true,
);
assert.equal(
  await mobile.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  ),
  true,
);
await browser.close();
console.log(
  "PASS: mobile welcome/overflow, async session-switch draft isolation, remote-image privacy, inline artifact mapping, persisted execution history",
);
