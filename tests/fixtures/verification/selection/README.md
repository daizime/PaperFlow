# 空白拖拽、双栏与公式选择合成素材

`blank-drag-columns-formulas.pdf` 为本项目原创合成 PDF，正文、唯一标记、上下标及矢量分数线均由 TypeScript 绘制，没有复制论文、外部 PDF、照片或字体文件。生成物按项目 AGPL-3.0-only 提供；仅引用 Standard 14 Courier 字体名称。不是实际研究数据。

在项目根运行：

```powershell
pnpm exec tsx scripts/verification/generate-selection-fixtures.ts
```

共两页，MediaBox 均为 `[0,0,600,780]`，第 2 页旋转 90°。左右栏按 L1、R1、L2、R2、L3、R3 顺序交错绘制；相邻正文基线相距 24 点。公式 `E=mc2+a1` 的上标 2、下标 1 是独立文字操作；分数的分子 `a+b`、分母 `c+d` 也是文字，分数线是矢量图形，没有 `/` 字符。这里的复制期望只针对已有字符，不能视为 LaTeX 或数学语义转换。

`manifest.json` 记录文件 SHA256/字节数、每一绘制文字的原始坐标/字号/字体度量/绘制次序、PDF.js 实际提取的文字 items/transform/索引、19 个手势的精确路径与期望，以及本机上游参考文件的版本/许可证/hash。

手势覆盖纯白边与栏间空白起拖、灰色阅读背景起拖、文字出白页到灰底、文字/公式进入空白与反向/返回、真实单步快速公式拖拽、分子/分母和 mouseup 后普通选择/双击。`recovery-setup` 只为后续恢复场景制造前置状态，其结果单独记录；同一类空白行为在 blank 组有独立严格断言。

双栏跨多行的原始 PDF 内容流顺序是单独的边界：本轮不据此重排整页阅读顺序或实现句子切分。ASCII 合成素材不代表已覆盖 RTL、复杂连字、缺失 ToUnicode 或任意公式。
