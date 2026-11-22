# 文字与公式空白拖拽修复候选

## 阶段 H：修订版 8，普通手势独立维护选区与有界边缘滚动

候选14的源码新20与原20实际通过，新包完整40却为 **37通过、3失败**；三败均在200%/DPR2，分别仅复制末字 `K`、公式主段 `E=mc`、分子夹入分母及远处正文。原始来源为 `.cache/qa/20261028-selection-regression-01/r7-07-new-package-40/playwright.json`，不能据源码通过替代新包验收。ASAR与out一致；追加 `r7-08-packaged-gap-diagnostic` 三例、`r7-09-minimal-fraction-trace` 单例均未复现，原诊断脚本的时序差异与盲区在QA审计中保留。**本轮不把未复现诊断当成原三败已定位或已消失。**

独立静态核对确认：原普通真字mousedown及文字内move仍放行浏览器默认选区，selectionchange又校正端点，mouseup马上释放控制器，存在两个机制同时维护端点的时序窗口。主控正式放行消除这一静态风险。r7产品、原20测试、旧报告和hash已先存 `.cache/reader/20261028-selection-01/revision8/`；这不代表该窗口已被证实为上述新包三败的运行根因。

revision8仅对阅读客户区内、无修饰主鼠标detail1接管：mousedown先preventDefault，焦点转向阅读区后重新核对原root、文字节点/offset、登记与客户区/滚动几何，再立即初始化真实DOM Selection；所有后续自管move和mouseup均阻止原生默认选区并由同一控制器更新focus。官方TextLayer、原始items/索引和真实字符Range保持。双/三击、修饰键起拖、touch/pen、工具栏及原生滚动条在接管前旁路；手势中加入修饰键会终止自管并保留当前选区，不承诺中途无缝切回原生拖选。复制事件继续不拦截。

焦点保护复用现有同步导航标记：ReaderToolbar页码input的onBlur可能提交不同页，PdfViewer.navigate会同步beginAnchor、设置 `data-navigation-anchor` 并对齐。focus后若该标记激活、实际几何/滚动或命中身份改变，仅取消这次起拖，保留页码提交；未改页码、命中与视口未变时允许第一次直接拖选，不要求再点一次。未修改Viewer或共享接口。

阻止原生默认行为可能移除浏览器自动滚动，因此新增一个绑定当前手势的RAF：只有合法按住、同root客户区内36px边缘带、真实鼠标向边缘移动建立的意图才滚动；静止指针可保留意图，向内或离开客户区清掉意图。速度最高480 CSS px/s、每帧dt最多32ms，累积亚像素余量，按真实可滚动范围判定边界。真实move才采样指针线段；RAF和scroll事件只按当前client点与最新DOM Range重命中，不重放旧路径、不建立新意图、不写回scroll形成循环。

mouseup、pointercancel、window blur、Escape/修饰键、按钮丢失、离开文档、root失焦或相关页撤销统一停止手势及RAF。原点层或最后文字撤销后停止，不新增Canvas pin；现有800px挂载余量只支持待测的有限相邻页范围，不能据两页用例宣称任意跨页。RTL、组合字形、任意角度旋转及全部触摸/笔设备仍未完成动态验证。自动滚动不会扩大空白命中；focus仍必须来自实际合法字符或最后合法文字的边界。

本轮新增交互回归正在原文件末尾追加，原20点/断言保持，覆盖普通松开后稳定与复制、多击/Shift、静止指针边缘滚动/相邻页、释放停止及页码焦点。reader只作局部类型与lint，**未build、未GUI、未打包、未写out、未执行E2E**；最终局部结果与新增数量以本轮报告和revision8日志为准，所有真实行为交QA门禁。

## 阶段 G：修订版 7，命中空格的严格相邻字符候选待 QA

候选 `PF-SELECTION-20261028-13` 的原20项真实结果为 **19 通过、1 失败**，见 `.cache/qa/20261028-selection-regression-01/r6-04-source-selection-20/playwright.json`；唯一失败为 page1-100% 公式反向起点。该结果仍未达到选择门禁通过，全部失败原件保留。

