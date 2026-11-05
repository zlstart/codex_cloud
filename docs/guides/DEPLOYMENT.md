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
4. 保持 `DATABASE_URL` 留空，应用数据库将保存在上述目录的 `app.db`；已有 SQLite 部署继续使用原数据目录。
5. 填写 Responses 模型地址、模型与密钥，构建并启动。

```bash
docker build -t famsun-sandbox:latest sandbox
docker compose build app
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8080/health
```

Compose 只运行应用服务并公开 `127.0.0.1:8080`；SQLite 数据文件通过 `DATA_DIR` 的宿主目录挂载持久化，不需要数据库服务或数据库密码。前端静态文件和 API 同源提供。设置 HTTPS 反向代理后配置：

```dotenv
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://agent.example.com
ALLOW_REGISTRATION=false
```

`COOKIE_SECURE=true` 需要 HTTPS。部署后先在受控访问范围创建管理员，再开放入口。保持 **一个 Uvicorn worker、一个应用副本**；当前任务与审批等待属于 API 进程内协程。

## 网络、资源与证书

每个任务使用 SDK `DockerSandboxClient` 创建一个容器，命令、PTY、补丁和图片读取由 SDK 提供。容器绑定当前聊天目录，`uploads/` 额外只读挂载，任务结束后删除容器，聊天文件保留。

网络默认启用。容器根文件系统只读，非 root，移除 capabilities，启用 `no-new-privileges`，默认限制为 2048 MiB 内存、2 CPU、256 进程，文件句柄上限 4096，单文件大小上限 100 MiB。私有 `/tmp` 上限 512 MiB，保留 SDK 辅助程序所需的执行权限。资源设置由 `sdk_sandbox.py` 中的创建策略统一维护。

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
    proxy_read_timeout 7500s;
    client_max_body_size 101m;
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
| `AGENT_MAX_TURNS` | 主代理最大轮数，默认 200；代码生成、自检及多格式产物可能需要多轮工具往返，仍受总时间上限约束 |
| `AGENT_TIMEOUT_SECONDS` | 单次任务最长时间，默认 7200 秒，包含等待审批；复杂代码及多格式报告需要更长生成时间，用户仍可随时停止任务 |
| `AGENT_TRACING_ENABLED` | 默认 `false`；设置 `true` 启用 SDK 原生 OpenAI Traces |
| `OPENAI_TRACING_API_KEY` | 独立的 OpenAI 项目密钥；留空时使用 `OPENAI_API_KEY`，不会使用第三方 `AGENT_API_KEY` |
| `AGENT_TRACING_WORKFLOW_NAME` | 默认 `FAMSUN conversation` |
| `AGENT_TRACING_INCLUDE_SENSITIVE_DATA` | 默认 `false`；显式开启 SDK 正文采集策略，具体字段受 SDK 与模型协议限制 |
| `DATA_DIR` | 应用 SQLite 数据库、工作区与本地 SDK 历史目录 |
| `DATABASE_URL` | 仅支持 SQLite；留空使用 `DATA_DIR/app.db`；可指定 `sqlite:////absolute/path/app.db` |
| `ALLOWED_MCP_HOSTS` | MCP HTTPS 主机允许列表，逗号分隔 |
| `MAX_UPLOAD_MB` / `MAX_SESSION_MB` | 默认 100 / 2048 MiB |
| `FAMSUN_SANDBOX_IMAGE` | 默认 `famsun-sandbox:latest` |
| `FAMSUN_DOCKER_TIMEOUT_SECONDS` | Docker 请求超时，默认 180 秒，范围 1–3600 秒；较大镜像或慢存储可能超过 15 秒。创建响应超时后会按本次任务唯一标识等待并清理迟到的容器，不重试创建 |
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

OpenAI Traces 使用 SDK 后台导出，配置、隐私策略和第三方 Responses 可观测字段说明见 [追踪指南](TRACING.md)。运行页的追踪链接表示已配置采集，不代表服务端已成功接收；无需为追踪另外部署数据库。

