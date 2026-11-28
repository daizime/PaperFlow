# Changelog

本文档记录 **Foliopair**（原名 **PaperFlow**）的正式版本变更与可复核验证基线；所有日期均以发布时区为准。

## [Unreleased]

（暂无未发布条目）

## [0.2.1] - 2026-11-28

围绕「**Foliopair 品牌重塑与界面精修、单/双栏版面保真分段翻译与右边界对齐、跨页语义上下文连贯及安全加固**」的稳定升级版本（底层沿用 `PaperFlow` 数据目录、`user_version = 7` SQLite 数据库与 `window.paperflow` 契约，支持 `v0.2.0` / `v0.1.x` 老用户无缝升级）。

### 新增与重塑

- **Foliopair 品牌重塑、三套语义主题与融合式标题栏**：
  - 应用展示名、窗口标题、桌面快捷方式、`.desktop` 条目、科研向导及 `.pptx` 预览品牌标识全面升级为 **Foliopair**，同步重绘双页几何品牌图标与三套「纸墨档案 / 暖棉纸 / 石墨暗桌」语义设计令牌（[tokens.css](src/renderer/src/assets/tokens.css)）；
  - 新增 Preload 受控 API `setWindowTheme`（共 **67** 个冻结 API），支持将主题色同步到 Windows / Linux 原生无框标题栏叠加层，顶部操作栏重构为「左导航 + 中阅读工具 + 右紧凑引擎胶囊弹层」。
- **跨批/跨页翻译语义上下文连贯与快捷键自定义**：
  - 新增 [translation-context.ts](src/renderer/src/features/translation/translation-context.ts) 与 `doc.summary.v1:*` 文档摘要持久化，翻译请求可按批/跨页注入当前文档滚动摘要、章节标题与前序至多 6 块已译语义上下文；
  - 新增快捷键管理模块与设置弹窗自定义快捷键绑定支持，并支持主动切换「双栏」时对未译非中文文献预译前两页（普通打开与恢复视图仍保持本地零外发）。

### 优化与修复

- **单/双栏版面识别、右边界对齐与零上下遮挡**：
  - 强化 [layout-analysis.ts](src/renderer/src/features/reader/layout-analysis.ts) 与 [sentence-alignment.ts](src/renderer/src/features/translation/sentence-alignment.ts) 的栏位切分、跨栏标题识别及视觉保留区跳过，译文段落按栏宽与右边界吸附排版并纵向无遮挡重排，同步修复 Markdown / PDF 导出（[translation-export.ts](src/main/services/translation-export.ts)）在单栏与跨栏区域的对齐表现。
- **文献库窄侧栏控件防重叠、安全凭据隔离与备份加固**：
  - 修复文献库树形条目在同时展示「当前」与阅读状态标签时的右溢出/遮挡问题（`LibraryPanel` / `library.css`）；
  - 加固 OpenAI 兼容 API Key 按完整 Base URL 绑定存储、首次或变更本机 AI CLI 命令行参数前的系统授权弹窗确认、以及 ZIP 备份/恢复体积（512 MiB / 5,000 条目 / 1 GiB 解包）硬上限保护，并在删除/重置文献库时联动清理 `doc.summary.v1:*` 缓存键。

### 打包与验证摘要

- **发布产物（安装包更名为 `Foliopair-0.2.1-*`，两端 `app.asar` SHA-256 逐字节一致：`3ce191831fe30289cffddabe54442c8b9bb057748f1eb523c50a342023a4cbdf`）**：
  - `Foliopair-0.2.1-win-x64-setup.exe`（`123,345,270` B，Windows x64 NSIS，未签名 `NotSigned`）
  - `Foliopair-0.2.1-linux-x64.tar.gz`（`142,059,762` B，Linux x64 便携包）
  - `Foliopair-0.2.1-linux-x64.deb`（`102,271,920` B，在远程 Ubuntu x86_64 基于同源 `.tar.gz` 经 `dpkg-deb` 封装，Debian 包名保留 `paperflow` 以便升级替代 `[0.1.0]`/`[0.2.0]`）
- **实测记录与边界**：
  - Windows x64：`tsc --noEmit`（node/web/test 0 错误）、`eslint . --max-warnings=0`（0 警告）、Vitest **33 文件 / 256 项单元测试全部通过**、Playwright 开发态端到端 **14 文件 / 23 项全部通过**（`layout-sync.spec.ts:35:5` 首轮批跑曾出现 1 次同步滚动解锁断言超时，单独复测 `3/3` 与完整重跑全量 `23/23` 均通过）、打包 `PaperFlow.exe` 核心冒烟端到端 **7 文件 / 14 项全部通过**。
  - Ubuntu x86_64：`Foliopair-0.2.1-linux-x64.deb` 完成 `dpkg-deb --info` / `--contents` 与 `apt-get -s install` 模拟升级依赖解析校验；`.exe`/`.deb`/`.tar.gz` 安装包在目标纯净桌面系统上的交互式实机安装启动仍待补充。

## [0.2.0] - 2026-11-27

围绕「多级学科分类、多篇并排对照、AI 学术伴读与检索、后台跨文献工作流及计费透明化」的重大功能与工程升级版本（SQLite `user_version = 7`，支持从 `v1`–`v6` 数据库无损平滑迁移）。

### 新增

- **多级学科分类、专属词库隔离与批量整理（Zotero 风格）**：
  - 文献库升级为支持最多 4 级嵌套的树状分类文件夹，每个分类支持独立学科语境、专属术语表（可选是否继承全局术语表，彻底隔离跨学科术语冲突）与一键追加学科模板词条；
  - 支持递归导入本地文件夹自动映射分类与多选/跨分类批量移动、加 `#标签`、调整阅读状态（`未读 / 在读 / 已读`）及按分类/全库一键导出整套 PDF 与批注 Markdown。
