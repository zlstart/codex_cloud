# AI 会话项目测试与修复报告

生成时间：2026-11-04 09:47:11 UTC+8。时区：Asia/Shanghai（UTC+8）。

本报告分开记录任务运行终态、产物正确性、应用预览和真实压缩支持。文件可下载、命令已返回或参数被接受，都不自动等于任务或能力通过。

## 测试矩阵

| 检查 | 证据类型 | 结果 | 说明 |
| --- | --- | --- | --- |
| Python 完整回归 | 自动化 / 含 SDK 协议替身 | 通过 | 217 项通过 |
| 代码规范 | 静态检查 | 通过 | 命令日志有明确成功标记 |
| 前端生产构建 | 真实构建 | 通过 | 命令日志有明确成功标记 |
| 实时/回放时间线 | 真实浏览器 + authored fixtures | 通过 | 命令日志有明确成功标记 |
| 文件预览与动态更新 | 真实浏览器 + authored fixtures | 通过 | 命令日志有明确成功标记 |
| 工具/Markdown 显示 | 真实浏览器 + authored fixtures | 通过 | 命令日志有明确成功标记 |
| 三体数值独立核验 | 真实模型文件 + 独立数值求解 | 通过 | 44 项检查；CSV 与更小步长 RK4 比对 |
| 工厂指标独立核验 | 真实模型文件 + 合成数据独立 oracle | 通过 | 173 / 173 项通过 |
| 工厂原始 HTML 离线交互 | 未修改真实模型 HTML + 浏览器离线 | 通过 | KPI、筛选、导出、空状态、桌面/手机布局 |
| 真实诊断后端 | 真实 provider + Docker + API | 通过 | 错误补丁 → 失败状态 → 正确补丁 → file/cat；真实 context.status |
| 真实诊断浏览器 | 真实 provider / backend，无 fixture | 通过 | 错误状态、超阈值未压缩提示、刷新回放 |
| 供应商原生压缩 | 真实 provider | 未验证 | 本次未返回 compaction，未通过真实压缩支持验收 |
| HTML 预览脚本修复复测 | 真实模型原件应用预览 + 浏览器安全 fixture（分项） | 通过 | 脚本/ID/CSP及布局时机修复通过；真实三体原版/修订版×桌面/手机、工厂桌面/手机共6组通过。 |
| 删除文件同步复测 | 真实历史会话 API + 浏览器 authored fixtures | 通过 | 真实工厂/三体过期文件已从清单移除；实时、历史回放与当前预览同步通过。 |
| TypeScript 类型检查 | 静态类型检查，最终命令退出码由主代理确认 | 通过 | 最新 typecheck/build/timeline/previews/rendering 联合命令 exit 0；类型检查通过。 |
| 工厂最终生产构建应用预览 | 真实模型原件 / 真实应用 / Chromium | 通过 | 3脚本执行；8584→975→8584；应用下载内容相同；360px筛选/重置无溢出。 |
| 三体收敛复核 | 真实模型生成结果 + 独立 RK4 全步重算 | 通过 | 51 项检查通过，三种步长、15个比较状态及原文件哈希独立核对。 |
| 三体第4轮文案更正 | 真实 provider + 原件结构化差异核对 | 通过 | 仅 .conclusion.practical_verdict 改变；所有数值原样，不再误将 h/2→h/4 的差值写成 h→h/4。 |
| 三体最终原件数据与视觉 | 真实模型原件 / 独立数据核对 / 离线 Chromium | 通过 | HTML样本与原CSV逐值相同；真实应用与离线桌面/手机通过；最终print版消除3处排版缺陷，旧11文件不变。 |
| 带属性 head 的 CSP 注入与隔离 | 真实 Chromium + authored 攻击 fixture | 通过 | DOM注入和网络前阻断检查通过；无真实外网攻击请求。 |
| 三体真实应用 canvas 尺寸与画面 | 真实模型原件 / 真实应用浏览器 | 通过 | 真实桌面670×670、手机334×334；RGB轨迹非空，暂停/继续/滑块/重置通过，无人工resize。 |
| 最终成果真实UI链接与下载 | 真实模型产物 / 真实应用下载 | 通过 | 最终CSV、metrics、final HTML、print PNG、convergence_final 5个真实UI链接下载与API字节及元数据一致。 |
| 运行中的真实生产文件预览 | 真实模型任务仍running / 真实生产UI / fresh Chromium | 通过 | CSV0.185s、HTML0.312s、PNG0.157s；每次前后API均running，0页面/控制台错，新增模型请求0。仅为本次3次加载记录，不作性能SLA。 |
| 最终服务重载与历史恢复 | 真实生产构建 / 重启后API与全部文件下载 | 通过 | /health、生产页、两真实会话与global/files均200；22个当前文件下载均200且size核对，过期2 IDs未复活。 |
| 真实 Docker 原生 SDK 冒烟 | 真实 Docker + 原生 Agents SDK 工具 | 通过 | 四组 PASS：原生 exec/patch/file/image/Skills 与隔离/HTTPS；持久化/刷新/清理；PTY 取消；聚合配额。file/time 已补齐，模型管道命令可靠性限制仍保留。 |

