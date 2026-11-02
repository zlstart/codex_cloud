# 部署与运维

## 本地开发

需要 Python 3.12+、uv、Node.js 22+ 和 Docker Engine。以有权访问 Docker、且拥有数据目录的非 root 用户运行应用；沙箱使用一致的非 root UID / GID。

```bash
cp .env.example .env
docker build -t famsun-sandbox:latest sandbox
./scripts/dev.sh
```

启动脚本读取 `.env`，安装锁定依赖并启动 API 与 Vite；浏览器打开 `http://localhost:5173`。默认数据位于 `./data`。没有模型密钥仍可管理账号和文件；没有 Docker 时可设置 `SANDBOX_BACKEND=disabled` 调试这些页面，智能体任务不会运行。

首次注册创建管理员。需要开放员工注册时设置 `ALLOW_REGISTRATION=true` 并重启，完成后关闭。

## Docker Compose

使用专用 Linux Docker 主机与 Compose v2。API 通过宿主 Docker 创建兄弟容器，**DATA_DIR 必须在宿主和 API 容器内使用同一个绝对路径**。

1. 复制 `.env.example` 为 `.env`。
2. 设置 `DATA_DIR=/srv/famsun/data`，创建目录并赋予应用用户读写权限。
3. 设置 `FAMSUN_UID` / `FAMSUN_GID` 为该非 root 用户的数字 UID / GID；设置 `DOCKER_GID` 为 `stat -c '%g' /var/run/docker.sock` 的结果。
4. 设置强随机 `POSTGRES_PASSWORD`；用于连接 URL 的值须正确进行 URL 编码，或使用足够长的随机十六进制密码。
5. 填写 Responses 模型地址、模型与密钥，构建并启动。

```bash
docker build -t famsun-sandbox:latest sandbox
docker compose build app
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8080/health
```

Compose 只公开 `127.0.0.1:8080`，数据库没有宿主公开端口。前端静态文件和 API 同源提供。设置 HTTPS 反向代理后配置：

```dotenv
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://agent.example.com
ALLOW_REGISTRATION=false
```

`COOKIE_SECURE=true` 需要 HTTPS。部署后先在受控访问范围创建管理员，再开放入口。保持 **一个 Uvicorn worker、一个应用副本**；当前任务与审批等待属于 API 进程内协程。

## 网络、资源与证书

每个任务使用 SDK `DockerSandboxClient` 创建一个容器，命令、PTY、补丁和图片读取由 SDK 提供。容器绑定当前聊天目录，`uploads/` 额外只读挂载，任务结束后删除容器，聊天文件保留。

网络默认启用。容器根文件系统只读，非 root，移除 capabilities，启用 `no-new-privileges`，限制为 512 MiB 内存、1 CPU、64 进程，文件句柄上限 256，单文件大小上限 50 MiB。私有 `/tmp` 上限 128 MiB，保留 SDK 辅助程序所需的执行权限。资源设置由 `sdk_sandbox.py` 中的创建策略统一维护。

沙箱不挂载模型密钥、SDK 历史、其他聊天或 Docker socket。MCP 域名允许列表不限制普通 Shell 网络请求；如部署需要网络范围限制，应在 Docker 主机或网络层配置。

### 企业 CA 与代理

镜像构建支持可选 BuildKit CA secret：

```bash
docker build --secret id=proxy_ca,src=/path/to/combined-ca.pem -t famsun-sandbox:latest sandbox
docker build --secret id=proxy_ca,src=/path/to/combined-ca.pem -t famsun-agent:latest .
```

构建 secret 不会自动成为运行时证书。若沙箱的出站 HTTPS 需要企业 CA，可显式设置：

```dotenv
FAMSUN_SANDBOX_CA_BUNDLE=/srv/famsun/trust/ca-bundle.pem
```

该文件须为管理员管理的可信证书包，并包含需要的公共根证书。在 Compose 部署中，另加只读挂载，让 API 和宿主 Docker 看到同一个源路径，例如 `compose.override.yaml`：

```yaml
services:
  app:
    volumes:
      - /srv/famsun/trust/ca-bundle.pem:/srv/famsun/trust/ca-bundle.pem:ro
```

创建策略再把此文件只读挂到沙箱 `/run/famsun-ca.pem`，设置 `SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`PIP_CERT`。不要把 CA 放进用户可修改的聊天目录。API 自身访问模型 / MCP 所需的 CA 另按 HTTP 客户端要求设置 `SSL_CERT_FILE`。保留 TLS 校验；Docker 客户端可采用管理员已有的代理默认值，应用不会复制全部宿主环境到沙箱。

### 反向代理与 SSE

透传 `/api`，禁用 SSE 缓冲，读取超时应大于最长任务时间。Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 600s;
    client_max_body_size 26m;
}
```

来源列表应匹配浏览器实际访问域名。代理上传限制应覆盖应用配置的文件上限和 multipart 开销。

## 运行配置

