// Live acceptance: real UI, configured provider, persisted events, and generated HTML.
// No model/API mocks; generated code is never edited by this test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { playSnake } from "./acceptance-snake-play.mjs";

const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8000";
const output = path.resolve(
  process.env.FAMSUN_TEST_OUTPUT ||
    "../test-results/production-acceptance-2026-11-03/snake",
);
const storageState =
  process.env.FAMSUN_TEST_STORAGE_STATE || "/tmp/famsun-acceptance-admin.json";
const mode = process.argv[2] || "generate";
const title = "生产验收·贪吃蛇";
const originalPrompt = `请直接制作一个可离线打开、可实际游玩的完整贪吃蛇小游戏，并保存为 outputs/snake.html，最后给出文件链接。
要求：所有 HTML、CSS 和 JavaScript 放在这一个文件，不能引用 CDN、外部字体、图片或其他网络资源；精致清晰的中文界面，桌面和手机屏幕都适配。
必须有清楚的当前得分、游戏状态，开始、暂停/继续、重新开始按钮；键盘方向键和 WASD 控制方向，手机上有四个可点击的触控方向按钮（有清楚的文字或 aria-label）。撞墙或撞到自己结束游戏；吃到食物增长并增加得分；不能直接反向穿过身体。
请实际创建文件并用工具检查 HTML/脚本基本完整性，不要只在回复里贴代码，也不要需要我自行配置环境或确认。`;
const prompt = process.env.FAMSUN_ACCEPTANCE_PROMPT || (mode === "continue" ? "请继续完成上次任务，检查已存在 snake.html，保留成果，修复剩余问题并给出最终说明。" : originalPrompt);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeError = (error) =>
  String(error?.message ?? error).replace(
    /\b(cookie|authorization|x-api-key|api-key):[^\r\n]*/gi,
    "$1: [redacted]",
  );
const save = async (name, value) =>
  writeFile(
    path.join(output, name),
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
  );
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  baseURL,
  storageState,
  acceptDownloads: true,
  reducedMotion: "reduce",
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const browserErrors = [];
const networkRetries = [];
page.on("pageerror", (error) => browserErrors.push(error.message));
const screenshot = (name) =>
  page.screenshot({
    path: path.join(output, name),
    animations: "disabled",
    fullPage: true,
  });
const get = async (url) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await context.request.get(url);
      assert.equal(response.status(), 200, `GET ${url}`);
      return response.json();
    } catch (error) {
      if (
        attempt >= 2 ||
        !/ECONNRESET|ECONNREFUSED|Timeout|socket hang up/.test(safeError(error))
      )
        throw error;
      networkRetries.push({
        at: new Date().toISOString(),
        url,
        attempt: attempt + 1,
        error: safeError(error),
      });
      await save("network-retries.json", networkRetries);
      await page.waitForTimeout(1000);
    }
  }
};
let record;

async function openSession() {
  await page.goto(baseURL);
  const detail = await get(`/api/sessions/${record.session_id}`);
  await page
    .locator(".session-select")
    .filter({ hasText: detail.session.title })
    .first()
    .click();
  await page.getByLabel("发送给丰尚助手的消息").waitFor();
}

async function renameSession() {
  await page.locator(".session-row.selected").hover();
  await page.locator(".session-row.selected .session-more").click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.getByLabel("对话名称", { exact: true }).fill(title);
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
}

async function timeline(runId) {
  let after = 0;
  const events = [];
  for (;;) {
    const result = await get(
      `/api/runs/${runId}/timeline?after=${after}&limit=1000`,
    );
    events.push(...result.events);
    if (!result.has_more) break;
    assert.ok(result.next_cursor > after, "Timeline pagination advances");
    after = result.next_cursor;
  }
  assert.equal(
    new Set(events.map((event) => event.sequence)).size,
    events.length,
    "Persisted events are unique",
  );
  assert.ok(
    events.every(
      (event, index) =>
        index === 0 || event.sequence > events[index - 1].sequence,
    ),
    "Persisted events are ordered",
  );
  return events;
}

