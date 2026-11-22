# PaperFlow 基础界面预览

2026-11-22，冻结源码为 `PF-UI-20261122-03`。基础界面已有可运行的 Windows 预览。完整选区回归仍有失败，整包尚未验收。

- 中央首屏可选 PDF，左栏可搜索文件名并查看页数、大小、导入日期和当前文献。导入、重复、读取中和读取失败有对应反馈。搜索不会切走正在阅读的文献，取消导入会保留搜索词。
- 导入后显示真实 PDF.js Canvas 和 TextLayer。工具栏保留翻页、跳页、缩放、适合宽度和打开新 PDF，左栏与工具栏共享导入忙状态。右侧保留“尚未翻译”。
- Windows 解包预览入口（本机忽略路径）为 `release/selection-fix/ui-20261122-03/win-unpacked/PaperFlow.exe`。完整程序需保留同目录的 DLL、语言资源和 `resources/`。同批 NSIS 安装包（`release/selection-fix/ui-20261122-03/PaperFlow-0.1.0-win-x64-setup.exe`）已生成，未执行安装和卸载，程序和安装包均未签名。
- 归档的实测图片（本机忽略路径）为首屏 `.cache/qa/20261028-selection-regression-01/r9-13-packaged-ui-preview-2/ui-screenshots/paperflow-empty-workspace.png` 和导入后阅读界面 `.cache/qa/20261028-selection-regression-01/r9-13-packaged-ui-preview-2/ui-screenshots/paperflow-reading-workspace.png`。PDF 是原创合成测试素材。自动化只注入系统文件框返回值，其后的导入、SQLite、Canvas 和 TextLayer 实际运行。

## 验证结果

| 范围 | 实际结果 |
| --- | --- |
| 类型、lint、单测、生产构建 | 当前版本均退出 0，单测 59/59。此前类型检查曾因测试脚本使用未声明的 `Promise.withResolvers` 退出 2，已改为普通 Promise。 |
| 源码生产构建的桌面测试 | 基础 UI 2/2、选区 26/26。既有 20 项首次为 10 过、1 败、9 未执行；模拟 DPR 3 的 60% 缩放用例只选出 `Geom`，原因未确定。原用例无观察器复测 3/3，随后完整既有 20/20。 |
| 新 Windows 解包程序完整回归 | 22 过、1 败、25 未执行。200%/DPR2 的横跨分子与分母拖选应得到 `a+b c+d`，实际选区与剪贴板只有 `a`。随后 12 项稳定性验证未执行。 |
| 同一 Windows 解包程序的独立 UI 预览 | 基础 UI 2/2，覆盖首屏导入、共享忙状态、取消保留搜索词、去重反馈、搜索时继续阅读及真实 PDF 页面。完整包回归的失败结果仍保留。 |

原始命令、日志、截图及附件在本机 `.cache/qa/20261028-selection-regression-01/` 的 `r9-*` 目录。分式失败见 `r9-12-new-package-48`，独立 UI 预览见 `r9-13-packaged-ui-preview-2`。模拟 DPR 结果不覆盖物理显示器间切换。读取文献库失败后的重试入口已经实现，尚未做专门故障注入验证。