| 环境变量 | 含义 / 默认值 |
| --- | --- |
| `AGENT_API_KEY` | 模型密钥，仅服务端使用；支持 `OPENAI_API_KEY` 别名 |
| `AGENT_BASE_URL` | API 根地址；支持 `OPENAI_BASE_URL`，不填写完整 `/responses` 路径 |
| `AGENT_MODEL` | 模型名称，默认 `gpt-5.6-luna`，与 SDK 0.24 默认模型一致；已配置值不变 |
| `AGENT_COMPACTION_THRESHOLD` | 原生压缩阈值，默认 32000，需适合目标模型上下文 |
| `AGENT_MAX_TURNS` | 主代理最大轮数，默认 20 |
| `AGENT_TIMEOUT_SECONDS` | 单次任务最长时间，默认 300 秒，包含等待审批 |
| `DATA_DIR` | 工作区与本地 SDK 历史目录 |
| `DATABASE_URL` | 应用数据库；留空使用 `DATA_DIR/app.db` |
| `ALLOWED_MCP_HOSTS` | MCP HTTPS 主机允许列表，逗号分隔 |
| `MAX_UPLOAD_MB` / `MAX_SESSION_MB` | 默认 25 / 250 MB |
| `FAMSUN_SANDBOX_IMAGE` | 默认 `famsun-sandbox:latest` |
| `FAMSUN_SANDBOX_UID` / `FAMSUN_SANDBOX_GID` | 沙箱非 root 身份；Compose 从 `FAMSUN_UID` / `FAMSUN_GID` 传入 |
| `FAMSUN_SANDBOX_CA_BUNDLE` | 可选，只读可信证书包的宿主 / API 共用路径 |
| `FAMSUN_DEPLOYMENT_ID` | 可选部署标签；默认从数据目录生成，用于限定遗留容器清理 |

API 协议固定为 Responses，`AGENT_API_MODE` 不再用于选择协议。管理员保存的 Base URL、模型和压缩阈值优先于环境默认值。目标服务必须支持流式 Responses、原生 custom tools 和 `context_management`；参数被接受不等于已经验证真实压缩触发，应分别验收。

MCP 凭据放在 `MCP_<NAME>_TOKEN` 环境变量，扩展只保存变量名。已有部署也可使用 `FAMSUN_MCP_TOKENS` JSON 映射。凭据不写入 Skill、对话或版本库。普通员工无法编辑全局扩展定义。

网络允许安装任务依赖，但根文件系统只读；临时安装应使用工作区虚拟环境或可写目标目录。稳定的业务依赖应预装到镜像，更新依赖锁文件后重建：

```bash
uv pip compile sandbox/requirements.in --generate-hashes --python-version 3.12 --output-file sandbox/requirements.txt
docker build -t famsun-sandbox:latest sandbox
```

## 备份、升级与重启

一致性备份包含应用数据库和整个 `DATA_DIR`：工作区文件以及 `history/<user>/<session>.sqlite3`。即使应用使用 PostgreSQL，SDK 历史仍在本地 SQLite，不能只做 `pg_dump`。

升级前停止接收新任务，等待活动任务结束，再备份。应用启动会创建缺失表，并为旧扩展表补充 JSON `config` 列；旧 API 模式设置归一为 Responses。旧聊天的 user / assistant 文本在第一次运行时导入空 SDK 历史，之后以完整 SDK 项目为准。后续复杂迁移仍需单独设计和演练。

重启会把未完成任务标记为中断，保留事件和文件；不会自动重放工具或恢复等待审批的协程。容器清理按部署标签限定，同一 Docker 主机上多个部署应使用不同数据目录或显式不同 `FAMSUN_DEPLOYMENT_ID`。

Docker socket 使控制面具有较高宿主权限，应使用专用执行主机。要扩展到多个 worker / 副本，需先实现持久队列、分布式锁、任务所有权和共享存储。企业 SSO、业务系统用户身份映射及更强执行隔离需要另行接入。

## 目标环境验证

这些是复跑命令，不代表已在当前目标环境通过：

```bash
./scripts/check.sh
PYTHONPATH=backend uv run python tests/docker_smoke.py
```

Docker smoke 直接使用 SDK 原生沙箱，覆盖文件 / 补丁 / 命令 / Skills、资源配置、网络 TLS、隔离和清理；不调用模型。以应用的非 root 用户运行，先构建镜像并保证数据目录权限与 UID / GID 对齐。

运行界面回归前启动开发服务，再在 `frontend/` 执行 `npm run test:ui`；该脚本使用模拟 API。真实部署可运行 `npm run test:deployment`，需要独立验收环境；模型端到端脚本另需 `FAMSUN_LIVE_MODEL_TEST=1` 和已配置模型服务，会产生真实模型调用费用。

上线时另验收两个账号的隔离、真实 Responses 工具循环、连续多轮历史、压缩、子代理、MCP 允许 / 拒绝、取消、SSE 重连、文件预览和备份恢复。记录实际执行命令、环境和结果；历史验证报告不自动适用于当前部署。
