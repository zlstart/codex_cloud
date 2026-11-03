import { safeError } from "./acceptance-safe-error.mjs";
// Production acceptance through the real UI and configured provider. No mocks.
// Never upload prompts.json or expected-results.json; never modify model outputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8000";
const root = path.resolve("../test-results/production-acceptance-2026-11-03");
const output = path.join(root, "analysis");
const mode = process.argv[2] || "generate";
const label = process.argv[3] || (mode === "generate" ? "baseline" : "recheck");
const title = "生产验收·经营分析与五格式报告";
const prompts = JSON.parse(await readFile(path.join(root, "inputs/prompts.json"), "utf8"));
const uploadNames = ["2026年10月生产明细.csv", "2026年10月经营补充.xlsx"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(path.join(output, "screenshots"), { recursive: true });
await mkdir(path.join(output, "downloads"), { recursive: true });
async function save(name, value) {
  const target = path.join(output, name);
  await writeFile(`${target}.tmp`, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  await rename(`${target}.tmp`, target);
}
let report;
try { report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8")); }
catch { report = { scenario: "analysis-and-five-formats", title, base_url: baseURL, live_provider: true, started_at: new Date().toISOString(), runs: [], previews: [], browser_errors: [] }; }
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext({ baseURL, storageState: "/tmp/famsun-acceptance-admin.json", acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("pageerror", error => report.browser_errors.push(safeError(error)));
const screenshot = (name) => page.screenshot({ path: path.join(output, "screenshots", `${label}-${name}.png`), animations: "disabled", fullPage: true });
async function get(url) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { response = await context.request.get(url); break; }
    catch (error) {
      if (attempt === 2 || !/ECONNRESET|ECONNREFUSED|Timeout|socket hang up/.test(safeError(error))) throw new Error(safeError(error));
      await page.waitForTimeout(1000 * (attempt + 1));
    }
  }
  assert.equal(response.status(), 200, `Authenticated GET ${url}`);
  return response.json();
}
async function persist() { report.updated_at = new Date().toISOString(); await save("report.json", report); }
async function events(runId) {
  let after = 0;
  const all = [];
  for (;;) {
    const data = await get(`/api/runs/${runId}/timeline?after=${after}&limit=1000`);
    all.push(...data.events);
    if (!data.has_more) break;
    assert.ok(data.next_cursor > after, "Timeline cursor advances");
    after = data.next_cursor;
  }
  assert.ok(all.every((event, index) => index === 0 || event.sequence > all[index - 1].sequence), "Timeline is ordered without duplicates");
  return all;
}
async function openSession() {
  await page.goto("/");
  const detail = await get(`/api/sessions/${report.session_id}`);
  await page.locator(".session-select").filter({ hasText: detail.session.title }).first().click();
  await page.getByLabel("发送给丰尚助手的消息").waitFor();
  if (detail.session.title !== title) await renameSession();
  report.uploads = detail.files.filter(file => file.kind === "upload");
}
async function renameSession() {
  await page.locator(".session-row.selected").hover();
  await page.locator(".session-row.selected .session-more").click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.getByLabel("对话名称", { exact: true }).fill(title);
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
}
async function createAndUpload() {
  await page.goto("/");
  await page.getByRole("button", { name: /新建对话/ }).click();
  const creation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/sessions" && response.request().method() === "POST");
  await page.locator('.composer input[type="file"]').setInputFiles(uploadNames.map(name => path.join(root, "inputs", name)));
  const created = await creation;
  assert.equal(created.status(), 201);
  const session = await created.json();
  report.session_id = session.id;
  await page.getByText("已上传 2 个文件，可以开始提问了。", { exact: true }).waitFor();
  await renameSession();
  const detail = await get(`/api/sessions/${report.session_id}`);
  report.uploads = detail.files.filter(file => file.kind === "upload");
  assert.deepEqual(report.uploads.map(file => file.name).sort(), [...uploadNames].sort());
  await screenshot("00-uploaded-inputs");
  await persist();
  for (const file of report.uploads) await preview(file, `upload-${path.extname(file.name).slice(1)}`, false);
}
async function submit(stage, prompt) {
  await save(`${stage}-prompt.txt`, prompt);
  let run = report.runs.findLast(item => item.stage === stage && !item.superseded);
  if (!run) {
    const settings = await get('/api/settings');
    await page.getByLabel("发送给丰尚助手的消息").fill(prompt);
    const responsePromise = page.waitForResponse(response => /\/api\/sessions\/[^/]+\/runs$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
    const submitted = Date.now();
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 201, "Real UI submitted the run");
    const result = await response.json();
    run = { stage, attempt: report.runs.filter(item => item.stage === stage).length + 1, run_id: result.id, session_id: result.session_id, ui_base_url: baseURL, submitted_at: new Date(submitted).toISOString(), prompt, status: result.status, model: settings.provider.model, api_mode: settings.provider.api_mode, limits: settings.limits, runtime_timeout_seconds: settings.limits.max_runtime_seconds ?? Number(process.env.FAMSUN_ACCEPTANCE_RUNTIME_SECONDS || 300) };
    report.runs.push(run);
    await persist();
    console.log(`SUBMITTED ${JSON.stringify({ stage, run_id: run.run_id, session_id: run.session_id })}`);
  }
  if (run.status === "completed") return;
  assert.ok(!["failed", "cancelled"].includes(run.status), `Previous ${stage} ended ${run.status}; consult root before another attempt`);
  const deadline = Date.now() + Number(process.env.FAMSUN_ACCEPTANCE_POLL_TIMEOUT_MS || ((run.runtime_timeout_seconds || 300) + 120) * 1000);
  let lastLog = 0, captured = false;
  while (Date.now() < deadline) {
    const state = await get(`/api/runs/${run.run_id}`);
    const timeline = await events(run.run_id);
    run.status = state.status;
    run.error = state.error;
    run.event_count = timeline.length;
    await save(`${stage}-events.json`, timeline);
    await save(`${stage}-run-state.json`, state);
    await persist();
    if (!captured && timeline.some(event => event.type === "tool.started")) {
      await screenshot(`${stage}-progress`);
      captured = true;
    }
    if (Date.now() - lastLog >= 15000) {
      console.log(`PROGRESS ${stage} ${run.status} events=${timeline.length} elapsed_s=${Math.round((Date.now() - Date.parse(run.submitted_at)) / 1000)}`);
      lastLog = Date.now();
    }
    if (["completed", "failed", "cancelled"].includes(run.status)) break;
    await page.waitForTimeout(2500);
  }
  const detail = await get(`/api/sessions/${report.session_id}`);
  run.finished_at = new Date().toISOString();
  run.duration_seconds = (Date.now() - Date.parse(run.submitted_at)) / 1000;
  run.answer = detail.messages.filter(message => message.role === "assistant" && message.run_id === run.run_id).map(message => message.content).join("\n\n");
  run.files = detail.files;
  report.files = detail.files;
  await save(`${stage}-answer.md`, run.answer);
  await save(`${stage}-session.json`, detail);
  await page.waitForTimeout(400);
  await screenshot(`${stage}-final`);
  await persist();
  console.log(`FINISHED ${JSON.stringify({ stage, status: run.status, seconds: run.duration_seconds, file_count: detail.files.length })}`);
  assert.equal(run.status, "completed", `${stage} ended ${run.status}: ${run.error || "unknown failure"}`);
}
async function preview(file, name, download = true) {
  const result = { label, ui_base_url: baseURL, file_id: file.id, file_name: file.name, kind: file.kind, started_at: new Date().toISOString() };
  try {
    // Full-canvas screenshots may temporarily resize Chromium and close its responsive panel.
    // Enter through the actual workspace control for each file, independent of older message cards.
    const workspaceToggle = page.locator('.workspace-toggle');
    if (!/\bactive\b/.test(await workspaceToggle.getAttribute('class') || '')) await workspaceToggle.click();
    await page.getByRole("button", { name: `预览 ${file.name}`, exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('.preview-body')?.getAttribute('aria-busy') === 'false', undefined, { timeout: 30000 });
    const ext = path.extname(file.name).toLowerCase();
    if (ext === ".pdf") {
      await dialog.locator('.pdf-toolbar').waitFor({ timeout: 30000 });
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.pdf-preview canvas');
        return document.querySelector('.pdf-preview [role="alert"]') || (canvas?.width > 0 && !document.querySelector('.pdf-busy'));
      }, undefined, { timeout: 30000 });
    }
    result.preview_kind = await dialog.locator('.preview-body').getAttribute('class');
    result.visible_text = await dialog.innerText();
    result.alerts = await dialog.getByRole('alert').allTextContents();
    result.format_notices = await dialog.locator('.preview-notice').allTextContents();
    result.limitation = /此格式可下载后|原始排版、图片与图表请下载|暂时无法预览|无法打开 PDF|无法渲染/.test(result.visible_text);
    result.sheet_tabs = await dialog.getByRole('tablist', { name: '工作表', exact: true }).getByRole('tab').allTextContents();
    result.sheets = [];
    for (const tab of await dialog.getByRole('tablist', { name: '工作表', exact: true }).getByRole('tab').all()) {
      await tab.click();
      result.sheets.push({ name: await tab.innerText(), visible_text: await dialog.locator('.spreadsheet-preview').innerText() });
      await screenshot(`preview-${name}-sheet-${result.sheets.length}`);
      const leakedFormula = dialog.getByRole('cell').filter({ hasText: '=IF(AND(' }).first();
      if (await leakedFormula.count()) {
        await leakedFormula.scrollIntoViewIfNeeded();
        result.sheets.at(-1).formula_text_visible = true;
        await screenshot(`preview-${name}-formula-cache-defect`);
      }
    }
    if (ext === '.pptx' && await dialog.locator('.presentation-slide').count()) {
      result.ppt_slides = [];
      for (let index = 0; index < 30; index++) {
        const slide = dialog.locator('.presentation-slide');
        result.ppt_slides.push({ page: await dialog.locator('.presentation-toolbar').innerText(), text: await slide.textContent(), images: await slide.locator('image').count(), box: await slide.boundingBox(), content_overflows: await slide.locator('.slide-text,.slide-table-container').evaluateAll(nodes => nodes.filter(node => node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2).map(node => ({ text: node.textContent, width: node.clientWidth, height: node.clientHeight, content_width: node.scrollWidth, content_height: node.scrollHeight }))) });
        await screenshot(`preview-${name}-slide-${index + 1}`);
        const next = dialog.getByRole('button', { name: '下一张幻灯片', exact: true });
        if (await next.isDisabled()) break;
        await next.click();
      }
    }
    if (ext === '.docx' && await dialog.locator('.document-page').count()) {
      result.document = { tables: await dialog.locator('.document-table').count(), images: [] };
      for (const [index, image] of (await dialog.locator('.document-page img').all()).entries()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(node => node.decode());
        result.document.images.push(await image.evaluate(node => ({ loaded: node.complete && node.naturalWidth > 0, width: node.naturalWidth, height: node.naturalHeight })));
        await screenshot(`preview-${name}-image-${index + 1}`);
      }
      await dialog.locator('.document-preview').evaluate(node => node.scrollTop = 0);
    }
    const iframe = dialog.locator('iframe');
    if (await iframe.count()) {
      const frame = await (await iframe.elementHandle()).contentFrame();
      await frame.locator('body').waitFor();
      await frame.evaluate(() => Promise.allSettled([...document.images].map(image => image.decode())));
      result.html = await frame.evaluate(() => ({
        body_text: document.body.innerText,
        scripts: document.scripts.length,
        tables: document.querySelectorAll('table').length,
        images: [...document.images].map(img => ({ loaded: img.complete && img.naturalWidth > 0, width: img.naturalWidth, height: img.naturalHeight })),
        canvases: document.querySelectorAll('canvas').length,
      }));
      result.html.sandbox = await iframe.getAttribute('sandbox');
    }
    await screenshot(`preview-${name}`);
    result.screenshot = `screenshots/${label}-preview-${name}.png`;
    if (ext === '.pdf' && await dialog.locator('.pdf-preview canvas').count()) {
      result.pdf_pages = [];
      for (let index = 0; index < 30; index++) {
        result.pdf_pages.push({ page: await dialog.locator('.pdf-toolbar').innerText(), canvas: await dialog.locator('canvas').evaluate(node => ({ width: node.width, height: node.height })), alerts: await dialog.getByRole('alert').allTextContents() });
        await screenshot(`preview-${name}-page-${index + 1}`);
        // Save the actual PDF.js canvas pixels without temporarily resizing the viewport.
        const canvasPng = await dialog.locator('.pdf-preview canvas').evaluate(node => node.toDataURL('image/png').split(',')[1]);
        await writeFile(path.join(output, 'screenshots', `${label}-pdf-canvas-page-${index + 1}.png`), Buffer.from(canvasPng, 'base64'));
        const next = dialog.getByRole('button', { name: '下一页 PDF', exact: true });
        if (await next.isDisabled()) break;
        await next.click();
        await page.waitForTimeout(100);
        await page.waitForFunction(() => !document.querySelector('.pdf-busy'), undefined, { timeout: 30000 });
      }
    }
    if (result.limitation || result.alerts.length || result.html?.images.some(image => !image.loaded)) console.log(`PREVIEW_ISSUE ${JSON.stringify({ file: file.name, kind: result.preview_kind, alerts: result.alerts, limitation: result.limitation })}`);
  } catch (error) {
    result.error = safeError(error);
    await screenshot(`preview-${name}-failure`).catch(() => {});
    console.log(`PREVIEW_FAILURE ${JSON.stringify({ file: file.name, error: safeError(error) })}`);
  } finally {
    // Download remains independently testable even when visual preview fails.
    if (download && await page.getByRole('dialog').isVisible()) {
      try {
        const dialog = page.getByRole('dialog');
          const downloadPromise = page.waitForEvent('download');
          await dialog.getByRole('link', { name: '下载文件', exact: true }).click();
          const downloaded = await downloadPromise;
          const filename = path.basename(file.name);
          const localPath = path.join(output, 'downloads', filename);
          await downloaded.saveAs(localPath);
          const bytes = await readFile(localPath);
          const response = await context.request.get(file.url);
          assert.equal(response.status(), 200);
          const apiBytes = await response.body();
          result.download = { path: localPath, suggested_filename: downloaded.suggestedFilename(), bytes: bytes.length, sha256: sha256(bytes), api_sha256: sha256(apiBytes), identical_to_api: bytes.equals(apiBytes), matches_metadata_size: bytes.length === file.size, mime_type: response.headers()['content-type'] };
          assert.ok(result.download.identical_to_api && result.download.matches_metadata_size, 'Real UI download matches authorized bytes and file metadata');
      } catch (error) {
        result.download_error = safeError(error);
      }
    }
    result.finished_at = new Date().toISOString();
    report.previews.push(result);
    await persist();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
}
async function verifyOutputs() {
  await openSession();
  const detail = await get(`/api/sessions/${report.session_id}`);
  report.files = detail.files;
  const priority = ['.pptx', '.docx', '.html', '.pdf', '.xlsx'];
  const order = file => { const index = priority.indexOf(path.extname(file.name).toLowerCase()); return index < 0 ? 100 : index; };
  const files = detail.files.filter(file => file.kind === 'output').sort((a, b) => order(a) - order(b));
  report.requested_formats = Object.fromEntries(['.html', '.xlsx', '.docx', '.pdf', '.pptx'].map(ext => [ext, files.filter(file => path.extname(file.name).toLowerCase() === ext).map(file => file.id)]));
  await persist();
  for (const [index, file] of files.entries()) await preview(file, `output-${index + 1}-${path.extname(file.name).slice(1)}`);
  report.downloads = report.previews.filter(item => item.label === label && item.kind === 'output').map(item => ({ file_id: item.file_id, file_name: item.file_name, ...item.download, error: item.error }));
  const checks = report.previews.filter(item => item.label === label && item.kind === 'output');
  report.final_preview_label = label;
  report.requested_formats_complete = Object.values(report.requested_formats).every(ids => ids.length > 0);
  report.download_checks_passed = files.length > 0 && checks.length === files.length && checks.every(item => item.download?.identical_to_api && item.download?.matches_metadata_size && !item.download_error);
  report.preview_issues = checks.filter(item => item.error || item.alerts?.length || item.limitation || item.html?.images.some(image => !image.loaded) || item.pdf_pages?.some(page => page.alerts.length) || item.ppt_slides?.some(slide => slide.content_overflows?.length)).map(item => ({ file_name: item.file_name, error: item.error, alerts: item.alerts, limitation: item.limitation, broken_html_images: item.html?.images.filter(image => !image.loaded).length, pdf_page_errors: item.pdf_pages?.filter(page => page.alerts.length), slide_overflows: item.ppt_slides?.filter(slide => slide.content_overflows?.length) }));
  report.completed_at = new Date().toISOString();
  await persist();
  console.log(`PREVIEWS_RECORDED ${JSON.stringify({ files: files.length, formats: Object.fromEntries(Object.entries(report.requested_formats).map(([ext, ids]) => [ext, ids.length])), previews: checks.length, download_checks_passed: report.download_checks_passed, preview_issues: report.preview_issues.length })}`);
}
async function requireAnalysisVerified() {
  const latest = report.runs.findLast(item => item.stage.startsWith('correction') && !item.superseded)
    || report.runs.findLast(item => item.stage === 'analysis' && !item.superseded);
  const verification = JSON.parse(await readFile(path.join(output, `${latest.stage}-verification.json`), 'utf8'));
  assert.equal(verification.run_id, latest.run_id, 'Verification must cover the latest analysis/correction run');
  assert.equal(verification.overall_analysis_pass, true, 'Independent business-quality review must pass before deliverables');
}
try {
  if (mode === 'retry-analysis' || mode === 'retry-deliverables') {
    // This mode is invoked only after the parent authorizes a new live attempt.
    const retryStage = mode === 'retry-analysis' ? 'analysis' : 'deliverables';
    const previous = report.runs.findLast(item => item.stage === retryStage && !item.superseded);
    assert.ok(previous && ['failed', 'cancelled'].includes(previous.status), 'Only an explicitly failed analysis can be retried');
    const archive = path.join(output, `${retryStage}-attempt-${previous.attempt || 1}`);
    await mkdir(archive, { recursive: true });
    for (const name of [`${retryStage}-events.json`, `${retryStage}-run-state.json`, `${retryStage}-answer.md`, `${retryStage}-session.json`, 'report.json']) {
      await copyFile(path.join(output, name), path.join(archive, name));
    }
    previous.superseded = true;
    previous.evidence_directory = archive;
    if (report.failure) (report.failed_attempts ??= []).push(report.failure);
    delete report.failure;
    await persist();
  }
  if (mode === 'generate' || mode === 'retry-analysis') {
    if (!report.session_id) await createAndUpload(); else {
      await openSession();
      if (!report.runs.length && report.failure) {
        (report.harness_errors ??= []).push(report.failure);
        delete report.failure;
      }
      if (!report.previews.length) for (const file of report.uploads) await preview(file, `upload-${path.extname(file.name).slice(1)}`, false);
    }
    await submit('analysis', prompts.analysis_prompt);
    if (process.env.FAMSUN_ACCEPTANCE_PAUSE_AFTER_ANALYSIS === '1') {
      console.log('ANALYSIS_READY: awaiting independent metric verification before deliverables');
    } else {
      await requireAnalysisVerified();
      await submit('deliverables', prompts.deliverables_prompt);
      await verifyOutputs();
    }
  } else if (mode === 'correction') {
    await openSession();
    const stage = process.env.FAMSUN_ACCEPTANCE_CORRECTION_STAGE || 'correction';
    const correctionPrompt = await readFile(path.join(output, `${stage}-prompt.txt`), 'utf8');
    await submit(stage, correctionPrompt);
    console.log('CORRECTION_READY: awaiting independent verification before deliverables');
  } else if (mode === 'deliverables' || mode === 'retry-deliverables') {
    assert.equal(report.runs.findLast(item => item.stage === 'analysis' && !item.superseded)?.status, 'completed');
    await openSession();
    await requireAnalysisVerified();
    await submit('deliverables', prompts.deliverables_prompt);
    if (process.env.FAMSUN_ACCEPTANCE_SKIP_OUTPUT_PREVIEW === '1') {
      console.log('ARTIFACTS_READY: generation completed; baseline/current UI checks will run separately');
    } else await verifyOutputs();
  } else if (mode === 'verify') await verifyOutputs();
  else throw new Error(`Unknown mode: ${mode}`);
} catch (error) {
  report.failure = { at: new Date().toISOString(), mode, message: safeError(error) };
  await persist();
  await screenshot('failure').catch(() => {});
  console.error(safeError(error));
  process.exitCode = 1;
} finally { await browser.close(); }
