# 选区连续性回归合成素材（5 行综合场景）

本目录为 PaperFlow 原创合成测试素材，不复制论文、截图正文或用户文献；英文与公式字符仅供选区连续性回归测试，无科学事实或 LaTeX 主张。

## 内容与制作坐标

- 单页 `600 × 780`、0°、UserUnit 1。引用 PDF Standard 14 字体 `Times-Roman`、`Times-Italic`、`Helvetica` 与 `Symbol`，不嵌入或复制字体文件。
- **绘制流顺序隔离**：`unselected-title` 与 `unselected-intro` 在 Row 1 之前绘制；Row 1–Row 5 按阅读顺序连续绘制（包含 Row 3 与 Row 4 的宽正下方下标 `A,B,C,D,E`、行内右侧下标及居中三点）；右栏（`x >= 460`）与远端哨兵（`y = 240`）在 Row 5 之后绘制，保证从 Row 1 起点拖选至 Row 5 终点时 DOM 区间自然囊括 5 行全部内容且不夹杂右栏或哨兵。
- **Row 1**（`y = 602`）：零 `\p{Sm}` 数学符号的普通混排正文，含 `Times-Roman` / `Times-Italic` / `Helvetica` 多次切换与 `4.5 pt` span 间隙（`< 1.25*em = 15 pt`，且在 100% DPR 1 下可稳定采集 `>= 2` 列纯白样本）。
- **Row 2**（`y = 585`）：普通正文 `passes into:`（基线低于 Row 1 `17 pt`）。
- **Row 3**（`y = 556`）：缩进独立公式（基线低于 Row 2 `29 pt`），含 `V[ ] =` 与 `20 pt` `⊕`（`> 1.25*em` 即 `20 pt` 左右间隔）、正下方对称宽下标 `A,B,C,D,E`（`8 pt`）、以及 `F[A, B] ⊗ G[A, C, E] ⊗ H[C, D]`。
- **Row 4**（`y = 524`）：行内混排公式，同时包含宽正下方下标 `⊕_{A,B,C,D,E}`（左右间隔 `18 pt > 1.25*em`）与行内右侧下标 `⊕_A ... ⊕_E`；居中三点经 `encodeText` 审计后选用 `Symbol` `⋅⋅⋅`（`U+22C5 U+22C5 U+22C5`，基线抬升 `1.5 pt`）。
- **Row 5**（`y = 500`）：基线低于 Row 4 `24 pt` 的普通正文 `holds bounded weights at all nodes. Next`。

## 再生及实际审计

```powershell
pnpm.cmd exec tsx scripts/verification/generate-selection-continuity-fixture.ts
```

元数据日期固定为 `2026-11-22T00:00:00.000Z`，无随机量；`raw-extraction.json` 保存 Node PDF.js 原始提取结果，非有限数值显式序列化为字符串。

## 验证边界

**已真实执行**：PDF 生成及 Node PDF.js 非空白字符/顺序、字号/基线、页面几何与流顺序隔离审计。**待 verifier 执行**：Electron 真实鼠标拖拽、Ctrl+C 剪贴板、100%/150% DPR 1 蓝框连续性与 guard 白底像素检测。
