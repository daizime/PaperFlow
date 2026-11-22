# 紧行距文字选区合成素材

本目录为 PFV-READER-005 阶段 A 的原创合成素材。英文句子仅用于测试，不复制论文、用户截图正文或外部 PDF，不表达科学事实。素材沿用项目 AGPL-3.0-only 许可；pdf-lib 为 MIT，PDF.js 为 Apache-2.0。

## 内容与坐标

- `tight-lines.pdf`：两页，均为 600 × 780 PDF 单位、0°、UserUnit 1。第 1 页有独立未选标题、dense-two 两行、dense-multi 五行、loose-control 两行；第 2 页只有未选 sentinel。
- 正文引用 Standard 14 的 Times-Roman 字体名，18 pt；密集组基线间距 16 pt，对照组 28 pt。未嵌入或复制字体文件。最终浏览器字体替代及字框必须实测。
- `manifest.json` 给出每行制作坐标、字符串、逐字 advance 总宽及完整预期行。PDF 坐标原点在左下，Y 向上；E2E 应从 PDF 点与 Canvas CSS 框独立换算，不能从 TextLayer 包围框反向瞄准。
- 起点固定首字符 advance 内 x + 0.4，终点固定末字符 advance 内 x + width - 0.4，Y 均为 baseline + 6。选取字身中部，远离相邻行字框交叠边；不依据命中结果移动端点。
- drawText 生成的普通 Tj 不含 AFM 成对字距调整，因此行宽使用逐字符宽度求和，而非 pdf-lib 含 kerning 的整串宽度。已与 PDF.js 实际提取 advance 对齐。

## 可再生与实际审计

在项目根目录执行：

```powershell
pnpm exec tsx scripts/verification/generate-selection-overlap-fixture.ts
```

元数据日期固定为 2026-11-22T00:00:00.000Z，作者、标题和 producer 固定，生成内容无随机量。
manifest 保存 PDF 字节数/SHA-256、页几何和本机依赖源码引用指纹。`raw-extraction.json` 保存本次 Node PDF.js 的全部原始文字 item、styles、transform、advance 和 hasEOL；生成器逐项核对文字/顺序、坐标、字号与 advance，并销毁 loading task。生成日志及可选 Poppler 静态预览写入 `.cache/reader/20261122-overlap-01/generator/`。

## 验证边界

**已真实执行**：素材生成、Node PDF.js 文字提取及制作参数审计。**设计预期**：18 pt 字号与 16 pt 基线间距可能产生约 2 pt 的浏览器 Range 纵向交叠；`expectRectOverlap` 是测试预期，不是已测结论。**待 QA**：实际 Range 交叠、真实鼠标选区/剪贴板、同白底区域叠色像素及窗口/DPI 情况。静态 PDF 预览不显示浏览器 Selection，不能证明选区颜色修复，也不代表用户原 PDF 已验证。
