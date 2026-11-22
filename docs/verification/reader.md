# 阅读器验证报告

## 2026-10-28：PFV-READER-003 导航锚定候选，桌面待验

任务 `PFV-READER-003`，轮次 `20261028-navigation-01`，修复前标准 ZIP 基线 `PF-VERIFY-20261028-06`。前任务 002 已由主控按 fit-width 与测试回调修复范围接受；此项导航缺陷及软件整体仍须另行验收。

qa 修正回调后实际全套为 **18 通过、1 失败**，仅模拟 DPR 3 在导航第 13 页时等待 30 秒仍为 idle。私有被动探针随后核实：初始 98 ms 的 ready 只是一瞬；第 11/12 页实际高度分别增长约 902.880/560.880 CSS 像素，共 1463.760，目标页 top 相应从约 146.370 移至 1610.130，scrollTop 保持约 7662.333。目标离开被动 IO 的扩展下界 1450 后回到 idle。来源为 `.cache/qa/20261028-regression-01/07-source-e2e-r2/` 与 `07-dpr3-diagnostic-r2/{observations.json,finding.json}`；探针没有执行纠正滚动。最初私有脚本序列化失败仍保留，不算产品结果；探针本身也不算原回归通过。

本次只改 `PdfViewer.tsx`、`reader.css` 和独立 reader spec，另更新本报告与模块记录；`PdfPage.tsx` 保持原样。产品候选采用以下方式：

- 导航、恢复、缩放及有效 fit 建立带文献身份、PDF 对象和页码的目标锚定；定位每次读取目标的实际矩形，以增量调整阅读容器 scrollTop，并记录浏览器钳制、舍入后的实际位置。
- 一个 ResizeObserver 观察各页占位元素及阅读容器。逐页尺寸通知按批次补偿一次，因此前页变高、后页变矮而总高度相抵时仍能纠正目标。只在明确命令或尺寸通知时定位，没有无限逐帧拉回、没有延长 IO 缓冲或渲染超时。
- wheel、touch、pointer、滚动按键、新导航、换文献、卸载均取消旧锚定。scroll 事件与最后程序写入不一致时也取消，覆盖没有可捕获指针事件的原生滚动条。锚定期间才关闭浏览器自身 scroll anchoring，取消即恢复默认；程序补偿事件不会把当前页改成暂时露出的前页。
- 待提交的定位意图绑定命令序号。用户取消会同时清掉意图；即使旧 scale/fit 状态随后提交，布局阶段也不能重建过期锚定。没有排队定位 RAF 可在取消后回拉旧页。
- Canvas、TextLayer、文字/坐标借用接口和离屏资源释放保持原有机制；没有全书 Canvas 渲染。PdfPage 的 `800px` rootMargin 和页面门禁没有改动。

测试保持原五档 DPR、原几何 `<0.1` 误差阈值及真实鼠标选字。原 DPR 3 用例在首次 navigate(13) 后、fit 和 `scrollIntoViewIfNeeded()` 选字辅助之前，增加 **4 秒被动稳定观察**，连续核对当前页、Canvas/TextLayer、rendered 与实际可见位置；取样在 rAF 后任务中读取，以避免把 ResizeObserver 补偿前、尚未绘制的中间态误报为可见漂移。取样不写 scrollTop、不调用纠正滚动，也没有增加已有超时。

另加一例 DPR 3 用户取消场景：先验证导航稳定，再真实滚轮滚动，核对 scrollTop 增长及第 13 页相对阅读区保持在上方，避免前页增长令 scrollTop 数值假通过；随后连续发出 14→16 导航，观察 2 秒确认最新目标保持可见。该 spec 现为 9 例；四秒稳定窗口及取消场景的观测写入 JSON 附件，失败也保留。

本轮只执行局部严格类型、零警告 lint 和差异空白检查，均退出 **0**：

```powershell
pnpm exec tsc --noEmit -p .cache/reader/20261028-navigation-01/tsconfig.reader.json
pnpm exec tsc --noEmit -p .cache/reader/20261028-navigation-01/tsconfig.tests.json
pnpm exec eslint src/renderer/src/features/reader/PdfViewer.tsx src/renderer/src/features/reader/PdfPage.tsx tests/e2e/reader-verification.spec.ts --max-warnings=0
```

证据位于 `.cache/reader/20261028-navigation-01/` 的 `reader-types.log`、`test-types.log`、`lint.log`、`diff-check.log` 与 `protected-paths.json`。独立静态复核提出的“取消后排队缩放重新建锚”和“仅看 scrollTop 的测试假通过”均已补强，最终未发现确认阻断。

