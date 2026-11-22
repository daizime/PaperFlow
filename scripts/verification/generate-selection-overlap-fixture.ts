import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

interface Line {
  id: string
  text: string
  x: number
  y: number
  size: number
  width: number
}
interface FixtureCase {
  id: string
  pageNumber: number
  lines: Line[]
  start: { x: number; y: number }
  end: { x: number; y: number }
  expectedLines: string[]
  expectRectOverlap: boolean
  baselinePitch: number
}

const fixtureRoot = resolve('tests/fixtures/verification/selection-overlap')
const auditRoot = resolve('.cache/reader/20261122-overlap-01/generator')
const generator = 'scripts/verification/generate-selection-overlap-fixture.ts'
const pdfName = 'tight-lines.pdf'
const width = 600
const height = 780
const fontSize = 18
const fixedDate = '2026-11-22T00:00:00.000Z'
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const round = (value: number): number => Number(value.toFixed(6))

// PDF-lib emits one Tj per drawText: its full-string width includes AFM kerning,
// whereas this PDF's plain Tj uses the sum of individual glyph advances.
function advance(font: PDFFont, text: string, size: number): number {
  return round([...text].reduce((sum, character) => sum + font.widthOfTextAtSize(character, size), 0))
}

function makeCase(font: PDFFont, id: string, baseline: number, pitch: number, texts: string[]): FixtureCase {
  const lines = texts.map((text, index): Line => ({
    id: `${id}-line-${index + 1}`, text, x: 48, y: baseline - index * pitch,
    size: fontSize, width: advance(font, text, fontSize)
  }))
  const first = lines[0]
  const last = lines[lines.length - 1]
  return {
    id, pageNumber: 1, lines,
    // Fixed authored PDF points, inside the first/last character's advance.
    // Baseline + 6 is in the capital/body region, away from adjacent line-box overlap.
    start: { x: first.x + 0.4, y: first.y + 6 },
    end: { x: round(last.x + last.width - 0.4), y: last.y + 6 },
    expectedLines: lines.map(line => line.text), expectRectOverlap: pitch < fontSize, baselinePitch: pitch
  }
}

