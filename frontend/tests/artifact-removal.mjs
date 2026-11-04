// Real Chromium/application UI with authored API/SSE fixtures, not live-model evidence.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const artifacts =
  process.env.FAMSUN_TEST_ARTIFACT_DIR || "/tmp/famsun-artifact-removal";
mkdirSync(artifacts, { recursive: true });
const now = "2026-11-04T01:00:00Z";
const session = {
  id: "s-remove",
  title: "文件移除回归",
  model: "fixture",
  pinned: false,
  created_at: now,
  updated_at: now,
};
const otherSession = { ...session, id: "s-other", title: "另一会话文件" };
const run = {
  id: "r-remove",
  session_id: session.id,
  status: "running",
  created_at: now,
  updated_at: now,
};
const otherRun = { ...run, id: "r-other", session_id: otherSession.id };
const removed = {
  id: "f-removed",
  session_id: session.id,
  name: "report_payload.json",
  mime_type: "application/json",
  size: 16,
  kind: "output",
  created_at: now,
  url: "/api/files/f-removed/content",
};
const kept = {
  ...removed,
  id: "f-kept",
  name: "retained.txt",
  mime_type: "text/plain",
  kind: "upload",
  url: "/api/files/f-kept/content",
};
const globalRemoved = {
  ...kept,
  id: "f-global-removed",
  name: "global-payload.txt",
  kind: "output",
  url: "/api/files/f-global-removed/content",
};
const otherFile = {
  ...kept,
  id: "f-other",
  session_id: otherSession.id,
  name: "other-session.txt",
  url: "/api/files/f-other/content",
};
let currentFiles = [removed, globalRemoved, kept];
let fileListRequests = 0;
let runStatus = "running";
const events = [
  {
    sequence: 1,
    run_id: run.id,
    type: "artifact.created",
    data: { artifact: removed },
    created_at: now,
  },
  {
    sequence: 2,
    run_id: run.id,
    type: "artifact.removed",
    data: { artifact: removed },
    created_at: now,
  },
];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await context.addInitScript(() => {
  window.removalSources = [];
  window.EventSource = class extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      window.removalSources.push(this);
    }
    close() {
      this.closed = true;
    }
  };
  window.emitRemovalEvents = (entries, runId, includeClosed = false) => {
    for (const source of window.removalSources.filter(
      (source) =>
        (includeClosed || !source.closed) &&
        source.url.includes(`/runs/${runId}/`),
    ))
      for (const event of entries)
        source.dispatchEvent(
          new MessageEvent(event.type, {
            data: JSON.stringify(event.data),
            lastEventId: String(event.sequence),
          }),
        );
  };
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
      id: "u-removal",
      name: "Removal fixture",
      email: "removal@example.test",
      role: "admin",
    });
  if (path === "/api/settings")
    return json(route, {
      provider: { configured: true, api_mode: "responses", model: "fixture" },
      sandbox: { backend: "docker", available: true },
      limits: { max_upload_mb: 25, max_turns: 20 },
      registration_enabled: false,
    });
  if (path === "/api/sessions") return json(route, [session, otherSession]);
  if (
    path === `/api/sessions/${session.id}` ||
    path === `/api/sessions/${otherSession.id}`
  ) {
    const isOther = path.endsWith(otherSession.id);
    const selectedRun = isOther ? otherRun : { ...run, status: runStatus };
    return json(route, {
      session: isOther ? otherSession : session,
      files: isOther ? [otherFile] : currentFiles,
      runs: [selectedRun],
      messages: [
        {
          id: `question-${selectedRun.id}`,
          role: "user",
          run_id: selectedRun.id,
          content: "生成后移走中间文件，保留最终成果",
          created_at: now,
        },
      ],
    });
  }
  if (path === `/api/runs/${run.id}/timeline`)
    return json(route, {
      events,
      next_cursor: events.at(-1).sequence,
      has_more: false,
      status: runStatus,
    });
  if (path === "/api/files") {
    fileListRequests++;
    return json(route, [...currentFiles, otherFile]);
  }
  if (path === removed.url)
    return currentFiles.some((file) => file.id === removed.id)
      ? route.fulfill({
          contentType: "application/json",
          body: '{"stage":"work"}',
        })
      : route.fulfill({ status: 404, body: "File moved out of outputs" });
  if (path === kept.url || path === otherFile.url || path === globalRemoved.url)
    return route.fulfill({
      contentType: "text/plain",
      body:
        path === otherFile.url ? "other session content" : "retained content",
    });
  return json(route, []);
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let result = "failed";
const emit = (entries, runId = run.id, includeClosed = false) =>
  page.evaluate(
    ({ entries, runId, includeClosed }) =>
      window.emitRemovalEvents(entries, runId, includeClosed),
    { entries, runId, includeClosed },
  );
