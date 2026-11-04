// Actual second UI turn; compares unchanged first-round artifact bytes independently.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
assert.equal(
  process.env.FAMSUN_LIVE_MODEL_TEST,
  "1",
  "Live model submission requires FAMSUN_LIVE_MODEL_TEST=1",
);
const mode = process.argv[2] || "convergence";
const apiOnlyResume = process.env.FAMSUN_RESUME_API_ONLY === "1";
assert.ok(["convergence", "visual", "correction", "print"].includes(mode));
const root = path.resolve(
    process.env.FAMSUN_TEST_OUTPUT || "../test-results/three-body",
  ),
  out = path.join(
    root,
    mode === "print"
      ? "print-final"
      : mode === "visual"
        ? "visual-final"
        : mode === "correction"
          ? "convergence-final"
          : "followup",
  );
await mkdir(out, { recursive: true });
const original = JSON.parse(
  await readFile(path.join(root, "report.json"), "utf8"),
);
assert.ok(["completed", "failed"].includes(original.status));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const ctx = await browser.newContext({
  baseURL: process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8000",
  storageState:
    process.env.FAMSUN_TEST_STORAGE_STATE ||
    "/tmp/famsun-acceptance-admin.json",
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage(),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const save = async (n, v) =>
  writeFile(
    path.join(out, n),
    typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n",
  );
const get = async (u) => {
  const r = await ctx.request.get(u);
  assert.equal(r.status(), 200);
  return r.json();
};
let report;
try {
  report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
} catch {
  report = {
    live_provider: true,
    session_id: original.session_id,
    previous_run_id: original.run_id,
    checks: {},
    browser_errors: [],
  };
}
page.on("pageerror", (e) => report.browser_errors.push(e.message));
const prompt =
  mode === "print"
    ? `请只用1次exec_command工具调用完成最终PNG版式修复：在同一个命令内新建并运行必要的绘图脚本，只读取现有 outputs/three_body.csv 与 outputs/metrics.json（可读convergence_final.json），只新建 outputs/three_body_print.png 与 outputs/render_three_body_print.py。禁止重新积分、禁止修改任何已有文件，尤其CSV/metrics/HTML/既有PNG/收敛JSON全部保持原字节与SHA256。
现有three_body_final.png还存在3个明确缺陷：底部x轴标题与页脚重叠；右下数据来源文字超出右栏边框；E0/L0下标字符显示方框。请从已有1266行CSV重绘，使用ASCII字符串E0、L0、max|dE|/|E0|，不使用Unicode下标；中文字体优先Noto Sans CJK SC，不要对中文强制monospace字体。
布局请严格分配三个互不重叠区域：左侧等比例三体共轨图，右侧有足够内边距的模型/初值/误差简表，底部独立footer行（例如GridSpec两行，footer跨两列，给x轴标题额外bottom留白），所有文字保持在画布内。精简右栏叙述、按实际字体宽度换行；三颗星初值每颗用位置和速度两行，避免长行。右下来源移到底部独立footer也可以。保持三色星体初值/末值/相位标记、真实同一8字轨道，不人为错开，不改变任何数值。
脚本请在savefig前canvas.draw，读取文字renderer bounding boxes，检查右栏文字不越其区域，footer与x轴标题的boxes不相交；必要时在同一个脚本中调整字体/留白后再保存。不要使用任何会重写原成果的main函数。命令应输出数据源SHA256、样本数、图像尺寸、边界检查与所有原文件哈希保持不变的结果。完成后立即结束，不追加工具。
最终简短给出统一Markdown链接：outputs/three_body.csv、outputs/metrics.json、outputs/three_body_final.html、outputs/three_body_print.png、outputs/convergence_final.json，说明只重绘版式、没有重算数据。`
    : mode === "correction"
      ? `请只用1次工具调用完成一个文字勘误，然后结束回复，不进行任何积分或数值重算，不修改任何现有文件。
读取 outputs/convergence.json，仅修改 conclusion.practical_verdict 这一个字符串字段，另存 outputs/convergence_final.json。该句把5.8616e-13误标为h与h/4之差，正确是h/2=0.0005与h/4=0.00025的差；h=0.001与h/2=0.0005之差是8.8081e-12。去掉该句中不正确的相对尺度描述，说明CSV 9位小数舍入约5e-10，dt=0.001对给定初值与时程足够。除此之外保留全部字段、数组、数值和字符串完全一致。写完用对象比较断言只有 conclusion.practical_verdict 不同。
最终请给统一可点击的Markdown链接：outputs/three_body.csv、outputs/metrics.json、outputs/three_body_final.html、outputs/three_body_final.png、outputs/convergence_final.json；说明1266样本，是真实RK4数值模拟而非三体通解，原数据未改变。不要追加任何其他任务或建议。`
      : mode === "visual"
        ? `三体数值与收敛复核已经通过。请仅局部修正视觉问题，最多4个工具调用，基于已有CSV、metrics和HTML，不再进行任何积分，不运行原模拟脚本main，不新增数值计算任务，也不改任何已有文件。
先记录现有成果SHA256，结束时确认不变。只新建 outputs/three_body_final.html、outputs/three_body_final.png 和可选 outputs/refine_visuals.py。
PNG问题：星2初值注释被右侧能量误差inset盖住。请把说明/初值/误差统计放到独立布局区域，完整可读且不覆盖轨迹，保留等比例坐标、单位、三颗不同颜色的初始点/相位和图例。三颗天体共用同一条8字轨道，应诚实标注共轨，不能人为错开物理轨迹。只从已有CSV绘图。
HTML问题：390px手机上HUD盖住星1初始标记，星2右侧初值标签被裁切。请将HUD移出绘图区或放入独立区域，初值标签按左右位置对齐或限定到画布范围，保持中文可读；保留暂停/继续、重置回t=0并暂停、时间滑块，桌面和手机适配。原HTML脚本在脱网浏览器已正常运行，请仅局部改布局/标签，内嵌全部1266行数值必须与原CSV完全相同，不添加外部依赖。
直接交付并结束，最终回复请链接原CSV、原metrics.json、新HTML、新PNG、convergence.json，说明1266样本与数值模拟限制。不要展开额外美化/自检。`
        : `上轮已经实际生成并运行了完整三体成果，但在额外优化PNG时触及900秒运行上限。请沿用成果，在最多6个工具调用内完成以下有界复核并直接给出最终回复，不再美化PNG或HTML，也不要重复运行原脚本的main。
继续刚才的三体任务，沿用上轮的初值、G、质量、积分时间区间和牛顿引力方程，不需要重新询问。可以安全导入既有脚本的积分函数复用，但不能触发原脚本输出重写。
硬性约束：不要修改、重写、重排或重新生成已有 three_body.csv、metrics.json、three_body.html、three_body.png、simulate_three_body.py。先记录这些文件的SHA256，复核结束后再次计算并确认完全一致；只能新建 outputs/convergence.json 和可选 outputs/check_convergence.py。
请实际运行固定步长 RK4 的 h=0.001、0.0005、0.00025 三次独立积分，计算每档 max_relative_energy_error、max_absolute_angular_momentum_error、max_center_of_mass_norm。将三档在 t=0、3.16、6.32、9.48、12.65 的位置/速度与上轮CSV对应时刻比较；记录最大位置与速度绝对差。分析缩小步长后的变化，不要强行声称误差恰好缩小16倍（要考虑舍入误差）。
convergence.json 至少包含 original_run_parameters、source_files_sha256_before、source_files_sha256_after、original_files_unchanged、runs（三档dt及上述误差）、comparison_times、comparison_summary、conclusion。最后给出新JSON链接，说明原文件是否保持一致和实际收敛结论。`;
try {
  if (apiOnlyResume)
    assert.ok(
      report.run_id,
      "API-only resume requires an existing run ID; it cannot submit a model task",
    );
  if (!apiOnlyResume) await page.goto("/");
  let detail = await get(`/api/sessions/${report.session_id}`);
  if (!apiOnlyResume)
    await page
      .locator(".session-select")
      .filter({ hasText: detail.session.title })
      .first()
      .click();
  if (!report.run_id) {
    report.clean_load_browser_errors = [...report.browser_errors];
    assert.equal(
      report.clean_load_browser_errors.length,
      0,
      "Fresh browser load must have no page errors before live submission",
    );
    report.original_files = [];
    for (const f of (mode !== "convergence"
      ? detail.files
      : original.files
    ).filter((f) => f.kind === "output" && !f.name.endsWith(".pyc"))) {
      const r = await ctx.request.get(f.url);
      assert.equal(r.status(), 200);
      const b = await r.body();
      report.original_files.push({
        id: f.id,
        name: f.name,
        url: f.url,
        size: b.length,
        sha256: hash(b),
      });
    }
    await save("prompt.txt", prompt);
    await page.getByLabel("发送给丰尚助手的消息").fill(prompt);
    const pending = page.waitForResponse(
      (r) =>
        /\/api\/sessions\/[^/]+\/runs$/.test(new URL(r.url()).pathname) &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const r = await pending;
    assert.equal(r.status(), 201);
    report.run_id = (await r.json()).id;
    report.submitted_at = new Date().toISOString();
    await save("report.json", report);
    console.log(
      "SUBMITTED_FOLLOWUP " +
        JSON.stringify({
          session_id: report.session_id,
          run_id: report.run_id,
        }),
    );
  }
  let last = 0;
  for (const deadline = Date.now() + 20 * 60 * 1000; Date.now() < deadline;) {
    const state = await get(`/api/runs/${report.run_id}`);
    report.status = state.status;
    report.error = state.error;
    let events = [],
      cursor = 0;
    for (;;) {
      const r = await get(
        `/api/runs/${report.run_id}/timeline?after=${cursor}&limit=1000`,
      );
      events.push(...r.events);
      if (!r.has_more) break;
      assert.ok(r.next_cursor > cursor);
      cursor = r.next_cursor;
    }
    report.event_count = events.length;
    await save("events.json", events);
    await save("run-state.json", state);
    await save("report.json", report);
    if (Date.now() - last > 15000) {
      console.log(`FOLLOWUP_PROGRESS ${state.status} events=${events.length}`);
      last = Date.now();
    }
    if (["completed", "failed", "cancelled"].includes(state.status)) break;
    await page.waitForTimeout(2500);
  }
  detail = await get(`/api/sessions/${report.session_id}`);
  report.answer = detail.messages
    .filter((m) => m.role === "assistant" && m.run_id === report.run_id)
    .map((m) => m.content)
    .join("\n\n");
  report.files = detail.files;
  report.original_file_hash_checks = [];
  for (const f of report.original_files) {
    const r = await ctx.request.get(f.url),
      b = await r.body();
    report.original_file_hash_checks.push({
      name: f.name,
      before_sha256: f.sha256,
      after_sha256: hash(b),
      unchanged: r.status() === 200 && hash(b) === f.sha256,
    });
  }
  report.checks.original_files_unchanged =
    report.original_file_hash_checks.every((f) => f.unchanged);
  for (const f of detail.files.filter(
    (f) =>
      f.kind === "output" &&
      !f.name.endsWith(".pyc") &&
      !report.original_files.some((x) => x.id === f.id),
  )) {
    const r = await ctx.request.get(f.url);
    assert.equal(r.status(), 200);
    await writeFile(path.join(out, path.basename(f.name)), await r.body());
  }
  report.finished_at = new Date().toISOString();
  const terminalState = await get(`/api/runs/${report.run_id}`);
  report.run_updated_at = terminalState.updated_at;
  report.provider_duration_seconds =
    (Date.parse(terminalState.updated_at) - Date.parse(report.submitted_at)) /
    1000;
  if (report.harness_error) {
    (report.harness_error_history ??= []).push(report.harness_error);
    delete report.harness_error;
  }
  report.duration_seconds =
    (Date.now() - Date.parse(report.submitted_at)) / 1000;
  await save("answer.md", report.answer);
  await save("session.json", detail);
  if (!apiOnlyResume)
    await page.screenshot({
      path: path.join(
        root,
        "screenshots",
        mode === "print"
          ? "11-print-final-answer.png"
          : mode === "correction"
            ? "09-final-links.png"
            : mode === "visual"
              ? "08-visual-final-answer.png"
              : "07-followup-final.png",
      ),
      fullPage: true,
    });
  if (apiOnlyResume)
    report.screenshot_pending =
      "Existing run harvested through authenticated API while UI server was unavailable";
  await save("report.json", report);
  console.log(
    "FINISHED_FOLLOWUP " +
      JSON.stringify({
        status: report.status,
        original_files_unchanged: report.checks.original_files_unchanged,
        seconds: report.duration_seconds,
      }),
  );
  if (report.status !== "completed" || !report.checks.original_files_unchanged)
    process.exitCode = 1;
} catch (e) {
  report.harness_error = e.message;
  await save("report.json", report);
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
