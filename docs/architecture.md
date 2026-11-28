# Foliopair（原 PaperFlow）架构说明

> 更新注记（`v0.2.1`，2026-11-28）：界面与品牌已更名为 **Foliopair**。为兼容升级，沿用 `org.paperflow.desktop`、`appData/PaperFlow` 下的 `paperflow.sqlite`、ZIP 内的 `paperflow-backup.json` 和 `window.paperflow` 桥接契约。本文正文已于同日按 `v0.2.1` 源码整体同步：Preload 暴露 **67** 个冻结的 `window.paperflow` 成员（65 个 `invoke` 方法 + 2 个主进程事件订阅），SQLite `user_version = 7`、共 7 张业务表。该版本新增单/双栏分段翻译、跨页/跨批次翻译语境、自定义快捷键、按 Base URL 绑定凭据和本机 CLI 授权确认。

本说明记录 Foliopair 当前版本的进程与模块、安全边界、IPC 业务契约、本地存储与阅读器生命周期，并保留 T01–T08 沉淀的选区与坐标边界。构建、实机与打包验收以 `implementation-notes.md` 和 `verification/summary.md` 的实际命令和结果为准。

## 进程与模块

项目保持 electron-vite 的主进程、Preload、Renderer 三层入口。导入时另建一个隐藏、独立沙盒的校验窗口；PDF 解析不在拥有文件系统权限的主进程中执行；外部 AI 翻译、余额与学术检索请求仅通过主进程服务受控代理执行，渲染层保持零外网直连权限。

```mermaid
flowchart LR
  UI[React 文献库 / 阅读 / 译文 / AI 伴读 UI] --> API[window.paperflow 67 个冻结成员]
  API --> IPC[主进程：来源检查 + Zod]
  IPC --> DOC[DocumentService：有界快照/字节导入/哈希/复制/删除/清理]
  IPC --> TRN[TranslationService：safeStorage 密钥加密 + API/CLI 代理 + 用量/余额]
  IPC --> LIT[LiteratureSearchService：OpenAlex / arXiv 受控检索与下载]
  IPC --> BAK[BackupService：ZIP 备份 / 目录导入导出 / BibTeX]
  IPC --> DB[LibraryDatabase：参数绑定 SQLite v7]
  DOC --> VALID[隐藏沙盒校验窗口]
  VALID --> VW[本地 PDF.js Worker：逐页操作列表校验]
  TRN --> EXT[OpenAI 兼容 API / 本机 AI CLI]
  LIT --> EXT
  IPC --> EVT[translation:progress / ai-chat:stream]
  EVT --> UI
  UI --> READER[PdfViewer：目录/检索/白边裁剪/导航/缩放/进度/原页快照]
  READER --> PAGE[PdfPage：Canvas + TextLayer + 选区与检索高亮]
  READER --> RW[本地 PDF.js Worker]
```

| 目录/文件 | 责任 |
| --- | --- |
| `src/main/index.ts` | 应用启动与装配：保留内部名称 `PaperFlow` 与 AppUserModelId `org.paperflow.desktop`；解析 `--user-data-dir`；依次创建 `LibraryDatabase`、`DocumentService`、`TranslationService`（注入系统授权弹窗 `authorizeCli`）、`BackupService` 与 `LiteratureSearchService`；启动时清理孤立副本（`cleanupOrphanFiles`）；注册 IPC；退出前取消在途翻译与 AI 任务，并在 `will-quit` 关闭数据库 |
| `src/main/window.ts` | 按工作区自适应的主窗口（最大 1440×900，最小尺寸随屏幕在 640×440 至 1080×680 间取值）、融合式标题栏叠加层与三套主题色（`applyWindowThemeChrome`）、精简应用菜单、会话级安全策略（权限请求一律拒绝、请求来源白名单、开发态 CSP 响应头）与关闭前进度刷新 |
| `src/main/services/app-protocol.ts` | 注册 `app://`、构建资源清单与 CSP |
| `src/main/ipc/index.ts` | 65 个 `ipcMain.handle` 业务 handler；逐一校验受信窗口、`mainFrame`、精确 URL 与 Zod 入参；翻译、学术检索与备份 handler 按服务装配情况条件注册 |
| `src/main/services/document-service.ts` | 文件快照/字节导入、扩展名/头/大小检查、SHA-256、去重、临时文件、库副本、删除与孤立文件清理 |
| `src/main/services/database.ts` | `user_version = 7` 七张业务表（含 v0→v7 非破坏升级）、设置与译文缓存持久化、分类层级校验、跨库检索、级联删除与参数绑定 SQL |
| `src/main/services/pdf-validation.ts` | 隐藏校验窗口、20 秒超时、专用返回信道与资源销毁 |
| `src/main/services/translation-service.ts` | 翻译、划句解释、AI 对话与学术技能的统一引擎入口：OpenAI 兼容 HTTP（`fetch`）与本机 AI CLI（Codex / Gemini 预设及自定义 CLI，如 Claude），批处理解析与公式占位符校验、SQLite 块级缓存与单块回退、取消与进程树清理 |
| `src/main/services/translation-credentials.ts` | API Key 按完整 Base URL 绑定的 `safeStorage` 加密凭据库（`translation.openaiCredentials.v2`，迁移旧 `translation.openaiApiKey.v1`），仅向渲染层返回 `hasApiKey` / `apiKeyPreview` |
| `src/main/services/translation-cli-authorization.ts` | 本机 CLI 程序与参数的系统授权确认（`translation.cliAuthorizations.v1`） |
| `src/main/services/openai-stream.ts` | OpenAI 兼容流式 / JSON 响应读取与 `usage` 字段归一化 |
| `src/main/services/usage-service.ts` | 今日 / 累计 Token 与缓存命中台账（`usage.ledger.v1`、`usage.preferences.v1`）及 DeepSeek 余额查询 |
| `src/main/services/translation-export.ts` | 中英对照 / 纯中文 Markdown 导出，以及在隔离隐藏窗口中渲染排版 PDF |
| `src/main/services/academic-skills.ts` · `custom-skills.ts` | 内置学术技能的提示词构建；自定义技能读写（`ai.customSkills.v1`） |
| `src/main/services/pptx-builder.ts` | 原生 `.pptx` 生成、幻灯片 JSON 解析与 Markdown 预览格式化 |
| `src/main/services/literature-search-service.ts` · `literature-http.ts` | OpenAlex / arXiv 受控检索、摘要 AI 速览、PDF 校验下载入库与 DOI 元数据补全，含 URL 与连接地址校验 |
| `src/main/services/backup-service.ts` · `zip-archive.ts` | 整库 `.zip` 备份/幂等恢复、目录结构导入、分类 PDF/批注导出与 BibTeX 生成；零外部依赖 PKZIP 引擎（CRC32、Zip-Slip 防护、体积/条目上限） |
| `src/main/services/research-profile.ts` | 科研向导画像（`research.profile.v1`）与分类专属词库 / 全局词库的有效翻译作用域合并 |
| `src/main/services/annotation-export.ts` | 批注 Markdown 格式化 |
| `src/preload/index.ts` | 仅暴露 67 个冻结的 `window.paperflow` 成员，没有原始 IPC、路径、密钥读取或 Node API |
| `src/preload/validation.ts` | 校验窗口专用一次性字节接收与结果报告，不暴露业务 API |
| `src/renderer/validation.ts` | 调用 PDF.js，逐页获取操作列表，报告页数/友好错误 |
| `src/renderer/src/App.tsx` | 工作区骨架：文献库侧栏折叠、标签页与多篇并排分栏、三视图切换、译文缓存预加载与多页状态协调、`.workspace` 文件拖拽导入 |
| `src/renderer/src/features/workspace/` | 顶栏（视图切换、引擎胶囊、科研向导入口）、标签页栏与用量提示层 |
| `src/renderer/src/features/library/` · `onboarding/` | 文献列表、多级分类树、批量整理、内联重命名、跨库检索、学术检索弹窗与首次科研向导 |
| `src/renderer/src/features/reader/` | PDF 生命周期、Canvas/TextLayer 与 `ImageBitmap` 底图快照回传、目录抽屉、惰性全文搜索、`Ctrl+滚轮`/快捷键、白边裁剪、多栏版面分析与底色采样、跨页/旋转连选 SVG、多篇分栏与 `forced-colors` 适配 |
| `src/renderer/src/features/translation/` | 原页底图 + 原位覆写译文层、逐句双向对齐（`sentence-alignment.ts`）、跨页/跨批上下文（`translation-context.ts`）、后台连续翻译、引擎设置弹窗、用量与余额展示、双向同步滚动（`scroll-sync.ts`、`useDualScrollSync.ts`） |
| `src/renderer/src/features/study/` | AI 对话悬浮窗/抽屉、划句伴读条、高亮批注抽屉、图表速览、引用弹窗、快捷键面板、学术技能与 `.pptx` 预览 |
| `src/shared/` | 跨进程契约（`PaperFlowAPI`、`CHANNELS`）、引用格式化与论文标题提炼（`citation.ts`）及 Zod 入参模型（含 HTTP(S) URL 与安全 CLI token 校验） |

