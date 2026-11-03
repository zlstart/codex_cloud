import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext();
await context.addInitScript(() => {
  window.testSources = [];
  window.EventSource = class extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.closed = false;
      window.testSources.push(this);
    }
    close() {
      this.closed = true;
    }
  };
  window.emitRun = (events) => {
    for (const source of window.testSources.filter((s) => !s.closed)) {
      for (const e of events)
        source.dispatchEvent(
          new MessageEvent(e.type, {
            data: JSON.stringify(e.data),
            lastEventId: String(e.sequence),
          }),
        );
    }
  };
});
const now = "2026-11-02T12:00:00Z";
const session = {
  id: "timeline",
  title: "时间线验证",
  model: "fixture-model",
  pinned: false,
  created_at: now,
  updated_at: now,
};
const run = {
  id: "run-1",
  session_id: session.id,
  status: "running",
  created_at: now,
  updated_at: now,
};
const userMessage = {
  id: "user-1",
  run_id: run.id,
  role: "user",
  content: "请检查销售数据并生成结果。",
  created_at: now,
};
let runStatus = "running";
let historyRequests = 0;
const events = [];
let sequence = 0;
const record = (type, data) => {
  const event = {
    sequence: ++sequence,
    run_id: run.id,
    type,
    data,
    created_at: now,
  };
  events.push(event);
  return event;
};
const json = (route, data) =>
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(data),
  });