async function generate() {
  const started = Date.now();
  await save("prompt.txt", prompt);
  try {
    record = JSON.parse(await readFile(path.join(output, "run.json"), "utf8"));
  } catch {
    /* first real submission */
  }
  if (!record) {
    let prior;
    if (mode === "continue") {
      assert.ok(process.env.FAMSUN_CONTINUE_FROM, "Continuation requires a prior real run record");
      prior = JSON.parse(await readFile(path.resolve(process.env.FAMSUN_CONTINUE_FROM), "utf8"));
      record = prior;
      await openSession();
      record = undefined;
    } else {
      await page.goto(baseURL);
      await page.getByRole("button", { name: /新建对话/ }).click();
    }
    await page.getByLabel("发送给丰尚助手的消息").fill(prompt);
    await screenshot("01-submission.png");
    const responsePromise = page.waitForResponse(
      (response) =>
        /\/api\/sessions\/[^/]+\/runs$/.test(
          new URL(response.url()).pathname,
        ) && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 201, "Real UI creates the run");
    const run = await response.json();
    record = {
      scenario: "snake",
      title,
      prompt,
      submitted_at: new Date(started).toISOString(),
      run_id: run.id,
      session_id: run.session_id,
      base_url: baseURL,
      live_provider: true,
      continues_run_id: prior?.run_id,
    };
    await save("run.json", record);
    // Name the newly selected conversation through the real UI.
    await renameSession();
    console.log(
      `SUBMITTED ${JSON.stringify({ run_id: run.id, session_id: run.session_id })}`,
    );
  } else {
    await openSession();
    await renameSession();
    console.log(`RESUMING ${record.run_id}`);
  }
  let status;
  let progressCaptured = false;
  let lastLog = 0;
  const deadline =
    Date.now() + Number(process.env.FAMSUN_LIVE_TIMEOUT_MS || 20 * 60 * 1000);
  while (Date.now() < deadline) {
    status = await get(`/api/runs/${record.run_id}`);
    const events = await timeline(record.run_id);
    await save("events.json", events);
    await save("run-state.json", status);
    if (
      !progressCaptured &&
      events.some(
        (event) => event.type === "tool.started" || event.type === "text.delta",
      )
    ) {
      await screenshot("02-progress.png");
      progressCaptured = true;
    }
    if (Date.now() - lastLog > 15_000) {
      console.log(
        `PROGRESS ${status.status} events=${events.length} elapsed_s=${Math.round((Date.now() - Date.parse(record.submitted_at)) / 1000)}`,
      );
      lastLog = Date.now();
    }
    if (["completed", "failed", "cancelled"].includes(status.status)) break;
    await page.waitForTimeout(2500);
  }
  record.completed_at = new Date().toISOString();
  record.duration_seconds =
    (Date.now() - Date.parse(record.submitted_at)) / 1000;
  record.status = status?.status ?? "unknown";
  const detail = await get(`/api/sessions/${record.session_id}`);
  record.files = detail.files;
  record.answer = detail.messages
    .filter(
      (message) =>
        message.role === "assistant" && message.run_id === record.run_id,
    )
    .map((message) => message.content)
    .join("\n\n");
  record.browser_errors = browserErrors;
  await save("run.json", record);
  await save("session-detail.json", detail);
  await save("answer.md", record.answer);
  await page.reload();
  await page
    .locator(".session-select")
    .filter({ hasText: title })
    .first()
    .click();
  if (record.answer) await page.locator(".final-answer").waitFor();
  await screenshot("03-final.png");
  assert.equal(
    record.status,
    "completed",
    `Live generation ended with ${record.status}`,
  );
  const file =
    detail.files.find(
      (file) => file.kind === "output" && /snake.*\.html$/i.test(file.name),
    ) ??
    detail.files.find(
      (file) => file.kind === "output" && /\.html$/i.test(file.name),
    );
  assert.ok(file, "Model generated a real HTML artifact");
  record.artifact = file;
  const response = await context.request.get(file.url);
  assert.equal(response.status(), 200);
  const bytes = await response.body();
  await writeFile(path.join(output, "api-snake.html"), bytes);
  await page
    .getByRole("button", { name: `预览 ${file.name}`, exact: true })
    .first()
    .click();
  const iframe = page.getByRole("dialog").locator("iframe");
  await iframe.waitFor();
  const frame = await iframe
    .elementHandle()
    .then((handle) => handle.contentFrame());
  await frame.locator("body").waitFor();
  await frame.waitForFunction(() => document.body.innerText.trim().length > 0);
  const baseline = await frame.evaluate(() => ({
    scripts: document.scripts.length,
    buttons: document.querySelectorAll("button").length,
    inputs: document.querySelectorAll("input,select,textarea").length,
    canvases: document.querySelectorAll("canvas").length,
    body_text: document.body.innerText,
    canvas_hashes: [...document.querySelectorAll("canvas")].map((canvas) =>
      canvas.toDataURL(),
    ),
  }));
  baseline.iframe_sandbox = await iframe.getAttribute("sandbox");
  baseline.raw_script_count = (
    bytes.toString("utf8").match(/<script\b/gi) || []
  ).length;
  baseline.raw_button_count = (
    bytes.toString("utf8").match(/<button\b/gi) || []
  ).length;
  baseline.script_and_control_stripping_observed =
    baseline.raw_script_count > 0 &&
    baseline.scripts === 0 &&
    baseline.raw_button_count > baseline.buttons;
  await save("preview-at-completion.json", baseline);
  await screenshot("04-preview-at-completion.png");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "下载文件", exact: true })
    .click();
  const download = await downloadPromise;
  const downloadedPath = path.join(output, "downloaded-snake.html");
  await download.saveAs(downloadedPath);
  const downloaded = await readFile(downloadedPath);
  record.download = {
    suggested_filename: download.suggestedFilename(),
    bytes: downloaded.length,
    sha256: sha256(downloaded),
    api_sha256: sha256(bytes),
    identical_to_api: downloaded.equals(bytes),
    path: downloadedPath,
  };
  assert.ok(
    record.download.identical_to_api,
    "UI download matches authorized API bytes exactly",
  );
  await save("run.json", record);
  console.log(
    `ARTIFACT_READY ${JSON.stringify({ run_id: record.run_id, artifact_path: downloadedPath, file_name: file.name, baseline_stripping: baseline.script_and_control_stripping_observed, download_sha256: record.download.sha256 })}`,
  );
}

