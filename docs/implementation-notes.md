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
