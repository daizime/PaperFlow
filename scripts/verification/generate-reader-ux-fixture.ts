import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

interface TextPart {
  id: string
  pageNumber: number
  text: string
  font: 'Times-Roman' | 'Helvetica-Bold'
  x: number
  y: number
  size: number
  width: number
}

interface OutlineSpec {
  title: string
  pageNumber: number
  topY: number
  items?: OutlineSpec[]
}

const fixtureRoot = resolve('tests/fixtures/verification/reader-ux')
const generator = 'scripts/verification/generate-reader-ux-fixture.ts'
const pdfName = 'reader-ux-fixture.pdf'
const fixedDate = '2026-11-22T00:00:00.000Z'
const PAGE_WIDTH = 600
const PAGE_HEIGHT = 780
const MIN_MARGIN = 110

const round = (value: number): number => Number(value.toFixed(6))
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const advance = (font: PDFFont, text: string, size: number): number =>
  round([...text].reduce((sum, ch) => sum + font.widthOfTextAtSize(ch, size), 0))

function countItems(nodes: readonly OutlineSpec[]): number {
  let count = 0
  for (const node of nodes) {
    count += 1
    if (node.items) count += countItems(node.items)
  }
  return count
}

function attachOutlines(document: PDFDocument, pages: readonly PDFPage[], specs: readonly OutlineSpec[]): void {
  const context = document.context
  const outlinesRef = context.nextRef()

  function buildList(nodes: readonly OutlineSpec[], parentRef: PDFRef): { first: PDFRef; last: PDFRef } {
    const refs = nodes.map(() => context.nextRef())
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]
      const ref = refs[index]
      const dict = PDFDict.withContext(context)
      dict.set(PDFName.of('Title'), PDFHexString.fromText(node.title))
      dict.set(PDFName.of('Parent'), parentRef)
      if (index > 0) dict.set(PDFName.of('Prev'), refs[index - 1])
      if (index < nodes.length - 1) dict.set(PDFName.of('Next'), refs[index + 1])

      const targetPage = pages[node.pageNumber - 1]
      const dest = PDFArray.withContext(context)
      dest.push(targetPage.ref)
      dest.push(PDFName.of('XYZ'))
      dest.push(PDFNull)
      dest.push(PDFNumber.of(node.topY))
      dest.push(PDFNull)
      dict.set(PDFName.of('Dest'), dest)

      if (node.items && node.items.length > 0) {
        const childBounds = buildList(node.items, ref)
        dict.set(PDFName.of('First'), childBounds.first)
        dict.set(PDFName.of('Last'), childBounds.last)
        dict.set(PDFName.of('Count'), PDFNumber.of(countItems(node.items)))
      }
      context.assign(ref, dict)
    }
    return { first: refs[0], last: refs[refs.length - 1] }
  }

  const topBounds = buildList(specs, outlinesRef)
  const outlinesDict = PDFDict.withContext(context)
  outlinesDict.set(PDFName.of('Type'), PDFName.of('Outlines'))
  outlinesDict.set(PDFName.of('First'), topBounds.first)
  outlinesDict.set(PDFName.of('Last'), topBounds.last)
  outlinesDict.set(PDFName.of('Count'), PDFNumber.of(countItems(specs)))
  context.assign(outlinesRef, outlinesDict)
  document.catalog.set(PDFName.of('Outlines'), outlinesRef)
}

