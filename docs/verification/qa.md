# PaperFlow QA 验证记录

## PFV-QA-002 revision 5 最新结果（2026-10-28）

本轮基线 `PF-VERIFY-20261028-07`，run `20261028-regression-01`，已完成授权门禁执行，提交主控验收。安装包仍未签名；原生文件框完整选择、物理 DPI/跨屏和其他机器仍未验证。根 `docs/artifacts.json` 保留的是 2026-10-27 旧包，须主控同步；当前新包索引为 `.cache/qa/20261028-regression-01/r5-08-dist-win/artifacts.json`，qa 未越权修改总交付索引。

| 实际执行范围 | 最新结果 |
| --- | --- |
| 公共检查 | typecheck 0、lint 0；Vitest **59/59**、5 文件，退出 0 |
| 新构建与兼容性 | `pnpm build` 退出 0；native 依任务复用 `05-native` 通过证据，未冒充重跑 |
| DPR 3 两项定向 | 旋转/图层/选字及滚轮/最新导航，**2/2**、退出 0 |
| 完整源码 E2E | **20/20**，0 跳过、0 flaky，退出 0，runner 67.142 秒 |
| 新 Windows 包 | `pnpm dist:win` 退出 0，明确 `--publish never` |
| 新解包完整 E2E | 显式指向新 `release/win-unpacked/PaperFlow.exe`，**20/20**，0 跳过、0 flaky，退出 0，runner 67.068 秒 |
| 新安装版原关闭恢复单例 | 无已有安装冲突；隔离安装退出 0、未自动启动；单例 **1/1**、退出 0 |
| 卸载与数据保留 | 卸载器退出 0；早期验证脚本因开始菜单快捷方式尚在退出 1，后续只读确认自行消失，未手工删除。最终目录/注册项/快捷方式/进程无残留；默认 124 文件和隔离数据库哈希差异 0 |

五档进程 DPR 1/1.25/1.5/2/3 在源码和新包中各完成 12 组第 13–16 页 × fit/放大/缩小的几何、图层、像素上限和真实鼠标选字断言。新增稳定观察覆盖 4 秒被动保持、真实滚轮后 1 秒不被拉回、页码 14→16 最新导航后 2 秒稳定；DPR 3 定向和全套均通过。合成加密拒绝、合成 600 页实际导入/导航/远页释放、原阅读选择复制/缩放/恢复与安全边界也在两套完整运行中通过。有限观察和合成素材不能推断无限时序、任意长文档内存有界或真实物理多屏。

### 新产物

| 产物 | 字节数 | SHA256 | 签名 |
| --- | ---: | --- | --- |
| 本轮 NSIS 包的现归档位置（`release/安装包/PaperFlow-0.1.0-win-x64-setup.exe`） | 122,993,353 | `d488a699708e93b7da76e598274451f6eaf075ebf731c0f7a8a9573bef1777f7` | NotSigned |
| 新解包入口（`release/win-unpacked/PaperFlow.exe`） | 245,590,016 | `aa290d32926ae9c999fa479f4e8bb90b48737b495dba5c1976e8d93453201498` | NotSigned |
| 新 app.asar（`release/win-unpacked/resources/app.asar`） | 33,280,280 | `98ab809a7ff0c07356b77f177c8b56a205c29b14061b0fe7a03d8d5cd9336d9c` | 不适用 |

dist 重建 out 与源码回归所测 out 的 **209 文件**哈希一致；asar 内 out 双向比较也是 209 项，无缺失、额外、链接或字节差异。安装后与已测解包目录的 **141 个物理文件**哈希一致，两个计数范围不同。私有 asar 校验脚本首次误用 Windows 路径分隔符，仅修正私有脚本后比较通过；初次脚本和工具错误摘录保留，没有改包或重新打包。

安装目标为 `<repo-root>\.cache\qa\20261028-regression-01\r5-installed`，注册位置与卸载器均精确核对。安装版日志保存实际启动路径、PID、明确隔离的 user-data-dir；鼠标选字/剪贴板、正常窗口关闭退出 0 和重启恢复第 3 页均通过。文件框返回值为注入，仍不能作为完整原生选文件证据。测试安装已移除，release 安装包与完整解包目录保留。

卸载早期快照 10:49:52 尚见开始菜单快捷方式；10:50:39 只读复查已无该文件，10:52:10 最终核对干净，确切删除时刻未测。未手动删除快捷方式、真实正文或默认进度；早期验证脚本退出 1 与最终干净状态分别保存，不概括为所有命令首次全部通过。

