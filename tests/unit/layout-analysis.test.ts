import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  analyzePageLayout,
  projectPdfRectsToViewport,
  refineDocumentHeadersFooters,
  type PageLayoutResult
} from '../../src/renderer/src/features/reader/layout-analysis'
import { extractPageGraphicHints } from '../../src/renderer/src/features/reader/pdf-graphics'
import { isTranslatableBlock } from '../../src/renderer/src/features/translation/sentence-alignment'
import type { PageGeometry, PageTextContent } from '../../src/renderer/src/features/reader/pdf-geometry'
import layoutManifest from '../fixtures/verification/layout-analysis/manifest.json'

const pdfOptions = {
  standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
  useSystemFonts: false,
  stopAtErrors: true
}

let academicPdf: PDFDocumentProxy
let academicTask: ReturnType<typeof getDocument>
let selectionPdf: PDFDocumentProxy
let selectionTask: ReturnType<typeof getDocument>

async function analyzeRealPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  scale = 1
): Promise<{ layout: PageLayoutResult; geometry: PageGeometry }> {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale })
  const geometry: PageGeometry = {
    pageNumber,
    viewport,
    outputScale: { x: 1, y: 1 }
  }
  const textContent = (await page.getTextContent({ includeMarkedContent: true })) as PageTextContent
  const layout = analyzePageLayout(textContent, geometry)
  page.cleanup()
  return { layout, geometry }
}

beforeAll(async () => {
  const academicBytes = new Uint8Array(
    await readFile(resolve('tests/fixtures/verification/layout-analysis', layoutManifest.file.name))
  )
  academicTask = getDocument({ ...pdfOptions, data: academicBytes })
  academicPdf = await academicTask.promise

  const selectionBytes = new Uint8Array(
    await readFile(resolve('tests/fixtures/verification/selection/blank-drag-columns-formulas.pdf'))
  )
  selectionTask = getDocument({ ...pdfOptions, data: selectionBytes })
  selectionPdf = await selectionTask.promise
})

afterAll(async () => {
  await academicTask?.destroy()
  await selectionTask?.destroy()
})