## 真实复杂任务

### 三体任务·首轮

- 运行：未通过；run_id：`c91dc208919b4712ba8382b65730df4d`。
- 服务器运行：2026-11-04 08:45:45 UTC+8 → 2026-11-04 09:00:57 UTC+8；实际运行 911.921 秒。
- 计时依据：API run.created_at → 终态事件时间；测试脚本记录耗时 912.149 秒（可能包含截图、轮询与采集延迟，不作为模型任务耗时）。
- 记录：238 个事件，25 次工具调用；终态证据：True。
- 终态错误：任务执行超时，请缩小任务范围后重试。。

### 三体任务·同会话续作

- 运行：运行完成；run_id：`678006372e99420e921a29c38c601537`。
- 服务器运行：2026-11-04 09:03:59 UTC+8 → 2026-11-04 09:07:24 UTC+8；实际运行 204.555 秒。
- 计时依据：API run.created_at → 终态事件时间；测试脚本记录耗时 251.006 秒（可能包含截图、轮询与采集延迟，不作为模型任务耗时）。
- 记录：488 个事件，6 次工具调用；终态证据：True。
- 终态错误：无；逐工具失败见下方审计。

### 三体任务·视觉最终修订

- 运行：运行完成；run_id：`4c954b1c65cc4632adef67fbe076bd58`。
- 服务器运行：2026-11-04 09:10:17 UTC+8 → 2026-11-04 09:17:31 UTC+8；实际运行 434.057 秒。
- 计时依据：API run.created_at → 终态事件时间；测试脚本记录耗时 641.249 秒（可能包含截图、轮询与采集延迟，不作为模型任务耗时）。
- 记录：328 个事件，4 次工具调用；终态证据：True。
- 终态错误：无；逐工具失败见下方审计。

### 三体任务·收敛说明文案更正（第4轮）

- 运行：运行完成；run_id：`efc56457ff5d427c8ea36e3b932ba361`。
- 服务器运行：2026-11-04 09:22:51 UTC+8 → 2026-11-04 09:23:52 UTC+8；实际运行 61.299 秒。
- 计时依据：API run.created_at → 终态事件时间；测试脚本记录耗时 60.78 秒（可能包含截图、轮询与采集延迟，不作为模型任务耗时）。
- 记录：153 个事件，1 次工具调用；终态证据：True。
- 终态错误：无；逐工具失败见下方审计。

### 三体任务·静态图最终排版

- 运行：运行完成；run_id：`bcbeabff56aa497abe1376b4566b446d`。
- 服务器运行：2026-11-04 09:36:00 UTC+8 → 2026-11-04 09:40:11 UTC+8；实际运行 251.424 秒。
- 计时依据：API run.created_at → 终态事件时间；测试脚本记录耗时 252.041 秒（可能包含截图、轮询与采集延迟，不作为模型任务耗时）。
- 记录：234 个事件，5 次工具调用；终态证据：True。
- 终态错误：无；逐工具失败见下方审计。

### 工厂报表·首轮

- 运行：未通过；run_id：`822c45733ce447fca53dbcae87f64c82`。
- 服务器运行：2026-11-04 08:45:47 UTC+8 → 2026-11-04 09:00:27 UTC+8；实际运行 880.139 秒。
- 计时依据：API run.created_at → 终态事件时间；测试脚本记录耗时 880.426 秒（可能包含截图、轮询与采集延迟，不作为模型任务耗时）。
- 记录：209 个事件，23 次工具调用；终态证据：True。
- 终态错误：模型返回了无法执行的工具请求或响应格式。已保留工作空间文件，请重试或调整模型。。

