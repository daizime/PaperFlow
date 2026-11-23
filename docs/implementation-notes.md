# 实施记录
日期：2026-10-27（Asia/Shanghai）。工作目录：<repo-root>。

## 实施与阶段门禁
初始工作区为空，无 Git 仓库或旧用户代码。先执行官方 `pnpm create @quick-start/electron@latest . --template react-ts --name paperflow`。下载获准后取得 @quick-start/create-electron 1.0.31；CLI 因 pnpm dlx 缺少 kleur 未完成。随后从该官方包复制 base/react-ts 模板，保留三进程约定。模板 MIT 原文已保留，来源见第三方清单。

- T01：安全主窗口、React 三栏布局、app:// 白名单协议、CSP、沙盒单文件 preload、开发 HMR、Windows 解包测试。类型/构建/启动与安全测试通过后进入 T02。
- T02：SQLite 两表、版本迁移、PDF 有界快照/哈希/复制/去重、安全业务 IPC、隐藏沙盒逐页解析校验、文献列表。业务测试与源码/打包导入、重启通过后进入 T03。
- T03：真实 PDF.js Worker、Canvas、官方 TextLayer、连续滚动/页码/缩放、懒渲染与资源取消、扫描页提示、阅读状态关闭刷新。最终完成源码与 Windows 包测试。
- 只实施 T01–T03。没有 LLM、翻译引擎、OCR、账号、Zotero、云存储或外部文献服务。

采用 multi-session-collab 的任务落盘、基线、独占文件与主控验收约定。用户未明确要求创建新的持久聊天，因此没有创建持久模块聊天；临时代理用于独立安全复核、后端、单页及工具栏实现，不登记为持久会话。版本与本地交付由主控兼任；真实会话身份与状态放在被忽略的项目管理/状态/，不随产品提交。

## 关键处理
1. 模板中的 sandbox:false、宽泛 electronAPI、shell.openExternal 和 file:// 生产入口均已替换。主窗口仅暴露六个业务 API。
2. Preload 各入口独立输出单文件 CJS；运行时仅 require Electron。没有为修复模块加载而关闭 sandbox。
3. Electron GitHub 下载超时，改用可连接镜像，并核对官方 electron npm 包 checksums.json。Windows x64 zip SHA256 为 `10a89447ef64ac5cb9f782af48ffd83734a40ae91681259d1048ca3c9e6c5da4`。Builder 复用已校验的本地 distribution。
4. 传统 electron-builder install-app-deps 尝试要求 Python；实际安装的 better-sqlite3 13 已改用 Node-API10 并附带预编译文件。采用该二进制并在真实 Electron 中验证：Electron44.7.2 / NAPI10 / SQLite3.53.4，打开、查询、关闭成功；npmRebuild:false 有实际兼容证据。
5. 安全复核发现 app:// 的 URL.origin 为 null，PDF.js 默认同源判断可能导致 fake Worker。改为显式 new Worker + PDFWorker.create({port})，不放宽 worker CSP；生产测试验证 Worker URL 与无 fake worker 警告。
6. 文件结构校验在隐藏沙盒窗口及本地 Worker 中逐页 getOperatorList，不在高权限主进程解析。20秒超时会拒绝过于复杂或损坏文件；不是 PDF 标准全项一致性证明。
7. Canvas 与 TextLayer 共用 viewport，字体加载后布局文字；高 DPI 物理像素有上限。新旧任务使用独立 DOM/Canvas 并取消、等待结束后 cleanup。
8. 数据库在 will-quit 关闭，窗口关闭先等待当前进度刷新。独立复核发现 A已保存→B待写→A关闭的去重竞态，改为按最后排队状态去重，补充3项异步单测。
9. Renderer 的 React/PDF.js 通过 Vite 打包，不作为外部生产 npm 包重复分发。仅保留实际使用的 PDF.js 离线资源，排除 QuickJS；确认最终包无可选 Node Canvas 依赖。
10. 许可证原文、Chromium 声明、字体/ICC/WASM 条款和官方模板 MIT 已保留。Liberation1.07.4 字体的对应源码核查仍待正式分发前落实。

