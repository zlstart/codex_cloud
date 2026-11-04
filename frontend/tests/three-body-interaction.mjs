// Playwright checks actual unmodified HTML; reads rendered state, clicks real controls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
const root = path.resolve(
  process.env.FAMSUN_TEST_OUTPUT || "../test-results/three-body",
);
const baseURL = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:8000";
const htmlName = process.env.FAMSUN_THREE_BODY_HTML || "three_body.html";
const htmlDirectory =
  process.env.FAMSUN_THREE_BODY_HTML_DIR || path.join(root, "downloads");
const evidencePrefix = process.env.FAMSUN_THREE_BODY_EVIDENCE_PREFIX || "";
const appViewport = {
  width: Number(process.env.FAMSUN_APP_WIDTH || 1440),
  height: Number(process.env.FAMSUN_APP_HEIGHT || 1000),
};
const report = JSON.parse(
  await readFile(path.join(root, "report.json"), "utf8"),
);
const evidence = {
  browser: "Playwright Chromium",
  browser_plugin_fallback:
    "No callable Browser JavaScript runtime; fallback authorized",
  checks: [],
  errors: [],
  offline_delivery:
    "Chromium administrative policy blocks file://. Unmodified downloaded HTML is loaded with page.setContent while the browser context is offline; this verifies self-contained execution, not direct file:// navigation.",
};
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const save = () =>
  writeFile(
    path.join(root, evidencePrefix + "interaction-verification.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
const hash = (s) => createHash("sha256").update(s).digest("hex");
const snap = async (target) => ({
  range: await target
    .locator("input[type=range]")
    .first()
    .evaluate((n) => ({
      value: Number(n.value),
      min: Number(n.min),
      max: Number(n.max),
    })),
  buttons: await target.getByRole("button").allTextContents(),
  text: (await target.locator("body").innerText()).slice(0, 9000),
  canvases: await target.locator("canvas").evaluateAll((ns) =>
    ns.map((n) => ({
      width: n.width,
      height: n.height,
      data: n.toDataURL(),
    })),
  ),
});
async function actionTest(target, page, label) {
  label = evidencePrefix + label;
  let record = { label };
  evidence.checks.push(record);
  try {
    await target.locator("body").waitFor();
    record.canvas_at_entry = await target
      .locator("canvas")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          width: node.width,
          height: node.height,
          clientWidth: node.clientWidth,
          clientHeight: node.clientHeight,
        })),
      );
    await target.waitForFunction(
      () =>
        [...document.querySelectorAll("canvas")].some(
          (canvas) => canvas.width > 100 && canvas.height > 100,
        ),
      undefined,
      { timeout: 10000 },
    );
    record.canvas_pixels_at_entry = await target
      .locator("canvas")
      .first()
      .evaluate((canvas) => {
        const pixels = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let red = 0,
          blue = 0,
          yellow = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (!pixels[i + 3]) continue;
          if (pixels[i] > 150 && pixels[i + 1] < 130 && pixels[i + 2] < 130)
            red++;
          if (pixels[i + 2] > 150 && pixels[i] < 130) blue++;
          if (pixels[i] > 150 && pixels[i + 1] > 120 && pixels[i + 2] < 130)
            yellow++;
        }
        return {
          red,
          blue,
          yellow,
          width: canvas.width,
          height: canvas.height,
        };
      });
    assert.ok(
      ["red", "blue", "yellow"].every(
        (color) => record.canvas_pixels_at_entry[color] > 5,
      ),
      "Rendered canvas contains all three colored bodies/trajectories",
    );
    await page.screenshot({
      path: path.join(root, "screenshots", label + "-first-view.png"),
      fullPage: target === page,
    });
    record.identity = { title: await target.title(), url: target.url() };
    record.buttons_initial = await target.getByRole("button").allTextContents();
    record.slider_count = await target.locator("input[type=range]").count();
    assert.ok(record.slider_count >= 1, "time slider exists");
    let pause = target.getByRole("button", { name: /暂停/ });
    if (await pause.count()) await pause.first().click();
    await page.waitForTimeout(200);
    let a = await snap(target);
    await page.waitForTimeout(350);
    let b = await snap(target);
    record.pause = {
      before: a.range,
      after: b.range,
      canvas_unchanged:
        JSON.stringify(a.canvases) === JSON.stringify(b.canvases),
    };
    assert.equal(a.range.value, b.range.value, "Paused time stays fixed");
    assert.ok(record.pause.canvas_unchanged, "Paused canvas stays fixed");
    let play = target.getByRole("button", { name: /继续|播放|开始/ });
    assert.ok(await play.count(), "continue exists");
    await play.first().click();
    await page.waitForTimeout(650);
    let c = await snap(target);
    record.continue = {
      before: b.range,
      after: c.range,
      canvas_changed: JSON.stringify(b.canvases) !== JSON.stringify(c.canvases),
    };
    assert.notEqual(c.range.value, b.range.value, "Continue advances time");
    assert.ok(record.continue.canvas_changed, "Continue redraws canvas");
    await target.getByRole("button", { name: /暂停/ }).first().click();
    let slider = target.locator("input[type=range]").first();
    await slider.focus();
    await slider.press("Home");
    for (let i = 0; i < 20; i++) await slider.press("ArrowRight");
    let d = await snap(target);
    record.slider = { before: c.range, after: d.range };
    assert.ok(
      d.range.value > d.range.min,
      "Keyboard interaction seeks forward",
    );
    assert.notEqual(
      d.range.value,
      c.range.value,
      "Slider updates actual state",
    );
    await page.screenshot({
      path: path.join(root, "screenshots", label + "-interaction.png"),
      fullPage: target === page,
    });
    await target.getByRole("button", { name: /重置/ }).first().click();
    let e = await snap(target);
    await page.waitForTimeout(300);
    let f = await snap(target);
    record.reset = {
      before: d.range,
      after: e.range,
      stable: f.range.value === e.range.value,
      canvas_hash: hash(e.canvases[0]?.data || ""),
    };
    assert.equal(e.range.value, e.range.min, "Reset sets t=0");
    assert.equal(e.range.value, f.range.value, "Reset pauses");
    record.body_text = f.text;
    record.canvas_dimensions = f.canvases.map(({ width, height }) => ({
      width,
      height,
    }));
    assert.ok(
      record.canvas_dimensions.length > 0 &&
        record.canvas_dimensions.every((c) => c.width > 100 && c.height > 100),
      "Canvas backing dimensions must render a visible trajectory, not a 1x1 bitmap",
    );
    record.layout = await target.locator("body").evaluate((n) => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    record.passed = true;
    await target.locator("canvas").first().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(root, "screenshots", label + "-reset.png"),
      fullPage: target === page,
    });
  } catch (e) {
    record.passed = false;
    record.error = e.message;
    await target
      .locator("canvas")
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await page
      .screenshot({
        path: path.join(root, "screenshots", label + "-failure.png"),
        fullPage: target === page,
      })
      .catch(() => {});
  }
  await save();
}
try {
  if (process.env.FAMSUN_SKIP_APP_PREVIEW !== "1") {
    const ctx = await browser.newContext({
      baseURL,
      storageState:
        process.env.FAMSUN_TEST_STORAGE_STATE ||
        "/tmp/famsun-acceptance-admin.json",
      viewport: appViewport,
    });
    let page = await ctx.newPage();
    page.on("pageerror", (e) =>
      evidence.errors.push({ surface: "app", error: e.message }),
    );
    await page.goto("/");
    let detail = await (
      await ctx.request.get(`/api/sessions/${report.session_id}`)
    ).json();
    if (appViewport.width < 800)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page
      .locator(".session-select")
      .filter({ hasText: detail.session.title })
      .first()
      .click();
    if (
      appViewport.width < 800 &&
      (await page.locator(".sidebar-scrim").isVisible())
    )
      await page.getByRole("button", { name: "收起导航", exact: true }).click();
    let toggle = page.locator(".workspace-toggle");
    if (!/\bactive\b/.test((await toggle.getAttribute("class")) || ""))
      await toggle.click();
    await page
      .getByRole("button", { name: `预览 ${htmlName}`, exact: true })
      .first()
      .click();
    let iframe = page.getByRole("dialog").locator("iframe");
    await iframe.waitFor();
    let frame = await (await iframe.elementHandle()).contentFrame();
    evidence.app_iframe_sandbox = await iframe.getAttribute("sandbox");
    await actionTest(
      frame,
      page,
      appViewport.width < 800 ? "05-app-html-mobile" : "05-app-html-desktop",
    );
    await page.keyboard.press("Escape");
    for (const button of await page.locator(".process-toggle").all())
      if ((await button.getAttribute("aria-expanded")) === "false")
        await button.click();
    const rendered = await page.locator("[data-call-id]").evaluateAll((ns) =>
      ns.map((n) => ({
        call_id: n.getAttribute("data-call-id"),
        status: n.querySelector(".timeline-tool-status")?.textContent,
        summary: n.querySelector("summary")?.textContent,
      })),
    );
    evidence.rendered_tools = rendered;
    await page.screenshot({
      path: path.join(
        root,
        "screenshots",
        evidencePrefix + "05-ordered-tools.png",
      ),
      fullPage: true,
    });
    await ctx.close();
  } else {
    evidence.app_preview_skipped_reason =
      "UI server unavailable; this invocation checks downloaded HTML offline only";
  }
  for (const [name, width, height] of process.env.FAMSUN_SKIP_OFFLINE === "1"
    ? []
    : [
        ["desktop", 1440, 1000],
        ["mobile", 390, 844],
      ]) {
    const offline = await browser.newContext({
      viewport: { width, height },
      offline: true,
    });
    let p = await offline.newPage();
    p.on("pageerror", (e) =>
      evidence.errors.push({ surface: "offline-" + name, error: e.message }),
    );
    let requests = [];
    p.on("request", (r) => {
      if (/^https?:/.test(r.url())) requests.push(r.url());
    });
    await p.setContent(
      await readFile(path.join(htmlDirectory, htmlName), "utf8"),
      { waitUntil: "load" },
    );
    await actionTest(p, p, "06-offline-" + name);
    evidence.checks.at(-1).external_network_requests = requests;
    await offline.close();
  }
  evidence.overall_pass =
    evidence.checks.every((c) => c.passed) && !evidence.errors.length;
  await save();
  console.log(
    JSON.stringify({
      overall_pass: evidence.overall_pass,
      checks: evidence.checks.map(({ label, passed, error }) => ({
        label,
        passed,
        error,
      })),
      errors: evidence.errors,
    }),
  );
  if (!evidence.overall_pass) process.exitCode = 1;
} catch (e) {
  evidence.harness_error = e.message;
  await save();
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
