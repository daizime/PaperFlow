# PaperFlow T01–T03 多会话补充验收

> **2026-11-22 接续与选区连贯修复验证更新（Worktree: `init_paperflow_desktop`）**：在同步 `2026-11-22 15:00:59` 源码并合入两项稳定性修复（`window.ts` URL 防护与 `useReaderPersistence`/`PdfViewer` 防抖状态稳定化）后，又经 `/swarm` 协作完成符号、字体切换段落、宽下标 ($\bigoplus_{A,B,C,D,E}$)、行内居中点与连续上下行选区断白修复，最终实测结果如下（全部 `--workers=1 --retries=0`，0 失败/0 跳过/0 重试）：
> - 静态与单测：`pnpm typecheck` / `pnpm lint` 通过；`pnpm test` **6 文件 70/70 通过**（含 `selection-bridges.test.ts` **11 项**）。
> - 开发热更新与原生检查：`pnpm dev` + `scripts/dev-smoke.ts` 与 `pnpm rebuild:electron`（`Electron 44.7.2 / NAPI 10 / SQLite 3.53.4`）于先前同配置工作区实测通过，本轮未改主进程/原生模块/构建配置。
> - 源码 E2E（`out/main/index.js`）：**61/61 通过**（含 `selection-continuity.spec.ts` 4/4、`math-highlight.spec.ts` 3/3、`selection-overlap.spec.ts` 6/6、`selection-verification.spec.ts` 26/26、`workspace-ui.spec.ts` 2/2）。
> - Windows 打包与实机 `.exe` E2E（`release/win-unpacked/PaperFlow.exe`）：**61/61 通过**；209/209 构建文件与 `app.asar` 逐字节一致，41/41 许可证 SHA-256 一致，产物 `NotSigned`，摘要见 [artifacts.json](../artifacts.json) 与 [实施记录](../implementation-notes.md)。以下保留 2026-10-28 历史记录与未验证边界。

日期：2026-10-28，Asia/Shanghai。此前基础功能的指定自动化与本机隔离安装验证通过；后续选区反馈仍在修复，不能称为全部场景验证或正式发布。

2026-11-22 本机整理后，历史安装包与配套 blockmap 曾归入各自的 `安装包/` 目录（本机忽略目录 `release/README.md`）。下文保留验收时的路径。

后续用户反馈：系统文件框手动选取并导入 PDF 已由用户确认成功，记录为用户手动验证，详见 [反馈记录](user-feedback.md)。同日优先修复文字/公式拖入空白跳选：候选 14 源码新增 20 项与既有 20 项全部通过，但新 Windows 解包应用完整 40 项为 **37 过、3 败**，仍未接受交付。追加被动诊断 3 项和轻量分子诊断 1 项通过，但未复现原失败，不能抵销失败门禁。revision 8 正在处理静态确认的原生选择与脚本端点双重控制窗口，尚未执行新候选桌面验收；详情见 [选区 QA 记录](qa-selection.md)。下面的 59/20/20/1 是此前候选的实际测试结果，不代表该新反馈已全部解决。

源码候选为 `PF-VERIFY-20261028-07`，来自包含未提交修改的工作区。历史 Git 基线为 `0779111`；本轮没有提交、推送、远程部署或发布 Release。源码快照、原始日志和验收记录保存在本机忽略目录，不能将快照称为干净 HEAD 构建。

## 实际目录与协作

项目直接位于 `<repo-root>`。完整初始布局见 [初始交付报告](../delivery-report.md)，当前源文件清单见 [source-files.txt](source-files.txt)。本轮新增或扩展的主要路径如下，未逐项展开依赖、缓存、许可证原文和生成资源。

```text
src/
  main/{index.ts,window.ts,ipc/,services/}
  preload/{index.ts,validation.ts}
  renderer/{index.html,validation.html,validation.ts,src/}
    src/features/library/
    src/features/reader/
      PdfViewer.tsx / PdfPage.tsx / ReaderToolbar.tsx
      pdf-engine.ts / pdf-geometry.ts
      useReaderPersistence.ts / reader-state-writer.ts
      reader.css / page.css / toolbar.css
    src/features/translation/TranslationPanel.tsx
  shared/{contracts.ts,schemas.ts}
tests/
  unit/{library,library-robustness,schemas,pdf-geometry,reader-state-writer}.test.ts
  e2e/{bootstrap,library,reader,reader-verification,security,verification}.spec.ts
  e2e/helpers.ts
  fixtures/verification/reader/
    encrypted-r2.pdf / geometry.pdf / long-600.pdf / manifest.json / README.md
scripts/verification/{generate-reader-fixtures.ts,library-faults.ps1}
docs/verification/{summary,reader,library,qa,release,license-source-plan}.md
项目管理/{README.md,规则/,脚本/,状态/}
out/                                生产构建，忽略提交
release/PaperFlow-0.1.0-win-x64-setup.exe
release/win-unpacked/                完整解包应用
```

