// Read-only real-artifact check. The selectors below were observed in this run's
// generated DOM; no app/API mocks, output edits, model calls, or script injection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from '/workspace/codex_cloud/frontend/node_modules/playwright/index.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const run = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
assert.equal(run.status, 'completed', 'Only verify finalized output');
let repair;
try {
  repair = JSON.parse(await readFile(path.join(root, 'repair/report.json'), 'utf8'));
  assert.equal(repair.status, 'completed', 'Wait for targeted HTML repair to complete');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const baseURL = 'http://127.0.0.1:5173';
const out = path.join(root, `html-verification-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(out, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = { started_at: new Date().toISOString(), initial_run_id: run.run_id, repair_run_id: repair?.run_id, session_id: run.session_id, live_provider: true, generated_outputs_modified: false, model_calls_submitted: false, checks: [], issues: [] };
const save = () => writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

function watch(page, label) {
  const observed = { label, console: [], page_errors: [], requests: [], failed_requests: [] };
  page.on('console', (message) => observed.console.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on('pageerror', (error) => observed.page_errors.push(error.message));
  page.on('request', (request) => observed.requests.push({ url: request.url(), type: request.resourceType() }));
  page.on('requestfailed', (request) => observed.failed_requests.push({ url: request.url(), failure: request.failure() }));
  return observed;
}

async function snapshot(frame) {
  const state = await frame.evaluate(() => {
    const slider = document.querySelector('#slider');
    const canvas = document.querySelector('#cv');
    // The observed artifact draws three white star cores; its grid/HUD text is
    // colored. Track those actual rendered cores, not changing time-label pixels.
    const { width, height } = canvas;
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) if (pixels[4*i] > 245 && pixels[4*i+1] > 245 && pixels[4*i+2] > 245 && pixels[4*i+3] > 240) mask[i] = 1;
    const markers = [];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      mask[i] = 0;
      const queue = [i];
      let count = 0, xsum = 0, ysum = 0;
      for (let k = 0; k < queue.length; k++) {
        const pixel = queue[k], x = pixel % width, y = Math.floor(pixel / width);
        count++; xsum += x; ysum += y;
        for (const next of [x > 0 ? pixel-1 : -1, x < width-1 ? pixel+1 : -1, y > 0 ? pixel-width : -1, y < height-1 ? pixel+width : -1]) {
          if (next >= 0 && mask[next]) { mask[next] = 0; queue.push(next); }
        }
      }
      if (count >= 8 && count < 200) markers.push({ x: xsum/count, y: ysum/count, pixels: count });
    }
    return {
      range: { value: Number(slider.value), min: Number(slider.min), max: Number(slider.max) },
      time: document.querySelector('#hud-t').textContent,
      output: document.querySelector('#slider-out').textContent,
      status: document.querySelector('#status').textContent,
      pixels: canvas.toDataURL(),
      canvas: { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight },
      markers: markers.sort((a,b) => a.x-b.x || a.y-b.y),
      layout: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    };
  });
  state.canvas_sha256 = sha(state.pixels);
  delete state.pixels;
  assert.equal(state.markers.length, 3, 'Canvas shows three distinct white star cores');
  return state;
}

function markerMotion(a, b) {
  const permutations = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  return Math.sqrt(Math.min(...permutations.map(order => a.markers.reduce((sum, point, i) => sum + (point.x-b.markers[order[i]].x)**2 + (point.y-b.markers[order[i]].y)**2, 0))));
}

async function actions(frame, page, label) {
  const result = { label, functional_passed: false };
  evidence.checks.push(result);
  try {
    await frame.locator('#hud-t').waitFor();
    await frame.waitForFunction(() => document.querySelector('#cv')?.width > 100 && document.querySelector('#cv')?.height > 100);
    result.controls = await frame.evaluate(() => ({ buttons: [...document.querySelectorAll('button')].map(n => ({ id: n.id, text: n.textContent })), sliders: [...document.querySelectorAll('input[type=range]')].map(n => ({ id: n.id, label: n.getAttribute('aria-label'), labels: [...n.labels].map(label => label.textContent) })) }));
    assert.ok(result.controls.sliders.some(s => s.label?.includes('时间') || s.labels.some(label => label.includes('时间'))), 'Time slider has a label');
    await frame.getByRole('button', { name: /重置/ }).click();
    await frame.waitForFunction(() => document.querySelector('#slider').value === '0' && document.querySelector('#hud-t').textContent === 't = 0.000');
    result.initial = await snapshot(frame);
    result.colors = await frame.evaluate(() => {
      const dots = [...document.querySelectorAll('.legend .dot')];
      const canvas = document.querySelector('#cv');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return dots.map(dot => {
        const css = getComputedStyle(dot).color;
        const rgb = css.match(/[\d.]+/g).slice(0, 3).map(Number);
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 60 && rgb.every((c, j) => Math.abs(c - pixels[i + j]) <= 25)) count++;
        return { legend: dot.parentElement.textContent, css, matching_pixels: count };
      });
    });
    assert.equal(result.colors.length, 3);
    assert.ok(result.colors.every(color => color.matching_pixels > 5), 'All three legend colors occur on canvas');
    await frame.locator('#cv').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `${label}-initial.png`), fullPage: frame === page });

    await frame.getByRole('button', { name: /继续/ }).click();
    await frame.waitForFunction(() => Number(document.querySelector('#slider').value) > 15);
    result.playing = await snapshot(frame);
    assert.notEqual(result.playing.canvas_sha256, result.initial.canvas_sha256);
    result.play_motion_pixels = markerMotion(result.playing, result.initial);
    assert.ok(result.play_motion_pixels > 2, 'Play moves the actual star cores');
    await frame.getByRole('button', { name: /暂停/ }).click();
    await page.waitForTimeout(100);
    const paused = await snapshot(frame);
    await page.waitForTimeout(350);
    const pausedLater = await snapshot(frame);
    result.pause = { before: paused, after: pausedLater };
    assert.equal(pausedLater.range.value, paused.range.value, 'Pause freezes slider');
    assert.equal(pausedLater.time, paused.time, 'Pause freezes time');
    assert.equal(pausedLater.canvas_sha256, paused.canvas_sha256, 'Pause freezes canvas');

    await frame.getByRole('button', { name: /继续/ }).click();
    await frame.waitForFunction(value => Number(document.querySelector('#slider').value) > value + 10, paused.range.value);
    result.continue = await snapshot(frame);
    assert.notEqual(result.continue.canvas_sha256, paused.canvas_sha256);
    result.continue_motion_pixels = markerMotion(result.continue, paused);
    assert.ok(result.continue_motion_pixels > 2, 'Continue moves the actual star cores');
    await frame.getByRole('button', { name: /暂停/ }).click();
    const slider = frame.getByRole('slider', { name: /时间/ });
    await slider.scrollIntoViewIfNeeded();
    const bounds = await slider.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.1, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    result.seek = await snapshot(frame);
    assert.ok(result.seek.range.value > result.seek.range.max * 0.55 && result.seek.range.value < result.seek.range.max * 0.85, 'Pointer drag seeks to later time');
    assert.notEqual(result.seek.canvas_sha256, paused.canvas_sha256);
    result.seek_motion_pixels = markerMotion(result.seek, paused);
    assert.ok(result.seek_motion_pixels > 2, 'Seek moves the actual star cores');
    assert.ok(Math.abs(Number(result.seek.time.match(/[\d.]+/)[0]) - result.seek.range.value * 0.01) < 0.001, 'Visible time agrees with selected sample');
    await page.screenshot({ path: path.join(out, `${label}-seek.png`), fullPage: frame === page });
    await frame.getByRole('button', { name: /重置/ }).click();
    await frame.waitForFunction(() => document.querySelector('#hud-t').textContent === 't = 0.000');
    const reset = await snapshot(frame);
    await page.waitForTimeout(300);
    result.reset = { first: reset, later: await snapshot(frame) };
    assert.equal(reset.range.value, 0);
    assert.equal(reset.canvas_sha256, result.initial.canvas_sha256, 'Reset restores original rendering');
    assert.equal(result.reset.later.canvas_sha256, reset.canvas_sha256, 'Reset remains paused');
    result.functional_passed = true;
    result.no_horizontal_overflow = reset.layout.scrollWidth <= reset.layout.clientWidth + 1;
    if (!result.no_horizontal_overflow) evidence.issues.push({ label, kind: 'generated_html_horizontal_overflow', ...reset.layout });
  } catch (error) {
    result.error = error.message;
    evidence.issues.push({ label, kind: 'interaction_failure', message: error.message });
    await page.screenshot({ path: path.join(out, `${label}-failure.png`), fullPage: frame === page }).catch(() => {});
  }
  await save();
}

try {
  const owner = await browser.newContext({ baseURL, storageState: '/tmp/famsun-acceptance-admin.json', acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const session = await (await owner.request.get(`/api/sessions/${run.session_id}`)).json();
  const htmlFile = session.files.find(file => file.name === 'three_body.html');
  const csvFile = session.files.find(file => file.name === 'three_body.csv');
  assert.ok(htmlFile && csvFile);
  const sourceResponse = await owner.request.get(htmlFile.url);
  assert.equal(sourceResponse.status(), 200);
  const source = await sourceResponse.body();
  assert.equal(source.length, htmlFile.size);
  evidence.artifact = { name: htmlFile.name, id: htmlFile.id, bytes: source.length, sha256: sha(source) };
  const csv = await (await owner.request.get(csvFile.url)).text();
  const samples = csv.trim().split(/\r?\n/).slice(1).map(line => line.split(',').map(Number));
  const embedded = JSON.parse(source.toString('utf8').match(/<script[^>]+id="sim-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(embedded.samples.length, samples.length);
  const differences = samples.flatMap((row, i) => row.map((value, j) => Math.abs(value - embedded.samples[i][j])));
  evidence.embedded_data = { csv_rows: samples.length, embedded_rows: embedded.samples.length, maximum_absolute_difference: Math.max(...differences), tolerance: 1e-9 };
  assert.ok(evidence.embedded_data.maximum_absolute_difference <= 1e-9);
  const baselineHtml = await readFile(path.join(root, 'baseline-downloads/three_body.html'), 'utf8');
  const baselineData = JSON.parse(baselineHtml.match(/<script[^>]+id="sim-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const baselineCsv = await readFile(path.join(root, 'baseline-downloads/three_body.csv'));
  assert.deepEqual(embedded.samples, baselineData.samples, 'Targeted repair preserves all embedded samples');
  assert.deepEqual(Buffer.from(csv), baselineCsv, 'Targeted repair preserves CSV bytes');
  evidence.repair_preservation = { embedded_samples_identical: true, csv_bytes_identical: true, csv_sha256: sha(baselineCsv) };

  const page = await owner.newPage();
  const appObserved = watch(page, 'app-preview');
  evidence.app_observed = appObserved;
  await page.goto('/');
  await page.getByRole('button', { name: '文件空间', exact: true }).click();
  await page.locator('.file-table-row').filter({ has: page.locator(`a[href="${htmlFile.url}?download=true"]`) }).getByRole('button', { name: htmlFile.name, exact: true }).click();
  const iframe = page.locator(`iframe[title="${htmlFile.name}"]`);
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
  const frame = await (await iframe.elementHandle()).contentFrame();
  await actions(frame, page, 'preview-desktop');
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载文件', exact: true }).click();
  const downloaded = await pending;
  const saved = path.join(out, 'three_body.downloaded.html');
  await downloaded.saveAs(saved);
  const downloadedBytes = await readFile(saved);
  assert.equal(await downloaded.failure(), null);
  assert.equal(downloaded.suggestedFilename(), htmlFile.name);
  assert.deepEqual(downloadedBytes, source);
  evidence.download = { suggested_filename: downloaded.suggestedFilename(), bytes: downloadedBytes.length, sha256: sha(downloadedBytes), api_bytes_identical: true, saved_file: path.basename(saved) };
  await page.setViewportSize({ width: 390, height: 844 });
  await actions(frame, page, 'preview-mobile');
  evidence.app_mobile_layout = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  if (evidence.app_mobile_layout.scrollWidth > evidence.app_mobile_layout.clientWidth + 1) evidence.issues.push({ label: 'app-mobile', kind: 'app_horizontal_overflow', ...evidence.app_mobile_layout });
  await owner.close();

  const probeContext = await browser.newContext({ offline: true });
  const probe = await probeContext.newPage();
  try {
    await probe.goto(pathToFileURL(saved).href, { waitUntil: 'load', timeout: 10_000 });
    evidence.direct_file_open = { loaded: true, url: probe.url() };
  } catch (error) {
    evidence.direct_file_open = { loaded: false, error: error.message, limitation: 'Offline setContent below verifies unmodified self-contained HTML, not direct file navigation.' };
  }
  await probeContext.close();

  evidence.offline = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, offline: true });
    const page = await context.newPage();
    const label = viewport.width > 600 ? 'offline-desktop' : 'offline-mobile';
    const observed = watch(page, label);
    evidence.offline.push({ viewport, ...observed });
    await page.setContent(downloadedBytes.toString('utf8'), { waitUntil: 'load' });
    await actions(page, page, label);
    await context.close();
  }
  for (const observed of [appObserved, ...evidence.offline]) {
    for (const message of observed.console.filter(message => message.type === 'error')) evidence.issues.push({ label: observed.label, kind: 'console_error', message: message.text });
    for (const message of observed.page_errors) evidence.issues.push({ label: observed.label, kind: 'page_error', message });
  }
  for (const observed of evidence.offline) {
    for (const request of observed.requests.filter(request => /^https?:/.test(request.url))) evidence.issues.push({ label: observed.label, kind: 'offline_external_resource_attempt', url: request.url });
  }
  evidence.functional_passed = evidence.checks.length === 4 && evidence.checks.every(check => check.functional_passed);
  evidence.all_layouts_passed = evidence.checks.every(check => check.no_horizontal_overflow) && evidence.app_mobile_layout.scrollWidth <= evidence.app_mobile_layout.clientWidth + 1;
  evidence.passed = evidence.functional_passed && evidence.all_layouts_passed && evidence.issues.length === 0;
} catch (error) {
  evidence.error = error.message;
  evidence.passed = false;
} finally {
  evidence.finished_at = new Date().toISOString();
  await save();
  await browser.close();
  console.log(JSON.stringify({ output: out, functional_passed: evidence.functional_passed, all_layouts_passed: evidence.all_layouts_passed, passed: evidence.passed, issues: evidence.issues, error: evidence.error }, null, 2));
  process.exitCode = evidence.passed ? 0 : 1;
}