## 实际命令与最终结果
| 命令/检查 | 结果 |
|---|---|
| `pnpm fixtures` | 通过：6个原创 PDF，无真实论文全文 |
| `pnpm dev --remoteDebuggingPort 9333` | 通过：真实窗口与固定本机 Vite 服务 |
| `pnpm exec tsx scripts/dev-smoke.ts` | 通过：组件文字修改/恢复、React HMR保持页面上下文、无 pageerror；完整工程复验通过 |
| `pnpm typecheck` | 通过：主进程/Preload/Renderer/测试，strict:true |
| `pnpm lint` | 通过 |
| `pnpm test` | 通过：3个文件，21项 |
| `pnpm test:e2e` | 通过：源码生产构建5/5 |
| 设置 PAPERFLOW_EXECUTABLE 为 release/win-unpacked/PaperFlow.exe 后 `pnpm test:e2e` | 通过：最终Windows程序5/5 |
| `pnpm test:e2e --grep 真实多页Canvas`（源码与Windows包） | 两次各1/1，补充真实滚轮连续阅读及译文独立滚动验证 |
| `pnpm build` | 通过 |
| `pnpm pack:win` | 通过，T01和T02阶段实测解包程序 |
| `pnpm dist:win` | 通过，本地NSIS安装包，--publish never |
| `pnpm rebuild:electron` | 通过：真实Electron加载Node-API SQLite |
| `pnpm exec tsx scripts/capture-preview.ts` | 通过：最终程序真实PDF阅读画面，见paperflow-reader.png |
| 最终包/构建文件比对 | 209个构建文件逐字节一致；Worker、AGPL正文、上游通知在包内 |
| 许可证校验 | 41份记录SHA256一致；其中40份还与安装来源文件逐字节一致 |
| Authenticode | NotSigned，本地测试包未签名 |

最终安装包大小与 SHA256 见 [artifacts.json](artifacts.json)。构建日志出现“signing with signtool.exe”不代表签名成功；本项目没有设置签名证书，以实际 Authenticode 结果为准。

Playwright 的系统文件框返回值被测试替换；其后的 PDF.js 结构解析、文件复制、SHA256、SQLite、渲染和文字选择全部真实运行。文本选择采用鼠标拖拽，Ctrl+C 后从 Electron 系统剪贴板读取非空真实文字。没有通过 JS 人工创建 Range 冒充用户选区。

computer-use 实测原生文件框成功打开，显示 PDF 扩展名过滤；工具未能可靠聚焦模态输入控件，完整原生选文件确认未记为通过。测试使用独立临时数据目录；未导入用户私人文献。

## 失败与修复历史
- 模板CLI缺少kleur、官方二进制网络超时：改用已取得的官方模板包及通过官方SHA校验的镜像二进制。
- 受限命令环境中的文件重命名报EPERM：真实用户环境重测通过；不修改导入业务来绕过权限。
- 原生重编译缺Python：核实Node-API预编译路径，未安装Python替代Electron。
- 早期测试在loadURL完成前退出导致启动错误窗口：测试先等待界面就绪；退出期间不再弹启动错误。
- Playwright对阻止导航后的待导航状态观察不可靠：以主进程webContents URL、正文和窗口数量核验，未移除导航拦截。
- Lint曾扫描生成的PDF.js第三方资源：将原样复制的资源目录排除，自有TS仍严格检查。
- 扫描页测试status角色不唯一：限定到OCR提示，重测通过。
- 新增队列测试一度使用与ES2022类型目标不符的Promise.withResolvers：改为标准Promise延迟控制器，类型检查和测试通过。
- `pnpm licenses list --prod --json` 因缓存索引缺失失败；改用已安装package.json与LICENSE/NOTICE原文核查，未把该命令标记为通过。
- 首次ASAR比对用了POSIX分隔符，被本机ASAR库拒绝；改为Windows本机路径后209文件比对通过。

## 验收边界与后续风险
当前核心功能没有未修复的已知阻断失败。未验证：NSIS安装/卸载与其他Windows机器、真实加密PDF样本、独占文件锁/磁盘满/断电、极长文档与多种DPI硬件。100MiB边界、普通复制/数据库失败清理有单测，不等同这些实机故障场景已通过。

安装包未签名。长文档只对Canvas懒渲染，仍为每页保留DOM占位；极端页数性能需后续验证。关闭刷新最长等待2秒，强杀/断电或磁盘写入失败时不保证最新状态。复杂PDF可能因20秒导入校验时限被拒绝。字体对应源码、正式分发的完整源码提供方案须在公开发布前核查；本轮未发布远端。

架构、安全与后续页面接口见 [architecture.md](architecture.md)，依赖许可见 [third-party-licenses.md](third-party-licenses.md)。

