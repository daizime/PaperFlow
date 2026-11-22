import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

interface Point {
  x: number
  y: number
}

interface Rect extends Point {
  width: number
  height: number
}

type PartRole = 'body' | 'operator' | 'subscript' | 'dots'

interface Part {
  id: string
  rowId: string
  text: string
  font: 'Times-Roman' | 'Times-Italic' | 'Helvetica' | 'Symbol'
  x: number
  y: number
  size: number
  width: number
  role: PartRole
  drawOrder: number
}

interface BridgeCandidate {
  id: string
  kind: 'horizontal' | 'vertical'
  cases: ('fullFiveRows' | 'proseTwoRows')[]
  sourcePartIds: string[]
  sourceRowIds: string[]
  pdfWindow: Rect
  description: string
}

interface GuardWindow {
  id: string
  cases: ('fullFiveRows' | 'proseTwoRows')[]
  pdfWindow: Rect
  reason: string
}

interface DotCandidateAudit {
  id: string
  font: Part['font']
  text: string
  codePoints: string[]
  encodable: boolean
  widthAt12: number | null
}

const fixtureRoot = resolve('tests/fixtures/verification/selection-continuity')
const auditRoot = resolve('.cache/reader/20261122-selection-continuity-01/generator')
const generator = 'scripts/verification/generate-selection-continuity-fixture.ts'
const pdfName = 'selection-continuity-regression.pdf'
const fixedDate = '2026-11-22T00:00:00.000Z'
const pageWidth = 600
const pageHeight = 780

const round = (value: number): number => Number(value.toFixed(6))
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const withoutWhitespace = (text: string): string => text.replace(/\s+/gu, '')

