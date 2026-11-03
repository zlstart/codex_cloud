// Deterministic regression for progressive model writes; not a live-provider acceptance.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await context.addInitScript(() => {
  window.sources = [];
  window.EventSource = class extends EventTarget {
    constructor() {
      super();
      window.sources.push(this);
    }
    close() {
      this.closed = true;
    }
  };
  window.emitArtifact = (artifact, id) =>
    window.sources
      .filter((source) => !source.closed)
      .forEach((source) =>
        source.dispatchEvent(
          new MessageEvent("artifact.created", {
            data: JSON.stringify({ artifact }),
            lastEventId: String(id),
          }),
        ),
      );
});
const now = "2026-11-03T01:00:00Z";
const session = {
  id: "s-update",
  title: "逐步写入文件",
  created_at: now,
  updated_at: now,
};
const run = {
  id: "r-update",
  session_id: session.id,
  status: "running",
  created_at: now,
  updated_at: now,
};
let content = "value = 1111";
const file = {
  id: "f-update",
  session_id: session.id,
  name: "result.py",
  mime_type: "text/x-python",
  size: content.length,
  kind: "output",
  created_at: now,
  url: "/api/files/f-update/content",
};
const json = (route, data) =>
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(data),
  });
await context.route("**/api/**", (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/auth/me")
    return json(route, { id: "u1", name: "回归测试", role: "admin" });
  if (pathname === "/api/settings")
    return json(route, {
      provider: { model: "fixture", configured: true },
      sandbox: { available: true, backend: "docker" },
      limits: { max_upload_mb: 25 },
    });
  if (pathname === "/api/sessions") return json(route, [session]);
  if (pathname === `/api/sessions/${session.id}`)
    return json(route, {
      session,
      runs: [run],
      files: [file],
      messages: [
        {
          id: "question",
          role: "user",
          content: "生成文件",
          run_id: run.id,
          created_at: now,
        },
      ],
    });
  if (pathname === file.url)
    return route.fulfill({ contentType: "text/plain", body: content });
  return json(route, []);
});
const page = await context.newPage();
try {
  await page.goto(process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173");
  await page
    .locator(".session-select")
    .filter({ hasText: session.title })
    .click();
  await page.waitForFunction(() =>
    window.sources.some((source) => !source.closed),
  );
  await page
    .getByRole("button", { name: "预览 result.py", exact: true })
    .click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".file-preview-modal code")?.textContent ===
      expected,
    content,
  );
  // Corrected bytes can have exactly the same length; timestamp is the revision key.
  content = "value = 2222";
  await page.evaluate((file) => window.emitArtifact(file, 1), {
    ...file,
    created_at: "2026-11-03T01:00:01Z",
  });
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".file-preview-modal code")?.textContent ===
      expected,
    content,
    { timeout: 5000 },
  );
  content += "\n# " + "completed ".repeat(100);
  await page.evaluate((file) => window.emitArtifact(file, 2), {
    ...file,
    size: content.length,
    created_at: "2026-11-03T01:00:02Z",
  });
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".file-preview-modal code")?.textContent ===
      expected,
    content,
    { timeout: 5000 },
  );
  assert.equal(
    await page.locator(".file-tile").count(),
    1,
    "Revision updates replace metadata without duplicate files",
  );
  assert.equal(
    await page.locator(".file-tile-info small").innerText(),
    `${content.length} B · 助手生成`,
  );
  console.log(
    "PASS: open preview follows equal-size revisions and appended content; one updated file card",
  );
} finally {
  await browser.close();
}