QA `r6-05-formula-advance-diagnostic/geometry-facts.json` 已独立证实：下标 `1` 的 `--scale-x=1.2`，实际字符 Range 为 `[540.46875,547.6687622] × [426.09375,438.09375]`，严格覆盖固定点 `(547.3,432.5)`；实际宽约7.2，r5尺度修正已生效。但同一点的 elementsFromPoint 只返回推断空格和容器等节点，遗漏该字符，caret 也返回空格。该证据不支持继续扩大字符宽度、调整测试点或增加容差。

主控据此正式放行 revision7，只改选择控制器：在 attach 时按公开 textDivs 原始顺序登记严格索引前后各一项，不跳过空项寻找远处文字。仅当当前点实际叠层命中登记的非空纯空白 textDiv 时，追加这两项候选；候选必须仍连接、属于相同登记 layer，并继续通过原0.25容差的逐字符 Range 含点验证，边界仍只在已验证字符两端之间确定。两邻同时可命中则拒绝歧义，不任意选取，也不全页查最近文字。

原 dragstart 守卫在已有合法、非 blocked、无修饰普通鼠标手势、anchor/lastText 登记及同阅读区来源的约束下，允许登记空格作为原生拖放来源，以覆盖浏览器实际命中来源与合法文字不同的情况。初始空白仍为 blocked，未登记或其他 UI 不拦；真正 pointercancel 处理不变。

局部 product/test 严格类型及三个产品文件零警告 ESLint 均退出 **0**，独立日志、改前控制器、前版报告和最终 hash 在 `.cache/reader/20261028-selection-01/revision7/`。除控制器外，布局 helper、PdfPage、测试、生成器、PDF、manifest 与 r6 hash 一致；没有修改坐标、字号、原始 items/索引/撤销语义或有效文字精确断言。源码 ready 供主控捕获；未构建、未启动 Electron、未写 out、未执行 E2E。**r7 的剩余反向用例及全20项真实选择复制仍待 QA，不宣称通过。**

## 阶段 F：修订版 6 的历史原生文字拖放守卫

主控已核 QA `.cache/qa/20261028-selection-regression-01/r4-07-passive-drag-diagnostic/minimal-drag-facts.json` 并正式放行。200% 原坐标诊断记录可信 `dragstart`，target 为 `LEFT_ALPHA_TARGET_12345678` 的 Text，DataTransfer 含 `text/html` 与 `text/plain`；当时选区0→1为 `L`。约5.6ms后发生 pointercancel，随后24个 drag、22个 dragover 和一次 dragend；终点折叠 caret 最近 offset26 正确。该探针已确认浏览器进入文字拖放流，不能再将同次取消解释为几何最近点错误；原20项11过9败的记录不被此诊断覆盖。

revision6 相对 r5 仅在 `text-selection.ts` 增加一个 capture dragstart 监听，沿同一 AbortController 释放。仅当当前已有合法、非 blocked 的普通鼠标 PDF 选择手势，无修饰键，anchor/最后文字仍为连接的登记文字，且拖放源属于相同登记阅读区的非空白 textDiv 时调用 preventDefault。兼容 QA 实际记录的 Text target，也允许该公开文字节点的 HTMLElement 来源；工具栏、未登记节点、不同阅读区、空白起拖及多击/修饰键旁路不满足守卫。既有 pointercancel 仍终止手势，未忽略真实取消，也没有全局禁拖。

r5 的布局 helper、PdfPage、新测试、生成器及素材 hash 均保持一致，见 `.cache/reader/20261028-selection-01/revision6/final-hashes.json`。实际局部 product/test 严格类型检查和三个产品文件零警告 ESLint 均退出 **0**，日志独立保存在 revision6。源码 ready 供主控捕获冻结；未构建、未启动 Electron、未写 out、未运行 E2E。**受限守卫能否恢复原鼠标序列、反向公式与真实复制仍待 QA，不把静态通过当成交互通过。**

## 阶段 E：修订版 5 的历史布局与命中修复

