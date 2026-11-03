import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173";
const now = "2026-11-03T00:00:00Z";
const session = {
  id: "rendering",
  title: "代码与工具显示",
  created_at: now,
  updated_at: now,
};
const run = {
  id: "rendering-run",
  session_id: session.id,
  status: "completed",
  created_at: now,
  updated_at: now,
};
const python = 'def greet(name):\n    return "Hello, " + name\n';
const hostile = '<img src=x onerror="window.renderingInjected=true">';
const longLine = "long_value = " + "x".repeat(400);
const markdown = [
  "代码示例，内联 `const inline = true`。",
  "```py\n" + python + "```",
  "```html\n" + hostile + "\n```",
  "```unknown-language\nplain <tag>\n```",
  "```\nuntagged source\n```",
  "```js\n" + longLine + "\n```",
].join("\n\n");
let sequence = 0;
const traceId = "trace_" + "a".repeat(32);
const events = [
  {
    sequence: ++sequence,
    run_id: run.id,
    type: "run.tracing",
    data: {
      provider: "openai",
      status: "enabled",
      trace_id: traceId,
      sensitive_data: false,
    },
    created_at: now,
  },
];
function tool(callId, name, args, output, type = "tool.completed") {
  for (const [eventType, data] of [
    ["tool.started", { call_id: callId, name, arguments: args }],
    [type, { call_id: callId, name, output }],
  ])
    events.push({
      sequence: ++sequence,
      run_id: run.id,
      type: eventType,
      data,
      created_at: now,
    });
}
tool(
  "shell",
  "exec_command",
  { cmd: "python report.py", workdir: "/workspace", max_output_tokens: 3000 },
  "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 2\nOutput:\nFile not found",
);
tool(
  "patch",
  "apply_patch",
  {
    raw: "*** Begin Patch\n*** Update File: report.py\n@@\n-old = 1\n+new = 2\n*** End Patch",
  },
  "Success. Updated the following files:\nM report.py",
);
tool(
  "json",
  "lookup",
  { query: "sales" },
  JSON.stringify({ rows: [{ total: 123 }], source: "report.csv" }),
);
tool(
  "long",
  "exec_command",
  { cmd: "cat large.log" },
  JSON.stringify({
    exit_code: 0,
    output: "line\n".repeat(6000) + "LAST_LINE",
    wall_time_seconds: 1,
  }),
);
tool(
  "background",
  "exec_command",
  { cmd: "python worker.py" },
  "Chunk ID: job\nWall time: 1 seconds\nProcess running with session ID 42\nFinal output:\nStarted",
);
tool(
  "error",
  "lookup",
  {},
  JSON.stringify({
    isError: true,
    content: [{ type: "text", text: "Permission denied" }],
  }),
);
events.push({
  sequence: ++sequence,
  run_id: run.id,
  type: "run.completed",
  data: {},
  created_at: now,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value) => {
        window.copiedCode = value;
      },
    },
  });
});
const json = (route, value) =>
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(value),
  });