不引入全局大型状态框架；React 状态按文献库、文档、单页与翻译设置分开。仍不引入 OCR、Python 翻译运行时或自动远程发布。

## 安全边界

主窗口与校验窗口均启用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`；不以关闭 Chromium 安全机制修复加载。译文排版 PDF 导出所用的隐藏窗口同样启用上述配置并关闭 JavaScript，运行于独立 `session` 分区，仅放行导出 HTML 自身的 `file://` URL，渲染完成后立即销毁并清理临时目录。Preload 使用 electron-vite 独立入口构建为 CJS 单文件，依赖完整打包，运行时只依赖沙盒允许的 Electron 模块。

生产入口为 `app://bundle/index.html`，校验器为 `app://bundle/validation.html`。协议在 ready 前注册为 standard/secure，支持本地 fetch，不设置 `bypassCSP`。handler 只服务启动时枚举的构建资源，校验 host、方法、路径和查询串；文献库与任意磁盘文件不在资源清单中。开发入口只接受固定 `http://127.0.0.1:5173`，生产忽略开发服务器环境变量。

网络请求按来源白名单拦截：渲染层在生产环境仅允许应用资源与内部 data/blob/devtools 用途（开发另允许固定 Vite HTTP/WebSocket），**保持无外部翻译 API 直连权限**。CSP 默认拒绝，脚本与 Worker 限同源；PDF 字体需要本地 blob/data，PDF.js 的位置样式需要行内 style，WASM 解码使用 `wasm-unsafe-eval`。不启用普通 JavaScript `unsafe-eval`。页面导航、子 frame 导航、弹窗、webview 与系统权限请求均拒绝。PDF 只渲染页面与文字，不建立链接/脚本执行层，不解析 PDF 内部链接；主进程仅在渲染层显式调用 `openExternalUrl` 且通过公网 HTTPS 校验后执行 `shell.openExternal`。

业务 handler 每次校验调用者 `webContents` 身份、`senderFrame === mainFrame` 和精确受信 URL，而非 URL 前缀。参数由 Zod 校验，校验失败统一返回「请求参数无效。」；renderer 无法指定任意 IPC channel 或任意系统 Shell 命令。除用户在系统文件/目录对话框中亲手选定的路径（`pickCliExecutable` 返回的可执行文件路径、目录导入/导出的目录路径）外，渲染层不获得本机路径，也不获得库内存储文件名与原始 API 密钥。

