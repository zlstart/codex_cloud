// Final delivery QA. Serves the existing report over loopback; never regenerates it.
// QA screenshots/downloads stay outside production-acceptance evidence to avoid self-inclusion.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execute = promisify(execFile);
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const defaultReport = path.join(
  repository,
  "docs/reports/production-acceptance-2026-11-03.html",
);
const options = {
  report: defaultReport,
  output: path.join(repository, "test-results/report-delivery-qa-2026-11-03"),
};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  if (flag === "--help") {
    console.log(
      "Usage: node tests/acceptance-test-report.mjs [--report PATH.html] [--output QA_DIRECTORY]",
    );
    process.exit(0);
  }
  assert.ok(
    ["--report", "--output"].includes(flag) && process.argv[index + 1],
    `Unknown/incomplete option: ${flag}`,
  );
  options[flag.slice(2)] = path.resolve(process.argv[index + 1]);
}
const basename = options.report.replace(/\.html$/i, "");
const dataPath = `${basename}.json`;
const bundlePath = `${basename}-evidence.zip`;
const evidenceRoot = path.join(
  repository,
  "test-results/production-acceptance-2026-11-03",
);
const outputRelative = path.relative(evidenceRoot, options.output);
assert.ok(
  outputRelative.startsWith("..") || path.isAbsolute(outputRelative),
  "QA output must be outside production acceptance evidence",
);
await mkdir(path.join(options.output, "downloads"), { recursive: true });

const digest = async (filename) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
};
const result = {
  started_at: new Date().toISOString(),
  report: options.report,
  output: options.output,
  status: "running",
  checks: [],
  downloads: [],
  browser_errors: [],
  external_requests: [],
};
const check = (name, details = {}) =>
  result.checks.push({ name, status: "pass", ...details });
