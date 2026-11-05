// Real HTTP/browser regression with authored HTML; no model calls or API mocks.
// Run after building the frontend. The backend and accounts are disposable.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
assert.ok(
  existsSync(path.join(root, "frontend/dist/index.html")),
  "Build the frontend first",
);
const directory = await mkdtemp(path.join(tmpdir(), "famsun-download-test-"));
const portProbe = createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const server = spawn(
  process.env.FAMSUN_TEST_PYTHON || path.join(root, ".venv/bin/python"),
  [
    "-c",
    `import sys
from pathlib import Path
import uvicorn
from app.config import Settings
from app.main import create_app
app = create_app(Settings(data_dir=Path(sys.argv[1]), database_url='', sandbox_backend='disabled', api_key='', registration_enabled=True))
uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[2]), log_level='warning')`,
    directory,
    String(port),
  ],
  {
    cwd: root,
    env: { ...process.env, PYTHONPATH: path.join(root, "backend") },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let startupOutput = "";
server.stdout.on("data", (chunk) => {
  startupOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  startupOutput += chunk;
});
const baseURL = `http://127.0.0.1:${port}`;
let browser;
try {
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 20_000;
    const probe = async () => {
      if (server.exitCode !== null)
        return reject(new Error(`Backend exited: ${startupOutput}`));
      if (Date.now() > deadline)
        return reject(new Error(`Backend startup timed out: ${startupOutput}`));
      try {
        if ((await fetch(`${baseURL}/api/auth/status`)).ok) return resolve();
      } catch {
        /* wait for the disposable server */
      }
      setTimeout(probe, 100);
    };
    server.once("error", reject);
    void probe();
  });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_EXECUTABLE_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    args: ["--no-sandbox"],
  });
  const owner = await browser.newContext({ baseURL, acceptDownloads: true });
  const outsider = await browser.newContext({ baseURL });
  const anonymous = await browser.newContext({ baseURL });
  const credentials = {
    email: `${randomUUID()}@example.test`,
    password: randomUUID(),
    name: "Download regression",
  };
  assert.equal(
    (
      await owner.request.post("/api/auth/register", { data: credentials })
    ).status(),
    201,
  );
  assert.equal(
    (
      await outsider.request.post("/api/auth/register", {
        data: { ...credentials, email: `${randomUUID()}@example.test` },
      })
    ).status(),
    201,
  );
  const session = await (
    await owner.request.post("/api/sessions", { data: {} })
  ).json();
  const page = await owner.newPage();
  const network = await owner.newCDPSession(page);
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  const source = Buffer.from(
    '<!doctype html><html><meta charset="utf-8"><body><h1>三体模拟</h1><button onclick="this.textContent=\'已运行\'">运行</button><script>window.fixtureExecuted=true;</script></body></html>',
  );
  for (const surface of ["list", "modal"]) {
    const name = `${surface}-三体模拟 原始文件.html`;
    const uploaded = await owner.request.post(
      `/api/sessions/${session.id}/files`,
      {
        multipart: { file: { name, mimeType: "text/html", buffer: source } },
      },
    );
    assert.equal(uploaded.status(), 201);
    const file = await uploaded.json();
    const url = `${file.url}?download=true`;
    assert.equal((await anonymous.request.get(url)).status(), 401);
    assert.equal((await outsider.request.get(url)).status(), 404);
    const raw = await owner.request.get(file.url);
    assert.match(raw.headers()["content-security-policy"], /sandbox;/);
    assert.ok(
      !raw.headers()["content-security-policy"].includes("allow-scripts"),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "文件空间", exact: true }).click();
    if (surface === "modal") {
      await page.getByRole("button", { name, exact: true }).click();
      assert.equal(
        await page.locator(`iframe[title="${name}"]`).getAttribute("sandbox"),
        "allow-scripts",
      );
      await page
        .frameLocator(`iframe[title="${name}"]`)
        .getByRole("heading", { name: "三体模拟" })
        .waitFor();
    }
    const link = page.getByRole("link", {
      name: surface === "modal" ? "下载文件" : `下载 ${name}`,
      exact: true,
    });
    await network.send("Network.enable");
    await network.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 300,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    const downloadExact = async (label, leave = false) => {
      const pending = page.waitForEvent("download", { timeout: 5_000 });
      await link.click();
      assert.equal(await link.getAttribute("aria-busy"), "true");
      if (leave) {
        if (surface === "modal")
          await page
            .getByRole("button", { name: "关闭弹窗", exact: true })
            .click();
        else
          await page
            .getByRole("button", { name: "生成成果", exact: true })
            .click();
      }
      const result = await pending;
      assert.equal(
        await result.failure(),
        null,
        `${surface}: browser completed download`,
      );
      assert.equal(result.suggestedFilename(), name);
      const saved = path.join(directory, `${surface}-${label}.html`);
      await result.saveAs(saved);
      assert.deepEqual(
        await readFile(saved),
        source,
        `${surface}: exact original HTML bytes`,
      );
      assert.equal(
        page.url(),
        `${baseURL}/`,
        "Download preserves the app page",
      );
      if (leave) {
        if (surface === "modal")
          await page.getByRole("button", { name, exact: true }).click();
        else
          await page
            .getByRole("button", { name: "全部文件", exact: true })
            .click();
      }
    };
    await downloadExact("first");
    await owner.request.post("/api/auth/logout");
    const count = downloads.length;
    await link.click();
    await page
      .getByRole("alert")
      .filter({ hasText: "请先登录工作空间" })
      .waitFor({ timeout: 3_000 });
    assert.equal(
      downloads.length,
      count,
      "Expired authentication must not download an error document",
    );
    assert.equal(page.url(), `${baseURL}/`);
    assert.equal(
      (
        await owner.request.post("/api/auth/login", {
          data: { email: credentials.email, password: credentials.password },
        })
      ).status(),
      200,
    );
    await downloadExact("retry");
    assert.equal(
      await page.getByRole("alert").count(),
      0,
      "Successful retry clears the download error",
    );
    await downloadExact("leave", true);
    assert.equal(
      (await owner.request.delete(`/api/files/${file.id}`)).status(),
      200,
    );
    await link.click();
    await page
      .getByRole("alert")
      .filter({ hasText: /文件不存在|无权/ })
      .waitFor({ timeout: 3_000 });
    assert.equal(
      downloads.length,
      count + 2,
      "Missing files must not download an error document",
    );
    console.log(
      `PASS ${surface}: exact HTML/Chinese filename, expired login and missing-file feedback, retry, pending downloads survive closing/filtering, ownership and sandbox`,
    );
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.pid && server.exitCode === null)
    await new Promise((resolve) => server.once("exit", resolve));
  await rm(directory, { recursive: true, force: true });
}