一致性备份包含整个 `DATA_DIR`：`app.db`、工作区文件以及 `history/<user>/<session>.sqlite3`。如自定义 `DATABASE_URL` 指向其他 SQLite 文件，也要将该文件纳入备份；Compose 中须额外挂载其所在目录并赋予应用用户写权限。SQLite URL 支持 `sqlite:///` 与 `sqlite+pysqlite:///`，其他数据库或驱动配置会在启动时明确报错，不会自动切换数据库或搬迁数据。

SQLite 使用 WAL、外键约束和 30 秒锁等待，支持单个应用进程内的并行聊天；写事务由 SQLite 串行处理。数据目录使用支持 SQLite 文件锁的本地持久磁盘，保持一个 API worker、一个应用副本。不要直接复制正在写入的 `.db` 文件并遗漏 `-wal` / `-shm` 文件。

最简单的一致性备份方式是先等待活动任务结束并停止应用（`docker compose stop app`），备份整个数据目录，再启动应用（`docker compose start app`）。恢复时同样先停止应用，完整恢复数据目录和原属主 / 权限后启动。需要在线备份时须使用 SQLite backup API，并协调所有应用数据库、SDK 历史与工作区文件的一致性。

升级前停止接收新任务，等待活动任务结束，再备份。应用启动会创建缺失表，并为旧扩展表补充 JSON `config` 列；旧 API 模式设置归一为 Responses。旧聊天的 user / assistant 文本在第一次运行时导入空 SDK 历史，之后以完整 SDK 项目为准。后续复杂迁移仍需单独设计和演练。

重启会把未完成任务标记为中断，保留事件和文件；不会自动重放工具或恢复等待审批的协程。容器清理按部署标签限定，同一 Docker 主机上多个部署应使用不同数据目录或显式不同 `FAMSUN_DEPLOYMENT_ID`。

Docker socket 使控制面具有较高宿主权限，应使用专用执行主机。要扩展到多个 worker / 副本，需先实现持久队列、分布式锁、任务所有权和共享存储。企业 SSO、业务系统用户身份映射及更强执行隔离需要另行接入。

## 目标环境验证

文件预览使用应用镜像中的 `openpyxl`、`python-docx`、`python-pptx` 和图像解析依赖，不依赖外部 Office 转换服务或宿主机 LibreOffice。升级这些能力时需重新构建应用镜像，并等待当前任务结束后重启单实例服务；仅替换静态前端不会更新已加载的后端预览模块。