### 工厂报表·同会话恢复

- 运行：运行完成；run_id：`32c842db3ee9480b9734bdca7e3e2616`。
- 服务器运行：2026-11-04 09:04:21 UTC+8 → 2026-11-04 09:06:50 UTC+8；实际运行 149.046 秒。
- 计时依据：run.started 事件时间 → 终态事件时间（未取得 API created_at）；测试脚本记录耗时 149.982 秒（可能包含截图、轮询与采集延迟，不作为模型任务耗时）。
- 记录：548 个事件，4 次工具调用；终态证据：True。
- 终态错误：无；逐工具失败见下方审计。

### 真实诊断·压缩状态与补丁恢复

- 运行：运行完成；run_id：`6458c1da74ce415bac5777e51c93b6e3`。
- 服务器运行：2026-11-04 08:54:54 UTC+8 → 2026-11-04 08:55:31 UTC+8；实际运行 37.204 秒。
- 计时依据：API run.created_at → 终态事件时间；测试脚本记录耗时 None 秒（可能包含截图、轮询与采集延迟，不作为模型任务耗时）。
- 记录：97 个事件，3 次工具调用；终态证据：True。
- 终态错误：无；逐工具失败见下方审计。

## 问题、修复与复测

### 更新中的文件预览长期加载 · 通过

修复前：运行事件不断更新文件列表时，预览请求反复被取消，用户无法在任务进行中查看文件。

根因：effect 依赖文件修订元数据（size/created_at 等），更新触发请求清理/取消；并发更新时还需回收被移除的 sheet/page 选择。

修复：按稳定文件身份管理请求，内容更新后追赶最新修订；只在关闭/换文件时取消；数据缩小时重置分页和工作表选择。

复测：动态更新fixture覆盖17次修订和缩表分页复位；最终又在真实三体第5轮仍running时用fresh browser打开CSV/HTML/PNG，分别0.185/0.312/0.157秒加载，三次前后API均running，0页面/控制台错误。检查没有发起新模型请求，直接证明本次生产运行中可预览。

证据：`preview/before/preview-live-updates.json`、`preview/before-pagination-reset/preview-live-updates.json`、`preview/after/preview-live-updates.json`、`final/live-preview-final/report.json`

### 同一任务压缩后仍发送旧工具历史 · 通过

修复前：新增真实 SDK 协议测试在第三次模型请求发现旧 call_id；原测试只验证新 run，因此漏检。

根因：SDK 0.24 沙箱准备处理 original input，模型循环后拼接本轮新产物，原生边界未覆盖该完整请求。

修复：官方 call_model_input_filter 组合原生 ToolOutputTrimmer 与 Compaction.process_context；只在有真实 compaction 条目时移除旧请求历史。

复测：专项 44 项通过，覆盖压缩后两个工具配对、重复压缩、SQLite 重开及 provider 失败恢复；协议替身不算真实供应商支持。

证据：`compaction/REPORT.md`、`compaction/regression.log`、`compaction/full-regression.log`

### 超阈值但没有压缩时缺少可见诊断 · 通过

修复前：仅收到 compaction 时发成功事件，未压缩时没有输入量与阈值证据。

根因：界面把没有成功事件表现为空白，无法区分未达阈值、供应商未返回与显示缺失。

修复：增加每响应 context.status；显示实际输入 tokens、阈值及真实条目数量；实时/回放同 reducer，子代理独立归属。

复测：真实模型/API/浏览器验证准确显示“输入超过阈值，未观测到压缩”，刷新后保持；不把裁剪称为压缩。

证据：`final/diagnostic-live/checks.json`、`final/diagnostic-live/browser-checks.json`、`compaction-ui/browser-green.log`

### 当前供应商原生压缩仍未通过验收 · 未验证

修复前：历史报告使用 glm-5.3；本次环境实际为 qwen3.8-flash，必须重新验证。

根因：四次直接流式请求接受 context_management，但输入超阈值仍未返回 compaction。供应商内部原因未获证实。

修复：保留当前模型和 Responses 协议，增加诚实诊断；未伪造摘要或静默切换服务。

复测：真实 qwen3.8-flash 请求在默认 32000 阈值、实际输入 41296 / 41167 tokens 时仍无 compaction 条目。参数被接受、普通事实保留或 SDK 协议测试通过，都不等于真实原生压缩已经生效。保留未通过供应商原生压缩验收的结论。

