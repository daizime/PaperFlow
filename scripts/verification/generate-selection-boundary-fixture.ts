import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { composeAffine, projectVisualRun } from '../../src/renderer/src/features/reader/selection-bridges'

interface Point {
  x: number
  y: number
}

interface Rect extends Point {
  width: number
  height: number
}

type FontName = 'Times-Roman' | 'Times-Italic' | 'Symbol'
type PartRole = 'body' | 'operator' | 'subscript'

interface PartSpec {
  id: string
  pageNumber: 1 | 2 | 3
  rowId: string
  group: 'excluded-before' | 'selected' | 'excluded-after'
  text: string
  font: FontName
  size: number
  width: number
  role: PartRole
  // Page 1 & 2: PDF coordinates (x right, y up); Page 3: visual rotated coordinates (x right, y down)
  x: number
  y: number
  pdfX: number
  pdfY: number
  drawOrder: number
}

interface BridgeWindowSpec {
  id: string
  pageNumber: 1 | 2 | 3
  kind: 'horizontal' | 'vertical'
  cases: string[]
  sourcePartIds: string[]
  pdfWindow: Rect
  description: string
}

interface GuardWindowSpec {
  id: string
  pageNumber: 1 | 2 | 3
  cases: string[]
  pdfWindow: Rect
  reason: string
}

const fixtureRoot = resolve('tests/fixtures/verification/selection-boundary')
const auditRoot = resolve('.cache/reader/20261122-selection-boundary-01/generator')
const generator = 'scripts/verification/generate-selection-boundary-fixture.ts'
const pdfName = 'selection-boundary-fixture.pdf'
const fixedDate = '2026-11-22T00:00:00.000Z'

const portraitWidth = 600
const portraitHeight = 780
const rotatedPdfWidth = 780
const rotatedPdfHeight = 600

const round = (value: number): number => Number(value.toFixed(6))
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const withoutWhitespace = (text: string): string => text.replace(/\s+/gu, '')

const advance = (font: PDFFont, text: string, size: number): number =>
  round([...text].reduce((sum, ch) => sum + font.widthOfTextAtSize(ch, size), 0))

const auditJson = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, entry: unknown) => (typeof entry === 'number' && !Number.isFinite(entry) ? String(entry) : entry),
    2
  ) + '\n'