describe('layout-analysis: multi-column reading order, hyphenation, cross-column stitching, and filtering', () => {
  test('reconstructs interleaved two-column reading order, hyphenation, abbreviations, and block kinds on page 1', async () => {
    const { layout } = await analyzeRealPage(academicPdf, 1, 1)

    expect(layout.hasText).toBe(true)
    expect(layout.columnCount).toBe(2)

    const actualTexts = layout.sentences.map(s => s.text)
    expect(actualTexts).toEqual(layoutManifest.expectedOrder.page1)

    // 确认断词与保留前缀复合词均准确合并
    expect(actualTexts[2]).toContain('architecture')
    expect(actualTexts[2]).toContain('(e.g., Smith et al., 2025).')
    expect(actualTexts[3]).toContain('Fig. 1, the scale factor is 3.14 with self-attention weights')

    // 确认语义分类准确
    expect(layout.sentences[0].blockKind).toBe('heading')
    expect(layout.sentences[1].blockKind).toBe('heading')
    expect(layout.sentences[4].blockKind).toBe('formula')
    expect(layout.sentences[4].text).toBe('E = mc^2 + alpha (1)')
    expect(layout.sentences[7].blockKind).toBe('caption')
    expect(layout.sentences[8].blockKind).toBe('heading')

    // 确认跨栏未完句合并为单句且矩形覆盖第1栏与第2栏
    const crossSentence = layout.sentences[5]
    expect(crossSentence.text).toBe('The deterministic layout pipeline reconstructs column boundaries.')
    expect(crossSentence.crossColumn).toBe(true)
    expect(crossSentence.fragments.length).toBe(2)
    expect(crossSentence.fragments.map(f => f.columnIndex)).toEqual([1, 2])
    expect(crossSentence.rects.length).toBe(2)

    // 确认页眉与页码已过滤
    const filteredTexts = layout.filteredItems.map(item => item.text)
    expect(filteredTexts).toContain('Synthetic Journal of Layout Audits')
    expect(filteredTexts).toContain('- 1 -')
  })

  test('segments upper/lower two-column bands around middle spanning table on page 2', async () => {
    const { layout } = await analyzeRealPage(academicPdf, 2, 1)

    expect(layout.columnCount).toBe(2)
    expect(layout.sentences.map(s => s.text)).toEqual(layoutManifest.expectedOrder.page2)

    const spanningTable = layout.sentences.find(s => s.text.startsWith('Table 1:'))
    expect(spanningTable?.blockKind).toBe('caption')
    expect(spanningTable?.columnIndex).toBe(0)
  })

  test('sentence IDs and unscaled PDF bounds remain invariant between scale 1.0 and 2.0', async () => {
    const res1 = await analyzeRealPage(academicPdf, 1, 1.0)
    const res2 = await analyzeRealPage(academicPdf, 1, 2.0)

    expect(res2.layout.sentences.map(s => s.id)).toEqual(res1.layout.sentences.map(s => s.id))
    expect(res2.layout.sentences.map(s => s.text)).toEqual(res1.layout.sentences.map(s => s.text))

    // 从未缩放 PDF 坐标分别投影到 1x 与 2x viewport，尺寸比精确为 2.0
    for (let i = 0; i < res1.layout.sentences.length; i += 1) {
      const s1 = res1.layout.sentences[i]
      const s2 = res2.layout.sentences[i]
      expect(Math.abs(s1.bounds.x - s2.bounds.x)).toBeLessThan(1e-4)
      expect(Math.abs(s1.bounds.y - s2.bounds.y)).toBeLessThan(1e-4)

      const projected1 = projectPdfRectsToViewport(res1.geometry, s1.rects)
      const projected2 = projectPdfRectsToViewport(res2.geometry, s2.rects)
      for (let r = 0; r < projected1.length; r += 1) {
        expect(projected2[r].x).toBeCloseTo(projected1[r].x * 2, 3)
        expect(projected2[r].y).toBeCloseTo(projected1[r].y * 2, 3)
        expect(projected2[r].width).toBeCloseTo(projected1[r].width * 2, 3)
        expect(projected2[r].height).toBeCloseTo(projected1[r].height * 2, 3)
      }
    }
  })

  test('handles interleaved column fixture and 90-degree rotated page without dropping text or distorting PDF coordinates', async () => {
    const p1 = await analyzeRealPage(selectionPdf, 1, 1)
    const p2 = await analyzeRealPage(selectionPdf, 2, 1.5)

    expect(p1.layout.hasText).toBe(true)
    expect(p1.layout.columnCount).toBe(2)

    const p1Texts = p1.layout.sentences.map(s => s.text)
    const idxLeftAlpha = p1Texts.findIndex(t => t.includes('LEFT_ALPHA_TARGET'))
    const idxLeftGamma = p1Texts.findIndex(t => t.includes('LEFT_GAMMA_OTHER'))
    const idxRightAlpha = p1Texts.findIndex(t => t.includes('RIGHT_ALPHA_OTHER'))
    expect(idxLeftAlpha).toBeGreaterThanOrEqual(0)
    expect(idxLeftGamma).toBeGreaterThanOrEqual(idxLeftAlpha)
    // 左栏全部读完后再进入右栏（彻底解开 PDF 流里的 L1, R1, L2, R2 交错，且不将左右栏混入同一句）
    expect(idxRightAlpha).toBeGreaterThan(idxLeftGamma)
    expect(p1Texts.some(t => t.includes('LEFT_') && t.includes('RIGHT_'))).toBe(false)

    // 90° 旋转第 2 页也能完整识别两栏并把 PDF 矩形准确映射回旋转后的 viewport
    expect(p2.layout.hasText).toBe(true)
    expect(p2.layout.columnCount).toBe(2)
    expect(p2.layout.sentences.map(s => s.text)).toEqual(p1.layout.sentences.map(s => s.text))

    const p2Left = p2.layout.sentences.find(s => s.text.includes('LEFT_ALPHA_TARGET'))!
    const projected = projectPdfRectsToViewport(p2.geometry, p2Left.rects)
    expect(projected[0].width).toBeGreaterThan(0)
    expect(projected[0].height).toBeGreaterThan(0)
  })

  test('refineDocumentHeadersFooters removes repeating margin blocks across multiple pages', async () => {
    const { layout: p1 } = await analyzeRealPage(academicPdf, 1, 1)
    const { layout: p2 } = await analyzeRealPage(academicPdf, 2, 1)

    // 模拟未在单页规则滤除但重复出现在两页顶部的运行页眉（如 y=100 处，落入顶部 22% 区）
    const makeFakeRunningHeader = (pageNumber: number, text: string) => ({
      id: `p${pageNumber}-b000`,
      pageNumber,
      order: 0,
      kind: 'paragraph' as const,
      columnIndex: 0,
      fontSize: 9.5,
      isBold: false,
      bounds: { x: 54, y: 690, width: 210, height: 10 },
      displayBounds: { x: 54, y: 95, width: 210, height: 10 },
      sentences: [
        {
          id: `fake-header-${pageNumber}`,
          pageNumber,
          order: 0,
          blockId: `p${pageNumber}-b000`,
          blockKind: 'paragraph' as const,
          columnIndex: 0,
          text,
          rects: [{ x: 54, y: 690, width: 210, height: 10 }],
          displayRects: [{ x: 54, y: 95, width: 210, height: 10 }],
          bounds: { x: 54, y: 690, width: 210, height: 10 },
          displayBounds: { x: 54, y: 95, width: 210, height: 10 },
          fragments: [],
          crossColumn: false
        }
      ]
    })

    const map = new Map<number, PageLayoutResult>([
      [1, { ...p1, blocks: [makeFakeRunningHeader(1, 'Proceedings Vol. 12'), ...p1.blocks] }],
      [2, { ...p2, blocks: [makeFakeRunningHeader(2, 'Proceedings Vol. 13'), ...p2.blocks] }]
    ])

    const refined = refineDocumentHeadersFooters(map)
    expect(refined.get(1)!.blocks.length).toBe(p1.blocks.length)
    expect(refined.get(2)!.blocks.length).toBe(p2.blocks.length)
    expect(refined.get(1)!.filteredItems.some(f => f.text === 'Proceedings Vol. 12' && f.reason === 'header')).toBe(true)
    expect(refined.get(2)!.filteredItems.some(f => f.text === 'Proceedings Vol. 13' && f.reason === 'header')).toBe(true)
  })

  test('never merges narrow-gutter (10pt/12pt) two-column lines into spanning sentences while keeping true spanning titles intact', async () => {
    const realPage = await academicPdf.getPage(1)
    const viewport = realPage.getViewport({ scale: 1 })
    realPage.cleanup()
    const geometry: PageGeometry = {
      pageNumber: 1,
      viewport,
      outputScale: { x: 1, y: 1 }
    }

    const makeTextItem = (str: string, x: number, pdfY: number, width: number, size: number, bold = false) => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, pdfY] as [number, number, number, number, number, number],
      fontName: bold ? 'F2' : 'F1',
      hasEOL: false
    })

    // 模拟 Springer/IEEE 窄栏隙双栏页：正文字号 9.5pt，左右两栏齐行边界间隙仅 10pt（285..295，小于旧版 16pt 硬阈值），
    // 且顶部含真正通栏大标题（中间某单词空格恰好落在 290 附近但不应被拆断）。
    const items = [
      // 通栏标题：总宽 ~495pt，词间隙约 5pt（<< 栏隙），不能误拆
      makeTextItem('Incremental Maintenance over Recursive', 50, 708, 236, 15, true),
      makeTextItem('View Hierarchies in Relational Engines', 291, 708, 254, 15, true),

      // 第 1 行左/右齐行（间隙 12pt: 284..296）
      makeTextItem('We now turn to incremental view maintenance. F-IVM', 50, 668, 234, 9.5),
      makeTextItem('Figure 2 overviews the main components of F-IVM, anno-', 296, 668, 249, 9.5),

      // 第 2 行左/右齐行，且左栏恰好在中间连字符换行，右栏同时出现逗号断句（极端紧间隙 10pt: 285..295）
      makeTextItem('input relations, for incremental computation we may materi-', 50, 654, 235, 9.5),
      makeTextItem('computation, rely on queries with natural joins and group-', 295, 654, 250, 9.5),

      // 第 3 行左/右各自断词续接（间隙 11pt: 284..295）
      makeTextItem('alize additional views to speed up maintenance tasks.', 50, 640, 234, 9.5),
      makeTextItem('by aggregates, where each aggregate rings over tuples.', 295, 640, 250, 9.5),

      // 第 4 行（间隙 12pt）
      makeTextItem('Queries and delta rules evaluate view trees smoothly.', 50, 626, 233, 9.5),
      makeTextItem('Section 3 details the algebraic data model and queries.', 295, 626, 248, 9.5)
    ]

    const textContent: PageTextContent = {
      items,
      styles: {
        F1: { fontFamily: 'Times New Roman', ascent: 0.72, descent: -0.22, vertical: false },
        F2: { fontFamily: 'Helvetica Bold', ascent: 0.75, descent: -0.2, vertical: false }
      },
      lang: null
    }

    const layout = analyzePageLayout(textContent, geometry)
    expect(layout.columnCount).toBe(2)

    const allSentenceTexts = layout.sentences.map(s => s.text)
    expect(allSentenceTexts[0]).toBe('Incremental Maintenance over Recursive View Hierarchies in Relational Engines')
    expect(layout.blocks[0].columnIndex).toBe(0)
    expect(layout.blocks[0].kind).toBe('heading')

    // 左右两栏绝不能在窄栏隙处粘连为同一条跨栏句或同一块
    expect(allSentenceTexts.some(t => t.includes('materialize') && t.includes('rely on queries'))).toBe(false)
    expect(allSentenceTexts.some(t => t.includes('We now turn to incremental') && t.includes('Figure 2 overviews'))).toBe(
      false
    )

    // 左栏断词拼接正确、右栏 group-by 保留学术复合连字符或正常读取且排序在左栏之后
    const leftIdx = allSentenceTexts.findIndex(t => t.includes('we may materialize additional views'))
    const rightIdx = allSentenceTexts.findIndex(t => t.includes('computation, rely on queries with natural joins'))
    expect(leftIdx).toBeGreaterThan(0)
    expect(rightIdx).toBeGreaterThan(leftIdx)
  })

  test('keeps continuous column paragraphs intact despite adjacent tall math operators or line-start inline citations', async () => {
    const realPage = await academicPdf.getPage(1)
    const viewport = realPage.getViewport({ scale: 1 })
    realPage.cleanup()
    const geometry: PageGeometry = {
      pageNumber: 1,
      viewport,
      outputScale: { x: 1, y: 1 }
    }

    const makeTextItem = (str: string, x: number, pdfY: number, width: number, size: number) => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, pdfY] as [number, number, number, number, number, number],
      fontName: 'F1',
      hasEOL: false
    })

    // 1. 左栏 4 行连续正文（12.5pt 间距）旁侧存在右栏大号跨基线数学算符，绝不能把左栏两行融合成单一 LineSegment 并引发段内腰斩；
    // 2. 第 5 行行首以 "[44]." 引文编号开头而上一行未句末收束时，必须并入同段并归属于上一句，不能被误拆为 list-item。
    const items = [
      makeTextItem('Our framework decomposes updates into a union of fac-', 51, 680, 238, 10),
      makeTextItem('⊕', 360, 672, 16, 18),
      makeTextItem('torizable relations. The cumulative size is smaller than sub-', 51, 667.5, 238, 10),
      makeTextItem('E', 378, 661, 8, 7.5),
      makeTextItem('linear bounds, recovering prior work on this', 51, 655, 210, 10),
      makeTextItem('[44].', 51, 642.5, 20, 10),
      makeTextItem('Matrix chain computation follows naturally.', 74, 642.5, 195, 10),
      makeTextItem('Figure 2 shows another example on the right column.', 306, 655, 238, 10)
    ]

    const textContent: PageTextContent = {
      items,
      styles: {
        F1: { fontFamily: 'Times New Roman', ascent: 0.72, descent: -0.22, vertical: false }
      },
      lang: null
    }

    const layout = analyzePageLayout(textContent, geometry)
    const col1Blocks = layout.blocks.filter(b => b.columnIndex === 1)
    expect(col1Blocks).toHaveLength(1)
    expect(col1Blocks[0].kind).toBe('paragraph')
    expect(col1Blocks[0].sentences.map(s => s.text)).toEqual([
      'Our framework decomposes updates into a union of factorizable relations.',
      'The cumulative size is smaller than sub-linear bounds, recovering prior work on this [44].',
      'Matrix chain computation follows naturally.'
    ])
  })

  test('preserves prose lines containing dense inline math while isolating standalone formula/symbol fragments and non-prose digits', async () => {
    const realPage = await academicPdf.getPage(1)
    const viewport = realPage.getViewport({ scale: 1 })
    realPage.cleanup()
    const geometry: PageGeometry = {
      pageNumber: 1,
      viewport,
      outputScale: { x: 1, y: 1 }
    }

    const makeTextItem = (str: string, x: number, pdfY: number, width: number, size: number, bold = false) => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, pdfY] as [number, number, number, number, number, number],
      fontName: bold ? 'F2' : 'F1',
      hasEOL: false
    })

    const items = [
      // 含高密度行内数学表达的连续英文正文（必须完整并入段落，不能误判为 formula 而漏译）
      makeTextItem('Example 9 Arbitrary relations can be decomposed. The relation R[A, B] =', 51, 700, 238, 10),
      makeTextItem('{(ai, bj) → 1 | i ∈ [n], j ∈ [m]} can be decomposed as R1[A] ⊗ R2[B], where', 51, 686, 238, 10),
      makeTextItem('R2[B] = {(bj) → 1 | j ∈ [m]}. Consider now R′[A, B] = R[A, B] −', 51, 672, 238, 10),
      makeTextItem('δSA[A] ⊗ δSC[C] ⊗ δSE[E]. In the construction of the delta tree.', 51, 658, 238, 10),

      // 孤立展示公式/算符/上下标/控制字符碎片（必须归为 formula 保持底图原样）
      makeTextItem('⊕', 110, 624, 12, 10),
      makeTextItem('@A', 124, 628, 12, 7.6),
      makeTextItem('A VR[A] ⊗ δV@E[A,C]', 138, 624, 96, 10),
      makeTextItem('RST', 170, 608, 14, 6.5),
      makeTextItem('︸ ︸', 142, 594, 48, 10),
      makeTextItem('\u0005\u0006', 280, 578, 8, 10),

      // 大字号纯数字出版商页脚/编号（不能误分类为 heading）
      makeTextItem('123', 480, 578, 36, 14.9, true)
    ]

    const textContent: PageTextContent = {
      items,
      styles: {
        F1: { fontFamily: 'Times New Roman', ascent: 0.72, descent: -0.22, vertical: false },
        F2: { fontFamily: 'Helvetica Bold', ascent: 0.75, descent: -0.2, vertical: false }
      },
      lang: null
    }

    const layout = analyzePageLayout(textContent, geometry)
    const proseBlock = layout.blocks.find(b => b.sentences.some(s => s.text.includes('Example 9')))
    expect(proseBlock?.kind).toBe('paragraph')
    expect(proseBlock?.sentences.map(s => s.text).join(' ')).toContain('can be decomposed as R1[A] ⊗ R2[B], where')
    expect(proseBlock?.sentences.map(s => s.text).join(' ')).toContain('Consider now R′[A, B]')
    expect(proseBlock?.sentences.map(s => s.text).join(' ')).toContain('In the construction of the delta tree.')

    for (const token of ['@A', 'RST', '︸ ︸', '\u0005\u0006']) {
      const b = layout.blocks.find(block => block.sentences.some(s => s.text.includes(token)))
      expect(b?.kind).toBe('formula')
    }

    const digitBlock = layout.blocks.find(b => b.sentences.some(s => s.text.trim() === '123'))
    expect(digitBlock?.kind).not.toBe('heading')
  })

  test('binds superscripts/subscripts and offset math symbols to their horizontal host rows and extracts inline formula snapshots', async () => {
    const realPage = await academicPdf.getPage(1)
    const viewport = realPage.getViewport({ scale: 1 })
    realPage.cleanup()
    const geometry: PageGeometry = {
      pageNumber: 1,
      viewport,
      outputScale: { x: 1, y: 1 }
    }

    const mk = (str: string, x: number, pdfY: number, width: number, size: number, fontName = 'F1') => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, pdfY] as [number, number, number, number, number, number],
      fontName,
      hasEOL: false
    })

    // 复现双栏 PDF 真实痛点：
    // 1. 左栏存在相邻基线文本行，右栏第二行含下沉下标 RST/T/R 及上标 @A/@D/@B，小字号下标必须归入右栏第二行而非左栏或第三行；
    // 2. 第一行结尾为普通英语 exploits，第二行含略上浮的 ⊕_X，不能被误吸到第一行变成 join⊕。
    const items = [
      // 左栏同纵坐标行（不能抢走右栏下标）
      mk('computing left column baseline text safely without math theft.', 51, 432, 230, 10, 'F1'),
      mk('next left column line running parallel below.', 51, 419.5, 210, 10, 'F1'),

      // 右栏第 1 段：⊕_X 与上方 exploits 在同一垂直邻域但水平分离于 Line 2 内部
      mk('The Optimize method exploits distributivity', 306, 444.5, 220, 10, 'F1'),
      mk('marginalization', 306, 432, 62, 10, 'F1'),
      mk('⊕', 371.5, 439.5, 11, 10, 'F_MATH'),
      mk('X', 383.2, 429.1, 4.6, 7.6, 'F_VAR'),
      mk('to push joins.', 392, 432, 65, 10, 'F1'),

      // 右栏第 2 段：stacked @A / RST + 花体 O(1) + 跨栏陷阱下标
      mk('A single-tuple update ', 306, 410, 92, 10, 'F1'),
      mk('δS', 399, 410, 10, 10, 'F_SYM'),
      mk(' binds variables.', 410, 410, 80, 10, 'F1'),
      mk('computing', 306, 397.5, 42, 10, 'F1'),
      mk('δV', 350.5, 397.5, 10, 10, 'F_SYM'),
      mk('@A', 361, 401.1, 11, 7.6, 'F_VAR'),
      mk('RST', 360.8, 394, 11.6, 7.6, 'F_VAR'),
      mk('requires', 375, 397.5, 32, 10, 'F1'),
      mk('O', 409, 397.5, 8, 10, 'F_CAL'),
      mk('(', 417, 397.5, 3.7, 10, 'F_SYM'),
      mk('1', 420.8, 397.5, 5, 10, 'F1'),
      mk(')', 425.8, 397.5, 3.7, 10, 'F_SYM'),
      mk('lookups in ', 432, 397.5, 42, 10, 'F1'),
      mk('V', 475, 397.5, 6, 10, 'F1'),
      mk('R', 481, 394, 4.5, 7.6, 'F_VAR'),
      mk(' [44].', 487, 397.5, 25, 10, 'F1'),
      mk('An arbitrary-sized update completes in linear time.', 306, 385, 220, 10, 'F1')
    ]

    const textContent: PageTextContent = {
      items,
      styles: {
        F1: { fontFamily: 'Times New Roman', ascent: 0.72, descent: -0.22, vertical: false },
        F_MATH: { fontFamily: 'Symbol', ascent: 0.72, descent: -0.22, vertical: false },
        F_VAR: { fontFamily: 'Times Italic', ascent: 0.7, descent: -0.2, vertical: false },
        F_SYM: { fontFamily: 'Symbol', ascent: 0.72, descent: -0.22, vertical: false },
        F_CAL: { fontFamily: 'CMSY', ascent: 0.72, descent: -0.22, vertical: false }
      },
      lang: null
    }

    const layout = analyzePageLayout(textContent, geometry)
    const optimizeBlock = layout.blocks.find(b => b.sentences.some(s => s.text.includes('Optimize')))!
    expect(optimizeBlock).toBeDefined()
    expect(optimizeBlock.sentences.map(s => s.text).join(' ')).toContain('marginalization ⊕X to push joins.')
    expect(optimizeBlock.sentences.map(s => s.text).join(' ')).not.toContain('distributivity ⊕')
    const oplusFormula = optimizeBlock.inlineFormulas?.find(f => f.fallbackText.includes('⊕'))
    expect(oplusFormula).toBeDefined()
    expect(oplusFormula!.displayRect.y).toBeGreaterThanOrEqual(792 - 444.5 + 1.8)
    expect(oplusFormula!.displayRect.height).toBeLessThanOrEqual(16)
    expect(optimizeBlock.translationSourceText).toContain('⟪M1⟫')
    expect(optimizeBlock.translationSourceText).toContain('Optimize')

    const deltaBlock = layout.blocks.find(b => b.sentences.some(s => s.text.includes('single-tuple update')))!
    expect(deltaBlock).toBeDefined()
    const plainText = deltaBlock.sentences.map(s => s.text).join(' ')
    expect(plainText).toContain('computing δVRST@A requires O(1) lookups')
    expect(plainText).not.toContain('updateRST')
    expect(deltaBlock.inlineFormulas?.some(f => f.fallbackText.includes('δV') && f.fallbackText.includes('RST'))).toBe(true)
    expect(deltaBlock.inlineFormulas?.some(f => f.fallbackText === 'O(1)')).toBe(true)
    expect(deltaBlock.translationSourceText).toContain('[44].')
    expect(deltaBlock.translationSourceText).toContain('⟪M1⟫')
  })

  test('extractPageGraphicHints extracts scale-invariant tables, images, vector diagrams, and fraction bars while ignoring shading/clips', async () => {
    const page1 = await academicPdf.getPage(1)
    const viewport1 = page1.getViewport({ scale: 1 })
    const viewport2 = page1.getViewport({ scale: 2 })
    page1.cleanup()

    // 合成 PDF 绘制指令列表（合成素材），覆盖 save/restore/transform/FormXObject/beginGroup/image/constructPath
    const operatorList = {
      fnArray: [
        10, // save (image)
        12, // transform -> (60, 260, 140x90)
        85, // paintImageXObject
        11, // restore
        // 3 条水平表线（模拟 booktabs 三线表，y_pdf = 580, 560, 500, x = 305..540）
        91, // constructPath fill (rule 1)
        91, // constructPath stroke (rule 2)
        91, // constructPath stroke (rule 3)
        // 短分式线 (y_pdf = 420, x = 120..146)
        91,
        // 矢量图 FormXObject + beginGroup/endGroup（含 3 条描边线）
        74, // paintFormXObjectBegin
        76, // beginGroup
        91, // constructPath stroke
        91, // constructPath stroke
        91, // constructPath stroke
        77, // endGroup
        75, // paintFormXObjectEnd
        // 宽大浅色填充底纹框（不得误识别为图片/矢量图）
        91, // constructPath fill-only (226x70)
        // 仅裁剪路径 endPath=28（不得进入任何图形分类）
        91
      ],
      argsArray: [
        null,
        [140, 0, 0, 90, 60, 260],
        ['img_0'],
        null,
        [22, [], new Float32Array([305, 580, 540, 580.8])],
        [20, [], new Float32Array([305, 560, 540, 560.8])],
        [20, [], new Float32Array([305, 500, 540, 500.8])],
        [22, [], new Float32Array([120, 420, 146, 420.6])],
        [[1, 0, 0, 1, 320, 180], [0, 0, 200, 110]],
        [{ needsIsolation: true }],
        [20, [], [10, 10, 180, 10]],
        [20, [], [10, 10, 10, 90]],
        [24, [], [40, 20, 120, 80]],
        [{}],
        [],
        [22, [], new Float32Array([54, 150, 280, 220])],
        [28, [], new Float32Array([54, 100, 260, 160])]
      ]
    }

    const hints1 = extractPageGraphicHints(operatorList, { pageNumber: 1, viewport: viewport1, outputScale: { x: 1, y: 1 } })
    const hints2 = extractPageGraphicHints(operatorList, { pageNumber: 1, viewport: viewport2, outputScale: { x: 1, y: 1 } })

    expect(hints1.imageRects).toHaveLength(1)
    expect(hints1.imageRects[0].x).toBeCloseTo(60, 3)
    expect(hints1.imageRects[0].y).toBeCloseTo(792 - 350, 3)
    expect(hints1.imageRects[0].width).toBeCloseTo(140, 3)
    expect(hints1.imageRects[0].height).toBeCloseTo(90, 3)

    expect(hints1.horizontalRules).toHaveLength(3)
    expect(hints1.tableRuleRegions).toHaveLength(1)
    expect(hints1.tableRuleRegions[0].x).toBeCloseTo(305, 3)
    expect(hints1.tableRuleRegions[0].width).toBeCloseTo(235, 3)

    expect(hints1.fractionBars).toHaveLength(1)
    expect(hints1.vectorDiagramRects).toHaveLength(1)
    expect(hints1.vectorDiagramRects[0].x).toBeCloseTo(320, 3)
    expect(hints1.vectorDiagramRects[0].width).toBeCloseTo(200, 3)

    // 验证 scale=1 与 scale=2 归算后的显示坐标一致
    expect(hints2.imageRects[0].x).toBeCloseTo(hints1.imageRects[0].x, 3)
    expect(hints2.imageRects[0].y).toBeCloseTo(hints1.imageRects[0].y, 3)
    expect(hints2.tableRuleRegions[0].y).toBeCloseTo(hints1.tableRuleRegions[0].y, 3)
    expect(hints2.vectorDiagramRects[0].y).toBeCloseTo(hints1.vectorDiagramRects[0].y, 3)
  })

  test('isolates table captions from table cells, keeps column & spanning tables non-translatable, and preserves prose paragraphs', async () => {
    const page1 = await academicPdf.getPage(1)
    const viewport = page1.getViewport({ scale: 1 })
    page1.cleanup()
    const geometry: PageGeometry = { pageNumber: 1, viewport, outputScale: { x: 1, y: 1 } }
    const mk = (str: string, x: number, pdfY: number, width: number, size = 9.5, bold = false) => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, pdfY] as [number, number, number, number, number, number],
      fontName: bold ? 'F2' : 'F1',
      hasEOL: false
    })

    // 合成左栏常规正文 + 右栏 Table 1（仿截图表结构：粗体表注 + 表头 + 单位 + 3 数据行 + 下方正文）（合成素材）
    const items = [
      mk('Left column narrative line one with continuous', 54, 700, 220, 9.5),
      mk('Left column narrative line two explaining workloads.', 54, 686, 220, 9.5),
      mk('Left column narrative line three continuing text.', 54, 672, 220, 9.5),
      mk('Left column narrative line four closing section.', 54, 658, 220, 9.5),

      mk('Table 1: Synthetic hardware cost and latency metrics.', 312, 700, 232, 9.5, true),
      mk('Price', 385, 680, 22, 9),
      mk('Read Latency', 428, 680, 56, 9),
      mk('Bandwidth', 504, 680, 44, 9),
      mk('[$/TB]', 382, 668, 28, 9),
      mk('[μs/4 KB]', 434, 668, 40, 9),
      mk('[GB/s]', 512, 668, 28, 9),
      mk('DRAM', 312, 650, 28, 9),
      mk('5000', 386, 650, 20, 9),
      mk('0.1', 450, 650, 14, 9),
      mk('92.0', 518, 650, 18, 9),
      mk('Flash SSDs', 312, 638, 48, 9),
      mk('200', 388, 638, 16, 9),
      mk('78.0', 446, 638, 18, 9),
      mk('12.5', 518, 638, 18, 9),
      mk('RDMA (IB EDR 4x)', 312, 626, 76, 9),
      mk('-', 392, 626, 6, 9),
      mk('5.0', 450, 626, 14, 9),
      mk('11.2', 518, 626, 18, 9),

      mk('However, memory-only systems incur high costs.', 312, 594, 230, 9.5),
      mk('They also degrade steeply under cold workloads.', 312, 580, 230, 9.5)
    ]
    const textContent: PageTextContent = {
      items,
      styles: {
        F1: { fontFamily: 'Times New Roman', ascent: 0.72, descent: -0.22, vertical: false },
        F2: { fontFamily: 'Times Bold', ascent: 0.72, descent: -0.22, vertical: false }
      },
      lang: null
    }

    const graphicHints = extractPageGraphicHints(
      {
        fnArray: [91, 91, 91],
        argsArray: [
          [20, [], [310, 689, 552, 689.7]],
          [20, [], [310, 661, 552, 661.7]],
          [20, [], [310, 620, 552, 620.7]]
        ]
      },
      geometry
    )

    for (const layout of [analyzePageLayout(textContent, geometry, { graphicHints }), analyzePageLayout(textContent, geometry)]) {
      const caption = layout.blocks.find(b => b.kind === 'caption')
      expect(caption).toBeDefined()
      expect(caption!.sentences.map(s => s.text).join(' ')).toBe('Table 1: Synthetic hardware cost and latency metrics.')
      expect(isTranslatableBlock(caption!)).toBe(true)

      const tableBlocks = layout.blocks.filter(b => b.kind === 'table')
      expect(tableBlocks.length).toBeGreaterThanOrEqual(1)
      const tableText = tableBlocks.map(b => b.sentences.map(s => s.text).join(' ')).join(' ')
      expect(tableText).toContain('Read Latency')
      expect(tableText).toContain('DRAM')
      expect(tableText).toContain('RDMA (IB EDR 4x)')
      for (const tb of tableBlocks) {
        expect(isTranslatableBlock(tb)).toBe(false)
      }

      const bodyAfter = layout.blocks.find(b => b.sentences.some(s => s.text.includes('memory-only systems')))
      expect(bodyAfter?.kind).toBe('paragraph')
      expect(isTranslatableBlock(bodyAfter!)).toBe(true)
    }

    // 验证跨双栏全宽表格在 spanning band 内保持整体 table 不拆分
    const spanningItems = [
      mk('Upper left column discusses query plans.', 54, 700, 210, 10),
      mk('Upper right column discusses storage cost.', 326, 700, 210, 10),
      mk('Table 2: Synthetic cross-column comparison.', 54, 650, 260, 10, true),
      mk('System', 60, 628, 36, 9.5),
      mk('Storage', 200, 628, 38, 9.5),
      mk('Latency', 350, 628, 38, 9.5),
      mk('Throughput', 470, 628, 54, 9.5),
      mk('AlphaEngine', 60, 612, 60, 9.5),
      mk('NVMe', 200, 612, 30, 9.5),
      mk('12.0 us', 350, 612, 36, 9.5),
      mk('4.5 Mops', 470, 612, 46, 9.5),
      mk('Lower left column resumes normal prose.', 54, 570, 210, 10),
      mk('Lower right column completes normal prose.', 326, 570, 210, 10)
    ]
    const spanLayout = analyzePageLayout({ items: spanningItems, styles: textContent.styles, lang: null }, geometry)
    const spanTableBlocks = spanLayout.blocks.filter(b => b.kind === 'table')
    expect(spanTableBlocks.length).toBe(1)
    expect(spanTableBlocks[0].columnIndex).toBe(0)
    expect(isTranslatableBlock(spanTableBlocks[0])).toBe(false)
    expect(spanLayout.blocks.filter(b => b.kind === 'paragraph').length).toBeGreaterThanOrEqual(4)
  })

  test('marks embedded figures, multi-line formulas, and inline math tokens non-translatable while preserving μs units and shaded callout prose', async () => {
    const page1 = await academicPdf.getPage(1)
    const viewport = page1.getViewport({ scale: 1 })
    page1.cleanup()
    const geometry: PageGeometry = { pageNumber: 1, viewport, outputScale: { x: 1, y: 1 } }
    const mk = (str: string, x: number, pdfY: number, width: number, size = 10, fontName = 'F1') => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, pdfY] as [number, number, number, number, number, number],
      fontName,
      hasEOL: false
    })

    // 合成插图框内节点文字 + 带底纹连续正文框 + 多行分式/约束大公式 + 含 α/≤/O(n log n)/p < 0.05/μs/长句= 的正文（合成素材）
    const items = [
      // 图表框图内文字 (pdfY = 670..710 -> displayY = 82..122, vectorDiagramRect display x=54, y=70, w=220, h=65)
      mk('Client', 72, 704, 30, 9),
      mk('RDMA Read', 142, 704, 56, 9),
      mk('Local Cache', 142, 680, 56, 9),
      mk('Figure 2: Synthetic diagram labels.', 54, 650, 180, 9.5, 'F_BOLD'),

      // 填充底纹框内的真实连续正文（必须维持 paragraph）
      mk('Theorem 1 states that the distributed protocol', 54, 608, 215, 10),
      mk('terminates reliably under asynchronous faults.', 54, 594, 215, 10),

      // 大块多行展示公式（含优化约束 subject to、分段 if/otherwise、Unicode − 与分数线）
      mk('min ||Ax − b||^2 + λ ||x||', 82, 540, 130, 10),
      mk('a + b', 124, 524, 24, 7.5),
      mk('c + d', 124, 511, 24, 7.5),
      mk('subject to Cx ≤ d, ∀i', 82, 495, 118, 9.5),
      mk('0, otherwise', 82, 480, 56, 9.5),

      // 行内希腊字母/算符/同字体紧凑公式/单位与长句含=保护（词间保留约 3pt 正常空格间隙）
      mk('The latency is', 54, 430, 58, 10),
      mk('5', 115, 430, 5, 10),
      mk('μ', 123, 430, 6, 10),
      mk('s', 129, 430, 5, 10),
      mk('where', 137, 430, 25, 10),
      mk('α', 165, 430, 6, 10),
      mk('holds for', 174, 430, 38, 10),
      mk('≤', 215, 430, 7, 10),
      mk('in', 225, 430, 9, 10),
      mk('O(n log n)', 237, 430, 46, 10),
      mk('Consider the relation R[A] = 1 for every tuple', 54, 416, 192, 10),
      mk('with', 249, 416, 18, 10),
      mk('p', 270, 416, 5, 10),
      mk('<', 277, 416, 6, 10),
      mk('0.05', 285, 416, 18, 10),
      mk('.', 303, 416, 3, 10)
    ]

    const graphicHints = extractPageGraphicHints(
      {
        fnArray: [74, 91, 91, 91, 75, 91, 91],
        argsArray: [
          [[1, 0, 0, 1, 54, 662], [0, 0, 220, 65]],
          [20, [], [10, 10, 60, 30]],
          [20, [], [80, 10, 190, 30]],
          [20, [], [80, 38, 190, 56]],
          [],
          [22, [], [50, 586, 275, 622]], // 宽浅色填充底纹框
          [22, [], [120, 519, 152, 519.6]] // 分数线 (pdfY=519 -> displayY=273)
        ]
      },
      geometry
    )

    const layout = analyzePageLayout(
      {
        items,
        styles: {
          F1: { fontFamily: 'Times New Roman', ascent: 0.72, descent: -0.22, vertical: false },
          F_BOLD: { fontFamily: 'Times Bold', ascent: 0.72, descent: -0.22, vertical: false }
        },
        lang: null
      },
      geometry,
      { graphicHints }
    )

    const figureBlock = layout.blocks.find(b => b.kind === 'figure')
    expect(figureBlock).toBeDefined()
    expect(figureBlock!.sentences.map(s => s.text).join(' ')).toContain('RDMA Read')
    expect(isTranslatableBlock(figureBlock!)).toBe(false)

    const captionBlock = layout.blocks.find(b => b.kind === 'caption')
    expect(captionBlock?.sentences[0].text).toBe('Figure 2: Synthetic diagram labels.')

    const theoremBlock = layout.blocks.find(b => b.sentences.some(s => s.text.includes('Theorem 1 states')))
    expect(theoremBlock?.kind).toBe('paragraph')
    expect(isTranslatableBlock(theoremBlock!)).toBe(true)

    const formulaBlock = layout.blocks.find(b => b.kind === 'formula')
    expect(formulaBlock).toBeDefined()
    const formulaText = layout.blocks
      .filter(b => b.kind === 'formula')
      .map(b => b.sentences.map(s => s.text).join(' '))
      .join(' ')
    expect(formulaText).toContain('subject to Cx ≤ d')
    expect(formulaText).toContain('0, otherwise')
    expect(formulaText).toContain('a + b')
    expect(formulaText).toContain('c + d')
    for (const fb of layout.blocks.filter(b => b.kind === 'formula')) {
      expect(isTranslatableBlock(fb)).toBe(false)
    }

    const proseInlineBlock = layout.blocks.find(b => b.sentences.some(s => s.text.includes('latency is')))
    expect(proseInlineBlock?.kind).toBe('paragraph')
    expect(proseInlineBlock?.translationSourceText).toContain('5 μs')
    expect(proseInlineBlock?.translationSourceText).toContain('Consider the relation R[A] = 1 for every tuple')
    const tokens = proseInlineBlock?.inlineFormulas?.map(f => f.fallbackText) ?? []
    expect(tokens).toContain('α')
    expect(tokens).toContain('≤')
    expect(tokens).toContain('O(n log n)')
    expect(tokens).toContain('p < 0.05')
    expect(tokens.some(t => t.includes('for every tuple'))).toBe(false)
  })

  test('detects narrow-gutter 2-column body beneath wide Figure 1 + caption and splits bold run-in paragraphs, both with and without graphicHints (合成素材)', async () => {
    const page1 = await academicPdf.getPage(1)
    const viewport = page1.getViewport({ scale: 1 })
    page1.cleanup()
    const geometry: PageGeometry = { pageNumber: 1, viewport, outputScale: { x: 1, y: 1 } }
    const mk = (str: string, x: number, pdfY: number, width: number, size = 9, fontName = 'F1') => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, pdfY] as [number, number, number, number, number, number],
      fontName,
      hasEOL: false
    })

    // 顶部通栏 Figure 1 架构图（标签跨越页面中线）+ 通栏图注 + 下方 12pt 窄栏距双栏正文（含首行缩进、粗体行首段标题与章节标题）（合成素材）
    const items = [
      // Figure 1 顶部矢量框内文字（含跨越中线 x=285..340 的标签）
      mk('Node 0', 140, 728, 34, 8),
      mk('P1', 292, 718, 12, 8),
      mk('Transfer page', 284, 702, 54, 7.5),
      mk('Memory', 112, 714, 34, 8),
      mk('SSD', 114, 690, 20, 8),
      mk('Node 1', 436, 728, 34, 8),
      mk('(a) Logical B-Tree and placement', 124, 676, 130, 8),
      mk('(b) ScaleStore Main Components', 378, 676, 135, 8),

      // 通栏粗体 2 行图注
      mk(
        'Figure 1: Overview of ScaleStore using a distributed B-Tree. (a) B-tree pages spread',
        54,
        654,
        496,
        9,
        'F_BOLD'
      ),
      mk('across local and remote memory. (b) ScaleStore main architecture components.', 54, 643, 350, 9, 'F_BOLD'),

      // 左栏 (x = 54..298, width = 244), 栏距 12pt (298..310)
      mk('provide high performance even for latency-sensitive OLTP work-', 54, 624, 244, 9),
      mk('loads. However, such distributed in-memory DBMS designs still', 54, 613.5, 244, 9),
      mk('require that all data reside in memory even when the hot set fits.', 54, 603, 224, 9),

      // 粗体行首分段: ScaleStore. (与正文同一基线分项)
      mk('ScaleStore.', 54, 589.5, 46, 9, 'F_BOLD'),
      mk('Given the two directions, we propose a novel', 103, 589.5, 195, 9),
      mk('distributed storage engine called ScaleStore that provides', 54, 579, 244, 9),
      mk('low-latency access to aggregated memory across all nodes.', 54, 568.5, 226, 9),

      // 粗体行首分段: Challenges.
      mk('Challenges.', 54, 555, 48, 9, 'F_BOLD'),
      mk('While combining distributed memory with SSDs', 105, 555, 193, 9),
      mk('appears intuitive, it triggers several non-trivial design questions.', 54, 544.5, 238, 9),

      // 缩进起始新段
      mk('Distributed cache protocol. To address these challenges, we', 64, 531, 234, 9),
      mk('implement a distributed caching protocol operating on fixed pages.', 54, 520.5, 244, 9),

      // 右栏 (x = 310..558, width = 248)
      mk('concurrent modifications even when multiple copies are cached by', 310, 624, 248, 9),
      mk('several nodes across the entire distributed cluster.', 310, 613.5, 190, 9),

      // 粗体行首分段: High performance eviction.
      mk('High performance eviction.', 310, 600, 102, 9, 'F_BOLD'),
      mk('Because ScaleStore caches pages', 415, 600, 143, 9),
      mk('and handles workload shifts, the local DRAM buffer fills rapidly', 310, 589.5, 248, 9),
      mk('so unused cold pages must be evicted efficiently from memory.', 310, 579, 240, 9),

      // 章节标题 2 SYSTEM OVERVIEW
      mk('2 SYSTEM OVERVIEW', 310, 559, 122, 10.5, 'F_BOLD'),
      mk('In this section, we illustrate the main concept behind our system', 310, 544, 248, 9),
      mk('using a motivating example and introduce the main components.', 310, 533.5, 242, 9),

      // 小节标题 2.1 A Motivating Example
      mk('2.1 A Motivating Example', 310, 514, 118, 9.5, 'F_BOLD'),
      mk('In ScaleStore, page access is transparent across cluster nodes', 310, 499, 248, 9),
      mk('via a unified page identifier without manual placement.', 310, 488.5, 224, 9)
    ]

    const graphicHints = extractPageGraphicHints(
      {
        fnArray: [74, 91, 91, 91, 75],
        argsArray: [
          [[1, 0, 0, 1, 50, 666], [0, 0, 512, 76]],
          [20, [], [10, 10, 180, 60]],
          [20, [], [200, 10, 340, 60]],
          [20, [], [360, 10, 500, 60]],
          []
        ]
      },
      geometry
    )

    const textContent: PageTextContent = {
      items,
      styles: {
        F1: { fontFamily: 'Times New Roman', ascent: 0.72, descent: -0.22, vertical: false },
        F_BOLD: { fontFamily: 'Times Bold', ascent: 0.72, descent: -0.22, vertical: false }
      },
      lang: null
    }

    for (const withHints of [true, false]) {
      const layout = analyzePageLayout(
        textContent,
        geometry,
        withHints ? { graphicHints } : undefined
      )

      expect(layout.columnCount).toBe(2)

      const captionBlock = layout.blocks.find(b => b.kind === 'caption')
      expect(captionBlock?.columnIndex).toBe(0)
      expect(captionBlock?.sentences.map(s => s.text).join(' ')).toContain('Figure 1: Overview of ScaleStore')

      const scaleStorePara = layout.blocks.find(b => b.sentences.some(s => s.text.startsWith('ScaleStore.')))
      const challengesPara = layout.blocks.find(b => b.sentences.some(s => s.text.startsWith('Challenges.')))
      const cachePara = layout.blocks.find(b => b.sentences.some(s => s.text.includes('Distributed cache protocol.')))
      const evictionPara = layout.blocks.find(b =>
        b.sentences.some(s => s.text.startsWith('High performance eviction.'))
      )
      const secHeading = layout.blocks.find(b => b.sentences.some(s => s.text === '2 SYSTEM OVERVIEW'))
      const subHeading = layout.blocks.find(b => b.sentences.some(s => s.text === '2.1 A Motivating Example'))

      expect(scaleStorePara?.columnIndex).toBe(1)
      expect(challengesPara?.columnIndex).toBe(1)
      expect(cachePara?.columnIndex).toBe(1)
      expect(evictionPara?.columnIndex).toBe(2)
      expect(secHeading?.kind).toBe('heading')
      expect(secHeading?.columnIndex).toBe(2)
      expect(subHeading?.kind).toBe('heading')
      expect(subHeading?.columnIndex).toBe(2)

      // 各自然段保持完整多句/多行，不被拆碎且不互相粘连
      expect(scaleStorePara?.id).not.toBe(challengesPara?.id)
      expect(challengesPara?.id).not.toBe(cachePara?.id)
      expect(scaleStorePara?.sentences.map(s => s.text).join(' ')).toContain(
        'low-latency access to aggregated memory across all nodes.'
      )
      expect(evictionPara?.sentences.map(s => s.text).join(' ')).toContain(
        'so unused cold pages must be evicted efficiently from memory.'
      )
    }
  })

  test('preserves full-width top title and abstract while splitting lower 2-column body (合成素材)', async () => {
    const page1 = await academicPdf.getPage(1)
    const viewport = page1.getViewport({ scale: 1 })
    page1.cleanup()
    const geometry: PageGeometry = { pageNumber: 1, viewport, outputScale: { x: 1, y: 1 } }
    const mk = (str: string, x: number, pdfY: number, width: number, size = 10, fontName = 'F1') => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, pdfY] as [number, number, number, number, number, number],
      fontName,
      hasEOL: false
    })

    // 合成混合首页面布局：上半部分 ~40% 为通栏标题/作者/摘要，下半部分为双栏引言与背景（合成素材）
    const items = [
      mk('A Synthetic Study on Mixed-Column Academic Page Layouts', 92, 732, 428, 15, 'F_BOLD'),
      mk('Alice Smith, Bob Chen, Carol Wang', 216, 706, 180, 10.5),
      mk('Abstract', 54, 676, 48, 11, 'F_BOLD'),
      mk('Modern research papers frequently combine single-column front matter with dense', 54, 658, 504, 10),
      mk('two-column body prose on the opening page. Layout segmentation must recognize', 54, 644, 504, 10),
      mk('the full-width abstract cleanly while preserving left-then-right reading order', 54, 630, 504, 10),
      mk('across both lower columns without interleaving opposing baselines across the', 54, 616, 504, 10),
      mk('center column gutter during bilingual side-by-side translation.', 54, 602, 340, 10),

      // 左栏正文
      mk('1 Introduction', 54, 566, 90, 11.5, 'F_BOLD'),
      mk('Distributed transaction engines require low latency across', 54, 546, 240, 9.5),
      mk('thousands of concurrent cores. Prior designs relied on coarse', 54, 533, 240, 9.5),
      mk('locking schemes that bottlenecked on shared metadata tables.', 54, 520, 232, 9.5),
      mk('In contrast, partitioned storage keeps hot tuples local to', 64, 503, 230, 9.5),
      mk('each NUMA socket while bounding cross-node traffic tightly.', 54, 490, 234, 9.5),

      // 右栏正文
      mk('2 Background and Motivation', 316, 566, 152, 11.5, 'F_BOLD'),
      mk('Recent hardware advances provide high-bandwidth RDMA fabrics', 316, 546, 242, 9.5),
      mk('that reduce remote memory access latency to single microseconds.', 316, 533, 242, 9.5),
      mk('However, naive remote dereferencing still incurs round trips.', 316, 520, 238, 9.5),
      mk('Caching hot tree pages locally closes this performance gap', 326, 503, 232, 9.5),
      mk('when invalidation protocols amortize coherence overhead.', 316, 490, 228, 9.5)
    ]

    const layout = analyzePageLayout(
      {
        items,
        styles: {
          F1: { fontFamily: 'Times New Roman', ascent: 0.72, descent: -0.22, vertical: false },
          F_BOLD: { fontFamily: 'Times Bold', ascent: 0.72, descent: -0.22, vertical: false }
        },
        lang: null
      },
      geometry
    )

    expect(layout.columnCount).toBe(2)

    const titleBlock = layout.blocks.find(b => b.sentences.some(s => s.text.includes('A Synthetic Study')))
    const abstractHeading = layout.blocks.find(b => b.sentences.some(s => s.text === 'Abstract'))
    const abstractBody = layout.blocks.find(b =>
      b.sentences.some(s => s.text.includes('Modern research papers frequently'))
    )
    const introHeading = layout.blocks.find(b => b.sentences.some(s => s.text === '1 Introduction'))
    const bgHeading = layout.blocks.find(b => b.sentences.some(s => s.text === '2 Background and Motivation'))

    expect(titleBlock?.columnIndex).toBe(0)
    expect(abstractHeading?.columnIndex).toBe(0)
    expect(abstractBody?.columnIndex).toBe(0)
    expect(introHeading?.columnIndex).toBe(1)
    expect(bgHeading?.columnIndex).toBe(2)
  })

  test('keeps single-column layout intact despite compact 2-column table and preserves parskip / bold run-in paragraphs (合成素材)', async () => {
    const page1 = await academicPdf.getPage(1)
    const viewport = page1.getViewport({ scale: 1 })
    page1.cleanup()
    const geometry: PageGeometry = { pageNumber: 1, viewport, outputScale: { x: 1, y: 1 } }
    const mk = (str: string, x: number, pdfY: number, width: number, size = 10, fontName = 'F1') => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, pdfY] as [number, number, number, number, number, number],
      fontName,
      hasEOL: false
    })

    // 合成纯单栏论文：通栏多段正文 + parskip 段距 + 粗体行首段落 + 嵌入式紧凑双列对照表（合成素材）
    const items = [
      // 第 1 段
      mk('Single-column technical reports rely on consistent margins across the full page', 72, 710, 468, 10),
      mk('width while mixing paragraphs, bold run-in headings, and summary tables.', 72, 696, 440, 10),

      // 第 2 段（利用中等 parskip 约 20pt 步距 vs 14pt 行距自然分段）
      mk('Even when an inline benchmark table appears mid-page with two aligned', 72, 676, 468, 10),
      mk('columns of metrics, the document itself remains strictly single-column.', 72, 662, 435, 10),

      // 第 3 段（紧接其后的粗体行首段标题）
      mk('Design Principle.', 72, 643, 82, 10, 'F_BOLD'),
      mk('Every storage request routes through a lock-free queue so', 158, 643, 382, 10),
      mk('tail latency stays bounded across multiple processor sockets.', 72, 629, 360, 10),

      // 嵌入式 2 列表格（5 行短单元项，左右两列位于 x=120 与 x=340）
      mk('Metric', 120, 588, 36, 9, 'F_BOLD'),
      mk('Baseline', 340, 588, 44, 9, 'F_BOLD'),
      mk('Throughput', 120, 574, 58, 9),
      mk('12.4 Mops/s', 340, 574, 58, 9),
      mk('P99 Latency', 120, 560, 60, 9),
      mk('4.2 us', 340, 560, 34, 9),
      mk('DRAM Footprint', 120, 546, 78, 9),
      mk('64.0 GB', 340, 546, 42, 9),
      mk('Cache Hit Rate', 120, 532, 74, 9),
      mk('98.5%', 340, 532, 32, 9),

      // 表格下方恢复单栏通栏正文
      mk('As summarized above, deterministic layout rules preserve natural reading flow', 72, 496, 468, 10),
      mk('and classify embedded metric tables as non-translatable structural regions.', 72, 482, 452, 10)
    ]

    const layout = analyzePageLayout(
      {
        items,
        styles: {
          F1: { fontFamily: 'Times New Roman', ascent: 0.72, descent: -0.22, vertical: false },
          F_BOLD: { fontFamily: 'Times Bold', ascent: 0.72, descent: -0.22, vertical: false }
        },
        lang: null
      },
      geometry
    )

    expect(layout.columnCount).toBe(1)

    const paragraphs = layout.blocks.filter(b => b.kind === 'paragraph')
    expect(paragraphs.length).toBeGreaterThanOrEqual(4)
    for (const p of paragraphs) {
      expect(p.columnIndex).toBe(0)
    }

    const designBlock = paragraphs.find(b => b.sentences.some(s => s.text.startsWith('Design Principle.')))
    expect(designBlock).toBeDefined()
    expect(designBlock?.sentences.map(s => s.text).join(' ')).not.toContain('Even when an inline benchmark')

    const tableBlocks = layout.blocks.filter(b => b.kind === 'table')
    expect(tableBlocks.length).toBe(1)
    expect(isTranslatableBlock(tableBlocks[0])).toBe(false)
  })
})