**OpenAI 兼容 HTTP 翻译（限定 `http:`/`https:` URL）与本机 AI CLI 进程唤醒均由主进程 `TranslationService` 受控执行**：CLI 命令须通过纯文件系统 `PATH` 解析（`resolveCliExecutable`）并结合 Zod 严格拦截 Shell 注入元字符（`[&|<>^%!\r\n`$;]`），提示词通过 `stdin` 管道传入空隔离临时目录并在超时/取消时终止进程树。凭据与外部访问的约束如下：

- **API Key 按完整 Base URL 绑定**（`translation-credentials.ts`）：密钥经 Electron `safeStorage` 加密存于 `app_settings` 的 `translation.openaiCredentials.v2`，仅向前端暴露 `hasApiKey` 与 `apiKeyPreview`。保存设置时省略 `apiKey` 只能复用绑定至同一 Base URL 的密钥；更换地址后旧密钥不可见也不可用，需重新录入。旧版未绑定地址的 `translation.openaiApiKey.v1` 仅用于迁移。
- **本机 CLI 系统授权**（`translation-cli-authorization.ts`）：首次使用某程序或变更程序 / 参数时，`saveTranslationSettings` 与 `testTranslationConnection` 先经 `authorizeCli` 弹出系统对话框列明程序、参数与最长运行时间；用户拒绝则整个请求失败。已确认的程序与参数记录于 `translation.cliAuthorizations.v1`。
- **主进程学术请求**。OpenAlex 和 arXiv 检索、OpenAlex 引用补全及 PDF 下载使用受控 GET，最多跟随五次重定向。请求和重定向逐跳校验 HTTPS、主机名和 DNS 解析结果，连接只使用已校验的公网 IPv4 或 IPv6 地址，并保留原主机的 TLS 校验。拒绝内嵌凭据和非公网地址。自动化测试可显式设置 `PAPERFLOW_TEST_LITERATURE_BASE`，仅放行对应环回服务的同源请求。摘要速览使用已配置的翻译引擎。
- **在浏览器中打开链接**。`openExternalUrl` 在将初始 HTTPS 地址交给系统浏览器前校验其 DNS 解析结果。浏览器后续的 DNS 解析、连接和重定向由浏览器自行管理。
- **备份恢复**（`zip-archive.ts`）：写出与读入共用 512 MiB 压缩包、5,000 个条目与 1 GiB 解包总量的硬上限，读入时校验 CRC32 并做 Zip-Slip 路径防护；备份包刻意不含加密 API Key。

专用校验结果 handler 只接受对应隐藏窗口与精确校验 URL，随后校验返回结构。

这些措施缩小权限边界，不意味着对所有恶意 PDF、Chromium 漏洞或资源耗尽已作形式化安全证明。依赖升级时需重新验证上述安全边界。

## IPC 业务契约

`src/shared/contracts.ts` 的 `PaperFlowAPI` 通过 `contextBridge` 暴露 67 个冻结成员：65 个 `ipcRenderer.invoke` 方法与 2 个主进程事件订阅（`onTranslationProgress`、`onAiChatStream`）。PDF 字节是 `Uint8Array`。翻译、划句解释与 AI 请求（发送消息 / 运行技能 / 取消）handler 仅在 `TranslationService` 已装配时注册，对话历史与自定义技能读写不依赖该服务；备份导出/恢复、目录导入导出与 `.bib` 导出仅在 `BackupService` 已装配时注册；学术检索类 handler 仅在 `LiteratureSearchService` 已装配时注册。当前 `main/index.ts` 启动时三者均传入。

### 文献

| API | channel | 校验与行为 |
| --- | --- | --- |
| `importPdf()` | `document:import` | 无参数；系统文件框支持多选，取消返回 `{ canceled: true, results: [], failures: [] }`；逐个导入，返回 `results`（`imported` / `existing` 与公开记录）及逐文件失败原因 `failures` |
| `importPdfBytes(input)` | `document:import-bytes` | `{ originalFilename, bytes }`；1–260 字符文件名（`DocumentService` 另行拒绝路径分隔符、控制字符与非 `.pdf` 扩展名）、IPC 有界 `Uint8Array`（≤105 MiB 上限，实际 PDF 上限仍为 100 MiB）与 PDF 头，供拖拽导入复用同一提交与沙盒校验路径 |
| `listDocuments()` | `document:list` | 无参数；按导入时间倒序返回公开记录 |
| `readPdfBytes(documentId)` | `document:read` | UUID；只读已入库文献，验证库副本和哈希 |
| `updatePageCount(documentId, pageCount)` | `document:page-count` | UUID、1–1,000,000 的整数；更新页数并约束已有进度 |
| `renameDocument(documentId, displayTitle)` | `document:rename` | UUID 与 1–200 字符去首尾空白且不含控制字符的显示标题；返回更新后的公开记录 |
| `updateDocumentMeta(input)` | `document:update-meta` | `{ documentId, starred?, tags?, folderId?, readingStatus? }`；至多 20 个、每个 ≤32 字符的标签（忽略大小写去重），阅读状态为 `unread` / `reading` / `done`，目标分类须存在 |
| `deleteDocument(documentId)` | `document:delete` | UUID；先中止该文献在途翻译，再删除 SQLite 记录（外键级联清除阅读状态、译文缓存与批注，并删除 `doc.summary.v1:<id>` 摘要），最后校验 `storedFilename === <id>.pdf`、非符号链接且 `realpath` 在 `library/` 内后移除副本 |
| `resetLibrary()` | `library:reset` | 无参数；取消全部在途翻译后清空文献、分类文件夹、批注、译文缓存、对话记录、阅读状态与文档摘要，保留 `app_settings` 中的引擎与科研配置，随后清理孤立副本 |
| `searchLibrary(query)` | `library:search` | 1–200 字符关键词；参数绑定 `LIKE … ESCAPE` 检索标题、文件名、标签、批注与已缓存译文，最多返回 40 条命中 |

### 分类文件夹

| API | channel | 校验与行为 |
| --- | --- | --- |
| `listFolders()` | `folder:list` | 无参数；按创建时间返回全部分类文件夹 |
| `createFolder(input)` | `folder:create` | 名称 1–64 字符；可选上级分类、学科门类、学科语境（≤300 字符）、术语表（≤200 条）与是否继承全局词库；嵌套层级最多 4 级 |
| `updateFolder(input)` | `folder:update` | 同上的可选字段；禁止设为自身子分类或移入自身后代，移动后子树高度不得使层级超过 4 级 |
| `deleteFolder(folderId)` | `folder:delete` | UUID；删除该分类及其全部子分类（`ON DELETE CASCADE`），所属文献回到未分类 |
| `importFolder(input?)` | `folder:import-dir` | 可选 `parentFolderId`（须存在）；系统目录框选择后递归导入，并按目录结构映射为分类文件夹 |
| `exportFolderPdfs(input)` | `folder:export-pdfs` | `scope` 为 `all` / `unassigned` / `folder`（后者必须且仅此时提供 `folderId`），可选 `includeAnnotations`；导出 PDF 与批注 Markdown 到所选目录 |

### 阅读状态

| API | channel | 校验与行为 |
| --- | --- | --- |
| `getReaderState(documentId)` | `reader:get` | UUID 且文献存在；返回状态或 null |
| `saveReaderState(state)` | `reader:save` | 严格对象；UUID、有效页码、0.5–3 的有限倍率、ISO 时间；页码不得超过已知页数，数据库使用主进程时间 |
| `listReaderProgress()` | `reader:list-progress` | 无参数；返回 `documentId → page_number` 映射 |

### 翻译设置、凭据与用量

| API | channel | 校验与行为 |
| --- | --- | --- |
| `getTranslationSettings()` | `translation:get-settings` | 无参数；返回供应商类型、目标语言、术语表、Base URL/模型、`hasApiKey`/`apiKeyPreview`（永不返回明文密钥）与 CLI 配置（含 `authorized`） |
| `saveTranslationSettings(input)` | `translation:save-settings` | 严格 Zod 校验：`http:`/`https:` Base URL（8–512 字符）、禁止元字符的 CLI 命令与参数元组（≤24 个）、`timeoutSec`（10–300）、术语表 ≤200 条；CLI 供应商须先通过系统授权弹窗；`apiKey` 省略时仅可复用绑定至同一 Base URL 的密钥，空字符串清除，非空则加密保存 |
| `getDocumentTranslationScope(documentId)` | `translation:get-scope` | UUID；返回所在分类、是否继承全局词库、分类/全局/有效术语表数量与作用域指纹 |
| `detectLocalAiClients()` | `translation:detect-local-clients` | 无参数；探测本机 Codex / Gemini CLI 是否可直接调用 |
| `pickCliExecutable()` | `translation:pick-cli-executable` | 无参数；系统文件框选择可执行文件，路径 ≤512 字符且不含元字符；取消返回 `{ canceled: true, filePath: null }` |
| `testTranslationConnection(draft?)` | `translation:test` | 无参或传入完整设置草稿；发送最小测试消息或探活 CLI 可执行路径，返回耗时、样本输出或错误与解析路径；CLI 草稿须先授权 |
| `getProviderBalance(draft?)` | `translation:get-balance` | 无参或设置草稿；返回服务商余额快照（仅展示服务端实测字段） |
| `getUsageSummary()` | `translation:get-usage` | 无参数；返回今日 / 累计 Token、请求数、已译块/页与缓存命中统计及偏好 |
| `saveUsagePreferences(input)` | `translation:save-usage-prefs` | 低余额阈值（0–100,000）、币种与可空的输入/输出参考单价 |
| `resetUsageStats(scope?)` | `translation:reset-usage` | 可选 `today` / `all`；清零对应台账并返回最新统计 |

### 译文缓存、翻译与导出

| API | channel | 校验与行为 |
| --- | --- | --- |
| `getPageTranslations(documentId, pageNumber)` | `translation:get-page` | UUID 与有效页码；按当前目标语言返回该页已缓存的 `TranslatedBlockRecord[]` |
| `listDocumentTranslations(documentId)` | `translation:list-document` | UUID；按页返回整篇已缓存译文 |
| `translatePage(input)` | `translation:translate-page` | UUID、页码、1–160 个待译块（`blockId`/`kind`/`sourceText`/`sourceHash`）、可选 `force` 与 `context`（文档摘要 ≤1200 字符、章节标题 ≤300 字符、至多 6 块前序上下文）；优先命中 `translation_cache`，按 ≤3800 字符 / ≤10 块分批调用翻译引擎、失败回退单块并持久化缓存，进度经 `translation:progress` 推送 |
| `onTranslationProgress(listener)` | `translation:progress` | 订阅主进程推送的 `{ documentId, pageNumber, items, completedCount, totalCount }`，返回取消订阅函数 |
| `cancelTranslation(documentId?)` | `translation:cancel` | 可选 UUID；中止全部或指定文献的在途 `AbortController` 请求与 CLI 子进程树 |
| `clearDocumentTranslations(documentId)` | `translation:clear-document` | UUID；清空指定文献的全部本地 SQLite 译文缓存记录 |
| `updateBlockTranslation(input)` | `translation:update-block` | UUID、页码、块 ID、源哈希与 1–24,000 字符译文；手工修订写回缓存 |
| `exportTranslationDocument(input)` | `translation:export-document` | UUID、标题、`bilingual-md` / `zh-md` / `zh-pdf` / `bilingual-pdf` 与至多 1000 页（每页 ≤200 块）；系统保存框后写出 Markdown，或在隔离隐藏窗口中渲染为 A4 PDF |
| `explainSelection(input)` | `translation:explain` | UUID、页码、≤4000 字符选中文本、可选 ≤6000 字符上下文与 `explain` / `formula` / `translate` 模式 |

### AI 对话与学术技能

| API | channel | 校验与行为 |
| --- | --- | --- |
| `listChatMessages(sessionKey)` | `ai-chat:list` | 会话标识（1–96 字符，仅字母、数字、`:`、`_`、`-`）；按时间返回消息记录 |
| `sendChatMessage(input)` | `ai-chat:send` | 可选 `requestId`、会话标识、≤6000 字符问题、`active` / `all-open` / `free` 上下文范围、可选引用与至多 6 篇上下文文献（含 ≤16,000 字符页面摘录）；流式增量经 `ai-chat:stream` 推送 |
| `runAiSkill(input)` | `ai-chat:run-skill` | 内置技能 `summary-focus` / `ppt-deck` / `peer-review` / `compare-matrix` 或 `custom`（必须提供 Prompt）；可返回幻灯片结构 |
| `onAiChatStream(listener)` | `ai-chat:stream` | 订阅 `{ requestId, sessionKey, delta, fullText }`，返回取消订阅函数 |
| `cancelAiChat(requestId?)` | `ai-chat:cancel` | 可选请求 ID；中止全部或指定 AI 任务 |
| `clearChatMessages(sessionKey)` | `ai-chat:clear` | 会话标识；清空该会话记录 |
| `listCustomAiSkills()` | `ai-chat:list-custom-skills` | 无参数；返回 `app_settings` 中的自定义技能 |
| `saveCustomAiSkill(input)` | `ai-chat:save-custom-skill` | 可选 UUID、名称 ≤60、说明 ≤160 与 Prompt ≤4000 字符；新建或更新后返回最新列表 |
| `deleteCustomAiSkill(id)` | `ai-chat:delete-custom-skill` | 技能 UUID；删除后返回最新列表 |
| `exportSlideDeckPptx(deck)` | `ai-chat:export-pptx` | 1–24 张幻灯片的结构描述（`cover` / `metrics` / `two-column` / `cards` / `closing`）；系统保存框后生成原生 `.pptx` |
| `exportMarkdownContent(suggestedName, markdown)` | `ai-chat:export-md` | 建议文件名 ≤120 字符与 ≤200,000 字符正文；系统保存框后写出 `.md` |

### 学术检索与引用

| API | channel | 校验与行为 |
| --- | --- | --- |
| `searchLiterature(input)` | `literature:search` | 搜索词（≤240 字符）或至少一个标签；可选 `relevance` / `citations` / `recent` 排序、仅开放获取、起始年份、1–25 条上限与 AI 扩展；检索 OpenAlex 与 arXiv |
| `importLiteraturePdf(input)` | `literature:import-pdf` | PDF 链接（≤1500 字符）、标题与可选标签 / 分类；主进程下载并校验后入库 |
| `summarizeLiteratureAbstract(input)` | `literature:summarize-abstract` | 标题（≤300 字符）与 ≤8000 字符摘要；返回 AI 速览 |
| `enrichCitationMetadata(input)` | `citation:enrich` | DOI 或标题至少一项；经 OpenAlex 补全并返回匹配来源与置信度 |
| `exportFolderBibtex(input)` | `citation:export-bib` | `scope` 为 `all` / `unassigned` / `folder`，可携带逐篇引用元数据覆盖；系统保存框后写出 `.bib`，无记录时直接返回取消 |

### 批注

| API | channel | 校验与行为 |
| --- | --- | --- |
| `listAnnotations(documentId)` | `annotation:list` | UUID；按页码与创建时间返回批注 |
| `createAnnotation(input)` | `annotation:create` | UUID、页码、`yellow` / `green` / `blue` / `pink` 之一、≤4000 字符摘录、≤8000 字符笔记、至多 200 个定位矩形与可选句子 ID；无定位矩形时必须有笔记正文 |
| `updateAnnotation(input)` | `annotation:update` | 批注 UUID 与可选颜色 / 笔记 |
| `deleteAnnotation(annotationId)` | `annotation:delete` | 批注 UUID |
| `exportAnnotationsMarkdown(documentId)` | `annotation:export-md` | UUID；系统保存框后写出批注 Markdown |

### 备份、剪贴板、科研向导与窗口主题

| API | channel | 校验与行为 |
| --- | --- | --- |
| `exportBackup()` | `backup:export` | 无参数；系统保存框后将整库打包为单个 `.zip`（不含加密 API Key） |
| `importBackup()` | `backup:import` | 无参数；系统文件框选择 `.zip`，写入前校验 512 MiB 体积上限后幂等恢复 |
| `openExternalUrl(url)` | `system:open-external` | ≤1500 字符链接，初始地址经主进程 HTTPS 和公网地址校验后交由系统浏览器打开 |
| `copyText(text)` | `clipboard:write-text` | 1–200,000 字符文本；写入系统剪贴板 |
| `copyImageDataUrl(dataUrl)` | `clipboard:write-image` | ≤12 MiB 的 `data:image/png;base64,` URL；转码为 PNG 后写入系统剪贴板 |
| `getResearchProfile()` | `profile:get` | 无参数；返回科研向导画像或 null |
| `saveResearchProfile(input)` | `profile:save` | 阶段、学科门类、至多 6 个方向、自定义课题、范式、阅读目标与至多 16 个推荐标签，可选应用初始术语表 |
| `setWindowTheme(theme)` | `window:set-theme` | `light` / `sepia` / `dark`；写入 `ui:theme` 并同步原生标题栏叠加层 |

`DocumentRecord` 含 ID、原文件名、显示标题、字节数、页数、导入时间、星标、标签、分类与阅读状态，不含 SHA-256 与库内存储文件名。所有 SQL 值使用位置或命名参数绑定；建表迁移 SQL 是应用内固定文本。

## 本地存储与导入一致性

默认文件位于 Electron `app.getPath('userData')`：

```text
userData/
  paperflow.sqlite
  paperflow.sqlite-wal / paperflow.sqlite-shm  （数据库打开时可能存在）
  library/
    <UUID>.pdf