## 2026-10-28 多会话补验
已建立四个真实长期模块，主控唯一派工和验收、qa唯一公共构建/桌面执行。补齐真实加密/600页/旋转与UserUnit合成素材、坐标单测和Windows故障验证。修复SQLITE_FULL中文提示、当前页fit宽度、混合页尺寸变化导致程序导航移出IO、测试evaluate参数传递及缓存lint范围；源码/接口/依赖范围均按任务约束核查。
最终07候选：typecheck/lint/test59/build/dist通过；DPR3两项、源码20项、新解包20项、隔离新安装版1项通过。卸载早期脚本因快捷方式尚在退出1，后续只读验证自行消失、无手工清理，最终无本轮残留；124默认数据文件SHA差异0。原14过5败、18过1败、探针脚本失败与所有前后证据保留，未以重试日志覆盖。
新包122993353字节，SHA256 d488a699708e93b7da76e598274451f6eaf075ebf731c0f7a8a9573bef1777f7，未签名、未发布。详细命令、分层证据、真实/模拟/注入/未验区别和后续坐标接口见docs/verification/summary.md及各模块报告。原2026-10-27交付记录仅作为历史，新改动尚未提交Git；不自动进入T04–T08。

## 2026-11-22 接续验收与稳定性修复
原仓库 `<repo-root>` 中的 Codex 持久多会话因余额耗尽自动停止，本工作区 `init_paperflow_desktop` 同步了截至 `2026-11-22 15:00:59` 的最新源码、测试与合成素材（保留 `<repo-root>` 只读备份），在当前工作区安装依赖、补齐验证并合入稳定性修复。由于宿主不具备 Codex 持久线程路由工具，`项目管理/状态/registry.json` 仅登记核实后的主控会话，未伪造任何持久模块 ID。

1. **新同步且首次完整验证的功能**：公式与相邻行选区连续高亮（`selection-bridges.ts`、`selection-ink.ts`、`selection-highlight.ts`、`PdfPage.tsx`、`page.css`）、公式桥接单测（`tests/unit/selection-bridges.test.ts`，6 项）及端到端像素回归（`tests/e2e/math-highlight.spec.ts`，3 项）；以及选区叠色修复（`selection-overlap.spec.ts`，6 项）、基础文献库搜索/首屏 UI 改造（`workspace-ui.spec.ts`，2 项）与 26 项选区回归（含 200% DPR2 分式案例）。
2. **本次合入的稳定性修复**：
   - [window.ts](../src/main/window.ts)：`installSessionSecurity()` 中 `onBeforeRequest` 对 `new URL(details.url)` 增加 `try/catch` 防护，格式非法 URL 安全取消请求而不是抛出异常。
   - [useReaderPersistence.ts](../src/renderer/src/features/reader/useReaderPersistence.ts) 与 [PdfViewer.tsx](../src/renderer/src/features/reader/PdfViewer.tsx)：将 `useReaderPersistence` 的防抖 `useEffect` 依赖收敛到原始字段 `[documentId, pageNumber, scale, flush]`，并在 `flush()` 内生成 `updatedAt`；同时在 `PdfViewer.tsx` 使用 `useMemo` 稳定传入对象，防止 `setTextStatus` 等无关重渲染反复重置 450ms 防抖计时器。
3. **实际验证结果（均在当前 worktree 实跑，0 跳过 / 0 重试）**：
   - `pnpm typecheck` / `pnpm lint`：全部通过（退出 0）。
   - `pnpm test`：6 个测试文件 **65/65 通过**（含 `selection-bridges.test.ts` 6 项、`pdf-geometry.test.ts` 22 项、`library.test.ts` 16 项、`library-robustness.test.ts` 16 项、`reader-state-writer.test.ts` 3 项、`schemas.test.ts` 2 项）。
   - `pnpm dev` + `scripts/dev-smoke.ts`：通过（真实窗口、React HMR 保持上下文、无 `pageerror`）。
   - `pnpm rebuild:electron`：通过（`electron: 44.7.2`, `napi: 10`, `sqlite: 3.53.4`）。
   - `pnpm build` 与 `pnpm test:e2e`（源码 `out/main/index.js`）：**57/57 通过**（含 T01 安全/启动、T02 导入/去重/持久化、T03 阅读/600 页/混合尺寸/DPI/UI 2 项/选区重叠 6 项/公式连续性 3 项/选区回归 26 项）。
   - `pnpm dist:win` 与打包 `.exe` 实测（`release/win-unpacked/PaperFlow.exe`）：**57/57 通过**（含此前 10 月打包曾失败的 `PFV selection fraction page1-200pct-dpr2`）。
   - 产物一致性与许可证核验：`out/` 与 `app.asar` 中 **209/209** 文件逐字节一致，Worker 随包，无 QuickJS 或多余原生 Canvas 运行时包；`resources/licenses/manifest.json` **41/41** 份许可证 SHA-256 一致；两份 `.exe` Authenticode 均为 `NotSigned`。
4. **未验证与保留边界**：NSIS 安装包未在本次重新运行静默装卸脚本；未验证 150%/旋转的跨两行公式连贯性、forced-colors 模式、跨页公式高亮、真实用户 PDF 文献、多物理显示器迁移、物理磁盘满/断电及字体源码公开分发渠道。

