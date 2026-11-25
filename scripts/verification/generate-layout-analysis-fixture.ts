import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

type FontKey = 'Times-Roman' | 'Helvetica-Bold' | 'Courier'

interface DrawnPart {
  id: string
  pageNumber: number
  column: 'spanning' | 'left' | 'right' | 'header' | 'footer'
  expectedKind: 'heading' | 'paragraph' | 'caption' | 'formula' | 'header' | 'page-number'
  text: string
  font: FontKey
  x: number
  y: number
  size: number
  width: number
}

const fixtureRoot = resolve('tests/fixtures/verification/layout-analysis')
const generator = 'scripts/verification/generate-layout-analysis-fixture.ts'
const pdfName = 'two-column-academic-fixture.pdf'
const fixedDate = '2026-11-24T00:00:00.000Z'
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

const round = (value: number): number => Number(value.toFixed(6))
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const advance = (font: PDFFont, text: string, size: number): number =>
  round([...text].reduce((sum, ch) => sum + font.widthOfTextAtSize(ch, size), 0))

async function main(): Promise<void> {
  const document = await PDFDocument.create({ updateMetadata: false })
  document.setTitle('PaperFlow original synthetic two-column layout fixture')
  document.setAuthor('PaperFlow synthetic verification fixtures')
  document.setSubject('Original synthetic academic two-column PDF for layout analysis and dual-pane alignment.')
  document.setCreator('PaperFlow deterministic fixture generator')
  document.setProducer('pdf-lib 1.17.1 / PaperFlow synthetic fixture')
  document.setCreationDate(new Date(fixedDate))
  document.setModificationDate(new Date(fixedDate))

  const roman = await document.embedFont(StandardFonts.TimesRoman)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const courier = await document.embedFont(StandardFonts.Courier)
  const fonts: Record<FontKey, PDFFont> = {
    'Times-Roman': roman,
    'Helvetica-Bold': bold,
    Courier: courier
  }

  const part = (
    id: string,
    pageNumber: number,
    column: DrawnPart['column'],
    expectedKind: DrawnPart['expectedKind'],
    text: string,
    font: FontKey,
    x: number,
    y: number,
    size: number
  ): DrawnPart => ({
    id,
    pageNumber,
    column,
    expectedKind,
    text,
    font,
    x,
    y,
    size,
    width: advance(fonts[font], text, size)
  })

  // 注意：有意以左右栏交错顺序写入 PDF 流，以验证版面分析真实重建而非沿用流顺序。
  const page1Parts: DrawnPart[] = [
    part('p1-header', 1, 'header', 'header', 'Synthetic Journal of Layout Audits', 'Times-Roman', 54, 758, 9),
    part('p1-title', 1, 'spanning', 'heading', 'Deterministic Layout Pipeline for Local Academic Readers', 'Helvetica-Bold', 54, 708, 15.5),
    part('p1-l-h1', 1, 'left', 'heading', '1. Introduction', 'Helvetica-Bold', 54, 668, 12),
    part('p1-r-cont', 1, 'right', 'paragraph', 'line reconstructs column boundaries.', 'Times-Roman', 326, 668, 10.5),
    part('p1-l-p1', 1, 'left', 'paragraph', 'Modern readers require stable layout archi-', 'Times-Roman', 54, 646, 10.5),
    part('p1-r-p1b', 1, 'right', 'paragraph', 'It preserves exact PDF coordinates.', 'Times-Roman', 326, 653, 10.5),
    part('p1-l-p2', 1, 'left', 'paragraph', 'tecture (e.g., Smith et al., 2025). As shown in', 'Times-Roman', 54, 631, 10.5),
    part('p1-r-fig', 1, 'right', 'caption', 'Figure 1: Synthetic two-column alignment diagram.', 'Helvetica-Bold', 326, 622, 10),
    part('p1-l-p3', 1, 'left', 'paragraph', 'Fig. 1, the scale factor is 3.14 with self-', 'Times-Roman', 54, 616, 10.5),
    part('p1-r-h2', 1, 'right', 'heading', '2. Methods', 'Helvetica-Bold', 326, 592, 12),
    part('p1-l-p4', 1, 'left', 'paragraph', 'attention weights across two columns.', 'Times-Roman', 54, 601, 10.5),
    part('p1-r-p2', 1, 'right', 'paragraph', 'Every sentence keeps unscaled boxes.', 'Times-Roman', 326, 570, 10.5),
    part('p1-l-eq', 1, 'left', 'formula', 'E = mc^2 + alpha', 'Courier', 54, 572, 11),
    part('p1-l-eq-tag', 1, 'left', 'formula', '(1)', 'Times-Roman', 266, 572, 10.5),
    part('p1-l-cross', 1, 'left', 'paragraph', 'The deterministic layout pipe-', 'Times-Roman', 54, 540, 10.5),
    part('p1-page-num', 1, 'footer', 'page-number', '- 1 -', 'Times-Roman', 294, 32, 9)
  ]

  const page2Parts: DrawnPart[] = [
    part('p2-header', 2, 'header', 'header', 'Synthetic Journal of Layout Audits', 'Times-Roman', 54, 758, 9),
    part('p2-l-h21', 2, 'left', 'heading', '2.1 Band Segmentation', 'Helvetica-Bold', 54, 700, 12),
    part('p2-r-upper', 2, 'right', 'paragraph', 'Right upper band follows left upper band.', 'Times-Roman', 326, 682, 10.5),
    part('p2-l-upper', 2, 'left', 'paragraph', 'Left upper band stays above the table.', 'Times-Roman', 54, 682, 10.5),
    part('p2-span-table', 2, 'spanning', 'caption', 'Table 1: Cross-column reading order metrics verified across spanning blocks.', 'Helvetica-Bold', 54, 640, 10.5),
    part('p2-r-lower', 2, 'right', 'paragraph', 'Right lower band completes page reading order.', 'Times-Roman', 326, 596, 10.5),
    part('p2-l-lower', 2, 'left', 'paragraph', 'Left lower band resumes after spanning table.', 'Times-Roman', 54, 596, 10.5),
    part('p2-page-num', 2, 'footer', 'page-number', '- 2 -', 'Times-Roman', 294, 32, 9)
  ]

  const allParts = [...page1Parts, ...page2Parts]
  const pages: PDFPage[] = [1, 2].map(() => document.addPage([PAGE_WIDTH, PAGE_HEIGHT]))

  for (const item of allParts) {
    pages[item.pageNumber - 1].drawText(item.text, {
      x: item.x,
      y: item.y,
      size: item.size,
      font: fonts[item.font],
      color: rgb(0, 0, 0)
    })
  }

  // 在第 1 页右栏空白区绘制原创合成矢量柱状图框，在第 2 页绘制矢量表格框，用于验证原页底图覆写模式完整保留图形像素（不新增文本项）
  const p1 = pages[0]
  p1.drawRectangle({ x: 326, y: 420, width: 224, height: 112, borderWidth: 1, borderColor: rgb(0.68, 0.75, 0.86), color: rgb(0.97, 0.98, 1) })
  const barColors = [rgb(0.22, 0.39, 0.71), rgb(0.28, 0.56, 0.82), rgb(0.18, 0.62, 0.45), rgb(0.84, 0.52, 0.21)]
  const barHeights = [46, 74, 62, 86]
  for (let b = 0; b < 4; b += 1) {
    p1.drawRectangle({
      x: 348 + b * 48,
      y: 434,
      width: 28,
      height: barHeights[b],
      color: barColors[b]
    })
  }
  p1.drawLine({ start: { x: 338, y: 434 }, end: { x: 538, y: 434 }, thickness: 1, color: rgb(0.35, 0.42, 0.55) })

  const p2 = pages[1]
  p2.drawRectangle({ x: 54, y: 452, width: 504, height: 96, borderWidth: 1, borderColor: rgb(0.65, 0.72, 0.84), color: rgb(0.98, 0.99, 1) })
  for (const rowY of [484, 516]) {
    p2.drawLine({ start: { x: 54, y: rowY }, end: { x: 558, y: rowY }, thickness: 0.75, color: rgb(0.75, 0.8, 0.89) })
  }
  for (const colX of [222, 390]) {
    p2.drawLine({ start: { x: colX, y: 452 }, end: { x: colX, y: 548 }, thickness: 0.75, color: rgb(0.75, 0.8, 0.89) })
  }

  const bytes = await document.save({ useObjectStreams: false })
  const file = { name: pdfName, bytes: bytes.length, sha256: sha256(bytes) }

  // 使用 Node pdfjs-dist 审计生成 PDF 可真实提取全部流条目
  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
    useSystemFonts: false
  })
  const extractedPages: Array<{ pageNumber: number; itemCount: number }> = []
  try {
    const pdf = await task.promise
    if (pdf.numPages !== 2) throw new Error(`Expected 2 pages, got ${pdf.numPages}`)
    for (let number = 1; number <= 2; number += 1) {
      const page = await pdf.getPage(number)
      const content = await page.getTextContent({ includeMarkedContent: true })
      const textItems = content.items.filter(entry => 'str' in entry && entry.str.trim().length > 0)
      extractedPages.push({ pageNumber: number, itemCount: textItems.length })
    }
  } finally {
    await task.destroy()
  }

  const manifest = {
    schemaVersion: 1,
    source: 'PaperFlow 原创合成双栏学术版面分析与双向对齐验证 PDF；不复制任何真实论文内容。',
    license: 'AGPL-3.0-only',
    generator,
    fixedMetadataDate: fixedDate,
    file,
    pageSize: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
    extractedPages,
    expectedOrder: {
      page1: [
        'Deterministic Layout Pipeline for Local Academic Readers',
        '1. Introduction',
        'Modern readers require stable layout architecture (e.g., Smith et al., 2025).',
        'As shown in Fig. 1, the scale factor is 3.14 with self-attention weights across two columns.',
        'E = mc^2 + alpha (1)',
        'The deterministic layout pipeline reconstructs column boundaries.',
        'It preserves exact PDF coordinates.',
        'Figure 1: Synthetic two-column alignment diagram.',
        '2. Methods',
        'Every sentence keeps unscaled boxes.'
      ],
      page2: [
        '2.1 Band Segmentation',
        'Left upper band stays above the table.',
        'Right upper band follows left upper band.',
        'Table 1: Cross-column reading order metrics verified across spanning blocks.',
        'Left lower band resumes after spanning table.',
        'Right lower band completes page reading order.'
      ]
    },
    parts: allParts
  }

  const readme = [
    '# Layout Analysis 验证合成素材',
    '',
    '本目录为 PaperFlow 原创合成双栏学术排版验证素材（2 页，612 × 792 pt，Standard 14 字体），未复制任何外部文献。',
    '',
    '## 素材覆盖场景',
    '',
    '- 交错绘制顺序的左右双栏与中间跨栏表题分段（Band-Aware XY-Cut）。',
    '- 行尾断词拼接（`archi-` + `tecture` -> `architecture`）与保留前缀复合词（`self-` + `attention` -> `self-attention`）。',
    '- 跨栏未完句合并（左栏底部 `pipe-` 接右栏顶部 `line reconstructs column boundaries.`）。',
    '- 页眉（`Synthetic Journal of Layout Audits`）与页码（`- 1 -` / `- 2 -`）过滤。',
    '- 学术缩写与小数保护（`e.g.`、`et al.`、`Fig. 1`、`3.14`）及公式编号 `(1)` 与图表标题分类。',
    '',
    '## 重新生成',
    '',
    '```powershell',
    `pnpm.cmd exec tsx ${generator}`,
    '```',
    ''
  ].join('\n')

  await mkdir(fixtureRoot, { recursive: true })
  await writeFile(resolve(fixtureRoot, pdfName), bytes)
  await writeFile(resolve(fixtureRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(resolve(fixtureRoot, 'README.md'), readme)

  console.log(JSON.stringify({ file, extractedPages }, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
