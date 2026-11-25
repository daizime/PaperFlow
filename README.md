# PaperFlow

**`v0.1.0` + 双语翻译预览 · `AGPL-3.0-only` · `Windows x64 / Linux x64` · 安全隔离桌面端**

面向科研论文的本地桌面双语 PDF 阅读器（Electron 44 + React 19 + PDF.js 6.4 + SQLite）。文献库、排版解析、白边裁剪与译文缓存均运行在本地；2026-11-24 已获授权接入主进程受控代理双语翻译，支持 **OpenAI 兼容 API**（DeepSeek / OpenAI / 本机 Ollama）与 **本机 AI CLI**（Codex CLI / Claude CLI / Gemini CLI / 自定义 CLI），并采用 PDF 原页底图 + 原位译文覆写保持图表、公式与 1:1 双栏对齐；渲染层仍保持无外网直连权限，不引入 OCR 或 Python 翻译运行时依赖。

![PaperFlow 主界面预览（原创合成样本 PDF）](docs/paperflow-reader.png)

## 下载与安装（v0.1.0）

可在仓库 GitHub Releases 获取 `v0.1.0` 正式附件与 `SHA256SUMS.txt` 校验清单，也可按下方源码命令在本机构建（所有构建脚本严格保留 `--publish never`）：

| 平台与形态 | 发行文件 / 本地产物 | 安装与运行说明 |
| --- | --- | --- |
| **Windows x64 安装向导** | `PaperFlow-0.1.0-win-x64-setup.exe` | 图形化 NSIS 安装向导（支持自选目录、桌面与开始菜单快捷方式及控制面板卸载）；未商业签名（Authenticode `NotSigned`），SmartScreen 提示时请先对照 `SHA256SUMS.txt` 校验后再放行 |
| **Windows x64 解包版** | `release/win-unpacked/PaperFlow.exe` | `pnpm pack:win` 本地生成，双击运行，需保留同目录 DLL、语言资源与 `resources/` |
| **Ubuntu / Debian `.deb`（推荐）** | `PaperFlow-0.1.0-linux-x64.deb` | 终端执行 `sudo apt install ./PaperFlow-0.1.0-linux-x64.deb`（或用系统应用安装器打开）；安装脚本会自动将 `/opt/PaperFlow/chrome-sandbox` 设为 `root:root 4755` 并注册应用菜单与 PDF 关联；卸载：`sudo apt remove paperflow` |
| **Linux x64 便携归档** | `PaperFlow-0.1.0-linux-x64.tar.gz` | 支持在 Windows 跨平台执行 `pnpm dist:linux` 生成；若系统限制非特权 user namespace（如 Ubuntu 24.04/26.04），解压后先对 `chrome-sandbox` 执行 `sudo chown root:root` 与 `sudo chmod 4755`，再运行 `./PaperFlow-0.1.0-linux-x64/paperflow` |
| **对应上游字体源码包** | `fonts-liberation_1.07.4.orig.tar.gz` | 随包 PDF.js 标准字体 Liberation Sans `1.07.4`（GPL v2 + 字体例外）对应源码归档 |

## 核心特性与版本演进概览

当前工作区已实现 T01–T03 基础、纯本地科研阅读器增强，以及 T04–T06 双栏对齐双语翻译能力：
- **本地文献库管理与工作区交互**：按钮或拖拽 `.pdf` 批量导入（100 MiB 上限，有界 `Uint8Array` 传输并共享主进程 SHA-256 去重与隐藏沙盒校验，前端不接触真实本地路径）、标题/原文件名搜索、内联重命名、确认删除（联动清理 `reader_state`、`translation_cache` 与副本）；顶部支持一键「收起文献库 / 展开文献库」。
- **1:1 对称双栏阅读与科研阅读体验**：打开文献后默认进入左原文 / 右译文 **1:1 等宽对半对照**视图（支持拖拽中线调整 `25%–75%` 比例、双击恢复 1:1，以及工具栏「双栏对照 / 单栏精读」一键切换）；保留目录书签抽屉（忽略纯外链）、`Ctrl+F` 取消式惰性全文搜索、`Ctrl+滚轮` 缩放与键盘快捷键、`裁剪白边` 联动适合宽度阅读、跨页与公式/旋转页 SVG 连选高亮、`forced-colors` 适配，以及基于 `scroll-sync.ts` / `useDualScrollSync.ts` 的默认锁定、可手动解锁双向同步滑动控制。
- **原页底图覆写翻译与逐句双向联动（T04–T06）**：参考 `pdf2zh` 原位覆写与 `NeoRead` 双栏句级联动思路，右侧通过原页 `ImageBitmap` 底图完整保留原 PDF 矢量图表、表格与公式块（跳过 `formula` 块），在待译段落坐标框内按边缘采样的原块底色与安全列宽自适配渲染中文译文（防止溢出与跨栏尾片透出英文）；无论点击或拖选左侧原文句子还是右侧译文句段，对侧对应句子均实时同步高亮。翻译通过主进程 `TranslationService` 受控执行 **OpenAI 兼容 API**（DeepSeek / OpenAI / 本机 Ollama）或 **本机 AI CLI**（Codex CLI / Claude CLI / Gemini CLI / 自定义 CLI），API Key 经 `safeStorage` 加密保存于本地 SQLite，译文按 `(document_id, page_number, block_id, target_language)` 持久化缓存，重复打开无需重复请求。

