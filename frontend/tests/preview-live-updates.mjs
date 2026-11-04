// Authored API/SSE fixtures exercise the real UI; this is not live-provider evidence.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const artifacts =
  process.env.FAMSUN_TEST_ARTIFACT_DIR || "/tmp/famsun-preview-live-updates";
mkdirSync(artifacts, { recursive: true });
const now = "2026-11-04T01:00:00Z";
const session = {
  id: "s-preview-live",
  title: "运行中持续更新文件",
  created_at: now,
  updated_at: now,
  model: "fixture",
  pinned: false,
};
const run = {
  id: "r-preview-live",
  session_id: session.id,
  status: "running",
  created_at: now,
  updated_at: now,
};
const file = {
  id: "f-preview-live",
  session_id: session.id,
  name: "live-result.py",
  mime_type: "text/x-python",
  size: 12,
  kind: "output",
  created_at: now,
  url: "/api/files/f-preview-live/content",
};
const workbook = {
  ...file,
  id: "f-preview-workbook",
  name: "live-workbook.xlsx",
  mime_type:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  url: "/api/files/f-preview-workbook/content",
};
let workbookPreview = {
  kind: "spreadsheet",
  truncated: false,
  sheets: ["First", "Second"].map((name) => ({
    name,
    rows: [[`${name} sheet content`]],
    total_rows: 1,
    total_columns: 1,
    truncated: false,
  })),
};
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const requests = [];
const failures = [];
const errors = [];
let result = "failed";
page.on("requestfailed", (request) => {
  if (new URL(request.url()).pathname === file.url)
    failures.push(request.failure()?.errorText);
});
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  window.previewSources = [];
  window.previewRevision = 0;
  window.EventSource = class extends EventTarget {
    constructor() {
      super();
      window.previewSources.push(this);
    }
    close() {
      this.closed = true;
    }
  };
  window.emitPreviewRevision = (file) => {
    const revision = ++window.previewRevision;
    const artifact = {
      ...file,
      created_at: new Date(Date.UTC(2026, 10, 4, 1, 0, revision)).toISOString(),
    };
    for (const source of window.previewSources.filter(
      (source) => !source.closed,
    ))
      source.dispatchEvent(
        new MessageEvent("artifact.created", {
          data: JSON.stringify({ artifact }),
          lastEventId: String(revision),
        }),
      );
  };
});
const json = (route, value) =>
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(value),
  });