async function main(): Promise<void> {
  const document = await PDFDocument.create({ updateMetadata: false })
  document.setTitle('PaperFlow original synthetic tight-line selection fixture')
  document.setAuthor('PaperFlow synthetic verification fixtures')
  document.setSubject('Original synthetic text. No copied paper, external PDF, or scientific claim.')
  document.setCreator('PaperFlow deterministic fixture generator')
  document.setProducer('pdf-lib 1.17.1 / PaperFlow synthetic fixture')
  document.setCreationDate(new Date(fixedDate))
  document.setModificationDate(new Date(fixedDate))
  const font = await document.embedFont(StandardFonts.TimesRoman)
  const cases = [
    makeCase(font, 'dense-two', 650, 16, [
      'Dense first row carries seven amber seeds.',
      'Dense second row follows quiet violet rain.'
    ]),
    makeCase(font, 'dense-multi', 510, 16, [
      'Dense alpha keeps five copper leaves.',
      'Dense beta maps eight silver stones.',
      'Dense gamma names six gentle rivers.',
      'Dense delta counts nine paper lanterns.',
      'Dense epsilon holds four cedar branches.'
    ]),
    makeCase(font, 'loose-control', 320, 28, [
      'Loose first row carries seven amber seeds.',
      'Loose second row follows quiet violet rain.'
    ])
  ]
  const excludedRuns: (Line & { pageNumber: number })[] = [
    { id: 'unselected-title', pageNumber: 1, text: 'ORIGINAL SYNTHETIC SELECTION OVERLAP', x: 48, y: 744, size: 11, width: 0 },
    { id: 'synthetic-notice', pageNumber: 1, text: 'Synthetic fixture: Times-Roman 18 pt; dense pitch 16; control pitch 28.', x: 48, y: 722, size: 10, width: 0 },
    { id: 'dense-two-label', pageNumber: 1, text: 'DENSE TWO / ORIGINAL SYNTHETIC TEXT', x: 48, y: 680, size: 10, width: 0 },
    { id: 'dense-multi-label', pageNumber: 1, text: 'DENSE MULTI / ORIGINAL SYNTHETIC TEXT', x: 48, y: 540, size: 10, width: 0 },
    { id: 'loose-control-label', pageNumber: 1, text: 'LOOSE CONTROL / ORIGINAL SYNTHETIC TEXT', x: 48, y: 350, size: 10, width: 0 },
    { id: 'page-two-sentinel', pageNumber: 2, text: 'UNSELECTED_PAGE_SENTINEL_SYNTHETIC_02', x: 48, y: 700, size: 18, width: 0 }
  ].map(line => ({ ...line, width: advance(font, line.text, line.size) }))
  const pages = [1, 2].map(number => ({ number, width, height, rotation: 0, view: [0, 0, width, height], userUnit: 1 }))
  const drawOrder: (Line & { pageNumber: number })[] = []
  for (const specification of pages) {
    const page = document.addPage([width, height])
    const runs = specification.number === 1 ? [
      ...excludedRuns.filter(run => run.pageNumber === 1 && (run.id === 'unselected-title' || run.id === 'synthetic-notice')),
      ...cases.flatMap(entry => [excludedRuns.find(run => run.id === `${entry.id}-label`)!, ...entry.lines.map(line => ({ ...line, pageNumber: 1 }))])
    ] : excludedRuns.filter(run => run.pageNumber === 2)
    for (const line of runs) {
      if (line.x < 0 || line.x + line.width > width || line.y < 0 || line.y + line.size > height) throw new Error(`Out-of-page synthetic run: ${line.id}`)
      page.drawText(line.text, { x: line.x, y: line.y, size: line.size, font, color: rgb(0, 0, 0) })
      drawOrder.push(line)
    }
  }
  const bytes = await document.save({ useObjectStreams: false })
  const file = { name: pdfName, bytes: bytes.length, sha256: sha256(bytes) }
  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
    useSystemFonts: false
  })
  const extraction = []
  try {
    const pdf = await task.promise
    if (pdf.numPages !== pages.length) throw new Error('Unexpected synthetic fixture page count')
    for (const specification of pages) {
      const page = await pdf.getPage(specification.number)
      const viewport = page.getViewport({ scale: 1 })
      if (viewport.width !== width || viewport.height !== height || page.rotate !== 0 || page.userUnit !== 1 || page.view.some((value, index) => value !== specification.view[index])) throw new Error('Unexpected synthetic page geometry')
      const content = await page.getTextContent({ includeMarkedContent: true })
      const textItems = content.items.filter(item => 'str' in item && item.str.length > 0)
      const expectedRuns = drawOrder.filter(line => line.pageNumber === specification.number)
      if (textItems.length !== expectedRuns.length) throw new Error('Synthetic text runs were merged, split, or lost')
      for (let index = 0; index < expectedRuns.length; index++) {
        const expected = expectedRuns[index]
        const actual = textItems[index]
        if (!('str' in actual) || actual.str !== expected.text || Math.abs(actual.width - expected.width) > 0.001 || Math.abs(actual.height - expected.size) > 0.001 || Math.abs(actual.transform[4] - expected.x) > 0.001 || Math.abs(actual.transform[5] - expected.y) > 0.001) throw new Error(`PDF.js extraction differs from authored run: ${expected.id}`)
      }
      extraction.push({
        pageNumber: specification.number, viewport: { width: viewport.width, height: viewport.height },
        rotation: page.rotate, view: page.view, userUnit: page.userUnit, styles: content.styles,
        items: content.items.map((item, index) => 'str' in item ? { index, str: item.str, transform: item.transform, width: item.width, height: item.height, fontName: item.fontName, hasEOL: item.hasEOL, dir: item.dir } : { index, markedContent: true })
      })
    }
  } finally { await task.destroy() }
  const referenceFiles = [
    { path: 'node_modules/pdf-lib/es/core/embedders/StandardFontEmbedder.js', version: '1.17.1', license: 'MIT', reason: 'Standard Times-Roman metrics, unkerned Tj advance audit' },
    { path: 'node_modules/pdfjs-dist/legacy/build/pdf.mjs', version: '6.4.299', license: 'Apache-2.0', reason: 'Actual Node PDF.js extraction, not browser Range measurement' }
  ]
  const references = await Promise.all(referenceFiles.map(async reference => ({ ...reference, sha256: sha256(await readFile(resolve(reference.path))) })))
  const manifest = {
    schemaVersion: 1,
    source: 'PaperFlow 原创合成英文测试文字和 PDF；未复制论文、用户截图正文、外部 PDF 或字体文件，无科学事实主张。',
    license: 'AGPL-3.0-only（同项目；依赖许可单独列示）',
    generator, fixedMetadataDate: fixedDate,
    file, pages, cases, excludedRuns,
    font: {
      name: 'Times-Roman', standard: 'PDF Standard 14 / pdf-lib StandardFonts.TimesRoman', embeddedFontFile: false,
      size: fontSize, ascentAt18: font.heightAtSize(fontSize, { descender: false }),
      metricHeightAt18: font.heightAtSize(fontSize),
      reference: '本机 pdf-lib 1.17.1 的 StandardFontEmbedder 标准字体度量；PDF 引用 BaseFont /Times-Roman 名称，未复制字体文件。'
    },
    coordinates: {
      space: 'PDF default user space: origin lower left, x right, y up; points are independent of TextLayer DOM',
      widthMethod: 'sum(font.widthOfTextAtSize(each character, size)); plain Tj has no AFM pair kerning',
      pointMethod: 'first line x + 0.4 / last line x + width - 0.4; baseline y + 6 at both ends; authored once, not adjusted from browser hit results',
      lineBoxExpectation: '18 pt size and 16 pt dense baseline pitch suggest a 2 pt Range overlap; actual browser Range overlap and pixels MUST be measured by QA, not inferred from this manifest.'
    },
    extraction: { file: 'raw-extraction.json', tool: 'Node PDF.js 6.4.299', includeMarkedContent: true, useSystemFonts: false, result: 'passed: exact nonempty item text/order, glyph advance, baseline, font size, page geometry and count' },
    localReferences: references,
    verificationBoundary: { executed: ['生成原创合成 PDF', 'Node PDF.js 实际提取与制作参数逐项审计'], notExecuted: ['Electron/浏览器实际选区', 'Range 实测交叠', '选区截图和叠色像素', '剪贴板复制', '用户原文档验证'] }
  }
  const readme = [
    '# 紧行距文字选区合成素材', '',
    '本目录为 PFV-READER-005 阶段 A 的原创合成素材。英文句子仅用于测试，不复制论文、用户截图正文或外部 PDF，不表达科学事实。素材沿用项目 AGPL-3.0-only 许可；pdf-lib 为 MIT，PDF.js 为 Apache-2.0。', '',
    '## 内容与坐标', '',
    '- `tight-lines.pdf`：两页，均为 600 × 780 PDF 单位、0°、UserUnit 1。第 1 页有独立未选标题、dense-two 两行、dense-multi 五行、loose-control 两行；第 2 页只有未选 sentinel。',
    '- 正文引用 Standard 14 的 Times-Roman 字体名，18 pt；密集组基线间距 16 pt，对照组 28 pt。未嵌入或复制字体文件。最终浏览器字体替代及字框必须实测。',
    '- `manifest.json` 给出每行制作坐标、字符串、逐字 advance 总宽及完整预期行。PDF 坐标原点在左下，Y 向上；E2E 应从 PDF 点与 Canvas CSS 框独立换算，不能从 TextLayer 包围框反向瞄准。',
    '- 起点固定首字符 advance 内 x + 0.4，终点固定末字符 advance 内 x + width - 0.4，Y 均为 baseline + 6。选取字身中部，远离相邻行字框交叠边；不依据命中结果移动端点。',
    '- drawText 生成的普通 Tj 不含 AFM 成对字距调整，因此行宽使用逐字符宽度求和，而非 pdf-lib 含 kerning 的整串宽度。已与 PDF.js 实际提取 advance 对齐。', '',
    '## 可再生与实际审计', '', '在项目根目录执行：', '',
    '```powershell', 'pnpm exec tsx scripts/verification/generate-selection-overlap-fixture.ts', '```', '',
    `元数据日期固定为 ${fixedDate}，作者、标题和 producer 固定，生成内容无随机量。`,
    'manifest 保存 PDF 字节数/SHA-256、页几何和本机依赖源码引用指纹。`raw-extraction.json` 保存本次 Node PDF.js 的全部原始文字 item、styles、transform、advance 和 hasEOL；生成器逐项核对文字/顺序、坐标、字号与 advance，并销毁 loading task。生成日志及可选 Poppler 静态预览写入 `.cache/reader/20261122-overlap-01/generator/`。', '',
    '## 验证边界', '',
    '**已真实执行**：素材生成、Node PDF.js 文字提取及制作参数审计。**设计预期**：18 pt 字号与 16 pt 基线间距可能产生约 2 pt 的浏览器 Range 纵向交叠；`expectRectOverlap` 是测试预期，不是已测结论。**待 QA**：实际 Range 交叠、真实鼠标选区/剪贴板、同白底区域叠色像素及窗口/DPI 情况。静态 PDF 预览不显示浏览器 Selection，不能证明选区颜色修复，也不代表用户原 PDF 已验证。', ''
  ].join('\n')
  await mkdir(fixtureRoot, { recursive: true })
  await mkdir(auditRoot, { recursive: true })
  await writeFile(resolve(fixtureRoot, pdfName), bytes)
  await writeFile(resolve(fixtureRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(resolve(fixtureRoot, 'raw-extraction.json'), JSON.stringify({ file, pages: extraction }, null, 2) + '\n')
  await writeFile(resolve(fixtureRoot, 'README.md'), readme)
  await writeFile(resolve(auditRoot, 'generation-audit.json'), JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, file, pages: extraction, references, authoredDrawOrder: drawOrder, result: manifest.extraction.result, boundary: manifest.verificationBoundary }, null, 2) + '\n')
  console.log(JSON.stringify({ file, pages: pages.length, cases: cases.map(entry => ({ id: entry.id, start: entry.start, end: entry.end, lines: entry.lines.length })), extraction: manifest.extraction.result }, null, 2))
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
