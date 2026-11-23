# Reader UX 验证合成素材

本目录为 PaperFlow 原创合成阅读器核心交互验证素材（3 页，600 × 780 pt，Standard 14 字体），不复制任何外部文献。

## 素材结构

- 真实 PDF `/Outlines` 目录书签：包含 3 个一级章节与 3 个嵌套子章节，分别指向第 1–3 页。
- 每页正文均落在宽白边安全区内（四边留白均 >= 110 pt），用于验证白边裁剪与裁剪后适合宽度放大。
- 第 1–3 页每页各含 1 处全大写 `QUANTUM_BENCHMARK` 与 1 处大小写混合变体（共 6 处不区分大小写 / 3 处区分大小写），用于文内搜索与跨页跳转。
- 第 1 页含固定 PDF 坐标的 `Selectable cropped sentence for clipboard audit.`，用于验证白边裁剪状态下的鼠标拖选与 `Ctrl+C` 复制保真。

## 生成与审计

```powershell
pnpm.cmd exec tsx scripts/verification/generate-reader-ux-fixture.ts
```

已通过 Node `pdfjs-dist` 校验页数、`/Outlines` 书签及页码解析、`QUANTUM_BENCHMARK` 各页文本匹配次数和四边白边留白尺寸。