证据：`compaction/live-provider-results.json`、`compaction/live-runtime-results.json`

### 原生 apply_patch 失败被展示为普通返回 · 通过

修复前：缺少 Begin Patch 的输入返回原生错误文本，但原事件缺少失败标记。

根因：SDK 0.24 custom tool 异常分支未经过 RunConfig.tool_error_formatter，不能靠该回调修复。

修复：用官方 Filesystem.configure_tools 包装原生 apply_patch，记录真实异常 call_id 后原样抛出，由 custom_data_extractor传出失败状态。

复测：真实 8002 诊断按错误补丁→正确补丁恢复→file/cat 全链路通过；不正则猜测任意输出，也不隐藏原错误。

证据：`final/diagnostic-live/checks.json`、`final/diagnostic-live/browser-checks.json`、`baseline/patch-status-before.log`、`baseline/patch-status-after.log`

### 沙箱缺少 file/time · 通过

修复前：真实任务触发 file/time 缺失；部分命令经 tail 管道后仍显示退出 0。

根因：初始镜像缺少基础 file/time 命令。模型将失败命令接入 tail 管道且未启用 pipefail 时，管道会返回尾部命令的 0；这不能要求界面凭 0 自动判断前段失败。

修复：镜像补齐 file/time；提示明确 POSIX/Bash 与 pipefail、补丁 Begin/End/+ 行，以及 write_stdin 必须使用真实 session ID。提示用于降低模型错误概率，不保证永不失败。

复测：新版Docker smoke四组PASS，真实诊断file成功，Bash pipefail校验通过。该PASS仅指工具可用性和已验证的执行语义；第5轮模型仍使用未启用pipefail的tee管道，多个Python Traceback被管道0退出码掩盖，模型命令写法没有因此根治。完整审计保留语义失败与后续恢复。

证据：`environment/file-command-before.json`、`environment/file-command-after.log`、`environment/time-command-before.log`、`environment/docker-sdk-smoke-final.log`、`final/diagnostic-live/checks.json`

### 生成文件删除后保留过期卡片和 404 · 通过

修复前：工厂验收下载已删除生成物时遇到 404；需要同步持久化清单、事件与已打开预览。

根因：文件扫描/事件链路未完整表达删除，与浏览器现有清单状态不一致。

修复：同步磁盘删除、持久化文件记录、artifact.removed 事件及前端实时/回放状态，当前预览在文件移除时正确关闭或更新。

复测：浏览器 fixture 的实时/回放删除场景通过；真实历史工厂与三体会话的过期文件 ID 均从清单消失，会话访问仍为 200。两种证据分别记录，没有把 fixture 当真实模型验证。

证据：`artifact-removal/frontend/before/artifact-removal.json`、`artifact-removal/frontend/after/artifact-removal.json`、`artifact-removal/real-legacy-after.json`

### HTML 预览清理误删脚本，报表与动画未初始化 · 通过

修复前：应用内工厂 KPI 为 —，三体 canvas 不动；同一下载原件离线交互正常。

根因：原预览净化使用跨标签字符串规则，脚本中的标记文本可能导致合法脚本内容被误删；另有合法元素 id 丢失，影响生成页面初始化。

修复：按 DOM 节点处理并保留合法内联脚本及标识，在隔离 iframe 中执行，外部资源与导航限制保持。

复测：真实工厂原件的 3 个脚本均保留并执行，真实应用 KPI 随筛选/重置 8584 → 975 → 8584，应用下载按钮获得相同 HTML；360px 手机视口无横向溢出。三体画布尺寸问题独立列为未完成项，不包含在此通过结论中。

证据：`html-preview/diagnostic.json`、`html-preview/identifier-diagnostic.json`、`factory/preview-production-final.json`、`html-preview/previews-regression.log`、`html-preview/build.log`

### 三体静态 PNG 的重叠、越框与缺字 · 通过

修复前：数值验收通过，但首轮 PNG 与手机画面仍存在注释遮挡或裁切，不能把数值正确等同于视觉交付合格。

根因：根代理复检前一版PNG发现底部页脚重叠、右栏越框、E0/L0缺字；数值/HTML通过不能替代静态图最终可读性验收。

修复：第5轮真实模型另存three_body_print.png，直接使用既有CSV/metrics/convergence数据重绘版式，不重新积分、不修改已有文件；ASCII E0/L0、独立footer与右栏边界检查。