候选 12 原 20 项实际为 **11 通过、9 失败**，来源 `.cache/qa/20261028-selection-regression-01/r4-04-source-selection-20/playwright.json`。100% 正向文字及四种组合的正向/单步公式已出现完整目标与真实复制；反向起点仍有空白 span 命中，200% 与旋转页 DPR3 文字只得到 `L`。测试组在首个失败手势停止，后续手势未执行不能计为通过。

主控正式放行 revision5，只修已有证据的两项：

- 单字符尺度：既有公式正向选区中，下标 `1` 的 Range 宽 6 CSS px，而原创 PDF 的 advance 为 7.2；反向固定点 x547.3 超出原 Range 右边界546.46875。公开 PDF.js 的 `#appendText` 默认仅为多字符或明显非等比单字符设置宽度缩放。新增内部 `text-layer-layout.ts` 在官方 TextLayer.render 完成后、登记及 ready 前，按含 str 的原 items 顺序对应公开 textDivs；不删除空 str 索引、不计 marked-content 为文字节点，仅校准一个非空白 Unicode 字符。期望 advance 为 `(vertical ? item.height : item.width) × viewport.scale × viewport.userUnit`；用当前 computed font 的 measureText 宽度乘 computed transform 的本地 x 轴基矢长度得到实际 advance，再按比例调整既有 `--scale-x`。不把旋转 AABB 宽度当 advance，不乘 DPR，不改字号、位置、旋转或原始 items。
- 空格截获：QA `r4-05-passive-geometry-diagnostic/text-reverse-100-geometry-summary.json` 的实际叠层包含顶层推断空格和下层正文。正文起点648.5位于正文 Range 内，原生 caret 却指向空格。控制器保留 caret 快路径；失败后只遍历该点 elementsFromPoint 返回的、登记为公开 textDiv 的实际叠层，并逐字符验证 Range 含点，仍使用原0.25容差。验证成功后仅比较该字符两端确定边界，不扫描全页寻找最近文字，也不把空白字串当合法命中。

200% 截断尚未在本轮盲改。QA `text-forward-200-event-summary.json` 确认唯一一次按键中 mousemove 的 Pointer/Mouse 匹配成功，caret=1、选区为 `L`，其后约1.1ms出现 pointercancel，再无后续 move/up。被动终点审计的折叠 caret 最近项明确是26，而非1；因此该探针不支持“配对丢失小数”或“nearestBoundary 扫到1”的归因。原生文本拖放只是解释取消的候选机制，尚无 dragstart 证据，且探针可能影响时序；不能据此断言原20项均同因。Pointer配对、nearestBoundary、取消语义保持，等待 QA 后续证据。

实际 product/test 严格类型检查及三个产品文件的零警告 ESLint 均退出 **0**，日志在 `.cache/reader/20261028-selection-01/revision5/`。内部两项只读复核未发现确认阻断。测试、生成器、PDF、manifest 的 hash 保留；未移动目标点、改有效字符串断言或增加容差。未构建、未启动 Electron、未写 out、未执行 E2E。**修订版5只提交候选，文字/公式/反向/旋转与性能均待 QA，200% 输入取消还需独立定位。**

## 阶段 D：修订版 4，候选 12 的历史起点修复

候选 `PF-SELECTION-20261028-11` 的实际结果已核对：`.cache/qa/20261028-selection-regression-01/r3-04-source-selection-20/playwright.json` 为 **10 通过、10 失败、0 跳过**，仍不能交付。其 `extracted-attachments/PFV_selection_text_page1-100pct-dpr1-0/selection-observations.json` 中，`text-to-gutter` 在 mousedown 正确命中 `LEFT_ALPHA_TARGET_12345678` 的 Text，anchor/focus 均为 0；mousemove 后 anchor 变为 25、focus 为 26，mouseup 和真实剪贴板均只剩 `8`。原记录与截图保留，没有把前两候选失败覆盖或计作通过。