```

主进程支持绝对路径的 `--user-data-dir` 启动参数，供隔离测试或本机自选数据目录使用；renderer 不提供路径配置接口。数据库不写入安装目录。

`PRAGMA user_version = 7` 管理建表与非破坏升级事务：支持从 `v0` 全新初始化，以及从 `v1`–`v6` 在原库上逐级升级并保留已有文献、阅读进度、译文缓存与批注；高于 7 的版本直接拒绝打开。整个迁移在单个事务内完成。启用外键、WAL、5 秒 busy timeout。各版本变更如下：

| `user_version` | 本版新增 |
| --- | --- |
| 1 | `documents`、`reader_state` |
| 2 | `translation_cache`、`app_settings` |
| 3 | `annotations` |
| 4 | `documents.starred`、`documents.tags_json` |
| 5 | `folders`、`documents.folder_id`（`ON DELETE SET NULL`） |
| 6 | `chat_messages` |
| 7 | `documents.reading_status` |

业务表共七张：

| 表 | 字段与约束 |
| --- | --- |
| `documents` | UUID `id` 主键；唯一 `sha256`、唯一 `stored_filename`；`original_filename`、`display_title`、`byte_size`（> 0 且 ≤100 MiB）、可空 `page_count`、`imported_at`；`starred`、`tags_json`、`folder_id`（外键 `folders(id) ON DELETE SET NULL`）、`reading_status`（`unread` / `reading` / `done`，默认 `unread`） |
| `reader_state` | `document_id` 主键并外键关联文献（`ON DELETE CASCADE`）；从 1 开始的 `page_number`；0.5–3 的 `scale`；`updated_at` |
| `translation_cache` | `(document_id, page_number, block_id, target_language)` 复合主键并外键关联文献（`ON DELETE CASCADE`）；存储 `source_hash`、`provider_signature`、`translated_text`、`updated_at` 与 lookup 索引 |
| `annotations` | UUID `id` 主键；`document_id` 外键关联文献（`ON DELETE CASCADE`）；`page_number`、`color`、`quote_text`、`note`、`rects_json`、`sentence_ids_json`、`created_at`、`updated_at` |
| `folders` | UUID `id` 主键；`parent_id` 自引用外键（`ON DELETE CASCADE`）；`name`、`faculty_id`、`context_summary`、`glossary_json`、`inherit_global_glossary`、`created_at`、`updated_at`；嵌套深度由应用层限制为 4 级 |
| `chat_messages` | UUID `id` 主键；`session_key`、`role`（仅 `user` / `assistant`）、`content`、`quote_text`、`context_summary`、`created_at` |
| `app_settings` | 键值对配置表（`key` 主键、`value`、`updated_at`） |

`app_settings` 中当前使用的键：

| 键 | 内容 |
| --- | --- |
| `translation.config.v1` | 翻译引擎设置 JSON（供应商、目标语言、术语表、Base URL / 模型、CLI 配置） |
| `translation.openaiCredentials.v2` | 按完整 Base URL 绑定、经 `safeStorage` 加密的 API Key；旧 `translation.openaiApiKey.v1` 仅用于迁移 |
| `translation.cliAuthorizations.v1` | 已授权的本机 CLI 程序与参数 |
| `usage.ledger.v1` · `usage.preferences.v1` | Token 用量台账与用量偏好 |
| `ai.customSkills.v1` | 自定义学术技能 |
| `research.profile.v1` | 科研向导画像 |
| `doc.summary.v1:<documentId>` | 单篇文献的滚动摘要，供跨批 / 跨页翻译注入上下文；随文献删除、文献库重置一并清理 |
| `ui:theme` | 当前全局主题 |

导入串行排队。主进程以一个有界快照读取源文件，限制 **100 MiB（104,857,600 字节）**，检查普通文件、`.pdf` 扩展名与 `%PDF-1.x`/`%PDF-2.x` 文件头，并比较读取前后大小和修改时间。哈希与写入使用同一份字节，源文件不修改。

相同 SHA-256 返回现有记录，并先检查已有副本可读；同名不同内容按不同 UUID 共存。新文件（无论来自原生文件框 `importFile` 还是渲染层拖拽读取字节 `importBuffer`）均共用 `commitPdfBytes()`：先交隐藏沙盒 PDF.js 校验器逐页构造操作列表，拒绝已加密、无法解析或超时的文件，校验成功后写入排他创建的临时文件、flush、重命名，再写数据库。可捕获的复制/数据库失败会清理临时文件及未提交副本，并在错误文本中保留原文件名与可读超限大小。此外，`main/index.ts` 在启动创建主窗口前运行 `cleanupOrphanFiles()`，仅清理 `library/` 下未入库的 `<uuid>.pdf` 与残留 `.<uuid>.tmp` 普通文件，不触碰其他用户文件。

库存读取与删除均要求数据库命名匹配 `<id>.pdf`，拒绝符号链接和非普通文件，检查 `realpath` 位于 `library/` 目录内；读取另核对大小、文件头及 SHA-256。PDF.js 仍可能修复或容忍部分非标准结构；导入校验不等同于 PDF 标准全项一致性验证。合法但复杂的文件也可能因 20 秒时限被拒绝。

better-sqlite3 **13.0.3** 的本机 `binding.gyp` 使用 `NAPI_VERSION=10`，并自带平台预编译模块。当前工程采用 Node-API 兼容路径，非传统每个 Electron V8 ABI 都重新编译；`npmRebuild: false` 避免误触发旧式 rebuild。`pnpm rebuild:electron` 是实际加载与 SQLite 查询验证脚本，并非假装执行原生重编译。未来换版本、平台或架构必须重新检查二进制存在性和运行兼容性；`.node` 在打包时解包到 ASAR 外。

## 阅读器生命周期、文字与资源

`pdf-engine.ts` 为每个文档显式创建本地模块 Worker，再用 `PDFWorker.create({ port })` 传给 `getDocument`。原因是标准 URL API 对 `app://` 的 origin 返回 null，单靠 `workerSrc` 会触发 PDF.js 跨源 blob 包装并与严格 Worker CSP 冲突。销毁封装幂等调用 loading task 销毁、PDFWorker 销毁和物理 Worker terminate，不长期退化成 fake Worker。CMaps、标准字体、ICC profile 和图像解码 WASM 均随包，不依赖 CDN。