复测：最终print版2010×1320已通过根代理及独立目视：三处缺陷消除；像素边界测量横轴标题底876px、footer顶1081px，间隔205px；右栏54条文字在框内，E0/L0完整。源文件哈希匹配、11旧文件不变，真实UI5个最终链接下载内容与API一致。第5轮前3个语义失败及第4个中间版式自检失败保留，第5个调用修复后检查全过。

证据：`three-body/visual-final/three_body_final.png`、`three-body/print-final/print-verification.json`、`three-body/print-final/tool-audit.json`、`three-body/print-final-delivery-verification.json`、`three-body/visual-final/data-verification.json`、`three-body/convergence-final/diff-verification.json`、`three-body/three-body-result.json`

### head 带属性时字符串替换漏注入隔离策略 · 通过

修复前：恢复合法 id 后，review 发现 head 若带属性，原字符串替换可能漏注入 CSP。

根因：恢复合法标识后的 review 发现，原固定 <head> 字符串替换无法覆盖带属性的 head，可能漏注入 CSP。

修复：改为 DOM 插入 CSP 与限制节点，增加带属性 head 等攻击 fixture，检查外部请求在到达网络前被阻止。

复测：CSP 攻击 fixture、预览回归及生产构建通过。该结论属于真实 Chromium 上的 authored fixture 隔离测试，不冒充真实供应商能力；未向真实外网发送攻击请求。

证据：`html-preview/csp-red.log`、`html-preview/csp-green.log`、`html-preview/previews-regression.log`、`html-preview/build.log`

### 真实三体预览的 canvas 初始尺寸仍可能为 1×1 · 通过

修复前：恢复脚本及合法标识后，真实应用预览仍出现 canvas 初始 1×1，需要继续检查布局。

根因：React挂载iframe时立即设置srcdoc，生成页面的内联初始化可能早于iframe完成布局，getBoundingClientRect首次读取0，页面将canvas backing store钳为1×1。未证实display:none是原因。

修复：先挂载opaque iframe，由ResizeObserver确认非零尺寸后再加载原srcdoc；保持生成脚本原样，不向脚本注入resize。同步补充已加载HTML刷新生命周期与初始化fixture。

复测：真实应用对三体原版/修订版×桌面/手机均通过：桌面670×670、手机334×334，独立检查确认RGB轨迹像素存在，暂停/继续/滑块/重置正确；无人工resize、无page error。旧canvas-timing FAIL保留，已由新的production-final强验收取代。

证据：`html-preview/real-artifact-before-canvas.json`、`html-preview/canvas-red.log`、`html-preview/canvas-green.log`、`html-preview/loaded-frame-regression.log`、`html-preview/real-artifact-verification.json`、`three-body/production-final-interaction-verification.json`、`three-body/production-final-mobile-interaction-verification.json`、`html-preview/overview-verification.json`

### 输出目录失效或替换为符号链接时文件同步抛 500 · 通过

修复前：删除同步修复后的边界 review 发现，reconcile_outputs 遇到失效目录或符号链接可能抛 500。

根因：reconcile_outputs在安全检查前调用会mkdir的workspace()；outputs被悬空symlink或普通文件替代时FileExistsError阻断GET与任务终态处理。

修复：workspace初始化失败时保守跳过文件同步并保留现有元数据，不跟随不可信符号链接、不删除已有记录。

复测：先由2项失败回归复现，再经8项相关测试通过；最终完整Python217项、Ruff与git diff --check通过，独立review无未解决P0/P1/P2。

证据：`artifact-removal/unsafe-directory-before.log`、`artifact-removal/backend-after.log`、`artifact-removal/REPORT.md`、`final/code-review.md`、`final/pytest.log`、`final/ruff.log`

## 数值验收

三体独立求解与 CSV 再计算：

```json
{
  "sample_count": 1266,
  "initial_energy": -1.2871419917663254,
  "max_relative_energy_error": 2.1354125338515813e-09,
  "initial_angular_momentum": 0.0,
  "max_absolute_angular_momentum_error": 1.9475803192392505e-09,
  "max_center_of_mass_norm": 4.714045597952174e-10,
  "minimum_pair_distance_csv_samples": 0.690526646322119
}
```

工厂独立 oracle：173 / 173 项通过。

## 逐工具审计

