# HTTP API 与执行事件

完整 OpenAPI 文档位于 `/api/docs`，模型位于 `/api/openapi.json`。时间为 UTC ISO 8601 字符串，错误通常返回 `{ "detail": "可读说明" }`。业务资源要求登录；健康检查、注册 / 登录状态和不含密钥的设置读取用于初始化页面。

## 登录与授权

登录使用不透明的 HttpOnly、SameSite=Lax Cookie `famsun_session`，数据库保存 token 摘要。生产环境使用 HTTPS 和 `COOKIE_SECURE=true`。修改请求校验 Origin / Fetch Metadata，代理需正确传递 Host 和协议。

| 方法与路径 | 请求 / 返回含义 |
| --- | --- |
| `GET /api/auth/status` | 是否已有用户及注册状态 |
| `POST /api/auth/register` | `{email,password,name}`；首次注册成为管理员 |
| `POST /api/auth/login` | `{email,password}` |
| `POST /api/auth/logout` | 撤销当前登录 |
| `GET /api/auth/me` | `{id,email,name,role}` |

密码 10–128 字符，后续公开注册由 `ALLOW_REGISTRATION` 控制。未登录返回 401，跨用户资源返回 404，成员执行管理员操作返回 403。扩展定义在组织内共享；文件、聊天、任务与审批仍逐项校验用户归属。

## 会话与文件

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/sessions` | 本人会话，置顶和最近更新优先 |
| `POST /api/sessions` | `{title?}` 创建会话 |
| `GET /api/sessions/{id}` | `{session,messages,files,runs}` |
| `PATCH /api/sessions/{id}` | 修改 `{title?,pinned?}` |
| `DELETE /api/sessions/{id}` | 停止任务并删除会话、工作区和 SDK 历史 |
| `GET /api/files` | 本人所有会话的文件 |
| `POST /api/sessions/{id}/files` | multipart `file`，返回文件记录 |
| `GET /api/files/{id}/content` | 授权文件读取；`?download=true` 以附件下载 |
| `GET /api/files/{id}/preview` | Office 文档的有界 JSON 预览 |
| `DELETE /api/files/{id}` | 删除本人文件 |

文件记录包含 `id,session_id,name,mime_type,size,kind,created_at,url`；`kind` 为 `upload` / `output`。URL 不是公开分享链接，仍需要所属用户的 Cookie。默认上传上限 25 MB，单会话 250 MB；上传请求需要 Content-Length。活动任务期间不允许上传或删除文件，返回 409。

### Office 预览

`/preview` 接受 `.xlsx`、`.xlsm`、`.xls`、`.docx`。其他格式返回 415，可通过 `/content` 在浏览器预览或下载。超过独立的 25 MB 预览上限返回 413；损坏、加密、解析超时或资源超限返回 422。

表格响应：

```json
{
  "kind": "spreadsheet",
  "sheets": [{
    "name": "Sheet1",
    "rows": [["产线", "产量"], ["A", 120]],
    "total_rows": 2,
    "total_columns": 2,
    "truncated": false
  }],
  "truncated": false
}
```

DOCX 响应为 `{kind:"document",paragraphs:[...],truncated:false}`，段落和表格行作为文本返回，不承诺保留原始版式。

预览最多 20 个工作表，每表 1,000 行 / 50 列，文本总预算 2,000,000 字符，单个文本值最多 4,096 字符；DOCX 最多 2,000 个文本块。Office ZIP 文件还检查条目数、展开体积与压缩比例。解析在独立进程中进行，限制内存、CPU 与 15 秒等待时间；公式使用已有缓存值，不计算公式、执行宏或获取外部链接。`truncated` 表示预览不完整，原文件不被修改。

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

相同聊天内重复请求 ID 和相同内容返回已有任务；重复 ID 配不同内容返回 409。内容最多 100,000 字符，附件最多 20 个。缺少模型密钥返回 503。同一聊天最多一个活动任务，每用户最多三个，全服务最多十六个。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/runs/{id}` | 任务状态与错误 |
| `GET /api/runs/{id}/events?after=0` | 持久化 SSE，支持 `Last-Event-ID` |
| `GET /api/runs/{id}/timeline?after=0&limit=500` | 同一事件记录的分页 JSON |
| `POST /api/runs/{id}/cancel` | 取消本人的任务 |
| `POST /api/runs/{id}/approve` | `{approval_id,approved}`，处理本人的待决审批 |

状态为 `queued → running → completed/failed/cancelled`，MCP 工具审批期间可进入 `awaiting_approval`。浏览器断开 SSE 不取消任务。审批通过 SDK interruption / RunState 恢复，不重复提交当前用户输入；拒绝结果交回模型。

## 有序 timeline

SSE 的 `id` 和 JSON 的 `sequence` 都是持久化 `RunEvent.id`。ID 递增但不保证同一任务连续编号。客户端按 ID 去重、按顺序归约，不能按工具名称配对。

JSON 分页响应：

```json
{
  "events": [{
    "sequence": 101,
    "run_id": "run-id",
    "type": "text.delta",
    "data": {"item_id":"msg-1","agent_id":"main","agent_name":"丰尚助手","parent_call_id":null,"delta":"正在检查资料。","phase":"intermediate"},
    "created_at": "2026-11-02T10:00:00+00:00"
  }],
  "next_cursor": 101,
  "has_more": false,
  "status": "running"
}
```