## 2026-11-22 符号/宽下标/连续上下行选区连贯修复（Swarm 协作）

针对用户反馈的真实选区截图问题（字体/变量切换处竖向白缝、宽下标 $\bigoplus_{A,B,C,D,E}$ 左右空白、行内居中省略号与右邻下标 $\bigoplus_A \cdots \bigoplus_E$ 断白、连续上下行及独立公式行上下留白），采用 `/swarm` 多角色协同完成根因修复、原创合成回归构造与全量验证：

1. **核心修复（`src/renderer/src/features/reader/`）**：
   - `selection-highlight.ts` 与 `selection-bridges.ts`：移除 `\p{Sm}` 前置门控与 `math`-only 过滤，使字体切换普通正文与连续普通行同样参与补间；扩展 `mathSymbol` 至中点与省略点字符（`\u00b7\u2026\u22c5\u22ef`），允许 ≤3 个纯数学符号连续运行按真实字形 ink 裁剪多余空白；仍通过同一 SVG `<path>` (`fill-opacity: 0.36`) 绘制，不改动 DOM `Selection` 或 `Ctrl+C` 复制文本，不产生叠色变深。
   - 行内对齐与宽/右邻角标归并（`selection-bridges.ts`）：修正 `alignLargeOperators` 与 `alignCenteredInlineRuns`，防止大运算符吞并正常上/下标及空格导致行带缩为小字号（曾引发 `math-highlight` 150% `subscript-to-operator` 回退），并在 `buildLineFragments` 计算主体中位字号时排除已重对齐运行；在横向分组前先行匹配堆叠宽下标/上标（含宽于宿主运算符的 `A,B,C,D,E`）及右邻下标（如 `⊕_A`、`⊕_E`），将宿主的水平范围扩展为与附属角标的并集后重新合并相邻段。
   - 双向纵向行间补间：支持普通连续行间（`baselineDiff <= 2.3*em`、`bandGap <= 1.0*em`）及独立公式行上/下方正文双向水平交集纵向连接（`baselineDiff <= 4.2*em`、`visualGap <= 1.95*em`、`bandGap <= 2.6*em`），同时严格保留双栏宽缝、行末空白、未选文本与段落大间距留白。
2. **新增原创合成回归与单测**：
   - 单元测试 `tests/unit/selection-bridges.test.ts` 扩充至 **11 项**（含普通字体切换段落、宽下标、行内 `⊕_A ··· ⊕_E`、独立公式双向行距及大运算符防吞并角标用例，另有负向宽栏缝与大段间距用例）。
   - 生成器 `scripts/verification/generate-selection-continuity-fixture.ts` 产出一页原创合成回归 PDF `tests/fixtures/verification/selection-continuity/selection-continuity-regression.pdf`（`4425` 字节，SHA-256 `4c686458a8ceb11f00a5657e20434134120fa48d8402c2d677486c1d87c89a04`，经 Node PDF.js 6.4.299 提取与流隔离审计）。
   - E2E 用例 `tests/e2e/selection-continuity.spec.ts` 新增 **4 项**（100% 与 150% DPR 1 下的 5 行连续拖选及无 `\p{Sm}` 前两行正文拖选，逐像素核验 25 个连接窗 ≥95% 单次纯蓝、7 个守卫窗 ≥95% 留白、字形 ink 保留 ≥90% 与完整 `Control+C` 字符序列）。
3. **本轮发现并修复的历史/中间失败**：
   - 阶段 1 初次测试（39 项 E2E 中 36 过 3 败）：(a) `math-highlight.spec.ts` 150% 仅选公式在 `subscript-to-operator` 实测 `blueFraction = 0.5`，原因为 `alignCenteredInlineRuns` 将 `12pt` 上/下标与空格重对齐到大运算符 `⊕`，拉低中位字号使行带退化为 `12pt` 上标高度；(b) `selection-continuity.spec.ts` 100% 两项在 `r1-gap-1` 报 `script-precondition` 列数不足（`3pt` / `2.8pt` 缝隙受抗锯齿影响仅余 1 个纯白列，但连接窗 `blueFraction = 1.0`）。分别由 `selection-dev` 与 `fixture-dev` 修复并将横向小缝放宽至 `4.2–4.5pt`（仍远小于 `1.25*em=15pt`）后重测全过。