基线比对另发现 `docs/verification/qa.md` 与 06 不同，本模块未写该文件，差异来源未核实；其余 135 个非本轮修改路径一致。该差异保留在 protected-paths.json，交主控冻结时核对，不覆盖其他模块文档。

**reader 本轮未启动 Electron、未构建或运行任何测试。修复与新断言均未记为桌面通过。** 请 qa 统一重建后定向执行及完整回归：

```powershell
pnpm exec playwright test tests/e2e/reader-verification.spec.ts --workers=1 --grep "DPR3 navigation|simulated DPR 3"
```

原生滚动条、触摸/键盘、末页不足屏高时的浏览器钳制、快速取消时序及 600 页观察开销仍须动态确认。DPR 是进程模拟，不能替代物理显示器验证。

## 2026-10-28：修订版 2 的测试回调传参修正，完整 DPI 回归待执行

任务与轮次仍为 `PFV-READER-002` / `20261028-fit-width-01`，任务修订版 2。qa 已真实确认 fit-width 正向单例通过：第 13 页变为 65%，Canvas 宽 812.5 CSS 像素，位于可用 821 像素内；左右边界为 276.25–1088.75，阅读可用边界为 272–1093，scrollLeft 为 0。随后源码桌面全套为 **14 通过、5 失败**，失败对应 DPR 1/1.25/1.5/2/3 的旋转用例，均在测试第 153 行等待时得到 Infinity，尚未采到页面几何结果。依据为 `.cache/qa/20261028-regression-01/summary.json` 及 `07-source-e2e/summary.json`，原失败日志保持原位。

静态核对发现该行 `Locator.evaluate` 直接引用 Node 侧局部变量 expectedWidth，却没有通过回调参数传入浏览器。此为确认的测试上下文错误；原日志只显示捕获后转成的 Infinity，没有保存底层异常原文。本次唯一测试改动为把 expectedWidth 作为 evaluate 参数显式传入，再由浏览器回调的 width 参数参与计算。原 `<0.1` 断言、几何验证、真实鼠标拖选、原异常捕获及全部五档 DPR 均保留，其余 evaluate 回调只读检查后未发现同类外部引用。

本次对冻结的两个产品文件没有任何修改。前后 hash 均与此前提交值一致，证据在 `.cache/reader/20261028-fit-width-01/revision2/frozen-products-before.json` 和 `frozen-products-after.json`；测试前后逐行比对只差第 153 行，见 `harness-change.json`。

本次实际局部检查均退出码 **0**，lint **0 警告**：

```powershell
pnpm exec tsc --noEmit -p .cache/reader/20261028-fit-width-01/revision2/tsconfig.harness.json
pnpm exec eslint tests/e2e/reader-verification.spec.ts --max-warnings=0
```

日志分别为上述 revision2 缓存内的 `types.log`、`lint.log`。reader 未构建或启动桌面；测试回调修正后的五档 DPI 仍交 qa 真实完整重跑，不能由局部静态检查推定通过。另有“异步 fit 点击后立即读取 zoom 可能取到旧倍率”的静态等待风险，本次没有动态证据，也未扩展授权改动；若重跑触发，须保留新失败再核定。

## 2026-10-28：第一候选的产品修复与静态检查记录

新任务 `PFV-READER-002`，轮次 `20261028-fit-width-01`，基线 `PF-VERIFY-20261028-02`。仅修改 `PdfViewer.tsx` 与 `reader.css` 两个产品文件；原正向测试、PdfPage、坐标/共享接口、依赖和构建配置均未改动。本次受保护的 13 个路径与新基线 hash 均一致，见 `.cache/reader/20261028-fit-width-01/protected-paths.json`。

qa 已真实执行此前的独立正向单例并失败：第 13 页点击前后均为 133%，Canvas 宽 1662.5 CSS 像素，可用宽度 821，左右边界 668.4375–2330.9375，阅读可用边界 272–1093，scrollLeft 为 89；共保留 18 个采样，未记录页面异常。来源为本机 `.cache/qa/fit-width-probe/attempt-20261028-092818/summary.json` 及同目录 `mixed-size-fit-width-observations.json`，reader 已读取原始附件；摘要另保存于本轮缓存 `qa-before-summary.json`。该失败使用原创合成几何 PDF，属于真实桌面执行，不能与先前 Node 单测或物理 DPI 验证混为一谈。

修复内容：