根目录保有 README、AGPL LICENSE、严格 TS/ESLint 配置、electron-vite、electron-builder、Playwright、Vitest 配置和 `pnpm-lock.yaml`。

已建立四个真实长期聊天：PaperFlow｜阅读器与坐标、PaperFlow｜本地文献服务、PaperFlow｜测试与交付、PaperFlow｜版本与许可。身份及路由只存于本机登记；临时审阅代理没有登记为持久会话。主控维护共享配置、任务和验收；qa 独占公共构建、打包及桌面操作。入口为 [项目管理](../../项目管理/README.md)。

## T01、T02、T03 的实际行为

| 阶段 | 已实现与实际验证 |
| --- | --- |
| T01 | Electron + React + 严格 TypeScript；浅色三栏界面、图标、窗口尺寸约束；生产 app:// 协议；sandbox/contextIsolation/webSecurity 保持开启，Node integration 关闭；固定业务 Preload、CSP、导航/弹窗/权限拒绝；构建和实际 Windows 启动 |
| T02 | 系统选择入口；扩展名、PDF 头、100MiB 限制及真实 PDF.js 结构校验；SHA256 去重、UUID 副本、同名共存、失败清理；SQLite 持久化、页数与进度；调用者/参数/文献 ID 校验；损坏和加密样本友好拒绝 |
| T03 | 本地真实 Worker、Canvas 和官方 TextLayer；多页连续阅读、鼠标拖选及 Ctrl+C、缩放和页码导航；离屏 Canvas 释放、渲染取消、高 DPI 像素预算；状态防抖和关闭刷新；混合尺寸适合宽度与可取消导航锚定 |

右侧仍为独立滚动的“尚未翻译”容器。没有接入 AI、LLM、OCR、账号、同步、云存储或外部文献服务。测试 PDF 均为明确标注的原创合成素材，未提交真实论文全文。

本轮实际修复：`SQLITE_FULL` 中文错误映射；适合宽度错误使用首页宽度及混合宽页偏移；相邻页从估计尺寸变为真实尺寸时，导航目标被推离懒渲染范围。另修测试浏览器回调未显式传参和 lint 未忽略生成缓存的问题，原断言和失败记录保留。

## 主要版本

本轮没有增加依赖或改变锁文件。以下为已安装版本，详细清单见 [dependency-versions.json](../dependency-versions.json)。

| 组件 | 版本 |
| --- | --- |
| Node.js / pnpm | 24.21.0 / 11.25.0 |
| Electron / electron-vite / Vite | 44.7.2 / 6.0.0 / 8.3.4 |
| React / React DOM | 19.3.0 / 19.3.0 |
| TypeScript / Tailwind CSS | 5.9.3 / 4.3.3 |
| pdfjs-dist | 6.4.299 |
| better-sqlite3 / 实际 SQLite | 13.0.3 / 3.53.4 |
| Zod | 4.6.7 |
| Vitest / Playwright | 5.0.5 / 1.64.1 |
| electron-builder / ESLint | 26.15.3 / 10.13.0 |

## IPC 与数据库

`window.paperflow` 只暴露六个方法：

| 方法 | 用途 |
| --- | --- |
| `importPdf()` | 主进程打开原生框，返回 imported/existing 或取消 |
| `listDocuments()` | 返回文献元数据 |
| `readPdfBytes(documentId)` | 仅返回已入库合法 UUID 的字节 |
| `updatePageCount(documentId, pageCount)` | 保存解析后的页数 |
| `getReaderState(documentId)` | 获取页码、倍率和时间 |
| `saveReaderState(state)` | 保存阅读状态 |

前端不传本地路径，不获得原始 IPC、文件系统或命令执行能力。类型及 Zod 模型位于 `src/shared/`，主进程验证调用窗口、主 frame、URL 和参数。

数据位于 Electron userData，PDF 为 `library/<UUID>.pdf`。`documents` 保存 UUID、唯一 SHA256、原始/显示/存储文件名、大小、可空页数和导入时间；`reader_state` 以 document_id 外键关联页码、倍率和更新时间。使用绑定参数、WAL 与 `user_version=1`，不写入安装目录。阅读状态约 450ms 防抖，正常关闭刷新；物理断电不作同等保证。

## 实际命令和结果

下表记录最终候选；详细参数、退出码、JSON 和附件见 [QA 报告](qa.md)。每个实际 E2E 案例均为 passed，未用自动重试隐藏失败。几组测试是不同执行范围，不应相加当作不同功能数量。