4. **最终实测结果（当前版本，0 跳过 / 0 重试）**：
   - 静态与单元测试：`pnpm typecheck` / `pnpm lint` 退出 0；`pnpm test` **6 个文件 70/70 通过**（含 `selection-bridges.test.ts` **11/11**）。
   - 源码构建与 E2E（`pnpm build` → `out/main/index.js`）：**61/61 通过**（含 `selection-continuity.spec.ts` 4/4、`math-highlight.spec.ts` 3/3、`selection-overlap.spec.ts` 6/6、`selection-verification.spec.ts` 26/26 等全部 11 个 spec 文件），并对 100% 5 行连选截图完成人工与脚本双核验。
   - Windows 打包与实机 `.exe` E2E（`pnpm dist:win` → `release/win-unpacked/PaperFlow.exe`）：**61/61 通过**。
   - 产物一致性与许可校验：`out/` 与 `release/win-unpacked/resources/app.asar` 中 **209/209** 文件逐字节一致，Worker 随包，无 QuickJS 或多余 Canvas 原生依赖；`resources/licenses/manifest.json` 40 份组件许可证与 1 份脚手架许可证（共 **41/41**）SHA-256 一致；`PaperFlow.exe` 与 NSIS 安装包 Authenticode 均为 `NotSigned`。注：`pnpm dev` 热更新与 `pnpm rebuild:electron` 均已于本工作区先前通过验证且本轮未改动主进程、原生依赖或构建配置。
5. **仍未验证的边界**：未读取或直接测试用户原始论文 PDF 文件；未重新运行 NSIS 静默安装/卸载实机脚本；直角旋转页上的跨多行连续公式、跨页选区连接、Windows 高对比度（forced-colors）模式、多物理显示器 DPI 迁移、物理磁盘满/断电及 Liberation 1.07.4 字体源码公开分发渠道仍未验证。

## 2026-11-22 纯本地阅读器体验、文献库管理与选区边界加固

在完成上述选区连贯修复并合入 `main`（基线 `ecb90f3`）后，继续在当前 worktree `init_paperflow_desktop` 内以 Antigravity Swarm 协同推进纯本地科研阅读器完善，保持 T01–T03 安全与完全离线约束（仍无 LLM、云服务、OCR、Python 翻译依赖或自动发布）：

1. **三路并行功能实现与边界加固**：
   - **本地文献库管理（`library-dev`）**：`PaperFlowAPI` / `CHANNELS` 扩展至 9 个方法（新增 `importPdfBytes`、`renameDocument`、`deleteDocument`），严格经 `Zod` 校验且不向渲染进程暴露本地路径；`App.tsx` `.workspace` 阻止默认文件跳转并呈现拖拽导入覆盖层（`释放以导入 PDF 文献`）；`DocumentService` 共用 `commitPdfBytes()`、实现基于 UUID/非符号链接/`realpath` 检查的安全删除（外键 `ON DELETE CASCADE` 清理 `reader_state`）、逐文件详细中文失败提示与 `关闭提示`，以及启动建窗前 `cleanupOrphanFiles()` 自动回收孤立 `<uuid>.pdf` / `.<uuid>.tmp`。
   - **阅读器核心体验（`reader-dev`）**：新增目录书签抽屉（`pdf-outline.ts`、`PdfOutline.tsx`，仅解析文档内 `getDestination` + `getPageIndex`，忽略纯外部 `item.url`，空目录显示“此 PDF 未包含目录书签”）；新增 `Ctrl+F` 取消式惰性全文搜索（`pdf-search.ts`、`PdfSearchBar.tsx`，按页惰性缓存 `getTextContent()` 不触发离屏 Canvas，支持区分大小写、`Enter`/`Shift+Enter`/`Escape` 与 `.pdf-highlight-layer` 命中定位）；支持 `.pdf-scroll` `Ctrl+滚轮`缩放及 `.reader-panel` 快捷键（`Ctrl+=`/`-`/`0`、`ArrowLeft`/`ArrowRight`/`PageUp`/`PageDown`/`Home`/`End`）；新增本地白边裁剪阅读（`margin-crop.ts`、`裁剪白边` 联动 `适合宽度` 重算且保持 `PageViewport` 与 `attachSelectionHighlight` 精准对齐）；顶部标题栏适配自定义重命名标题展示。
   - **选区边界加固（`selection-hardener`）**：扩展 `selection-bridges.ts` 仿射投影工具（`composeAffine`、`displayScaleForViewport`、`projectVisualRun`、`viewportToDisplayRect`、`displayToViewportRect`），在 0°/90°/180°/270° 旋转、`CropBox` 与 `UserUnit` 下将运行段映射至未缩放视觉显示空间；`selection-highlight.ts` 保留 `attachSelectionHighlight` 7 参签名，强化 `selectedPart` 的 `comparePoint` 叶节点守卫并支持跨页连选统一 `.pdf-selection-shape` SVG 高亮；新增 `forced-colors.css` 在 `@media (forced-colors: active)` 下以 `forced-color-adjust: none` 保留字形墨迹清晰度并增强列表/搜索/按钮可读性。
