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