`PdfViewer` 从 IPC 获取字节与保存状态，维护 `PDFDocumentProxy`、当前页、缩放、加载/错误状态，并在顶部栏按自定义标题优先展示文献名（`displayTitle`）。首次未保存状态时按可用宽度计算倍率，普通缩放限制在 50%–300%。连续纵向滚动更新当前页；工具栏与快捷键支持：
- **目录书签抽屉**（`pdf-outline.ts`、`PdfOutline.tsx`）：仅解析 PDF 内部目标（`getDestination` + `getPageIndex`），忽略纯外部 `item.url` 链接，空目录显式提示“此 PDF 未包含目录书签”。
- **文内检索**（`pdf-search.ts`、`PdfSearchBar.tsx`，`Ctrl+F`）：`PdfSearchService` 按页通过 `getTextContent()` 惰性缓存 UTF-16 索引与 `spans`，不触发离屏 Canvas 渲染；支持异步取消、`yieldEvery` 分片让出事件循环、大小写切换、`Enter`/`Shift+Enter`/`Escape` 切换与关闭，并在每页 `.pdf-highlight-layer` 绘制 `.pdf-search-match` / `.pdf-search-match--active` 与自动居中滚动。
- **缩放与键盘操作**：支持阅读区 `Ctrl/Meta + 滚轮`缩放，以及焦点在 `.reader-panel` 时的 `Ctrl+=`/`-`/`0`、`ArrowLeft`/`ArrowRight`/`PageUp`/`PageDown`/`Home`/`End`（输入框等可编辑元素内保持原行为）。
- **白边裁剪阅读**（`margin-crop.ts`）：在页面首个可用 Canvas 上执行 `measureCanvasCropInsets` 扫描非空白 ink 包围盒（单边上限 `0.35`、单轴上限 `0.65`），开启“裁剪白边”时仅调整 `.pdf-page` 裁剪视框与 `.pdf-page-mount` 偏移，并在「适合宽度」计算中折减水平白边，不改动 `PageViewport` 与双坐标投影。
- **多篇并排分栏**（`SplitPdfPane.tsx`、`split-panes.ts`）：每个分栏独立持有 `source` / `dual` / `translation` 视图模式与权重，分栏之间通过拖放进行拆分、互换与合并。

