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
})
