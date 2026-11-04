# 2026-11-04 · 复杂任务回归与修复

[返回报告索引](../../README.md) · [说明文档](../../../guides/README.md)

本批次记录三体运行轨迹、HTML 工厂生产报表、每一步工具调用、运行中工作区预览及上下文压缩验证。报告生成于北京时间 2026-11-04，基于提交 `564a561becb9af061d94549617830c8b8ffad73f` 及本轮修复。

## 阅读入口

- [详细 Markdown 报告](report.md)
- [离线图文 HTML（内嵌 34 张图、可展开逐工具审计）](report.html)
- [PDF 报告](report.pdf)
- [完整结构化审计](results.json)
- [34 张原始截图及证据范围](screenshots/README.md)
- [完整测试证据与产物 ZIP](qa-report-and-evidence.zip)
- [归档文件 SHA256](archive-manifest.json)

## 本轮结论

8 轮真实运行、2,295 条事件、71 次工具调用均保留；两次首轮任务失败与后续恢复独立展示。217 项后端回归、前端构建与浏览器回归、4 组真实 Docker 原生 SDK 冒烟通过。运行中预览、HTML 脚本与画布初始化、工具失败标记、过期文件同步等已修复并复验。

**当前供应商的原生上下文压缩仍未通过真实验收。** 多次超阈值响应未返回 compaction。应用侧历史处理和状态提示修复、SDK 协议测试通过，均不能替代真实服务的压缩结果。

模型命令仍出现过不存在的库接口及管道掩盖错误的问题；报告保留每次失败与恢复，不将退出码 0 或最终文件存在等同于业务正确。

## 经核验的实际产物

| 场景 | 产物 |
| --- | --- |
| 三体 | [交互动画](deliverables/three-body/three_body_final.html)、[打印轨迹图](deliverables/three-body/three_body_print.png)、[轨迹 CSV](deliverables/three-body/three_body.csv)、[指标](deliverables/three-body/metrics.json)、[收敛复核](deliverables/three-body/convergence_final.json) |
| 工厂 | [HTML 运行报表](deliverables/factory/factory_report.html)、[清洗 CSV](deliverables/factory/cleaned_production.csv)、[指标](deliverables/factory/metrics.json) |

[产物来源及 SHA256](deliverables/manifest.json)记录原字节副本。HTML 预览保留隔离下载限制；使用报表内部导出功能时，先下载 HTML 再由浏览器打开。

## 归档范围

主报告、PDF、JSON 和 ZIP 保留生成时的原字节；截图另存供仓库直接浏览。ZIP 包含当轮脱敏工具记录、测试脚本、日志、原件及当时的代码补丁快照，按包内 `SHA256SUMS` 可校验。ZIP 中的补丁是该批次历史快照，当前代码以仓库为准。

原始记录中的 `/workspace/...` 路径描述测试环境，不是本仓库的运行前提；报告提到的原始证据位于 ZIP 的 `evidence/` 下。不包含认证状态、Cookie、API 密钥或测试数据库。