await context.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/auth/me")
    return json(route, {
      id: "u1",
      name: "测试用户",
      email: "qa@example.com",
      role: "admin",
    });
  if (url.pathname === "/api/settings")
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
  if (url.pathname === "/api/sessions") return json(route, [session]);
  if (url.pathname === `/api/sessions/${session.id}`)
    return json(route, {
      session,
      files: [],
      runs: [{ ...run, status: runStatus }],
      messages: [
        userMessage,
        ...(runStatus === "completed"
          ? [
              {
                id: "final-1",
                run_id: run.id,
                role: "assistant",
                content: "最终核验结果：销售额增长 12%。",
                created_at: now,
              },
            ]
          : []),
      ],
    });
  if (url.pathname === `/api/runs/${run.id}/timeline`) {
    historyRequests++;
    const after = Number(url.searchParams.get("after") || 0);
    const remaining = events.filter((e) => e.sequence > after);
    const selected = remaining.slice(0, 5);
    const duplicate = after ? events.find((e) => e.sequence === after) : null;
    return json(route, {
      events: [...(duplicate ? [duplicate] : []), ...selected],
      next_cursor: selected.at(-1)?.sequence ?? after,
      has_more: remaining.length > selected.length,
      status: runStatus,
    });
  }
  return json(route, []);
});
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(baseURL);
  await page
    .locator(".session-select")
    .filter({ hasText: session.title })
    .click();
  await page.waitForFunction(() => window.testSources.some((s) => !s.closed));
  const first = [
    record("text.delta", {
      item_id: "intro",
      delta: "先检查数据来源与缺失值。",
      agent_id: "main",
    }),
    record("tool.started", {
      item_id: "tool-a",
      call_id: "call-a",
      name: "shell",
      arguments: { command: "inspect source" },
    }),
    record("text.delta", { item_id: "progress", delta: "接着核对汇总口径。" }),
    record("tool.started", {
      item_id: "tool-b",
      call_id: "call-b",
      name: "shell",
      arguments: { command: "verify totals" },
    }),
    record("tool.completed", {
      call_id: "call-b",
      name: "shell",
      output: "TOTAL_B",
    }),
    record("tool.completed", {
      call_id: "call-a",
      name: "shell",
      output: "SOURCE_A",
    }),
    record("text.completed", {
      item_id: "child",
      text: "子助手完成了交叉核验。",
      phase: "final",
      agent_id: "analyst",
      agent_name: "数据分析师",
      parent_call_id: "delegate-1",
    }),
    record("text.delta", {
      item_id: "answer",
      delta: "初步结果：增长 12%。",
      agent_id: "main",
    }),
    record("text.phase", { item_id: "answer", phase: "final" }),
  ];
  await page.evaluate((entries) => window.emitRun(entries), first);
  await page.getByText("先检查数据来源与缺失值。", { exact: true }).waitFor();
  assert.deepEqual(
    await page
      .locator(".timeline-list > li")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.itemId)),
    ["intro", "tool-a", "progress", "tool-b", "child"],
  );
  await page.locator('[data-call-id="call-a"] summary').click();
  await page.locator('[data-call-id="call-b"] summary').click();
  assert.match(
    await page.locator('[data-call-id="call-a"]').innerText(),
    /SOURCE_A/,
  );
  assert.match(
    await page.locator('[data-call-id="call-b"]').innerText(),
    /TOTAL_B/,
  );
  await page.evaluate((entry) => window.emitRun([entry]), first[7]);
  assert.equal(
    await page.locator(".final-answer").innerText(),
    "初步结果：增长 12%。",
  );
  await page.getByRole("button", { name: /正在处理.*2 个步骤/ }).click();
  assert.equal(await page.locator(".timeline-list").count(), 0);
  assert.equal(await page.locator(".final-answer").isVisible(), true);
  await page.getByRole("button", { name: /正在处理.*2 个步骤/ }).click();
  await page.evaluate(() =>
    window.testSources
      .find((source) => !source.closed)
      .onerror(new Event("error")),
  );
  await page
    .getByText("连接暂时中断，正在恢复执行记录…", { exact: true })
    .waitFor();
  await page.evaluate(() =>
    window.testSources
      .find((source) => !source.closed)
      .onopen(new Event("open")),
  );
  await page.waitForTimeout(100);
  const distanceFromEnd = await page
    .locator(".chat-scroll")
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  assert.ok(
    distanceFromEnd >= 100 ||
      (await page.getByRole("button", { name: "回到最新内容" }).count()) === 0,
    "Collapsing content to fit must clear a stale jump-to-latest button",
  );
  await page.screenshot({
    path: "/tmp/famsun-timeline-live-desktop.png",
    fullPage: true,
  });
  const long = [];
  for (let i = 0; i < 30; i++)
    long.push(
      record("text.delta", {
        item_id: `step-${i}`,
        delta: `检查记录 ${i + 1}：核验地区、时间、口径及数据来源，并保留可复核的证据。`,
      }),
    );
  await page.evaluate((entries) => window.emitRun(entries), long);
  await page.waitForTimeout(100);
  await page.locator(".chat-scroll").evaluate((el) => {
    el.scrollTop = 80;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.getByRole("button", { name: "回到最新内容" }).waitFor();
  await page.evaluate(
    (entry) => window.emitRun([entry]),
    record("text.delta", {
      item_id: "last-progress",
      delta: "最后一项核验已经完成。",
    }),
  );
  await page.waitForTimeout(100);
  assert.ok(
    await page.locator(".chat-scroll").evaluate((el) => el.scrollTop < 150),
    "Streaming must not steal the reader's scroll position",
  );
  await page.getByRole("button", { name: "回到最新内容" }).click();
  assert.ok(
    await page
      .locator(".chat-scroll")
      .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 100),
  );
  runStatus = "completed";
  await page.evaluate(
    (entry) => window.emitRun([entry]),
    record("run.completed", { final_item_ids: ["answer"] }),
  );
  await page
    .getByText("最终核验结果：销售额增长 12%。", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".final-answer").count(), 1);
  assert.equal(
    await page.getByText("初步结果：增长 12%。", { exact: true }).count(),
    0,
  );
  assert.equal(await page.locator(".timeline-list").count(), 0);
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  await page.getByText("先检查数据来源与缺失值。", { exact: true }).waitFor();
  assert.ok(
    historyRequests > 1,
    "History should paginate and reuse the reducer",
  );
  assert.equal(await page.locator('[data-item-id="intro"]').count(), 1);
  assert.equal(await page.locator(".final-answer").count(), 1);
  await page.getByRole("button", { name: /执行过程.*2 个步骤/ }).click();
  assert.equal(await page.locator(".final-answer").isVisible(), true);
  await page.screenshot({
    path: "/tmp/famsun-timeline-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /执行过程.*2 个步骤/ }).click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Timeline must fit the mobile viewport",
  );
  await page.screenshot({
    path: "/tmp/famsun-timeline-mobile.png",
    fullPage: true,
  });
  runStatus = "failed";
  events.length = 0;
  sequence = 0;
  record("text.delta", { item_id: "partial", delta: "已保存部分检查结果。" });
  record("tool.started", {
    call_id: "interrupted",
    name: "shell",
    arguments: {},
  });
  record("run.failed", { error: "连接异常" });
  await page.reload();
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page
    .locator(".session-select")
    .filter({ hasText: session.title })
    .click();
  await page.locator(".incomplete-message").waitFor();
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  await page.getByText("已保存部分检查结果。", { exact: true }).waitFor();
  assert.match(
    await page.locator('[data-call-id="interrupted"]').innerText(),
    /已中断/,
  );
  assert.equal(await page.locator(".final-answer").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: chronological SSE, same-name concurrent tools, replay dedupe/pagination, child attribution, separate authoritative final, collapsible process, reader-controlled scroll, mobile layout",
  );
} finally {
  await browser.close();
}