说明：`v0.1.0` 发布包曾完成 **Windows 宿主机（`89/89` 单测 + `69/69` 打包 `.exe` E2E）**、**Ubuntu 26.04.1 LTS 虚拟机（`88 passed | 1 skipped` 单测 + `69/69` 打包 `./paperflow` E2E + `.deb` 安装实测）**与 **纯净 Windows 11 Build 26300 虚拟机（零预装 VC++/Node，`1024×768` 无裁切首启 + `1920×1080` `69/69` E2E + NSIS 安装实测）**全量验证；本次新增双语翻译与 1:1 双栏能力后的本地实测结论见本轮交付说明，跨平台安装包与云端真密钥联网回归将按需补充。历史发布详情见 [更新日志](CHANGELOG.md)、[产物清单](docs/artifacts.json)、[补充验收记录](docs/verification/summary.md) 与 [实施记录](docs/implementation-notes.md)。

## 从源码构建与启动

要求 Node.js 24+ 与 pnpm 11.25.0；版本由 `package.json` / `pnpm-lock.yaml` 固定。

```powershell
pnpm install --frozen-lockfile
pnpm fixtures
pnpm dev
```

通过左侧「导入 PDF」或直接将 `.pdf` 文件拖入工作区导入本地文献（单文件上限 100 MiB；源文件保持原样）。图像扫描页会提示暂不支持 OCR。未选择文献时右侧显示「尚未翻译」占位；打开文献后点击右栏顶部的「设置」可配置 OpenAI 兼容 API（如 DeepSeek、本机 Ollama）或本机已安装的 AI CLI（如 `codex`），点击「翻译本页」即可在原位底图上对照阅读中文译文。

## 命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | Electron + Vite 开发窗口，React HMR |
| `pnpm typecheck` | 主进程、Preload、Renderer、脚本与测试严格类型检查 |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest 业务与构建脚本单元测试 |
| `pnpm test:e2e` | Playwright 实际 Electron 测试，需先 build |
| `pnpm build` | 生产构建到 `out/`，不依赖开发服务器 |
| `pnpm dist:win` | Windows x64 NSIS 本地安装包（`--publish never`） |
| `pnpm pack:win` | Windows 解包程序到 `release/win-unpacked/`（`--publish never`） |
| `pnpm dist:linux` | Linux x64 便携 `.tar.gz`（支持 Windows 跨平台构建并校验 Electron SHA-256 与 POSIX 权限） |
| `pnpm dist:linux:deb` | 先构建 `.tar.gz`，再于 Ubuntu/Debian 上使用 `dpkg-deb` 封装 `release/PaperFlow-<version>-linux-x64.deb` |
| `pnpm fixtures` | 重新生成可再分发的原创测试 PDF |
| `pnpm rebuild:electron` | 在真实 Electron 中验证 SQLite Node-API 兼容性，需先 build |

安装时会下载 Electron 二进制。若直连 GitHub 超时，可自行配置可信的 Electron 镜像，并与 `electron` npm 包中 `checksums.json` 的 SHA-256 校验一致，请勿禁用下载校验。`better-sqlite3` 13 附带 Node-API 10 预编译文件，本项目不调用传统 `electron-rebuild` 编译，避免额外 Python/C++ 工具链依赖；升级后须重新运行原生与打包测试。

## 本地数据

默认位于 Electron `app.getPath('userData')`（Windows 通常为 `%APPDATA%/PaperFlow`，Linux 通常为 `~/.config/PaperFlow`）：
- `paperflow.sqlite`：WAL 模式、外键开启、绑定参数、`user_version=2`（支持 `v1→v2` 非破坏平滑升级），包含 `documents`、`reader_state`、`translation_cache` 与 `app_settings` 四张业务表。
- `library/<UUID>.pdf`：入库副本。前端不接触绝对路径。
- `app_settings`：保存翻译引擎配置与经系统安全模块 `safeStorage` 加密后的 API 密钥；Chromium `localStorage` 保存最近选择的文献 ID。不向任何未配置的外部服务遥测或上传文献数据。

