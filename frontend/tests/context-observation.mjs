import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

// Frontend protocol fixtures verify rendering/replay, not live provider support.
const artifacts = process.env.FAMSUN_CONTEXT_QA_DIR || "/tmp/famsun-context-ui";
mkdirSync(artifacts, { recursive: true });
const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await context.addInitScript(() => {
  window.testSources = [];
  window.EventSource = class extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      window.testSources.push(this);
    }
    close() {
      this.closed = true;
    }
  };
  window.emitRun = (events) => {
    for (const source of window.testSources.filter((s) => !s.closed))
      for (const event of events)
        source.dispatchEvent(
          new MessageEvent(event.type, {
            data: JSON.stringify(event.data),
            lastEventId: String(event.sequence),
          }),
        );
  };
});
const now = "2026-11-04T01:00:00Z";
const session = {
  id: "context-qa",
  title: "压缩观测验证",
  model: "fixture-model",
  pinned: false,
  created_at: now,
  updated_at: now,
};
const run = {
  id: "context-run",
  session_id: session.id,
  status: "running",
  created_at: now,
  updated_at: now,
};
let runStatus = "running";
const events = [];
const record = (type, data) => {
  const event = {
    sequence: events.length + 1,
    run_id: run.id,
    type,
    data,
    created_at: now,
  };
  events.push(event);
  return event;
};
const observation = (response_id, overrides = {}) => ({
  item_id: response_id,
  response_id,
  agent_id: "main",
  agent_name: "主助手",
  parent_call_id: null,
  status: "threshold_exceeded",
  input_tokens: 41296,
  threshold: 32000,
  compaction_count: 0,
  ...overrides,
});
const json = (route, data) =>
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(data),
  });
await context.route("**/api/**", (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/auth/me")
    return json(route, {
      id: "u1",
      name: "测试用户",
      email: "qa@example.com",
      role: "admin",
    });
  if (path === "/api/settings")
    return json(route, {
      provider: {
        model: "fixture-model",
        base_url: "https://example.com/v1",
        api_mode: "responses",
        configured: true,
      },
      sandbox: { backend: "docker", available: true },
      limits: { max_upload_mb: 25, max_turns: 20 },
      registration_enabled: true,
    });
  if (path === "/api/sessions") return json(route, [session]);
  if (path === `/api/sessions/${session.id}`)
    return json(route, {
      session,
      files: [],
      runs: [{ ...run, status: runStatus }],
      messages: [
        {
          id: "user-1",
          run_id: run.id,
          role: "user",
          content: "请核验长上下文与子助手的压缩状态。",
          created_at: now,
        },
        ...(runStatus === "completed"
          ? [
              {
                id: "final-1",
                run_id: run.id,
                role: "assistant",
                content: "核验完成。",
                created_at: now,
              },
            ]
          : []),
      ],
    });
  if (path === `/api/runs/${run.id}/timeline`)
    return json(route, {
      events,
      next_cursor: events.at(-1)?.sequence ?? 0,
      has_more: false,
      status: runStatus,
    });
  return json(route, []);
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
try {
  await page.goto(baseURL);
  await page
    .locator(".session-select")
    .filter({ hasText: session.title })
    .click();
  await page.waitForFunction(() =>
    window.testSources.some((source) => !source.closed),
  );
  await page.evaluate(
    (entries) => window.emitRun(entries),
    [
      record("text.delta", {
        item_id: "progress",
        delta: "正在核验长上下文观测。",
      }),
      record("context.status", observation("response-1")),
    ],
  );
  await page.getByText("正在核验长上下文观测。", { exact: true }).waitFor();
  await page.screenshot({
    path: `${artifacts}/initial-desktop.png`,
    fullPage: true,
  });
  assert.equal(
    await page.locator(".timeline-context").count(),
    1,
    "Live SSE must render context.status",
  );
  assert.match(await page.locator(".timeline-context").innerText(), /41,296/);
  assert.match(await page.locator(".timeline-context").innerText(), /32,000/);
  assert.match(await page.locator(".timeline-context").innerText(), /未.*压缩/);
  assert.doesNotMatch(
    await page.locator(".timeline-context").innerText(),
    /不支持/,
  );
  assert.equal(await page.locator('.inline-notice[role="alert"]').count(), 0);
  await page.evaluate(
    (entries) => window.emitRun(entries),
    [
      record(
        "context.status",
        observation("response-2", { input_tokens: 43000 }),
      ),
      record(
        "context.status",
        observation("child-1", {
          agent_id: "analyst",
          agent_name: "数据分析师",
          parent_call_id: "delegate-a",
          status: "not_observed",
          input_tokens: null,
        }),
      ),
      record(
        "context.status",
        observation("child-2", {
          agent_id: "analyst",
          agent_name: "数据分析师",
          parent_call_id: "delegate-b",
          status: "compacted",
          input_tokens: 44000,
          compaction_count: 1,
        }),
      ),
    ],
  );
  await page.getByText(/43,000/).waitFor();
  assert.equal(await page.locator(".timeline-context").count(), 3);
  assert.match(
    await page.locator('[data-context-status="not_observed"]').innerText(),
    /未提供/,
  );
  assert.match(
    await page.locator('[data-context-status="compacted"]').innerText(),
    /原生.*压缩/,
  );
  const live = await page.locator(".timeline-context").allTextContents();
  assert.equal(await page.locator('.inline-notice[role="alert"]').count(), 0);
  await page.screenshot({
    path: `${artifacts}/live-desktop.png`,
    fullPage: true,
  });
  runStatus = "completed";
  await page.evaluate(
    (entry) => window.emitRun([entry]),
    record("run.completed", {}),
  );
  await page.getByText("核验完成。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  await page.locator('[data-context-status="compacted"]').waitFor();
  assert.deepEqual(
    await page.locator(".timeline-context").allTextContents(),
    live,
  );
  await page.screenshot({
    path: `${artifacts}/history-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator(".sidebar-open").count())
    await page.getByRole("button", { name: "收起导航", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  await page.locator(".timeline-context").first().scrollIntoViewIfNeeded();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: `${artifacts}/history-mobile.png`,
    fullPage: true,
  });
  assert.equal(new URL(page.url()).origin, new URL(baseURL).origin);
  assert.ok((await page.title()).length > 0);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: context status live SSE and identical history; scoped updates; honest missing usage; no per-response alerts; desktop/mobile; no console errors",
  );
} finally {
  await browser.close();
}