const canEncode = (font: PDFFont, text: string): boolean => {
  try {
    font.encodeText(text)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const document = await PDFDocument.create({ updateMetadata: false })
  document.setTitle('PaperFlow original synthetic selection boundary fixture')
  document.setAuthor('PaperFlow synthetic verification fixtures')
  document.setSubject('Original synthetic cross-page, 90-degree rotated formula, and high-contrast verification fixture.')
  document.setCreator('PaperFlow deterministic fixture generator')
  document.setProducer('pdf-lib 1.17.1 / PaperFlow synthetic fixture')
  document.setCreationDate(new Date(fixedDate))
  document.setModificationDate(new Date(fixedDate))

  const timesRoman = await document.embedFont(StandardFonts.TimesRoman)
  const timesItalic = await document.embedFont(StandardFonts.TimesRomanItalic)
  const symbol = await document.embedFont(StandardFonts.Symbol)

  const fonts = new Map<FontName, PDFFont>([
    ['Times-Roman', timesRoman],
    ['Times-Italic', timesItalic],
    ['Symbol', symbol]
  ])

  const oplus = '\u2295'
  const otimes = '\u2297'
  if (!canEncode(symbol, oplus) || !canEncode(symbol, otimes)) {
    throw new Error('Symbol font cannot encode U+2295 or U+2297')
  }

  const parts: PartSpec[] = []
  let drawOrder = 0

  const addPortraitPart = (
    id: string,
    pageNumber: 1 | 2,
    rowId: string,
    group: PartSpec['group'],
    text: string,
    font: FontName,
    x: number,
    y: number,
    size: number,
    role: PartRole = 'body'
  ): PartSpec => {
    const part: PartSpec = {
      id,
      pageNumber,
      rowId,
      group,
      text,
      font,
      size,
      width: advance(fonts.get(font)!, text, size),
      role,
      x: round(x),
      y: round(y),
      pdfX: round(x),
      pdfY: round(y),
      drawOrder: drawOrder++
    }
    parts.push(part)
    return part
  }

  // Page 3 rotation = 90 deg CW: visual (vx, vy) in 600x780 maps to PDF (px = vy, py = vx)
  const addRotatedPart = (
    id: string,
    rowId: string,
    group: PartSpec['group'],
    text: string,
    font: FontName,
    vx: number,
    vy: number,
    size: number,
    role: PartRole = 'body'
  ): PartSpec => {
    const part: PartSpec = {
      id,
      pageNumber: 3,
      rowId,
      group,
      text,
      font,
      size,
      width: advance(fonts.get(font)!, text, size),
      role,
      x: round(vx),
      y: round(vy),
      pdfX: round(vy),
      pdfY: round(vx),
      drawOrder: drawOrder++
    }
    parts.push(part)
    return part
  }

  // ---------------- Page 1 (600x780, 0 deg) ----------------
  addPortraitPart('p1-header', 1, 'p1-excluded-before', 'excluded-before', 'SYNTHETIC BOUNDARY FIXTURE PAGE ONE', 'Times-Roman', 48, 710, 11)
  addPortraitPart('p1-middle', 1, 'p1-excluded-before', 'excluded-before', 'Unselected middle block on page one for scroll isolation.', 'Times-Roman', 48, 420, 12)

  const p1Line1 = addPortraitPart('p1-line1', 1, 'p1-row-1', 'selected', 'Boundary flow starts near page one bottom and keeps', 'Times-Roman', 48, 108, 12)
  const p1Line2Gap = 4.5
  const p1Line2A = addPortraitPart('p1-line2-a', 1, 'p1-row-2', 'selected', 'font', 'Times-Roman', 48, 90, 12)
  const p1Line2B = addPortraitPart('p1-line2-b', 1, 'p1-row-2', 'selected', 'M', 'Times-Italic', p1Line2A.x + p1Line2A.width + p1Line2Gap, 90, 12)
  const p1Line2C = addPortraitPart(
    'p1-line2-c',
    1,
    'p1-row-2',
    'selected',
    'wrapped before crossing cleanly onto page two.',
    'Times-Roman',
    p1Line2B.x + p1Line2B.width + p1Line2Gap,
    90,
    12
  )

  // ---------------- Page 2 (600x780, 0 deg) ----------------
  const p2Line1 = addPortraitPart('p2-line1', 2, 'p2-row-1', 'selected', 'Continuing smoothly across the top of page two with', 'Times-Roman', 48, 710, 12)
  const p2Line2 = addPortraitPart('p2-line2', 2, 'p2-row-2', 'selected', 'multiple lines and zero white gaps between pages.', 'Times-Roman', 48, 692, 12)
  addPortraitPart('p2-unselected', 2, 'p2-excluded-after', 'excluded-after', 'Unselected paragraph below page two boundary.', 'Times-Roman', 48, 636, 12)
  addPortraitPart('p2-sentinel', 2, 'p2-excluded-after', 'excluded-after', 'UNSELECTED_BOUNDARY_SENTINEL_PAGE2', 'Times-Roman', 48, 320, 12)

  // ---------------- Page 3 (780x600, rotation 90 deg) ----------------
  addRotatedPart('p3-header', 'p3-excluded-before', 'excluded-before', 'ROTATED 90 DEG SYNTHETIC BOUNDARY FIXTURE', 'Times-Roman', 48, 76, 11)

  const p3Row1Vy = 148
  const p3Gap = 4.5
  const p3R1Alpha = addRotatedPart('p3-r1-alpha', 'p3-row-1', 'selected', 'alpha', 'Times-Roman', 48, p3Row1Vy, 12)
  const p3R1S = addRotatedPart('p3-r1-s', 'p3-row-1', 'selected', 'S', 'Times-Italic', p3R1Alpha.x + p3R1Alpha.width + p3Gap, p3Row1Vy, 12)
  const p3R1And = addRotatedPart('p3-r1-and', 'p3-row-1', 'selected', 'and', 'Times-Roman', p3R1S.x + p3R1S.width + p3Gap, p3Row1Vy, 12)
  const p3R1T = addRotatedPart('p3-r1-t', 'p3-row-1', 'selected', 'T', 'Times-Italic', p3R1And.x + p3R1And.width + p3Gap, p3Row1Vy, 12)
  const p3R1Tail = addRotatedPart('p3-r1-tail', 'p3-row-1', 'selected', 'map rotated vectors:', 'Times-Roman', p3R1T.x + p3R1T.width + p3Gap, p3Row1Vy, 12)

  const p3Row2Vy = 178
  const p3LeftGap = 20
  const p3RightGap = 20
  const p3R2Left = addRotatedPart('p3-r2-left', 'p3-row-2', 'selected', 'Q[ ] =', 'Times-Roman', 68, p3Row2Vy, 12)
  const p3R2Op = addRotatedPart('p3-r2-op', 'p3-row-2', 'selected', oplus, 'Symbol', p3R2Left.x + p3R2Left.width + p3LeftGap, 181, 20, 'operator')
  const underscriptW = advance(timesRoman, 'A,B,C,D,E', 8)
  const p3R2Sub = addRotatedPart(
    'p3-r2-underscript',
    'p3-row-2',
    'selected',
    'A,B,C,D,E',
    'Times-Roman',
    p3R2Op.x + p3R2Op.width / 2 - underscriptW / 2,
    192,
    8,
    'subscript'
  )
  const p3R2Term1 = addRotatedPart('p3-r2-term1', 'p3-row-2', 'selected', 'F[A, B]', 'Times-Roman', p3R2Op.x + p3R2Op.width + p3RightGap, p3Row2Vy, 12)
  const p3R2Otimes = addRotatedPart('p3-r2-otimes', 'p3-row-2', 'selected', otimes, 'Symbol', p3R2Term1.x + p3R2Term1.width + p3Gap, p3Row2Vy, 12, 'operator')
  const p3R2Term2 = addRotatedPart('p3-r2-term2', 'p3-row-2', 'selected', 'G[C, D, E]', 'Times-Roman', p3R2Otimes.x + p3R2Otimes.width + p3Gap, p3Row2Vy, 12)

  const p3Row3Vy = 210
  const p3R3Body = addRotatedPart(
    'p3-r3-body',
    'p3-row-3',
    'selected',
    'stays continuous across rotated rows and symbols.',
    'Times-Roman',
    48,
    p3Row3Vy,
    12
  )

  addRotatedPart('p3-col2-r1', 'p3-excluded-after', 'excluded-after', 'Col2 rotated alpha.', 'Times-Roman', 440, p3Row1Vy, 12)
  addRotatedPart('p3-col2-r2', 'p3-excluded-after', 'excluded-after', 'Col2 rotated beta.', 'Times-Roman', 440, p3Row2Vy, 12)
  addRotatedPart('p3-col2-r3', 'p3-excluded-after', 'excluded-after', 'Col2 rotated gamma.', 'Times-Roman', 440, p3Row3Vy, 12)
  addRotatedPart('p3-sentinel', 'p3-excluded-after', 'excluded-after', 'UNSELECTED_ROTATED_SENTINEL_PAGE3', 'Times-Roman', 48, 480, 12)

  const page1 = document.addPage([portraitWidth, portraitHeight])
  const page2 = document.addPage([portraitWidth, portraitHeight])
  const page3 = document.addPage([rotatedPdfWidth, rotatedPdfHeight])
  page3.setRotation(degrees(90))

  for (const part of parts) {
    const targetPage = part.pageNumber === 1 ? page1 : part.pageNumber === 2 ? page2 : page3
    if (part.pageNumber === 3) {
      if (part.x < 0 || part.x + part.width > portraitWidth || part.y < 0 || part.y > portraitHeight) {
        throw new Error(`Rotated part outside visual bounds: ${part.id}`)
      }
      targetPage.drawText(part.text, {
        x: part.pdfX,
        y: part.pdfY,
        size: part.size,
        font: fonts.get(part.font)!,
        rotate: degrees(90),
        color: rgb(0, 0, 0)
      })
    } else {
      if (part.x < 0 || part.x + part.width > portraitWidth || part.y < 0 || part.y + part.size > portraitHeight) {
        throw new Error(`Portrait part outside page bounds: ${part.id}`)
      }
      targetPage.drawText(part.text, {
        x: part.pdfX,
        y: part.pdfY,
        size: part.size,
        font: fonts.get(part.font)!,
        color: rgb(0, 0, 0)
      })
    }
  }

  const bytes = await document.save({ useObjectStreams: false })
  const file = { name: pdfName, bytes: bytes.length, sha256: sha256(bytes) }
  const pages = [
    { number: 1, width: portraitWidth, height: portraitHeight, rotation: 0, view: [0, 0, portraitWidth, portraitHeight], userUnit: 1 },
    { number: 2, width: portraitWidth, height: portraitHeight, rotation: 0, view: [0, 0, portraitWidth, portraitHeight], userUnit: 1 },
    { number: 3, width: rotatedPdfWidth, height: rotatedPdfHeight, rotation: 90, view: [0, 0, rotatedPdfWidth, rotatedPdfHeight], userUnit: 1 }
  ]

  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
    useSystemFonts: false
  })

  const extractedPages: unknown[] = []
  const rowTextById = new Map<string, string>()

  try {
    const pdf = await task.promise
    if (pdf.numPages !== 3) throw new Error(`Expected 3 pages, got ${pdf.numPages}`)
    const pageGroups = [1, 2, 3] as const
    for (const pageNumber of pageGroups) {
      const actualPage = await pdf.getPage(pageNumber)
      const viewport = actualPage.getViewport({ scale: 1 })
      const spec = pages[pageNumber - 1]
      if (actualPage.rotate !== spec.rotation) {
        throw new Error(`Page ${pageNumber} rotation mismatch: ${actualPage.rotate} !== ${spec.rotation}`)
      }
      if (pageNumber === 3 && (viewport.width !== portraitWidth || viewport.height !== portraitHeight)) {
        throw new Error(`Page 3 rotated viewport mismatch: ${viewport.width}x${viewport.height}`)
      }
      const content = await actualPage.getTextContent({ includeMarkedContent: true })
      const pageParts = parts.filter(part => part.pageNumber === pageNumber)
      let expectedIndex = 0
      let activeRowId: string | null = null
      const matchedItems: unknown[] = []
      for (let itemIndex = 0; itemIndex < content.items.length; itemIndex++) {
        const item = content.items[itemIndex]
        if (!('str' in item)) continue
        if (!item.str.trim()) {
          if (activeRowId) rowTextById.set(activeRowId, (rowTextById.get(activeRowId) ?? '') + item.str)
          continue
        }
        const expected = pageParts[expectedIndex++]
        if (!expected || withoutWhitespace(item.str) !== withoutWhitespace(expected.text)) {
          throw new Error(`Page ${pageNumber} item mismatch at ${expected?.id}: got ${JSON.stringify(item.str)}`)
        }
        const composed = composeAffine(viewport.transform, item.transform)
        const projected = projectVisualRun(viewport.transform, item.transform, 1, item.dir)
        if (!projected || !projected.horizontal) {
          throw new Error(`Page ${pageNumber} item ${expected.id} did not project to horizontal visual run: ${JSON.stringify(composed)}`)
        }
        if (Math.abs(projected.em - expected.size) > 0.01) {
          throw new Error(`Page ${pageNumber} item ${expected.id} em mismatch: ${projected.em} vs ${expected.size}`)
        }
        const expectedBaseline = pageNumber === 3 ? expected.y : portraitHeight - expected.y
        if (Math.abs(projected.baseline - expectedBaseline) > 0.01) {
          throw new Error(`Page ${pageNumber} item ${expected.id} baseline mismatch: ${projected.baseline} vs ${expectedBaseline}`)
        }
        matchedItems.push({
          partId: expected.id,
          rowId: expected.rowId,
          itemIndex,
          str: item.str,
          width: item.width,
          height: item.height,
          transform: item.transform,
          viewportComposed: composed,
          projected
        })
        if (expected.group === 'selected') {
          activeRowId = expected.rowId
          rowTextById.set(activeRowId, (rowTextById.get(activeRowId) ?? '') + item.str)
        } else {
          activeRowId = null
        }
      }
      if (expectedIndex !== pageParts.length) {
        throw new Error(`Page ${pageNumber} expected ${pageParts.length} items, got ${expectedIndex}`)
      }
      extractedPages.push({
        pageNumber,
        view: actualPage.view,
        rotation: actualPage.rotate,
        userUnit: actualPage.userUnit,
        viewport: { width: viewport.width, height: viewport.height, transform: viewport.transform },
        content,
        matchedItems
      })
      actualPage.cleanup()
    }
  } finally {
    await task.destroy()
  }

  const normalizeRowText = (raw: string): string => raw.replace(/\s+/gu, ' ').trim()
  const crossPageRows = ['p1-row-1', 'p1-row-2', 'p2-row-1', 'p2-row-2'].map(rowId => ({
    id: rowId,
    text: normalizeRowText(rowTextById.get(rowId) ?? '')
  }))
  const rotatedRows = ['p3-row-1', 'p3-row-2', 'p3-row-3'].map(rowId => ({
    id: rowId,
    text: normalizeRowText(rowTextById.get(rowId) ?? '')
  }))

  // Rotated visual window (vx, vy, vw, vh) -> Page 3 PDF window { x: vy, y: vx, width: vh, height: vw }
  const visualToPdfWindow = (vx: number, vy: number, vw: number, vh: number): Rect => ({
    x: round(vy),
    y: round(vx),
    width: round(vh),
    height: round(vw)
  })

  const bridgeCandidates: BridgeWindowSpec[] = [
    // Cross-page multi-line horizontal & vertical bridges
    {
      id: 'p1-r2-gap-a-b',
      pageNumber: 1,
      kind: 'horizontal',
      cases: ['crossPageMultiLine'],
      sourcePartIds: [p1Line2A.id, p1Line2B.id],
      pdfWindow: { x: round(p1Line2A.x + p1Line2A.width + 0.3), y: 90.5, width: round(p1Line2Gap - 0.6), height: 5.5 },
      description: 'Page 1 Row 2 font switch gap between font and M'
    },
    {
      id: 'p1-r2-gap-b-c',
      pageNumber: 1,
      kind: 'horizontal',
      cases: ['crossPageMultiLine'],
      sourcePartIds: [p1Line2B.id, p1Line2C.id],
      pdfWindow: { x: round(p1Line2B.x + p1Line2B.width + 0.3), y: 90.5, width: round(p1Line2Gap - 0.6), height: 5.5 },
      description: 'Page 1 Row 2 font switch gap between M and wrapped...'
    },
    {
      id: 'p1-v-r1-r2',
      pageNumber: 1,
      kind: 'vertical',
      cases: ['crossPageMultiLine'],
      sourcePartIds: [p1Line1.id, p1Line2C.id],
      pdfWindow: { x: 110, y: 100.8, width: 80, height: 4.0 },
      description: 'Page 1 vertical gap between bottom lines 1 and 2'
    },
    {
      id: 'p2-v-r1-r2',
      pageNumber: 2,
      kind: 'vertical',
      cases: ['crossPageMultiLine'],
      sourcePartIds: [p2Line1.id, p2Line2.id],
      pdfWindow: { x: 60, y: 702.8, width: 90, height: 4.0 },
      description: 'Page 2 vertical gap between top lines 1 and 2'
    },

    // Page 3 rotated 90 deg bridges
    {
      id: 'p3-r1-gap-alpha-s',
      pageNumber: 3,
      kind: 'horizontal',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R1Alpha.id, p3R1S.id],
      pdfWindow: visualToPdfWindow(p3R1Alpha.x + p3R1Alpha.width + 0.3, p3Row1Vy - 6.5, p3Gap - 0.6, 5.5),
      description: 'Rotated Page 3 Row 1 gap between alpha and S'
    },
    {
      id: 'p3-r1-gap-s-and',
      pageNumber: 3,
      kind: 'horizontal',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R1S.id, p3R1And.id],
      pdfWindow: visualToPdfWindow(p3R1S.x + p3R1S.width + 0.3, p3Row1Vy - 6.5, p3Gap - 0.6, 5.5),
      description: 'Rotated Page 3 Row 1 gap between S and and'
    },
    {
      id: 'p3-r1-gap-and-t',
      pageNumber: 3,
      kind: 'horizontal',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R1And.id, p3R1T.id],
      pdfWindow: visualToPdfWindow(p3R1And.x + p3R1And.width + 0.3, p3Row1Vy - 6.5, p3Gap - 0.6, 5.5),
      description: 'Rotated Page 3 Row 1 gap between and and T'
    },
    {
      id: 'p3-r1-gap-t-tail',
      pageNumber: 3,
      kind: 'horizontal',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R1T.id, p3R1Tail.id],
      pdfWindow: visualToPdfWindow(p3R1T.x + p3R1T.width + 0.3, p3Row1Vy - 6.5, p3Gap - 0.6, 5.5),
      description: 'Rotated Page 3 Row 1 gap between T and tail'
    },
    {
      id: 'p3-r2-left-of-oplus',
      pageNumber: 3,
      kind: 'horizontal',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R2Left.id, p3R2Op.id],
      pdfWindow: visualToPdfWindow(p3R2Left.x + p3R2Left.width + 1, p3Row2Vy - 7.5, p3LeftGap - 2, 6.5),
      description: 'Rotated Page 3 Row 2 >1.25em gap left of wide-underscript oplus'
    },
    {
      id: 'p3-r2-right-of-oplus',
      pageNumber: 3,
      kind: 'horizontal',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R2Op.id, p3R2Term1.id],
      pdfWindow: visualToPdfWindow(p3R2Op.x + p3R2Op.width + 1, p3Row2Vy - 7.5, p3RightGap - 2, 6.5),
      description: 'Rotated Page 3 Row 2 >1.25em gap right of wide-underscript oplus'
    },
    {
      id: 'p3-r2-gap-term1-otimes',
      pageNumber: 3,
      kind: 'horizontal',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R2Term1.id, p3R2Otimes.id],
      pdfWindow: visualToPdfWindow(p3R2Term1.x + p3R2Term1.width + 0.3, p3Row2Vy - 7, p3Gap - 0.6, 6),
      description: 'Rotated Page 3 Row 2 gap before otimes'
    },
    {
      id: 'p3-r2-gap-otimes-term2',
      pageNumber: 3,
      kind: 'horizontal',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R2Otimes.id, p3R2Term2.id],
      pdfWindow: visualToPdfWindow(p3R2Otimes.x + p3R2Otimes.width + 0.3, p3Row2Vy - 7, p3Gap - 0.6, 6),
      description: 'Rotated Page 3 Row 2 gap after otimes'
    },
    {
      id: 'p3-v-r1-to-r2',
      pageNumber: 3,
      kind: 'vertical',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R1Tail.id, p3R2Left.id],
      pdfWindow: visualToPdfWindow(70, 154, 40, 10),
      description: 'Rotated Page 3 vertical gap between Row 1 and display eq Row 2'
    },
    {
      id: 'p3-v-r2-to-r3-underscript',
      pageNumber: 3,
      kind: 'vertical',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R2Sub.id, p3R3Body.id],
      pdfWindow: visualToPdfWindow(p3R2Sub.x + 2, 195.2, p3R2Sub.width - 4, 4.5),
      description: 'Rotated Page 3 vertical gap beneath wide underscript A,B,C,D,E to Row 3'
    },
    {
      id: 'p3-v-r2-to-r3-terms',
      pageNumber: 3,
      kind: 'vertical',
      cases: ['rotatedPage3'],
      sourcePartIds: [p3R2Term1.id, p3R3Body.id],
      pdfWindow: visualToPdfWindow(p3R2Term1.x + 4, 184, 72, 12),
      description: 'Rotated Page 3 vertical gap beneath F[A, B] ... down to Row 3'
    }
  ]

  const p1Line1Right = round(p1Line1.x + p1Line1.width)
  const p2Line2Right = round(p2Line2.x + p2Line2.width)
  const p3R3Right = round(p3R3Body.x + p3R3Body.width)

  const guardWindows: GuardWindowSpec[] = [
    {
      id: 'p1-above-selection',
      pageNumber: 1,
      cases: ['crossPageMultiLine'],
      pdfWindow: { x: 60, y: 136, width: 160, height: 14 },
      reason: 'Page 1 selected paragraph 上方保持白底'
    },
    {
      id: 'p1-after-r1-end',
      pageNumber: 1,
      cases: ['crossPageMultiLine'],
      pdfWindow: { x: round(p1Line1Right + 16), y: 109, width: 60, height: 8 },
      reason: 'Page 1 Row 1 末尾之外不得延长'
    },
    {
      id: 'p2-after-r2-end',
      pageNumber: 2,
      cases: ['crossPageMultiLine'],
      pdfWindow: { x: round(p2Line2Right + 16), y: 693, width: 60, height: 8 },
      reason: 'Page 2 Row 2 末尾之外不得延长'
    },
    {
      id: 'p2-below-selection',
      pageNumber: 2,
      cases: ['crossPageMultiLine'],
      pdfWindow: { x: 60, y: 660, width: 160, height: 14 },
      reason: 'Page 2 未选第三段上方留白保持白底'
    },
    {
      id: 'p3-wide-column-gutter',
      pageNumber: 3,
      cases: ['rotatedPage3'],
      pdfWindow: visualToPdfWindow(350, 148, 60, 60),
      reason: 'Rotated Page 3 主栏与右栏间宽栏缝保持白底'
    },
    {
      id: 'p3-above-r1',
      pageNumber: 3,
      cases: ['rotatedPage3'],
      pdfWindow: visualToPdfWindow(60, 108, 160, 14),
      reason: 'Rotated Page 3 Row 1 上方未选标题空白保持白底'
    },
    {
      id: 'p3-after-r3-end',
      pageNumber: 3,
      cases: ['rotatedPage3'],
      pdfWindow: visualToPdfWindow(p3R3Right + 16, p3Row3Vy - 8, 56, 8),
      reason: 'Rotated Page 3 Row 3 末尾之外保持白底'
    },
    {
      id: 'p3-below-r3',
      pageNumber: 3,
      cases: ['rotatedPage3'],
      pdfWindow: visualToPdfWindow(60, 236, 180, 16),
      reason: 'Rotated Page 3 Row 3 下方段落空白保持白底'
    }
  ]

  const selections = {
    crossPageMultiLine: {
      startPage: 1,
      endPage: 2,
      start: { x: round(p1Line1.x + 0.4), y: p1Line1.y + 4 },
      end: { x: round(p2Line2.x + p2Line2.width - 0.4), y: p2Line2.y + 4 },
      expectedText: crossPageRows.map(r => r.text).join('\n'),
      selectedPartIds: ['p1-line1', 'p1-line2-a', 'p1-line2-b', 'p1-line2-c', 'p2-line1', 'p2-line2'],
      referencePartIds: ['p1-line1', 'p2-line1', 'p2-line2'],
      normalization: 'remove-whitespace-only' as const
    },
    crossPageSingleRunPerPage: {
      startPage: 1,
      endPage: 2,
      start: { x: round(p1Line2C.x + 0.4), y: p1Line2C.y + 4 },
      end: { x: round(p2Line1.x + p2Line1.width - 0.4), y: p2Line1.y + 4 },
      expectedText: [p1Line2C.text, p2Line1.text].join('\n'),
      selectedPartIds: ['p1-line2-c', 'p2-line1'],
      referencePartIds: ['p1-line2-c', 'p2-line1'],
      normalization: 'remove-whitespace-only' as const
    },
    rotatedPage3: {
      startPage: 3,
      endPage: 3,
      start: { x: p3Row1Vy - 4, y: round(p3R1Alpha.x + 0.4) },
      end: { x: p3Row3Vy - 4, y: round(p3R3Body.x + p3R3Body.width - 0.4) },
      expectedText: rotatedRows.map(r => r.text).join('\n'),
      selectedPartIds: [
        'p3-r1-alpha', 'p3-r1-s', 'p3-r1-and', 'p3-r1-t', 'p3-r1-tail',
        'p3-r2-left', 'p3-r2-op', 'p3-r2-underscript', 'p3-r2-term1', 'p3-r2-otimes', 'p3-r2-term2',
        'p3-r3-body'
      ],
      referencePartIds: ['p3-r1-tail', 'p3-r3-body'],
      normalization: 'remove-whitespace-only' as const
    }
  }

  const references = await Promise.all(
    [
      { path: 'node_modules/pdf-lib/es/core/embedders/StandardFontEmbedder.js', version: '1.17.1', license: 'MIT' },
      { path: 'node_modules/pdfjs-dist/legacy/build/pdf.mjs', version: '6.4.299', license: 'Apache-2.0' }
    ].map(async reference => ({
      ...reference,
      sha256: sha256(await readFile(resolve(reference.path)))
    }))
  )

  const manifest = {
    schemaVersion: 1,
    source: 'PaperFlow 原创合成边界测试 PDF（跨页选区 + 90°旋转多行公式 + 高对比度验证）；不复制任何外部文献。',
    license: 'AGPL-3.0-only',
    generator,
    fixedMetadataDate: fixedDate,
    file,
    pages,
    parts,
    selections,
    bridgeCandidates,
    guardWindows,
    excludedRuns: parts.filter(part => part.group !== 'selected'),
    font: {
      names: ['Times-Roman', 'Times-Italic', 'Symbol'],
      standard: 'PDF Standard 14 font-name references'
    },
    localReferences: references,
    verificationBoundary: {
      executed: ['生成 3 页原创合成边界测试 PDF', 'Node PDF.js 6.4.299 实际提取与旋转仿射显示基线/字号验证'],
      notExecuted: ['Electron 真实跨页鼠标拖拽与 Ctrl+C', '90° 旋转页 DPR 1 蓝框连续性与 ink 像素验证', 'forced-colors: active 高对比度视觉与 ink 对比验证']
    }
  }

  const readme = [
    '# 选区边界硬化合成测试素材（跨页 + 90°旋转 + 高对比度）',
    '',
    '本目录为 PaperFlow 原创合成测试素材，用于验证跨页连续选区、90° 顺时针旋转页面多行公式连续性以及 Windows 高对比度模式（`forced-colors: active`）。',
    '',
    '## 页面结构',
    '',
    '- **第 1 页（`600 × 780`，0°）**：页首/页中未选正文与页尾连续段落（`y = 108` 与 `y = 90` 含字体切换 `M`）。',
    '- **第 2 页（`600 × 780`，0°）**：页首承接两行正文（`y = 710` 与 `y = 692`），下方含未选段落及远端哨兵。',
    '- **第 3 页（`780 × 600`，`rotation: 90`）**：顺时针旋转 90° 后在阅读器以 `600 × 780` 竖直正向显示，包含带斜体切换的行 `alpha S and T map rotated vectors:`、带宽正下方下标的独立公式 `Q[ ] = ⊕_{A,B,C,D,E} F[A, B] ⊗ G[C, D, E]`、下一行连续正文以及右栏与远端未选哨兵。',
    '',
    '## 再生命令',
    '',
    '```powershell',
    `pnpm.cmd exec tsx ${generator}`,
    '```',
    ''
  ].join('\n')

  await mkdir(fixtureRoot, { recursive: true })
  await mkdir(auditRoot, { recursive: true })
  await writeFile(resolve(fixtureRoot, pdfName), bytes)
  await writeFile(resolve(fixtureRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(resolve(fixtureRoot, 'raw-extraction.json'), auditJson({ file, pages: extractedPages }))
  await writeFile(resolve(fixtureRoot, 'README.md'), readme)
  await writeFile(resolve(auditRoot, 'generation-audit.json'), auditJson({ file, pages, parts, bridgeCandidates, guardWindows }))

  console.log(
    JSON.stringify(
      {
        file,
        pages: pages.length,
        parts: parts.length,
        bridges: bridgeCandidates.length,
        guards: guardWindows.length,
        crossPageRows,
        rotatedRows
      },
      null,
      2
    )
  )
}

void main()
