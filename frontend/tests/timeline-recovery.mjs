import { chromium } from "playwright";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext();
await context.addInitScript(() => {
  window.sources = [];
  window.EventSource = class extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.closed = false;
      window.sources.push(this);
    }
    close() {
      this.closed = true;
    }
  };
  window.sendEvents = (events) =>
    window.sources
      .filter((s) => !s.closed)
      .forEach((s) =>
        events.forEach((e) =>
          s.dispatchEvent(
            new MessageEvent(e.type, {
              data: JSON.stringify(e.data),
              lastEventId: String(e.id),
            }),
          ),
        ),
      );
});
const now = new Date().toISOString();
const session = {
  id: "s1",
  title: "恢复验证",
  created_at: now,
  updated_at: now,
  pinned: false,
  model: "model",
};
const run = {
  id: "r1",
  session_id: "s1",
  status: "running",
  created_at: now,
  updated_at: now,
};
const approvalGates = new Map();
let terminal = false;
let unavailable = false;
let failures = 0;
const json = (route, data, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
await context.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/auth/me")
    return json(route, {
      id: "u1",
      name: "测试",
      email: "test@example.com",
      role: "admin",
    });
  if (path === "/api/settings")
    return json(route, {
      provider: {
        configured: true,
        api_mode: "responses",
        model: "model",
        base_url: "",
      },
      sandbox: { available: true, backend: "docker" },
      limits: { max_turns: 20, max_upload_mb: 25 },
      registration_enabled: true,
    });
  if (path === "/api/sessions") return json(route, [session]);
  if (path === "/api/sessions/s1") {
    if (terminal && (unavailable || failures > 0)) {
      failures = Math.max(0, failures - 1);
      return json(route, { detail: "暂时无法读取会话" }, 503);
    }
    return json(route, {
      session,
      files: [],
      runs: [{ ...run, status: terminal ? "completed" : "running" }],
      messages: [
        {
          id: "m1",
          run_id: "r1",
          role: "user",
          content: "开始",
          created_at: now,
        },
        ...(terminal
          ? [
              {
                id: "m2",
                run_id: "r1",
                role: "assistant",
                content: "服务端最终结果",
                created_at: now,
              },
            ]
          : []),
      ],
    });
  }
  if (path === "/api/runs/r1/approve") {
    const id = route.request().postDataJSON().approval_id;
    const status = await new Promise((resolve) =>
      approvalGates.set(id, resolve),
    );
    return json(
      route,
      status === 200 ? { ok: true } : { detail: "旧授权已经过期" },
      status,
    );
  }
  return json(route, []);
});
const page = await context.newPage();
try {
  await page.goto(process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173");
  await page
    .locator(".session-select")
    .filter({ hasText: session.title })
    .click();
  await page.waitForFunction(() => window.sources.some((s) => !s.closed));
  await page.evaluate(() =>
    window.sendEvents([
      {
        id: 1,
        type: "approval.required",
        data: { id: "a", tool: "TOOL_A", arguments: {} },
      },
    ]),
  );
  await page.getByRole("button", { name: "允许本次操作" }).click();
  await page.evaluate(() =>
    window.sendEvents([
      { id: 2, type: "approval.resolved", data: { id: "a" } },
      {
        id: 3,
        type: "approval.required",
        data: { id: "b", tool: "TOOL_B", arguments: {} },
      },
    ]),
  );
  await page.getByText("TOOL_B", { exact: true }).waitFor();
  await page.getByRole("button", { name: "允许本次操作" }).click();
  approvalGates.get("a")(200);
  await page.waitForTimeout(150);
  assert.equal(
    await page.getByText("TOOL_B", { exact: true }).count(),
    1,
    "Late A response must preserve approval B",
  );
  assert.equal(
    await page.getByRole("button", { name: "允许本次操作" }).isDisabled(),
    true,
    "Late A response must not reset B's pending decision",
  );
  await page.evaluate(() =>
    window.sendEvents([
      { id: 4, type: "approval.resolved", data: { id: "b" } },
      {
        id: 5,
        type: "approval.required",
        data: { id: "c", tool: "TOOL_C", arguments: {} },
      },
    ]),
  );
  approvalGates.get("b")(409);
  await page.waitForTimeout(150);
  assert.equal(
    await page.getByText("旧授权已经过期", { exact: true }).count(),
    0,
    "Old approval errors must not leak into the next approval",
  );
  terminal = true;
  unavailable = true;
  await page.evaluate(() =>
    window.sendEvents([
      {
        id: 6,
        type: "text.completed",
        data: { item_id: "final", text: "流式最终结果", phase: "final" },
      },
      { id: 7, type: "run.completed", data: { final_item_ids: ["final"] } },
    ]),
  );
  await page.getByRole("button", { name: "重试同步", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "停止生成", exact: true }).count(),
    0,
    "Terminal runs must release the composer when detail refresh fails",
  );
  assert.equal(
    await page.getByText("流式最终结果", { exact: true }).isVisible(),
    true,
    "Terminal snapshot must survive a failed refresh",
  );
  await page
    .getByRole("textbox", { name: "发送给丰尚助手的消息" })
    .fill("保留这个后续问题");
  unavailable = false;
  await page.getByRole("button", { name: "重试同步", exact: true }).click();
  await page.getByText("服务端最终结果", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "发送给丰尚助手的消息" })
      .inputValue(),
    "保留这个后续问题",
  );
  assert.equal(await page.locator(".final-answer").count(), 1);

  terminal = false;
  await page.reload();
  await page
    .locator(".session-select")
    .filter({ hasText: session.title })
    .click();
  await page.waitForFunction(() => window.sources.some((s) => !s.closed));
  terminal = true;
  failures = 1;
  await page.evaluate(() =>
    window.sendEvents([
      {
        id: 1,
        type: "text.completed",
        data: { item_id: "final", text: "自动重试结果", phase: "final" },
      },
      { id: 2, type: "run.completed", data: { final_item_ids: ["final"] } },
    ]),
  );
  await page
    .getByText("服务端最终结果", { exact: true })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await page.getByRole("button", { name: "重试同步", exact: true }).count(),
    0,
  );
  console.log(
    "PASS: delayed approval success/error isolation, terminal composer recovery, preserved final/draft, manual sync and automatic retry",
  );
} finally {
  await browser.close();
}
