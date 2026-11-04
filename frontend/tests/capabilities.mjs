import { chromium } from "playwright";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";

const baseUrl = process.env.FAMSUN_TEST_BASE_URL || "http://127.0.0.1:5173";
const artifactDirectory =
  process.env.FAMSUN_TEST_ARTIFACT_DIR || "../test-results/capabilities";
mkdirSync(artifactDirectory, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const user = {
  id: "capability-admin",
  name: "能力管理员",
  email: "admin@example.com",
  role: "admin",
};
const settings = {
  provider: {
    base_url: "https://api.example.com/v1",
    model: "responses-model",
    api_mode: "responses",
    configured: true,
    compaction_threshold: 32000,
  },
  sandbox: { backend: "docker", available: true },
  limits: { max_upload_mb: 25, max_turns: 20 },
  registration_enabled: true,
};
const definitions = [
  {
    id: "skill1",
    type: "skill",
    name: "数据研判",
    description: "分析生产数据",
    content:
      "# 分析方法\n\n核对输入，记录结论。\n\n![远程图片](https://private-exfil.example/private)",
    enabled: true,
    builtin: true,
    editable: true,
  },
  {
    id: "mcp1",
    type: "mcp",
    name: "业务数据库",
    description: "查询业务指标",
    url: "https://tools.example.com/mcp",
    token_env: "MCP_REPORT_TOKEN",
    enabled: true,
    editable: true,
  },
];
const json = (route, value, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
let role = "admin";
let settingsPayload;
let remoteRequests = 0;
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on("request", (request) => {
  if (request.url().includes("private-exfil.example")) remoteRequests++;
});
const failures = [];
page.on("pageerror", (error) => failures.push(error.message));
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method();
  if (path === "/api/auth/me") return json(route, { ...user, role });
  if (path === "/api/sessions") return json(route, []);
  if (path === "/api/settings") {
    if (method === "PATCH") {
      settingsPayload = request.postDataJSON();
      Object.assign(settings.provider, settingsPayload);
    }
    return json(route, settings);
  }
  if (path === "/api/extensions")
    return json(route, {
      skills: definitions.filter((x) => x.type === "skill"),
      mcp_servers: definitions.filter((x) => x.type === "mcp"),
      subagents: definitions.filter((x) => x.type === "subagent"),
    });
  const parts = path.split("/").filter(Boolean);
  if (parts[1] === "extensions") {
    if (method === "POST" || (method === "PATCH" && parts.length === 4)) {
      const payload = request.postDataJSON();
      if (payload.content === "FAIL")
        return json(route, { detail: "技能内容验证失败" }, 422);
      const type = { skills: "skill", mcp: "mcp", subagents: "subagent" }[
        parts[2]
      ];
      const definition =
        method === "POST"
          ? {
              id: `created-${definitions.length}`,
              type,
              enabled: true,
              editable: true,
            }
          : definitions.find((x) => x.id === parts[3]);
      if (type === "subagent") {
        const { name, description, ...config } = payload;
        Object.assign(definition, { name, description, config });
      } else Object.assign(definition, payload);
      if (method === "POST") definitions.push(definition);
      return json(route, definition);
    }
    const definition = definitions.find((x) => x.id === parts[2]);
    if (method === "PATCH") Object.assign(definition, request.postDataJSON());
    if (definition) return json(route, definition);
  }
  return json(route, []);
});

