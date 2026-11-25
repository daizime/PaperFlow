# Layout Analysis 验证合成素材

本目录为 PaperFlow 原创合成双栏学术排版验证素材（2 页，612 × 792 pt，Standard 14 字体），未复制任何外部文献。

## 素材覆盖场景

- 交错绘制顺序的左右双栏与中间跨栏表题分段（Band-Aware XY-Cut）。
- 行尾断词拼接（`archi-` + `tecture` -> `architecture`）与保留前缀复合词（`self-` + `attention` -> `self-attention`）。
- 跨栏未完句合并（左栏底部 `pipe-` 接右栏顶部 `line reconstructs column boundaries.`）。
- 页眉（`Synthetic Journal of Layout Audits`）与页码（`- 1 -` / `- 2 -`）过滤。
- 学术缩写与小数保护（`e.g.`、`et al.`、`Fig. 1`、`3.14`）及公式编号 `(1)` 与图表标题分类。

## 重新生成

```powershell
pnpm.cmd exec tsx scripts/verification/generate-layout-analysis-fixture.ts
```