完整脱敏参数、输出、事件序号和 call_id 在同目录 `results.json` 的 runs[].tool_calls；HTML 提供逐项折叠阅读。

### 三体任务·首轮

| 次序 | 工具 | 状态 | 时长（秒） | call_id |
| --- | --- | --- | ---: | --- |
| 1 | exec_command | 已返回 | 1.675 | `call_5c02d92d2cd340cab64d8b01` |
| 2 | exec_command | 已返回 | 1.014 | `call_0c80e4b5ffee4358b952d26c` |
| 3 | exec_command | 已返回 | 1.478 | `call_dde3d10f21c34fda929906bc` |
| 4 | exec_command | 已返回 | 1.003 | `call_176f7d6d271a4758a1e8bab6` |
| 5 | update_plan | 已返回 | 0.054 | `call_d1a270babd8b4ccd8cd6f6dc` |
| 6 | apply_patch | 未通过 | 0.02 | `call_43645fc3d3654b2e91c36781` |
| 7 | apply_patch | 已返回 | 0.846 | `call_23946856fe944934ba654539` |
| 8 | apply_patch | 未通过 | 0.197 | `call_9c2e6fad26a748388a8eae63` |
| 9 | exec_command | 已返回 | 0.395 | `call_364b008bedd44d10b2a5b78d` |
| 10 | apply_patch | 已返回 | 0.783 | `call_47e4ad2867204977bc406ec7` |
| 11 | apply_patch | 已返回 | 0.889 | `call_0607641908fb4eff8dfb01bb` |
| 12 | exec_command | 未通过 | 0.198 | `call_e3715e0b5be94b90959a6e89` |
| 13 | exec_command | 未通过 | 0.394 | `call_98ea28a73c54435b98a95a9b` |
| 14 | apply_patch | 已返回 | 0.881 | `call_58ff17045eb44cfeb998cb95` |
| 15 | exec_command | 已返回 | 18.61 | `call_e46e010b797140ee850d847c` |
| 16 | exec_command | 已返回 | 0.897 | `call_4bb45edcbb58403c8a42cec1` |
| 17 | exec_command | 已返回 | 0.39 | `call_092f6806f17041a393c620f4` |
| 18 | apply_patch | 已返回 | 0.912 | `call_b99fb3346d5546038dcbcd66` |
| 19 | apply_patch | 已返回 | 1.067 | `call_2194c0ff062245098a005d8a` |
| 20 | apply_patch | 已返回 | 0.916 | `call_0210f1a6cfd2472cbf977b92` |
| 21 | exec_command | 已返回 | 18.251 | `call_55c0342ad95e4a4ebf9f207c` |
| 22 | exec_command | 已返回 | 0.66 | `call_3ae68b2a13d9407486e71cdb` |
| 23 | exec_command | 已返回 | 0.811 | `call_0330ff02c38f47b49b068f2e` |
| 24 | view_image | 已返回 | 0.546 | `call_3eae4811ec93408a8e80d06a` |
| 25 | exec_command | 已返回 | 0.436 | `call_177399d3381340a3a217c954` |

### 三体任务·同会话续作

| 次序 | 工具 | 状态 | 时长（秒） | call_id |
| --- | --- | --- | ---: | --- |
| 1 | exec_command | 已返回 | 29.122 | `call_02c1d00e344c4c6e8822b5d2` |
| 2 | apply_patch | 已返回 | 0.677 | `call_70f142eaa6e74736a5c0fb73` |
| 3 | exec_command | 已返回 | 13.908 | `call_1705e78bb6794cb7999a0eda` |
| 4 | apply_patch | 已返回 | 0.896 | `call_57a42e68f8324f9a89d41e1c` |
| 5 | exec_command | 未通过 | 11.642 | `call_130c30d256834ff6ad2fd436` |
| 6 | exec_command | 已返回 | 0.187 | `call_6adb2aa02ba843ee8d5a7fec` |

### 三体任务·视觉最终修订

| 次序 | 工具 | 状态 | 时长（秒） | call_id |
| --- | --- | --- | ---: | --- |
| 1 | exec_command | 已返回 | 0.266 | `call_0ea65be9f4b74440a39d9601` |
| 2 | apply_patch | 已返回 | 0.237 | `call_32768cadcab440c4ab7e8913` |
| 3 | apply_patch | 已返回 | 0.931 | `call_483914ed71b64cfa8d96dfad` |
| 4 | exec_command | 已返回 | 1.663 | `call_613ef27538a84ad9939d5371` |