// Plain Tj has no pair kerning; sum individual glyph advances, then audit with Node PDF.js.
const advance = (font: PDFFont, text: string, size: number): number =>
  round([...text].reduce((sum, character) => sum + font.widthOfTextAtSize(character, size), 0))

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
  document.setTitle('PaperFlow original synthetic selection continuity regression fixture')
  document.setAuthor('PaperFlow synthetic verification fixtures')
  document.setSubject('Original synthetic prose, wide underscripts, and inline symbols. No copied paper or scientific claim.')
  document.setCreator('PaperFlow deterministic fixture generator')
  document.setProducer('pdf-lib 1.17.1 / PaperFlow synthetic fixture')
  document.setCreationDate(new Date(fixedDate))
  document.setModificationDate(new Date(fixedDate))

  const timesRoman = await document.embedFont(StandardFonts.TimesRoman)
  const timesItalic = await document.embedFont(StandardFonts.TimesRomanItalic)
  const helvetica = await document.embedFont(StandardFonts.Helvetica)
  const symbol = await document.embedFont(StandardFonts.Symbol)

  const fonts = new Map<Part['font'], PDFFont>([
    ['Times-Roman', timesRoman],
    ['Times-Italic', timesItalic],
    ['Helvetica', helvetica],
    ['Symbol', symbol]
  ])

  const oplus = '\u2295'
  const otimes = '\u2297'
  if (!canEncode(symbol, oplus) || !canEncode(symbol, otimes)) {
    throw new Error('Standard Symbol font cannot encode required U+2295 / U+2297 operators')
  }

  const dotCandidates: { id: string; font: Part['font']; text: string; baselineShift: number }[] = [
    { id: 'symbol-dotmath-spaced', font: 'Symbol', text: '\u22c5 \u22c5 \u22c5', baselineShift: 1.5 },
    { id: 'symbol-dotmath-tight', font: 'Symbol', text: '\u22c5\u22c5\u22c5', baselineShift: 1.5 },
    { id: 'times-middledot-tight', font: 'Times-Roman', text: '\u00b7\u00b7\u00b7', baselineShift: 1.5 },
    { id: 'times-periods-raised', font: 'Times-Roman', text: '...', baselineShift: 3.5 }
  ]

  const dotAudits: DotCandidateAudit[] = dotCandidates.map(candidate => {
    const font = fonts.get(candidate.font)!
    const encodable = canEncode(font, candidate.text)
    return {
      id: candidate.id,
      font: candidate.font,
      text: candidate.text,
      codePoints: [...candidate.text].map(ch => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')),
      encodable,
      widthAt12: encodable ? advance(font, candidate.text, 12) : null
    }
  })

  // Prefer single-item Symbol centered dots '\u22c5\u22c5\u22c5' (U+22C5) if encodable; fallback otherwise.
  const chosenDotSpec =
    dotCandidates.find(c => c.id === 'symbol-dotmath-tight' && canEncode(fonts.get(c.font)!, c.text)) ??
    dotCandidates.find(c => c.id === 'times-middledot-tight' && canEncode(fonts.get(c.font)!, c.text)) ??
    dotCandidates.find(c => canEncode(fonts.get(c.font)!, c.text))
  if (!chosenDotSpec) {
    throw new Error('No candidate 3-dot ellipsis could be encoded')
  }

  let nextOrder = 0
  const makePart = (
    id: string,
    rowId: string,
    text: string,
    font: Part['font'],
    x: number,
    y: number,
    size: number,
    role: PartRole
  ): Part => ({
    id,
    rowId,
    text,
    font,
    x: round(x),
    y: round(y),
    size,
    width: advance(fonts.get(font)!, text, size),
    role,
    drawOrder: nextOrder++
  })

  // 1. Excluded runs drawn BEFORE selection
  const excludedBefore: Part[] = [
    makePart('unselected-title', 'excluded-before', 'ORIGINAL SYNTHETIC SELECTION CONTINUITY', 'Times-Roman', 48, 690, 11, 'body'),
    makePart(
      'unselected-intro',
      'excluded-before',
      'Synthetic prose, wide underscripts, and inline symbols for continuity audit.',
      'Times-Roman',
      48,
      656,
      12,
      'body'
    )
  ]

  // 2. Row 1: ordinary prose with repeated font switches, ZERO \p{Sm} math symbols, 4.5pt inter-span gaps
  const row1Y = 602
  const row1Gap = 4.5
  const row1Specs: { id: string; text: string; font: Part['font'] }[] = [
    { id: 'r1-blocks', text: 'blocks', font: 'Times-Roman' },
    { id: 'r1-m1', text: 'M', font: 'Times-Italic' },
    { id: 'r1-and1', text: 'and', font: 'Times-Roman' },
    { id: 'r1-n1', text: 'N', font: 'Times-Italic' },
    { id: 'r1-match', text: 'match grids', font: 'Times-Roman' },
    { id: 'r1-m2', text: 'M', font: 'Helvetica' },
    { id: 'r1-and2', text: 'and', font: 'Times-Roman' },
    { id: 'r1-n2', text: 'N', font: 'Helvetica' },
    { id: 'r1-tail', text: '. Each step', font: 'Times-Roman' }
  ]
  const row1Parts: Part[] = []
  let cursorX = 48
  for (const spec of row1Specs) {
    const part = makePart(spec.id, 'row-1', spec.text, spec.font, cursorX, row1Y, 12, 'body')
    row1Parts.push(part)
    cursorX = round(part.x + part.width + row1Gap)
  }

  // 3. Row 2: short prose directly below Row 1 (baseline 17pt below Row 1, visual gap ~3pt)
  const row2Y = 585
  const row2Parts: Part[] = [
    makePart('r2-body', 'row-2', 'passes into:', 'Times-Roman', 48, row2Y, 12, 'body')
  ]

  // 4. Row 3: indented display equation with wide underscript under \u2295 and \u2297 chain
  // Baseline 29pt below Row 2 (visual gap ~15pt)
  const row3Y = 556
  const row3InlineGap = 4.2
  const r3Left = makePart('r3-left', 'row-3', 'V[ ] =', 'Times-Roman', 68, row3Y, 12, 'body')
  const r3LeftGap = 20 // > 1.25 * 12 (15pt)
  const r3Op = makePart('r3-op', 'row-3', oplus, 'Symbol', r3Left.x + r3Left.width + r3LeftGap, 553, 20, 'operator')
  const r3SubWidth = advance(timesRoman, 'A,B,C,D,E', 8)
  const r3SubX = round(r3Op.x + r3Op.width / 2 - r3SubWidth / 2)
  const r3Underscript = makePart('r3-underscript', 'row-3', 'A,B,C,D,E', 'Times-Roman', r3SubX, 542, 8, 'subscript')
  const r3RightGap = 20 // > 1.25 * 12 (15pt)
  const r3Term1 = makePart('r3-term1', 'row-3', 'F[A, B]', 'Times-Roman', r3Op.x + r3Op.width + r3RightGap, row3Y, 12, 'body')
  const r3Otimes1 = makePart('r3-otimes1', 'row-3', otimes, 'Symbol', r3Term1.x + r3Term1.width + row3InlineGap, row3Y, 12, 'operator')
  const r3Term2 = makePart('r3-term2', 'row-3', 'G[A, C, E]', 'Times-Roman', r3Otimes1.x + r3Otimes1.width + row3InlineGap, row3Y, 12, 'body')
  const r3Otimes2 = makePart('r3-otimes2', 'row-3', otimes, 'Symbol', r3Term2.x + r3Term2.width + row3InlineGap, row3Y, 12, 'operator')
  const r3Term3 = makePart('r3-term3', 'row-3', 'H[C, D]', 'Times-Roman', r3Otimes2.x + r3Otimes2.width + row3InlineGap, row3Y, 12, 'body')
  const row3Parts: Part[] = [r3Left, r3Op, r3Underscript, r3Term1, r3Otimes1, r3Term2, r3Otimes2, r3Term3]

  // 5. Row 4: inline prose with wide underscript \u2295_{A,B,C,D,E} AND inline right-adjacent subscripts + raised dots \u2295_A ... \u2295_E
  // Baseline 32pt below Row 3
  const row4Y = 524
  const row4InlineGap = 4.2
  const r4Here = makePart('r4-here', 'row-4', 'here', 'Times-Roman', 48, row4Y, 12, 'body')
  const r4LeftGap = 18 // > 1.25 * 12 (15pt)
  const r4Op1 = makePart('r4-op1', 'row-4', oplus, 'Symbol', r4Here.x + r4Here.width + r4LeftGap, 523, 16, 'operator')
  const r4SubWidth = advance(timesRoman, 'A,B,C,D,E', 8)
  const r4SubX = round(r4Op1.x + r4Op1.width / 2 - r4SubWidth / 2)
  const r4Underscript = makePart('r4-underscript', 'row-4', 'A,B,C,D,E', 'Times-Roman', r4SubX, 514, 8, 'subscript')
  const r4RightGap = 18 // > 1.25 * 12 (15pt)
  const r4Denotes = makePart('r4-denotes', 'row-4', 'denotes', 'Times-Roman', r4Op1.x + r4Op1.width + r4RightGap, row4Y, 12, 'body')
  const r4Op2 = makePart('r4-op2', 'row-4', oplus, 'Symbol', r4Denotes.x + r4Denotes.width + row4InlineGap, 523, 15, 'operator')
  const r4SubA = makePart('r4-sub-a', 'row-4', 'A', 'Times-Roman', r4Op2.x + r4Op2.width + 0.5, 518.5, 8, 'subscript')
  const r4Dots = makePart(
    'r4-dots',
    'row-4',
    chosenDotSpec.text,
    chosenDotSpec.font,
    r4SubA.x + r4SubA.width + row4InlineGap,
    row4Y + chosenDotSpec.baselineShift,
    14,
    'dots'
  )
  const r4Op3 = makePart('r4-op3', 'row-4', oplus, 'Symbol', r4Dots.x + r4Dots.width + row4InlineGap, 523, 15, 'operator')
  const r4SubE = makePart('r4-sub-e', 'row-4', 'E', 'Times-Roman', r4Op3.x + r4Op3.width + 0.5, 518.5, 8, 'subscript')
  const r4Tail = makePart('r4-tail', 'row-4', '. Every local link', 'Times-Roman', r4SubE.x + r4SubE.width + row4InlineGap, row4Y, 12, 'body')
  const row4Parts: Part[] = [r4Here, r4Op1, r4Underscript, r4Denotes, r4Op2, r4SubA, r4Dots, r4Op3, r4SubE, r4Tail]

  // 6. Row 5: prose below Row 4 pushed 24pt down (gap from Row 4 main body ~10pt)
  const row5Y = 500
  const row5Parts: Part[] = [
    makePart('r5-body', 'row-5', 'holds bounded weights at all nodes. Next', 'Times-Roman', 48, row5Y, 12, 'body')
  ]

  const selectedParts: Part[] = [...row1Parts, ...row2Parts, ...row3Parts, ...row4Parts, ...row5Parts]

  // 7. Excluded runs drawn AFTER selection (never adjacent in stream before Row 5 end)
  const excludedAfter: Part[] = [
    makePart('col2-row1', 'excluded-after', 'Col two item alpha.', 'Times-Roman', 460, row1Y, 12, 'body'),
    makePart('col2-row2', 'excluded-after', 'Col two item beta.', 'Times-Roman', 460, row2Y, 12, 'body'),
    makePart('col2-row3', 'excluded-after', 'Col two item gamma.', 'Times-Roman', 460, row3Y, 12, 'body'),
    makePart('col2-row4', 'excluded-after', 'Col two item delta.', 'Times-Roman', 460, row4Y, 12, 'body'),
    makePart('remote-sentinel', 'excluded-after', 'UNSELECTED_REMOTE_SENTINEL_CONTINUITY_07', 'Times-Roman', 48, 240, 12, 'body')
  ]

  const drawOrder: Part[] = [...excludedBefore, ...selectedParts, ...excludedAfter]
  const page = document.addPage([pageWidth, pageHeight])
  for (const part of drawOrder) {
    if (part.x < 0 || part.x + part.width > pageWidth || part.y < 0 || part.y + part.size > pageHeight) {
      throw new Error(`Synthetic run is outside page: ${part.id}`)
    }
    page.drawText(part.text, {
      x: part.x,
      y: part.y,
      size: part.size,
      font: fonts.get(part.font)!,
      color: rgb(0, 0, 0)
    })
  }

  const bytes = await document.save({ useObjectStreams: false })
  const file = { name: pdfName, bytes: bytes.length, sha256: sha256(bytes) }
  const pages = [{ number: 1, width: pageWidth, height: pageHeight, rotation: 0, view: [0, 0, pageWidth, pageHeight], userUnit: 1 }]

  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
    useSystemFonts: false
  })

  let rawContent: unknown
  const rowExtracted = new Map<string, string>()
  const matchedItems: { partId: string; rowId: string; itemIndex: number; str: string; width: number; height: number; x: number; y: number }[] = []

  try {
    const pdf = await task.promise
    if (pdf.numPages !== 1) throw new Error('Unexpected synthetic page count')
    const actualPage = await pdf.getPage(1)
    const viewport = actualPage.getViewport({ scale: 1 })
    if (
      viewport.width !== pageWidth ||
      viewport.height !== pageHeight ||
      actualPage.rotate !== 0 ||
      actualPage.userUnit !== 1 ||
      actualPage.view.some((value, index) => value !== pages[0].view[index])
    ) {
      throw new Error('Unexpected synthetic page geometry')
    }

    const content = await actualPage.getTextContent({ includeMarkedContent: true })
    let expectedIndex = 0
    let activeRowId: string | null = null

    for (let itemIndex = 0; itemIndex < content.items.length; itemIndex++) {
      const item = content.items[itemIndex]
      if (!('str' in item)) continue
      if (!item.str.trim()) {
        if (activeRowId) rowExtracted.set(activeRowId, (rowExtracted.get(activeRowId) ?? '') + item.str)
        continue
      }
      const expected = drawOrder[expectedIndex++]
      if (
        !expected ||
        withoutWhitespace(item.str) !== withoutWhitespace(expected.text) ||
        Math.abs(item.height - expected.size) > 0.001 ||
        Math.abs(item.transform[5] - expected.y) > 0.001
      ) {
        throw new Error(
          `PDF.js item differs from authored part at index ${expectedIndex - 1} (${expected?.id ?? 'extra'}): got str=${JSON.stringify(item.str)} h=${item.height} y=${item.transform[5]}`
        )
      }
      matchedItems.push({
        partId: expected.id,
        rowId: expected.rowId,
        itemIndex,
        str: item.str,
        width: item.width,
        height: item.height,
        x: item.transform[4],
        y: item.transform[5]
      })
      if (expected.rowId.startsWith('row-')) {
        activeRowId = expected.rowId
        rowExtracted.set(activeRowId, (rowExtracted.get(activeRowId) ?? '') + item.str)
      } else {
        activeRowId = null
      }
    }

    if (expectedIndex !== drawOrder.length) {
      throw new Error(`Expected ${drawOrder.length} non-empty items, got ${expectedIndex}`)
    }

    // Verify drawOrder containment invariants: excluded-before < row-1..row-5 < excluded-after
    const firstSelectedPos = matchedItems.findIndex(item => item.rowId === 'row-1')
    let lastSelectedPos = -1
    for (let i = matchedItems.length - 1; i >= 0; i--) {
      if (matchedItems[i].rowId === 'row-5') {
        lastSelectedPos = i
        break
      }
    }
    if (firstSelectedPos <= 0 || lastSelectedPos < firstSelectedPos) {
      throw new Error('Invalid selected row positions in extracted stream')
    }
    for (let i = 0; i < firstSelectedPos; i++) {
      if (matchedItems[i].rowId !== 'excluded-before') throw new Error(`Unexpected run before Row 1: ${matchedItems[i].partId}`)
    }
    for (let i = firstSelectedPos; i <= lastSelectedPos; i++) {
      if (!matchedItems[i].rowId.startsWith('row-')) throw new Error(`Excluded run interleaved inside selection: ${matchedItems[i].partId}`)
    }
    for (let i = lastSelectedPos + 1; i < matchedItems.length; i++) {
      if (matchedItems[i].rowId !== 'excluded-after') throw new Error(`Selected run leaked after Row 5: ${matchedItems[i].partId}`)
    }

    rawContent = {
      pageNumber: 1,
      view: actualPage.view,
      rotation: actualPage.rotate,
      userUnit: actualPage.userUnit,
      viewport: { width: viewport.width, height: viewport.height },
      content,
      matchedItems
    }
  } finally {
    await task.destroy()
  }

  const normalizeRowText = (raw: string): string => raw.replace(/\s+/gu, ' ').trim()
  const rowDefs = [
    { id: 'row-1', parts: row1Parts, role: 'prose' as const },
    { id: 'row-2', parts: row2Parts, role: 'prose' as const },
    { id: 'row-3', parts: row3Parts, role: 'display-math' as const },
    { id: 'row-4', parts: row4Parts, role: 'inline-math' as const },
    { id: 'row-5', parts: row5Parts, role: 'prose' as const }
  ]

  const selectedRows = rowDefs.map(def => {
    const text = normalizeRowText(rowExtracted.get(def.id) ?? '')
    const expectedNoWs = withoutWhitespace(def.parts.map(p => p.text).join(''))
    if (withoutWhitespace(text) !== expectedNoWs) {
      throw new Error(`Row ${def.id} extraction mismatch: ${text} vs ${expectedNoWs}`)
    }
    return {
      id: def.id,
      text,
      partIds: def.parts.map(p => p.id),
      role: def.role
    }
  })

  const row1Start = { x: round(row1Parts[0].x + 0.4), y: row1Y + 6 }
  const row2End = { x: round(row2Parts[0].x + row2Parts[0].width - 0.4), y: row2Y + 6 }
  const row5End = { x: round(row5Parts[0].x + row5Parts[0].width - 0.4), y: row5Y + 6 }

  const selections = {
    fullFiveRows: {
      pageNumber: 1,
      start: row1Start,
      end: row5End,
      expectedText: selectedRows.map(r => r.text).join('\n'),
      expectedLines: selectedRows.map(r => r.text),
      normalization: 'remove-whitespace-only' as const
    },
    proseTwoRows: {
      pageNumber: 1,
      start: row1Start,
      end: row2End,
      expectedText: selectedRows.slice(0, 2).map(r => r.text).join('\n'),
      expectedLines: selectedRows.slice(0, 2).map(r => r.text),
      normalization: 'remove-whitespace-only' as const
    }
  }

  // Horizontal bridge windows across EVERY inter-span gap in Row 1, Row 3, and Row 4
  const bridgeCandidates: BridgeCandidate[] = []
  for (let i = 0; i < row1Parts.length - 1; i++) {
    const a = row1Parts[i]
    const b = row1Parts[i + 1]
    bridgeCandidates.push({
      id: `r1-gap-${i + 1}-${a.id}-to-${b.id}`,
      kind: 'horizontal',
      cases: ['fullFiveRows', 'proseTwoRows'],
      sourcePartIds: [a.id, b.id],
      sourceRowIds: ['row-1'],
      pdfWindow: {
        x: round(a.x + a.width + 0.3),
        y: row1Y + 0.5,
        width: round(b.x - (a.x + a.width) - 0.6),
        height: 5.5
      },
      description: `Row 1 font-switch horizontal gap between ${a.id} (${a.font}) and ${b.id} (${b.font})`
    })
  }

  bridgeCandidates.push(
    {
      id: 'r3-left-of-oplus',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r3Left.id, r3Op.id],
      sourceRowIds: ['row-3'],
      pdfWindow: { x: round(r3Left.x + r3Left.width + 1), y: row3Y + 1, width: round(r3LeftGap - 2), height: 7 },
      description: 'Row 3 >1.25em gap left of wide-underscript circled-plus'
    },
    {
      id: 'r3-right-of-oplus',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r3Op.id, r3Term1.id],
      sourceRowIds: ['row-3'],
      pdfWindow: { x: round(r3Op.x + r3Op.width + 1), y: row3Y + 1, width: round(r3RightGap - 2), height: 7 },
      description: 'Row 3 >1.25em gap right of wide-underscript circled-plus'
    },
    {
      id: 'r3-gap-term1-otimes1',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r3Term1.id, r3Otimes1.id],
      sourceRowIds: ['row-3'],
      pdfWindow: { x: round(r3Term1.x + r3Term1.width + 0.25), y: row3Y + 1, width: round(row3InlineGap - 0.5), height: 6 },
      description: 'Row 3 horizontal gap before first otimes'
    },
    {
      id: 'r3-gap-otimes1-term2',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r3Otimes1.id, r3Term2.id],
      sourceRowIds: ['row-3'],
      pdfWindow: { x: round(r3Otimes1.x + r3Otimes1.width + 0.25), y: row3Y + 1, width: round(row3InlineGap - 0.5), height: 6 },
      description: 'Row 3 horizontal gap after first otimes'
    },
    {
      id: 'r3-gap-term2-otimes2',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r3Term2.id, r3Otimes2.id],
      sourceRowIds: ['row-3'],
      pdfWindow: { x: round(r3Term2.x + r3Term2.width + 0.25), y: row3Y + 1, width: round(row3InlineGap - 0.5), height: 6 },
      description: 'Row 3 horizontal gap before second otimes'
    },
    {
      id: 'r3-gap-otimes2-term3',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r3Otimes2.id, r3Term3.id],
      sourceRowIds: ['row-3'],
      pdfWindow: { x: round(r3Otimes2.x + r3Otimes2.width + 0.25), y: row3Y + 1, width: round(row3InlineGap - 0.5), height: 6 },
      description: 'Row 3 horizontal gap after second otimes'
    },
    {
      id: 'r4-left-of-oplus',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r4Here.id, r4Op1.id],
      sourceRowIds: ['row-4'],
      pdfWindow: { x: round(r4Here.x + r4Here.width + 1), y: row4Y + 1, width: round(r4LeftGap - 2), height: 7 },
      description: 'Row 4 >1.25em gap left of inline wide-underscript circled-plus'
    },
    {
      id: 'r4-right-of-oplus',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r4Op1.id, r4Denotes.id],
      sourceRowIds: ['row-4'],
      pdfWindow: { x: round(r4Op1.x + r4Op1.width + 1), y: row4Y + 1, width: round(r4RightGap - 2), height: 7 },
      description: 'Row 4 >1.25em gap right of inline wide-underscript circled-plus'
    },
    {
      id: 'r4-gap-denotes-op2',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r4Denotes.id, r4Op2.id],
      sourceRowIds: ['row-4'],
      pdfWindow: { x: round(r4Denotes.x + r4Denotes.width + 0.25), y: row4Y + 1, width: round(row4InlineGap - 0.5), height: 6 },
      description: 'Row 4 horizontal gap before oplus_A'
    },
    {
      id: 'r4-gap-sub-a-dots',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r4SubA.id, r4Dots.id],
      sourceRowIds: ['row-4'],
      pdfWindow: { x: round(r4SubA.x + r4SubA.width + 0.25), y: row4Y + 1, width: round(row4InlineGap - 0.5), height: 6 },
      description: 'Row 4 horizontal gap between right-adjacent subscript A and raised dots'
    },
    {
      id: 'r4-gap-dots-op3',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r4Dots.id, r4Op3.id],
      sourceRowIds: ['row-4'],
      pdfWindow: { x: round(r4Dots.x + r4Dots.width + 0.25), y: row4Y + 1, width: round(row4InlineGap - 0.5), height: 6 },
      description: 'Row 4 horizontal gap between raised dots and oplus_E'
    },
    {
      id: 'r4-gap-sub-e-tail',
      kind: 'horizontal',
      cases: ['fullFiveRows'],
      sourcePartIds: [r4SubE.id, r4Tail.id],
      sourceRowIds: ['row-4'],
      pdfWindow: { x: round(r4SubE.x + r4SubE.width + 0.25), y: row4Y + 1, width: round(row4InlineGap - 0.5), height: 6 },
      description: 'Row 4 horizontal gap between right-adjacent subscript E and trailing period/prose'
    },
    // Vertical inter-row bridges across ALL 5 rows
    {
      id: 'v-row1-to-row2',
      kind: 'vertical',
      cases: ['fullFiveRows', 'proseTwoRows'],
      sourcePartIds: [row1Parts[0].id, row2Parts[0].id],
      sourceRowIds: ['row-1', 'row-2'],
      pdfWindow: { x: 52, y: 595, width: 48, height: 4.5 },
      description: 'Vertical gap between ordinary prose Row 1 and Row 2'
    },
    {
      id: 'v-row2-to-row3',
      kind: 'vertical',
      cases: ['fullFiveRows'],
      sourcePartIds: [row2Parts[0].id, r3Left.id],
      sourceRowIds: ['row-2', 'row-3'],
      pdfWindow: { x: 70, y: 569, width: 32, height: 11 },
      description: 'Vertical gap between prose Row 2 and indented display equation Row 3'
    },
    {
      id: 'v-row3-to-row4-underscript',
      kind: 'vertical',
      cases: ['fullFiveRows'],
      sourcePartIds: [r3Underscript.id, r4Denotes.id],
      sourceRowIds: ['row-3', 'row-4'],
      pdfWindow: { x: round(r3Underscript.x + 2), y: 534, width: round(r3Underscript.width - 4), height: 5 },
      description: 'Vertical gap beneath Row 3 wide underscript A,B,C,D,E down to Row 4'
    },
    {
      id: 'v-row3-to-row4-terms',
      kind: 'vertical',
      cases: ['fullFiveRows'],
      sourcePartIds: [r3Term1.id, r4Op2.id],
      sourceRowIds: ['row-3', 'row-4'],
      pdfWindow: { x: round(r3Term1.x + 4), y: 538, width: 80, height: 14 },
      description: 'Vertical gap beneath Row 3 right-hand terms F[A,B] otimes ... down to Row 4'
    },
    {
      id: 'v-row4-to-row5-outside-underscript',
      kind: 'vertical',
      cases: [
        'fullFiveRows'
      ],
      sourcePartIds: [r4Denotes.id, row5Parts[0].id],
      sourceRowIds: ['row-4', 'row-5'],
      pdfWindow: { x: round(r4Underscript.x + r4Underscript.width + 6), y: 512, width: 96, height: 5.5 },
      description: 'Vertical gap between Row 4 and Row 5 outside Row 4 wide underscript x-range'
    }
  )

  const maxRowWidthX = Math.max(...selectedParts.map(p => round(p.x + p.width)))
  const row1Right = round(row1Parts.at(-1)!.x + row1Parts.at(-1)!.width)
  const row2Right = round(row2Parts[0].x + row2Parts[0].width)
  const row5Right = round(row5Parts[0].x + row5Parts[0].width)

  const guardWindows: GuardWindow[] = [
    {
      id: 'wide-column-gap',
      cases: ['fullFiveRows', 'proseTwoRows'],
      pdfWindow: { x: 365, y: 524, width: 60, height: 60 },
      reason: '左侧主栏与右栏 (x>=460) 之间的宽栏缝，不得跨栏连接'
    },
    {
      id: 'after-row1-end',
      cases: ['proseTwoRows'],
      pdfWindow: { x: round(row1Right + 14), y: row1Y + 1, width: 42, height: 8 },
      reason: '仅选中前两行时，Row 1 末尾之外的同基线空白不得延长'
    },
    {
      id: 'after-row2-end',
      cases: ['fullFiveRows', 'proseTwoRows'],
      pdfWindow: { x: round(row2Right + 18), y: row2Y + 1, width: 96, height: 8 },
      reason: 'Row 2 末尾之外的同基线空白（上方有 Row 1，下方有 Row 3），不得越界填充'
    },
    {
      id: 'after-row5-end',
      cases: ['fullFiveRows'],
      pdfWindow: { x: round(row5Right + 14), y: row5Y + 1, width: 56, height: 8 },
      reason: 'Row 5 末尾之外的同基线空白，不得向右延长'
    },
    {
      id: 'paragraph-gap-below',
      cases: ['fullFiveRows'],
      pdfWindow: { x: 60, y: 452, width: 200, height: 14 },
      reason: 'Row 5 下方独立段落空白，不得向远处哨兵延长'
    },
    {
      id: 'unselected-title-above',
      cases: ['fullFiveRows', 'proseTwoRows'],
      pdfWindow: { x: 48, y: 690, width: 200, height: 11 },
      reason: 'Row 1 上方独立未选标题背景，不得高亮'
    },
    {
      id: 'unselected-row3',
      cases: ['proseTwoRows'],
      pdfWindow: { x: 68, y: row3Y, width: 160, height: 12 },
      reason: '仅选 Row 1 -> Row 2 时，下方未选的 Row 3 公式必须保持白底'
    }
  ]

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
    source: 'PaperFlow 原创合成文字、字符组合与 PDF；不复制论文、截图正文或用户文献；公式无数学事实或 LaTeX 主张。',
    license: 'AGPL-3.0-only（同项目；依赖许可单列）',
    generator,
    fixedMetadataDate: fixedDate,
    file,
    pages,
    parts: selectedParts,
    selectedRows,
    selections,
    bridgeCandidates,
    guardWindows,
    reference: {
      fullFiveRowsBodyPartIds: ['r1-match', 'r1-tail', 'r2-body', 'r4-tail', 'r5-body'],
      proseTwoRowsBodyPartIds: ['r1-match', 'r1-tail', 'r2-body']
    },
    excludedRuns: [...excludedBefore, ...excludedAfter],
    geometryAudit: {
      maxSelectedX: maxRowWidthX,
      secondColumnX: 460,
      gutterWidth: round(460 - maxRowWidthX),
      rowBaselines: { row1: row1Y, row2: row2Y, row3: row3Y, row4: row4Y, row5: row5Y }
    },
    dotAudit: {
      chosenId: chosenDotSpec.id,
      chosenFont: chosenDotSpec.font,
      chosenText: chosenDotSpec.text,
      chosenBaselineShift: chosenDotSpec.baselineShift,
      chosenSize: 14,
      candidates: dotAudits
    },
    font: {
      names: ['Times-Roman', 'Times-Italic', 'Helvetica', 'Symbol'],
      standard: 'PDF Standard 14 font-name references; no font files copied or embedded'
    },
    coordinates: {
      space: 'PDF default user space, lower-left origin, x right, y up',
      widthMethod: 'Sum of individual glyph advances, audited against Node PDF.js; no AFM pair kerning in plain Tj',
      pointMethod: 'Fixed authored first character x+0.4 and last character x+width-0.4; baseline+6; never aimed from TextLayer'
    },
    extraction: {
      file: 'raw-extraction.json',
      tool: 'Node PDF.js 6.4.299',
      result: 'passed exact non-whitespace characters/order, font size/baseline, page geometry, and excluded-run containment',
      serialization: 'Nonfinite numeric extraction values are recorded as strings NaN/Infinity, not silently null.'
    },
    localReferences: references,
    verificationBoundary: {
      executed: ['生成一页原创合成 PDF', 'Node PDF.js 实际提取、流顺序隔离与制作参数核对'],
      notExecuted: ['Electron/真实鼠标拖选和 Ctrl+C 剪贴板', '浏览器 Range 实测', 'DPR 1 CSS 蓝框连贯像素与 guard 白底实测', '用户原文档验证']
    }
  }

  const readme = [
    '# 选区连续性回归合成素材（5 行综合场景）',
    '',
    '本目录为 PaperFlow 原创合成测试素材，不复制论文、截图正文或用户文献；英文与公式字符仅供选区连续性回归测试，无科学事实或 LaTeX 主张。',
    '',
    '## 内容与制作坐标',
    '',
    '- 单页 `600 × 780`、0°、UserUnit 1。引用 PDF Standard 14 字体 `Times-Roman`、`Times-Italic`、`Helvetica` 与 `Symbol`，不嵌入或复制字体文件。',
    '- **绘制流顺序隔离**：`unselected-title` 与 `unselected-intro` 在 Row 1 之前绘制；Row 1–Row 5 按阅读顺序连续绘制（包含 Row 3 与 Row 4 的宽正下方下标 `A,B,C,D,E`、行内右侧下标及居中三点）；右栏（`x >= 460`）与远端哨兵（`y = 240`）在 Row 5 之后绘制，保证从 Row 1 起点拖选至 Row 5 终点时 DOM 区间自然囊括 5 行全部内容且不夹杂右栏或哨兵。',
    '- **Row 1**（`y = 602`）：零 `\\p{Sm}` 数学符号的普通混排正文，含 `Times-Roman` / `Times-Italic` / `Helvetica` 多次切换与 `4.5 pt` span 间隙（`< 1.25*em = 15 pt`，且在 100% DPR 1 下可稳定采集 `>= 2` 列纯白样本）。',
    '- **Row 2**（`y = 585`）：普通正文 `passes into:`（基线低于 Row 1 `17 pt`）。',
    '- **Row 3**（`y = 556`）：缩进独立公式（基线低于 Row 2 `29 pt`），含 `V[ ] =` 与 `20 pt` `⊕`（`> 1.25*em` 即 `20 pt` 左右间隔）、正下方对称宽下标 `A,B,C,D,E`（`8 pt`）、以及 `F[A, B] ⊗ G[A, C, E] ⊗ H[C, D]`。',
    `- **Row 4**（\`y = 524\`）：行内混排公式，同时包含宽正下方下标 \`⊕_{A,B,C,D,E}\`（左右间隔 \`18 pt > 1.25*em\`）与行内右侧下标 \`⊕_A ... ⊕_E\`；居中三点经 \`encodeText\` 审计后选用 \`${chosenDotSpec.font}\` \`${chosenDotSpec.text}\`（\`${dotAudits.find(d => d.id === chosenDotSpec.id)!.codePoints.join(' ')}\`，基线抬升 \`${chosenDotSpec.baselineShift} pt\`）。`,
    '- **Row 5**（`y = 500`）：基线低于 Row 4 `24 pt` 的普通正文 `holds bounded weights at all nodes. Next`。',
    '',
    '## 再生及实际审计',
    '',
    '```powershell',
    `pnpm.cmd exec tsx ${generator}`,
    '```',
    '',
    `元数据日期固定为 \`${fixedDate}\`，无随机量；\`raw-extraction.json\` 保存 Node PDF.js 原始提取结果，非有限数值显式序列化为字符串。`,
    '',
    '## 验证边界',
    '',
    '**已真实执行**：PDF 生成及 Node PDF.js 非空白字符/顺序、字号/基线、页面几何与流顺序隔离审计。**待 verifier 执行**：Electron 真实鼠标拖拽、Ctrl+C 剪贴板、100%/150% DPR 1 蓝框连续性与 guard 白底像素检测。',
    ''
  ].join('\n')

  await mkdir(fixtureRoot, { recursive: true })
  await mkdir(auditRoot, { recursive: true })
  await writeFile(resolve(fixtureRoot, pdfName), bytes)
  await writeFile(resolve(fixtureRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(resolve(fixtureRoot, 'raw-extraction.json'), auditJson({ file, page: rawContent, selectedRows }))
  await writeFile(resolve(fixtureRoot, 'README.md'), readme)
  await writeFile(
    resolve(auditRoot, 'generation-audit.json'),
    auditJson({
      generatedAt: fixedDate,
      node: process.version,
      file,
      authoredDrawOrder: drawOrder,
      matchedItems,
      dotAudit: manifest.dotAudit,
      geometryAudit: manifest.geometryAudit,
      references,
      boundary: manifest.verificationBoundary
    })
  )

  console.log(
    JSON.stringify(
      {
        file,
        dotAudit: { chosenId: manifest.dotAudit.chosenId, chosenFont: manifest.dotAudit.chosenFont },
        geometryAudit: manifest.geometryAudit,
        selectedRows,
        bridgeCount: bridgeCandidates.length,
        guardCount: guardWindows.length,
        audit: manifest.extraction.result
      },
      null,
      2
    )
  )
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