反向代理应保留应用 HTML 的 `Content-Security-Policy: frame-src 'none'; object-src 'none'`，以及文件读取响应自带的 sandbox CSP。前端入口还提供相同的 frame 限制，开发和生产都允许受限 srcdoc 内联交互，禁止该 iframe 导航到外部页面。不要为 HTML 游戏开启 `allow-same-origin` 或放宽为任意远端 iframe。Office 的具体预览范围与资源限制见 [API 文档](API.md#office-预览)。

这些是复跑命令，不代表已在当前目标环境通过：

```bash
./scripts/check.sh
PYTHONPATH=backend uv run python tests/docker_smoke.py
```

Docker smoke 直接使用 SDK 原生沙箱，覆盖文件 / 补丁 / 命令 / Skills、资源配置、网络 TLS、隔离和清理；不调用模型。以应用的非 root 用户运行，先构建镜像并保证数据目录权限与 UID / GID 对齐。

运行界面回归前启动开发服务，再在 `frontend/` 执行 `npm run test:ui`；该脚本使用模拟 API。真实部署可运行 `npm run test:deployment`，需要独立验收环境；模型端到端脚本另需 `FAMSUN_LIVE_MODEL_TEST=1` 和已配置模型服务，会产生真实模型调用费用。

`FAMSUN_TEST_BASE_URL=http://127.0.0.1:8000 npm run test:previews` 可针对已构建前端验证交互 HTML、隔离边界、Office 内容和异常图片/幻灯片尺寸；此套件使用明确标记的模拟 API 与人工构造文件，不能替代真实模型产物验收。真实验收还需在应用内生成并操作文件，核对下载字节、图表/表格内容和实际截图。

上线时另验收两个账号的隔离、真实 Responses 工具循环、连续多轮历史、压缩、子代理、MCP 允许 / 拒绝、取消、SSE 重连、文件预览和备份恢复。记录实际执行命令、环境和结果；历史验证报告不自动适用于当前部署。


## 复杂任务预算与开发热加载

开发启动脚本使用 `--reload --reload-dir backend/app`，只监视后端源码。`data/`、`test-results/` 和任务工作空间里的生成文件不会触发重启；后端源码修改仍会重启并中断活动任务。生产部署不启用 reload。

`.env` 中含空格的值应加引号，例如 `AGENT_TRACING_WORKFLOW_NAME="FAMSUN conversation"`。修改下列部署预算后重启后端；已运行的任务不会动态替换预算。示例配置见根目录 `.env.example`。

| 环境变量 | 默认值 | 控制范围 |
| --- | ---: | --- |
| `AGENT_MAX_TURNS` | 200 | 主代理模型轮数，未单独配置的子代理继承此值 |
| `AGENT_TIMEOUT_SECONDS` | 7200 | 整个任务秒数，包含子代理和审批等待 |
| `AGENT_MODEL_TIMEOUT_SECONDS` | 300 | 模型 HTTP 请求超时秒数 |
| `MAX_UPLOAD_MB` | 100 | 上传和登记产物的单文件上限，MiB |
| `MAX_SESSION_MB` | 2048 | 实际工作空间总容量，MiB |
| `MAX_WORKSPACE_ENTRIES` | 10000 | 文件和目录条目预算；同时用于产物扫描 |
| `AGENT_MAX_PLAN_STEPS` | 50 | 单个任务计划的步骤数 |
| `MCP_TIMEOUT_SECONDS` | 120 | MCP HTTP 超时秒数 |
| `MCP_SESSION_TIMEOUT_SECONDS` | 300 | MCP 会话及 SSE 读取超时秒数 |
| `MCP_MAX_LIST_PAGES` | 100 | MCP 工具列表最大页数 |
| `FAMSUN_DOCKER_TIMEOUT_SECONDS` | 180 | Docker daemon 请求超时秒数，可设 1–3600 |
| `FAMSUN_SANDBOX_MEMORY_MB` | 2048 | 每个会话容器的内存上限，MiB，禁用额外 swap |
| `FAMSUN_SANDBOX_CPUS` | 2 | 每个容器的 CPU 配额 |
| `FAMSUN_SANDBOX_PIDS_LIMIT` | 256 | 每个容器的进程数 |
| `FAMSUN_SANDBOX_NOFILE` | 4096 | 容器内进程的文件描述符上限 |
| `FAMSUN_SANDBOX_FILE_MB` | 100 | 容器内单文件写入上限，MiB |
| `FAMSUN_SANDBOX_TMP_MB` | 512 | 容器临时文件系统容量，MiB |

子代理轮数留空表示继承部署值，可明确设置 1–10000。启动时将未修改的旧版内置子代理 12 轮配置升级为继承；管理员修改过的配置保留。提高产物大小时，需要同时调整 `MAX_UPLOAD_MB` 和 `FAMSUN_SANDBOX_FILE_MB`，且 `MAX_SESSION_MB` 必须容纳全部文件。

这些值提供复杂任务的执行余量，仍保持有限的资源边界。多个聊天并行时需按容器配额评估宿主容量。会话磁盘配额由启动检查与周期扫描监控，并非文件系统硬配额。模型上下文压缩阈值和旧工具输出截断独立保持有界，放宽任务预算不意味着扩大模型上下文。
