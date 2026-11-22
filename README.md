# PaperFlow
面向科研论文的 Windows 本地 PDF 阅读器。当前实现 T01–T03：安全桌面框架、本地文献库、真实 PDF.js Canvas + TextLayer、多页阅读和阅读进度。不接入翻译、LLM、OCR、网络文献服务或云存储。

## Windows 启动

通过 `pnpm dist:win` 或 `pnpm pack:win` 会在被 Git 忽略的 `release/` 目录生成本地测试程序（`NotSigned`，未签名、未远程发布）：

| 用途 | 产物说明（本机构建后生成） |
| --- | --- |
| 直接启动解包版 | `release/win-unpacked/PaperFlow.exe`，双击运行，需保留同目录 DLL、语言资源与 `resources/` |
| 本地安装包 | `release/PaperFlow-0.1.0-win-x64-setup.exe`（NSIS 安装包，`--publish never`） |

当前版本已完成基础文献库检索/首屏 UI 接线、选区重叠修复与公式/字体切换/宽下标/连续行选区断白修复，经 `typecheck`、`lint`、`70/70` 单元测试、`61/61` 源码 E2E 与 `61/61` 打包 `.exe` E2E 实测通过；最新构建校验见 [产物清单](docs/artifacts.json)、[补充验收记录](docs/verification/summary.md) 与 [实施记录](docs/implementation-notes.md)。

## 从源码启动

要求 Windows x64、Node.js 24+、pnpm 11.25.0；版本由 package.json / pnpm-lock.yaml 固定。

```powershell
pnpm install --frozen-lockfile
pnpm fixtures
pnpm dev
```

通过左侧「导入 PDF」选择本地文件。文件上限为 100 MiB；源文件保持原样，校验成功后复制进用户数据目录。支持内容去重、同名不同内容并存。工具栏可翻页、跳页、缩放 50%–300%、适合宽度。使用鼠标拖选文字后按 Ctrl+C 复制。图像扫描页会提示暂不支持 OCR。右侧译文区只显示「尚未翻译」。

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
启用 sandbox / contextIsolation / webSecurity，禁用 Node integration、页面导航、弹窗和权限请求。Preload 仅暴露六个业务方法；IPC 核验窗口、主 frame、精确 URL 与 Zod 参数。生产资源由白名单 app://bundle 协议服务。PDF 解析和阅读使用本地 Worker，不加载 CDN，不执行 PDF 链接、表单脚本或注释动作。

测试素材见 [tests/fixtures/README.md](tests/fixtures/README.md)。Playwright 的导入测试仅替换原生系统文件框的返回值，之后的解析、文件复制、数据库和阅读全部真实运行；不会用图片模拟 PDF。实际执行结果、失败修复与尚未验证项目见 [实施记录](docs/implementation-notes.md) 和 [交付报告](docs/delivery-report.md)。

长期模块协作入口见 [项目管理](项目管理/README.md)。新增的加密、600页、旋转与DPI素材均为合成测试数据，生成器为 `scripts/verification/generate-reader-fixtures.ts`；补测证据及限制分别记录于 `docs/verification/`。模块提交须由主控核验后验收，全套构建、打包和桌面测试由测试模块统一运行。

2026-10-28 的基础验收记录包含 59 项单测、源码与 Windows 解包应用各 20 项 E2E、隔离安装版 1 项通过。用户也手动确认了系统文件框导入。物理 DPI、其他机器与公开分发许可事项仍待验证，当前安装包未签名。详见 [补充验收记录](docs/verification/summary.md)。

2026-11-22 恢复开发并完成首屏导入、文献搜索、导入结果反馈和共享导入状态 UI 接线；早期 UI 预览历史记录见 [基础界面预览](docs/verification/ui-showcase.md)。随后经连续选区修复，当前源码与 Windows 解包程序均已通过全套 70 项单测与 61 项端到端回归（含选区重叠、公式及 5 行连续选区），详见 [补充验收记录](docs/verification/summary.md) 与 [实施记录](docs/implementation-notes.md)。

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
见 [架构说明](docs/architecture.md)。T04–T08 可复用 PdfPageData（原始文字、TextLayer、viewport）、PdfViewerProps.onPageData 和 pdf-geometry 的双向坐标、鼠标选区矩形转换；当前不做句子切分、翻译、高亮或裁剪。

## 许可证
自有代码采用 [AGPL-3.0-only](LICENSE)。上游版权及许可见 [第三方清单](docs/third-party-licenses.md)、resources/THIRD-PARTY-NOTICES.txt 和 resources/licenses/。PDF.js 附带字体、ICC、WASM 有独立条款，不能仅按 PDF.js 主许可证判断。后续引入 pdf2zh-next、BabelDOC、PyMuPDF 前须重新核查整个分发方案。当前不安装这些依赖。

本地测试包不代表正式发布、签名或许可审查已全部完成。本轮不上传 GitHub Release、不远程部署。
