# SDK 原生重构验收 · 2026-11-02

项目从 `3998b92` 重构，使用锁定的 Python Agents SDK **0.24.0**。保留 React 19 / TypeScript / Vite 与 FastAPI / SQLAlchemy，将自制模型工具替换为 SDK 能力。本文覆盖本次实测；旧版本验收报告不代表此次实现。

## 已通过

| 验证层 | 实测结果 |
| --- | --- |
| Python | 84 项通过；默认跳过的 2 项 PostgreSQL 测试另在真实 PostgreSQL 17 上通过 |
| 静态与构建 | Ruff、TypeScript、生产前端构建、diff 检查通过；npm audit 无已知漏洞 |
| SDK 协议测试 | Responses 原生工具、完整 Session 历史、返回 compaction 后缩短后续输入、子代理独立历史/权限、原生审批恢复、取消清理 |
| 时间线 | 8 项 reducer 测试；同名并发工具配对、子代理归属、顺序文本/工具、分页重放去重、最终回复独立、失败/取消保留过程 |
| 浏览器 | 能力查看/编辑、成员权限、错误恢复；Excel/MD/HTML/CSV/PDF/DOCX/图片预览、移动端、键盘、HTML 外连阻断、Blob 清理 |
| 异步竞态 | 延迟审批 A 不覆盖后续审批 B；终态刷新失败可自动/手动同步，保留最终文本和输入草稿 |
| API 响应性 | SDK 生命周期使用独立线程池和线程专属事件循环；250 ms 阻塞启停不阻塞 API 心跳，也不占用登录等操作的默认线程池；审批回传主循环，重复/启动前取消等待清理，异常内容保持脱敏 |
| 真实 Docker | 原生命令、PTY、补丁、图像、Skills、Excel/图表、HTTPS 联网；非 root/只读根与上传目录/CPU/内存/PID 限制；跨会话隔离、持久文件、取消/配额终止后清理 |
| 真实应用 | 双账号登录、归属校验、授权上传/下载、刷新与进程重启后的 Cookie/会话/文件/能力偏好保留 |
| 生产包装 | Docker 应用镜像构建；非 root、只读根文件系统下 HTTP/静态资源/上传下载；镜像内 SDK 启动兄弟沙箱并持久读写成功 |
| 旧数据迁移 | SQLite 与 PostgreSQL 扩展表新增 config 列，保留用户/技能正文/禁用偏好，重复迁移幂等 |

## 真实模型结果

使用已配置的 DashScope Responses 端点及 `glm-5.3`，没有使用 Chat Completions：

- 连续两轮记住并复述验收口令。
- 真实读取 CSV，汇总 A=360、B=100、总量 460；生成 XLSX 和 900×600 PNG，下载后校验实际数据和图片字节。
- 新会话上传该 Excel 并再次读取、报告上述数值。
- 主助手使用原生 `as_tool` 委派数据分析助手；子代理调用原生 `apply_patch` 创建文件，再调用 `exec_command` 读取。核验 `NATIVE_SUBAGENT_OK` 文件字节、父子调用 ID、最终回答。
- 重启应用后在浏览器验证真实 Excel/PNG 预览、子代理执行过程和最终正文，未出现浏览器异常。

**原生压缩尚未在此供应商上验证生效。** 两次有界探测均接受 `context_management` 参数，但未返回 `type=compaction`：一次 4049 输入 tokens；一次含较早 assistant/已完成工具结果的流式请求，4362 输入 tokens、阈值 1024。后者返回 reasoning/message，并正确回答标记。这不能证明供应商完全不支持，也不能据此声称已经压缩成功。SDK 压缩处理的协议测试通过；部署时需选用实际返回并接受 compaction item 的服务/模型。

真实企业 MCP 端点未提供，MCP 允许/拒绝和嵌套子代理审批使用 SDK 协议测试验证；不将其描述为真实企业系统联调。

## 复跑

```bash
./scripts/check.sh
PYTHONPATH=backend uv run python tests/docker_smoke.py
# 使用独立、可清空的 PostgreSQL 测试库
FAMSUN_TEST_DATABASE_URL=<test-db-url> uv run pytest -q tests/test_postgres.py
```

启动前端后，在 `frontend/` 执行：

```bash
npm run test:ui
npm run test:timeline
npm run test:capabilities
npm run test:previews
```

上述浏览器回归使用受控接口数据。真实应用/模型验收使用独立数据库，在空验收环境先运行 `test:deployment`；它写入仅本地保存、权限 0600 的认证状态。随后运行：

```bash
FAMSUN_LIVE_MODEL_TEST=1 FAMSUN_TEST_BASE_URL=http://127.0.0.1:8000 uv run python tests/live_model_smoke.py
FAMSUN_LIVE_MODEL_TEST=1 FAMSUN_TEST_BASE_URL=http://127.0.0.1:8000 uv run python tests/live_sdk_features.py
# frontend/，应用重启后
FAMSUN_DISPOSABLE_DEPLOYMENT=1 FAMSUN_TEST_BASE_URL=http://127.0.0.1:8000 npm run test:deployment-restart
FAMSUN_TEST_BASE_URL=http://127.0.0.1:8000 node tests/live-model-browser.mjs
```

原始验收数据在被 Git 忽略的 `test-results/`。密钥、认证状态、数据库和生成产物不提交到仓库。

## 部署限制

- 保持单 API worker / 单应用副本；会话彼此并发，但运行协程和待审批状态属于进程。重启后未完成任务明确标为中断。
- 本次未部署公网服务，也未合并生产分支。
- Excel 为数据预览；DOCX 为正文/表格文本预览，不声称还原 Office 排版。解析受独立进程的时间/内存/解压大小及总单元格限制。
- PDF 库和 worker 按需下载。Vite 报告 PDF 库约 501 kB 原始包体积（约 150 kB gzip）的提示；不进入初始页面主包。