await context.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/auth/me")
    return json(route, { id: "u1", name: "测试用户", role: "admin" });
  if (url.pathname === "/api/settings")
    return json(route, {
      provider: { model: "fixture", configured: true },
      sandbox: { backend: "docker", available: true },
      limits: { max_upload_mb: 25 },
    });
  if (url.pathname === "/api/sessions") return json(route, [session]);
  if (url.pathname === `/api/sessions/${session.id}`)
    return json(route, {
      session,
      files: [],
      runs: [run],
      messages: [
        {
          id: "question",
          role: "user",
          content: "展示代码和工具结果",
          run_id: run.id,
          created_at: now,
        },
        {
          id: "answer",
          role: "assistant",
          content: markdown,
          run_id: run.id,
          created_at: now,
        },
      ],
    });
  if (url.pathname === `/api/runs/${run.id}/timeline`)
    return json(route, {
      events,
      next_cursor: sequence,
      has_more: false,
      status: "completed",
    });
  return json(route, []);
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(baseURL);
  await page
    .locator(".session-select")
    .filter({ hasText: session.title })
    .click();
  const code = page.locator(
    '.final-answer .code-block[data-language="python"]',
  );
  await page.locator(".final-answer .code-block").first().waitFor();
  assert.equal(
    (await code.locator(".hljs-keyword").count()) > 0,
    true,
    "Python fences need syntax highlighting",
  );
  assert.equal(
    await code.locator("code").textContent(),
    python,
    "Code preserves exact whitespace",
  );
  await code.getByRole("button", { name: "复制代码" }).click();
  assert.equal(
    await page.evaluate(() => window.copiedCode),
    python,
    "Copy uses the original source",
  );
  assert.equal(
    await page
      .locator('.final-answer .code-block[data-language="plaintext"]')
      .count(),
    2,
    "Unknown and untagged fences fall back to text",
  );
  assert.equal(
    await page.locator(".final-answer p code").textContent(),
    "const inline = true",
    "Inline code remains inline",
  );
  assert.equal(
    await page.locator(".final-answer img").count(),
    0,
    "Code cannot inject HTML",
  );
  assert.equal(await page.evaluate(() => window.renderingInjected), undefined);

  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  const traceLink = page.getByRole("link", { name: "查看 OpenAI 追踪" });
  assert.equal(
    await traceLink.getAttribute("href"),
    `https://platform.openai.com/traces/trace?trace_id=${traceId}`,
  );
  assert.match(
    await page.locator(".run-tracing").innerText(),
    /正文采集：关闭/,
  );
  for (const id of ["shell", "patch", "json", "long", "background", "error"]) {
    await page.locator(`[data-call-id="${id}"] > summary`).click();
  }
  const shell = page.locator('[data-call-id="shell"]');
  assert.match(
    await shell.locator(":scope > summary").innerText(),
    /执行失败/,
    "Nonzero exit must not look successful",
  );
  assert.equal(
    await shell.locator('[data-language="bash"] code').textContent(),
    "python report.py",
  );
  assert.match(await shell.innerText(), /工作目录.*\/workspace/s);
  assert.match(await shell.innerText(), /退出码.*2/s);
  assert.equal(
    await shell.locator('[data-language="plaintext"] code').textContent(),
    "File not found",
  );
  assert.equal(
    (await page.locator('[data-call-id="patch"] .hljs-addition').count()) > 0,
    true,
    "Patch additions are highlighted",
  );
  assert.equal(
    (await page
      .locator('[data-call-id="json"] [data-language="json"] .hljs-attr')
      .count()) > 0,
    true,
    "JSON strings are formatted and highlighted",
  );
  assert.match(
    await page.locator('[data-call-id="error"] summary').innerText(),
    /执行失败/,
  );
  assert.match(
    await page.locator('[data-call-id="error"]').innerText(),
    /Permission denied/,
  );
  assert.match(
    await page.locator('[data-call-id="background"] summary').innerText(),
    /已转入后台/,
  );
  const longOutput = page.locator(
    '[data-call-id="long"] [data-language="plaintext"] pre',
  );
  assert.match(
    await longOutput.textContent(),
    /LAST_LINE$/,
    "Long output is scrollable without silently discarding its tail",
  );
  assert.ok(
    await longOutput.evaluate(
      (node) =>
        node.scrollHeight > node.clientHeight && node.clientHeight < 400,
    ),
  );
  await page.locator(".chat-scroll").evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({
    path: "/tmp/famsun-rendering-desktop.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Code fits narrow screens",
  );
  const wideCode = page.locator(
    '.final-answer [data-language="javascript"] pre',
  );
  assert.ok(
    await wideCode.evaluate((node) => node.scrollWidth > node.clientWidth),
    "Wide code scrolls horizontally",
  );
  assert.deepEqual(errors, []);
  await page.locator(".chat-scroll").evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({
    path: "/tmp/famsun-rendering-tools-mobile.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.getByRole("button", { name: /执行过程.*6 个步骤/ }).click();
  await page.locator(".chat-scroll").evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({
    path: "/tmp/famsun-rendering-mobile.png",
    animations: "disabled",
    fullPage: true,
  });
  console.log(
    "PASS: highlighted Markdown, safe/plain fallbacks, exact copy, structured shell/patch/JSON results, failure statuses, full scrollable output, mobile layout",
  );
} finally {
  await browser.close();
}
