// Real HTTP/browser acceptance against a disposable deployment. No API mocking.
// Creates two disposable local test accounts; never run on a production database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { chromium } from "playwright";

assert.equal(
  process.env.FAMSUN_DISPOSABLE_DEPLOYMENT,
  "1",
  "Requires disposable deployment opt-in",
);
const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8000";
const output = process.env.FAMSUN_TEST_OUTPUT || "../test-results/deployment";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const admin = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
});
const member = await browser.newContext({ baseURL });
const page = await admin.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const passed = [];
const check = (name) => {
  passed.push(name);
  console.log(`PASS: ${name}`);
};
const password = randomUUID();
const suffix = randomUUID().slice(0, 8);
try {
  await page.goto(baseURL);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const status = await (await admin.request.get("/api/auth/status")).json();
  assert.equal(
    status.has_users,
    false,
    "Start with an empty disposable deployment",
  );
  await page.getByLabel("姓名", { exact: true }).fill("部署验收管理员");
  await page
    .getByLabel("邮箱", { exact: true })
    .fill(`qa-${suffix}@example.com`);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建账号并进入" }).click();
  await page.getByText("部署验收管理员", { exact: true }).waitFor();
  const me = await (await admin.request.get("/api/auth/me")).json();
  assert.equal(me.role, "admin");
  check("browser first administrator registration");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  assert.equal((await admin.request.get("/api/auth/me")).status(), 401);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByLabel("邮箱", { exact: true })
    .fill(`qa-${suffix}@example.com`);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByText("部署验收管理员", { exact: true }).waitFor();
  check("browser logout revokes session and password login succeeds");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "生产验收.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("line,output\nA,120\nB,100\nA,240\n"),
    });
  await page
    .getByRole("button", { name: "预览 生产验收.csv", exact: true })
    .waitFor();
  const files = await (await admin.request.get("/api/files")).json();
  const file = files.find((f) => f.name === "生产验收.csv");
  assert.ok(file);
  await page
    .getByRole("button", { name: "预览 生产验收.csv", exact: true })
    .click();
  await page.getByRole("dialog").getByText("120", { exact: true }).waitFor();
  await page.screenshot({
    animations: "disabled",
    path: `${output}/desktop-preview.png`,
  });
  await page.keyboard.press("Escape");
  const download = await admin.request.get(`${file.url}?download=true`);
  assert.equal(download.status(), 200);
  assert.match(download.headers()["content-disposition"], /attachment/);
  assert.match(await download.text(), /A,240/);
  check("browser CSV upload, tabular preview and authorized download bytes");
  const skillResponse = await admin.request.post("/api/extensions/skills", {
    data: {
      name: "部署验收技能",
      description: "验收",
      content: "核对上传数据后再报告合计。",
    },
  });
  assert.equal(skillResponse.status(), 201);
  const skill = await skillResponse.json();
  assert.equal(
    (
      await admin.request.patch(`/api/extensions/${skill.id}`, {
        data: { enabled: false },
      })
    ).status(),
    200,
  );
  assert.equal(
    (
      await (
        await admin.request.get(`/api/extensions/skills/${skill.id}`)
      ).json()
    ).enabled,
    false,
  );
  check("real skill creation and per-user disabled preference");
  const registered = await member.request.post("/api/auth/register", {
    data: { email: `member-${suffix}@example.com`, password, name: "验收成员" },
  });
  assert.equal(registered.status(), 201);
  assert.equal((await registered.json()).role, "member");
  const sid = file.session_id;
  assert.deepEqual(
    await (await member.request.get("/api/sessions")).json(),
    [],
  );
  assert.deepEqual(await (await member.request.get("/api/files")).json(), []);
  for (const [method, path, data] of [
    ["get", `/api/sessions/${sid}`],
    ["delete", `/api/sessions/${sid}`],
    ["patch", `/api/sessions/${sid}`, { title: "unauthorized" }],
    ["get", file.url],
    ["get", `${file.url}?download=true`],
    ["delete", `/api/files/${file.id}`],
    [
      "post",
      `/api/sessions/${sid}/runs`,
      { content: "unauthorized", client_request_id: randomUUID() },
    ],
  ])
    assert.equal(
      (await member.request[method](path, { data })).status(),
      404,
      `${method} ${path}`,
    );
  assert.equal(
    (
      await member.request.post(`/api/sessions/${sid}/files`, {
        multipart: {
          file: {
            name: "x.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("x"),
          },
        },
      })
    ).status(),
    404,
  );
  assert.equal(
    (
      await member.request.patch("/api/settings", {
        data: { model: "unauthorized" },
      })
    ).status(),
    403,
  );
  assert.equal(
    (await member.request.delete(`/api/extensions/${skill.id}`)).status(),
    403,
  );
  assert.equal(
    (
      await member.request.post("/api/extensions/skills", {
        data: { name: "x", content: "x" },
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await admin.request.post("/api/sessions", {
        data: {},
        headers: { Origin: "https://attacker.example" },
      })
    ).status(),
    403,
  );
  check(
    "two real accounts: list isolation, 8 foreign-resource denials, 3 admin denials and CSRF denial",
  );
  await admin.request.patch(`/api/sessions/${sid}`, {
    data: { title: "部署验收会话", pinned: true },
  });
  await page.reload();
  await page
    .getByRole("button", { name: /部署验收会话/ })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: /部署验收会话/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: "预览 生产验收.csv", exact: true })
    .waitFor();
  await page.screenshot({
    animations: "disabled",
    path: `${output}/desktop-workspace.png`,
  });
  check(
    "refresh preserves authenticated session, pinned conversation and file",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "文件空间", exact: true }).click();
  await page.getByRole("button", { name: "生产验收.csv", exact: true }).click();
  await page.getByRole("dialog").getByText("240", { exact: true }).waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    animations: "disabled",
    path: `${output}/mobile-preview.png`,
  });
  await page.keyboard.press("Escape");
  await page.screenshot({
    animations: "disabled",
    path: `${output}/mobile-files.png`,
  });
  check("390px mobile navigation, file space, preview and no page overflow");
  assert.deepEqual(errors, []);
  check("no browser JavaScript exceptions");
  // Local-only state for a subsequent process-restart probe; never commit it.
  await admin.storageState({ path: `${output}/admin-state.json` });
  await chmod(`${output}/admin-state.json`, 0o600);
  await writeFile(
    `${output}/restart-target.json`,
    JSON.stringify({ sid, file, skillId: skill.id }),
  );
  await writeFile(
    `${output}/results.json`,
    JSON.stringify(
      {
        passed,
        model: "NOT TESTED: requires separately authorized reachable provider",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
