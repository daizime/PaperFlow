# 密集行选区叠色验证（阶段 A）

任务为 `PFV-READER-005 / 20261122-overlap-01`，基线 `PF-OVERLAP-20261122-01`。本阶段仅制作原创合成素材及真实交互用例，产品代码冻结。用户截图所用原 PDF 未提供，合成复现不能当作用户文档已经验证。

## 素材与生成

生成器为 `scripts/verification/generate-selection-overlap-fixture.ts`，输出目录 `tests/fixtures/verification/selection-overlap/`。使用项目锁定的 pdf-lib 1.17.1 和标准字体 Times Roman，不复制论文文字或外部字体文件。第一页包含未选标题、紧排两行、紧排五行及宽行距两行对照，第二页为独立未选 sentinel。字号、基线、字符宽度、PDF起终点、期望全文、提取顺序及文件hash均以 manifest 和生成审计为准。

```powershell
pnpm exec tsx scripts/verification/generate-selection-overlap-fixture.ts
```

已生成PDF为3373字节、两页，SHA256为 `951ad5367cc645fa84bd30c8da36827d9a3a4678d711b60b4fa35e3b034ab7cf`。紧排区使用18pt字、16单位基线间距，对照区使用28单位基线间距。该参数旨在产生文字布局框的纵向交叠，实际浏览器 Range 与像素是否叠深必须由 QA 真实运行确认，不能从字号相减直接宣称复现。静态 PDF 渲染仅检查原创文字与排版，不代表 Electron 选区验证。

实际已执行生成器与Node PDF.js提取审计；PDF、manifest、raw-extraction和README重复生成hash一致。Poppler120DPI静态渲染退出0，两页文字经视觉检查完整可辨；日志有未使用的Symbol字体提示，保留原日志，不据此宣称浏览器字体行为已验证。首次生成器README模板反引号语法错误已修正，初始失败、后续成功和再生记录均在 `.cache/reader/20261122-overlap-01/generator/`，没有覆盖。

## 真实交互与像素判据

`tests/e2e/selection-overlap.spec.ts` 仅从 manifest 的已知 PDF 坐标与 Canvas CSS 框生成鼠标点；TextLayer与Range只用于选后留证，不反过来瞄准。真实Selection和Ctrl+C需匹配目标正文，标题、另一块正文和第二页 sentinel 不得夹入。使用相同窗口状态、缩放和滚动的选前/选后PNG，记录焦点与选区端点。

几何先按文字行去重Range矩形，避免同一span/文本节点返回相同矩形造成假重叠；紧排区须有不同行之间至少1 CSS px的纵轴交叠，对照区应无实质行间交叠。几何重叠本身不是修复失败，后续绘制层可以保留原Range几何。

PNG由真实Chromium在离屏Canvas解码；`scale: 'css'` 截图按CSS坐标采样，不再乘DPR。只取选前接近等白底的像素，排除字形、抗锯齿和非白底，再配对比较同x列上的重叠带与单覆盖带。初版判据为有效像素至少64、共同x列至少32、上色比例至少90%，两带RGB最大通道均值差与白色距离中位差各不超过12。**这些数值是预先编写的测试判据，尚非实测结果。** 样本不足明确失败，不能跳过、改点或调整CSS造出复现。

旧候选也运行同一个“颜色不重复叠深”的目标断言；若失败，应保留before/after PNG、区域及原始像素、统计量、Range矩形、Selection/复制与实际通过/失败，不把预期旧版失败改写成通过。像素均匀不能单独证明字形可读、命中正确或失焦颜色正确，需分别检查。

## 后续最小产品方案（尚未放行）

已核本地 pdfjs-dist 6.4.299 公开 `DrawLayer`。`build/pdf.mjs` 的同页单Range绘制将正面积矩形写成一个clipPath，裁剪单个 `.selection` 背景；行间交叠与重复矩形不应重复叠画。官方viewer同时给TextLayer加 `selectionRendering` 抑制原生背景，并将DrawLayer父级放在Canvas包装层。项目需要自有页作用域的覆盖样式及移除DOM前的 `destroy()`，不改变原始字符、viewport、Selection端点或剪贴板。多Range、forced-colors及失焦样式需另行核验，不能据单页主选区承诺覆盖全部情况。

公开源码路径、版本和hash见 `.cache/reader/20261122-overlap-01/public-drawlayer-references.json`。若QA证实旧候选确有叠深，再由主控正式放行产品最小改动。r9分式仅复制 `a` 属于独立内容故障，本任务不得据此盲修端点。

## 执行边界

本阶段共3组素材×100%/150%、DPR1，合计6例。固定PDF点必须在阅读客户区且避开36px边缘带，防止自动滚动破坏像素配对；条件不满足时明确失败，不移动点或更改窗口来造结果。当前像素分析限定水平、活动窗口、白底正文，不把该结论外推到旋转/失焦/forced-colors或用户原PDF。

reader已实际执行且退出0：

```powershell
pnpm exec tsc --noEmit -p .cache/reader/20261122-overlap-01/tsconfig.tests.json
pnpm exec eslint scripts/verification/generate-selection-overlap-fixture.ts tests/e2e/selection-overlap.spec.ts --max-warnings=0
```

日志分别为 `.cache/reader/20261122-overlap-01/types.log`、`lint.log`。所有Electron、GUI、公共检查、构建与包测由QA独占；reader本阶段未启动这些操作，也未修改src或既有测试。

QA在锁定旧候选/新候选及隔离数据目录下运行：

```powershell
pnpm exec playwright test tests/e2e/selection-overlap.spec.ts --workers=1 --retries=0
```

实际生成审计、预览和局部结果以本轮短报告及 `.cache/reader/20261122-overlap-01/` 日志为准；真实视觉与复制结果在QA运行前均为未验证。
