# PaperFlow
面向科研论文的 Windows 本地 PDF 阅读器。当前实现 T01–T03：安全桌面框架、本地文献库、真实 PDF.js Canvas + TextLayer、多页阅读和阅读进度。不接入翻译、LLM、OCR、网络文献服务或云存储。

## Windows 与 Linux 启动

通过 `pnpm dist:win`、`pnpm pack:win` 或 `pnpm dist:linux` 会在被 Git 忽略的 `release/` 目录生成本地测试程序（`NotSigned`，未签名、未远程发布）：

| 用途 | 产物说明（本机构建后生成） |
| --- | --- |
| Windows 解包版 | `release/win-unpacked/PaperFlow.exe`，双击运行，需保留同目录 DLL、语言资源与 `resources/` |
| Windows 安装包 | `release/PaperFlow-0.1.0-win-x64-setup.exe`（NSIS 安装包，`--publish never`） |
| Linux x64 便携包 | `release/PaperFlow-0.1.0-linux-x64.tar.gz`（Windows 跨平台构建；在 Linux 解压后运行 `PaperFlow-0.1.0-linux-x64/paperflow`） |

当前版本已具备完整 T01–T03 基础及纯本地科研阅读器增强能力，包含：
- **本地文献库管理**：按钮或拖拽 `.pdf` 导入（通过有界 `Uint8Array` 传输并共享主进程 SHA-256 去重与沙盒校验，不暴露本地路径）、文献搜索、内联重命名、确认删除（联动清理 `reader_state` 与副本）、逐文件详细错误列表与启动孤立副本自动清理。
- **科研阅读体验**：PDF 内部目录书签抽屉、`Ctrl+F` 取消式惰性全文搜索与命中定位高亮、`Ctrl+滚轮`缩放与键盘翻页/缩放快捷键、本地白边裁剪阅读（`裁剪白边` 联动适合宽度，保留精准选字坐标系）。
- **选区连续性与边界加固**：跨页连选 SVG 高亮、0°/90°/180°/270° 旋转页面数学公式与多行选区连续性、Windows `forced-colors: active` 高对比度无内描边平滑适配。

经 `typecheck`、`lint`、`89/89` 单元测试、`69/69` Windows 源码 E2E 与 `69/69` Windows 打包 `.exe` E2E 实测通过（并由用户于 Windows 真实高对比度桌面环境复验选区显示）；Linux x64 便携包已通过 TAR/ELF/`209/209` 构建与 `41/41` 许可证一致性校验，并在 Ubuntu 26.04.1 LTS 实机（Wayland + `vmwgfx`，需满足 `chrome-sandbox` `root:root 4755`）实测通过无参 `./paperflow`（自动走 X11 包装脚本）、窗口扩缩/最大化（含用户鼠标实机确认）、拖拽导入与 PDF.js 渲染（Linux 全套 E2E 未于 Linux 原生运行）。最新构建校验见 [产物清单](docs/artifacts.json)、[补充验收记录](docs/verification/summary.md) 与 [实施记录](docs/implementation-notes.md)。

## 从源码启动

要求 Windows x64、Node.js 24+、pnpm 11.25.0；版本由 package.json / pnpm-lock.yaml 固定。

```powershell
pnpm install --frozen-lockfile
pnpm fixtures
pnpm dev
```

通过左侧「导入 PDF」或直接将 `.pdf` 文件拖入工作区导入本地文献。单文件上限为 100 MiB；源文件保持原样，校验成功后复制进用户数据目录，支持内容去重、同名不同内容并存、内联重命名与确认删除。工具栏支持目录抽屉、前后页/跳页、缩放 50%–300%、适合宽度、裁剪白边与文内搜索（`Ctrl+F`），并支持 `Ctrl+滚轮` 缩放与阅读区方向键/快捷键。使用鼠标拖选文字（含跨页与 90° 旋转页公式）后按 `Ctrl+C` 复制。图像扫描页会提示暂不支持 OCR。右侧译文区仍只显示「尚未翻译」。

## 命令
| 命令 | 用途 |
|---|---|
| `pnpm dev` | Electron + Vite 开发窗口，React HMR |
| `pnpm typecheck` | 主进程、Preload、Renderer、测试严格类型检查 |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest 业务测试 |
| `pnpm test:e2e` | Playwright 实际 Electron 测试，需先 build |
| `pnpm build` | 生产构建到 out/，不依赖开发服务器 |
| `pnpm dist:win` | Windows x64 NSIS 本地测试安装包，不上传 |
| `pnpm pack:win` | Windows 解包程序到 release/win-unpacked/ |
| `pnpm dist:linux` | Linux x64 便携 `.tar.gz`（支持在 Windows 跨平台构建并校验 Electron SHA-256 与 POSIX 权限） |
| `pnpm fixtures` | 重新生成可再分发的原创测试 PDF |
| `pnpm rebuild:electron` | 在真实 Electron 中验证 SQLite Node-API 兼容性，需先 build |