主控据此正式放行 revision4。对照上一版控制器，可确认 selectionchange 曾把浏览器漂移的 anchor 回写为本次手势起点。修订版 4 仅作最小修正：普通无修饰单击拖拽的初始合法 anchor 为只读；真实文字内只更新 focus 并恢复选区，空白内仍投影 focus，selectionchange 统一恢复该手势的固定起点和当前终点，不再采纳漂移 anchor。mouseup 先作最终端点修正再释放手势；端点相等时不再设置 Selection，以终止自身触发的异步通知循环。

原 TextLayer、DOM 原始顺序、原始文字/viewport/索引与释放接口保持；多击和修饰键的原生旁路保留。没有更改测试瞄准点、字符框容差、素材或有效文字/公式的精确断言。新测试文件 hash 与候选 11 一致，见 `.cache/reader/20261028-selection-01/revision4/final-hashes.json`；改前控制器及上一轮报告保存在同目录。

实际仅执行局部 product/test 严格类型检查和控制器零警告 ESLint，三个日志均为退出 **0**：`revision4/product-types.log`、`revision4/test-types.log`、`revision4/lint.log`。内部只读复核未发现确认阻断；这不是动态测试证据。主控已捕获并冻结 `PF-SELECTION-20261028-12`，reader 不再修改产品、测试和素材，未构建、未启动 Electron、未运行 E2E。**候选 12 的真实文字、公式、反向/返回、单步快速拖拽及复制仍待 QA 复验，不能声称已修复。**

## 阶段 C：修订版 3，候选 11 的历史坐标修复

冻结候选 `PF-SELECTION-20261028-10` 的新选择测试实际为 **5 通过、15 失败**。正文、公式、分子及 mouseup 后控制词等多项在 mousedown 时已成为空选区；这是真实回归，候选 10 不可据局部静态通过宣称可交付。原 `09-source-selection-20`、`10-passive-hit-diagnostic`、`11-passive-event-coordinate` 的结果保持原位，没有覆盖失败。

主控已依据 qa `11-passive-event-coordinate/minimal-facts-r2.json` 正式放行阶段 C：测试请求 `(430.9,245.5)`，实际兼容 mousedown 坐标为 `(430,245)`。事件 target 仍是正确文字 SPAN，但用整数重新查询 elementFromPoint/两种 caret API 都得到文字层 DIV；原始小数点的标准 caret API 则命中正确文本节点 offset 0，首字符 Range.left 为 430.5。当前控制器据整数拒绝真实文字，随后走了空白清选区分支。证据没有内部 tracing，因此不把后续字符容差比较说成已经执行；也没有据此修改容差或瞄准点。

修订版 3 只改控制器与一处已获准的空选区复制断言：

- 捕获真实鼠标 PointerEvent 的小数位置，供紧随的兼容 mousedown/move/up 一次性消费。配对核对事件阶段、target、buttons、可信标记及坐标量化差；不匹配则用该 MouseEvent 原坐标，不凭空加偏移，也不复用已消费样本。
- 阅读区命中、caret/字符框、真实路径采样和最终端点投影统一使用准确位置。现有 0.25 字符框容差保持不变，PDF/Canvas 测试目标点和所有有效文字、公式精确断言保持不变。
- pointercancel、blur 和最后登记注销同时清掉坐标样本。原 TextLayer、原始文字/viewport/索引及资源释放接口没有变化。
- 仅当真实选中文字严格为 `''` 时，Ctrl+C 允许剪贴板为 `''` 或原哨兵；任何正文或公式仍不得进入剪贴板。有效选区仍精确匹配目标。旧灰底用例“空选区且剪贴板被清空”单独作为复制行为边界，不能当成远处正文误选。

PdfPage、生成器、PDF 与 manifest 四个关键文件与候选 10 的 hash 一致，见 `.cache/reader/20261028-selection-01/revision3/unchanged-fixtures-product.json`。旧版本与原失败均保留；新局部检查日志在 revision3 子目录，product/test 严格类型与零警告 lint 均退出 **0**。命令仍为下方相同局部检查，仅日志输出目录改为 revision3。

**reader 未启动 Electron、未构建或运行 E2E。修订版 3 的普通选择、公式、单步拖拽和复制尚未证明通过，代码 ready 冻结后由 qa 重跑原 20 项及回归。** 原样保留的旧候选记录与限制如下。