### 三体任务·收敛说明文案更正（第4轮）

| 次序 | 工具 | 状态 | 时长（秒） | call_id |
| --- | --- | --- | ---: | --- |
| 1 | exec_command | 已返回 | 0.374 | `call_8cbddc3c6bec4d5eafd467c0` |

### 三体任务·静态图最终排版

| 次序 | 工具 | 状态 | 时长（秒） | call_id |
| --- | --- | --- | ---: | --- |
| 1 | exec_command | 未通过 | 1.403 | `call_a719f03369504e40922edc03` |
| 2 | exec_command | 未通过 | 1.363 | `call_b457ae20469446d09f7e0cf9` |
| 3 | exec_command | 未通过 | 1.268 | `call_cce07aa85c8e4be6b89d2c39` |
| 4 | exec_command | 未通过 | 2.638 | `call_a7da351bb1c747128192d9d5` |
| 5 | exec_command | 已返回 | 2.017 | `call_9fd0537e19cb4f97826c9afc` |

### 工厂报表·首轮

| 次序 | 工具 | 状态 | 时长（秒） | call_id |
| --- | --- | --- | ---: | --- |
| 1 | exec_command | 已返回 | 1.821 | `call_f010b1b390704b9d86a7d2ee` |
| 2 | exec_command | 已返回 | 1.332 | `call_1d56185b20164a6fbff5a76c` |
| 3 | exec_command | 未通过 | 3.621 | `call_35ea49e7af644b4a827a279a` |
| 4 | exec_command | 已返回 | 0.836 | `call_9f13303ea8d74cc59ac53ef9` |
| 5 | exec_command | 已返回 | 0.212 | `call_14a6e6f9a78f4e5990256688` |
| 6 | exec_command | 已返回 | 0.806 | `call_6a365e92583644db96085529` |
| 7 | write_stdin | 未通过 | 0.042 | `call_43c7e83b778544439c659aa1` |
| 8 | apply_patch | 未通过 | 0.067 | `call_9bf63795539f42eeb61ef51b` |
| 9 | apply_patch | 已返回 | 0.65 | `call_cb14714274c848ac8310422c` |
| 10 | exec_command | 已返回 | 0.136 | `call_e8a058edb10e4172b5b80784` |
| 11 | apply_patch | 已返回 | 0.967 | `call_e853a581ff2c49bfb6a2d1b3` |
| 12 | apply_patch | 已返回 | 0.979 | `call_581da84cd9c94ddc8bf28322` |
| 13 | apply_patch | 已返回 | 1.42 | `call_f84bf4ba2d594676a979718f` |
| 14 | exec_command | 已返回 | 1.203 | `call_376d6939ea2146cca6441b15` |
| 15 | exec_command | 已返回 | 0.471 | `call_39305f3d1e61484d979da1c3` |
| 16 | exec_command | 已返回 | 0.988 | `call_a988de18ee454d59ae07def1` |
| 17 | apply_patch | 未通过 | 0.142 | `call_6ce69dd4eff24704972ecd96` |
| 18 | exec_command | 已返回 | 0.23 | `call_b38297e1c9484655b0527feb` |
| 19 | exec_command | 已返回 | 0.381 | `call_0ea87b0f52af456488b1de13` |
| 20 | exec_command | 已返回 | 1.01 | `call_4b6c49d36e50419c804a0ab7` |
| 21 | exec_command | 已返回 | 0.475 | `call_7187eb27982f47ae85b660e2` |
| 22 | exec_command | 已返回 | 0.239 | `call_5fcfa0d7cbc0412eb3da0931` |
| 23 | exec_command | 已返回 | 0.314 | `call_1e9f46c4d64541ee9b6f39a3` |

### 工厂报表·同会话恢复

| 次序 | 工具 | 状态 | 时长（秒） | call_id |
| --- | --- | --- | ---: | --- |
| 1 | exec_command | 已返回 | 2.949 | `call_19cd3ae060d74f599fd85000` |
| 2 | exec_command | 已返回 | 0.429 | `call_627fe31c74df455eb5336ed5` |
| 3 | exec_command | 已返回 | 0.407 | `call_180fb59c0b5148518b9149c5` |
| 4 | exec_command | 已返回 | 0.291 | `call_409f808c70664ad6964b8f9f` |

