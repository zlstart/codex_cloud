# 新配置真实模型验收（2026-11-02）

本轮从 `09524a8` 拉取既有分支，在新实例重新构建应用、执行镜像与 PostgreSQL。
**真实模型核心链路已通过；尚未交付长期托管或用户可直接访问的公网入口。**
这份记录更新上一轮的模型网络阻塞结论，不把原轮结果当作本轮实测。

## 连通结果与修复

- 新实例实际读取到最新发布配置，出站策略为 `unrestricted/enforced`；三个模型变量均存在。
- 第一次请求到达供应商，返回 HTTP 404 `Not support`，不再是出站代理 403。
- 原因是 `AGENT_BASE_URL` 末尾含 `/responses`，SDK 又追加 `/chat/completions`。
- 使用 `https://dashscope.aliyuncs.com/compatible-mode/v1` 和 `chat_completions` 模式，沿用用户配置的模型与密钥；实际 HTTP 200，输入 `Reply exactly: CONNECTION_OK`，输出 `CONNECTION_OK`。
- 正确根地址已保存到本实例应用设置中，重启后仍有效。没有修改云环境配置或创建密钥。以后新建空数据库时，云配置里的 Base URL 仍应去掉 `/responses`。
- 优化设置页的根地址说明，并拒绝将 `/responses` 或 `/chat/completions` 完整端点保存为 Base URL，给出明确中文错误；已在重建后的应用实测 400 和提示内容。

## 验收矩阵

| 项目 | 本轮结果 | 实际证据 / 边界 |
| --- | --- | --- |
| 应用与沙箱镜像 | 通过 | 实际 Docker 构建；用现有 BuildKit secret 传入代理 CA，保持 TLS 校验 |
| PostgreSQL | 通过 | 独立实例、持久化目录、仅 Unix socket；46 项测试包含独立 famsun_test 集成测试 |
| Python lint、后端测试 | 通过 | 修改后 ruff check backend tests；46 passed、0 skipped |
| TypeScript、生产构建 | 通过 | 修改后 npm run typecheck、npm run build |
| 真实连续对话 | 通过 | 口令记忆两轮：输入 FAMSUN-7319，下一轮准确复述；收到持久化流式文本事件 |
| CSV 分析与模型工具调用 | 通过 | 模型调用真实 Python Docker 工具，按产线汇总 A=360、B=100、总量=460 |
| Excel 生成及下载 | 通过 | 模型生成 summary.xlsx；授权 HTTP 下载；解析 ZIP 内工作表 XML，核对数值 100、360 |
| PNG 生成及下载 | 通过 | 模型生成 production.png；授权下载，PNG 900×600；人工图像检查确认 A=360、B=100 的柱子和标注 |
| Excel 上传与分析 | 通过 | 将下载的 Excel 上传到新会话，模型使用 Python 读取，返回 A=360、B=100、总量=460、最大产线 A |
| 真实模型任务取消 | 通过 | 模型已启动 90 秒 sleep 的 Python 容器后发取消；约 0.03 秒进入 cancelled；随后无遗留执行容器 |
| 任务级超时 | 通过 | 临时部署 AGENT_TIMEOUT_SECONDS=2；真实请求约 1.84 秒进入 failed 并显示任务超时；随后恢复 300 秒 |
| Docker 边界与执行超时 | 通过 | 再次运行 tests/docker_smoke.py：非 root、禁网、只读输入/根目录、无模型密钥、实际取消与执行截止时间 |
| 浏览器真实部署回归 | 通过 | 注册、退出登录、CSV 上传/预览/下载、Skills 偏好、两用户隔离与管理员权限、CSRF、桌面与 390px 手机、无 JS 异常 |
| 真实模型产物浏览器预览 | 通过 | 真实会话的受保护 PNG 解码为 900×600，刷新后仍可预览；没有 mock API |
| 应用与数据库重启恢复 | 通过 | 实际重启 PostgreSQL、删除并用新镜像重建应用容器；Cookie、会话、文件字节、Skills 偏好保留；模型会话分别恢复 6 条和 2 条消息，生成文件仍可下载 |
| 前端组件回归 | 通过 | 最终部署重新跑 test:ui；此脚本使用 API fixture，与上述真实模型验证分开 |
| 企业 MCP / 审批 | 未测 | 未提供实际企业 MCP 配置；不将 fixture 审批测试算作企业服务验收 |
| 公网 HTTPS / 长期托管 | 未完成 | 当前环境未提供端口预览能力，也没有指定目标服务器、域名和持续托管方案 |
| 负载、备份恢复、SSO、运维告警 | 未测 | 仍需在目标企业部署环境验收 |

## 可复核的输入与输出

CSV 输入是专门构造的验收数据，不含业务资料：

```csv
line,output
A,120
B,100
A,240
```

真实模型回答摘录：

> 原始数据共 3 行（A 线 120 + 240，B 线 100），按 line 分组求和后 A = 360、B = 100，总量 460。

另一个会话上传 Excel 后回答最大产线 A、数值 360、总量 460。
验收不只依赖模型回答，还检查实际工具事件、下载字节、Excel XML、PNG 格式、图像内容和浏览器解码。
临时账号、Cookie、数据库、模型完整事件、截图和带内部路径的结果仅保留在被忽略的本地目录，不进入代码仓库。

## 复跑

先按 frontend/README.md 在空的隔离部署执行 test:deployment，再在项目根目录运行：

```bash
FAMSUN_LIVE_MODEL_TEST=1 FAMSUN_TEST_BASE_URL=http://127.0.0.1:8080 \
  uv run python tests/live_model_smoke.py
cd frontend
FAMSUN_TEST_BASE_URL=http://127.0.0.1:8080 node tests/live-model-browser.mjs
```

真实模型脚本主动调用供应商，会产生用量；读取本地 test-results/deployment/admin-state.json，创建测试会话并上传验收文件。
结果保存在同目录 live-model-results.json。浏览器脚本读取结果验证真实 PNG，不模拟模型响应。
取消和任务级 2 秒超时在本轮通过隔离部署专项脚本实测；通用复跑脚本不修改运行中服务的超时配置。

## 当前访问方式与生命周期

运行中的 famsun-app 与 famsun-db 位于本次临时云实例。应用仅监听 127.0.0.1:8080，健康检查通过；**这不是用户浏览器能直接访问的公网地址**。
数据库禁用 TCP，仅能通过权限受限部署目录中的 Unix socket 访问，测试数据落在持久化宿主目录。已关闭后续公开注册。
保留的账号全部是临时验收账号，不应当作生产管理员交付。
实例销毁会影响服务及数据；没有创建收费资源、公开隧道或变更网络权限。需明确长期部署目标后才能完成最终上线。