## 阶段 B：候选 10 的历史实现和素材准备

任务 `PFV-READER-004`，轮次 `20261028-selection-01`，修订版 2，基线 `PF-CONTINUE-20261028-09`。主控已依据 qa 旧包真实鼠标证据正式放行阶段 B。本报告只记录已核实证据、候选改动和待测项，不把静态检查写为交互通过。

## 已确认的旧包现象

来源：`.cache/qa/20261028-selection-regression-01/02-old-valid-probe-host-permission/observations.json`。旧包运行真实 PDF.js，使用项目原创 `valid.pdf`；文件框仅注入返回值，后续导入、绘制与鼠标均真实。探针从 Canvas CSS 框和已知 PDF 坐标发起，没有用透明 TextLayer 自身位置瞄准。

- `blank-left-down` 整段位于 PDF x=20 的空白页边，却从空选区变为多行正文，并包含 `E = mc2`、`f(x) = x + 1` 与图注。
- `blank-left-up`、`blank-right-up` 也出现远处正文和公式；`blank-formula-to-gutter` 最终为空。不能把所有空白动作一概记为失败。
- `body-to-left-margin`、`formula-to-right-blank`、`formula-to-left-margin` 的原始结果分别保留，后两项实际为换行或 `E = ` 等片段。本轮不据此声称任意公式应复制成 LaTeX。

reader 的只读摘要保存为 `.cache/reader/20261028-selection-01/old-failure-summary.json`。原探针的 Windows CRLF 直接比较错误、app.close 后读取 process 的工具错误保持原样，均不算产品根因。

## 静态核对与最小候选

已核对本机 pdfjs-dist 6.4.299（Apache-2.0）上游源码。基础 TextLayer 按文字 items 创建 DOM；官方 Viewer 另有 TextLayerBuilder 的 endOfContent、拖选和 selectionchange 协调，且部分旧 Chromium 启发式在新版会跳过。本项目没有直接复制这些旧启发式，也没有改用 Builder 丢弃公开 TextLayer。

现有旧选择测试从透明 span 自身边界拖拽，只能证明文字层可以被选，不能独立排除图文命中偏离。全局字体继承、字形回退及公式内容流顺序是需实测的其他因素；尚无证据证明全部用户现象均源自这些因素，候选也不声称修复任意字体的字符偏移。

新增内部 `text-selection.ts`，PdfPage 在官方 TextLayer.render 完成后登记公开 textDivs 及 scrollRoot：

- 只在阅读容器客户区处理无修饰主键鼠标，包含白页边、栏间和灰色页外背景；客户区不含原生滚动条，工具栏不在此范围。真实文字起拖按实际 hit 所属 layer 绑定，空白手势按 root 绑定，避免首个注册页离屏误取消后页手势。
- 命中先通过浏览器 caret API 定位，再检查前后相邻非空白字符的 Range 布局框，不以整条 span 外框判真命中。它仍是字符布局盒，不是 Canvas 墨迹像素检测；任意角度旋转、连字和特殊字体边界不能据静态检查宣称完备。
- 空白起拖阻止该手势的原生远处吸附，并仅在这次显式无修饰空白按下时清掉旧选区。文字起拖仍由浏览器创建普通选区；拖入空白时保留原 anchor 和方向，只将 focus 限制在最后合法文字节点的最近 caret 边界，重入真实文字后恢复原生行为。
- 实际鼠标事件可能从首 span 一步跳到公式后空白，因此控制器在真实指针线段内做有上限的局部字符命中采样，不依赖测试人为增加 move steps，不扫描或重排全页阅读顺序。
- Shift/Ctrl/Alt/Meta、多击、右键、触摸/笔输入保留原生；手势中加入修饰键、Escape、mouseup、blur、取消或相关页面注销会终止接管。不拦复制事件。全局监听由登记集合统一 Abort 清理；先注销再移除页面 DOM。

官方 TextLayer 对象、原始 textContent、viewport、items 索引、onPageData 及 null 撤销语义保持。没有接入 OCR、云服务或翻译，没有图片替代文字；PdfViewer 导航、engine、共享接口、page.css 及其他测试未修改。

