# HTTP API 与执行事件

所有业务接口使用 `/api` 前缀。完整请求/响应模型以运行服务的 `/api/docs` 为准。时间为 UTC ISO 8601 字符串。错误统一返回 `{ "detail": "可读错误说明" }`。

## 登录与授权

登录使用不透明的 HttpOnly、SameSite=Lax Cookie `famsun_session`。数据库保存 token 的 SHA-256 摘要。生产部署设置 `COOKIE_SECURE=true` 并使用 HTTPS。修改请求会校验 Origin 和 Fetch Metadata；反向代理必须正确传递原始 Host/协议。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/auth/status` | 是否已有用户、当前是否开放注册 |
| `POST /api/auth/register` | `{email,password,name}`；首次注册成为管理员 |
| `POST /api/auth/login` | `{email,password}` |
| `POST /api/auth/logout` | 撤销当前登录 |
| `GET /api/auth/me` | 当前 `{id,email,name,role}` |

密码长度 10–128 字符。默认仅开放首位管理员注册；后续注册由 `ALLOW_REGISTRATION` 控制。未登录返回 401；跨用户资源返回 404；管理员操作对普通成员返回 403。

## 会话与文件

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/sessions` | 本人会话列表，置顶和最近更新优先 |
| `POST /api/sessions` | 创建会话，正文可传 `{title}` |
| `GET /api/sessions/{id}` | `{session,messages,files,runs}` |
| `PATCH /api/sessions/{id}` | 修改 `{title,pinned}` |
| `DELETE /api/sessions/{id}` | 停止活动任务并删除该会话与工作目录 |
| `GET /api/files` | 本人全部会话的文件 |
| `POST /api/sessions/{id}/files` | multipart 字段 `file` |
| `GET /api/files/{id}/content` | 授权读取，`?download=true` 作为附件下载 |
| `DELETE /api/files/{id}` | 删除本人文件 |

上传请求需要 Content-Length。单文件默认 25 MB、每会话默认 250 MB；运行中会话暂不允许上传或删除资料。文件记录包含 `id,session_id,name,mime_type,size,kind,created_at,url`；`kind` 为 `upload` 或 `output`。下载 URL 仍需所属用户的登录 Cookie。

## 任务与审批

```http
POST /api/sessions/{id}/runs
Content-Type: application/json

{
  "content": "分析上传的生产数据，生成报告和图表。",
  "attachment_ids": ["当前会话的文件ID"],
  "client_request_id": "客户端生成的唯一请求ID"
}
```

相同会话内相同请求 ID 和相同内容返回已有任务；重复 ID 配不同内容返回 409。未配置模型密钥返回 503，不伪造消息。每会话最多一个活动任务，每用户最多 3 个，全服务最多 16 个。

- `GET /api/runs/{id}`：状态与错误。
- `GET /api/runs/{id}/events?after=<事件ID>`：持久化 SSE；支持 `Last-Event-ID`。
- `POST /api/runs/{id}/cancel`：停止正在执行的模型或工具调用。
- `POST /api/runs/{id}/approve`：`{approval_id,approved}`，只能处理本人的未过期审批。

状态为 `queued → running → completed/failed/cancelled`；调用远程工具时可进入 `awaiting_approval`。客户端断开 SSE 不会取消任务。

| 事件 | data 中的主要字段 |
| --- | --- |
| `run.started` | 空对象 |
| `text.delta` | `delta` |
| `tool.started` | `name,arguments` |
| `tool.completed` | `name,output` |
| `plan.updated` | `steps,current_step,completed` |
| `artifact.created` | `artifact` 文件记录 |
| `approval.required` | `id,tool,arguments` |
| `approval.resolved` | `id,approved` |
| `run.completed` | 空对象 |
| `run.failed` | `error` |
| `run.cancelled` | 空对象或错误说明 |

每个 SSE 事件有递增 ID，前端应去重并处理审批已解决事件。终态任务的事件流会在历史事件全部发送后关闭。上下文被裁剪时通过工具记录明确提示，历史消息仍在数据库中。

## 配置与能力

- `GET /api/settings`：模型 Base URL、模型、API 模式、是否已配置密钥、沙箱状态和配额；从不返回密钥。
- `PATCH /api/settings`：管理员修改 `base_url,model,api_mode`。密钥从服务端环境读取。
- `GET /api/extensions`：`{skills,mcp_servers}`，包含当前用户的启用状态。
- `PATCH /api/extensions/{id}`：修改当前用户的 `{enabled}`。
- `POST /api/extensions/skills`：管理员提交 `{name,description,content}`。
- `GET /api/extensions/skills/{id}`：读取 Skill 正文。
- `POST /api/extensions/mcp`：管理员提交 `{name,description,url,token_env?}`。
- `DELETE /api/extensions/{id}`：管理员删除自定义扩展；内置技能仅支持停用。

MCP 使用 Streamable HTTP，HTTPS 域名需加入 `ALLOWED_MCP_HOSTS`。可选 `token_env` 只能为 `MCP_<NAME>_TOKEN` 格式的环境变量名称，不能传密钥值。所有远程工具均由 SDK 原生审批机制先审批、后执行。

`/health` 供进程与数据库健康检查。当前任务调度为单进程，部署保持一个 worker；重启后活动任务标记中断，执行事件和已生成文件保留。