async function select(target) {
  await page
    .locator(".session-select")
    .filter({ hasText: target.title })
    .click();
  await page.waitForFunction(
    (id) =>
      window.removalSources.some(
        (source) => !source.closed && source.url.includes(`/runs/${id}/`),
      ),
    target.id === session.id ? run.id : otherRun.id,
  );
}
async function expectTiles(names) {
  await page.waitForFunction(
    (expected) => {
      const names = [
        ...document.querySelectorAll(".workspace-files .file-tile-info strong"),
      ].map((element) => element.textContent);
      return (
        JSON.stringify(names.sort()) === JSON.stringify(expected.slice().sort())
      );
    },
    names,
    { timeout: 2000 },
  );
}
try {
  await page.goto(process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173");
  await select(session);
  await expectTiles([removed.name, globalRemoved.name, kept.name]);
  await page
    .getByRole("button", { name: `预览 ${removed.name}`, exact: true })
    .click();
  await page.locator(".file-preview-modal code").waitFor();
  await emit([events[0]]);
  currentFiles = [globalRemoved, kept];
  await emit([events[1]]);
  // This fails on the original code: artifact.removed is never subscribed to.
  await page
    .locator(".file-preview-modal")
    .waitFor({ state: "detached", timeout: 2000 });
  await expectTiles([globalRemoved.name, kept.name]);
  await page.screenshot({ path: `${artifacts}/removed-live.png` });

  // Repeated removals are harmless, including a new sequence for the same file.
  await emit([events[1], { ...events[1], sequence: 3 }]);
  await expectTiles([globalRemoved.name, kept.name]);
  await page
    .getByRole("button", { name: `预览 ${kept.name}`, exact: true })
    .click();
  await page.getByText("retained content", { exact: true }).waitFor();
  await emit([
    {
      ...events[1],
      sequence: 4,
      data: { artifact: { ...kept, session_id: otherSession.id } },
    },
  ]);
  assert.equal(
    await page.locator(".file-preview-modal code").textContent(),
    "retained content",
  );
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await expectTiles([globalRemoved.name, kept.name]);

  // Events queued on an old EventSource cannot modify the newly selected chat.
  await select(otherSession);
  await expectTiles([otherFile.name]);
  await emit(
    [{ ...events[1], sequence: 5, data: { artifact: otherFile } }],
    run.id,
    true,
  );
  await expectTiles([otherFile.name]);

  // Full SSE replay includes both historical create and remove events.
  await select(session);
  await emit(events);
  await expectTiles([globalRemoved.name, kept.name]);
  assert.equal(await page.locator(".file-preview-modal").count(), 0);

  // The already-mounted global file list also consumes removals without refetching.
  await page.getByRole("button", { name: "文件空间", exact: true }).click();
  await page
    .getByRole("button", { name: globalRemoved.name, exact: true })
    .click();
  await page.getByText("retained content", { exact: true }).waitFor();
  const listRequestsBeforeRemoval = fileListRequests;
  currentFiles = [kept];
  const globalRemoval = {
    ...events[1],
    sequence: 6,
    data: { artifact: globalRemoved },
  };
  events.push(globalRemoval);
  await emit([globalRemoval]);
  await page
    .locator(".file-preview-modal")
    .waitFor({ state: "detached", timeout: 2000 });
  await page
    .getByRole("button", { name: globalRemoved.name, exact: true })
    .waitFor({ state: "detached", timeout: 2000 });
  await page.getByRole("button", { name: kept.name, exact: true }).waitFor();
  assert.equal(
    fileListRequests,
    listRequestsBeforeRemoval,
    "Removal does not restart the global list request",
  );
  await page.screenshot({ path: `${artifacts}/removed-global-live.png` });

  // Completed-run JSON history keeps the audit trail but uses the current file list.
  runStatus = "completed";
  await page.reload();
  await page
    .locator(".session-select")
    .filter({ hasText: session.title })
    .click();
  await expectTiles([kept.name]);
  await page.getByRole("button", { name: "文件空间", exact: true }).click();
  await page.getByRole("button", { name: kept.name, exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: removed.name, exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: otherFile.name, exact: true })
    .waitFor();
  await page.screenshot({ path: `${artifacts}/removed-history-and-files.png` });
  assert.deepEqual(errors, []);
  result = "passed";
  console.log(
    "PASS: live artifact removal closes preview, updates workspace, preserves other files/chats, is idempotent, and does not revive during SSE/history replay",
  );
} catch (error) {
  await page.screenshot({ path: `${artifacts}/failure.png` });
  throw error;
} finally {
  writeFileSync(
    `${artifacts}/artifact-removal.json`,
    JSON.stringify(
      {
        result,
        evidence:
          "real Chromium/application UI with authored API/SSE fixtures; not live-provider validation",
        pageErrors: errors,
        auditedEvents: events.map((event) => event.type),
      },
      null,
      2,
    ),
  );
  await browser.close();
}