## 原创素材与独立正向测试

生成器：`scripts/verification/generate-selection-fixtures.ts`。PDF 为 2,634 字节、两页、SHA256 `c557bc4712ccc28c2213039a080319835449c24f9d33ad9e718632dae33e5419`。多次生成 PDF hash 一致。第 2 页为 90°旋转；原始文字/上下标/分数/干扰标记及 19 条手势均见 `tests/fixtures/verification/selection/manifest.json`。生成过程中已用真实 Node PDF.js 核对页数、旋转及文字 items；这不是桌面渲染通过。

独立 `selection-verification.spec.ts` 共 20 例：五组行为 × 四种页面/倍率/DPR 组合（普通页 100%/DPR1、200%/DPR2，旋转页 100%/DPR1、100%/DPR3）。先缩到 50%，再精确放大，避免初始 fit 如 136% 时用 ±10 无法达到 100%。灰底出页的文字案例使用可在高倍率下完整容纳的独立控制词，不穿过另一栏字形。

拖拽点仅来自素材 PDF 坐标、独立直角旋转映射和 Canvas **CSS** 框；DPR 不乘入 CSS 坐标。灰底点来自阅读客户区与 Canvas 位置关系。拖拽前按这些已知区域设置滚动位置并核对点实际可见；手势开始后不纠正滚动，不编程构造 Selection，也不在各手势之间调用 removeAllRanges 掩盖恢复错误。文字层节点和 rects 只用于事后诊断，不用于生成鼠标路径。

每条手势保存 PDF/CSS 起终点、实际 DPR/倍率/滚动/Canvas 像素尺寸、mousedown/move/mouseup 选中文字、anchor/focus/offset、Range rects、elementFromPoint 命中、前后截图与真实 Ctrl+C 剪贴板。复制前设置唯一哨兵。断言精确目标且不含邻栏/邻行/远处公式标记，仅规范化空白以兼容换行；不会删除干扰字符来凑通过。`formula-single-step` 明确只执行一次 mouse.move。mouseup 后的普通选择和双击不通过清空 Selection 来恢复。

纯空白开始的整次拖拽不延迟建立新 anchor；若用户本意从空白扫入文字开启选择，这是本次命中规则的明确边界。正常跨行/跨页落入实际文字时仍保持浏览器原生选择及原 PDF 流顺序；跨多行夹入另一栏、缺 ToUnicode、复杂数学语义复制等不扩成阅读顺序引擎。

## 实际验证与待执行

实际已执行并退出 0：

```powershell
pnpm exec tsx scripts/verification/generate-selection-fixtures.ts
pnpm exec tsc --noEmit -p .cache/reader/20261028-selection-01/tsconfig.product.json
pnpm exec tsc --noEmit -p .cache/reader/20261028-selection-01/tsconfig.tests.json
pnpm exec eslint src/renderer/src/features/reader/text-selection.ts src/renderer/src/features/reader/PdfPage.tsx scripts/verification/generate-selection-fixtures.ts tests/e2e/selection-verification.spec.ts --max-warnings=0
```

最终 lint 0 警告。日志与生成审计位于 `.cache/reader/20261028-selection-01/`。初始生成器顶层 await 不兼容本仓库 CJS、初始测试类型错误、缺失 scrollRoot effect 依赖的 lint 警告均保留原失败日志，随后修复；未禁用规则或依靠私有 .mts 副本运行生成器。

**reader 未构建、未打包、未启动 Electron、未运行 E2E。候选修复后的实际选区与复制均待 qa。** 交 qa 统一旧包/源码验证：

```powershell
pnpm exec playwright test tests/e2e/selection-verification.spec.ts --workers=1
```

优先核验空白白边/灰底、真实单步跨 span、返回/反向及 mouseup 后普通选择，再完整复验原五档 DPI、跨行/跨页、Shift、双击、复制与资源撤销。逐字符矩形仍不等于字形墨迹；RTL/组合字符、任意角度旋转、长距离自动滚动和快速拖拽性能未完成动态验证。没有把未验证项记为通过。
