已按要求只做局部修正，未重新积分、未重绘、未改动 CSV/metrics/PNG。

**周期说明修正**
- `outputs/three_body.html:153` 与 `outputs/simulate_three_body.py:526`（HTML_TEMPLATE 内）同一句已替换为：状态在 t ≈ 6.33 回到起点附近（周期约 6.326），t = 12.65 约相当于两个周期
- 该结论由已交付的 `outputs/three_body.csv` 直接佐证：t>0 时与初值状态的最小距离出现在 t=6.33（|Δstate|=0.0096），t=12.65 处 |Δstate|=0.0043；文中不再出现 6.916 与 1.83 周期

**360/390px 横向溢出修正（仅 CSS，未隐藏溢出）**
- 表格：`table-layout:fixed` + 首列 26% + `overflow-wrap:anywhere;word-break:break-word`，长数字换行而非撑破容器
- 容器：`main{grid-template-columns:minmax(0,1fr)}`、`main>*{min-width:0;max-width:100%}`、`.card{min-width:0}`、980px 断点去掉 `minmax(360px,…)` 硬下限
- 控件：`button/select/label/canvas/table/code/.chip/.tag/.warn/footer` 加 `max-width:100%`，`input[type=range]{min-width:0;flex:1 1 0}`，`.slider-row{flex-wrap:wrap}`，`output{min-width:0}`
- 指标网格：`.kv{grid-template-columns:minmax(0,auto) minmax(0,1fr)}`，值列 `min-width:0;overflow-wrap:anywhere`
- ≤620px 断点改为：主/卡片内边距 8–10px、表格 10.5px、HUD 与 `.kv` 12px、chip/tag 11.5px，文字仍可换行不裁切
- 全文无 `overflow-x:hidden`、无 `overflow:hidden`，canvas 的 `width:100%;aspect-ratio:1/1` 保持不变

**一致性核验（实测）**
- SHA256 前后相同：`outputs/three_body.csv` 07976028c6b72226、`outputs/metrics.json` 4d7525b5e71ec422、`outputs/three_body.png` 0fcc48ffeb84eac3
- HTML 内嵌 1266 行采样数据逐字节一致（e192b72d967e8cbb），`dt/G/masses/t_end/sample_dt` 等物理与采样元参数未变
- 成品 `<style>` 与生成器 `HTML_TEMPLATE` 的 CSS 逐字符一致，复现时会生成同样的修正文本；生成器仅 `ast.parse` + 导入常量校验，未执行 `main()`
- node DOM-stub 回归 16/16 通过：暂停冻结、继续推进、滑块定位 t=8.00、重置回 t=0 并暂停、到 12.65 自动暂停、实时 E 与 ΔE/E₀ 读数吻合
- 说明两点：容器内无浏览器，故未实测 `scrollWidth`（修正为结构性可收缩，非裁切）；`output` 规则中残留的 `min-width:8.5em` 已被同块后面的 `min-width:0;flex:0 0 auto` 覆盖、不生效，需要彻底删掉这一行我可以再补一次编辑。

**文件链接**
- `outputs/three_body.csv`
- `outputs/metrics.json`
- `outputs/three_body.png`
- `outputs/three_body.html`
- `outputs/simulate_three_body.py`