let browser;
let server;
let page;
try {
  const reportData = JSON.parse(await readFile(dataPath, "utf8"));
  const initialHashes = {
    html: await digest(options.report),
    json: await digest(dataPath),
    zip: await digest(bundlePath),
  };
  result.source_hashes = initialHashes;
  const notesKeys = reportData.notes?.key_screenshots || [];
  const sourceImages = new Map(
    reportData.screenshots.map((image) => [image.source, image]),
  );
  for (const source of notesKeys)
    assert.ok(
      sourceImages.has(source),
      `Curated screenshot is absent: ${source}`,
    );
  const expectedImages = notesKeys.length
    ? notesKeys.map((source) => sourceImages.get(source))
    : reportData.screenshots;
  assert.ok(
    expectedImages.length > 0,
    "Final report must include actual screenshots",
  );
  const routes = new Map([
    ["/", options.report],
    [`/${path.basename(options.report)}`, options.report],
    [`/${path.basename(bundlePath)}`, bundlePath],
  ]);
  server = createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const filename = routes.get(pathname);
    if (!filename) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": filename.endsWith(".zip")
        ? "application/zip"
        : "text/html; charset=utf-8",
    });
    createReadStream(filename)
      .on("error", () => response.destroy())
      .pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (
      url.startsWith(`${origin}/`) ||
      url.startsWith("data:") ||
      url.startsWith("blob:")
    )
      return route.continue();
    result.external_requests.push(url);
    return route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => result.browser_errors.push(error.message));
  await page.goto(origin, { waitUntil: "load" });
  await page.locator("h1").waitFor();

  const matrix = await page
    .locator("#formats table tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => [...row.cells].map((cell) => cell.innerText.trim())),
    );
  assert.deepEqual(matrix.map((row) => row[0]).sort(), [
    "DOCX",
    "HTML",
    "PDF",
    "PPTX",
    "XLSX",
  ]);
  for (const row of matrix) {
    assert.equal(row[1], "通过", `${row[0]} original-file gate`);
    assert.match(
      row[2],
      /^11\s*\/\s*11\s*项$/,
      `${row[0]} eleven metric checks`,
    );
    assert.equal(row[3], "通过", `${row[0]} business-content gate`);
    assert.match(row[4], /^已检查.*SHA/, `${row[0]} current-byte preview gate`);
    assert.equal(row[5], "通过", `${row[0]} download integrity gate`);
    assert.ok(
      !/未通过|待验收/.test(row.join(" ")),
      `${row[0]} final matrix contains an unfinished/failed gate`,
    );
  }
  assert.equal(
    (await page.locator(".kpi .value").first().innerText()).replace(/\s/g, ""),
    "5/5",
  );
  check(
    "Final five-format matrix passes all 11 numerical checks and independent gates",
    { matrix },
  );

  await page.locator(".shot img").evaluateAll(async (images) => {
    for (const image of images) image.loading = "eager";
    await Promise.all(images.map((image) => image.decode()));
  });
  const renderedImages = await page.locator(".shot").evaluateAll((figures) =>
    figures.map((figure) => {
      const image = figure.querySelector("img");
      return {
        alt: image.alt,
        src: image.src,
        complete: image.complete,
        width: image.naturalWidth,
        height: image.naturalHeight,
        caption: figure.querySelector("figcaption").innerText,
      };
    }),
  );
  assert.equal(
    renderedImages.length,
    expectedImages.length,
    "Key screenshot curation count",
  );
  for (let index = 0; index < renderedImages.length; index++) {
    const actual = renderedImages[index];
    const expected = expectedImages[index];
    assert.ok(
      actual.complete && actual.width > 0 && actual.height > 0,
      `Screenshot did not load: ${expected.source}`,
    );
    assert.equal(actual.width, expected.width, expected.source);
    assert.equal(actual.height, expected.height, expected.source);
    assert.ok(
      actual.caption.includes(expected.source),
      `Screenshot provenance missing: ${expected.source}`,
    );
    assert.match(actual.src, /^data:image\/png;base64,/);
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(actual.src.split(",")[1], "base64"))
        .digest("hex"),
      expected.sha256,
      `Embedded screenshot bytes changed: ${expected.source}`,
    );
  }
  check("All curated screenshots load from embedded original bytes", {
    displayed: expectedImages.length,
    archived: reportData.screenshots.length,
  });

  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: path.join(options.output, `${name}-overview.png`),
      animations: "disabled",
    });
    const widths = [];
    for (const section of await page.locator("main > section").all()) {
      await section.scrollIntoViewIfNeeded();
      const size = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        root: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      assert.ok(
        Math.max(size.body, size.root) <= size.viewport + 1,
        `${name} page overflow: ${JSON.stringify(size)}`,
      );
      widths.push(size);
    }
    await page.locator("#formats").screenshot({
      path: path.join(options.output, `${name}-matrix.png`),
      animations: "disabled",
    });
    const firstImage = page.locator(".shot .zoom").first();
    await firstImage.scrollIntoViewIfNeeded();
    await firstImage.click();
    const viewer = page.locator("#viewer");
    assert.equal(
      await viewer.evaluate((dialog) => dialog.open),
      true,
      `${name} screenshot lightbox`,
    );
    await viewer.locator("img").evaluate((image) => image.decode());
    assert.ok(
      await viewer.locator("img").evaluate((image) => image.naturalWidth > 0),
    );
    await page.screenshot({
      path: path.join(options.output, `${name}-lightbox.png`),
      animations: "disabled",
    });
    await viewer.getByRole("button").click();
    assert.equal(await viewer.evaluate((dialog) => dialog.open), false);
    check(`${name} layout and screenshot lightbox`, {
      viewport,
      checked_sections: widths.length,
      page_overflow: false,
    });
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  const links = page.locator(".download-link");
  assert.equal(
    await links.count(),
    reportData.downloads.length,
    "Every listed original has an embedded download link",
  );
  assert.ok(
    reportData.downloads.some(
      (item) =>
        item.source.startsWith("analysis/downloads/") && item.kind === "output",
    ),
    "No current generated originals to download",
  );
  for (let index = 0; index < reportData.downloads.length; index++) {
    const expected = reportData.downloads[index];
    const pending = page.waitForEvent("download");
    await links.nth(index).click();
    const download = await pending;
    const filename = `${String(index + 1).padStart(2, "0")}-${path.basename(expected.name)}`;
    const saved = path.join(options.output, "downloads", filename);
    await download.saveAs(saved);
    assert.equal(
      download.suggestedFilename(),
      expected.name,
      "Original filename preserved",
    );
    assert.equal(
      (await stat(saved)).size,
      expected.bytes,
      `${expected.name} byte count`,
    );
    const actualHash = await digest(saved);
    assert.equal(
      actualHash,
      expected.sha256,
      `${expected.name} embedded original bytes`,
    );
    result.downloads.push({
      name: expected.name,
      source: expected.source,
      version: expected.version,
      bytes: expected.bytes,
      sha256: actualHash,
    });
  }
  check(
    "All embedded original-file links produce exact browser-downloaded bytes",
    { count: result.downloads.length },
  );
  const zipPending = page.waitForEvent("download");
  await page.locator(".hero-actions a[download]").click();
  const zipDownload = await zipPending;
  const savedZip = path.join(options.output, path.basename(bundlePath));
  await zipDownload.saveAs(savedZip);
  assert.equal(
    await digest(savedZip),
    initialHashes.zip,
    "Actual browser evidence ZIP matches the delivery file",
  );

  const audit = String.raw`
import hashlib, json, re, stat, sys, zipfile
from pathlib import PurePosixPath
bundle, metadata = sys.argv[1:]
with open(metadata, encoding='utf-8') as handle:
    data = json.load(handle)
forbidden_path = re.compile(r'(^|[/_.-])(?:private|auth|cookies?|credentials?|secrets?|storage-state|session-detail|run-state|events)(?:$|[/_.-])', re.I)
credential = re.compile(r'\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})\b|famsun_session[\x22\x27]?\s*[:=]\s*[\x22\x27]?[A-Za-z0-9_-]{20,}', re.I)
forbidden_keys = {'password', 'password_hash', 'api_key', 'agent_api_key', 'openai_api_key', 'cookie', 'cookies', 'authorization', 'headers', 'access_token', 'refresh_token', 'session_token', 'auth_token', 'famsun_session', 'storage_state'}
def inspect(value):
    if isinstance(value, dict):
        assert not (set(str(key).lower() for key in value) & forbidden_keys), 'Private credential field in public JSON'
        for item in value.values(): inspect(item)
    elif isinstance(value, list):
        for item in value: inspect(item)
    elif isinstance(value, str):
        assert not credential.search(value), 'Credential-shaped value in clear text'
        assert not re.search(r'/tmp/famsun-acceptance-(?:admin|member)', value), 'Private browser state path in bundle'
with zipfile.ZipFile(bundle) as archive:
    assert archive.testzip() is None, 'ZIP CRC mismatch'
    members = archive.infolist()
    names = [member.filename for member in members]
    assert len(names) == len(set(names)), 'Duplicate archive paths'
    for member in members:
        entry = PurePosixPath(member.filename)
        assert not entry.is_absolute() and '..' not in entry.parts and '\\' not in member.filename, 'Unsafe archive path'
        assert not stat.S_ISLNK(member.external_attr >> 16), 'Archive symlink'
        assert not forbidden_path.search(member.filename), 'Private/raw evidence filename in bundle'
        assert entry.name != 'setup.json' and entry.suffix.lower() not in {'.log', '.env', '.db', '.sqlite', '.sqlite3'}, 'Raw state/log/database in bundle'
    manifest = json.loads(archive.read('MANIFEST.json'))
    assert set(names) == {item['path'] for item in manifest['files']} | {'MANIFEST.json'}, 'Unmanifested file'
    for item in manifest['files']:
        raw = archive.read(item['path'])
        assert len(raw) == item['bytes'] and hashlib.sha256(raw).hexdigest() == item['sha256'], 'Manifest byte/hash mismatch'
        if PurePosixPath(item['path']).suffix.lower() in {'.json', '.html', '.md', '.txt', '.csv'}:
            decoded = raw.decode('utf-8-sig')
            assert not credential.search(decoded), 'Credential-shaped value in cleartext member'
            if item['path'].endswith('.json'): inspect(json.loads(decoded))
    report_name = PurePosixPath(metadata).stem
    manifest_map = {item['path']:item for item in manifest['files']}
    for kind, rows in [('screenshots', data['screenshots']), ('downloads', data['downloads'])]:
        for row in rows:
            member = f"{report_name}.assets/{kind}/{row['source']}"
            assert member in manifest_map and manifest_map[member]['sha256'] == row['sha256'], f'Missing/mismatched {kind} evidence'
print(json.dumps({'status':'pass','zip_crc':'pass','manifest_entries':len(manifest['files']),'archived_screenshots':len(data['screenshots']),'archived_originals':len(data['downloads']),'privacy':'no credential fields/values, raw state/logs or unsafe archive paths detected'}))
`;
  const { stdout } = await execute(
    process.env.PYTHON_EXECUTABLE || path.join(repository, ".venv/bin/python"),
    ["-c", audit, savedZip, dataPath],
    { maxBuffer: 1024 * 1024 },
  );
  result.bundle_audit = JSON.parse(stdout);
  check(
    "Browser-downloaded evidence ZIP passes CRC, manifest, coverage and privacy checks",
    result.bundle_audit,
  );
  assert.deepEqual(result.browser_errors, [], "Report JavaScript errors");
  assert.deepEqual(
    result.external_requests,
    [],
    "Self-contained report requested an external resource",
  );
  assert.equal(
    await digest(options.report),
    initialHashes.html,
    "Report changed during QA",
  );
  assert.equal(
    await digest(dataPath),
    initialHashes.json,
    "Report data changed during QA",
  );
  assert.equal(
    await digest(bundlePath),
    initialHashes.zip,
    "Evidence ZIP changed during QA",
  );
  check("Report stayed stable and made no external resource requests");
  result.status = "pass";
} catch (error) {
  result.status = "fail";
  result.error = String(error.message).slice(0, 2500);
  if (page)
    await page
      .screenshot({
        path: path.join(options.output, "failure.png"),
        animations: "disabled",
      })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  result.finished_at = new Date().toISOString();
  await writeFile(
    path.join(options.output, "report.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      status: result.status,
      checks: result.checks.length,
      browser_original_downloads: result.downloads.length,
      output: options.output,
      error: result.error,
    }),
  );
}