- **研究生科研向导（首次引导与随时切换）**：首次启动提供直选全学科预设与多步向导两种模式，按学历阶段、学部学科与研究范式自动配置推荐标签与初始术语表；顶栏保留 `科研向导` 快捷入口随时切换调整。
- **多篇并排对比分栏与自由拖放工作区**：支持同时打开多篇 PDF 分栏精读与同屏拖拽分栏权重；支持从标签页或分栏标题拖放至左/中/右边缘互换、拆分或合并分栏，每栏支持独立切换「原文 / 双栏 / 译文」、独立页码与临时聚焦放大（`退出多开` 恢复单篇阅读）。
- **AI 论文对话、页码跳转、学术技能与 `.pptx` 导出**：
  - 全新混合式 **AI 对话助手**（可在悬浮窗与右侧抽屉间切换，支持边缘拖曳调整大小、多栏焦点/全部打开文献/自由对话三种上下文范围、流式输出、`停止生成`、`重新生成`、`[P.N]` 页码角标点击跳转、`一键存为批注笔记` 与 SQLite 持久化记录 `chat_messages`）；
  - 内置 4 项学术技能（`研究焦点与方法 FOCUS`、`组会汇报大纲`、`相关工作梳理`、`对比多篇文献`）与**自定义 AI 技能**管理，并支持预览及一键导出原生 `.pptx` 幻灯片。
- **AI 按需学术检索与 OpenAlex / DOI 引用补全**：在文献库与 AI 对话内按需检索 **arXiv / Semantic Scholar / OpenAlex**（主进程受控 HTTPS 访问，拦截私有/回环/非 HTTPS 跳转），支持摘要 AI 速览与一键下载入库（含 PDF Magic Header 与 SHA-256 校验）；引用弹窗接入 OpenAlex / DOI 自动补全元数据，并支持分类/全库一键导出规范 `.bib`。
- **后台跨文献连续翻译、范围跳过、手工改译与导出体系**：
  - **后台连续翻译**：支持自定义页码范围（如 `1-5, 8`）与自动识别并跳过 `References` 参考文献页，翻译期间可自由切换阅读其他 PDF，标签页显示 `译中` 徽标并在完成后弹窗提醒；支持在设置开启「翻页自动静默预译下一页」（默认关闭）；
  - **手工微调与多格式导出**：已译译文块支持直接原位手工编辑微调并写回 SQLite 缓存；支持一键导出 **中英对照 / 纯中文 Markdown（`.md`）与排版 PDF（`.pdf`）**。
- **接口真实余额查询、本地 Token 用量统计与深色模式颜色统一**：
  - 顶栏引擎状态胶囊实时区分展示 **DeepSeek 真实余额（含低余额预警）**、OpenAI 兼容今日累计用量、Ollama 本机离线零费用及 CLI 订阅配额；在设置弹窗提供「刷新余额 / 清零统计 / 参考单价估算 / 本地缓存省流命中率」且严格仅展示服务端实测字段，绝不伪造账单；
  - 深色模式下基于滤镜映射算法统一底图反色与覆写译文块底色（消除白块刺眼）、暗化句级高亮与适配行内公式混色。

### 优化与修复

- **界面精简与多开退出修复**：重构顶部操作栏（收敛主题切换为图标下拉菜单、侧栏展开时隐藏重复 `+ PDF`、降噪已译页面的 `重译本页`、居中对齐双栏底部悬浮控制胶囊、优化双栏分隔握柄与阴影层级）；修复退出多篇对比后停留在纯译文模式偶发一直显示「正在分析第 1 页版面结构…」的问题；修复切换到 OpenAI 兼容页签时用量卡片残留 CLI 配额提示的缺陷。
- **代码结构去冗余与仓库清理**：抽取跨进程共享 `src/shared/usage-billing.ts` 与 `src/shared/glossary-text.ts`，提炼 `pane-translation-helpers.ts` 消除主进程/副分栏 Hook 重复逻辑，拆分 `WorkspaceHeader`、`WorkspaceTabsBar`、`UsageToastLayer` 等工作区组件以精简 `App.tsx`，并移除 `.theme-switcher` 失效 CSS 及过时临时脚本与草稿文档。

### 已知边界

- Windows 安装包与主程序未进行商业代码签名（`NotSigned`），运行前请对照 `SHA256SUMS-v0.2.0.txt` 校验哈希。
- 本轮全量验证在 Windows x64 宿主机完成：`pnpm typecheck` 0 错误、`pnpm lint --max-warnings=0` 0 警告、Vitest **26 文件 / 199 项单元测试全部通过**、Playwright 开发态端到端 **14 文件 / 21 项用例全部通过**，打包成品 `PaperFlow.exe` 核心冒烟端到端 **7 文件 / 10 项全部通过**。
- `PaperFlow-0.2.0-linux-x64.tar.gz` 由 `scripts/dist-linux.ts` 在 Windows 跨平台构建并校验 Electron 下载 SHA-256 与 POSIX 权限；因当前宿主机无 WSL / `dpkg-deb`，本版本未在宿主机生成 `.deb` 原生包，Linux 实机安装运行与 `.deb` 回归留待 Ubuntu 环境补充。
- E2E 中的原生文件框由 `dialog.showOpenDialog` / `showSaveDialog` mock；翻译、余额查询、学术检索、OpenAlex 引用补全与 CLI 调用分别通过本机 `127.0.0.1` HTTP 模拟服务端及本地 Node CLI 桩完成验证；真实公网第三方 API 波动未纳入离线自动化门禁，便携 `.zip` 备份仍刻意排除加密 API 密钥。

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
