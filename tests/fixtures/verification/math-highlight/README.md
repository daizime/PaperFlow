# 公式选区连续性合成素材

本目录为 PFV-READER-006 阶段 A 原创合成素材，不复制论文、截图正文或用户文献。英文和公式字符仅供测试，无科学事实或 LaTeX 主张。

## 内容和制作坐标

- 单页 600 × 780、0°、UserUnit 1。独立未选标题和说明在选中两行之前；远哨兵在两行之后绘制，避免合法 DOM 区间误夹哨兵。
- 第一行正文 Times-Roman 18 pt，真实下标 i 和上标 2 为 12 pt；大运算符优先 Symbol 的 U+2295 circled-plus，72 pt。字体仅引用 Standard 14 名称，不复制或嵌入字体文件。
- 公式依制作顺序排列 p、下标 i、运算符、q、上标 2、尾部 = r；相邻组按逐字符 advance 串排并保留 6 PDF 单位短空白。第二行基线为 480，比公式普通正文 510 低 30。
- `manifest.json` 的 parts、selectedRows、selection 给出实际提取字符、制作坐标与完整两行预期。固定端点使用首字 x+0.4、末字 x+width−0.4、正文 baseline+6；不得从 TextLayer 包围框反向瞄点或为测试结果移动点。
- bridgeCandidates 是短横向间隙和普通 tail 与下一行共用 X 范围的竖缝候选窗；不得用大运算符整行 envelope 推断没有竖缝。真实上下标始终是选中字符，不是待覆盖空白。operatorProbe 仅作局部记录，不作为裁掉上凸蓝块的通过判据。
- guardWindows 保留公式末尾外、远处宽栏缝和第二行下方段落空白；所有连接仍须由实际选区、Range 和选前白底证明，不能只凭 manifest 判通过。

## 再生及实际审计

```powershell
pnpm exec tsx scripts/verification/generate-math-highlight-fixture.ts
```

PDF 元数据日期固定为 2026-11-22T00:00:00.000Z，无随机量。普通 Tj 不含 AFM pair kerning，行宽逐字相加并与 PDF.js 实际提取核对。
`raw-extraction.json` 保存实际 Node PDF.js 原始 item/styles 和制作 part 映射；NaN/Infinity 数值显式写为字符串。expectedText 来自实际提取，仅统一空白；E2E 的 remove-whitespace-only 只可忽略空白，不可删除或替换非空白字符。

## 验证边界

**已真实执行**：生成及 Node PDF.js 非空白字符/顺序、基线、字号、页几何审计；宽度和 X 原样保留（前导空格可能拆成单独 item），不声称每个 item 与整段 advance 等宽。**待 QA**：真实鼠标跨两行选择、Ctrl+C、原生 Range、连接 ROI 和 guard 像素。Poppler 静态预览只能检查 PDF 本身，不显示浏览器 Selection，不证明产品蓝框连接已通过。用户原 PDF 未读取或验证。
