# Changelog

本文档记录 PaperFlow 的正式版本变更与可复核验证基线；所有日期均以发布时区为准。

## [Unreleased]

（暂无未发布条目）

## [0.1.1] - 2026-11-25

围绕「本地优先、版面保真、双语精读、主流阅读器兼容备份」的重要功能升级版本（SQLite `user_version = 4`，支持从 `v0.1.0` `v1` 数据库无损平滑迁移）。

### 新增

- **原页底图覆写双语翻译与逐句双向联动**：新增主进程受控 `TranslationService`，支持 **OpenAI 兼容 API**（DeepSeek / OpenAI / 本机 Ollama 等）与 **本机 AI CLI**（Codex CLI / Claude CLI / Gemini CLI / 自定义 CLI），提供单页翻译、单段重译、后台逐页「连续译」及自定义专业术语表（Glossary）；译文持久化缓存于本地 SQLite，API Key 经 Electron `safeStorage` 加密存储；右侧原页 `ImageBitmap` 底图保留图表与公式，左右点击/拖选句段实时双向高亮。
- **三视图与三套护眼阅读主题**：重构为固定顶栏 + 底部悬浮控制胶囊（拖拽分栏线零抖动），支持一键切换 **「原文 / 双栏 / 译文」** 三种阅读视图、收起/展开文献库及双向滚动同步锁定/解锁；新增 **明亮 / 护眼暖纸（`mix-blend-mode: multiply` 给 PDF 与译文真实着色）/ 深色** 三套全局主题与定制滚动条。
- **文献库整理与跨库全文检索**：卡片升级为悬停图标栏（零高度抖动），新增星标收藏、自定义 `#标签` 筛选、实时阅读进度条，以及跨全库文献标题、标签、批注与已缓存译文的统一检索与点击跳转。
- **深度精读工具链（纯本地、无大模型亦可复用）**：
  - **划句批注与 AI 伴读**：黄/绿/蓝/粉四色 PDF 坐标高亮、随句笔记、右侧批注抽屉（筛选/编辑/跳转/导出 Markdown）及可选「AI 解释 / 解释公式」一键存为笔记；
  - **画幅优先图表与文献速览 + 一键复制**：自动识别选中句中的 `Fig. N` / `Table N` / `[N]` / `(Author, YYYY)`；图表速览以 1.8× 离屏渲染并结合逐行像素墨迹扫描与同栏正文段落硬边界截断去除白边与邻近正文，画幅优先展示；支持经主进程受控剪贴板一键复制高清 PNG 图片、题注与引用，支持点击正文/滚动自动收起及「固定」常驻对照；
  - **无书签 PDF 自动章节大纲**：对未内嵌书签的 PDF 自动扫描前 60 页并结合字号层级、重复页眉过滤与 `References` 后截断生成清晰章节树，点击目录项跳转并同步在原文/双栏/译文高亮定位对应标题；
  - **多出版商一键复制引用**：结合 PDF 内嵌元数据、首页字号层级与出版商版面结构提取标题、作者、年份、期刊/会议与 DOI，支持手工微调与一键复制 **BibTeX / IEEE / GB/T 7714 / RIS**；
  - **快捷键与 `?` 速查面板**：支持 `?`、`T`、`V`、`B`、`O`、`A`、`C`、`H`、`Ctrl+F`、`←/→`、`Esc` 等阅读快捷操作。
- **适配主流阅读器的便携 `.zip` 一键备份与恢复**：内置零外部依赖 PKZIP 工具（UTF-8 文件名、CRC32、Zip-Slip 路径防护与大小上限），单文件导出 `pdfs/*.pdf`、`library.bib`（Zotero / JabRef / Mendeley）、`library.ris`（EndNote / Zotero / Mendeley）、`notes/*.md`（Obsidian / Notion）与 `paperflow-backup.json` 无损恢复清单（刻意排除加密 API Key，支持跨空库还原与幂等重导）。
- **Linux `.deb` 打包脚本与测试清理加固**：新增 [dist-linux-deb.ts](scripts/dist-linux-deb.ts) 与 `pnpm dist:linux:deb`，精简 E2E 回归集并新增 `tests/e2e/global-teardown.ts` 自动清理 `%TEMP%\paperflow-*` 临时目录。

### 修复

- 修复深色模式下四色高亮圆点被全局按钮样式覆盖变灰以及深色/护眼模式滚动条颜色未适配的问题。
- 修复速览题注、复制文本与目录标题匹配误用翻译阶段 `⟪M1⟫` 公式占位符的问题。
- 修复点击目录跳转到页首标题时因居中滚动导致页码回退上一页的问题。
- 修复 Springer 栏目标签/中圆点作者/卷期年份与 `The VLDB Journal` 误判为会议、ACM 双行含逗号标题截断与多栏作者漏提、IEEE 双逗号等引用提取与格式化缺陷。

### 已知边界

- Windows 安装包未进行商业代码签名（`NotSigned`），下载安装前请对照校验清单验证 SHA-256。
- 本轮实测在 Windows x64 宿主机完成（`pnpm typecheck`、`pnpm lint --max-warnings=0`、16 文件 / 136 项 Vitest 单元测试、11 项开发态 Electron E2E、打包 `PaperFlow.exe` 3 项核心 E2E 及 Windows `Expand-Archive` 备份解压验证）；Linux `.tar.gz` 为 Windows 跨平台构建，Linux 实机与 `.deb` 原生安装回归留待 Ubuntu 环境补充。
- E2E 中系统文件选择框由 `dialog.showOpenDialog` / `showSaveDialog` mock，双语翻译测试由本机 `127.0.0.1` 模拟服务端与本地 CLI 桩完成；便携备份刻意不包含加密 API 密钥。

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