2. **新增原创合成素材与自动化验证**：
   - 生成三页原创合成阅读器 UX PDF [reader-ux-fixture.pdf](../tests/fixtures/verification/reader-ux/reader-ux-fixture.pdf)（`5685` 字节，SHA-256 `01c9a16c7aa163bea91a9023165022df7623362c1c029ea94a7fb304989a1221`，≥135pt 白边、嵌套 3+3 目录、6/3 处 `QUANTUM_BENCHMARK`）与三页原创合成边界 PDF [selection-boundary-fixture.pdf](../tests/fixtures/verification/selection-boundary/selection-boundary-fixture.pdf)（`4819` 字节，SHA-256 `be9d23bd2b80e2663e1a75f5849dda2d2ac8464ee40d9b766d4ce7f217c35a73`，页 1–2 跨页连选 + 页 3 90° 旋转多行公式 `⊕_{A,B,C,D,E}`），经 `pdfjs-dist` 6.4.299 审计。
   - 新增单测 `tests/unit/reader-ux.test.ts`（8 项）、扩展 `selection-bridges.test.ts` 至 14 项及 `schemas.test.ts`/`library.test.ts`（单测共 **7 个文件 89 项**）；新增端到端 spec `tests/e2e/library-management.spec.ts`（4 项）、`tests/e2e/reader-ux.spec.ts`（1 项）及 `tests/e2e/selection-boundary.spec.ts`（3 项），全套 E2E 共 **69 项**。
3. **本轮排查与修复的问题**：
   - `tests/e2e/bootstrap.spec.ts:9` 硬编码 6 个旧 IPC 方法断言，由主控同步更新为 9 个已排序业务 API 名称。
   - `tests/e2e/library-management.spec.ts` 拖拽导入断言初版检查 `BrowserWindow.getAllWindows()[0]`（后续改为 `find(w => w.isVisible())`），因紧随 drop 触发的隐藏沙盒校验窗口尚未 `loadURL` 提交且主窗体在无头测试启动期 `isVisible()` 可能为 `false` 导致两次失败；改为校验存在标题为 `PaperFlow` 且 URL 为 `app://bundle/index.html` 的主窗口并结合 `page.url()` 与导入完成后单一窗口 `expect.poll` 后通过。
   - 测试汇总时 `qa-verifier` 发现首次并行阶段的构建结果尚未收尾，清理 `out/` 重建并以 `--workers=1 --retries=0` 独立重新运行全量源码与打包 E2E，得到无污染的连续全绿结果。
4. **最终实测结果（`--workers=1 --retries=0`，0 失败 / 0 跳过 / 0 重试）**：
   - 静态与单元测试：`pnpm typecheck`、`pnpm lint` 全部退出 0；`pnpm test` **7 个文件 89/89 通过**。
   - 生产构建与 Preload 检查：`pnpm build` 通过，`out/preload/index.js`（25 行，1.27 kB）与 `out/preload/validation.js`（8 行，0.32 kB）确认为仅 `require("electron")` 的单文件 CJS（已在打包后复验）。
   - 源码与打包实机 E2E：源码构建 E2E **69/69 通过**；`pnpm dist:win`（`--publish never`）打包后对 `release/win-unpacked/PaperFlow.exe` 执行全套 E2E **69/69 通过**；已人工视觉审阅目录+检索+白边裁剪截图与 90° 旋转多行公式连选截图。
   - 产物一致性与许可校验：`out/` 与 `app.asar` 中 **209/209** 构建文件逐字节一致，`resources/licenses/manifest.json` **41/41** 份许可证 SHA-256 在磁盘与 `app.asar` 内完全一致；两份 `.exe` Authenticode 均为 `NotSigned`。注：`pnpm dev` 热更新、`pnpm rebuild:electron` 与 NSIS 静默装卸脚本本轮未重复执行。
5. **未验证与保留边界**：真实用户论文 PDF 未读取测试；180°/270° 旋转页面公式仅由单测几何投影验证，未单独做 E2E 像素验收；`forced-colors` 仅在 Playwright/Chromium 模拟条件下验收，未覆盖真实 Windows 高对比度系统切换、多物理显示器 DPI 迁移、物理磁盘满/断电、600+ 页 DOM 总体内存上限及 Liberation 1.07.4 字体源码公开分发渠道。

## 2026-11-23 高对比度选区描边修复、跨页取舍与 Linux x64 跨平台构建

基于用户真机论文验证反馈与 Linux 运行需求，完成以下修改与验证：

