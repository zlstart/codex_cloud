# 部署与运维

## 本地开发

```bash
cp .env.example .env
./scripts/dev.sh
```

脚本读取 `.env`，使用 uv 安装锁定的 Python 依赖，安装前端依赖并启动 API 与 Vite。前端代理 `/api` 至本地 API。按 Ctrl+C 关闭两个进程。

默认数据保存于 `./data`。首次注册创建管理员；要允许其他员工注册，可暂时设置 `ALLOW_REGISTRATION=true` 并重启 API，完成后关闭。

## Docker Compose

需要 Linux Docker Engine、Compose v2，以及一个专用于此应用的主机目录。API 调用宿主 Docker 创建执行容器，因此 **DATA_DIR 在宿主与 API 容器内必须是同一个绝对路径**。

1. 复制 `.env.example` 为 `.env`。
2. 设置 `DATA_DIR=/srv/famsun/data`，建立该目录并将其所有权赋给应用运行用户。
3. 设置 `FAMSUN_UID`、`FAMSUN_GID` 为该用户的数字 UID / GID。设置 `DOCKER_GID` 为 `stat -c '%g' /var/run/docker.sock` 的结果。
4. 设置强随机 `POSTGRES_PASSWORD`。可使用密码管理器产生至少 32 字节随机值；这里建议十六进制值，以免数据库 URL 中需要额外百分号编码。
5. 填写模型端点、模型名称和密钥；或暂时留空密钥完成系统初始化。

```bash
docker build -t famsun-sandbox:latest sandbox
docker compose build app
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8080/health
```

Compose 仅绑定本机 `127.0.0.1:8080`，前端静态文件与 API 由同一服务提供。数据库没有宿主公开端口。生产环境在前方放置 HTTPS 反向代理，并设置：

```dotenv
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://agent.example.com
ALLOW_REGISTRATION=false
```

将 `agent.example.com` 换成实际域名。`COOKIE_SECURE=true` 必须配合 HTTPS，否则浏览器不会发送登录 Cookie。部署后先通过受控网络创建第一个管理员账号，再向员工开放入口。

### 反向代理与 SSE

反向代理需透传 `/api`，禁用 SSE 响应缓冲，并让读取超时超过一次任务的最长时间。例如 Nginx：

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

TLS 证书与访问网关按公司基础设施配置。API 的 `ALLOWED_ORIGINS` 必须匹配浏览器访问的真实来源；不要使用宽泛通配符。

### 代理证书环境

企业出站代理或托管开发环境可能需要额外 CA。Dockerfile 支持可选 BuildKit secret；证书仅在安装依赖时挂载，不复制进镜像层。

```bash
docker build --secret id=proxy_ca,src=/path/to/combined-ca.pem -t famsun-sandbox:latest sandbox
docker build --secret id=proxy_ca,src=/path/to/combined-ca.pem -t famsun-agent:latest .
docker compose up -d --no-build
```

使用包含所需公共根证书和代理 CA 的证书包。保留宿主 Docker 已配置的代理和 registry 凭据，不关闭 TLS 校验。运行时如果模型端点需要企业 CA，还需将 CA 以只读方式挂载到 API 容器，并按 HTTP 客户端要求配置 `SSL_CERT_FILE`。

## 模型、MCP 与限制

| 环境变量 | 含义 |
| --- | --- |
| `AGENT_API_KEY` | 模型服务密钥，仅服务器使用 |
| `AGENT_BASE_URL` | 供应商 API 根地址，通常以 `/v1` 结尾 |
| `AGENT_MODEL` | 供应商实际支持的模型名称 |
| `AGENT_API_MODE` | `chat_completions` 或 `responses` |
| `ALLOWED_MCP_HOSTS` | 可添加的 MCP 主机名，逗号分隔，不含协议或路径 |
| `MAX_UPLOAD_MB` | 单次文件上传限制，默认 25 MB |
| `MAX_SESSION_MB` | 单会话文件容量限制，默认 250 MB |
| `AGENT_MAX_TURNS` | 一次任务最多的模型循环次数，默认 20 |
| `AGENT_TIMEOUT_SECONDS` | 一次任务最长时间，默认 300 秒 |
| `FAMSUN_SANDBOX_IMAGE` | 代码执行镜像，本地默认 `famsun-sandbox:latest` |
| `FAMSUN_DEPLOYMENT_ID` | 可选部署标识，隔离本部署的遗留容器清理；默认由数据目录路径生成 |

需要认证的 MCP 扩展可以设置 `token_env`，例如变量名 `MCP_RESEARCH_TOKEN`；将实际凭据只配置在服务器环境中。允许的变量名须匹配 `MCP_[A-Z0-9_]+_TOKEN`，不能引用模型密钥等其他环境变量。`FAMSUN_MCP_TOKENS` 也支持按扩展 ID 映射 Bearer token 的 JSON 对象，适合已有部署；两种方式都不应提交到版本库或写入 Skills。

需要新的 Python 包时修改 `sandbox/requirements.in`，重新锁定并构建镜像。执行容器不允许联网安装包。镜像内预装 NumPy、pandas、Matplotlib、SciPy、Seaborn、Pillow、OpenPyXL、python-docx、pypdf、ReportLab 和 XlsxWriter，并提供 Noto CJK 字体。

```bash
uv pip compile sandbox/requirements.in --generate-hashes --python-version 3.12 --output-file sandbox/requirements.txt
docker build -t famsun-sandbox:latest sandbox
```

## 数据备份与更新

数据库和 `DATA_DIR` 需要一起备份。数据库保存元数据，文件目录保存实际上传资料与产物；只备份其中一个无法完整恢复。

升级前停止接受新任务并等待当前任务结束，再制作一致性备份。PostgreSQL 使用 `pg_dump` 或公司的备份方案，文件目录使用保留权限的文件级快照。备份中含用户资料和会话内容，应加密并限制访问。

当前建表在应用启动时完成；复杂 schema 演进尚未提供自动迁移链。新增字段或升级数据模型时，先编写和演练迁移，再更新生产数据库。更新镜像后重启应用；未结束的任务会显示中断，不会自动重新执行。

## 部署边界

- 保持单 API worker、单应用副本。当前任务调度和等待审批使用进程内协程。
- Docker socket 赋予控制面很高的宿主权限。应使用专用执行主机；不要向业务工具或代码沙箱暴露它。
- 面向不受信任的公网租户时，需要额外的强隔离执行器、统一身份系统、全局配额、入侵监测与独立安全验证。
- 当前应用提供本地账号和管理员 / 成员角色。企业 SSO、细粒度业务授权、组织同步、审计平台对接与灾备需要接入现有企业系统。

## 上线验证

开发环境已成功构建沙箱镜像，并运行实际 Docker 冒烟测试，验证 CSV → Excel / PNG 的分析链路、非 root 身份、只读输入与根文件系统、无网络、无模型密钥，以及取消与超时。可在目标 Docker 主机重复执行：

```bash
PYTHONPATH=backend uv run python tests/docker_smoke.py
```

该测试不需要 API Key，也不会保存测试数据。它直接调用应用的真实沙箱适配器，而非模拟 Docker 响应。

用两个独立账号验证会话与文件互相不可见；用真实兼容模型验证流式回答、工具调用与错误处理；上传 CSV 并生成一张图，检查预览和下载；关闭浏览器再打开验证事件重连；执行任务时取消；分别拒绝和允许 MCP 审批。最后检查 HTTPS Cookie、来源限制、数据备份与恢复流程。

单元测试通过不等于目标供应商、Docker 主机及生产网关已经完成联调。请以当前部署的实际验证结果为准。
