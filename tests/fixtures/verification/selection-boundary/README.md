# 选区边界硬化合成测试素材（跨页 + 90°旋转 + 高对比度）

本目录为 PaperFlow 原创合成测试素材，用于验证跨页连续选区、90° 顺时针旋转页面多行公式连续性以及 Windows 高对比度模式（`forced-colors: active`）。

## 页面结构

- **第 1 页（`600 × 780`，0°）**：页首/页中未选正文与页尾连续段落（`y = 108` 与 `y = 90` 含字体切换 `M`）。
- **第 2 页（`600 × 780`，0°）**：页首承接两行正文（`y = 710` 与 `y = 692`），下方含未选段落及远端哨兵。
- **第 3 页（`780 × 600`，`rotation: 90`）**：顺时针旋转 90° 后在阅读器以 `600 × 780` 竖直正向显示，包含带斜体切换的行 `alpha S and T map rotated vectors:`、带宽正下方下标的独立公式 `Q[ ] = ⊕_{A,B,C,D,E} F[A, B] ⊗ G[C, D, E]`、下一行连续正文以及右栏与远端未选哨兵。

## 再生命令

```powershell
pnpm.cmd exec tsx scripts/verification/generate-selection-boundary-fixture.ts
```