阅读器目录下另有若干纯函数模块服务于选区与版面分析：`pdf-graphics.ts` 从页面操作列表提取图片、矢量图与分隔线区域；`pdf-title-extract.ts` 离网解析首页文本与元数据以提炼论文标题；`highlight-polygon.ts` 生成高亮多边形路径；`selection-ink.ts` 从已渲染画布把选框收紧到字形边界；`text-layer-layout.ts` 补齐单字符 advance；`translation-page-renderer.ts` 为译文侧离屏渲染页面并一次产出版面分析、底图快照与裁剪内边距。

`PdfPage` 用 IntersectionObserver 在阅读视口上下 800px 范围内渲染，离屏销毁物理像素与文字层 DOM。每页保留布局占位，按实际 page viewport 修正不同尺寸；当前实现是 Canvas 按需渲染，并非完整的页面 DOM 虚拟列表。极端超长文档的占位 DOM 开销仍需后续性能验收。

混合页的真实尺寸可能改变前方占位高度。程序跳页、恢复和缩放使用可取消的目标锚定，由一个 ResizeObserver 观察逐页尺寸并补偿位置；只在锚定期间关闭浏览器自动滚动锚定，避免两者同时调整。用户滚轮、指针、触摸、导航键或其他非本次补偿的滚动会取消旧目标；文献身份与命令序号防止过期缩放提交重新定位。Canvas 懒渲染范围未因此放大，onPageData 借用语义保持不变。DPR3 的四秒被动位置观察、真实滚轮与最新跳页回归见补充验收报告；未以静态审阅代替物理输入测试。

