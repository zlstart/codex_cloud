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

文件记录包含 `id,session_id,name,mime_type,size,kind,created_at,url`；`kind` 为 `upload` / `output`。URL 不是公开分享链接，仍需要所属用户的 Cookie。默认上传与登记产物上限 100 MiB，单会话 2048 MiB；上传请求需要 Content-Length。活动任务期间不允许上传或删除文件，返回 409。

### Office 预览

`/preview` 接受 `.xlsx`、`.xlsm`、`.xls`、`.docx`、`.pptx`。其他格式返回 415，可通过 `/content` 在浏览器预览或下载。超过独立的 25 MiB 预览上限返回 413；损坏、加密、解析超时或资源超限返回 422。

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

XLSX/XLSM 工作表还返回可选 `display_rows:(string|null)[][]`，与 `rows` 同坐标。非空值用于展示常见小数位、百分比、千分位及带引号的单位；原始 `rows` 保持数值类型。`number_format_fallback:true` 表示存在暂不支持的格式或显示预算不足，相应单元格回退原值并提示。多段格式、条件、颜色、区域码、分数、科学计数和自定义日期格式不作猜测性转换。

DOCX 保留有序正文、标题、表格和内嵌图片；`paragraphs` 保留为旧客户端的纯文本兼容字段：

```json
{
  "kind": "document",
  "paragraphs": ["生产报告", "产线 | 产量", "A | 120"],
  "blocks": [
    {"type": "paragraph", "text": "生产报告", "heading": 1},
    {"type": "table", "rows": [["产线", "产量"], ["A", "120"]]},
    {"type": "image", "src": "data:image/png;base64,...", "alt": "文档内嵌图片", "width": 640, "height": 360}
  ],
  "truncated": false
}
```

PPTX 响应为 `{kind:"presentation",width,height,total_slides,slides,truncated}`。`slides` 按页序排列，每页包含 `title`、可选 `background` 和 `elements`。各元素使用 CSS 像素坐标 `x,y,width,height`（96 dpi），类型如下：

| `type` | 内容 |
| --- | --- |
| `text` | `paragraphs:[{text,font_size?,color?,bold?,italic?,align?}]`，可选 `fill,stroke,shape` |
| `shape` | 可选 `fill,stroke`；`shape` 为 `rect`、`ellipse` 或 `roundRect` |
| `table` | `rows:string[][]`，可选 `column_widths`、`row_heights`、`cells`（对应单元格段落、填充及文本边距） |
| `image` | `src` 为内嵌图片 data URL，可选 `alt` |

PPTX 文本段落还可包含 `font_family`、`space_before`、`space_after` 及 `line_spacing:{kind:"multiple"|"pixels",value}`。文本形状与表格单元格的 `text_frame` 可包含四边 `margins`、`vertical_align`、`word_wrap`；原件明确使用 `SHAPE_TO_FIT_TEXT` 时返回 `auto_size:"shape_to_fit_text"`，按原语义自动增高。原生缩小字体以适应框体、合并表格和复杂主题继承未完整复现，会标记简化；前端不会自行缩小字体掩盖溢出。缺少这些扩展字段的旧响应仍使用基本预览。

表格预览最多 20 个工作表，每表 1,000 行 / 50 列、总计 50,000 单元格。DOCX 最多 2,000 个块；PPTX 最多 30 页、每页 200 个形状、总计 2,000 个段落；两者表格共享 20,000 单元格预算。文本总预算为 2,000,000 字符，单个文本值最多 4,096 字符。DOCX/PPTX 内嵌图片只接受静态 PNG/JPEG/GIF/WebP：最多 64 张、原图字节合计 5 MiB、总计 64 百万像素；单张不超过 2 MiB、16 百万像素、最长边 8,192 像素。data URL 的 Base64 编码会增加响应体积。

Office ZIP 最多 5,000 个条目、100 MiB 展开体积；大条目压缩比例不超过 250。最多四个解析进程并发，每个限制 768 MiB 地址空间、10 秒 CPU、15 秒等待时间和禁止文件写入。解析器不计算公式、执行宏或获取外部链接；公式只显示文件已有的缓存结果，可能为空。

预览不等于完整 Office 渲染：XLSX 不展示图表、图片或复杂格式；DOCX 不复刻分页、页眉页脚和复杂排版；PPTX 不复刻主题、动画、原生图表、分组图形或复杂变换。`truncated` 标记超限、已识别的省略或简化内容，不能据其为 `false` 推断版式完全一致。原文件不被修改，下载始终返回原始文件。

### HTML 与其他浏览器预览

HTML 最多读取 2 MiB，预览使用完整的有界 HTML，避免截断脚本或 Base64 图片；只有源码视图按 250,000 字符截取。清洗后的内联脚本和事件处理器在 `sandbox="allow-scripts"` 的不透明来源 iframe 中执行，不授予 `allow-same-origin`、顶层导航、弹窗、表单提交或下载权限。子文档 CSP 禁止外部资源；应用文档的 `frame-src 'none'` 同时阻止 iframe 自身导航到其他 URL。外部脚本、样式依赖与跨文件资源不会加载；需要持久化存储的应用应处理不透明来源下的存储不可用情况。

`/content` 直接打开时仍有禁止脚本的 sandbox CSP，交互只在上述隔离预览中运行。PDF 由浏览器逐页渲染；代码使用语法高亮，Markdown、CSV、图片和浏览器支持的音视频采用各自预览。下载保留原始字节，不注入预览策略或改变内容。

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
| `run.tracing` | `provider,status,trace_id,url,workflow_name,sensitive_data`；状态为 `enabled` / `disabled` / `missing_key`，详见 [追踪指南](TRACING.md) |
| `text.started` | `item_id,phase`，创建文字块 |
| `text.delta` | `item_id,delta,phase`，追加到相同文字块 |
| `text.completed` | `item_id,text,phase`，`text` 替换为完整权威文本 |
| `text.phase` | `item_id,phase`，将根代理最终答案标为 `final` |
| `tool.started` | `call_id,item_id,name,arguments` |
| `tool.completed` | `call_id,item_id,name,output,status?`，按 call ID 完成原工具块；`status=failed/error` 表示工具返回失败，不能显示为成功 |
| `tool.failed` | 相同工具身份和可读失败输出；保留在执行过程内，不替代任务终态 |
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

编辑接受相同字段的子集；`model:null` 恢复继承主模型；`max_turns:null` 恢复继承部署轮数（默认 200）。显式 `max_turns` 为 1–10000，最多引用 100 个 Skills 和 50 个 MCP；引用必须存在且类型匹配，重复 ID 去重。运行时还要求引用能力被当前用户启用。删除 Skill / MCP 时清理子代理引用。

`/health` 用于进程 / 数据库健康检查。当前部署仅支持单 worker 调度；重启后活动任务标记中断，历史事件与文件保留。
