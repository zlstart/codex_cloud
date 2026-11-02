# 交付验证记录

验证日期：2026-10-30。以下记录来自实际执行，模型供应商的真实凭据尚未配置。

| 检查 | 结果与范围 |
| --- | --- |
| Python 测试 | 46 项通过，包含 PostgreSQL 集成 |
| Python 静态检查 | `ruff check backend tests` 通过 |
| 前端生产构建 | TypeScript 检查和 Vite 打包通过 |
| 浏览器回归 | 移动端布局、会话切换竞态、外部图片阻止、授权产物链接与历史工具记录通过 |
| 实际网页业务流程 | 注册/登录、CSV 上传与预览、缺少模型配置提示、Skill 创建/停用、刷新持久化通过 |
| 两账号隔离 | 跨账号会话、文件返回 404；普通账号修改模型配置返回 403 |
| 模型协议 | 实际 Agents SDK + 本地 HTTP fixture 验证 Chat Completions、Responses 流式协议和工具循环 |
| MCP 审批 | 实际 SDK 原生中断/恢复机制，批准与拒绝均验证；远程 MCP 传输使用测试替身 |
| 实际 Docker 执行 | CSV → pandas → Excel / PNG；非 root、只读根目录和上传目录、无网络、无模型密钥、取消和超时通过 |
| PostgreSQL | 用户、中文文件、置顶、能力偏好、应用重启后的持久化通过 |
| 完整浏览器链路 | 浏览器上传 → 持久化任务 → 实际 SDK → 本地模型协议 fixture → 真实 Docker 分析 → 文件登记 → SSE 刷新回放 → 预览与历史执行记录通过 |
| 镜像 | `famsun-sandbox:latest` 和 `famsun-agent:latest` 构建成功；应用镜像非 root、只读根目录启动，`/health` 正常 |

完整链路使用合成 CSV，产量 120 + 100 + 240 = 460。报告、Excel 和 PNG 是真实生成的文件；测试服务只提供确定性的模型协议响应，没有调用外部大模型。

## 可复现检查

```bash
uv sync --frozen
uv run ruff check backend tests
uv run pytest -q
cd frontend
npm ci
npm run build
```

PostgreSQL 测试默认跳过。设置 `FAMSUN_TEST_DATABASE_URL` 可启用；数据库名须以 `_test` 或 `_qa` 结尾。该数据库必须专用于测试，测试会清空应用表。

真实 Docker 验证：

```bash
docker build -t famsun-sandbox:latest sandbox
PYTHONPATH=backend uv run python tests/docker_smoke.py
```

浏览器回归的启动和浏览器安装方式见 [前端验证说明](../frontend/README.md)。GitHub Actions 配置会自动运行后端、PostgreSQL、前端构建和浏览器回归。

## 需要在目标环境完成的验证

- 实际模型服务的凭据、协议支持、上下文长度、工具调用与视觉能力。
- 企业真实 MCP 服务、令牌权限、网络策略和写操作幂等性。
- 目标并发量下的负载、备份恢复、HTTPS/域名及运维告警。

当前默认部署是单应用进程。企业 SSO、持久分布式任务队列、多实例运行器和微虚拟机隔离未在本版本实现；具体边界见 [架构说明](ARCHITECTURE.md)。