安装时会下载 Electron 二进制。若直连 GitHub 超时，可自行配置可信的 Electron 镜像；本次安装使用 npmmirror 下载，并与 electron npm 包中 checksums.json 的 SHA-256 校验一致。不要禁用下载校验。better-sqlite3 13 附带 Node-API 10 预编译文件，本项目不调用传统 electron-rebuild 编译，避免无必要的 Python/C++ 工具链；升级后须重新运行原生与打包测试。

## 本地数据
默认位于 Electron `app.getPath('userData')`（本机通常为 `%APPDATA%/PaperFlow`）：
- `paperflow.sqlite`：documents 与 reader_state 两张业务表，WAL 模式、绑定参数、user_version=1。
- `library/<UUID>.pdf`：入库副本。前端不接触绝对路径。
- Chromium 配置数据保存最近选择的文献 ID，不保存正文到外部服务。

本机启动可使用 `--user-data-dir=<绝对目录>` 覆盖数据位置。自动化测试用独立临时目录，不混入真实文献库。页码和倍率防抖写入，并在窗口关闭时刷新；异常断电或强制杀进程不保证最后一次状态保存。

## 安全与测试边界
启用 sandbox / contextIsolation / webSecurity，禁用 Node integration、页面导航、弹窗和权限请求。Preload 仅暴露九个业务方法；IPC 核验窗口、主 frame、精确 URL 与 Zod 参数。生产资源由白名单 app://bundle 协议服务。PDF 解析和阅读使用本地 Worker，不加载 CDN，不执行 PDF 链接、外部目录 URL、表单脚本或注释动作。

测试素材见 [tests/fixtures/README.md](tests/fixtures/README.md)。Playwright 的原生导入测试替换系统文件框返回值，拖拽导入测试在渲染层构造 `File`/`DataTransfer`，之后的字节校验、解析、文件复制、数据库和阅读全部真实运行；不会用图片模拟 PDF。实际执行结果、失败修复与尚未验证项目见 [实施记录](docs/implementation-notes.md) 和 [交付报告](docs/delivery-report.md)。

长期模块协作入口见 [项目管理](项目管理/README.md)。新增的加密、600页、旋转与DPI、阅读器 UX 与选区边界素材均为原创合成测试数据（生成器见 `scripts/verification/`）；补测证据及限制分别记录于 `docs/verification/`。

2026-10-28 的基础验收记录包含 59 项单测、源码与 Windows 解包应用各 20 项 E2E、隔离安装版 1 项通过。用户也手动确认了系统文件框导入。详见 [补充验收记录](docs/verification/summary.md)。

2026-11-22 在完成选区连贯性修复并合入 `main` 后，继续在当前 worktree 通过 Swarm 多角色协作完成纯本地阅读器功能增强、本地文献库管理增强与跨页/旋转/`forced-colors` 选区边界加固，最新源码与 Windows 解包程序均已通过全套 **89 项单测**与 **69 项端到端回归**，详见 [补充验收记录](docs/verification/summary.md) 与 [实施记录](docs/implementation-notes.md)。

## 目录导航

| 文件或目录 | 内容 |
| --- | --- |
| [src/](src/) | Electron 主进程 `main/`、预加载 `preload/`、React 界面 `renderer/` 和跨进程类型 `shared/` |
| [tests/](tests/) · [scripts/](scripts/) | 单元测试、桌面测试、合成 PDF 素材及生成和验证脚本 |
| [build/](build/) · [resources/](resources/) | 打包图标、第三方许可原文和版权声明 |
| [docs/](docs/) · [docs/verification/](docs/verification/) | 架构、实施记录、交付说明和验证报告 |
| `release/` | 本地打包与解包输出目录（被 Git 忽略，执行 `pnpm dist:win` / `pnpm pack:win` 后生成 `win-unpacked/` 与 NSIS 安装包） |
| [项目管理/](项目管理/) · `项目管理/状态/` | 多会话分工约定（`状态/` 保存本机会话登记、冻结基线与交接，被 Git 忽略） |
| `node_modules/` · `out/` | 依赖和本地构建输出 |
| `.cache/` | 本机验证日志和原始证据。历史打包日志归在 `.cache/release-audit/构建日志/` |
| `test-results/` | Playwright 默认输出目录。上一次运行记录已归档，后续运行会重新生成此目录 |

## 开发结构与后续接口
见 [架构说明](docs/architecture.md)。T04–T08 可复用 `PdfPageData`（原始文字、TextLayer、viewport）、`PdfViewerProps.onPageData` 和 `pdf-geometry` 的双向坐标、鼠标选区矩形转换；`margin-crop.ts` 仅作本地阅读显示白边裁剪，仍不涉及句子切分、LLM 翻译、双语对照高亮或智能版面裁切。

## 许可证
自有代码采用 [AGPL-3.0-only](LICENSE)。上游版权及许可见 [第三方清单](docs/third-party-licenses.md)、resources/THIRD-PARTY-NOTICES.txt 和 resources/licenses/。PDF.js 附带字体、ICC、WASM 有独立条款，不能仅按 PDF.js 主许可证判断。后续引入 pdf2zh-next、BabelDOC、PyMuPDF 前须重新核查整个分发方案。当前不安装这些依赖。

本地测试包不代表正式发布、签名或许可审查已全部完成。本轮不上传 GitHub Release、不远程部署。
