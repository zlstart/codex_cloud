import { safeError } from "./acceptance-safe-error.mjs";
// Live disposable-deployment acceptance: no API/model mocks or injected UI state.
// Default is read-only resource authorization/download checks (plus a member signup).
// Cancellation is a separate opt-in so it never competes with artifact generation.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { chromium } from "playwright";

assert.equal(process.env.FAMSUN_DISPOSABLE_DEPLOYMENT, "1", "Requires disposable deployment opt-in");
const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8000";
assert.ok(new URL(baseURL).hostname === "127.0.0.1" || new URL(baseURL).hostname === "localhost", "Disposable local server only");
const phase = process.env.FAMSUN_RESILIENCE_PHASE || "security";
assert.ok(["security", "cancellation"].includes(phase));
if (phase === "cancellation") assert.equal(process.env.FAMSUN_LIVE_CANCEL_READY, "1", "Wait for explicit sandbox/slot readiness before cancellation workload");
const output = resolve(process.env.FAMSUN_TEST_OUTPUT || "../test-results/production-acceptance-2026-11-03/resilience");
const adminState = "/tmp/famsun-acceptance-admin.json";
const memberState = "/tmp/famsun-acceptance-member.json";
const runCommand = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { phase, started_at: new Date().toISOString(), base_url: baseURL, checks: [], downloads: [], browser_errors: [], failures: [], live_model_mocked: false };
await mkdir(`${output}/downloads`, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
const admin = await browser.newContext({ baseURL, storageState: phase === "cancellation" ? memberState : adminState, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await admin.newPage();
page.on("pageerror", error => report.browser_errors.push(safeError(error)));
const check = (name, evidence = {}) => { report.checks.push({ name, ...evidence }); console.log(`PASS: ${name}`); };
async function json(request, path) {
  const response = await request.get(path);
  assert.equal(response.status(), 200, `GET ${path}`);
  return response.json();
}
async function persist() {
  report.finished_at = new Date().toISOString();
  report.archived_evidence = `${phase}-attempt-${report.started_at.replace(/[:.]/g, "-")}`;
  await writeFile(`${output}/${phase}.json`, JSON.stringify(report, null, 2));
  const archive = `${output}/${report.archived_evidence}`;
  await mkdir(archive, { recursive: true });
  for (const name of await readdir(output)) {
    const eligible = name === `${phase}.json` || /\.(png|json)$/.test(name) &&
      (phase === "cancellation" ? name.startsWith("cancellation-") : /^(security-|member-|owner-)/.test(name));
    if (eligible && (await stat(`${output}/${name}`)).mtimeMs >= Date.parse(report.started_at)) {
      await copyFile(`${output}/${name}`, `${archive}/${name}`);
    }
  }
}
async function containers(sessionId) {
  const { stdout } = await runCommand("docker", ["ps", "-aq", "--filter", `label=famsun.chat=${sessionId}`], { timeout: 10_000 });
  return stdout.trim().split(/\s+/).filter(Boolean);
}
async function timeline(runId) {
  let after = 0;
  const events = [];
  for (;;) {
    const data = await json(admin.request, `/api/runs/${runId}/timeline?after=${after}&limit=1000`);
    events.push(...data.events);
    if (!data.has_more) return events;
    after = data.next_cursor;
  }
}
try {
  const me = await json(admin.request, "/api/auth/me");
  assert.equal(me.role, phase === "cancellation" ? "member" : "admin");
  if (phase === "security") {
    let member;
    try { await access(memberState); member = await browser.newContext({ baseURL, storageState: memberState, viewport: { width: 1440, height: 1000 } }); }
    catch { member = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } }); }
    if ((await member.request.get("/api/auth/me")).status() !== 200) {
      const response = await member.request.post("/api/auth/register", { data: { email: `resilience-${randomUUID().slice(0, 8)}@example.test`, password: randomUUID(), name: "隔离验收成员" } });
      assert.equal(response.status(), 201, "Disposable second member registration");
      assert.equal((await response.json()).role, "member");
      await member.storageState({ path: memberState });
      await chmod(memberState, 0o600);
    }
    assert.notEqual((await json(member.request, "/api/auth/me")).id, me.id);
    const anonymous = await browser.newContext({ baseURL });
    const sessions = await json(admin.request, "/api/sessions");
    const allFiles = await json(admin.request, "/api/files");
    const targets = process.env.FAMSUN_ACCEPTANCE_TARGETS ? JSON.parse(await readFile(process.env.FAMSUN_ACCEPTANCE_TARGETS, "utf8")) : null;
    const files = targets?.file_ids ? allFiles.filter(file => targets.file_ids.includes(file.id)) : allFiles;
    assert.ok(files.length, "Wait for real generated/uploaded artifacts before security acceptance");
    const sessionIds = targets?.session_ids || [...new Set(files.map(file => file.session_id))];
    const runIds = [];
    for (const sessionId of sessionIds) {
      const detail = await json(admin.request, `/api/sessions/${sessionId}`);
      runIds.push(...detail.runs.map(run => run.id));
    }
    if (targets?.run_ids) runIds.splice(0, runIds.length, ...targets.run_ids);
    report.resources = { sessions: sessionIds, runs: [...new Set(runIds)], files: files.map(({ id, name, kind, session_id }) => ({ id, name, kind, session_id })) };
    const memberSessions = await json(member.request, "/api/sessions");
    const memberFiles = await json(member.request, "/api/files");
    assert.equal(memberSessions.some(session => sessions.some(owner => owner.id === session.id)), false);
    assert.equal(memberFiles.some(file => allFiles.some(owner => owner.id === file.id)), false);
    check("Second real account lists contain no owner conversations or files", { member_sessions: memberSessions.length, member_files: memberFiles.length });
    const endpoints = [...sessionIds.map(id => `/api/sessions/${id}`), ...files.flatMap(file => [file.url, `${file.url}?download=true`, `/api/files/${file.id}/preview`]), ...[...new Set(runIds)].flatMap(id => [`/api/runs/${id}`, `/api/runs/${id}/timeline`, `/api/runs/${id}/events`])];
    for (const [context, expected, identity] of [[anonymous, 401, "anonymous"], [member, 404, "other member"]]) {
      for (const endpoint of endpoints) {
        const response = await context.request.get(endpoint, { timeout: 15_000 });
        assert.equal(response.status(), expected, `${identity} GET ${endpoint}`);
        report.checks.push({ name: `${identity} resource denied`, endpoint, status: response.status() });
      }
      console.log(`PASS: ${identity} denied on ${endpoints.length} actual content/download/preview/session/run/timeline/SSE endpoints`);
    }
    const memberPage = await member.newPage();
    memberPage.on("pageerror", error => report.browser_errors.push(safeError(error)));
    await memberPage.goto("/");
    await memberPage.getByRole("button", { name: "文件空间", exact: true }).click();
    await memberPage.locator(".files-view .empty-state").waitFor();
    await memberPage.screenshot({ path: `${output}/member-empty-files.png`, animations: "disabled" });
    await memberPage.goto(files[0].url);
    assert.match(await memberPage.locator("body").innerText(), /文件不存在|无权|不存在/);
    await memberPage.screenshot({ path: `${output}/member-forbidden-content.png`, animations: "disabled" });
    check("Browser member cannot see owner files or open a known content URL");

    await page.goto("/");
    await page.getByRole("button", { name: "文件空间", exact: true }).click();
    const sources = page.getByRole("group", { name: "文件来源", exact: true });
    await sources.getByRole("button", { name: "已上传", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.file-table-row .file-kind')].every(node => node.textContent === '已上传'));
    assert.equal(await page.locator('.file-table-row').count(), allFiles.filter(file => file.kind === 'upload').length);
    await page.screenshot({ path: `${output}/owner-uploaded-filter.png`, animations: "disabled" });
    await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('2026年10月生产明细');
    assert.equal(await page.locator('.file-table-row').count(), allFiles.filter(file => file.kind === 'upload' && file.name.includes('2026年10月生产明细')).length);
    await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('');
    await sources.getByRole("button", { name: "生成成果", exact: true }).click();
    assert.equal(await page.locator('.file-table-row').count(), allFiles.filter(file => file.kind === 'output').length);
    await page.screenshot({ path: `${output}/owner-generated-filter.png`, animations: "disabled" });
    await sources.getByRole("button", { name: "全部文件", exact: true }).click();
    check("Uploaded/generated filters and combined filename search match actual owner files");
    for (const file of files) {
      const response = await admin.request.get(`${file.url}?download=true`);
      assert.equal(response.status(), 200, `Owner download ${file.name}`);
      assert.match(response.headers()["content-disposition"], /attachment/);
      const bytes = await response.body();
      assert.equal(bytes.length, file.size, `Stored length ${file.name}`);
      const link = page.locator(`a[href="${file.url}?download=true"]`);
      await link.waitFor();
      const pending = page.waitForEvent("download");
      await link.click();
      const download = await pending;
      assert.equal(await download.failure(), null);
      assert.equal(download.suggestedFilename(), file.name);
      const destination = `${output}/downloads/${file.id}-${basename(file.name)}`;
      await download.saveAs(destination);
      const browserBytes = await readFile(destination);
      assert.equal(sha256(browserBytes), sha256(bytes), `Browser/API exact SHA256 ${file.name}`);
      const evidence = { file_id: file.id, name: file.name, kind: file.kind, bytes: bytes.length, sha256: sha256(bytes), browser_sha256: sha256(browserBytes), browser_filename: download.suggestedFilename() };
      if (file.kind === "upload") {
        try {
          const original = await readFile(resolve(output, "../inputs", basename(file.name)));
          assert.equal(sha256(original), sha256(bytes), `Original upload exact SHA256 ${file.name}`);
          evidence.original_upload_sha256 = sha256(original);
        } catch (error) { if (error.code !== "ENOENT") throw new Error(safeError(error)); }
      }
      report.downloads.push(evidence);
      console.log(`PASS: real browser download and exact SHA256 ${file.name}`);
    }
    await page.screenshot({ path: `${output}/owner-files-downloads.png`, animations: "disabled" });
    check("All selected owner files download with exact browser/API bytes", { count: files.length });
    assert.deepEqual(report.browser_errors, []);
  } else {
    const created = await admin.request.post("/api/sessions", { data: { title: `生产验收｜取消与恢复 ${randomUUID().slice(0, 6)}` } });
    assert.equal(created.status(), 201);
    const session = await created.json();
    report.session_id = session.id;
    await page.goto("/");
    await page.locator(".session-select").filter({ hasText: session.title }).click();
    const prompt = "现在执行取消恢复验收。请立即调用 exec_command 执行命令 python -c \"import time; print('CANCEL_ACCEPTANCE_STARTED', flush=True); time.sleep(120); print('CANCEL_ACCEPTANCE_FINISHED')\"，yield_time_ms 1000；然后用 write_stdin 等待完成。不要创建文件，不要替换这条命令，不要提前宣布完成。";
    await page.getByRole("textbox", { name: "发送给丰尚助手的消息" }).fill(prompt);
    const launched = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${session.id}/runs`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const launchedResponse = await launched;
    assert.equal(launchedResponse.status(), 201);
    const run = await launchedResponse.json();
    report.run_id = run.id;
    let observed = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const current = await json(admin.request, `/api/runs/${run.id}`);
      assert.ok(!["completed", "failed", "cancelled"].includes(current.status), `Run ended before real sleep was observed: ${current.status}`);
      const events = await timeline(run.id);
      const tool = events.find(event => event.type === "tool.started" && JSON.stringify(event.data.arguments).includes("time.sleep(120)"));
      if (tool) {
        const ids = await containers(session.id);
        for (const id of ids) {
          const { stdout } = await runCommand("docker", ["top", id, "-eo", "pid,args"], { timeout: 10_000 });
          if (stdout.split("\n").some(line => /python(?:3)? -c/.test(line) && line.includes("time.sleep(120)"))) {
            observed = { container_id: id, observed_at: new Date().toISOString(), tool_call_id: tool.data.call_id, command: "python -c … time.sleep(120) …", process_confirmed: true };
            break;
          }
        }
      }
      if (observed) break;
      await delay(1000);
    }
    assert.ok(observed, "Actual model tool call and sleeping Python process must be observed before cancellation");
    report.observed_process = observed;
    check("Actual live model started the requested long command in its session container", observed);
    const toolDetails = page.locator("details.timeline-tool");
    for (let index = 0; index < await toolDetails.count(); index++) {
      const detail = toolDetails.nth(index);
      if (await detail.getAttribute("open") === null) await detail.locator(":scope > summary").click();
    }
    await page.screenshot({ path: `${output}/cancellation-running.png`, animations: "disabled" });
    const before = Date.now();
    const cancelled = page.waitForResponse(response => response.url().endsWith(`/api/runs/${run.id}/cancel`) && response.request().method() === "POST", { timeout: 45_000 });
    await page.getByRole("button", { name: "停止生成", exact: true }).click();
    const stopping = page.getByRole("button", { name: "正在停止", exact: true });
    await stopping.waitFor();
    assert.equal(await stopping.isDisabled(), true, "Pending cancellation prevents repeat requests");
    await page.screenshot({ path: `${output}/cancellation-stopping.png`, animations: "disabled" });
    assert.equal((await cancelled).status(), 200);
    const ended = await json(admin.request, `/api/runs/${run.id}`);
    assert.equal(ended.status, "cancelled");
    const remaining = await containers(session.id);
    assert.deepEqual(remaining, [], "Cancel response must await sandbox container removal");
    const cancelMs = Date.now() - before;
    report.cancellation = { elapsed_ms: cancelMs, status: ended.status, remaining_containers: remaining };
    assert.ok(cancelMs < 30_000, `Cancellation should promptly clean up: ${cancelMs}ms`);
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "发送给丰尚助手的消息" }).fill("取消后输入恢复验收，不发送。");
    assert.equal(await page.getByRole("button", { name: "发送消息", exact: true }).isEnabled(), true);
    assert.equal(await page.locator(".composer").getByRole("button", { name: "上传文件", exact: true }).isEnabled(), true);
    const finalEvents = await timeline(run.id);
    assert.ok(finalEvents.some(event => event.type === "run.cancelled"));
    await writeFile(`${output}/cancellation-events.json`, JSON.stringify(finalEvents, null, 2));
    await page.screenshot({ path: `${output}/cancellation-recovered.png`, animations: "disabled" });
    await page.reload();
    await page.locator(".session-select").filter({ hasText: session.title }).click();
    await page.getByText("已停止", { exact: true }).first().waitFor();
    assert.equal((await json(admin.request, `/api/runs/${run.id}`)).status, "cancelled");
    await page.screenshot({ path: `${output}/cancellation-replayed.png`, animations: "disabled" });
    check("Browser stop promptly cancels the live run, removes its container, and restores composer/upload", report.cancellation);
    assert.deepEqual(report.browser_errors, []);
  }
} catch (error) {
  report.failures.push({ name: error.name, message: safeError(error) });
  if (phase === "cancellation" && report.run_id) {
    try {
      const current = await json(admin.request, `/api/runs/${report.run_id}`);
      if (!["completed", "failed", "cancelled"].includes(current.status)) {
        const stopped = await admin.request.post(`/api/runs/${report.run_id}/cancel`, { timeout: 45_000 });
        report.failure_cleanup = { cancel_status: stopped.status(), remaining_containers: await containers(report.session_id) };
      }
    } catch (cleanupError) {
      report.failure_cleanup = { error: safeError(cleanupError) };
    }
  }
  await page.screenshot({ path: `${output}/${phase}-failure.png`, animations: "disabled" }).catch(() => {});
  throw new Error(safeError(error));
} finally {
  await persist();
  await browser.close();
}
