import assert from "node:assert/strict";
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

// Authored fixtures exercise isolation and large markup. They are not live model output.
const baseUrl = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173";
const baseline = process.env.FAMSUN_PREVIEW_BASELINE === "1";
const name = "authored-interactive-fixture.html";
const html = `<!doctype html><html><head id="preview-head" lang="zh-CN" data-preview="fixture"><script>window.cspViolations=[];document.addEventListener('securitypolicyviolation',event=>window.cspViolations.push(event.effectiveDirective));fetch('https://blocked-preview.example/early').catch(()=>{});</script><style>body{font-family:sans-serif;padding:24px;background:#eff7f4}button{padding:12px}#board{width:300px;height:160px;background:#183b32;color:white;padding:20px}</style></head><body>
<h1>Authored interactive preview fixture</h1><p>This is a regression fixture, not model-generated acceptance evidence.</p>
<button id="start" onclick="document.querySelector('#status').textContent='Running';document.querySelector('#board').style.background='#225f44'">Start</button>
<p id="status">Waiting</p><div id="board">Sandbox game surface</div>
<p id="generated">Not initialized</p><canvas id="plot" width="40" height="20"></canvas>
<input id="sample" type="range" min="0" max="1" value="0" aria-label="Sample">
<button id="reset">Reset sample</button>
<canvas id="layout-plot" style="display:block;width:100%;aspect-ratio:2/1"></canvas>
<script type="application/json" id="fixture-data">{"rows":[6,12,18],"label":"<b>sample</b>"}</script>
<script>
window.renderSample=(value)=>{
  document.querySelector('#generated').innerHTML='<strong>'+value+'</strong>';
  const context=document.querySelector('#plot').getContext('2d');
  context.clearRect(0,0,40,20);context.fillStyle='#225f44';context.fillRect(0,0,value,20);
};
</script>
<script>
const samples=JSON.parse(document.querySelector('#fixture-data').textContent).rows;
const slider=document.querySelector('#sample');slider.max=String(samples.length-1);
slider.addEventListener('input',()=>window.renderSample(samples[Number(slider.value)]));
document.getElementById('reset').addEventListener('click',()=>{slider.value='0';window.renderSample(samples[0]);});
window.renderSample(samples[0]);
const layoutPlot=document.getElementById('layout-plot');
function resizePlot(){const bounds=layoutPlot.getBoundingClientRect();layoutPlot.width=Math.max(1,Math.round(bounds.width));layoutPlot.height=Math.max(1,Math.round(bounds.height));}
window.addEventListener('resize',resizePlot);resizePlot();
</script>
<!--${"bounded markup ".repeat(21000)}--><p id="tail">Complete HTML tail</p>
<script>window.fixtureScriptRan=true;try{parent.document.body.dataset.previewEscape='yes'}catch{window.parentBlocked=true}
window.tryExternal=()=>{fetch('https://blocked-preview.example/fetch').catch(()=>{});const image=new Image();image.src='https://blocked-preview.example/image';const frame=document.createElement('iframe');frame.src='https://blocked-preview.example/frame';document.body.append(frame);};
window.tryNavigation=()=>{location.href='https://blocked-preview.example/navigate';};
</script></body></html>`;
const now = new Date().toISOString();
const file = {
  id: "interactive",
  name,
  mime_type: "text/html",
  kind: "output",
  session_id: "fixture",
  size: Buffer.byteLength(html),
  created_at: now,
  url: "/api/files/interactive/content",
};
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const remoteRequests = [];
const diagnostics = [];
page.on("console", (entry) => {
  if (entry.type() === "error") diagnostics.push(entry.text());
});
page.on("pageerror", (error) => diagnostics.push(error.message));
await page.context().route("https://blocked-preview.example/**", (route) => {
  remoteRequests.push(route.request().url());
  return route.abort();
});
const json = (route, value) =>
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(value),
  });