- “适合宽度”读取当前页实际 PDF.js `getViewport({scale:1})`，因此尺寸包含旋转、CropBox 和 UserUnit；以阅读区客户宽度减实际内边距计算可用宽度，向下保留两位倍率，维持 50%–300% 边界。
- 页面列宽度固定为阅读区宽度，移除由其他宽页撑宽整列的约束。窄页沿用已有 auto margin 居中，超宽页从左侧溢出并保留横向滚动；有效 fit 提交后的布局帧恢复目标页并清零横向滚动。同倍率 fit 也会触发该定位。
- 新 fit、手动缩放、导航、滚动换页、文献切换与卸载使旧请求失效；提交前核对请求序号、PDF 对象、目标页及根元素。文献身份也在加载异步返回时复核，防止旧加载重新激活 PDF。两层定位动画帧均可取消，过期帧不拉回旧页。没有主动清理正在由 PdfPage 使用的页面资源，onPageData 借用接口保持。

本轮实际仅执行以下局部静态检查，均退出码 **0**，最终 lint **0 警告**：

```powershell
pnpm exec tsc --noEmit -p .cache/reader/20261028-fit-width-01/tsconfig.fit-width.json
pnpm exec eslint src/renderer/src/features/reader/PdfViewer.tsx --max-warnings=0
```

最终日志为本轮缓存 `types.log`、`lint.log`。首次 lint 清理回调 ref 警告保留在 `lint-initial-warning.log`；修复后通过稳定的失效函数递增当前请求，未关闭规则或改为恢复旧序号。

**第一候选提交时未构建、未启动 Electron、未修改或执行测试，当时尚未计为桌面通过。** 后续 qa 的单例通过及完整回归失败见上节；快速 fit 后换页、换文献、手动缩放与卸载的时序仍需动态确认。若页面在 50% 下仍超宽，现有最小倍率限制保持，不能宣称所有页面必然无需横向滚动。

## 2026-10-27：PFV-READER-001 历史准备与单测证据

任务 `PFV-READER-001`，轮次 `20261027-verification-01`，任务修订版 3。基线为 `PF-VERIFY-20261027-01`，Git 提交 `0779111916f8ab3360619e5302cd83e2dd823168`。reader 未修改产品源码、共享 helper、依赖、锁文件、构建配置或 Git 索引。上一轮对源码及配置的 38 份文件逐项比对均与基线一致，证据在 `.cache/reader/baseline-check.json`；该记录是当时快照，不代表其他模块后续修改后的整个工作区仍无差异。

本次续作将报告改为中文、增加独立适合宽度用例、修复 qa 检出的素材脚本类型推断问题，并更新本模块交接与信号；没有重跑已完成的素材生成或单测，没有启动 Electron 或执行公共全套检查。

## 已执行的验证与证据

以下命令此前在 `<repo-root>` 执行：

```powershell
pnpm exec tsx scripts/verification/generate-reader-fixtures.ts
pnpm exec vitest run tests/unit/pdf-geometry.test.ts
```

素材生成两次成功，三份 PDF 的 SHA256 均一致。`tests/fixtures/verification/reader/manifest.json` 保存来源、许可证、准确 SHA256 和页面尺寸。正文及矢量图形均为原创合成内容，没有复制外部 PDF。仅使用已安装的 `pdf-lib` 1.17.1 和 `pdfjs-dist` 6.4.299，没有新增依赖。已检查本机可执行命令 `qpdf`、`gswin64c`、`mutool`、`pdftk`，均未找到；已安装 pdf-lib 的说明未提供加密写入能力。

原创加密生成器参照 [Adobe PDF Reference 1.4 第 3.5 节、算法 3.1–3.4](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.4.pdf)，实现 Standard `/V 1 /R 2`。该外部规范的再分发许可证及文件 hash **未核实**；本项目仅引用规范，没有下载或再分发其文件字节。此旧式算法只用于兼容性测试，不代表已覆盖 AES 或全部加密修订版。

最终定向 Vitest 为 **22/22 通过**，共一个测试文件。测试使用真实 PDF.js 解析器及实际 `PDFPageProxy.getViewport()`，直接导入产品坐标函数；没有替换解析、密码异常或坐标转换。

| 检查 | 实际结果 |
| --- | --- |
| 加密 PDF，无密码 | 真实 `PasswordException`，code 1 |
| 加密 PDF，错误密码 | 真实 `PasswordException`，code 2 |
| 正确用户密码与所有者密码 | 两者均读取有效绘制指令列表及正文 `PaperFlow encrypted original text` |
| 页面几何组合 | 16 个实际页面 × 7 档缩放（0.5–3）× 4 档 outputScale，共 448 组 |
| 点坐标 | 5,376 次独立预期值、逆变换及窗口客户区转换比较；最大误差 `2.2737367544323206e-13` |
| 矩形坐标 | 448 次比较；最大误差 `1.2789769243681803e-13` |
| 600 页素材 | 全部页面绘制指令列表有效；第 1/300/600 页正文标记各异；Node 解析循环约 607 ms |