### 真实诊断·压缩状态与补丁恢复

| 次序 | 工具 | 状态 | 时长（秒） | call_id |
| --- | --- | --- | ---: | --- |
| 1 | apply_patch | 未通过 | 0.08 | `call_a87f2ad7b84444b0afce5e0c` |
| 2 | apply_patch | 已返回 | 0.781 | `call_44428e541818443ea8c25367` |
| 3 | exec_command | 已返回 | 0.187 | `call_e1aed6eb05b4438aa45b5284` |

## 截图与边界

关键截图已嵌入 `report.html`，无需网络。截图原始界面时间可能是浏览器 UTC；报告表格统一北京时间。

浏览器 mobile 表示模拟视口，不等于实体手机；离线 HTML 通过断网 context + setContent 检查，受管理浏览器禁止 file://，未宣称 file:// 导航测试。

真实供应商未返回 compaction 时，压缩后语义保真仍为未验证。SDK HTTP fixture 验证应用协议处理，不证明供应商支持。

首轮任务失败与后续续作终态独立记录；pending 不视为完成。完整工具输出只保留产品事件允许的内容，不含密钥、auth-state、私有 reasoning 或压缩密文。

运行耗时已按服务器 API created_at → 对应终态事件重算；三体视觉修订约 434 秒，原 641.249 秒是测试脚本采集耗时，不作为真实模型任务耗时。实际运行包含沙箱准备、模型调用与工具执行，不能称为纯推理耗时。

用户关心的运行中预览已取得最终生产证据：在三体第5轮仍运行时，新浏览器分别打开CSV、HTML和PNG，三次前后API均为running，均成功加载且无浏览器错误。该检查未新增模型请求。

三体共五轮：首轮超时，随后完成收敛复核、HTML视觉修订、收敛说明更正及最终print静态图。第4轮仅改说明字符串；第5轮直接复用已有数值，原11文件哈希不变，最终PNG三处排版缺陷全部消除。

工厂首轮为 ModelBehaviorError 类失败，但现有记录没有保留触发该异常的完整具体原因；本报告不将其武断归因于 HMR。后续同会话恢复完成，最终真实应用中的筛选、重置、下载及手机布局通过。

HTML 脚本/合法标识保留、CSP DOM 注入与 iframe 布局时机均已修复。真实应用中三体原版/修订版 × 桌面/手机及工厂桌面/手机共6组复验通过；供应商原生压缩仍未返回 compaction，因此能力边界继续明确保留。

最终PNG经第5轮真实模型修订与独立像素边界/哈希核验通过；中间Python错误和版式自检失败未隐藏，最终成功恢复。应用修复均有复测证据，供应商原生压缩仍单独未验证。

旧controls-only应用内交互结果不能证明画布正确；最终以新增production-final尺寸、RGB像素与交互强验收为准。旧canvas-timing失败保留用于前后对照。

工厂 iframe 未授予 allow-downloads，因此 iframe 内导出 CSV 被隔离策略限制；未修改原始 HTML 离线导出已通过，真实应用的文件下载按钮也已验证内容一致。

三体首轮 4 个失败调用涉及模型补丁输入/命令错误；其中 time 后接 tail 掩盖退出码属于模型管道写法问题。已确认的应用缺陷是原生 apply_patch 异常状态丢失，而原生 shell code 2 的界面已有失败显示。

收敛续轮的 KeyError 发生在已生成 convergence.json 之后的结果打印诊断；独立51项核验与哈希检查证明数据正确。模型最终文字存在差值对象误标，已由第4轮纠正且数值未变。

工厂首轮具体 ModelBehaviorError 触发原因未充分记录，本报告不将其归因于 HMR 或某一已修复预览缺陷。

第5轮静态图排版再次暴露模型执行可靠性限制：CONV路径类型与Bbox接口使用错误产生Python Traceback，但tee管道退出0掩盖前段失败。运行指令已明确pipefail，本轮模型仍未遵循。报告依独立逐调用审计记录语义失败和恢复，不新增前端输出字符串猜错规则，也不把工具返回0当业务正确。

测试工具自身问题单独记录：重载验证最初误请求/api/health得到404，已按真实路由/health修正；云策略拒绝读取/proc/<pid>/cwd后改用已知QA进程命令行核对。两者均非产品缺陷，不计入产品失败。