1. **高对比度选区交叉线修复与跨页取舍**：
   - **选区描边根因修复**：用户在 Windows 真机切换高对比度主题时，[forced-colors.css](../src/renderer/src/features/reader/forced-colors.css) 对 `.pdf-selection-shape` 设置的 `stroke: Highlight; stroke-width: 1px;` 会在单一合并 SVG `<path>` 内部每个重叠字符框/补间矩形周围描出边线，形成网状交叉线。现已改为 `stroke: none;` 仅保留 `fill: Highlight; fill-opacity: 0.36;`，并在 [selection-boundary.spec.ts](../tests/e2e/selection-boundary.spec.ts) 新增 `shapeStroke === 'none'` 断言及人工视觉截图核验（无交叉描边、字形清晰）。
   - **跨页选中页眉/页尾取舍**：按用户确认采用方案 A，保留标准 PDF/浏览器线性 DOM 选区行为，不过滤未标注 `/Artifact` 的页眉/页脚文本节点，避免误伤正文顶行、公式或脚注。
2. **Linux x64 便携包配置与跨平台打包（`dist:linux`）**：
   - 在 [electron-builder.yml](../electron-builder.yml) 新增 `linux` 目标（`executableName: paperflow`，`target: tar.gz`，`arch: [x64]`）与 `package.json` 的 `pnpm dist:linux` 脚本。
   - 新增 [scripts/dist-linux.ts](../scripts/dist-linux.ts)：从可信镜像下载并按 `node_modules/electron/checksums.json` SHA-256（`777b26a64aee3d185acb9f93c04782bb51eae7c2c61c793963ef24374e5a1539`）校验 `electron-v44.7.2-linux-x64.zip`，核查 ZIP 中央目录确认无 POSIX 符号链接损坏风险；调用 `electron-builder --linux tar.gz --x64 --publish never` 后在 Windows 下按 USTAR/PAX 规范修正目录与 ELF/`*.so*`/`*.node`/ZIP 可执行文件 POSIX 权限为 `0755`、其余数据文件为 `0644` 并重算校验和，随后全量遍历 TAR 校验 `paperflow`、`chrome-sandbox`、`chrome_crashpad_handler` 与 `better-sqlite3/prebuilds/linux-x64.node` 的 ELF 魔数及权限。
3. **本轮实测与静态核验结果（`--workers=1 --retries=0`，0 失败 / 0 跳过 / 0 重试）**：
   - 静态与单元测试：`pnpm typecheck`、`pnpm lint` 退出 `0`；`pnpm test` **7 个文件 89/89 通过**。
   - Windows 源码与打包 E2E：`pnpm build` 退出 `0`（Preload 单文件 CJS 仅 `require("electron")`）；源码构建 E2E **69/69 通过**；`pnpm dist:win` 后打包版 `release/win-unpacked/PaperFlow.exe` 全套 E2E **69/69 通过**，Authenticode 仍为 `NotSigned`。
   - Linux 便携包静态审计：`pnpm dist:linux` 生成 `release/PaperFlow-0.1.0-linux-x64.tar.gz`（`141707524` 字节，SHA-256 `aeb93425620b0606de81165184fb39a154832dea1aabceefae7192768498e188`，顶层目录 `PaperFlow-0.1.0-linux-x64/`，共 171 项）；Windows 与 Linux 两份 `app.asar` 均为 `33412086` 字节且内容完全一致（`209/209` 构建文件逐字节匹配、`41/41` 份许可证 SHA-256 一致、包含本地 PDF.js Worker、无 QuickJS/多余 Canvas 原生包）。
4. **未验证与跨平台约束**：
   - 因本机为 Windows 且无 WSL/Docker，未在 Windows 上构建 `.deb` 或 `.AppImage`，**也未在真实 Linux 操作系统上启动运行 `paperflow` 或执行 Linux E2E**；Ubuntu 24.04+ 或开启 AppArmor 限制的发行版如遇沙盒提示，需保持安全配置不变并对 `chrome-sandbox` 设置 root SUID（或直接在 Linux 环境执行 `pnpm install --frozen-lockfile && pnpm build && pnpm exec electron-builder --linux deb AppImage --x64 --publish never`）。
   - 未重新运行 `pnpm dev` 热更新、`pnpm rebuild:electron` 与 NSIS 安装/卸载实机脚本；高对比度真机切换（修复后）亦待在虚拟机或真机复验。

## 2026-11-23 高对比度选区、Ubuntu 26.04.1 LTS 实机启动与窗口自适应修复