Node 计时不包含桌面启动、沙盒导入、文件复制、页面渲染或物理显示过程，不能据此宣称产品 20 秒校验器已接受此文档。CSS/PDF 坐标结果不依赖 Canvas 物理像素的 outputScale。

日志位于 `.cache/reader/`：`generate.log`、`generate-repeat.log`、`vitest.log`、`geometry-metrics.json`。初始测试工具的两次失败均保留：`vitest-initial-failure.log` 为 Windows 字体路径末尾分隔符；`vitest-teardown-failure.log` 为 22 项断言已通过后，清理步骤误用已移除的 document.destroy 接口。最终改用 loadingTask.destroy，整文件通过。现有 Vite 原生配置加载警告仍保留在日志中。

qa 随后核实 `generate-reader-fixtures.ts:93` 存在 TS7022：页码变量与页面数组的推断形成间接自引用。原错误证据从 qa 日志复制保存为 `.cache/reader/qa-initial-test-types.log`。本次仅为页码变量增加明确的 `number` 类型，未改变生成逻辑。以下隔离严格类型检查包含本模块新增生成器、单测、E2E 及其导入类型，结果为**通过，退出码 0**；配置和结果分别保存在 `.cache/reader/tsconfig.reader.json`、`test-types.log`：

```powershell
pnpm exec tsc --noEmit -p .cache/reader/tsconfig.reader.json
```

## 已准备、交 qa 执行的桌面测试

以下测试均**尚未由 reader 执行或确认通过**：

```powershell
pnpm exec playwright test tests/e2e/reader-verification.spec.ts --workers=1
```

现在共 8 例：真实加密导入拒绝且文献不新增；600 页导入、首/中/末/首页导航、本地 Worker、远页 Canvas 释放及驻留 Canvas 数量；独立混合尺寸页面适合宽度；以及 DPR 1/1.25/1.5/2/3 的五例进程模拟。

DPI 用例采用由 qa 维护的 `launchApp(dataDir, {deviceScaleFactor})`，并读取实际 DPR 核对生效；当前共享 helper 已只读确认具备该可选参数。每个旋转方向结合偏移 CropBox、UserUnit 2.5，检查 CSS 尺寸、TextLayer/Canvas 对齐、Canvas 像素上限，以及缩放前后通过真实鼠标拖选完整的页码文字标记。几何观察值在断言失败时也会写入测试附件。本模块隔离类型检查已通过；公共类型、格式、构建和桌面执行由 qa 统一完成。

这些结果不能替代原生文件框完整选文件操作、物理显示器、跨显示器 DPI 切换、安装卸载或最终包实测。测试 helper 仅注入原生文件框返回值，后续导入与渲染路径保持既有真实执行方式。

## 混合尺寸适合宽度的独立复现

单独交 qa 的精确命令：

```powershell
pnpm exec playwright test tests/e2e/reader-verification.spec.ts --workers=1 --grep "PFV mixed-size current page fits available reader width"
```

用例导入同一份 `geometry.pdf`，从宽度 612 的首页切至第 13 页；目标页具有偏移 CropBox 和 UserUnit 2.5，天然视口宽度为 1250 CSS 像素。先核对目标页文字及最低 50% 缩放的可容纳前提，再点击“适合宽度”。

正向验收要求：当前页保持为第 13 页；其已完成渲染的 Canvas 宽度不超过阅读容器实际客户区扣除实测左右内边距后的宽度，Canvas 左右边界也完整落在该可用范围内，容许 1 CSS 像素误差。断言直接测量 DOM 边界和计算样式，没有套用产品 onFitWidth 的倍率计算公式。等待过程轮询渲染及边界，不要求一定发生重新渲染，避免“倍率未变”导致错误等待。点击前后测量值及页面错误会附在 `mixed-size-fit-width-observations` 中，失败也保留；点击后不额外滚动来替产品纠正页面位置。

源码检查提示 onFitWidth 可能继续使用首页宽度；以上用例用于核定该风险。本模块没有启动桌面，**目前仍为待复现问题，不能登记为已确认缺陷或已通过**。

## 保留的限制与风险

- Canvas 驻留数量有界不等于总内存有界。当前阅读器仍保留全部页面占位 DOM 与观察器，滚动时逐页扫描；600 页不证明任意页数的性能。
- 产品 20 秒校验预算未调整。桌面导入若超时，须记录为失败或边界，不能通过缩小素材掩盖。
- DPI 用例中的“适合宽度”只用于触发缩放；其功能正确性由新增独立用例验证，该用例尚未执行。
- E2E 与五档 DPR 仍是待执行状态；物理硬件 DPI 行为未验证。
