# PaperFlow

**`v0.1.0` · `AGPL-3.0-only` · `Windows x64 / Linux x64` · 纯本地离线运行**

面向科研论文的本地离线桌面 PDF 阅读器（Electron 44 + React 19 + PDF.js 6.4 + SQLite）。严格本地运行，不接入翻译模型、LLM、OCR、在线文献检索、账号系统或任何云端同步。

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

## 核心特性与三端验证概览

当前实现完整 T01–T03 基础及纯本地科研阅读器增强能力：
- **本地文献库管理**：按钮或拖拽 `.pdf` 批量导入（100 MiB 上限，有界 `Uint8Array` 传输并共享主进程 SHA-256 去重与隐藏沙盒校验，前端不接触真实本地路径）、标题/原文件名搜索、内联重命名、确认删除（联动清理 `reader_state` 与副本）、逐文件详细中文失败列表与启动孤立副本自动回收。
- **科研阅读体验**：PDF 内部目录书签抽屉（忽略纯外链）、`Ctrl+F` 取消式惰性全文搜索与命中定位高亮、`Ctrl+滚轮` 缩放与键盘翻页/缩放快捷键、`裁剪白边` 联动适合宽度阅读（保留精准文字选区坐标系）及 600 页长文档 Canvas 懒渲染与释放。
- **选区连贯与跨平台适配**：跨页与公式/上下行 SVG 连续高亮、`0°/90°/180°/270°` 旋转页支持、Windows `forced-colors: active` 高对比度无内描边适配，以及全平台基于桌面工作区的自适应窗口缩放与窄屏响应布局。

`v0.1.0` 已完成 **Windows 宿主机（`89/89` 单测 + `69/69` 打包 `.exe` E2E）**、**Ubuntu 26.04.1 LTS 虚拟机（`88 passed | 1 skipped` 单测 + `69/69` 打包 `./paperflow` E2E + `.deb` 安装实测）**与 **纯净 Windows 11 Build 26300 虚拟机（零预装 VC++/Node，`1024×768` 无裁切首启 + `1920×1080` `69/69` E2E + NSIS 与图形化安装实测）**全量验证；`out/` `209/209` 与 `41/41` 许可证核验一致。详情见 [更新日志](CHANGELOG.md)、[产物清单](docs/artifacts.json)、[补充验收记录](docs/verification/summary.md) 与 [实施记录](docs/implementation-notes.md)。

## 从源码构建与启动

要求 Node.js 24+ 与 pnpm 11.25.0；版本由 `package.json` / `pnpm-lock.yaml` 固定。

```powershell
pnpm install --frozen-lockfile
pnpm fixtures
pnpm dev
```

通过左侧「导入 PDF」或直接将 `.pdf` 文件拖入工作区导入本地文献（单文件上限 100 MiB；源文件保持原样）。图像扫描页会提示暂不支持 OCR。右侧译文区当前保留显示「尚未翻译」。

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
- `paperflow.sqlite`：`documents` 与 `reader_state` 两张业务表，WAL 模式、绑定参数、`user_version=1`。
- `library/<UUID>.pdf`：入库副本。前端不接触绝对路径。
- Chromium 配置数据保存最近选择的文献 ID，不上传任何文献内容或记录到外部服务。

启动可使用 `--user-data-dir=<绝对目录>` 覆盖数据位置。自动化测试使用独立临时目录，不混入真实文献库。页码与缩放倍率防抖写入，并在窗口关闭时刷新；异常断电或强制终止进程不保证最后一次状态落盘。

## 安全与测试边界

强制启用 `sandbox` / `contextIsolation` / `webSecurity`，禁用 Node integration、页面导航、弹窗和权限请求。Preload 仅暴露九个业务方法；IPC 核验窗口、主 frame、精确 URL 与 Zod 参数。生产资源由白名单 `app://bundle` 协议提供服务。PDF 解析和阅读使用本地 Worker，不加载 CDN，不执行 PDF 链接、外部目录 URL、表单脚本或注释动作。

测试素材说明见 [tests/fixtures/README.md](tests/fixtures/README.md)。新增的加密、600 页、旋转与 DPI、阅读器 UX 与选区边界素材均为原创合成测试数据（生成器见 `scripts/verification/`）。Playwright 导入测试替换系统文件框返回值，拖拽导入测试在渲染层构造 `File`/`DataTransfer`，其后的字节校验、解析、文件复制、数据库与阅读渲染均真实运行。实际执行结果、失败修复与尚未验证边界见 [实施记录](docs/implementation-notes.md)、[补充验收记录](docs/verification/summary.md) 与 [交付报告](docs/delivery-report.md)。长期模块协作入口见 [项目管理](项目管理/README.md)。

## 目录导航

| 文件或目录 | 内容 |
| --- | --- |
| [src/](src/) | Electron 主进程 `main/`、预加载 `preload/`、React 界面 `renderer/` 和跨进程类型 `shared/` |
| [tests/](tests/) · [scripts/](scripts/) | 单元测试、桌面端到端测试、合成 PDF 素材、预览截取与多平台打包脚本 |
| [build/](build/) · [resources/](resources/) | 打包图标、第三方许可原文和版权声明 |
| [docs/](docs/) · [docs/verification/](docs/verification/) | 架构、实施记录、交付说明、产物清单、验证报告与界面预览截图 |
| [CHANGELOG.md](CHANGELOG.md) | 版本更新日志、发布产物与实测边界记录 |
| `release/` | 本地打包与解包输出目录（被 Git 忽略） |
| [项目管理/](项目管理/) · `项目管理/状态/` | 多会话分工约定（`状态/` 保存本机会话登记、冻结基线与交接，被 Git 忽略） |
| `node_modules/` · `out/` | 依赖与本地构建输出 |
| `.cache/` · `test-results/` | 本机验证日志与 Playwright 临时输出 |

## 开发结构与后续接口

见 [架构说明](docs/architecture.md)。后续阶段可复用 `PdfPageData`（原始文字、TextLayer、viewport）、`PdfViewerProps.onPageData` 和 `pdf-geometry` 的双向坐标、鼠标选区矩形转换；`margin-crop.ts` 仅作本地阅读显示白边裁剪，仍不涉及句子切分、LLM 翻译、双语对照高亮或智能版面裁切。

## 许可证

自有代码采用 [AGPL-3.0-only](LICENSE)。上游版权及许可见 [第三方清单](docs/third-party-licenses.md)、`resources/THIRD-PARTY-NOTICES.txt` 和 `resources/licenses/`。PDF.js 附带字体、ICC、WASM 遵循各自独立许可条款。

`v0.1.0` Release 已随 Liberation Sans 1.07.4 对应源码包发布于 GitHub Releases；本地构建脚本始终保留 `--publish never` 不自动发布，且 Windows 产物保持 `NotSigned` 未商业代码签名。