| 命令或执行范围 | 结果 |
| --- | --- |
| `pnpm dev` 与 React HMR | 2026-10-27 已真实验证；本轮未重复，不能写成本轮新测试 |
| `pnpm typecheck` | 通过，退出 0 |
| `pnpm lint` | 最终通过，退出 0；早期缓存目录的 31 个错误保留 |
| `pnpm test` | 59/59，通过；实际 5 个测试文件 |
| `pnpm build` | 通过，退出 0 |
| `pnpm rebuild:electron` | 实际 Electron / NAPI10 / SQLite 查询通过；本轮最终门禁按未改原生模块复用该证据 |
| `pnpm test:e2e`，DPR3 定向 | 2/2，通过；含四秒被动稳定、真实滚轮取消及最新导航 |
| `pnpm test:e2e`，源码生产构建 | 20/20，通过 |
| `pnpm dist:win` | 通过，退出 0，未发布 |
| `pnpm test:e2e`，新 win-unpacked EXE | 20/20，通过；实际 EXE 路径另有记录 |
| 新 NSIS 安装版正常关闭恢复单例 | 1/1，通过；含真实鼠标选字及剪贴板 |
| 新包隔离静默安装与卸载 | 安装/卸载器退出 0；最终无本轮目录、注册项、快捷方式或进程残留 |

NSIS 首次卸载检查脚本因快捷方式尚在退出 1；稍后只读复查确认其自行消失，未手工删除。两个快照均保留。既有默认数据 124 个文件及本轮隔离数据库前后 SHA256 无差异。安装负载 141 个物理文件与新解包应用一致；ASAR 内 209 个 out 文件与实际已测构建一致。

本机原始证据为 `.cache/qa/20261028-regression-01/`，最终结果在 `r5-*`。历史失败为初次源码 14 过 5 败、修测试调用后 18 过 1 败，以及导航诊断。它们未被成功日志覆盖。模块定向报告分别见 [reader](reader.md)、[library](library.md)、[release](release.md)。

## Windows 产物

| 产物 | 大小与 SHA256 |
| --- | --- |
| `release/PaperFlow-0.1.0-win-x64-setup.exe` | 122993353 字节；`d488a699708e93b7da76e598274451f6eaf075ebf731c0f7a8a9573bef1777f7` |
| `release/win-unpacked/PaperFlow.exe` | 245590016 字节；`aa290d32926ae9c999fa479f4e8bb90b48737b495dba5c1976e8d93453201498` |
| `release/win-unpacked/resources/app.asar` | 33280280 字节；`98ab809a7ff0c07356b77f177c8b56a205c29b14061b0fe7a03d8d5cd9336d9c` |

安装包与 EXE 均为 `NotSigned`。完整交付元数据由版本模块在 [artifacts.json](../artifacts.json) 更新；本轮没有远程发布。

## 已通过、历史失败和未验证的区别

核心运行、导入/重复识别/同名共存、损坏及真实加密拒绝、真实 Canvas/TextLayer/本地 Worker、文字选择复制、进度恢复、安全 IPC、坐标往返、600 页导航与 Canvas 按需释放，以及本机静默装卸已通过上述范围测试。Windows FileShare.None 独占锁及释放重试为真实操作。

五档 DPR 是进程模拟，不是物理显示器切换。磁盘满、EIO、权限及部分清理错误为故障注入；SQLite 触发器拒绝是人为构造的真实数据库失败。精确 100MiB 的服务边界测试实际执行快照/哈希/复制，但 PDF 解析器用了替身，不能称为真实 100MiB PDF 全流程通过。

以下仍未验证或存在边界：

- 原生系统框完整选中文件；实际打开/取消已验证，自动导入用例注入了文件框返回值。
- 其他机器、真实多显示器/DPI 迁移、交互安装向导、真实触摸及原生滚动条等输入边界。
- 物理磁盘满、异常断电和强制终止；启动时尚无孤立副本自动回收。
- 极端文档总进程内存、完整页面 DOM 虚拟化；600 页验证的是 Canvas 驻留和释放，不是总内存上界。
- 需要低于 50% 才能容纳的超宽页仍受倍率下限约束；复杂合法 PDF 也可能触发 20 秒导入校验时限。
- 签名及公开分发来源证据尚未完成。字体 1.07.4 官方源码已本机保存，但 PGP、字节一致重建及向受领者提供来源的渠道尚未验证；FFmpeg 精确源码/配置仍待核对。见 [许可来源计划](license-source-plan.md)。

## T04–T08 复用接口

`PdfViewerProps.onPageData` 借用每页 `PdfPageData`：真实 `textContent`、官方 `TextLayer`、页面 DOM 和 `PageGeometry`（PageViewport、outputScale）。离屏、缩放或销毁时以 null 撤销，调用者不可长期保留过期资源。

`pdf-geometry.ts` 提供 PDF/CSS 点和矩形双向转换、客户区命中及 Selection 到分页 PDF 矩形的转换；覆盖旋转、CropBox 与 UserUnit。448 组 Viewport 检查的点/矩形最大往返误差约为 2.274e-13 / 1.279e-13；实际五档 DPR 的 Canvas/TextLayer 边界对齐阈值为 0.1 CSS 像素。原始文字项的 transform 和样式保留，不将一个 item 自动认作一句。

每页 Canvas/TextLayer 共用视口，保留不拦截选字的未来覆盖层位置。当前未实现句子切分、翻译、裁剪、双向高亮或它们的数据表；后续阶段需要另行派工。