try {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "能力中心", exact: true }).click();
  await page.getByRole("button", { name: "查看 数据研判" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "删除 数据研判" }).count(),
    0,
    "builtins cannot be deleted",
  );
  await page.getByRole("switch", { name: "停用 数据研判" }).click();
  await page.getByRole("switch", { name: "启用 数据研判" }).waitFor();
  assert.equal(definitions[0].enabled, false);
  await page.getByRole("button", { name: "查看 数据研判" }).click();
  const detail = page.getByRole("dialog", { name: "数据研判", exact: true });
  await detail.getByRole("button", { name: "预览", exact: true }).click();
  await detail.getByRole("heading", { name: "分析方法" }).waitFor();
  assert.equal(remoteRequests, 0);
  await detail.getByRole("button", { name: "编辑配置" }).click();
  const skillEditor = page.getByRole("dialog", { name: "编辑技能" });
  await skillEditor.getByRole("button", { name: "源码", exact: true }).click();
  await skillEditor.getByLabel("技能内容", { exact: true }).fill("FAIL");
  await skillEditor.getByRole("button", { name: "保存配置" }).click();
  await skillEditor.getByRole("alert").getByText("技能内容验证失败").waitFor();
  await skillEditor
    .getByLabel("技能内容", { exact: true })
    .fill("# 新方法\n核对数据来源。");
  await skillEditor.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("已保存「数据研判」").waitFor();
  assert.equal(definitions[0].content, "# 新方法\n核对数据来源。");
  await page.getByRole("tab", { name: /MCP 连接/ }).click();
  await page.getByRole("button", { name: "编辑 业务数据库" }).click();
  const mcp = page.getByRole("dialog", { name: "编辑连接" });
  assert.equal(
    await mcp.getByLabel("MCP 服务地址").inputValue(),
    "https://tools.example.com/mcp",
  );
  await mcp.getByLabel(/访问令牌环境变量/).fill("");
  await mcp.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("已保存「业务数据库」").waitFor();
  assert.equal(
    definitions[1].token_env,
    null,
    "clearing credentials sends null",
  );
  await page.getByRole("tab", { name: /子代理/ }).click();
  await page
    .getByRole("button", { name: "添加子代理", exact: true })
    .first()
    .click();
  const child = page.getByRole("dialog", { name: "添加子代理", exact: true });
  await child.getByLabel("子代理名称").fill("数据分析师");
  await child.getByLabel("用途描述").fill("独立核对与分析表格");
  await child
    .getByLabel("任务指引", { exact: true })
    .fill("验证表格数据，并交回结论与产物路径。");
  await child.getByLabel("使用模型").fill("specialist-model");
  await child.getByLabel("最大执行轮数").fill("12");
  await child.getByRole("checkbox", { name: /数据研判/ }).check();
  await child.getByRole("checkbox", { name: /业务数据库/ }).check();
  await child.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("button", { name: "查看 数据分析师" }).waitFor();
  assert.deepEqual(definitions[2].config, {
    instructions: "验证表格数据，并交回结论与产物路径。",
    model: "specialist-model",
    max_turns: 12,
    skill_ids: ["skill1"],
    mcp_server_ids: ["mcp1"],
  });
  await page.reload();
  await page.getByRole("button", { name: "能力中心", exact: true }).click();
  await page.getByRole("tab", { name: /子代理/ }).click();
  await page.getByRole("button", { name: "查看 数据分析师" }).click();
  const saved = page.getByRole("dialog", { name: "数据分析师", exact: true });
  assert.equal(
    await saved.getByLabel("使用模型").inputValue(),
    "specialist-model",
  );
  assert.equal(await saved.getByLabel("最大执行轮数").inputValue(), "12");
  await saved.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "工作台设置" });
  assert.equal(await settingsDialog.getByRole("combobox").count(), 0);
  await settingsDialog.getByLabel("压缩触发阈值（token）").fill("48000");
  await settingsDialog.getByRole("button", { name: "保存设置" }).click();
  await settingsDialog.getByText("设置已保存").waitFor();
  assert.equal(settingsPayload.api_mode, "responses");
  assert.equal(settingsPayload.compaction_threshold, 48000);
  await settingsDialog
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.screenshot({
    path: `${artifactDirectory}/capabilities-sdk.png`,
    fullPage: true,
  });

  role = "member";
  await page.reload();
  await page.getByRole("button", { name: "能力中心", exact: true }).click();
  await page.getByRole("button", { name: "查看 数据研判" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "编辑 数据研判" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "添加技能", exact: true }).count(),
    0,
  );
  await page.getByRole("tab", { name: /技能/ }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page
      .getByRole("tab", { name: /MCP 连接/ })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.getByRole("button", { name: "查看 业务数据库" }).click();
  assert.equal(
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "编辑配置" })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("dialog")
      .getByLabel("MCP 服务地址")
      .getAttribute("readonly"),
    "",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator(".sidebar.sidebar-open").count()) {
    await page.getByRole("button", { name: "收起导航" }).click();
  }
  await page.getByRole("button", { name: "查看 业务数据库" }).click();
  await page.getByRole("dialog", { name: "业务数据库", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "mobile detail must not overflow",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "mobile must not overflow",
  );
  await page.screenshot({
    path: `${artifactDirectory}/capabilities-mobile-sdk.png`,
    fullPage: true,
  });
  assert.deepEqual(failures, []);
  console.log(
    "PASS: capability CRUD payloads/persistence, save errors, builtin protections, member read-only, personal toggles, safe Markdown preview, subagent scope, Responses/compaction settings, keyboard tabs and mobile overflow (mock API)",
  );
} catch (error) {
  await page.screenshot({
    path: `${artifactDirectory}/capabilities-test-failure.png`,
    fullPage: true,
  });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