await page.route("**/api/**", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/auth/me")
    return json(route, {
      id: "u-preview",
      name: "Preview fixture",
      email: "preview@example.test",
      role: "admin",
    });
  if (pathname === "/api/settings")
    return json(route, {
      provider: { configured: true, model: "fixture", api_mode: "responses" },
      sandbox: { available: true, backend: "docker" },
      limits: { max_upload_mb: 25, max_turns: 20 },
      registration_enabled: false,
    });
  if (pathname === "/api/sessions") return json(route, [session]);
  if (pathname === `/api/sessions/${session.id}`)
    return json(route, {
      session,
      runs: [run],
      files: [file, workbook],
      messages: [
        {
          id: "question",
          role: "user",
          content: "持续生成工作区文件",
          run_id: run.id,
          created_at: now,
        },
      ],
    });
  if (pathname === `/api/files/${workbook.id}/preview`)
    return json(route, workbookPreview);
  if (pathname === file.url) {
    // Each response remains pending until the test explicitly releases it.
    // This guarantees several revisions arrive during an actual browser fetch.
    const body = await new Promise((release) =>
      requests.push({ release, released: false, request: route.request() }),
    );
    return route.fulfill({ contentType: "text/plain", body }).catch(() => {});
  }
  return json(route, []);
});
async function waitForRequests(count) {
  const deadline = Date.now() + 5000;
  while (requests.length < count && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    requests.length >= count,
    `Expected content request ${count}; received ${requests.length}`,
  );
}
function release(index, content) {
  requests[index].released = true;
  requests[index].release(content);
}
async function expectContent(content) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".file-preview-modal code")?.textContent ===
      expected,
    content,
    { timeout: 2000 },
  );
}
async function settleMount() {
  // Development StrictMode intentionally mounts, cancels, then mounts again.
  // Start assertions after that lifecycle check, also supporting built apps.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
try {
  await page.goto(process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173");
  await page
    .locator(".session-select")
    .filter({ hasText: session.title })
    .click();
  await page.waitForFunction(() =>
    window.previewSources.some((source) => !source.closed),
  );
  await page
    .getByRole("button", { name: `预览 ${file.name}`, exact: true })
    .click();
  await waitForRequests(1);
  await settleMount();
  const initial = requests.length - 1;
  const initialFailures = failures.length;
  assert.equal(requests[initial].request.failure(), null);
  await page.evaluate((file) => {
    window.previewUpdates = setInterval(
      () => window.emitPreviewRevision(file),
      50,
    );
  }, file);
  await page.waitForFunction(() => window.previewRevision >= 5);
  release(initial, "value = 0000");
  // Must display a completed response while revisions continue, rather than
  // only becoming usable after the model stops writing.
  await expectContent("value = 0000");
  await waitForRequests(initial + 2);
  const revision = await page.evaluate(() => window.previewRevision);
  await page.waitForFunction(
    (previous) => window.previewRevision >= previous + 5,
    revision,
  );
  assert.equal(
    await page.locator(".file-preview-modal code").textContent(),
    "value = 0000",
  );
  assert.equal(
    await page.locator(".preview-body").getAttribute("aria-busy"),
    "false",
  );
  assert.equal(
    requests.length,
    initial + 2,
    "Revision bursts are coalesced behind the current fetch",
  );
  assert.equal(
    failures.length,
    initialFailures,
    "Revision updates must not cancel in-flight content reads",
  );
  await page.screenshot({ path: `${artifacts}/preview-during-updates.png` });

  await page.evaluate(() => clearInterval(window.previewUpdates));
  release(initial + 1, "value = 1111");
  await expectContent("value = 1111");
  await waitForRequests(initial + 3);
  release(initial + 2, "value = 2222");
  await expectContent("value = 2222");
  assert.equal(await page.locator(".file-tile").count(), 2);

  // Equal-size corrections after loading still refresh the preview.
  await page.evaluate((file) => window.emitPreviewRevision(file), file);
  await waitForRequests(initial + 4);
  release(initial + 3, "value = 3333");
  await expectContent("value = 3333");

  // Closing aborts the in-flight refresh, and reopening gets its own lifecycle.
  await page.evaluate((file) => window.emitPreviewRevision(file), file);
  await waitForRequests(initial + 5);
  const cancelled = page.waitForEvent(
    "requestfailed",
    (request) => new URL(request.url()).pathname === file.url,
  );
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await cancelled;
  await page
    .getByRole("button", { name: `预览 ${file.name}`, exact: true })
    .click();
  await waitForRequests(initial + 6);
  await settleMount();
  release(requests.length - 1, "value = 5555");
  await expectContent("value = 5555");
  release(initial + 4, "value = 4444");
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await page.locator(".file-preview-modal code").textContent(),
    "value = 5555",
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${artifacts}/preview-after-updates.png` });

  // Replacing a multi-page preview must not leave a stale selection beyond
  // the new revision's bounds after sheets or pages are removed.
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page
    .getByRole("button", { name: `预览 ${workbook.name}`, exact: true })
    .click();
  await page.getByRole("tab", { name: "Second", exact: true }).click();
  await page
    .getByRole("cell", { name: "Second sheet content", exact: true })
    .waitFor();
  workbookPreview = {
    ...workbookPreview,
    sheets: [
      {
        name: "Only remaining sheet",
        rows: [["Latest workbook content"]],
        total_rows: 1,
        total_columns: 1,
        truncated: false,
      },
    ],
  };
  await page.evaluate((file) => window.emitPreviewRevision(file), workbook);
  await page
    .getByRole("cell", { name: "Latest workbook content", exact: true })
    .waitFor({ timeout: 2000 });
  assert.equal(
    await page
      .getByRole("tab", { name: "Only remaining sheet" })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.screenshot({
    path: `${artifacts}/preview-shrinking-workbook.png`,
  });

  // HTML must start after iframe layout, including loadedVersion remounts.
  const htmlFile = {
    ...file,
    name: "live-result.html",
    mime_type: "text/html",
  };
  const htmlRevision = (number) => `<!doctype html><html><body>
    <h1>Live HTML ${number}</h1><canvas style="display:block;width:100%;aspect-ratio:2/1"></canvas>
    <script>const canvas=document.querySelector('canvas');const size=canvas.getBoundingClientRect();
    canvas.width=Math.max(1,Math.round(size.width));canvas.height=Math.max(1,Math.round(size.height));
    canvas.getContext('2d').fillRect(0,0,canvas.width,canvas.height);</script></body></html>`;
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page.evaluate(
    (nextFile) => window.emitPreviewRevision(nextFile),
    htmlFile,
  );
  let count = requests.length;
  await page
    .getByRole("button", { name: `预览 ${htmlFile.name}`, exact: true })
    .click();
  await waitForRequests(count + 1);
  await settleMount();
  release(requests.length - 1, htmlRevision(1));
  let html = page.frameLocator(`iframe[title="${htmlFile.name}"]`);
  await html
    .getByRole("heading", { name: "Live HTML 1", exact: true })
    .waitFor();
  const previousFrame = await (
    await page.locator(`iframe[title="${htmlFile.name}"]`).elementHandle()
  ).contentFrame();
  assert.ok(
    await html
      .locator("canvas")
      .evaluate((node) => node.width > 100 && node.height > 50),
  );

  count = requests.length;
  await page.evaluate((nextFile) => {
    for (let index = 0; index < 3; index++)
      window.emitPreviewRevision(nextFile);
  }, htmlFile);
  await waitForRequests(count + 1);
  assert.equal(await html.getByRole("heading").textContent(), "Live HTML 1");
  release(requests.length - 1, htmlRevision(2));
  await html
    .getByRole("heading", { name: "Live HTML 2", exact: true })
    .waitFor();
  assert.ok(
    previousFrame.isDetached(),
    "Successful refresh replaces the old HTML frame",
  );
  assert.ok(
    await html
      .locator("canvas")
      .evaluate((node) => node.width > 100 && node.height > 50),
  );

  count = requests.length;
  await page.evaluate(
    (nextFile) => window.emitPreviewRevision(nextFile),
    htmlFile,
  );
  await waitForRequests(count + 1);
  const staleHtml = requests.length - 1;
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page
    .getByRole("button", { name: `预览 ${workbook.name}`, exact: true })
    .click();
  await page
    .getByRole("cell", { name: "Latest workbook content", exact: true })
    .waitFor();
  release(staleHtml, htmlRevision(3));
  await settleMount();
  assert.equal(
    await page.getByRole("dialog").locator("iframe").count(),
    0,
    "A closed HTML preview must not overwrite another file after a late response",
  );
  assert.deepEqual(errors, []);
  result = "passed";
  console.log(
    "PASS: preview loads during revision bursts, retains content, converges to latest equal-size revision, aborts only on close, resets removed sheet selections, and initializes refreshed HTML frames with real layout",
  );
} catch (error) {
  await page.screenshot({ path: `${artifacts}/preview-failure.png` });
  throw error;
} finally {
  const revision = await page
    .evaluate(() => {
      clearInterval(window.previewUpdates);
      return window.previewRevision;
    })
    .catch(() => null);
  writeFileSync(
    `${artifacts}/preview-live-updates.json`,
    JSON.stringify(
      {
        result,
        evidence:
          "authored API/SSE fixtures with real Chromium and application UI; not live-provider validation",
        revisions: revision,
        contentRequests: requests.length,
        requestFailures: failures,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  for (const request of requests.filter((request) => !request.released))
    request.release("cleanup");
  await browser.close();
}