await page.route("**/api/**", (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/auth/me")
    return json(route, {
      id: "fixture-user",
      name: "Fixture user",
      email: "fixture@example.test",
      role: "admin",
    });
  if (path === "/api/sessions") return json(route, []);
  if (path === "/api/settings")
    return json(route, {
      provider: { configured: false, api_mode: "responses", model: "fixture" },
      sandbox: { backend: "docker", available: true },
      limits: { max_upload_mb: 25, max_turns: 20 },
      registration_enabled: true,
    });
  if (path === "/api/files") return json(route, [file]);
  if (path === file.url)
    return route.fulfill({ contentType: "text/html", body: html });
  return route.fulfill({ status: 404, body: "Unknown fixture route" });
});
try {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "文件空间", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
  const frame = page.frameLocator(`iframe[title="${name}"]`);
  await frame
    .getByRole("heading", { name: "Authored interactive preview fixture" })
    .waitFor();
  if (baseline) {
    const result = {
      fixture: true,
      source: "authored regression fixture; not live model output",
      startButton: await frame.locator("#start").count(),
      completeTail: await frame.locator("#tail").count(),
      sandbox: await page
        .locator(`iframe[title="${name}"]`)
        .getAttribute("sandbox"),
    };
    await page.screenshot({
      path: "/tmp/famsun-interactive-fixture-before.png",
    });
    writeFileSync(
      "/tmp/famsun-interactive-fixture-before.json",
      JSON.stringify(result, null, 2),
    );
    console.log("Authored fixture baseline", result);
  } else {
    assert.equal(
      await page.locator(`iframe[title="${name}"]`).getAttribute("sandbox"),
      "allow-scripts",
    );
    await frame.getByText("Complete HTML tail", { exact: true }).waitFor();
    const child = page.frames().find((value) => value.url() === "about:srcdoc");
    await child.waitForFunction(() => window.fixtureScriptRan === true);
    assert.equal(
      await child.evaluate(() =>
        document.head.firstElementChild?.getAttribute("http-equiv"),
      ),
      "Content-Security-Policy",
      "Attributed head must receive CSP before any user script executes",
    );
    await child.waitForFunction(() =>
      window.cspViolations.includes("connect-src"),
    );
    const dimensions = await frame.locator("#layout-plot").evaluate((node) => ({
      width: node.width,
      height: node.height,
      rect: node.getBoundingClientRect().toJSON(),
    }));
    assert.ok(
      dimensions.width > 100 && dimensions.height > 50,
      `Responsive canvas must initialize with a real iframe viewport: ${JSON.stringify(dimensions)}`,
    );
    assert.equal(
      await frame.locator("#generated").textContent(),
      "6",
      "Inline HTML templates and JSON data must survive sanitization in script order",
    );
    assert.equal(await frame.locator("#sample").getAttribute("max"), "2");
    assert.equal(
      await child.evaluate(
        () =>
          JSON.parse(document.querySelector("#fixture-data").textContent).label,
      ),
      "<b>sample</b>",
    );
    await frame.getByRole("slider", { name: "Sample" }).focus();
    await frame.getByRole("slider", { name: "Sample" }).press("End");
    await frame.getByText("18", { exact: true }).waitFor();
    assert.equal(
      await child.evaluate(
        () =>
          document
            .querySelector("#plot")
            .getContext("2d")
            .getImageData(17, 1, 1, 1).data[3],
      ),
      255,
      "Template-backed script must update the canvas after interaction",
    );
    await frame
      .getByRole("button", { name: "Reset sample", exact: true })
      .click();
    await frame.getByText("6", { exact: true }).waitFor();
    assert.equal(await frame.locator("#sample").inputValue(), "0");
    await frame.getByRole("button", { name: "Start", exact: true }).click();
    await frame.getByText("Running", { exact: true }).waitFor();
    assert.equal(await child.evaluate(() => window.fixtureScriptRan), true);
    assert.equal(await child.evaluate(() => window.parentBlocked), true);
    assert.equal(
      await page.evaluate(() => document.body.dataset.previewEscape),
      undefined,
    );
    await page.screenshot({
      path: "/tmp/famsun-interactive-fixture-after.png",
    });
    await child.evaluate(() => window.tryExternal());
    await child.evaluate(() => window.tryNavigation());
    await page.waitForTimeout(200);
    assert.equal(remoteRequests.length, 0, remoteRequests.join("\n"));
    assert.ok(!child.url().includes("blocked-preview.example"));
    console.log(
      "PASS authored fixture: inline scripts/events and full bounded HTML; opaque parent isolation; fetch/images/frames/self-navigation blocked before network",
    );
  }
} catch (error) {
  await page.screenshot({ path: "/tmp/famsun-interactive-failure.png" });
  const child = page.frames().find((frame) => frame.url() === "about:srcdoc");
  if (child)
    console.error(
      await child.evaluate(() => ({
        status: document.querySelector("#status")?.textContent,
        handler: document.querySelector("#start")?.getAttribute("onclick"),
        script: window.fixtureScriptRan,
      })),
    );
  console.error(diagnostics);
  throw error;
} finally {
  await browser.close();
}
