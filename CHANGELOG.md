# Changelog

本文档记录 PaperFlow 的正式版本变更与可复核验证基线；所有日期均以发布时区为准。

## [Unreleased]

- 新增 [dist-linux-deb.ts](scripts/dist-linux-deb.ts) 与 `pnpm dist:linux:deb`（继续保留 `--publish never`），用于在 Ubuntu / Debian 环境中稳定复现基于同源 Linux 载荷的 `.deb` 原生安装包，并附带 [dist-linux-deb.test.ts](tests/unit/dist-linux-deb.test.ts) 单元测试。
- 刷新仓库主界面预览图 [paperflow-reader.png](docs/paperflow-reader.png) 并补充版本更新日志与桌面端安装说明。

## [0.1.0] - 2026-11-24

面向科研论文的纯本地离线桌面 PDF 阅读器首个公开基线版本（Electron 44 + React 19 + PDF.js 6.4 + SQLite / `AGPL-3.0-only`）。

### 新增

- **安全桌面容器与本地文献库**：强制开启 Electron `sandbox: true`、`contextIsolation: true`、`webSecurity: true` 并拦截外部导航与弹窗，通过 `app://bundle` 白名单协议加载本地资源；支持文件选择框与工作区拖拽批量导入 `.pdf`（100 MiB 上限、主进程 SHA-256 去重、隐藏沙盒逐页解析校验）、搜索、内联重命名、确认删除与 `reader_state` 级联清理，并在启动阶段回收孤立临时副本。
- **纯本地科研阅读体验**：基于 PDF.js Canvas 与官方 `TextLayer` 渲染，提供 PDF 目录书签抽屉（忽略纯外链）、`Ctrl+F` 可取消惰性全文搜索与命中定位高亮、`Ctrl+滚轮` 与快捷键缩放/翻页、`裁剪白边` 联动适合宽度模式，以及 600 页长文档离屏 Canvas 懒渲染与释放。
- **跨平台选区与桌面适配**：实现公式/上下行 SVG 连续选区高亮、`0°/90°/180°/270°` 旋转页与 `CropBox`/`UserUnit` 双向坐标映射、Windows 高对比度 `forced-colors: active` 无内描边平滑渲染；提供全平台基于桌面工作区的自适应窗口缩放、窄屏单行工具栏 / 紧凑三栏布局，以及 Linux X11 自动包装启动器与 `.deb` 安装封装。

### 修复

- 解决 Linux 桌面在高缩放 / FreeType RGB LCD 次像素渲染及窄视口下引发的 10 项原生 E2E 问题（包含相对亮度墨迹采样阈值适配、动态 `app.getAppPath()` Preload 解析、`path.sep` 路径兼容及紧凑布局）。
- 移除主窗口 `workAreaSize` 缩窗仅限 Linux 的条件判断，修复 Windows `1024×768` 等窄屏或高 DPI 环境下标题栏徽标与关闭按钮右溢裁切问题。

### 产物与验证摘要

- **发布产物（均对应一致的 `app.asar`，SHA-256 `e84ea6e5f0cc6363c752a51f0390dd7a9fd199faca9b3518b6392b2409c494a6`）**：
  - `PaperFlow-0.1.0-win-x64-setup.exe`（Windows x64 NSIS，未签名 `NotSigned`）
  - `PaperFlow-0.1.0-linux-x64.tar.gz`（Linux x64 便携包）
  - `PaperFlow-0.1.0-linux-x64.deb`（Ubuntu / Debian x64 原生安装包，自动设 `chrome-sandbox` 为 `root:root 4755`）
  - `fonts-liberation_1.07.4.orig.tar.gz`（GPL v2 + 字体例外对应源码包）与 `SHA256SUMS.txt`
- **三端验证**：Windows 宿主机（`89/89` 单测 + `69/69` 打包 E2E）、Ubuntu 26.04.1 LTS 虚拟机（`88 passed | 1 skipped` 单测 + `69/69` 打包 E2E + `.deb` 安装实测）与纯净 Windows 11 Build 26300 虚拟机（零预装 VC++/Node，`1024×768` 无裁切首启 + `1920×1080` `69/69` E2E + NSIS 与图形化安装实测）全量通过，详情见 [artifacts.json](docs/artifacts.json) 与 [summary.md](docs/verification/summary.md)。

### 已知边界

- Windows 安装包尚未使用商业代码签名证书签名（`NotSigned`）。
- 自动化 E2E 样本与多倍 DPI / `forced-colors` 校验基于项目合成 PDF 与进程模拟参数；单物理显示器环境尚未覆盖跨屏硬件 DPI 拖动迁移，亦未实测外部超大论文的极限内存上界。
- 最终两处微调后未重跑 `pnpm dev` 热更新与 `pnpm rebuild:electron`。
