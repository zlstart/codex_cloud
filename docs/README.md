# 项目文档

说明文档与测试报告分开维护。历史报告反映当时版本的实测结果，不代表当前版本或其他供应商已经通过相同检查。

- [说明文档](guides/README.md)：部署、架构、API、扩展、追踪、SDK 审计及设计计划。
- [测试报告归档](reports/README.md)：按测试日期和批次查看报告、截图及原始证据。
- [最新报告：2026-11-04 复杂任务回归](reports/2026-11-04/complex-regression/README.md)：三体轨迹、工厂报表、运行中预览、工具执行及上下文压缩。

```text
docs/
├── README.md
├── guides/
│   ├── README.md
│   ├── API.md、ARCHITECTURE.md、DEPLOYMENT.md 等
│   ├── plans/
│   └── specs/
└── reports/
    ├── README.md
    ├── 2026-10-30/delivery/
    ├── 2026-11-02/{deployment,live-model,sdk-native}/
    ├── 2026-11-03/{sqlite-workspace-tracing,production-acceptance}/
    └── 2026-11-04/complex-regression/
```

新增说明放入 `guides/`。新增测试报告使用 `reports/YYYY-MM-DD/<batch>/`，日期按北京时间；同一天多轮测试使用不同批次目录（必要时加 `HHmm-` 前缀），不覆盖已归档批次。每个批次提供 `README.md`，说明范围、结论、限制和附件入口，并更新报告总索引。

执行中的临时结果写入被 Git 忽略的 `test-results/`。归档前检查认证状态、Cookie、API 密钥和私有数据；通过检查后再保存截图和证据。归档截图不得由后续常规测试直接覆盖。