单页 Canvas 与官方 `TextLayer` 使用同一个 `PageViewport`。Canvas 物理像素按设备像素比缩放，并受 8 Mi 像素与 8192 单边限制；文字、选区和未来覆盖层始终使用 CSS 像素，不误乘 DPR。文本来自 `getTextContent`，交给官方 TextLayer 构造 DOM，不通过不可信 HTML 注入。Canvas 字体加载完成后再测量文字层，支持真实文字选择与复制。无可提取文字的页面正常显示图像并提示暂不支持 OCR。

每轮渲染使用独立 Canvas/DOM，同页后继任务等待旧任务完成。清理取消 RenderTask 和 TextLayer，等待已启动 Promise 结束后再 page cleanup，避免旧任务覆盖新页面。页面级失败显示错误；文档加载错误、密码文献均有友好提示。

阅读进度通过 `useReaderPersistence` 以 450ms 防抖串行保存；切换卸载主动 flush。关闭窗口发固定本地事件，等待进度保存，最长 2 秒后继续关闭；数据库在 `will-quit` 阶段关闭。突然终止进程、断电、磁盘写入失败或超过关闭等待时限时，最后未落库状态不作保证。最近文献 ID 存于应用来源 localStorage；页码和缩放在 SQLite。

## T04–T08 可复用接口

以下渲染层坐标与快照接口供版面分析、选区桥接及原页底图译文叠加复用。

| 接口 | 数据与用途 |
| --- | --- |
| `PdfViewerProps.onPageData` / `PdfPageProps.onPageData` | 页面就绪时借用 `PdfPageData`；离屏、缩放或卸载时传 null 撤销，调用者不得长期保留过期资源 |
| `PdfViewerProps.onPageBackdrop` | 页面 Canvas 就绪时回传 `PageBackdropSnapshot`（原页 `ImageBitmap` 与块底色采样）；离屏、缩放或卸载时传 null，调用者须及时 `.close()` 回收 |
| `PdfPageData` | `geometry`、原始 `textContent`、官方 `TextLayer`、页面 `canvas` 与 `element` |
| `PageTextContent` | `PDFPageProxy.getTextContent` 返回类型，保留 items、文本样式和文字 transform；不能把每个 item 默认等同一句话 |
| `PageGeometry` | 页码、完整 `PageViewport`、Canvas `outputScale`；统一旋转、CropBox、UserUnit 与缩放信息 |
| `pdfPointToViewport` / `viewportPointToPdf` | PDF 坐标与页面局部 CSS 坐标双向转换 |
| `pdfRectToViewport` / `viewportRectToPdf` | 变换矩形四角后求边界，兼容页面固有旋转 |
| `clientPointToPdf` | 客户区鼠标坐标减页面边界并转换回 PDF 坐标 |
| `selectionToPdfRects` | 将真实 DOM Selection 分页裁剪，输出 `{ pageNumber, rect }` 的 PDF 坐标矩形 |

### 空白区域的鼠标选择边界与跨页/旋转/高对比度连续高亮

`text-selection.ts` 在已渲染页面注册官方 TextLayer 的公开文字节点，保留原始 `textContent`、DOM 顺序及 `onPageData` 借用接口。主键从阅读区空白起拖时不建立文字选区；文字起拖后进入空白，将端点限制到实际指针路径经过的最后一个文字节点。字符 Range 用于验证命中，避免把透明整页或整行的外框当成文字。

针对公式、旋转页面与跨页连选场景，`selection-bridges.ts` 与 `selection-highlight.ts` 在同页统一 SVG 路径 `.pdf-selection-shape`（`fill-opacity: 0.36`）内合并原始字符框与补间矩形：
- **视觉显示投影与旋转支持**：通过 `composeAffine(viewport.transform, item.transform)`、`displayScaleForViewport`（`viewport.scale * viewport.userUnit`）、`projectVisualRun`、`viewportToDisplayRect` 与 `displayToViewportRect` 将文字运行与选区矩形映射至未缩放的视觉显示空间，统一处理 0°/90°/180°/270° 页面旋转、`CropBox` 与 `UserUnit`，保持宽高下标与行内公式的连续桥接。
- **跨页与端点守卫**：`selectedPart()` 增加 `comparePoint` 叶节点守卫；当选区跨越两页及以上（`activePages > 1 || startPage !== endPage`）时，即使某页仅选中单行文字、`bridges.length === 0`，也统一启用 `.pdf-selection-shape` 绘制。
- **高对比度适配**：`forced-colors.css` 在 `@media (forced-colors: active)` 下为 `.pdf-selection-shape` 设置 `forced-color-adjust: none`、`fill: Highlight`、`fill-opacity: 0.36`、`stroke: none`，并抑制冗余原生背景涂抹，在系统高对比度主题下保留下层 PDF Canvas 字符清晰度，同时增强选中列表项、聚焦环、搜索命中、句卡高亮及同步锁定按钮边界。

已观察到 PointerEvent 保留小数坐标而兼容 MouseEvent 截为整数的情况。控制器仅给紧随其后、类型/目标/按钮/可信状态匹配的兼容事件消费一次准确指针坐标；不匹配则使用原鼠标坐标，失焦、取消和最终注销会清理缓存。这项处理不扩大字符框容差。

快速移动沿指针线段作有限局部采样（约 2 CSS 像素，最多 1024 次），不是对任意字号、距离和内容顺序的保证。公式仍取自 PDF 的真实可提取字符，矢量分数线不伪造成文本，也不生成 LaTeX。双击、带修饰键的选择和复制沿用浏览器；阅读工具栏与原生滚动条不纳入空白拦截。