async function main(): Promise<void> {
  const document = await PDFDocument.create({ updateMetadata: false })
  document.setTitle('PaperFlow original synthetic reader UX fixture')
  document.setAuthor('PaperFlow synthetic verification fixtures')
  document.setSubject('Original synthetic text for outline, search, crop, and keyboard navigation checks.')
  document.setCreator('PaperFlow deterministic fixture generator')
  document.setProducer('pdf-lib 1.17.1 / PaperFlow synthetic fixture')
  document.setCreationDate(new Date(fixedDate))
  document.setModificationDate(new Date(fixedDate))

  const roman = await document.embedFont(StandardFonts.TimesRoman)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const fonts: Record<TextPart['font'], PDFFont> = {
    'Times-Roman': roman,
    'Helvetica-Bold': bold
  }

  const makePart = (
    id: string,
    pageNumber: number,
    text: string,
    font: TextPart['font'],
    x: number,
    y: number,
    size: number
  ): TextPart => ({
    id,
    pageNumber,
    text,
    font,
    x,
    y,
    size,
    width: advance(fonts[font], text, size)
  })

  const parts: TextPart[] = [
    // Page 1
    makePart('p1-heading', 1, '1. Synthetic Overview', 'Helvetica-Bold', 135, 610, 15),
    makePart('p1-sub', 1, '1.1 Search and Selection Anchor', 'Helvetica-Bold', 135, 584, 13),
    makePart('p1-exact', 1, 'Primary token: QUANTUM_BENCHMARK alpha pass.', 'Times-Roman', 135, 556, 12),
    makePart('p1-mixed', 1, 'Mixed token: Quantum_Benchmark lowercase probe.', 'Times-Roman', 135, 534, 12),
    makePart('p1-select', 1, 'Selectable cropped sentence for clipboard audit.', 'Times-Roman', 135, 506, 12),
    makePart('p1-footer', 1, 'Page 1 anchor inside wide margin frame.', 'Times-Roman', 135, 165, 11),

    // Page 2
    makePart('p2-heading', 2, '2. Cropped Layout Methods', 'Helvetica-Bold', 135, 610, 15),
    makePart('p2-sub', 2, '2.1 Nested Bookmark Target', 'Helvetica-Bold', 135, 584, 13),
    makePart('p2-exact', 2, 'Second hit: QUANTUM_BENCHMARK verification row.', 'Times-Roman', 135, 556, 12),
    makePart('p2-mixed', 2, 'Mixed case variant: quantum_benchmark check.', 'Times-Roman', 135, 534, 12),
    makePart('p2-footer', 2, 'Page 2 anchor inside wide margin frame.', 'Times-Roman', 135, 165, 11),

    // Page 3
    makePart('p3-heading', 3, '3. Keyboard and Search Wrap', 'Helvetica-Bold', 135, 610, 15),
    makePart('p3-sub', 3, '3.1 Final Section Target', 'Helvetica-Bold', 135, 584, 13),
    makePart('p3-exact', 3, 'Third hit: QUANTUM_BENCHMARK final occurrence.', 'Times-Roman', 135, 556, 12),
    makePart('p3-mixed', 3, 'Title case variant: Quantum_Benchmark wrap test.', 'Times-Roman', 135, 534, 12),
    makePart('p3-footer', 3, 'Page 3 anchor inside wide margin frame.', 'Times-Roman', 135, 165, 11)
  ]

  const pages: PDFPage[] = [1, 2, 3].map(() => document.addPage([PAGE_WIDTH, PAGE_HEIGHT]))
  const pageBounds = [1, 2, 3].map(number => {
    const pageParts = parts.filter(part => part.pageNumber === number)
    const page = pages[number - 1]
    for (const part of pageParts) {
      if (
        part.x < MIN_MARGIN ||
        part.x + part.width > PAGE_WIDTH - MIN_MARGIN ||
        part.y < MIN_MARGIN ||
        part.y + part.size > PAGE_HEIGHT - MIN_MARGIN
      ) {
        throw new Error(`Part ${part.id} violates >= ${MIN_MARGIN}pt white margin invariant`)
      }
      page.drawText(part.text, {
        x: part.x,
        y: part.y,
        size: part.size,
        font: fonts[part.font],
        color: rgb(0, 0, 0)
      })
    }
    const minX = round(Math.min(...pageParts.map(part => part.x)))
    const maxX = round(Math.max(...pageParts.map(part => part.x + part.width)))
    const minY = round(Math.min(...pageParts.map(part => part.y)))
    const maxY = round(Math.max(...pageParts.map(part => part.y + part.size)))
    return {
      number,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      rotation: 0,
      view: [0, 0, PAGE_WIDTH, PAGE_HEIGHT],
      contentBounds: { minX, maxX, minY, maxY },
      marginsPt: {
        left: minX,
        right: round(PAGE_WIDTH - maxX),
        bottom: minY,
        top: round(PAGE_HEIGHT - maxY)
      }
    }
  })

  const outlineSpecs: OutlineSpec[] = [
    {
      title: '1. Synthetic Overview',
      pageNumber: 1,
      topY: 640,
      items: [{ title: '1.1 Search and Selection Anchor', pageNumber: 1, topY: 600 }]
    },
    {
      title: '2. Cropped Layout Methods',
      pageNumber: 2,
      topY: 640,
      items: [{ title: '2.1 Nested Bookmark Target', pageNumber: 2, topY: 600 }]
    },
    {
      title: '3. Keyboard and Search Wrap',
      pageNumber: 3,
      topY: 640,
      items: [{ title: '3.1 Final Section Target', pageNumber: 3, topY: 600 }]
    }
  ]

  attachOutlines(document, pages, outlineSpecs)

  const bytes = await document.save({ useObjectStreams: false })
  const file = { name: pdfName, bytes: bytes.length, sha256: sha256(bytes) }

  // Audit generated PDF using Node pdfjs-dist
  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
    useSystemFonts: false
  })

  const auditedOutlines: Array<{ title: string; pageNumber: number; items: Array<{ title: string; pageNumber: number }> }> = []
  const perPageSearch: Array<{ pageNumber: number; caseInsensitiveCount: number; caseSensitiveCount: number }> = []

  try {
    const pdf = await task.promise
    if (pdf.numPages !== 3) throw new Error(`Expected 3 pages, got ${pdf.numPages}`)
    const rawOutline = await pdf.getOutline()
    if (!rawOutline || rawOutline.length !== 3) {
      throw new Error(`Expected 3 top-level outline nodes, got ${rawOutline?.length ?? 0}`)
    }

    const resolveOutlinePage = async (dest: string | unknown[] | null): Promise<number> => {
      if (!dest) throw new Error('Outline node missing dest')
      const arr = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
      if (!Array.isArray(arr) || !arr[0]) throw new Error('Invalid outline dest array')
      const idx = await pdf.getPageIndex(arr[0] as Parameters<typeof pdf.getPageIndex>[0])
      return idx + 1
    }

    for (let i = 0; i < rawOutline.length; i++) {
      const node = rawOutline[i]
      const pageNumber = await resolveOutlinePage(node.dest)
      if (pageNumber !== outlineSpecs[i].pageNumber) {
        throw new Error(`Outline "${node.title}" resolved to page ${pageNumber}, expected ${outlineSpecs[i].pageNumber}`)
      }
      const children: Array<{ title: string; pageNumber: number }> = []
      for (let j = 0; j < (node.items?.length ?? 0); j++) {
        const child = node.items[j] as { title: string; dest: string | unknown[] | null }
        const childPage = await resolveOutlinePage(child.dest)
        const expectedChildPage = outlineSpecs[i].items?.[j]?.pageNumber
        if (childPage !== expectedChildPage) {
          throw new Error(`Nested outline "${child.title}" resolved to page ${childPage}, expected ${expectedChildPage}`)
        }
        children.push({ title: child.title, pageNumber: childPage })
      }
      auditedOutlines.push({ title: node.title, pageNumber, items: children })
    }

    for (let number = 1; number <= 3; number++) {
      const page = await pdf.getPage(number)
      const content = await page.getTextContent({ includeMarkedContent: true })
      const joined = content.items
        .flatMap(item => ('str' in item ? [item.str] : []))
        .join('\n')
      const sensitive = joined.match(/QUANTUM_BENCHMARK/g)?.length ?? 0
      const insensitive = joined.match(/quantum_benchmark/gi)?.length ?? 0
      if (sensitive !== 1 || insensitive !== 2) {
        throw new Error(`Page ${number} search audit failed: sensitive=${sensitive}, insensitive=${insensitive}`)
      }
      perPageSearch.push({ pageNumber: number, caseInsensitiveCount: insensitive, caseSensitiveCount: sensitive })
    }
  } finally {
    await task.destroy()
  }

  const selectPart = parts.find(part => part.id === 'p1-select')!
  const manifest = {
    schemaVersion: 1,
    source: 'PaperFlow 原创合成阅读器 UX 验证 PDF；不复制任何真实论文内容。',
    license: 'AGPL-3.0-only',
    generator,
    fixedMetadataDate: fixedDate,
    file,
    pages: pageBounds,
    outlines: auditedOutlines,
    search: {
      query: 'QUANTUM_BENCHMARK',
      caseInsensitiveCount: 6,
      caseSensitiveCount: 3,
      perPage: perPageSearch
    },
    selection: {
      pageNumber: 1,
      start: { x: round(selectPart.x + 0.4), y: selectPart.y + 5 },
      end: { x: round(selectPart.x + selectPart.width - 0.4), y: selectPart.y + 5 },
      expectedText: selectPart.text
    },
    parts
  }

  const readme = [
    '# Reader UX 验证合成素材',
    '',
    '本目录为 PaperFlow 原创合成阅读器核心交互验证素材（3 页，600 × 780 pt，Standard 14 字体），不复制任何外部文献。',
    '',
    '## 素材结构',
    '',
    '- 真实 PDF `/Outlines` 目录书签：包含 3 个一级章节与 3 个嵌套子章节，分别指向第 1–3 页。',
    `- 每页正文均落在宽白边安全区内（四边留白均 >= ${MIN_MARGIN} pt），用于验证白边裁剪与裁剪后适合宽度放大。`,
    '- 第 1–3 页每页各含 1 处全大写 `QUANTUM_BENCHMARK` 与 1 处大小写混合变体（共 6 处不区分大小写 / 3 处区分大小写），用于文内搜索与跨页跳转。',
    '- 第 1 页含固定 PDF 坐标的 `Selectable cropped sentence for clipboard audit.`，用于验证白边裁剪状态下的鼠标拖选与 `Ctrl+C` 复制保真。',
    '',
    '## 生成与审计',
    '',
    '```powershell',
    `pnpm.cmd exec tsx ${generator}`,
    '```',
    '',
    '已通过 Node `pdfjs-dist` 校验页数、`/Outlines` 书签及页码解析、`QUANTUM_BENCHMARK` 各页文本匹配次数和四边白边留白尺寸。',
    ''
  ].join('\n')

  await mkdir(fixtureRoot, { recursive: true })
  await writeFile(resolve(fixtureRoot, pdfName), bytes)
  await writeFile(resolve(fixtureRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(resolve(fixtureRoot, 'README.md'), readme)

  console.log(JSON.stringify({ file, auditedOutlines, perPageSearch, pageBounds }, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
