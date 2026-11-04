# SQLite、工作空间展示与 OpenAI Traces 验证

日期：2026-11-03。基于 SDK 重构分支提交 `4f5a331332ece3fdb1ede08a9e717dbe1d96ddea`。

## 实际执行结果

| 检查 | 结果 |
| --- | --- |
| `.venv/bin/ruff check backend tests` | 通过 |
| `.venv/bin/pytest -q` | 139 项通过 |
| `.venv/bin/uv lock --check --offline` | 通过，65 个解析包 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过；PDF 分块仍有大于 500 kB 的体积提示 |
| `npm run test:ui` | Chromium 页面回归通过 |
| `npm run test:timeline` | 11 项归约测试及实时/回放/恢复页面流程通过 |
| `npm run test:capabilities` | 能力编辑与权限界面流程通过 |
| `npm run test:previews` | 6 项数据测试及桌面/手机预览流程通过 |
| `npm run test:rendering` | 6 项工具/文件链接测试及代码/工具展示流程通过 |
| Compose 配置检查 | 仅应用服务，SQLite 默认落入挂载的 DATA_DIR，无数据库服务/命名卷 |
| `git diff --check` | 通过 |

浏览器测试使用真实 Chromium 和确定性的 API/SSE 测试数据；不是实时模型或线上追踪服务的验收。检查了桌面与 390px 手机视口截图，代码高亮、缩进、复制/下载/关闭按钮以及内容滚动显示正常。

## 覆盖行为

- SQLite 配置拒绝不支持的数据库/驱动；错误不泄露 URL 中的凭据。验证默认文件位置、旧表增量迁移、认证/文件/偏好重启持久化、外键、WAL 和四线程并发写入。
- 工作空间全部文件/已上传/生成成果筛选、数量、空状态、键盘切换。文件预览涵盖表格、PDF、DOCX、图片、隔离 HTML、Markdown 与源码切换、代码/JSON 高亮、UTF-16、二进制拒绝、重试、截断与移动布局。
- Markdown、工具详情和代码文件共用高亮组件；验证原文复制、未知语言回退、HTML 注入防护、长输出尾部保留、终端退出码、后台任务状态、补丁、JSON 与错误结果。
- SDK 原生追踪通过内存 processor 和确定性的 Responses 协议验证：独立模型/追踪密钥、稳定运行 ID、会话分组、并行隔离、审批恢复、关闭/缺失密钥、敏感内容策略、流式运行、异常/取消生命周期。真实工作线程桥接与 API 测试验证追踪事件仅向所属用户提供。
- SDK MCP `is_error` 通过允许的自定义状态字段进入持久事件；不转存私有 MCP 元数据。工具输出截断保留明确提示，文件内容块仅保留文件名/ID，不保存内联字节。

## 验证边界

当前环境没有 `OPENAI_TRACING_API_KEY` 或 `OPENAI_API_KEY`，未执行真实 OpenAI Traces 上报。启用需设置 `AGENT_TRACING_ENABLED=true` 和独立 OpenAI 项目密钥后重启，详见 [追踪指南](../../../guides/TRACING.md)。第三方模型继续使用既有 `AGENT_*` 配置。

SDK 0.24 原生 Responses 追踪导出关联 ID/用量，OpenAI 无法读取第三方服务保存的完整模型响应；本次未增加自定义内容导出。SDK 后台批量发送与进程退出时刷新负责交付，界面“已启用”不等同于服务端已接收。

本次未重建 Docker 镜像或执行真实模型请求；现有供应商/Docker 历史验证报告不代表本次重新执行。