页面离屏、缩放或卸载时幂等撤销注册，最后一页撤销时终止共享事件监听器；有效手势绑定实际起拖文字层，灰色页外空白绑定阅读根容器。具体行为是否通过以本轮 QA 的真实鼠标记录为准，静态架构说明不代替测试结果。

实现位置为 `pdf-geometry.ts`、`selection-bridges.ts`、`selection-highlight.ts`、`forced-colors.css`、`PdfPage.tsx` 与 `PdfViewer.tsx`。未来高亮层仍以未缩放 PDF 坐标为准，显示时实时转换。

### 多栏版面分析、原页底图译文覆写、引擎代理与双栏同步滑动

根据 2026-11-24 授权放开的 T04–T06 阶段范围，`layout-analysis.ts` 通过 `PdfViewer` 的 `onPageData` 与 `onPageBackdrop` 借用入口同步提取纯坐标结果 `PageLayoutResult` 与页面 `ImageBitmap` 底图（不持有过期 `PDFPageProxy` 或 DOM 引用，缩放/离屏/切文档时显式 `.close()` 回收并清空状态），配合主进程 `TranslationService` 完成完整双语对照阅读：

1. **多栏版面分析与底色采样（`layout-analysis.ts`）**：
   - 将 PDF.js `textContent` 通过 `composeAffine(viewport.transform, item.transform)` 与 `viewportRectToPdf` 映射至未缩放视觉显示坐标与 PDF 用户坐标，支持 0°/90°/180°/270° 页面旋转、CropBox 与 UserUnit。
   - 过滤空白项、边缘垂直印记（`margin-stamp`）、页眉、页脚与页码，并提供跨页重复边缘块精炼（`refineDocumentHeadersFooters`）。
   - 采用基于跨幅宽行分带的 XY-Cut 重建多栏阅读序，识别 `heading`、`paragraph`、`caption`、`formula` 与 `list-item` 语义块；执行断词连字符拼接（保留 `self-`/`non-` 等复合前缀）、同 Band 跨栏未完句合并（`crossColumn: true`）、缩写/小数保护，计算基于坐标与文本的稳定块缓存键 `computeStableTranslationBlockKey` 与 64 位源签名 `hashTranslationBlockSource`。
   - `sampleBlockBackgroundColors` 在页面 Canvas 就绪瞬时采样待译块边缘像素中位底色，用于无痕覆写彩底或白底块。
2. **1:1 对称双栏、原页底图覆写与逐句双向联动（`App.tsx`、`TranslationPanel.tsx`、`sentence-alignment.ts`）**：
   - 顶部支持一键「收起文献库 / 展开文献库」；每个分栏可在 **「原文 / 双栏 / 译文」** 三种视图间切换（`SplitPaneViewMode`），未选择过时默认 `source`，已选视图按文献记入 `localStorage['paperflow:doc-view-modes']`；拖曳分屏隔断条可在 `0.2–0.8` 间调整相邻分栏的权重比例。
   - 未打开文献时保持 `.panel-heading` 与「尚未翻译」空态；打开文献后，`.translation-header` 通过 `ResizeObserver` 与左栏下沿像素对齐。
   - `.translation-page` 同步左侧尺寸、缩放与 `裁剪白边` 偏移，底层由 `MirrorBackdropCanvas` 绘制原 PDF 页面 `ImageBitmap` 完整保留矢量图表、表格与公式（`formula` 块保留底图并叠加透明 `.translation-mirror-sentence` 热区）；`OverlayPageContent` 为跨栏空尾块提供精确非重叠背景遮罩（`.translation-overlay-mask`），对已译中文块先在不侵占邻列/Formula 的前提下尝试同栏右边界安全展宽，再渐进缩微字号（最低 `5.5px` / `line-height: 1.08`）以实现 **0px 纵向漂移**。
   - **双向逐句对照高亮（`sentence-alignment.ts`、`PdfViewer.tsx`）**：已译块按中英文自然句切分并与原文句子 1:1 或区间比例双向对齐；未译块与公式块提供透明 `.translation-mirror-sentence` 热区。**左 → 右**：点击左侧原文句子在两侧同步高亮对应句；左侧拖选文字通过 `selectionchange` 与 `selectionToPdfRects` 反查覆盖句并仅在右侧同步高亮（不干扰左侧原生蓝底选区）。**右 → 左**：点击任意译文句段（`translation-overlay-sentence`）、未译热区或拖选译文文字，均在左侧 `.pdf-highlight-layer` 同步绘制精准 `.pdf-sentence-highlight` 并保持双栏句对交互对称（按 `Escape` 或点击空白清除）。
3. **主进程双引擎翻译代理与安全存密（`TranslationService`、`TranslationSettingsModal.tsx`）**：
   - 支持 **OpenAI 兼容 API**（DeepSeek / OpenAI / 本机 Ollama 等，主进程原生 `fetch`）与 **本机 AI CLI**（Codex / Claude / Gemini / 自定义 CLI，`resolveCliExecutable` 纯文件系统检索 + `stdin` 传参 + 空临时工作目录 + 进程树取消清理），由 Zod 严检 URL 协议与 CLI 安全 token。
   - OpenAI API Key 经 Electron `safeStorage` 加密存盘于 `app_settings`，按完整 Base URL 绑定（`translation-credentials.ts`），仅向前端暴露 `hasApiKey` 与 `apiKeyPreview`；译文按 `SOURCE_HASH` 分批翻译与单块稳健回退后落盘 SQLite `translation_cache`，切页/重启优先读缓存。
4. **双栏同步滑动锁定/解锁（`scroll-sync.ts`、`useDualScrollSync.ts`）**：
   - 默认开启「同步锁定」，纵向 1:1 像素对齐、横向按双向溢出比例映射，以时效窗 `isEchoScroll` 消除来回回声；手动切为「自由滑动」后两侧独立滚动，重锁时自动从左侧同步校准右侧。

扫描页 OCR、Python 翻译运行时依赖与自动远程发布仍严格不在实现范围内（`--publish never` 保持生效）。

架构依据：[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security/)、[Electron 自定义协议](https://www.electronjs.org/docs/latest/api/protocol)、[electron-vite 依赖处理](https://electron-vite.org/guide/dependency-handling)、[PDF.js 官方示例](https://mozilla.github.io/pdf.js/examples/)。具体行为以本项目锁定版本源码和测试为准。
