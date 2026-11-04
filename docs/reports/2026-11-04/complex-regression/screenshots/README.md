# 2026-11-04 复杂任务回归截图

[返回本批次报告](../README.md)

截图保留原始像素；每张图注明真实模型、浏览器测试数据或独立数值核验的证据范围。

## 01 · 修复前：更新中的预览无法完成加载

浏览器 fixture

![修复前：更新中的预览无法完成加载](01-preview-failure.png)

## 02 · 修复后：持续更新期间预览可读

浏览器 fixture

![修复后：持续更新期间预览可读](02-preview-during-updates.png)

## 03 · 修复后：工作表缩小时分页复位

浏览器 fixture

![修复后：工作表缩小时分页复位](03-preview-shrinking-workbook.png)

## 04 · 真实模型：超过阈值但未返回原生压缩条目

真实 provider / API / UI

![真实模型：超过阈值但未返回原生压缩条目](04-real-compaction-status.png)

## 05 · 真实模型：补丁失败被正确标记并恢复

真实 provider / API / UI

![真实模型：补丁失败被正确标记并恢复](05-real-patch-failure-fixed.png)

## 06 · 三体首轮：终态失败，不能以文件存在替代成功

真实 provider / UI

![三体首轮：终态失败，不能以文件存在替代成功](06-03-final-answer.png)

## 07 · 修复前：应用内三体动画未初始化

真实模型产物 / 应用预览

![修复前：应用内三体动画未初始化](07-05-app-html-desktop-failure.png)

## 08 · 三体原件：离线暂停、继续、滑块与重置

真实模型原件 / 离线 Chromium

![三体原件：离线暂停、继续、滑块与重置](08-06-offline-desktop-interaction.png)

## 09 · 三体原件：390px 浏览器视口交互

浏览器模拟手机视口

![三体原件：390px 浏览器视口交互](09-06-offline-mobile-interaction.png)

## 10 · 修复前：应用内工厂 KPI 未初始化

真实模型产物 / 应用预览

![修复前：应用内工厂 KPI 未初始化](10-app-preview-initialization-failure.png)

## 11 · 工厂原件：独立核对后的离线报表

真实模型原件 / 离线 Chromium

![工厂原件：独立核对后的离线报表](11-baseline-desktop-full.png)

## 12 · 工厂原件：产线、班次筛选改变 KPI

真实模型原件 / 离线 Chromium

![工厂原件：产线、班次筛选改变 KPI](12-baseline-desktop-filtered.png)

## 13 · 工厂原件：空筛选不会产生 NaN / Infinity

真实模型原件 / 离线 Chromium

![工厂原件：空筛选不会产生 NaN / Infinity](13-baseline-empty-filter.png)

## 14 · 工厂原件：手机视口筛选与布局

浏览器模拟手机视口

![工厂原件：手机视口筛选与布局](14-baseline-mobile-filtered.png)

## 15 · 修复前：删除产物清单与预览未同步

浏览器 fixture

![修复前：删除产物清单与预览未同步](15-failure.png)

## 16 · 后续复测截图 · removed-global-live

以对应 JSON 记录的测试范围为准

![后续复测截图 · removed-global-live](16-removed-global-live.png)

## 17 · 后续复测截图 · removed-history-and-files

以对应 JSON 记录的测试范围为准

![后续复测截图 · removed-history-and-files](17-removed-history-and-files.png)

## 18 · 后续复测截图 · removed-live

以对应 JSON 记录的测试范围为准

![后续复测截图 · removed-live](18-removed-live.png)

## 19 · 工厂最终应用预览：真实生产构建中 KPI 和脚本初始化正常

真实模型产物 / 真实应用生产构建

![工厂最终应用预览：真实生产构建中 KPI 和脚本初始化正常](19-production-final-app-preview-desktop.png)

## 20 · 工厂最终应用预览：筛选改变真实 KPI

真实模型产物 / 真实应用生产构建

![工厂最终应用预览：筛选改变真实 KPI](20-production-final-app-preview-filtered.png)

## 21 · 工厂最终应用预览：360px 浏览器视口筛选与布局通过

真实应用 / 浏览器模拟手机视口

![工厂最终应用预览：360px 浏览器视口筛选与布局通过](21-production-final-app-preview-mobile-filtered.png)

## 22 · 前一版静态PNG：根代理发现页脚重叠、右栏越框和缺字，保留为修订前证据

真实模型产物 / 静态排版缺陷证据

![前一版静态PNG：根代理发现页脚重叠、右栏越框和缺字，保留为修订前证据](22-three_body_final.png)

## 23 · 三体最终原件：离线手机视口重置与布局（不代表应用canvas已通过）

真实模型原件 / 离线 Chromium 模拟手机视口

![三体最终原件：离线手机视口重置与布局（不代表应用canvas已通过）](23-final-06-offline-mobile-reset.png)

## 24 · 三体第4轮完成后的最终成果链接

真实 provider 同会话续作 / 应用截图

![三体第4轮完成后的最终成果链接](24-09-final-links.png)

## 25 · 最终真实应用：无需人工resize，首屏即显示三色轨迹与有效画布

真实模型原件 / 生产应用 / Chromium桌面

![最终真实应用：无需人工resize，首屏即显示三色轨迹与有效画布](25-production-final-05-app-html-desktop-first-view.png)

## 26 · 最终真实应用：390px新context中首屏轨迹与画布正常

真实模型原件 / 生产应用 / Chromium模拟手机视口

![最终真实应用：390px新context中首屏轨迹与画布正常](26-production-final-mobile-05-app-html-mobile-first-view.png)

## 27 · 最终三体原件离线手机视口：重置后状态正确

真实模型原件 / 离线Chromium模拟手机视口

![最终三体原件离线手机视口：重置后状态正确](27-production-final-06-offline-mobile-reset.png)

## 28 · 最终修订版真实应用：新context首屏完整轨迹、三颗星均可见

真实模型产物 / 生产应用 / 未手动resize

![最终修订版真实应用：新context首屏完整轨迹、三颗星均可见](28-three-body-final-overview-desktop.png)

## 29 · 最终修订版真实应用手机首屏：轨迹和初始画面完整可见

真实模型产物 / 生产应用 / 模拟手机视口

![最终修订版真实应用手机首屏：轨迹和初始画面完整可见](29-three-body-final-overview-mobile.png)

## 30 · 最终真实生产：任务仍运行时CSV已加载，前后API均running

真实任务进行中 / fresh Chromium / 无新模型请求

![最终真实生产：任务仍运行时CSV已加载，前后API均running](30-01-three_body.csv.png)

## 31 · 最终真实生产：任务仍运行时HTML预览加载，画布670×670

真实任务进行中 / 真实生产UI / 非fixture

![最终真实生产：任务仍运行时HTML预览加载，画布670×670](31-02-three_body_final.html.png)

## 32 · 最终print静态图：footer与横轴分离、右栏不越框、E0/L0完整

第5轮真实模型产物 / 独立像素边界与哈希检查通过

![最终print静态图：footer与横轴分离、右栏不越框、E0/L0完整](32-three_body_print.png)

## 33 · 最终真实应用：print PNG预览加载，尺寸2010×1320

真实生产UI / 原图预览与下载一致

![最终真实应用：print PNG预览加载，尺寸2010×1320](33-print-12-png-preview.png)

## 34 · 第5轮真实运行完成后的最终5个成果链接

真实provider与生产UI / 5个下载独立核对通过

![第5轮真实运行完成后的最终5个成果链接](34-print-10-production-final-links.png)
