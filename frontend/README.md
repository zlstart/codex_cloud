# 丰尚智能工作台 · 前端

React 19、TypeScript、Vite，使用 FastAPI 的鉴权 Cookie 与持久化 SSE 事件。

```sh
npm ci
npm run dev
```

开发地址为 `http://localhost:5173`，`/api` 代理到 `http://127.0.0.1:8000`。
生产构建执行 `npm run build`，输出至 `dist/`，由后端统一提供服务。

## 验证

```sh
npm run typecheck
npm run build
# 另一个终端先运行 npm run dev
npm run test:ui
```

浏览器回归使用明确的测试 API 数据，覆盖发送请求期间切换会话的状态隔离、远程 Markdown 图片阻断、受保护文件的内联预览、持久化执行记录与手机布局；不调用真实模型。

默认使用系统 `/usr/bin/chromium`，也可运行 `npx playwright install chromium` 下载浏览器。可通过 `CHROMIUM_EXECUTABLE_PATH` 指定浏览器，通过 `FAMSUN_TEST_BASE_URL` 指定测试站点地址。

### 真实部署验收（独立测试数据库）

`test:deployment` 不拦截 API、不模拟模型回答。它在真实部署中创建两个临时测试账号，检查浏览器注册、退出与登录、CSV 上传/预览/下载、Skills 偏好、账号权限隔离、刷新恢复和手机操作。

必须使用**空的、可丢弃的专用数据库与文件目录**，设置 `ALLOW_REGISTRATION=true`，启动后端并完成前端构建。不要对生产数据运行。测试不会发出模型请求；模型能力必须另外进行真实服务验收。

```sh
FAMSUN_DISPOSABLE_DEPLOYMENT=1 FAMSUN_TEST_BASE_URL=http://127.0.0.1:8000 npm run test:deployment
# 重启同一部署的 API 进程，再运行：
FAMSUN_DISPOSABLE_DEPLOYMENT=1 FAMSUN_TEST_BASE_URL=http://127.0.0.1:8000 npm run test:deployment-restart
```

截图与结果默认写到被 Git 忽略的 `test-results/deployment/`，可通过 `FAMSUN_TEST_OUTPUT` 指定路径。该目录的 `admin-state.json` 含临时登录令牌（权限 0600），仅供重启验收使用；**不能发布、提交或作为报告附件**。测试账号留在测试数据库中，验收后应销毁专用测试数据库与目录，或在隔离实例中保留以便复核。不要把测试账号用于生产访问。

## 代码结构

- `src/App.tsx`：工作台视图组合。
- `src/lib/useWorkspace.ts`：账号、会话和文件的状态与异步操作；请求完成时校验账号和会话版本。
- `src/lib/useRunStream.ts`：SSE 回放、断线重连、审批、计划与实时工具事件。
- `src/components/`：对话、文件预览、能力管理、设置与登录。
- `src/styles/`：统一视觉样式与响应式布局。

HTML 预览使用 DOMPurify、严格 CSP 与无权限 iframe sandbox；Markdown 不自动加载外部图片。所有文件访问均经过后端身份与归属校验。