启动可使用 `--user-data-dir=<绝对目录>` 覆盖数据位置。自动化测试使用独立临时目录，不混入真实文献库。页码与缩放倍率防抖写入，并在窗口关闭时刷新；异常断电或强制终止进程不保证最后一次状态落盘。

## 安全与测试边界

强制启用 `sandbox` / `contextIsolation` / `webSecurity`，禁用 Node integration、页面导航、弹窗和权限请求。Preload 仅暴露十六个 `window.paperflow` 业务方法；IPC 核验窗口、主 frame、精确 URL 与 Zod 参数（含 `http:`/`https:` 与 CLI 元字符拦截）。生产资源由白名单 `app://bundle` 协议提供服务。PDF 解析和阅读使用本地 Worker，不加载 CDN，渲染层保持零外网直连权限，不执行 PDF 链接、外部目录 URL、表单脚本或注释动作；OpenAI 兼容接口请求与本机 AI CLI 子进程调用均限定在主进程 `TranslationService` 内受控执行。

测试素材说明见 [tests/fixtures/README.md](tests/fixtures/README.md)。新增的加密、600 页、旋转与 DPI、阅读器 UX、选区边界以及含矢量柱状图/表格的学术双栏素材均为原创合成测试数据（生成器见 `scripts/verification/`）。Playwright 导入测试替换系统文件框返回值，拖拽导入测试在渲染层构造 `File`/`DataTransfer`，其后的字节校验、解析、文件复制、数据库与阅读渲染均真实运行；OpenAI 兼容 API 与 CLI 端到端测试在本机使用受控 `127.0.0.1` 模拟服务端与本地 Node CLI 桩验证完整 IPC、加密存密、原位覆写与 SQLite 缓存恢复路径。实际执行结果、失败修复与尚未验证边界见 [实施记录](docs/implementation-notes.md)、[补充验收记录](docs/verification/summary.md) 与 [交付报告](docs/delivery-report.md)。长期模块协作入口见 [项目管理](项目管理/README.md)。

## 目录导航

| 文件或目录 | 内容 |
| --- | --- |
| [src/](src/) | Electron 主进程 `main/`（含 `translation-service.ts`）、预加载 `preload/`、React 界面 `renderer/` 和跨进程类型 `shared/` |
| [tests/](tests/) · [scripts/](scripts/) | 单元测试、桌面端到端测试、合成 PDF 素材、预览截取与多平台打包脚本 |
| [build/](build/) · [resources/](resources/) | 打包图标、第三方许可原文和版权声明 |
| [docs/](docs/) · [docs/verification/](docs/verification/) | 架构、实施记录、交付说明、产物清单、验证报告与界面预览截图 |
| [CHANGELOG.md](CHANGELOG.md) | 版本更新日志、发布产物与实测边界记录 |
| `release/` | 本地打包与解包输出目录（被 Git 忽略） |
| [项目管理/](项目管理/) · `项目管理/状态/` | 多会话分工约定（`状态/` 保存本机会话登记、冻结基线与交接，被 Git 忽略） |
| `node_modules/` · `out/` | 依赖与本地构建输出 |
| `.cache/` · `test-results/` | 本机验证日志与 Playwright 临时输出 |

## 开发结构与后续接口

见 [架构说明](docs/architecture.md)。主流程已打通 `PdfPageData`（原始文字、TextLayer、Canvas、viewport）、`PdfViewerProps.onPageData` / `onPageBackdrop` / `onSourceSentenceInteract`、`layout-analysis.ts` 多栏阅读序重构与底色采样、`TranslationPanel`（PDF2ZH 原页底图覆写 + `sentence-alignment.ts` 句级双向联动 + `useDualScrollSync` 同步锁定）及主进程 `TranslationService`；`margin-crop.ts` 负责阅读白边裁剪联动，扫描页 OCR、Python 翻译运行时与自动远程发布仍保持禁用。

## 许可证

自有代码采用 [AGPL-3.0-only](LICENSE)。上游版权及许可见 [第三方清单](docs/third-party-licenses.md)、`resources/THIRD-PARTY-NOTICES.txt` 和 `resources/licenses/`。PDF.js 附带字体、ICC、WASM 遵循各自独立许可条款。

`v0.1.0` Release 已随 Liberation Sans 1.07.4 对应源码包发布于 GitHub Releases；本地构建脚本始终保留 `--publish never` 不自动发布，且 Windows 产物保持 `NotSigned` 未商业代码签名。