1. **高对比度选区与跨页规则确认**：
   - 跨页选区按用户确认的方案 A 保留标准 PDF / 浏览器线性 DOM 选区行为，不拦截上下页页眉/页尾。
   - [src/renderer/src/features/reader/forced-colors.css](../src/renderer/src/features/reader/forced-colors.css)：移除 `.pdf-page .pdf-page-surface > .pdf-selection-shape` 在 `forced-colors: active` 下的内部 `1px` `Highlight` 描边，改为 `stroke: none;`，消除连续选区内部的网格交叉线；已在 [tests/e2e/selection-boundary.spec.ts](../tests/e2e/selection-boundary.spec.ts) 增加 `shapeStroke` 断言，并由用户在 Windows 真实高对比度桌面环境复验确认无交叉内框线。
2. **Linux 实机启动、X11 启动包装与窗口自适应修复（保持沙盒与安全边界不变）**：
   - 在 Ubuntu 26.04.1 LTS（GNOME Wayland + VMware `vmwgfx`、`kernel.apparmor_restrict_unprivileged_userns = 1`）实机排查中确认：(a) 需确保 `chrome-sandbox` 具备 `root:root 4755` SUID 权限；(b) Electron Linux 主程序入口运行 JS 前即已初始化 Ozone/Zygote，因此 `src/main/index.ts` 中后置 `app.commandLine.appendSwitch` 不能解决 Wayland + `vmwgfx` 默认隐藏窗口不可见问题；(c) 早期固定的 `1080×680` / `1440×900` 尺寸在高缩放（如 `125%`）下的逻辑工作区接近或超过桌面可用高度时，窗口无法自由缩窄与最大化。
   - [scripts/linux-after-pack.mjs](../scripts/linux-after-pack.mjs) 与 [electron-builder.yml](../electron-builder.yml) / [scripts/dist-linux.ts](../scripts/dist-linux.ts)：通过 `afterPack` 钩子将包内二进制改名为 `paperflow.bin` 并生成 POSIX `/bin/sh` 包装脚本 `paperflow`（当 `$DISPLAY` 存在且未显式传入 `--ozone-platform*` 时默认附加 `--ozone-platform=x11`），由 `dist-linux.ts` 在 Windows 主机端统一校验 LF、USTAR/PAX 路径、`0755`/`0644` 权限及 `linux-x64.node` 等原生产物魔数；同时移除 `src/main/index.ts` 中失效的后置 Ozone switch。
   - [src/main/window.ts](../src/main/window.ts) 与 [src/renderer/src/assets/main.css](../src/renderer/src/assets/main.css)：保持 Windows 默认 `1440×900` 与最小 `1080×680` 不变；在 Linux 下基于 `screen.getPrimaryDisplay().workAreaSize` 动态计算初始宽高与最小宽高（`minWidth` 取 `640..1080`、初始宽度取 `workAreaSize.width * 0.92`，高度同理），显式设置 `resizable: true`、`maximizable: true` 并补充 400ms 幂等 `ready-to-show` 兜底；在 `main.css` 补充 `@media (max-width: 1120px)` 三栏紧凑布局（`212px minmax(0, 1fr) 212px`）。
3. **验证与未测边界（严格区分已测与未测）**：
   - **已实测通过**：`pnpm typecheck` / `pnpm lint`（退出 `0`）、`pnpm test`（**7 文件 89/89**）、`pnpm build`（Preload 单文件 CJS 仅 `require("electron")`）、Windows 源码构建 E2E（**69/69**，`--workers=1 --retries=0`）、`pnpm dist:win` 与打包版 `release/win-unpacked/PaperFlow.exe` 全套 E2E（**69/69**，`0` 残留进程）、双端 `app.asar` 与 `out/` `209/209` 及 `41/41` 许可证一致（含 `LICENSE`、`resources/THIRD-PARTY-NOTICES.txt`），`pnpm dist:linux` 静态审计 TAR `172` 项及 ELF/权限校验通过。
   - **实机验证记录**：在 Ubuntu 26.04.1 LTS 实机配置 `chrome-sandbox` 权限后，验证无参 `./paperflow` 自动以 `--ozone-platform=x11` 拉起可见窗口（`Map State: IsViewable`、`1130×632` DIP / `1411×790` X11 px，具备 `_NET_WM_ACTION_RESIZE` / `MAXIMIZE_HORZ` / `MAXIMIZE_VERT` 属性并完成程序化宽高调节）、拖拽导入与 PDF.js 渲染，并由用户实机鼠标拖拽窗口边框扩缩与最大化确认通过；Windows 高对比度选区效果已由用户在真实高对比度桌面环境确认通过。
   - **未复测项**：Linux 平台 69 项 Playwright 全套 E2E、本轮 `pnpm dev` HMR、`pnpm rebuild:electron` 与 Windows NSIS 静默安装/卸载实机脚本未重新运行。