### 最新证据

证据根：`<repo-root>\.cache\qa\20261028-regression-01\`。

- `r5-01-typecheck`、`r5-02-lint`、`r5-03-unit/vitest.json`、`r5-04-build/out-manifest.json`；单测固定 JSON 执行前备份、执行后复制入本轮，未覆盖模块历史日志。
- `r5-06-dpr3-targeted`、`r5-07-source-e2e`、`r5-09-unpacked-e2e`、`r5-11-installed-e2e`：各自完整 `playwright.json`、`output.log`、`status.json`、`summary.json` 与解码附件。源码另有 `coverage-summary.json`，原附件未改写。
- `r5-08-dist-win/{artifacts.json,asar-comparison.json,asar-comparison.log,status.json}`；`r5-10-install/{preflight.json,status.json,payload-comparison.json}`；`r5-12-uninstall/{status.json,shortcut-recheck.json,final-verification.json}`。
- `baseline-r5-start.json`、`baseline-r5-final-before-report.json`：标准 ZIP 及 140 文件核对；只允许 reader/qa 自有报告差异，源码/测试/配置/锁差异 0。qa 未提交 Git、推送或发布。

以下保留 revisions 1–4 的原始失败与诊断历史，不代表最新 07 候选仍失败，也不能删除这些记录冒充首次成功。

## PFV-QA-002 revisions 1–4 历史

任务 `PFV-QA-002` / `20261028-regression-01`，冻结基线 `PF-VERIFY-20261028-03`。起始清单 **140 个文件**与当前大小、SHA256 全部一致；标准 ZIP 的 SHA256 为 `1cda984f0ab35310413fe4b11c613cf8e545af874ab5672420e975a565ddefcb`，与清单一致。检查结束、更新本文档前再次核对 140 文件，差异 0。没有修改源码、测试、断言、锁文件或共享配置。

按任务顺序执行：

| 阶段 | 本次结果 |
| --- | --- |
| `pnpm typecheck` | 退出码 0 |
| `pnpm lint` | 退出码 1，31 个错误、0 警告；门禁停止 |
| 单测与 Vitest JSON、build、native 检查、原 fit-width 单例、源码全套 E2E、dist、解包全套 E2E、新安装版及卸载 | **全部未执行**，不能引用旧任务结果替代 |

31 个 lint 错误全部来自 `.cache/qa` 下历史 Playwright 转译缓存以及 `.cache/release-audit` 的审计脚本，规则为 `no-require-imports`、`no-unused-vars`。当前 `eslint.config.mjs:4` 未把 `.cache` 加入忽略范围；这是共享检查配置与现有缓存的冲突，不据此推断候选阅读器修复已通过或失败。依任务要求保留缓存、断言和共享配置原状，交主控修复后再派续作；没有删除缓存或用临时忽略参数规避此阶段。

额外执行边界待主控核定：现有 `tests/unit/library-robustness.test.ts:42` 会写 `.cache/library`，`tests/unit/pdf-geometry.test.ts:32` 会写 `.cache/reader`，而本任务允许路径仅包含 `.cache/qa` 等指定路径。单测尚未执行，未触及这两处输出；后续任务应明确这两类既有测试输出的授权范围，或由主控调整输出位置。

本轮准确证据根：`<repo-root>\.cache\qa\20261028-regression-01\`，包括 `baseline-start.json`、`baseline-after-checks.json`、`preflight.json`、`summary.json`，以及 `01-typecheck/{output.log,status.json}`、`02-lint/{output.log,status.json}`。即使标准输出为空也预先创建日志，并追加退出码；本轮没有声明不存在的日志或测试 JSON。

revision 2 续作：已核对 `PF-VERIFY-20261028-04` 的 140 文件及 ZIP 与当前匹配，结果保存为 `baseline-r2-start.json`。仅重跑 `pnpm lint`，**退出码 0**，准确日志/状态为 `02-lint-r2/output.log`、`status.json`；复用原类型检查通过，不重复执行。读取到的 revision 2 `allowed_write_paths` 仍未包含上述单测必写的两个模块缓存路径，因此尚未启动单测及后继；信号已列出需要主控补齐的范围。原 lint 失败证据保留。

以上为保留的门禁历史。主控随后在 revision 3 正式补齐两个固定 JSON 与 `library/cases/**` 输出范围，并先备份旧 JSON 至本轮 `pre-unit-evidence`；读取当前任务后继续执行，结果如下：

| 当前门禁阶段 | 实际结果与证据 |
| --- | --- |
| 类型 / lint | 类型复用首次退出 0；04 基线的 lint-r2 退出 0，初次 31 个缓存错误未覆盖 |
| 完整单测 | **59/59 通过**、5 个文件，退出 0；`03-unit/vitest.json` 和 `output.log`；两个模块的新结果 JSON 已复制到 `03-unit` |
| 生产构建 | `pnpm build` 退出 0；`04-build/output.log` 与 `out-manifest.json` |
| Electron 原生检查 | `pnpm rebuild:electron` 退出 0；实际 Electron 44.7.2、N-API 10、SQLite 3.53.4；`05-native` |
| 原 mixed-size 单例 | **1/1 通过**，退出 0；第 13 页从 133% / 1662.5px 调到 65% / **812.5px**，可用宽 **821px**，左右界 276.25–1088.75 均在 272–1093 内，scrollLeft=0；`06-fit-width/observations.json`、`summary.json` |
| 首次完整源码 E2E（07） | **14 通过、5 失败、0 跳过、0 flaky**，退出 1，runner 统计耗时 62.599 秒；`07-source-e2e/playwright.json`、`output.log`、`status.json`；下文保留修正测试器后的 r2 结果 |
| dist、新解包应用全套、新隔离 NSIS 安装/单例/卸载 | **未执行**；按失败门禁停止，旧包结果不能替代 |

本轮源码 E2E 的通过项包括安全边界、文献导入/去重/恢复、合成加密 PDF 拒绝、合成 600 页实际导入和导航、独立 fit、既有阅读选择复制/缩放/状态恢复，以及五档进程 DPR 的实际读回。600 页导入至首屏测得约 1068.591ms，采样 Canvas 数为 2/3/2/2，仍保留全部 600 个占位 DOM；该计时仅为本机本次合成素材，不能推断任意长文档或进程内存有界。文件框返回值注入、进程 DPR 模拟与原生选文件/物理 DPI 实测严格区分。

首次 07 的五个失败全部位于 `reader-verification.spec.ts:153`，DPR 分别为 1、1.25、1.5、2、3；宽度轮询 5 秒后实际报告 `Infinity`。其附件均 `samples=[]`、`failures=[]`，故旋转组合、后续缩放、图层和选字没有得到这五例的完成验证。不能把它们描述为 Canvas 缺失或产品渲染失败：源码静态可见 Node 局部 `expectedWidth` 被浏览器 `evaluate` 回调直接引用，未显式传参，异常又被 `catch(() => Infinity)` 转换。两端环境不共享变量，见 [Playwright 官方说明](https://playwright.dev/docs/evaluating#different-environments)。`ReferenceError` 是据此作出的原因推导，原报告没有保留下层异常文本。

主控已核定测试器问题并安排 reader 仅修正参数传递；qa 未修改产品、测试或断言，没有重跑整套。原始 JSON 内的全部附件及 5 份 `error-context.md` 原样保留；另将 JSON 附件原字节解码到 `07-source-e2e/extracted-attachments/`，摘要为同目录上级 `summary.json`。`baseline-after-source-e2e.json` 记录：140 份清单中仅允许的 QA 自有报告变化，其余 **139 文件大小/哈希保持冻结一致**。后续等待新基线续作。

### revision 4：修正测试传参后的源码完整回归

主控派发 `PF-VERIFY-20261028-05`，reader 只把第 153 行的 `expectedWidth` 显式作为 evaluate 参数传递；原 `<0.1` 阈值、五档 DPR 与鼠标断言均未改动，产品源码未变。qa 核验新基线及允许的 reader/qa 自有报告差异后，复用既有单测、build、native、独立 fit，通过 `07-source-e2e-r2` **完整重跑 19 例**，没有重编译当前 out。

实际 runner 结果：**18 通过、1 失败、0 跳过、0 flaky**，退出码 1，耗时约 79.845 秒。DPR 1、1.25、1.5、2 的旋转/CropBox/UserUnit 用例各完成 12 个采样，覆盖第 13–16 页 × fit/放大/缩小，实际 DPR 与请求一致，图层/像素上限/鼠标选字断言均通过。DPR 3 的基础启动读回用例也通过，但其完整旋转用例在**首次导航第 13 页**时失败，尚未开始几何采样。

新失败栈为 `reader-verification.spec.ts:142 → navigate:14 → waitForPage:7`：30 秒中第 13 页 `data-rendered` 持续为 `false`，runner 记录 62 次不匹配；其附件 `samples=[]`、`failures=[]`。它发生在 fit 点击和第 153 行之前，不能继续归因于已修的闭包传参错误，也不能据空样本断言某个几何变换有误。尚未额外重试或做动态诊断，稳定复现性及根因未定；目标页布局、滚动位置和懒渲染观察器关系是待排查方向。没有延长超时、跳过 DPR 3 或更改断言。

后继 dist、新包 E2E、新隔离安装/卸载继续**全部未执行**。旧包仍只属于 QA001 的历史结果。准确证据为 `07-source-e2e-r2/{playwright.json,output.log,status.json,summary.json,dpi-summary.json}`，五份原始采样附件另解码保存在 `extracted-attachments/`，DPR 3 失败上下文保存在 `test-results/reader-verification-PFV-ro-81294-election-at-simulated-DPR-3/error-context.md`。原 `07-source-e2e` 五失败证据完整保留。`baseline-r4-start.json`、`baseline-after-source-e2e-r2.json` 记录冻结核对与允许的文档差异，qa 未修改源码/测试/配置/锁文件。

### DPR 3 单独诊断：页面位置失稳已观察，原回归仍失败

按任务追加的 `diagnostic_scope`，qa 只在本轮缓存编写一个私有探针，复用原 helper、合成 `geometry.pdf` 与 DPR 3。它不修改原 spec 或产品，独立增加只读 MutationObserver 和同样 `800px 0px` 预加载边界的 IntersectionObserver，记录 16 页矩形/尺寸/渲染状态、滚动、当前页/倍率、页面错误、Electron 窗口和显示工作区。独立观察器属于诊断 instrumentation，不能等同直接记录产品内部回调。

首次私有探针在导航前遭遇 tsx 对浏览器回调注入 `__name` 导致的序列化错误；原脚本、日志和错误 JSON 保存在 `07-dpr3-diagnostic`。仅将浏览器观察代码改为私有原生 JavaScript 字符串执行后，完成一次有效导航诊断，未重复完整回归。有效结果位于 `07-dpr3-diagnostic-r2`。

本次记录的进程 DPR 为 3，窗口 1080×680、内容区 1074×665，阅读区客户大小 536×504，初始倍率 76%。显示工作区值为 Electron 在强制倍率下报告的值，不能当作物理显示器 DPI 实测。

实测时序（时间为页面 `performance.now()` 毫秒）：

| 时间/状态 | 第 11 / 12 页高度（CSS px） | 第 13 页 top（CSS px） | root.scrollTop | 第 13 页状态 |
| --- | --- | --- | --- | --- |
| 967.2，导航后 | 601.9167 / 601.9167 | 146.3698 | 7662.3335 | 占位，随后开始渲染 |
| 979.1，前页实际尺寸更新 | 1504.7969 / 1162.7969 | 1610.1302 | 7662.3335 | 渲染中 |
| 1084.5 | 同上 | 同上 | 同上 | 短暂 ready |
| 1085.1，独立 IO | 同上 | 1610.1302，超过 IO 下界 1450 | 同上 | 观察到不相交 |
| 1115.6 / 2845.9 | 同上 | 同上 | 同上 | 回到 idle，rendered=false |

两前页合计增高 **1463.7604px**，目标页顶部下移 **1463.7605px**，滚动位置变化 **0**。因此目标被前页高度更新推离原导航位置已直接观察；独立 IO 的离开边界与产品回到占位状态相吻合。探针首次等待 ready 耗时约 98ms，这是等待耗时，非 ready 持续时间；首次 ready 与随后 idle 的两条记录间隔约 31.1ms。后续 1.5 秒稳定性检查仍为 idle，故不能将短暂 ready 作为导航正确或原用例通过；原回归的 30 秒超时完整保留，此探针没有逐字重现那一段超时。页面错误记录为空，无需借此推断没有布局缺陷。

没有执行纠正滚动，没有增加原测试超时/预加载边界，也未继续打包。原始时序、16 页完整状态、窗口/workArea 保存在 `observations.json`，提炼时序为 `summary.json`，偏移量计算为 `finding.json`；私有执行退出码保存在 `status.json`。`before-correction.png` 仅是合成素材的诊断画面，文件名沿用脚本命名，本次没有实际纠正操作。它与任何正式测试通过结论无关。

下文保留 QA001 历史结果及实际失败，不代表新基线的软件验收结论。

## PFV-QA-001 本机验证

首次执行 2026-10-27，revision 3 续作 2026-10-28；run `20261027-verification-01`，基线 `PF-VERIFY-20261027-01` / `0779111`。首次验收对象为既有安装包，续作对象为现有旧 `out`；均未构建当前并行修改中的源码。混合尺寸页面“适合宽度”已在旧构建中实际失败，原生文件框选中文件仍未验证，不能宣称全场景通过。

## 已确认结果

- 安装包 `release/PaperFlow-0.1.0-win-x64-setup.exe`：122,992,594 字节；SHA256 `c2a582f7b40ca350d7e4570ab1a7009b6ed4cd2484045f691fb9b0282d64109e`；Authenticode `NotSigned`。卸载后安装包哈希仍一致。
- 安装前未发现同名卸载项、常见安装目录、桌面/开始菜单快捷方式或运行中的 PaperFlow。发现既有默认数据目录，按用户数据保护，仅记录文件大小和哈希，未导入其中正文、修改进度或删除文件。
- NSIS 静默当前用户安装至 `<repo-root>\.cache\qa\20261027-verification-01\installed`，参数 `/S /currentuser /D=<上述绝对目录>`，退出码 0，没有自动启动程序。实际注册表安装位置、卸载器和两个新快捷方式均指向本轮安装。安装负载与当前 `release/win-unpacked` 的 **141 个文件逐字节一致**；历史交付报告的 209 文件计数未在本轮复算其旧口径。
- 测试启动始终显式带 `.cache/qa` 内的 `--user-data-dir`。真实桌面看到空库；原生“导入 PDF 文献”框可打开、Escape 取消并恢复按钮。取消后 Alt+F4 正常退出，随后确认无残留 PaperFlow 进程。
- 安装版 6 个定向 E2E 通过（9.3 秒）：DPR 1、1.25、1.5、2、3 均读取实际 `window.devicePixelRatio` 确认；另一个用例验证原创合成测试 PDF 渲染、真实鼠标选字、Ctrl+C 剪贴板、正常窗口关闭退出码 0，以及重启恢复第 3 页。此阅读用例注入了文件框返回值，**不能作为原生选文件证据**。
- 卸载前核对实际 `HKCU\Software\935403b3-5b9e-5598-9b80-7266b3e79f5e\InstallLocation` 和卸载命令精确指向隔离目录。仅执行该卸载器 `/S /currentuser`，退出码 0。安装目录、两处快捷方式和本轮注册项均消失；6 个隔离测试数据库哈希未变。
- 既有默认数据安装前后/卸载后均为 124 个文件，大小与 SHA256 差异 0。未清理保留的本轮证据和测试数据。

## 工具限制与失败保留

1. 原生文件框的文件名控件可见，但辅助访问点击报 `element 164 is not available in cached app state`；坐标点击和 Alt+N 后工具持续报告焦点为搜索框。未在未核实焦点时输入路径，未选中任何用户文件，故原生选文件及其后续阅读保持**未验证**。无弹窗返回值注入用于本次原生尝试。
2. 普通受限执行环境首次启动安装器报“无效的系统 DLL 重定位”，6 个定向测试均在 Electron 启动前失败。正常本机执行环境重试安装及 6 个用例通过，两轮日志均保留；未改 Electron sandbox、contextIsolation、webSecurity 或任何 Windows 安全设置，未绕过安全提示。隐藏启动后短时未取得可操作窗口，仅终止本轮隔离路径的进程后以可见模式重试；不据此判定产品缺陷。
3. 初次 QA 局部检查工具返回 0，但其标准输出为空，原报告引用的 `qa-types.log`、`qa-lint-final.log` 实际未生成，撤回对这两个旧证据路径的引用。2026-10-28 已重跑并保存含明确退出码的准确日志：`tsconfig.test.json`、QA 局部 TypeScript 和 QA ESLint 均退出 0。先前 `scripts/verification/generate-reader-fixtures.ts:93` 的 TS7022 历史保留在原 `test-types.log`；本次确认该错误已修复，未越权改动脚本。
4. 只完成本机当前用户静默安装/卸载；交互安装向导、其他机器、真实多显示器与签名分发均未验收。DPI 为进程模拟，不能等同物理显示器测试。公共构建、打包、全套单测和完整 E2E 留待后续任务。

## 本轮代码与来源

`tests/e2e/helpers.ts` 兼容增加 `launchApp(dataDir, { deviceScaleFactor? })`：有限正值校验、进程参数、实际 DPR 断言，失败时关闭进程；原单参数调用保持兼容。`tests/e2e/verification.spec.ts` 为本轮 6 个用例。未修改业务实现或构建配置。

比例参数依据 [Chromium 开关定义](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/display/display_switches.cc) 与 [比例解析实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/display/display.cc)，并以上述实际读回结果核实本包行为。未声称对应本机 Electron 的精确 Chromium 提交已核定。[Electron 开关文档](https://www.electronjs.org/docs/latest/api/command-line-switches) 未单列该参数。

NSIS 行为依据本机 `app-builder-lib@26.15.3` 的 `templates/nsis/installSection.nsh:104`、`uninstaller.nsh:216` 及实际执行证据：辅助静默安装未传 `--force-run`；卸载未传 `--delete-app-data`，当前构建配置未启用删除应用数据。独立数据参数依据 `src/main/index.ts:14`。

证据根：`<repo-root>\.cache\qa\20261027-verification-01\`。

- `preflight.json`、`installation.json`、`post-install-system.json`、`installed-file-comparison.json`
- `native-dialog-result.json`、`ui-empty.txt`、`ui-cancelled.txt`、`normal-ui-close.json`
- `targeted-test.log` / `playwright.json`（受限启动失败）；`targeted-normal-test.log` / `playwright-normal.json`（6/6 通过）；`targeted/dpi-*.json`、`targeted/installed-reader.json`
- `test-types.log`（首次并行 reader 脚本错误；原样保留）；局部检查的有效日志见下方 revision 3 证据目录。
- `pre-uninstall.json`、`uninstallation.json`、`post-uninstall.json`；默认数据清单仅保存在本机忽略的缓存中。

## revision 3：混合尺寸适合宽度单例

2026-10-28 仅对现有 `out` 执行 `PFV mixed-size current page fits available reader width` 单例，结果 **1 个失败**，退出码 1，单例耗时 18.121 秒；未重跑首次 6 项、安装/卸载或公共全套。测试使用原创合成 `geometry.pdf`，文件框返回值注入；DPR 为进程模拟 1，不能作为原生文件框或真实显示器验证。

第 13 页含偏移 CropBox 与 UserUnit=2.5。点击“适合宽度”前及最后一次采样均为当前页 13、已渲染、133%：Canvas 宽 **1662.5 CSS px**，实测可用宽 **821 CSS px**，边界为 272 至 1093；Canvas 边界为 668.4375 至 2330.9375。15 秒轮询后仍未完整进入可用范围，18 个原始采样随附件保留。即使不扣左右内边距，整个阅读区域也只有 869 CSS px，故溢出不能仅归因于内边距口径。页面异常收集为空与此视觉行为失败分别记录。

只读核对现有打包脚本 `out/renderer/assets/index-an-GYYUE.js:12008`、`:12105` 仍从第 1 页取尺寸并据此计算适合宽度，与不同宽度第 13 页的失败相符。这是针对旧构建的原因判断，未验证当前源码修复。执行前后 `out` 的 **209 个文件大小与 SHA256 差异 0**；未修改产品、测试或断言。

续作证据根：`<repo-root>\.cache\qa\fit-width-probe\attempt-20261028-092818\`。

- `execution.json`、`playwright.log`、`playwright.json`：准确命令、退出码和含原始附件的报告。
- `mixed-size-fit-width-observations.json`：从原报告附件原字节解码的观察值；原始报告未改写。
- `test-results/reader-verification-PFV-mi-bd880-fits-available-reader-width/error-context.md`：原始失败上下文。
- `probe.json`、`out-before.json`、`summary.json`：执行对象、素材/测试哈希、构建不变核对及测量摘要。
- `prior-log-presence.json`：核实两个旧局部日志缺失、旧 TS7022 错误日志存在。
- `static-checks.json`、`test-types.log`、`qa-types.log`、`qa-lint.log`：三项检查均明确记录退出码 0。