`after` 非负，`limit` 为 1–1000，默认 500；传回 `next_cursor` 继续读取。SSE 使用 URL `after` 与 `Last-Event-ID` 较大的值，终态任务发送完历史事件后关闭。

文本 / 工具 / 压缩事件包含 `item_id,agent_id,agent_name,parent_call_id`；根代理的父 call 为 null，子代理事件归属相应委派工具。子代理 item / call ID 按父调用加前缀，客户端应把这些 ID 当作不透明值。

| 事件 | 主要字段与处理 |
| --- | --- |
| `run.started` | 任务开始 |
| `text.started` | `item_id,phase`，创建文字块 |
| `text.delta` | `item_id,delta,phase`，追加到相同文字块 |
| `text.completed` | `item_id,text,phase`，`text` 替换为完整权威文本 |
| `text.phase` | `item_id,phase`，将根代理最终答案标为 `final` |
| `tool.started` | `call_id,item_id,name,arguments` |
| `tool.completed` | `call_id,item_id,name,output`，按 call ID 完成原工具块 |
| `context.compacted` | 压缩 item 的身份信息；不返回加密载荷 |
| `plan.updated` | `steps,current_step,completed`，可附 call / agent 信息 |
| `artifact.created` | `artifact` 文件记录 |
| `approval.required` | `id,tool,arguments` |
| `approval.resolved` | `id,approved` |
| `run.usage` | `requests,input_tokens,output_tokens,total_tokens` |
| `run.completed` | `message_id,final_item_ids`，关联保存的最终 Message |
| `run.failed` | `error` |
| `run.cancelled` | 取消终态 |

阶段值为 `intermediate` / `final`。子代理文字一直属于过程；最终 Message.content 是完成答复的权威内容，也支持没有完整 timeline 的旧记录。过程折叠不应隐藏最终答案。取消或失败后保留已有文字和工具活动。工具输出会被有界截断，private reasoning、密钥和 compaction 加密内容不会作为事件输出。

## 设置

`GET /api/settings` 返回 `provider,compaction,sandbox,limits,registration_enabled`。`provider` 包括 `base_url,model,api_mode:"responses",compaction_threshold,configured`，不返回密钥；`compaction` 包括 `enabled,mode,threshold`；`sandbox` 包括 `backend,available,network_enabled`。

管理员使用 `PATCH /api/settings` 更新 `base_url,model,compaction_threshold`。兼容字段 `api_mode` 仅接受 `"responses"`；不提供其他协议选项。压缩阈值范围 1,024–1,000,000，需与实际模型窗口匹配。

远端 Base URL 需要 HTTPS，本机 localhost / 127.0.0.1 / ::1 可用 HTTP；拒绝认证信息、query / fragment 和完整 endpoint 路径。密钥从服务器环境读取。Responses / custom tools / 原生 compaction 不兼容时明确报错，不自动降级。

## 扩展 CRUD

`GET /api/extensions` 返回 `{skills,mcp_servers,subagents}`，列表条目包含 `id,name,description,type,enabled,status,builtin,editable`。`enabled` 是当前用户偏好，`editable` 表示当前用户有管理员权限。

| 方法与路径 | 权限与用途 |
| --- | --- |
| `GET /api/extensions/{id}` | 登录用户读取完整配置；子代理选项在 `config` 中 |
| `GET /api/extensions/skills/{id}` | 保留的 Skill 正文读取接口 |
| `PATCH /api/extensions/{id}` | 当前用户更新 `{enabled}` |
| `POST /api/extensions/skills` | 管理员创建 Skill |
| `PATCH /api/extensions/skills/{id}` | 管理员编辑 Skill |
| `POST /api/extensions/mcp` | 管理员创建 MCP |
| `PATCH /api/extensions/mcp/{id}` | 管理员编辑 MCP |
| `POST /api/extensions/subagents` | 管理员创建子代理 |
| `PATCH /api/extensions/subagents/{id}` | 管理员编辑子代理 |
| `DELETE /api/extensions/{id}` | 管理员删除自定义扩展；内置项返回 400 |

Skill 创建字段为 `{name,description?,content}`，编辑接受对应的部分字段。名称最多 100 字符，描述最多 1,000 字符，正文最多 100,000 字符；内置 Skill 的编辑保存为用户修改，升级不会覆盖这类已标记修改。

MCP 创建字段为 `{name,description?,url,token_env?}`，编辑接受部分字段。`token_env` 只接受 `MCP_[A-Z0-9_]+_TOKEN` 变量名，编辑传 null 可清除；接口不会返回变量值。URL 需要命中服务器允许列表。所有远程工具调用走 SDK 原生审批。

子代理创建字段：

```json
{
  "name": "数据核对员",
  "description": "检查输入数据质量",
  "instructions": "检查真实数据，给出可复核结论。",
  "model": null,
  "max_turns": 12,
  "skill_ids": [],
  "mcp_server_ids": []
}
```

编辑接受相同字段的子集；`model:null` 恢复继承主模型。`max_turns` 为 1–100，最多引用 100 个 Skills 和 50 个 MCP；引用必须存在且类型匹配，重复 ID 去重。运行时还要求引用能力被当前用户启用。删除 Skill / MCP 时清理子代理引用。

`/health` 用于进程 / 数据库健康检查。当前部署仅支持单 worker 调度；重启后活动任务标记中断，历史事件与文件保留。