async function inspectDownloaded() {
  record ??= JSON.parse(await readFile(path.join(output, "run.json"), "utf8"));
  const gameFile = process.env.FAMSUN_GAME_FILE || "downloaded-snake.html";
  const bytes = await readFile(path.join(output, gameFile));
  const server = createServer((request, response) => {
    if (request.url === "/snake.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(bytes);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const artifactURL = `http://127.0.0.1:${server.address().port}/snake.html`;
  const offline = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
  });
  const remoteRequests = [];
  await offline.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(artifactURL).origin) return route.continue();
    remoteRequests.push(route.request().url());
    return route.abort();
  });
  const game = await offline.newPage();
  const gameErrors = [];
  game.on("pageerror", (error) => gameErrors.push(error.message));
  try {
    await game.goto(artifactURL);
    await game.screenshot({
      path: path.join(output, "05-downloaded-initial-desktop.png"),
      animations: "disabled",
      fullPage: true,
    });
    const observed = await game.evaluate(() => ({
      title: document.title,
      body_text: document.body.innerText,
      buttons: [...document.querySelectorAll("button")].map((button) => ({
        id: button.id,
        text: button.innerText,
        aria_label: button.getAttribute("aria-label"),
      })),
      canvases: [...document.querySelectorAll("canvas")].map((canvas) => ({
        id: canvas.id,
        width: canvas.width,
        height: canvas.height,
      })),
      scripts: document.scripts.length,
    }));
    observed.browser_errors = gameErrors;
    observed.remote_requests = remoteRequests;
    observed.source_file = gameFile;
    observed.source_sha256 = sha256(bytes);
    await save("downloaded-initial.json", observed);
    console.log(
      `DOWNLOADED_INSPECTED ${JSON.stringify({ title: observed.title, buttons: observed.buttons, errors: gameErrors, remote_requests: remoteRequests })}`,
    );
    if (mode === "play") {
      const results = { source_file: gameFile, source_sha256: sha256(bytes), remote_requests: remoteRequests, browser_errors: gameErrors };
      results.desktop = await playSnake({ target: game, page: game, screenshot: (name) => game.screenshot({ path: path.join(output, `standalone-desktop-${name}.png`), animations: "disabled", fullPage: true }) });
      await save("standalone-gameplay.json", results);
      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce", serviceWorkers: "block" });
      await mobile.route("**/*", (route) => new URL(route.request().url()).origin === new URL(artifactURL).origin ? route.continue() : route.abort());
      const mobilePage = await mobile.newPage();
      mobilePage.on("pageerror", (error) => gameErrors.push(error.message));
      try {
        await mobilePage.goto(artifactURL);
        results.mobile = await playSnake({ target: mobilePage, page: mobilePage, mobile: true, screenshot: (name) => mobilePage.screenshot({ path: path.join(output, `standalone-mobile-${name}.png`), animations: "disabled", fullPage: true }) });
        results.mobile.document_fits_viewport = await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
        assert.ok(results.mobile.document_fits_viewport);
        assert.deepEqual(gameErrors, []);
        assert.deepEqual(remoteRequests, []);
        await save("standalone-gameplay.json", results);
        console.log(`STANDALONE_GAMEPLAY_PASS ${JSON.stringify({ desktop_checks: results.desktop.checks.length, mobile_checks: results.mobile.checks.length, sha256: results.source_sha256 })}`);
      } finally { await mobile.close(); }
    }
  } finally {
    await offline.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function productPlay() {
  record = JSON.parse(await readFile(path.join(output, "run.json"), "utf8"));
  await openSession();
  const detail = await get(`/api/sessions/${record.session_id}`);
  const file = detail.files.find((file) => file.kind === "output" && /\.html$/i.test(file.name));
  assert.ok(file);
  const source = await (await context.request.get(file.url)).body();
  await page.getByRole("button", { name: `预览 ${file.name}`, exact: true }).first().click();
  const iframe = page.getByRole("dialog").locator("iframe");
  await iframe.waitFor();
  const frame = await iframe.elementHandle().then((handle) => handle.contentFrame());
  await frame.locator("#mainBtn").waitFor();
  const results = { source_sha256: sha256(source), iframe_sandbox: await iframe.getAttribute("sandbox"), browser_errors: browserErrors };
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("link", { name: "下载文件", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(path.join(output, "product-downloaded-snake.html"));
  const downloaded = await readFile(path.join(output, "product-downloaded-snake.html"));
  results.download = { bytes: downloaded.length, sha256: sha256(downloaded), identical_to_api: downloaded.equals(source) };
  assert.ok(results.download.identical_to_api);
  results.desktop = await playSnake({ target: frame, page, screenshot: (name) => screenshot(`product-desktop-${name}.png`) });
  await save("product-gameplay.json", results);
  await page.keyboard.press("Escape");
  const mobile = await browser.newContext({ baseURL, storageState, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const mobilePage = await mobile.newPage();
  const errors = [];
  mobilePage.on("pageerror", (error) => errors.push(error.message));
  try {
    await mobilePage.goto(baseURL);
    await mobilePage.getByRole("button", { name: "打开导航", exact: true }).click();
    await mobilePage.locator(".session-select").filter({ hasText: title }).first().click();
    await mobilePage.locator(".message-list").waitFor();
    // Open the current session's file via its final answer link if workspace is hidden.
    const preview = mobilePage.getByRole("button", { name: `预览 ${file.name}`, exact: true }).first();
    if (!(await preview.isVisible())) await mobilePage.locator(".workspace-toggle").click();
    await preview.click();
    const mobileIframe = mobilePage.getByRole("dialog").locator("iframe");
    await mobileIframe.waitFor();
    const mobileFrame = await mobileIframe.elementHandle().then((handle) => handle.contentFrame());
    await mobileFrame.locator("#mainBtn").waitFor();
    results.mobile = await playSnake({ target: mobileFrame, page: mobilePage, mobile: true, screenshot: (name) => mobilePage.screenshot({ path: path.join(output, `product-mobile-${name}.png`), animations: "disabled", fullPage: true }) });
    results.mobile.document_fits_viewport = await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    results.mobile.browser_errors = errors;
    assert.ok(results.mobile.document_fits_viewport);
    assert.deepEqual(errors, []);
    assert.deepEqual(browserErrors, []);
    await save("product-gameplay.json", results);
    console.log(`PRODUCT_GAMEPLAY_PASS ${JSON.stringify({ desktop_checks: results.desktop.checks.length, mobile_checks: results.mobile.checks.length, sha256: results.source_sha256 })}`);
  } finally { await mobile.close(); }
}

async function watchArtifact() {
  record = JSON.parse(await readFile(path.join(output, "run.json"), "utf8"));
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const detail = await get(`/api/sessions/${record.session_id}`);
    const file = detail.files.find((file) => file.kind === "output" && /\.html$/i.test(file.name));
    if (file) {
      const response = await context.request.get(file.url);
      assert.equal(response.status(), 200);
      const bytes = await response.body();
      const complete = /<script\b/i.test(bytes.toString("utf8")) && /<\/script>[\s\S]*<\/html>/i.test(bytes.toString("utf8"));
      if (mode !== "watch-complete" || complete) {
        const prefix = mode === "watch-complete" ? "early-complete" : "early";
        await writeFile(path.join(output, `${prefix}-snake.html`), bytes);
        await save(`${prefix}-artifact.json`, { captured_at: new Date().toISOString(), file, sha256: sha256(bytes), run_may_still_be_active: true });
        console.log(`EARLY_ARTIFACT_READY ${JSON.stringify({ file, complete, path: path.join(output, `${prefix}-snake.html`), sha256: sha256(bytes) })}`);
        return;
      }
    }
    const run = detail.runs.find((run) => run.id === record.run_id);
    if (["failed", "cancelled", "completed"].includes(run?.status)) throw new Error(`Run ${run.status} without an HTML artifact`);
    await page.waitForTimeout(3000);
  }
  throw new Error("Timed out waiting for the first real HTML artifact");
}

async function baselineOnly() {
  record = JSON.parse(await readFile(path.join(output, "run.json"), "utf8"));
  await openSession();
  const detail = await get(`/api/sessions/${record.session_id}`);
  const file = detail.files.find((file) => file.kind === "output" && /\.html$/i.test(file.name));
  assert.ok(file, "A real HTML artifact exists");
  const response = await context.request.get(file.url);
  const bytes = await response.body();
  await page.getByRole("button", { name: `预览 ${file.name}`, exact: true }).first().click();
  const iframe = page.getByRole("dialog").locator("iframe");
  await iframe.waitFor();
  const frame = await iframe.elementHandle().then((handle) => handle.contentFrame());
  await frame.waitForFunction(() => document.body?.innerText.trim().length > 0);
  const baseline = await frame.evaluate(() => ({
    scripts: document.scripts.length,
    buttons: document.querySelectorAll("button").length,
    body_text: document.body.innerText,
    canvases: [...document.querySelectorAll("canvas")].map((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let nontransparent = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) nontransparent++;
      return { width: canvas.width, height: canvas.height, nontransparent_pixels: nontransparent };
    }),
  }));
  baseline.origin = baseURL;
  baseline.iframe_sandbox = await iframe.getAttribute("sandbox");
  baseline.source_sha256 = sha256(bytes);
  baseline.raw_script_count = (bytes.toString("utf8").match(/<script\b/gi) || []).length;
  baseline.raw_button_count = (bytes.toString("utf8").match(/<button\b/gi) || []).length;
  baseline.script_and_control_stripping_observed = baseline.raw_script_count > baseline.scripts && baseline.raw_button_count > baseline.buttons;
  await screenshot("04-original-build-preview-baseline.png");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("link", { name: "下载文件", exact: true }).click();
  const download = await downloadPromise;
  const filename = path.join(output, "baseline-downloaded-snake.html");
  await download.saveAs(filename);
  const downloaded = await readFile(filename);
  baseline.download = { filename: download.suggestedFilename(), bytes: downloaded.length, sha256: sha256(downloaded), identical_to_api: downloaded.equals(bytes) };
  assert.ok(baseline.download.identical_to_api);
  await save("original-build-preview-baseline.json", baseline);
  console.log(`BASELINE_CONFIRMED ${JSON.stringify(baseline)}`);
}

try {
  if (mode === "generate" || mode === "continue") {
    await generate();
    await inspectDownloaded();
  } else if (mode === "inspect" || mode === "play") await inspectDownloaded();
  else if (mode === "product-play") await productPlay();
  else if (mode === "watch-artifact" || mode === "watch-complete") await watchArtifact();
  else if (mode === "baseline") await baselineOnly();
  else throw new Error(`Unknown mode ${mode}; use generate or inspect`);
} catch (error) {
  await save(mode === "generate" ? "failure.json" : `failure-${mode}.json`, {
    at: new Date().toISOString(),
    mode,
    message: safeError(error),
    browser_errors: browserErrors,
  });
  await screenshot("failure.png").catch(() => {});
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  await browser.close();
}
