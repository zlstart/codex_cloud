// Real-provider, authenticated UI acceptance. Never mocks or edits generated outputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
const out = path.resolve(
  process.env.FAMSUN_TEST_OUTPUT || "../test-results/three-body",
);
const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8000";
const state =
  process.env.FAMSUN_TEST_STORAGE_STATE || "/tmp/famsun-acceptance-admin.json";
const title = "真实验收·三体数值轨迹";
const mode = process.argv[2] || "generate";
if (mode === "generate")
  assert.equal(
    process.env.FAMSUN_LIVE_MODEL_TEST,
    "1",
    "Live model submission requires FAMSUN_LIVE_MODEL_TEST=1",
  );
const save = async (n, v) =>
  writeFile(
    path.join(out, n),
    typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n",
  );
const safe = (e) =>
  String(e?.message || e).replace(
    /\b(cookie|authorization|api-key):[^\r\n]*/gi,
    "$1: [redacted]",
  );
const sha = (b) => createHash("sha256").update(b).digest("hex");
const prompt = `请读取已上传的三体初值说明，实际运行数值模拟并交付可核验成果，不能仅画示意图。无需再确认。使用二维牛顿引力方程、G=1，三颗质量均为1；初始位置 r1=(-0.97000436,0.24308753), r2=(0.97000436,-0.24308753), r3=(0,0)，初始速度 v1=v2=(0.466203685,0.43236573), v3=(-0.93240737,-0.86473146)。使用固定步长 RK4，dt=0.001，从 t=0 积分到 t=12.65（含端点），不加软化。请先实际写出并运行计算脚本，再检查所得文件。
必须创建 outputs/three_body.csv：至少1000个等间隔样本（建议每10步导出），CSV列名严格为 t,x1,y1,vx1,vy1,x2,y2,vx2,vy2,x3,y3,vx3,vy3。必须包含初值和终值。
创建 outputs/metrics.json：记录 G、masses、method、dt、t_start、t_end、sample_count、initial_positions、initial_velocities，以及 initial_energy、max_relative_energy_error、initial_angular_momentum、max_absolute_angular_momentum_error、max_center_of_mass_norm、minimum_pair_distance；请从真实积分计算，不能预填示例值。
创建 outputs/three_body.png：等比例 x/y 坐标，三颗星分别着色，图例、轨迹、初值、单位和数值模拟说明。
创建 outputs/three_body.html：能直接离线打开的自包含中文动画，把真实CSV相同采样数据嵌入文件，不引用外部资源。桌面及手机适配；包含“暂停/继续”“重置”按钮和有明确标签的时间滑块，显示当前 t，三颗运动星体和轨迹。暂停时状态不动，继续后时间推进，拖动滑块定位，重置回t=0并暂停。显示初值、数值方法、dt、守恒误差，并说明这是特定初值下的数值模拟而非三体通解。
同时保留 outputs/simulate_three_body.py 以便复现。不要用外部轨迹数据，不要用仅描绘8字曲线的参数化函数替代积分。最后给出四个主要文件的可点击链接、实际样本数及主要守恒误差。`;
await mkdir(path.join(out, "screenshots"), { recursive: true });
await mkdir(path.join(out, "downloads"), { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  baseURL,
  storageState: state,
  acceptDownloads: true,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
let report;
try {
  report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
} catch {
  report = {
    scenario: "three-body",
    title,
    base_url: baseURL,
    live_provider: true,
    started_at: new Date().toISOString(),
    previews: [],
    browser_errors: [],
  };
}
page.on("pageerror", (e) => report.browser_errors.push(safe(e)));
page.on("console", (m) => {
  if (m.type() === "error") (report.console_errors ??= []).push(m.text());
});
const persist = async () => {
  report.updated_at = new Date().toISOString();
  await save("report.json", report);
};
const shot = (n) =>
  page.screenshot({
    path: path.join(out, "screenshots", n + ".png"),
    fullPage: true,
    animations: "disabled",
  });
const get = async (u) => {
  const r = await context.request.get(u);
  assert.equal(r.status(), 200, u);
  return r.json();
};
async function timeline() {
  let a = 0,
    ev = [];
  for (;;) {
    let r = await get(
      `/api/runs/${report.run_id}/timeline?after=${a}&limit=1000`,
    );
    ev.push(...r.events);
    if (!r.has_more) break;
    assert.ok(r.next_cursor > a);
    a = r.next_cursor;
  }
  assert.ok(ev.every((e, i) => !i || e.sequence > ev[i - 1].sequence));
  assert.equal(new Set(ev.map((e) => e.sequence)).size, ev.length);
  return ev;
}
async function openSession() {
  await page.goto("/");
  const d = await get(`/api/sessions/${report.session_id}`);
  await page
    .locator(".session-select")
    .filter({ hasText: d.session.title })
    .first()
    .click();
  await page.getByLabel("发送给丰尚助手的消息").waitFor();
}
async function rename() {
  await page.locator(".session-row.selected").hover();
  await page.locator(".session-row.selected .session-more").click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.getByLabel("对话名称", { exact: true }).fill(title);
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
}
async function preview(file, label, { download = true } = {}) {
  let p = {
    file_name: file.name,
    file_id: file.id,
    label,
    at: new Date().toISOString(),
  };
  try {
    let toggle = page.locator(".workspace-toggle");
    if (!/\bactive\b/.test((await toggle.getAttribute("class")) || ""))
      await toggle.click();
    await page
      .getByRole("button", { name: `预览 ${file.name}`, exact: true })
      .first()
      .click();
    const d = page.getByRole("dialog");
    await d.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector(".preview-body")?.getAttribute("aria-busy") ===
        "false",
    );
    p.run_status_at_open = (await get(`/api/runs/${report.run_id}`)).status;
    p.text = await d.innerText();
    p.alerts = await d.getByRole("alert").allTextContents();
    p.preview_class = await d.locator(".preview-body").getAttribute("class");
    await shot(label);
    if (download) {
      const dl = page.waitForEvent("download");
      await d.getByRole("link", { name: "下载文件", exact: true }).click();
      const item = await dl;
      const target = path.join(out, "downloads", path.basename(file.name));
      await item.saveAs(target);
      let b = await readFile(target);
      const r = await context.request.get(file.url);
      assert.equal(r.status(), 200);
      let api = await r.body();
      p.download = {
        path: target,
        bytes: b.length,
        sha256: sha(b),
        api_sha256: sha(api),
        identical_to_api: b.equals(api),
        matches_metadata_size: b.length === file.size,
      };
    }
  } catch (e) {
    p.error = safe(e);
    await shot(label + "-failure").catch(() => {});
  } finally {
    report.previews.push(p);
    await persist();
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog")
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {});
  }
  return p;
}
async function generate() {
  await save("prompt.txt", prompt);
  if (!report.run_id) {
    await page.goto("/");
    await page.getByRole("button", { name: /新建对话/ }).click();
    await save(
      "three_body_seed.txt",
      "三体数值模拟验收输入。G=1, m1=m2=m3=1；r1=(-0.97000436,0.24308753), r2=(0.97000436,-0.24308753), r3=(0,0)；v1=v2=(0.466203685,0.43236573), v3=(-0.93240737,-0.86473146)。这是真实积分请求，不接受示意图。\n",
    );
    const created = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/sessions" &&
        r.request().method() === "POST",
    );
    await page
      .locator('.composer input[type="file"]')
      .setInputFiles(path.join(out, "three_body_seed.txt"));
    let res = await created;
    assert.equal(res.status(), 201);
    report.session_id = (await res.json()).id;
    await page
      .getByText("已上传 1 个文件，可以开始提问了。", { exact: true })
      .waitFor();
    await rename();
    await page.getByLabel("发送给丰尚助手的消息").fill(prompt);
    await shot("01-prompt-and-upload");
    const submitted = page.waitForResponse(
      (r) =>
        /\/api\/sessions\/[^/]+\/runs$/.test(new URL(r.url()).pathname) &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    res = await submitted;
    assert.equal(res.status(), 201);
    let run = await res.json();
    report.run_id = run.id;
    report.submitted_at = new Date().toISOString();
    const s = await get("/api/settings");
    report.provider = {
      model: s.provider.model,
      api_mode: s.provider.api_mode,
    };
    report.limits = s.limits;
    await persist();
    console.log(
      "SUBMITTED " +
        JSON.stringify({
          session_id: report.session_id,
          run_id: report.run_id,
        }),
    );
  } else await openSession();
  let last = 0,
    captured = report.previews.some((p) => p.run_status_at_open === "running");
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    const run = await get(`/api/runs/${report.run_id}`);
    const ev = await timeline();
    report.status = run.status;
    report.error = run.error;
    report.event_count = ev.length;
    await save("events.json", ev);
    await save("run-state.json", run);
    await persist();
    if (!captured && run.status === "running") {
      const d = await get(`/api/sessions/${report.session_id}`);
      let f = d.files.find((f) => f.kind === "upload");
      if (f) {
        let p = await preview(f, "02-running-upload-preview", {
          download: false,
        });
        captured = p.run_status_at_open === "running";
        report.running_preview_proven = captured;
        await persist();
      }
    }
    if (Date.now() - last > 15000) {
      console.log(
        `PROGRESS ${run.status} events=${ev.length} elapsed_s=${Math.round((Date.now() - Date.parse(report.submitted_at)) / 1000)}`,
      );
      last = Date.now();
    }
    if (["completed", "failed", "cancelled"].includes(run.status)) break;
    await page.waitForTimeout(2500);
  }
  let d = await get(`/api/sessions/${report.session_id}`);
  report.files = d.files;
  report.answer = d.messages
    .filter((m) => m.role === "assistant" && m.run_id === report.run_id)
    .map((m) => m.content)
    .join("\n\n");
  report.finished_at = new Date().toISOString();
  report.duration_seconds =
    (Date.now() - Date.parse(report.submitted_at)) / 1000;
  await save("session.json", d);
  await save("answer.md", report.answer);
  await shot("03-final-answer");
  await persist();
  console.log(
    "FINISHED " +
      JSON.stringify({
        status: report.status,
        event_count: report.event_count,
        duration_seconds: report.duration_seconds,
        files: d.files.map((f) => f.name),
      }),
  );
}
async function downloadOutputs() {
  await openSession();
  const d = await get(`/api/sessions/${report.session_id}`);
  report.files = d.files;
  for (const [i, f] of d.files.filter((f) => f.kind === "output").entries())
    await preview(f, `04-output-${i + 1}-${path.extname(f.name).slice(1)}`);
  await persist();
}
try {
  if (mode === "generate") await generate();
  else if (mode === "verify") await downloadOutputs();
  else throw Error("Unknown mode");
} catch (e) {
  report.harness_error = safe(e);
  await persist();
  await shot("harness-failure").catch(() => {});
  console.error(safe(e));
  process.exitCode = 1;
} finally {
  await browser.close();
}
