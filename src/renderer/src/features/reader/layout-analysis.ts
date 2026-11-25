import {
  pdfRectToViewport,
  viewportRectToPdf,
  type PageGeometry,
  type PageRect,
  type PageTextContent
} from './pdf-geometry'
import { composeAffine, displayScaleForViewport, viewportToDisplayRect } from './selection-bridges'

export type LayoutBlockKind = 'heading' | 'paragraph' | 'caption' | 'formula' | 'list-item'
export type FilteredReason = 'header' | 'footer' | 'page-number' | 'margin-stamp'

export interface FilteredLayoutItem {
  text: string
  reason: FilteredReason
  displayRect: PageRect
  pdfRect: PageRect
}

export interface SentenceFragment {
  pageNumber: number
  columnIndex: number
  rect: PageRect
  displayRect: PageRect
  textSlice: string
}

export interface AnalyzedSentence {
  id: string
  pageNumber: number
  order: number
  blockId: string
  blockKind: LayoutBlockKind
  columnIndex: number
  text: string
  rects: PageRect[]
  displayRects: PageRect[]
  bounds: PageRect
  displayBounds: PageRect
  fragments: SentenceFragment[]
  crossColumn: boolean
}

export interface InlineFormulaSpan {
  token: string
  fallbackText: string
  displayRect: PageRect
  baselineY: number
  lineFontSize: number
}

export interface AnalyzedBlock {
  id: string
  pageNumber: number
  order: number
  kind: LayoutBlockKind
  columnIndex: number
  fontSize: number
  isBold: boolean
  bounds: PageRect
  displayBounds: PageRect
  sentences: AnalyzedSentence[]
  inlineFormulas?: InlineFormulaSpan[]
  translationSourceText?: string
  continuedFromPrevColumn?: boolean
  continuesToNextColumn?: boolean
  continuedSentenceId?: string
}

export interface PageLayoutResult {
  pageNumber: number
  naturalWidth: number
  naturalHeight: number
  columnCount: number
  bodyFontSize: number
  hasText: boolean
  blocks: AnalyzedBlock[]
  sentences: AnalyzedSentence[]
  filteredItems: FilteredLayoutItem[]
}

/** 正交主阅读角度（度），用于将未归正旋转页转入逻辑左上阅读坐标后再恢复真实几何。 */
type ReadingOrientation = 0 | 90 | -90 | 180

interface ProjectedTextItem {
  str: string
  em: number
  isBold: boolean
  fontName: string
  fontFamily: string
  orientation: ReadingOrientation
  displayRect: PageRect
  pdfRect: PageRect
  logicalRect: PageRect
  baseline: number
  vx: number
  vy: number
  ux: number
  uy: number
  ax: number
  ay: number
  vw: number
  vh: number
  displayScale: number
}

interface LineSpan {
  item: ProjectedTextItem
  startInLine: number
  endInLine: number
}

interface LineSegment {
  text: string
  spans: LineSpan[]
  em: number
  isBold: boolean
  fontFamily: string
  displayRect: PageRect
  pdfRect: PageRect
  logicalRect: PageRect
  logicalBaseline: number
  columnIndex: number
  /** 当同行右侧附着孤立公式编号如 (1) 时记录，仅供分类和合并使用。 */
  trailingEquationTag?: LineSegment
}

interface LayoutBand {
  kind: 'spanning' | 'columns'
  columnCount: number
  linesByColumn: Map<number, LineSegment[]>
}

interface LineContribution {
  line: LineSegment
  blockStart: number
  blockEnd: number
  lineTextLength: number
}

interface DraftBlock {
  kind: LayoutBlockKind
  columnIndex: number
  lines: LineSegment[]
  fontSize: number
  isBold: boolean
}

interface RawSentenceSlice {
  text: string
  startOffset: number
  endOffset: number
}

const CAPTION_RE = /^(?:Fig\.|Figure|Table|Tab\.|Algorithm|Scheme|Chart|图|表)\s*[A-Za-z0-9]+(?:[.\-]\d+)?(?:\s*[:.\-–—]|$)/i
const EQUATION_TAG_RE = /^\(\s*\d+(?:\.\d+)*(?:[a-z])?\s*\)$/i
const PAGE_NUMBER_RE =
  /^(?:[-–—]\s*)?(?:\d{1,4}|[ivxlcdm]{1,6})(?:\s*[-–—])?$|^(?:page|p\.?)\s*\d+(?:\s*(?:of|\/)\s*\d+)?$|^第\s*\d+\s*页(?:\s*\/\s*共\s*\d+\s*页)?$/i
const NUMBERED_HEADING_RE = /^(?:\d+(?:\.\d+)*\.?|[IVXLCDM]+\.|Appendix\s+[A-Z]\b|第[一二三四五六七八九十\d]+[章节条款])\s+\S/i
const SUBSECTION_HEADING_RE = /^\d+\.\d+(?:\.\d+)*\.?\s+\S/
const STANDARD_HEADING_RE =
  /^(?:abstract|introduction|background|related work|methods?|methodology|materials and methods|experimental|experiments?|results?|discussion|conclusions?|acknowledg?ments?|references|appendix|摘要|引言|绪论|相关工作|方法|实验|结果|讨论|结论|致谢|参考文献)\s*$/i
const LIST_ITEM_RE = /^(?:[•●▪◦‣–—-]\s+|\[\d+\]\s*|\(\d+\)\s+|\([a-zA-Z]\)\s+|\d+\)\s+|(?:\d+\.)\s+(?=[A-Za-z\u4e00-\u9fff]))/
const MATH_OP_RE = /[=<>±∓×÷∑∏∫∂∇√∞≈≠≤≥∈∉∀∃⊕⊗⊖⊙⊘∘→←↔⇒⇔↦∅∩∪⊂⊃⊆⊇∧∨¬⊥⊤‖λμσωαβγδεθπφψ︷︸⏞⏟^_{}]/g
const MATH_OP_TEST_RE = /[=<>±∓×÷∑∏∫∂∇√∞≈≠≤≥∈∉∀∃⊕⊗⊖⊙⊘∘→←↔⇒⇔↦∅∩∪⊂⊃⊆⊇∧∨¬⊥⊤‖λμσωαβγδεθπφψ︷︸⏞⏟^_{}]/
const MATH_FUNC_AND_GREEK_WORDS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'log', 'ln', 'exp', 'lim', 'limsup', 'liminf', 'min', 'max', 'argmin', 'argmax', 'sup', 'inf',
  'det', 'dim', 'ker', 'deg', 'mod', 'gcd', 'lcm', 'sgn', 'diag', 'span', 'var', 'cov', 'corr',
  'dom', 'iff', 'wrt', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi',
  'chi', 'psi', 'omega'
])
const CJK_CHAR_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
const SENTENCE_TERMINAL_RE = /[.?!。？！:：]["')\]\u201d\u2019]*$/
const PRESERVED_HYPHEN_PREFIXES = new Set([
  'self', 'non', 'pre', 'post', 'multi', 'cross', 'co', 're', 'sub', 'anti', 'inter', 'intra',
  'semi', 'meta', 'end', 'state', 'fine', 'zero', 'few', 'real', 'high', 'low', 'large', 'open',
  'two', 'three', 'four', 'well', 'long', 'short', 'full', 'half', 'mini', 'micro', 'macro',
  'over', 'under', 'out', 'in', 'up', 'down', 'counter', 'hyper', 'super', 'ultra', 'pseudo',
  'of', 'the', 'to', 'and', 'or', 'by', 'on'
])

const ABBREVIATIONS = new Set([
  'e.g.', 'i.e.', 'etc.', 'et al.', 'vs.', 'cf.', 'fig.', 'figs.', 'eq.', 'eqs.',
  'tab.', 'tabs.', 'sec.', 'secs.', 'ref.', 'refs.', 'vol.', 'no.', 'pp.', 'dr.',
  'prof.', 'mr.', 'mrs.', 'ms.', 'inc.', 'ltd.', 'u.s.', 'u.k.', 'ca.', 'approx.',
  'al.', 'resp.', 'ch.', 'chap.', 'proc.', 'conf.', 'dept.', 'univ.'
])

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function makeSentenceId(pageNumber: number, order: number, text: string, bounds: PageRect): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  const quantized = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`
  const hash = fnv1a32Hex(`${normalized}@${quantized}`)
  return `p${pageNumber}-s${String(order).padStart(3, '0')}-${hash}`
}

export function unionRects(rects: readonly PageRect[]): PageRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) continue
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  }
}

function quantizeAngle(radians: number): ReadingOrientation {
  const deg = ((radians * 180) / Math.PI + 360) % 360
  if (deg >= 45 && deg < 135) return 90
  if (deg >= 135 && deg < 225) return 180
  if (deg >= 225 && deg < 315) return -90
  return 0
}

function rotatePointToLogical(x: number, y: number, w: number, h: number, orientation: ReadingOrientation): { x: number; y: number } {
  if (orientation === 90) return { x: y, y: w - x }
  if (orientation === -90) return { x: h - y, y: x }
  if (orientation === 180) return { x: w - x, y: h - y }
  return { x, y }
}

function rectToLogical(rect: PageRect, natW: number, natH: number, orientation: ReadingOrientation): PageRect {
  if (orientation === 0) return { ...rect }
  const corners = [
    rotatePointToLogical(rect.x, rect.y, natW, natH, orientation),
    rotatePointToLogical(rect.x + rect.width, rect.y, natW, natH, orientation),
    rotatePointToLogical(rect.x, rect.y + rect.height, natW, natH, orientation),
    rotatePointToLogical(rect.x + rect.width, rect.y + rect.height, natW, natH, orientation)
  ]
  const minX = Math.min(...corners.map(c => c.x))
  const minY = Math.min(...corners.map(c => c.y))
  const maxX = Math.max(...corners.map(c => c.x))
  const maxY = Math.max(...corners.map(c => c.y))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function buildItemRectsFromSubAdvance(
  item: ProjectedTextItem,
  geometry: PageGeometry,
  sStart: number,
  sEnd: number
): { viewportRect: PageRect; displayRect: PageRect; pdfRect: PageRect } {
  const ascent = 0.85
  const descent = -0.2
  const xs: number[] = []
  const ys: number[] = []
  for (const s of [sStart, sEnd]) {
    for (const t of [descent, ascent]) {
      xs.push(item.vx + s * item.ux + t * item.vh * item.ax)
      ys.push(item.vy + s * item.uy + t * item.vh * item.ay)
    }
  }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  const viewportRect: PageRect = {
    x: minX,
    y: minY,
    width: Math.max(0.5, maxX - minX),
    height: Math.max(0.5, maxY - minY)
  }
  const displayRect = viewportToDisplayRect(viewportRect, item.displayScale)
  const pdfRect = viewportRectToPdf(geometry, viewportRect)
  return { viewportRect, displayRect, pdfRect }
}

function projectTextItems(
  textContent: PageTextContent,
  geometry: PageGeometry
): {
  items: ProjectedTextItem[]
  dominantOrientation: ReadingOrientation
  natWidth: number
  natHeight: number
  logicalWidth: number
  logicalHeight: number
} {
  const displayScale = displayScaleForViewport(geometry.viewport)
  if (!Number.isFinite(displayScale) || displayScale <= 0) {
    return { items: [], dominantOrientation: 0, natWidth: 0, natHeight: 0, logicalWidth: 0, logicalHeight: 0 }
  }
  const natWidth = geometry.viewport.width / displayScale
  const natHeight = geometry.viewport.height / displayScale
  const styles = textContent.styles ?? {}
  const projected: ProjectedTextItem[] = []
  const orientationWeights: Record<ReadingOrientation, number> = { 0: 0, 90: 0, '-90': 0, 180: 0 }

  for (const raw of textContent.items) {
    if (!('str' in raw) || typeof raw.str !== 'string') continue
    if (raw.str.trim().length === 0) continue

    const m = composeAffine(geometry.viewport.transform, raw.transform)
    const [va, vb, vc, vd, vx, vy] = m
    const baseLen = Math.hypot(va, vb)
    const ascLen = Math.hypot(vc, vd)
    if (!Number.isFinite(vx) || !Number.isFinite(vy) || baseLen <= 1e-6) continue

    const styleMeta = styles[raw.fontName]
    const verticalFont = Boolean(styleMeta?.vertical)
    const dirAngle = verticalFont ? Math.atan2(-vc, -vd) : Math.atan2(vb, va)
    const orientation = quantizeAngle(dirAngle)
    orientationWeights[orientation] += raw.str.trim().length

    const ux = va / baseLen
    const uy = vb / baseLen
    const vh = ascLen > 1e-6 ? ascLen : Math.max(baseLen, Math.abs((raw.height || 0) * displayScale))
    const ax = ascLen > 1e-6 ? vc / ascLen : -uy
    const ay = ascLen > 1e-6 ? vd / ascLen : ux

    const rawAdvance = (verticalFont ? raw.height : raw.width) * displayScale
    const vw = Number.isFinite(rawAdvance) && rawAdvance > 0
      ? rawAdvance
      : Math.max(baseLen * 0.52 * raw.str.length, vh * 0.4)
    const em = vh / displayScale
    if (!Number.isFinite(em) || em <= 0) continue

    const fontName = raw.fontName ?? ''
    const fontFamily = styleMeta?.fontFamily ?? ''
    const isBold = /bold|black|heavy|demi/i.test(`${fontName} ${fontFamily}`)

    const stubItem: ProjectedTextItem = {
      str: raw.str,
      em,
      isBold,
      fontName,
      fontFamily,
      orientation,
      displayRect: { x: 0, y: 0, width: 0, height: 0 },
      pdfRect: { x: 0, y: 0, width: 0, height: 0 },
      logicalRect: { x: 0, y: 0, width: 0, height: 0 },
      baseline: 0,
      vx,
      vy,
      ux,
      uy,
      ax,
      ay,
      vw,
      vh,
      displayScale
    }
    const { displayRect, pdfRect } = buildItemRectsFromSubAdvance(stubItem, geometry, 0, vw)
    stubItem.displayRect = displayRect
    stubItem.pdfRect = pdfRect
    projected.push(stubItem)
  }

  let dominantOrientation: ReadingOrientation = 0
  let bestWeight = -1
  for (const angle of [0, 90, -90, 180] as const) {
    if (orientationWeights[angle] > bestWeight) {
      bestWeight = orientationWeights[angle]
      dominantOrientation = angle
    }
  }

  const sideways = dominantOrientation === 90 || dominantOrientation === -90
  const logicalWidth = sideways ? natHeight : natWidth
  const logicalHeight = sideways ? natWidth : natHeight

  for (const item of projected) {
    item.logicalRect = rectToLogical(item.displayRect, natWidth, natHeight, dominantOrientation)
    const logicalOrigin = rotatePointToLogical(
      item.vx / displayScale,
      item.vy / displayScale,
      natWidth,
      natHeight,
      dominantOrientation
    )
    item.baseline = Number.isFinite(logicalOrigin.y) ? logicalOrigin.y : item.logicalRect.y + item.logicalRect.height * 0.82
  }

  return { items: projected, dominantOrientation, natWidth, natHeight, logicalWidth, logicalHeight }
}

function isMarginStamp(item: ProjectedTextItem, dominantOrientation: ReadingOrientation, logicalWidth: number): boolean {
  const orthogonal = Math.abs(((item.orientation - dominantOrientation + 540) % 360) - 180)
  // 若文本与页面主导阅读方向正交（近似 90°/270°），且窄窄贴在页面最左/最右 8% 边距内，判定为边栏印记
  const nearHorizontalEdge =
    item.logicalRect.x + item.logicalRect.width <= logicalWidth * 0.085 ||
    item.logicalRect.x >= logicalWidth * 0.915
  return Math.abs(orthogonal - 90) <= 5 && nearHorizontalEdge
}

function weightedMedian(values: Array<{ value: number; weight: number }>): number {
  if (values.length === 0) return 11
  const sorted = [...values].sort((a, b) => a.value - b.value)
  const totalWeight = sorted.reduce((sum, entry) => sum + entry.weight, 0)
  let acc = 0
  for (const entry of sorted) {
    acc += entry.weight
    if (acc >= totalWeight * 0.5) return entry.value
  }
  return sorted[sorted.length - 1].value
}

function shouldInsertSpaceBetween(leftText: string, rightText: string, gap: number, minEm: number): boolean {
  if (!leftText || !rightText) return false
  if (/\s$/.test(leftText) || /^\s/.test(rightText)) return false
  const leftLast = leftText[leftText.length - 1]
  const rightFirst = rightText[0]
  if (CJK_CHAR_RE.test(leftLast) && CJK_CHAR_RE.test(rightFirst)) {
    return gap > minEm * 0.45
  }
  return gap > Math.max(0.14 * minEm, 0.8)
}

function buildLineSegment(items: ProjectedTextItem[]): LineSegment {
  const sorted = [...items].sort((a, b) => a.logicalRect.x - b.logicalRect.x)
  let text = ''
  const spans: LineSpan[] = []
  let prevRight = sorted[0].logicalRect.x
  let prevEm = sorted[0].em

  for (let i = 0; i < sorted.length; i += 1) {
    const item = sorted[i]
    const cleanStr = item.str.replace(/^\s+|\s+$/g, '')
    if (!cleanStr) continue
    if (i > 0) {
      const gap = item.logicalRect.x - prevRight
      if (shouldInsertSpaceBetween(text, cleanStr, gap, Math.min(prevEm, item.em))) {
        text += ' '
      }
    }
    const startInLine = text.length
    text += cleanStr
    spans.push({ item, startInLine, endInLine: text.length })
    prevRight = Math.max(prevRight, item.logicalRect.x + item.logicalRect.width)
    prevEm = item.em
  }

  const weightEntries = sorted.map(it => ({ value: it.em, weight: Math.max(1, it.str.trim().length) }))
  const em = weightedMedian(weightEntries)
  const boldWeight = sorted.reduce((acc, it) => acc + (it.isBold ? it.str.trim().length : 0), 0)
  const totalWeight = sorted.reduce((acc, it) => acc + it.str.trim().length, 0)
  const baselineEntries = sorted.map(it => ({ value: it.baseline, weight: Math.max(1, it.str.trim().length) }))

  return {
    text,
    spans,
    em,
    isBold: totalWeight > 0 && boldWeight / totalWeight >= 0.6,
    fontFamily: sorted[0]?.fontFamily ?? '',
    displayRect: unionRects(sorted.map(it => it.displayRect)),
    pdfRect: unionRects(sorted.map(it => it.pdfRect)),
    logicalRect: unionRects(sorted.map(it => it.logicalRect)),
    logicalBaseline: weightedMedian(baselineEntries),
    columnIndex: 0
  }
}

function clusterIntoLineSegments(items: ProjectedTextItem[]): LineSegment[] {
  if (items.length === 0) return []
  // 先聚类正常字号行主体，再将上下标等小字号项优先吸附至水平邻近的宿主行，避免被他栏误抢
  const approxBodyEm = weightedMedian(
    items.map(it => ({ value: it.em, weight: Math.max(1, it.str.trim().length) }))
  )
  const ordered = [...items].sort((a, b) => a.baseline - b.baseline || a.logicalRect.x - b.logicalRect.x)
  const primaryItems = ordered.filter(it => it.em >= approxBodyEm * 0.85)
  const scriptItems = ordered.filter(it => it.em < approxBodyEm * 0.85)

  const rowClusters: Array<{
    baseline: number
    anchorEm: number
    maxEm: number
    minY: number
    maxY: number
    items: ProjectedTextItem[]
  }> = []

  const collidesHorizontallyAcrossRows = (
    rowAnchorEm: number,
    rowItems: readonly ProjectedTextItem[],
    candidate: ProjectedTextItem
  ): boolean => {
    if (candidate.em < rowAnchorEm * 0.85) return false
    return rowItems.some(existing => {
      if (existing.em < rowAnchorEm * 0.85) return false
      const minEm = Math.min(existing.em, candidate.em)
      const maxEm = Math.max(existing.em, candidate.em)
      if (minEm < maxEm * 0.82) return false
      const horizOverlap =
        Math.min(existing.logicalRect.x + existing.logicalRect.width, candidate.logicalRect.x + candidate.logicalRect.width) -
        Math.max(existing.logicalRect.x, candidate.logicalRect.x)
      return horizOverlap > 1.5 && Math.abs(candidate.baseline - existing.baseline) >= minEm * 0.45
    })
  }

  const rowMinHorizGap = (rowItems: readonly ProjectedTextItem[], candidate: ProjectedTextItem): number => {
    let minGap = Number.POSITIVE_INFINITY
    for (const existing of rowItems) {
      const gap = Math.max(
        0,
        existing.logicalRect.x - (candidate.logicalRect.x + candidate.logicalRect.width),
        candidate.logicalRect.x - (existing.logicalRect.x + existing.logicalRect.width)
      )
      if (gap < minGap) minGap = gap
    }
    return minGap
  }

  const appendToRow = (row: (typeof rowClusters)[number], item: ProjectedTextItem): void => {
    row.items.push(item)
    if (item.em > row.anchorEm * 1.15 && item.em <= row.anchorEm * 1.8) {
      row.anchorEm = item.em
      row.baseline = item.baseline
    } else if (item.em >= row.maxEm * 0.82) {
      const prevCount = row.items.length - 1
      row.baseline = (row.baseline * prevCount + item.baseline) / row.items.length
    }
    row.maxEm = Math.max(row.maxEm, item.em)
    row.minY = Math.min(row.minY, item.logicalRect.y)
    row.maxY = Math.max(row.maxY, item.logicalRect.y + item.logicalRect.height)
  }

  for (const item of primaryItems) {
    let matched: (typeof rowClusters)[number] | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (let i = rowClusters.length - 1; i >= Math.max(0, rowClusters.length - 12); i -= 1) {
      const row = rowClusters[i]
      const rawMaxEm = Math.max(row.anchorEm, item.em)
      const effectiveEm =
        rawMaxEm >= 13.5 ? Math.min(rawMaxEm, Math.min(row.anchorEm, item.em) * 1.35) : rawMaxEm
      const tol = Math.max(0.45 * effectiveEm, 2.5)
      const dist = Math.abs(item.baseline - row.baseline)
      if (dist <= tol && !collidesHorizontallyAcrossRows(row.anchorEm, row.items, item)) {
        const horizPenalty = rowMinHorizGap(row.items, item) > Math.max(2.5 * effectiveEm, 24) ? 2.5 : 0
        const score = dist + horizPenalty
        if (score < bestScore) {
          bestScore = score
          matched = row
        }
        continue
      }
      const vOverlap = Math.min(row.maxY, item.logicalRect.y + item.logicalRect.height) - Math.max(row.minY, item.logicalRect.y)
      if (
        vOverlap >= Math.min(row.maxEm, item.em) * 0.25 &&
        dist <= Math.max(row.anchorEm, item.em) * 0.85 &&
        !collidesHorizontallyAcrossRows(row.anchorEm, row.items, item)
      ) {
        const horizGap = rowMinHorizGap(row.items, item)
        if (horizGap <= Math.max(1.1 * Math.max(row.anchorEm, item.em), 8)) {
          const score = dist + 0.5
          if (score < bestScore) {
            bestScore = score
            matched = row
          }
        }
      }
    }
    if (matched) {
      appendToRow(matched, item)
    } else {
      rowClusters.push({
        baseline: item.baseline,
        anchorEm: item.em,
        maxEm: item.em,
        minY: item.logicalRect.y,
        maxY: item.logicalRect.y + item.logicalRect.height,
        items: [item]
      })
    }
  }

  for (const item of scriptItems) {
    let matched: (typeof rowClusters)[number] | null = null
    let bestScore = Number.POSITIVE_INFINITY

    for (const row of rowClusters) {
      const rawMaxEm = Math.max(row.anchorEm, item.em)
      const horizGap = rowMinHorizGap(row.items, item)
      const maxAdjGap = Math.max(1.25 * rawMaxEm, 10)
      const dist = Math.abs(item.baseline - row.baseline)
      if (horizGap <= maxAdjGap && dist <= rawMaxEm * 0.72 && !collidesHorizontallyAcrossRows(row.anchorEm, row.items, item)) {
        const score = dist + horizGap * 0.15
        if (score < bestScore) {
          bestScore = score
          matched = row
        }
      }
    }

    if (!matched) {
      for (const row of rowClusters) {
        const rawMaxEm = Math.max(row.anchorEm, item.em)
        const effectiveEm =
          rawMaxEm >= 13.5 ? Math.min(rawMaxEm, Math.min(row.anchorEm, item.em) * 1.35) : rawMaxEm
        const tol = Math.max(0.45 * effectiveEm, 2.5)
        const dist = Math.abs(item.baseline - row.baseline)
        if (dist <= tol && !collidesHorizontallyAcrossRows(row.anchorEm, row.items, item)) {
          const horizPenalty = rowMinHorizGap(row.items, item) > Math.max(2.5 * effectiveEm, 24) ? 2.5 : 0
          const score = dist + horizPenalty
          if (score < bestScore) {
            bestScore = score
            matched = row
          }
        }
      }
    }

    if (matched) {
      appendToRow(matched, item)
    } else {
      rowClusters.push({
        baseline: item.baseline,
        anchorEm: item.em,
        maxEm: item.em,
        minY: item.logicalRect.y,
        maxY: item.logicalRect.y + item.logicalRect.height,
        items: [item]
      })
    }
  }

  // 桥接同栏中与相邻行文字垂直交叠且水平紧邻的孤立浮沉算符簇（如 marginalization 与 to push 之间略偏上的 ⊕）
  for (let pass = 0; pass < 2; pass += 1) {
    let mergedAny = false
    for (let i = 0; i < rowClusters.length; i += 1) {
      const src = rowClusters[i]
      if (src.items.length === 0 || src.items.length > 3) continue
      const srcText = src.items.map(it => it.str.trim()).join('')
      if (!srcText || srcText.length > 4 || /[A-Za-z0-9]{2,}/.test(srcText) || !MATH_OP_TEST_RE.test(srcText)) {
        continue
      }
      const srcMinX = Math.min(...src.items.map(it => it.logicalRect.x))
      const srcMaxX = Math.max(...src.items.map(it => it.logicalRect.x + it.logicalRect.width))
      let bestTargetIdx = -1
      let bestDist = Number.POSITIVE_INFINITY
      for (let j = 0; j < rowClusters.length; j += 1) {
        if (i === j) continue
        const dst = rowClusters[j]
        if (dst.items.length === 0) continue
        const vOverlap = Math.min(src.maxY, dst.maxY) - Math.max(src.minY, dst.minY)
        if (vOverlap < Math.min(src.maxEm, dst.maxEm) * 0.2) continue
        const dist = Math.abs(src.baseline - dst.baseline)
        if (dist > Math.max(src.anchorEm, dst.anchorEm) * 0.85) continue
        const dstHasNearby = dst.items.some(existing => {
          const gap = Math.max(
            existing.logicalRect.x - srcMaxX,
            srcMinX - (existing.logicalRect.x + existing.logicalRect.width)
          )
          return gap <= Math.max(dst.anchorEm * 1.2, 12)
        })
        const dstCollides = src.items.some(srcIt => collidesHorizontallyAcrossRows(dst.anchorEm, dst.items, srcIt))
        if (dstHasNearby && !dstCollides && dist < bestDist) {
          bestDist = dist
          bestTargetIdx = j
        }
      }
      if (bestTargetIdx !== -1) {
        const target = rowClusters[bestTargetIdx]
        for (const it of src.items) target.items.push(it)
        target.maxEm = Math.max(target.maxEm, src.maxEm)
        target.minY = Math.min(target.minY, src.minY)
        target.maxY = Math.max(target.maxY, src.maxY)
        rowClusters.splice(i, 1)
        mergedAny = true
        break
      }
    }
    if (!mergedAny) break
  }

  // 每行内部按水平较大栏隙拆分为独立 LineSegment（用局部组字号阈值，避免同行另一栏的大号公式算符抬高阈值吞并栏隙）
  const segments: LineSegment[] = []
  for (const row of rowClusters) {
    const lineItems = [...row.items].sort((a, b) => a.logicalRect.x - b.logicalRect.x)
    let currentGroup: ProjectedTextItem[] = [lineItems[0]]
    let groupRight = lineItems[0].logicalRect.x + lineItems[0].logicalRect.width
    let groupEm = lineItems[0].em
    const rowSegments: LineSegment[] = []

    for (let i = 1; i < lineItems.length; i += 1) {
      const next = lineItems[i]
      const gap = next.logicalRect.x - groupRight
      const localSplitThreshold = Math.max(1.35 * Math.min(groupEm, next.em), 11.5)
      if (gap > localSplitThreshold) {
        const built = buildLineSegment(currentGroup)
        if (built.text.length > 0) rowSegments.push(built)
        currentGroup = [next]
        groupRight = next.logicalRect.x + next.logicalRect.width
        groupEm = next.em
      } else {
        currentGroup.push(next)
        groupRight = Math.max(groupRight, next.logicalRect.x + next.logicalRect.width)
        groupEm = Math.max(groupEm, next.em)
      }
    }
    const lastBuilt = buildLineSegment(currentGroup)
    if (lastBuilt.text.length > 0) rowSegments.push(lastBuilt)

    // 同行右侧紧随孤立公式编号 (1) / (2.1) 且左侧片段像公式时，先附挂以便整组判定为 formula（兼容双栏并行行）
    for (let k = 0; k < rowSegments.length; k += 1) {
      const seg = rowSegments[k]
      const nextSeg = rowSegments[k + 1]
      if (
        nextSeg &&
        EQUATION_TAG_RE.test(nextSeg.text.trim()) &&
        seg.text.length <= 120 &&
        !CAPTION_RE.test(seg.text) &&
        !NUMBERED_HEADING_RE.test(seg.text) &&
        (MATH_OP_TEST_RE.test(seg.text) || rowSegments.length === 2)
      ) {
        seg.trailingEquationTag = nextSeg
        segments.push(seg)
        k += 1
        continue
      }
      segments.push(seg)
    }
  }

  return segments.sort((a, b) => a.logicalBaseline - b.logicalBaseline || a.logicalRect.x - b.logicalRect.x)
}

function splitEquationTagIfNotFormula(lines: LineSegment[], bodyFontSize = 0): LineSegment[] {
  const expanded: LineSegment[] = []
  for (const line of lines) {
    if (line.trailingEquationTag && !looksLikeFormulaLine(line, bodyFontSize, true)) {
      const tag = line.trailingEquationTag
      line.trailingEquationTag = undefined
      expanded.push(line, tag)
    } else {
      expanded.push(line)
    }
  }
  return expanded.sort((a, b) => a.logicalBaseline - b.logicalBaseline || a.logicalRect.x - b.logicalRect.x)
}

function filterSinglePageEdgeItems(
  lines: LineSegment[],
  logicalHeight: number,
  bodyFontSize: number
): { bodyLines: LineSegment[]; filtered: FilteredLayoutItem[] } {
  if (lines.length === 0 || logicalHeight <= 0) {
    return { bodyLines: lines, filtered: [] }
  }
  const topBand = logicalHeight * 0.115
  const bottomBand = logicalHeight * 0.885
  const strictTop = logicalHeight * 0.085
  const strictBottom = logicalHeight * 0.915

  const innerLines = lines.filter(line => {
    const cy = line.logicalRect.y + line.logicalRect.height / 2
    return cy >= strictTop && cy <= strictBottom
  })
  const innerMinY = innerLines.length > 0 ? Math.min(...innerLines.map(l => l.logicalRect.y)) : strictTop
  const innerMaxY =
    innerLines.length > 0 ? Math.max(...innerLines.map(l => l.logicalRect.y + l.logicalRect.height)) : strictBottom

  const bodyLines: LineSegment[] = []
  const filtered: FilteredLayoutItem[] = []

  for (const line of lines) {
    const trimmed = line.text.trim()
    const cy = line.logicalRect.y + line.logicalRect.height / 2
    const inTopMargin = cy < topBand
    const inBottomMargin = cy > bottomBand
    const protectedHeading = line.em >= bodyFontSize * 1.15 || CAPTION_RE.test(trimmed) || NUMBERED_HEADING_RE.test(trimmed)

    if ((inTopMargin || inBottomMargin) && PAGE_NUMBER_RE.test(trimmed) && line.em <= bodyFontSize * 1.08) {
      filtered.push({ text: trimmed, reason: 'page-number', displayRect: line.displayRect, pdfRect: line.pdfRect })
      continue
    }

    if (!protectedHeading && cy < strictTop) {
      const gapBelow = innerMinY - (line.logicalRect.y + line.logicalRect.height)
      if (gapBelow >= bodyFontSize * 1.35 && line.em <= bodyFontSize * 1.02 && trimmed.length <= 100) {
        filtered.push({ text: trimmed, reason: 'header', displayRect: line.displayRect, pdfRect: line.pdfRect })
        continue
      }
    }

    if (!protectedHeading && cy > strictBottom) {
      const gapAbove = line.logicalRect.y - innerMaxY
      if (gapAbove >= bodyFontSize * 1.35 && line.em <= bodyFontSize * 1.02 && trimmed.length <= 100) {
        filtered.push({ text: trimmed, reason: 'footer', displayRect: line.displayRect, pdfRect: line.pdfRect })
        continue
      }
    }

    bodyLines.push(line)
  }

  return { bodyLines, filtered }
}

interface GutterCandidate {
  splitX: number
  gutterLeft: number
  gutterRight: number
  gutterWidth: number
  leftCount: number
  rightCount: number
}

function findBestColumnGutter(lines: readonly LineSegment[], bodyFontSize: number): GutterCandidate | null {
  if (lines.length < 4) return null
  const minX = Math.min(...lines.map(l => l.logicalRect.x))
  const maxX = Math.max(...lines.map(l => l.logicalRect.x + l.logicalRect.width))
  const span = maxX - minX
  if (span < Math.max(120, bodyFontSize * 10)) return null

  // 剔除明显跨栏宽行（例如跨双栏标题/全宽摘要/全宽表格）后再探测栏隙
  const narrowLines = lines.filter(l => l.logicalRect.width <= span * 0.56)
  if (narrowLines.length < 4) return null

  const minGutterWidth = Math.max(9, bodyFontSize * 0.85)
  const searchStart = minX + span * 0.2
  const searchEnd = maxX - span * 0.2

  // 收集窄行左右边界作为扫描分隔探测点
  const boundaries = new Set<number>()
  for (const line of narrowLines) {
    boundaries.add(line.logicalRect.x)
    boundaries.add(line.logicalRect.x + line.logicalRect.width)
  }
  const sortedX = [...boundaries].sort((a, b) => a - b)

  let best: GutterCandidate | null = null
  for (let i = 0; i < sortedX.length - 1; i += 1) {
    const a = sortedX[i]
    const b = sortedX[i + 1]
    const gap = b - a
    if (gap < minGutterWidth) continue
    const mid = (a + b) / 2
    if (mid < searchStart || mid > searchEnd) continue

    const leftLines: LineSegment[] = []
    const rightLines: LineSegment[] = []
    let crossing = 0
    for (const line of narrowLines) {
      const r = line.logicalRect
      if (r.x + r.width <= mid + 2) leftLines.push(line)
      else if (r.x >= mid - 2) rightLines.push(line)
      else crossing += 1
    }
    if (crossing > Math.floor(narrowLines.length * 0.1)) continue
    if (leftLines.length < 2 || rightLines.length < 2) continue

    const minShare = Math.max(2, narrowLines.length * 0.16)
    if (leftLines.length < minShare || rightLines.length < minShare) continue

    // 确认左右两栏在纵坐标上确有重叠区间（真正并排的多栏而非上下错落的短行）
    const leftTop = Math.min(...leftLines.map(l => l.logicalRect.y))
    const leftBottom = Math.max(...leftLines.map(l => l.logicalRect.y + l.logicalRect.height))
    const rightTop = Math.min(...rightLines.map(l => l.logicalRect.y))
    const rightBottom = Math.max(...rightLines.map(l => l.logicalRect.y + l.logicalRect.height))
    const overlapY = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop)
    if (overlapY <= bodyFontSize * 0.8) continue

    const score = gap * Math.min(leftLines.length, rightLines.length)
    const bestScore = best ? best.gutterWidth * Math.min(best.leftCount, best.rightCount) : -1
    if (score > bestScore) {
      best = {
        splitX: mid,
        gutterLeft: a,
        gutterRight: b,
        gutterWidth: gap,
        leftCount: leftLines.length,
        rightCount: rightLines.length
      }
    }
  }

  return best
}

/**
 * 极窄栏隙兜底探测：当双栏排版齐行后的实际栏隙仅 8–12pt，致使初轮合并把多行 L+R 粘进同一 LineSegment 时，
 * 直接基于词元/Span 之间的水平间隙分布反推全局对齐的垂直栏隙。
 */
function findBestGutterFromItemSpans(lines: readonly LineSegment[], bodyFontSize: number): GutterCandidate | null {
  if (lines.length < 4) return null
  const minX = Math.min(...lines.map(l => l.logicalRect.x))
  const maxX = Math.max(...lines.map(l => l.logicalRect.x + l.logicalRect.width))
  const span = maxX - minX
  if (span < Math.max(120, bodyFontSize * 10)) return null

  const minGutterWidth = Math.max(bodyFontSize * 0.8, 7.5)
  const searchStart = minX + span * 0.2
  const searchEnd = maxX - span * 0.2

  const candidateMidpoints: number[] = []
  for (const line of lines) {
    if (line.spans.length < 2) continue
    for (let i = 0; i < line.spans.length - 1; i += 1) {
      const a = line.spans[i].item.logicalRect.x + line.spans[i].item.logicalRect.width
      const b = line.spans[i + 1].item.logicalRect.x
      if (b - a < minGutterWidth) continue
      const mid = (a + b) / 2
      if (mid >= searchStart && mid <= searchEnd) {
        candidateMidpoints.push(mid)
      }
    }
  }
  if (candidateMidpoints.length === 0) return null

  const sortedMids = [...candidateMidpoints].sort((a, b) => a - b)
  const uniqueMids: number[] = []
  for (const mid of sortedMids) {
    if (uniqueMids.length === 0 || mid - uniqueMids[uniqueMids.length - 1] >= 3) {
      uniqueMids.push(mid)
    }
  }

  let best: GutterCandidate | null = null
  for (const mid of uniqueMids) {
    let leftCount = 0
    let rightCount = 0
    let evaluatedRows = 0
    let crossingRows = 0
    let leftTop = Number.POSITIVE_INFINITY
    let leftBottom = Number.NEGATIVE_INFINITY
    let rightTop = Number.POSITIVE_INFINITY
    let rightBottom = Number.NEGATIVE_INFINITY
    const splitPairs: Array<{ leftRight: number; rightLeft: number; gap: number }> = []

    for (const line of lines) {
      if (line.em >= bodyFontSize * 1.15) continue
      evaluatedRows += 1

      const hasCrossingItem = line.spans.some(s => {
        const ir = s.item.logicalRect
        return ir.x < mid - 3 && ir.x + ir.width > mid + 3
      })
      if (hasCrossingItem) {
        crossingRows += 1
        continue
      }

      const leftItems: ProjectedTextItem[] = []
      const rightItems: ProjectedTextItem[] = []
      for (const s of line.spans) {
        const cx = s.item.logicalRect.x + s.item.logicalRect.width / 2
        if (cx < mid) leftItems.push(s.item)
        else rightItems.push(s.item)
      }

      if (leftItems.length > 0 && rightItems.length === 0) {
        leftCount += 1
        leftTop = Math.min(leftTop, line.logicalRect.y)
        leftBottom = Math.max(leftBottom, line.logicalRect.y + line.logicalRect.height)
      } else if (rightItems.length > 0 && leftItems.length === 0) {
        rightCount += 1
        rightTop = Math.min(rightTop, line.logicalRect.y)
        rightBottom = Math.max(rightBottom, line.logicalRect.y + line.logicalRect.height)
      } else if (leftItems.length > 0 && rightItems.length > 0) {
        const leftRight = Math.max(...leftItems.map(it => it.logicalRect.x + it.logicalRect.width))
        const rightLeft = Math.min(...rightItems.map(it => it.logicalRect.x))
        const gap = rightLeft - leftRight
        if (gap >= minGutterWidth) {
          leftCount += 1
          rightCount += 1
          leftTop = Math.min(leftTop, line.logicalRect.y)
          leftBottom = Math.max(leftBottom, line.logicalRect.y + line.logicalRect.height)
          rightTop = Math.min(rightTop, line.logicalRect.y)
          rightBottom = Math.max(rightBottom, line.logicalRect.y + line.logicalRect.height)
          splitPairs.push({ leftRight, rightLeft, gap })
        } else {
          crossingRows += 1
        }
      }
    }

    if (evaluatedRows < 4 || leftCount < 2 || rightCount < 2 || splitPairs.length === 0) continue
    const minShare = Math.max(2, evaluatedRows * 0.16)
    if (leftCount < minShare || rightCount < minShare) continue
    if (crossingRows > Math.floor(evaluatedRows * 0.12)) continue

    const overlapY = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop)
    if (overlapY <= bodyFontSize * 0.8) continue

    const sortedPairs = [...splitPairs].sort((p, q) => p.gap - q.gap)
    const refPair = sortedPairs[Math.min(sortedPairs.length - 1, Math.floor(sortedPairs.length * 0.25))]
    const gutterWidth = refPair.gap
    const score = gutterWidth * Math.min(leftCount, rightCount)
    const bestScore = best ? best.gutterWidth * Math.min(best.leftCount, best.rightCount) : -1
    if (score > bestScore) {
      best = {
        splitX: (refPair.leftRight + refPair.rightLeft) / 2,
        gutterLeft: refPair.leftRight,
        gutterRight: refPair.rightLeft,
        gutterWidth,
        leftCount,
        rightCount
      }
    }
  }

  return best
}

function detectColumnGutters(lines: readonly LineSegment[], bodyFontSize: number): GutterCandidate[] {
  const firstSplit = findBestColumnGutter(lines, bodyFontSize) ?? findBestGutterFromItemSpans(lines, bodyFontSize)
  if (!firstSplit) return []

  const gutters = [firstSplit]
  const leftSubset = lines.filter(l => l.logicalRect.x + l.logicalRect.width <= firstSplit.splitX + 2)
  const rightSubset = lines.filter(l => l.logicalRect.x >= firstSplit.splitX - 2)

  // 最多支持 3 栏检测（在左右任意一侧若宽度仍够且出现清晰副栏隙，可继续细分）
  const leftSecond = findBestColumnGutter(leftSubset, bodyFontSize) ?? findBestGutterFromItemSpans(leftSubset, bodyFontSize)
  if (leftSecond && Math.abs(leftSecond.splitX - firstSplit.splitX) >= Math.max(80, bodyFontSize * 6)) {
    gutters.push(leftSecond)
  } else {
    const rightSecond =
      findBestColumnGutter(rightSubset, bodyFontSize) ?? findBestGutterFromItemSpans(rightSubset, bodyFontSize)
    if (rightSecond && Math.abs(rightSecond.splitX - firstSplit.splitX) >= Math.max(80, bodyFontSize * 6)) {
      gutters.push(rightSecond)
    }
  }

  return gutters.sort((a, b) => a.splitX - b.splitX)
}

/**
 * 若整页检测出全局栏隙，将误跨栏粘连在同一视觉行上的多栏文本按真实栏隙拆回各自栏内的独立 LineSegment；
 * 真正横跨栏隙的大标题/通栏正文（其跨越栏隙处的词间距仅常规词距且可能单串跨越）保留不拆。
 */
function splitLinesAtColumnGutters(lines: LineSegment[], gutters: readonly GutterCandidate[]): LineSegment[] {
  if (gutters.length === 0 || lines.length === 0) return lines
  const sortedGutters = [...gutters].sort((a, b) => a.splitX - b.splitX)
  const result: LineSegment[] = []

  const splitRecursive = (line: LineSegment, gutterIdx: number): void => {
    if (gutterIdx >= sortedGutters.length) {
      result.push(line)
      return
    }
    const g = sortedGutters[gutterIdx]
    const crossesGutter = line.logicalRect.x < g.splitX && line.logicalRect.x + line.logicalRect.width > g.splitX
    if (!crossesGutter || line.spans.length < 2) {
      splitRecursive(line, gutterIdx + 1)
      return
    }

    const hasCrossingItem = line.spans.some(s => {
      const r = s.item.logicalRect
      return r.x < g.gutterLeft - 1 && r.x + r.width > g.gutterRight + 1
    })
    if (hasCrossingItem) {
      splitRecursive(line, gutterIdx + 1)
      return
    }

    const leftItems: ProjectedTextItem[] = []
    const rightItems: ProjectedTextItem[] = []
    for (const s of line.spans) {
      const cx = s.item.logicalRect.x + s.item.logicalRect.width / 2
      if (cx < g.splitX) leftItems.push(s.item)
      else rightItems.push(s.item)
    }
    if (leftItems.length === 0 || rightItems.length === 0) {
      splitRecursive(line, gutterIdx + 1)
      return
    }

    const leftMaxRight = Math.max(...leftItems.map(it => it.logicalRect.x + it.logicalRect.width))
    const rightMinX = Math.min(...rightItems.map(it => it.logicalRect.x))
    const actualGap = rightMinX - leftMaxRight
    const minGap = Math.max(0.75 * line.em, g.gutterWidth * 0.55, 6.5)

    if (actualGap < minGap) {
      splitRecursive(line, gutterIdx + 1)
      return
    }

    const leftSeg = buildLineSegment(leftItems)
    const rightSeg = buildLineSegment(rightItems)
    if (line.trailingEquationTag) rightSeg.trailingEquationTag = line.trailingEquationTag
    if (leftSeg.text.length > 0) result.push(leftSeg)
    if (rightSeg.text.length > 0) splitRecursive(rightSeg, gutterIdx + 1)
  }

  for (const line of lines) {
    splitRecursive(line, 0)
  }

  return result.sort((a, b) => a.logicalBaseline - b.logicalBaseline || a.logicalRect.x - b.logicalRect.x)
}

function isSpanningLine(line: LineSegment, splits: readonly number[], bodyFontSize: number): boolean {
  const margin = Math.max(bodyFontSize * 1.4, 12)
  for (const splitX of splits) {
    if (line.logicalRect.x < splitX - margin && line.logicalRect.x + line.logicalRect.width > splitX + margin) {
      return true
    }
  }
  return false
}

function assignColumnIndex(line: LineSegment, splits: readonly number[]): number {
  const cx = line.logicalRect.x + line.logicalRect.width / 2
  for (let i = 0; i < splits.length; i += 1) {
    if (cx < splits[i]) return i + 1
  }
  return splits.length + 1
}

function buildReadingBands(lines: LineSegment[], splits: readonly number[], bodyFontSize: number): { bands: LayoutBand[]; columnCount: number } {
  if (lines.length === 0) return { bands: [], columnCount: 0 }
  if (splits.length === 0) {
    for (const line of lines) line.columnIndex = 0
    const map = new Map<number, LineSegment[]>([[0, lines]])
    return { bands: [{ kind: 'columns', columnCount: 1, linesByColumn: map }], columnCount: 1 }
  }

  const totalColumns = splits.length + 1
  const ordered = [...lines].sort((a, b) => a.logicalBaseline - b.logicalBaseline || a.logicalRect.x - b.logicalRect.x)
  const bands: LayoutBand[] = []
  let activeColumnBand: LayoutBand | null = null

  const flushColumnBand = (): void => {
    if (!activeColumnBand) return
    for (const colLines of activeColumnBand.linesByColumn.values()) {
      colLines.sort((a, b) => a.logicalBaseline - b.logicalBaseline || a.logicalRect.x - b.logicalRect.x)
    }
    bands.push(activeColumnBand)
    activeColumnBand = null
  }

  for (const line of ordered) {
    if (isSpanningLine(line, splits, bodyFontSize)) {
      flushColumnBand()
      line.columnIndex = 0
      bands.push({
        kind: 'spanning',
        columnCount: totalColumns,
        linesByColumn: new Map([[0, [line]]])
      })
    } else {
      const col = assignColumnIndex(line, splits)
      line.columnIndex = col
      if (!activeColumnBand) {
        activeColumnBand = { kind: 'columns', columnCount: totalColumns, linesByColumn: new Map() }
      }
      const list = activeColumnBand.linesByColumn.get(col)
      if (list) list.push(line)
      else activeColumnBand.linesByColumn.set(col, [line])
    }
  }
  flushColumnBand()

  return { bands, columnCount: totalColumns }
}

function stripControlCharsAndWhitespace(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code <= 32 || code === 127) continue
    out += text[i]
  }
  return out
}

function countProseWords(text: string): { total: number; long: number } {
  let total = 0
  let long = 0

  const cjkRuns = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g) ?? []
  total += cjkRuns.length
  long += cjkRuns.length

  const adjMarkerRe = /[0-9_^@α-ωΑ-Ωδλμσωθπφψ]/
  for (const match of text.matchAll(/[A-Za-z]+/g)) {
    const token = match[0]
    if (token.length < 2) continue
    if (!/[a-z]/.test(token)) continue
    const start = match.index ?? 0
    const end = start + token.length
    const prevChar = start > 0 ? text[start - 1] : ''
    const nextChar = end < text.length ? text[end] : ''
    if ((prevChar && adjMarkerRe.test(prevChar)) || (nextChar && adjMarkerRe.test(nextChar))) continue
    if (MATH_FUNC_AND_GREEK_WORDS.has(token.toLowerCase())) continue
    total += 1
    if (token.length >= 4) long += 1
  }

  return { total, long }
}

function looksLikeFormulaLine(
  line: LineSegment,
  bodyFontSize = 0,
  hasEquationTag = Boolean(line.trailingEquationTag)
): boolean {
  if (hasEquationTag) {
    // 有 (1) 编号的行只要包含数学运算符或短表达式即判定公式
    const text = line.text.trim()
    if (MATH_OP_TEST_RE.test(text) || text.length <= 60) {
      return true
    }
  }
  const text = line.text.trim()
  if (!text) return false
  if (CAPTION_RE.test(text) || LIST_ITEM_RE.test(text) || NUMBERED_HEADING_RE.test(text)) return false

  const prose = countProseWords(text)
  // 含明显自然语言词句的行（如夹杂行内符号的定义/引理叙述句）不视作纯公式行
  if (!hasEquationTag && (prose.total >= 3 || (prose.total >= 2 && prose.long >= 1))) {
    return false
  }

  if (prose.total === 0) {
    const visible = stripControlCharsAndWhitespace(text)
    if (!visible || !/[A-Za-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(visible)) {
      return true
    }
    if (text.length <= 90 && (MATH_OP_TEST_RE.test(text) || /@[A-Z]\b/.test(text))) {
      return true
    }
    if (
      bodyFontSize > 0 &&
      line.em <= bodyFontSize * 0.8 &&
      text.length <= 6 &&
      /^[A-Z0-9\s,()[\]'.-]+$/.test(text) &&
      /[A-Z]/.test(text)
    ) {
      return true
    }
  }

  const ops = text.match(MATH_OP_RE) ?? []
  const opCount = ops.length
  const longWords = (text.match(/[A-Za-z]{4,}/g) ?? []).length
  if (opCount >= 2 && longWords <= 2 && text.length <= 90) return true
  if (opCount >= 3 && opCount * 6 >= text.length && longWords <= 4) return true
  if (/^[a-zA-Z0-9\s()[\],.+\-*/=<>^_|\\]{3,55}$/.test(text) && opCount >= 1 && longWords <= 1) return true
  return false
}

function looksLikeHeadingLine(line: LineSegment, bodyFontSize: number): boolean {
  const text = line.text.trim()
  if (!text || CAPTION_RE.test(text) || looksLikeFormulaLine(line, bodyFontSize)) return false
  if (!/[A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false
  if (/^(?:[•●▪◦‣–—-]\s+|\[\d+\]\s*|\(\d+\)\s+|\([a-zA-Z]\)\s+)/.test(text)) return false
  if (line.em >= bodyFontSize * 1.12 && text.length <= 160 && !/[.?!。？！]$/.test(text)) return true
  if (
    (SUBSECTION_HEADING_RE.test(text) || (NUMBERED_HEADING_RE.test(text) && line.em >= bodyFontSize * 1.05)) &&
    text.length <= 120 &&
    !/[.?!。？！,;]$/.test(text) &&
    line.em >= bodyFontSize * 0.98
  ) {
    return true
  }
  if (line.isBold && text.length <= 120) {
    if (NUMBERED_HEADING_RE.test(text) || STANDARD_HEADING_RE.test(text)) return true
    if (!/[.?!。？！]$/.test(text) && text.split(/\s+/).length <= 14) return true
  }
  if (STANDARD_HEADING_RE.test(text) && line.em >= bodyFontSize * 0.98) return true
  return false
}

function groupLinesIntoBlocks(lines: readonly LineSegment[], columnIndex: number, bodyFontSize: number): DraftBlock[] {
  if (lines.length === 0) return []
  const lineGaps: number[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const g = lines[i].logicalBaseline - lines[i - 1].logicalBaseline
    if (g > 0 && g < bodyFontSize * 2.5) lineGaps.push(g)
  }
  const typicalStep = lineGaps.length > 0
    ? weightedMedian(lineGaps.map(v => ({ value: v, weight: 1 })))
    : bodyFontSize * 1.3

  const colLeft = Math.min(...lines.map(l => l.logicalRect.x))
  const colRight = Math.max(...lines.map(l => l.logicalRect.x + l.logicalRect.width))
  const colWidth = Math.max(1, colRight - colLeft)

  const blocks: DraftBlock[] = []
  let currentLines: LineSegment[] = [lines[0]]

  const classifyGroup = (group: LineSegment[]): LayoutBlockKind => {
    const firstText = group[0].text.trim()
    if (CAPTION_RE.test(firstText)) return 'caption'
    if (group.every(l => looksLikeFormulaLine(l, bodyFontSize))) return 'formula'
    if (group.length <= 3 && group.every(l => looksLikeHeadingLine(l, bodyFontSize))) return 'heading'
    if (LIST_ITEM_RE.test(firstText)) return 'list-item'
    return 'paragraph'
  }

  const flush = (): void => {
    if (currentLines.length === 0) return
    const kind = classifyGroup(currentLines)
    const fontSize = weightedMedian(currentLines.map(l => ({ value: l.em, weight: Math.max(1, l.text.length) })))
    const boldCount = currentLines.filter(l => l.isBold).length
    blocks.push({
      kind,
      columnIndex,
      lines: currentLines,
      fontSize,
      isBold: boldCount * 2 >= currentLines.length
    })
    currentLines = []
  }

  for (let i = 1; i < lines.length; i += 1) {
    const prev = currentLines[currentLines.length - 1]
    const next = lines[i]
    const nextTrimmed = next.text.trim()
    const step = next.logicalBaseline - prev.logicalBaseline
    const prevKindHint = classifyGroup(currentLines)
    const nextIsFormula = looksLikeFormulaLine(next, bodyFontSize)
    const nextIsHeading = looksLikeHeadingLine(next, bodyFontSize)
    const nextIsCaption = CAPTION_RE.test(nextTrimmed)
    const nextStartsInlineCitation = /^\[\d+(?:\s*[-–—,]\s*\d+)*\][.,;:]/.test(nextTrimmed)
    const nextIsList =
      LIST_ITEM_RE.test(nextTrimmed) &&
      !(nextStartsInlineCitation && prevKindHint === 'paragraph' && !SENTENCE_TERMINAL_RE.test(prev.text.trim()))

    const fontJump = Math.abs(next.em - prev.em) >= Math.max(prev.em, next.em) * 0.16
    const largeVerticalGap = step > Math.max(typicalStep * 1.38, Math.max(prev.em, next.em) * 1.72)
    const boldSwitch = prev.isBold !== next.isBold && (prevKindHint === 'heading' || nextIsHeading)
    const indentedStart =
      prevKindHint === 'paragraph' &&
      next.logicalRect.x - colLeft >= bodyFontSize * 0.85 &&
      (prev.logicalRect.x + prev.logicalRect.width < colRight - colWidth * 0.16 || SENTENCE_TERMINAL_RE.test(prev.text.trim()))
    const shortLineBreak =
      prevKindHint === 'paragraph' &&
      prev.logicalRect.width < colWidth * 0.72 &&
      SENTENCE_TERMINAL_RE.test(prev.text.trim()) &&
      !nextIsFormula &&
      /^[A-Z\u4e00-\u9fff0-9"(\[]/.test(nextTrimmed)

    const prevIsHeading = prevKindHint === 'heading'
    const nextStartsDistinctHeading =
      nextIsHeading &&
      (NUMBERED_HEADING_RE.test(nextTrimmed) ||
        STANDARD_HEADING_RE.test(nextTrimmed) ||
        (prevIsHeading && Math.abs(next.em - prev.em) >= Math.max(prev.em, next.em) * 0.1))

    const shouldBreak =
      fontJump ||
      largeVerticalGap ||
      boldSwitch ||
      nextIsCaption ||
      (nextIsList && !nextIsHeading) ||
      nextIsFormula !== (prevKindHint === 'formula') ||
      nextIsHeading !== prevIsHeading ||
      nextStartsDistinctHeading ||
      indentedStart ||
      shortLineBreak

    if (shouldBreak) flush()
    currentLines.push(next)
  }
  flush()

  return blocks
}

function shouldKeepTrailingHyphen(lineTextBeforeHyphen: string): boolean {
  const match = lineTextBeforeHyphen.match(/([A-Za-z-]+)$/)
  if (!match) return false
  const tail = match[1].toLowerCase()
  if (tail.includes('-')) {
    const parts = tail.split('-').filter(Boolean)
    const lastPart = parts[parts.length - 1] ?? ''
    return PRESERVED_HYPHEN_PREFIXES.has(lastPart) || parts.length >= 2
  }
  return PRESERVED_HYPHEN_PREFIXES.has(tail)
}

function assembleLinesText(lines: readonly LineSegment[]): { text: string; contributions: LineContribution[] } {
  let text = ''
  const contributions: LineContribution[] = []
  let suppressNextJoinSpace = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    let lineText = line.text.trim()

    if (i > 0 && text.length > 0 && !suppressNextJoinSpace) {
      const prevChar = text[text.length - 1]
      const nextChar = lineText[0] ?? ''
      if (!(CJK_CHAR_RE.test(prevChar) && CJK_CHAR_RE.test(nextChar))) {
        text += ' '
      }
    }
    suppressNextJoinSpace = false

    if (i < lines.length - 1) {
      const nextText = lines[i + 1].text.trim()
      const hyphenMatch = lineText.match(/^(.*[A-Za-z])([-\u00AD\u2010])$/)
      if (hyphenMatch && /^[a-z]/.test(nextText)) {
        const stem = hyphenMatch[1]
        if (hyphenMatch[2] === '-' && shouldKeepTrailingHyphen(stem)) {
          lineText = `${stem}-`
        } else {
          lineText = stem
        }
        suppressNextJoinSpace = true
      }
    }

    const blockStart = text.length
    text += lineText
    const blockEnd = text.length
    contributions.push({ line, blockStart, blockEnd, lineTextLength: line.text.length })
  }

  return { text, contributions }
}

function isProtectedPeriod(text: string, dotIndex: number): boolean {
  const before = text.slice(Math.max(0, dotIndex - 20), dotIndex + 1)
  const lowerBefore = before.toLowerCase()

  // 1. 常见学术缩写
  for (const abbr of ABBREVIATIONS) {
    if (lowerBefore.endsWith(abbr)) {
      const boundaryIdx = lowerBefore.length - abbr.length - 1
      if (boundaryIdx < 0 || !/[a-z0-9]/.test(lowerBefore[boundaryIdx])) return true
    }
  }

  // 2. 小数/版本号/节号（点前后都是数字，如 3.14, 1.2.3, v0.1.0）
  const prevChar = text[dotIndex - 1] ?? ''
  const nextChar = text[dotIndex + 1] ?? ''
  if (/\d/.test(prevChar) && /\d/.test(nextChar)) return true

  // 3. 省略号 ...
  if (prevChar === '.' || nextChar === '.') return true

  // 4. 姓名首字母或单字母简称，如 "J. Smith" 或 "A. B."
  if (/^[A-Z]$/.test(prevChar) && (dotIndex - 2 < 0 || /[\s(\[]/.test(text[dotIndex - 2]))) {
    if (/^\s+[A-Z]/.test(text.slice(dotIndex + 1))) return true
  }

  // 5. 多段缩写如 U.S.A. / e.g. / i.e. 中间点号，紧接非空白字母
  if (/[A-Za-z]/.test(prevChar) && /[A-Za-z0-9]/.test(nextChar)) return true

  // 6. Fig. 1 / Eq. (2) / Tab. II / Sec. 3 等后接编号
  if (/(?:^|[\s(\[])(?:fig|figs|eq|eqs|tab|tabs|sec|secs|ref|refs|vol|no|nos|pp|art|ch)\.$/.test(lowerBefore)) {
    if (/^\s*(?:\(?\d+|[IVXLCDM]+\b)/.test(text.slice(dotIndex + 1))) return true
  }

  // 7. 段首或列表项开头的序号（如 "1. Item" 或 "II. Background"）
  if (/^\s*(?:\d+(?:\.\d+)*|[IVXLCDM]+|[A-Za-z])\.$/.test(text.slice(0, dotIndex + 1))) {
    return true
  }

  return false
}

function splitAcademicSentences(text: string): RawSentenceSlice[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const leadingOffset = text.indexOf(trimmed)
  const slices: RawSentenceSlice[] = []
  let start = leadingOffset
  const endLimit = leadingOffset + trimmed.length

  const pushSlice = (rawEnd: number): void => {
    const sliceRaw = text.slice(start, rawEnd)
    const trimLeft = sliceRaw.search(/\S/)
    if (trimLeft === -1) {
      start = rawEnd
      return
    }
    const trimRight = sliceRaw.trimEnd().length
    const absStart = start + trimLeft
    const absEnd = start + trimRight
    slices.push({
      text: text.slice(absStart, absEnd),
      startOffset: absStart,
      endOffset: absEnd
    })
    start = rawEnd
  }

  for (let i = start; i < endLimit; i += 1) {
    const ch = text[i]
    if (ch === '。' || ch === '？' || ch === '！') {
      let closePos = i + 1
      while (closePos < endLimit && /[”’"')\]\u201d\u2019]/.test(text[closePos])) {
        closePos += 1
      }
      pushSlice(closePos)
      i = closePos - 1
      continue
    }

    if (ch === '.' || ch === '?' || ch === '!') {
      if (ch === '.' && isProtectedPeriod(text, i)) continue
      let closePos = i + 1
      // 允许句末标点紧跟引号、括号及引用方括号如 "[1]" 或 "[1, 2]"
      while (closePos < endLimit) {
        if (/^["')\u201d\u2019]/.test(text[closePos])) {
          closePos += 1
        } else if (text[closePos] === '[') {
          const refClose = text.indexOf(']', closePos)
          if (refClose !== -1 && refClose - closePos <= 16) {
            closePos = refClose + 1
          } else {
            break
          }
        } else {
          break
        }
      }
      if (closePos >= endLimit) break
      const after = text.slice(closePos)
      const nextTokenMatch = after.match(/^\s+([A-Za-z0-9\u4e00-\u9fff"'\u201c\u2018(\[])/)
      const nextImmediatelyCjk = CJK_CHAR_RE.test(text[closePos])
      if (nextTokenMatch || nextImmediatelyCjk) {
        const leadChar = nextTokenMatch ? nextTokenMatch[1] : text[closePos]
        // 若后面紧跟明显小写词，只在问号/感叹号或此前有完整句子长度时才切句；常规英文句首为大写/数字/引号/CJK
        if (ch !== '.' || !/^[a-z]/.test(leadChar)) {
          pushSlice(closePos)
          i = closePos - 1
        }
      }
    }
  }

  if (start < endLimit) {
    pushSlice(endLimit)
  }

  return slices
}

function projectSliceRects(
  contributions: readonly LineContribution[],
  sliceStart: number,
  sliceEnd: number,
  geometry: PageGeometry | null,
  pageNumber: number
): SentenceFragment[] {
  const fragments: SentenceFragment[] = []
  for (const contrib of contributions) {
    const overlapStart = Math.max(sliceStart, contrib.blockStart)
    const overlapEnd = Math.min(sliceEnd, contrib.blockEnd)
    if (overlapEnd <= overlapStart) continue

    const line = contrib.line
    const rawTrimLeft = line.text.search(/\S/)
    const baseOffsetInLine = rawTrimLeft === -1 ? 0 : rawTrimLeft
    const localStart = overlapStart - contrib.blockStart + baseOffsetInLine
    const localEnd = overlapEnd - contrib.blockStart + baseOffsetInLine
    const textSlice = line.text.slice(localStart, localEnd).trim()

    // 若整行基本都属于该句，直接复用整行精确矩形（含 trailingEquationTag 若为公式）
    const coversWholeLine = localStart <= baseOffsetInLine + 1 && localEnd >= line.text.trimEnd().length - 1
    if (coversWholeLine || !geometry || line.spans.length === 0) {
      const displayRects = [line.displayRect]
      const pdfRects = [line.pdfRect]
      if (line.trailingEquationTag && coversWholeLine) {
        displayRects.push(line.trailingEquationTag.displayRect)
        pdfRects.push(line.trailingEquationTag.pdfRect)
      }
      fragments.push({
        pageNumber,
        columnIndex: line.columnIndex,
        rect: unionRects(pdfRects),
        displayRect: unionRects(displayRects),
        textSlice
      })
      continue
    }

    const spanDisplayRects: PageRect[] = []
    const spanPdfRects: PageRect[] = []
    for (const span of line.spans) {
      const sStartChar = Math.max(localStart, span.startInLine)
      const sEndChar = Math.min(localEnd, span.endInLine)
      if (sEndChar <= sStartChar) continue
      const len = Math.max(1, span.endInLine - span.startInLine)
      if (sStartChar <= span.startInLine && sEndChar >= span.endInLine) {
        spanDisplayRects.push(span.item.displayRect)
        spanPdfRects.push(span.item.pdfRect)
      } else {
        const s0 = ((sStartChar - span.startInLine) / len) * span.item.vw
        const s1 = ((sEndChar - span.startInLine) / len) * span.item.vw
        const sliced = buildItemRectsFromSubAdvance(span.item, geometry, s0, s1)
        spanDisplayRects.push(sliced.displayRect)
        spanPdfRects.push(sliced.pdfRect)
      }
    }
    if (spanPdfRects.length > 0) {
      fragments.push({
        pageNumber,
        columnIndex: line.columnIndex,
        rect: unionRects(spanPdfRects),
        displayRect: unionRects(spanDisplayRects),
        textSlice
      })
    } else {
      fragments.push({
        pageNumber,
        columnIndex: line.columnIndex,
        rect: line.pdfRect,
        displayRect: line.displayRect,
        textSlice
      })
    }
  }
  return fragments
}

function canMergeCrossColumnBlocks(prev: DraftBlock, next: DraftBlock, fullTextPrev: string, fullTextNext: string, bodyFontSize: number): boolean {
  if (prev.kind !== 'paragraph' || next.kind !== 'paragraph') return false
  if (prev.columnIndex <= 0 || next.columnIndex !== prev.columnIndex + 1) return false
  const prevTrimmed = fullTextPrev.trimEnd()
  const nextTrimmed = fullTextNext.trimStart()
  if (!prevTrimmed || !nextTrimmed) return false

  // 前栏末尾不能已经是完整句终点（允许行尾连字符或未完成逗号/词语）
  if (SENTENCE_TERMINAL_RE.test(prevTrimmed)) return false

  // 后栏第一行不能有明显首行缩进（相比后栏主体左边距）
  if (next.lines.length >= 2) {
    const colMinX = Math.min(...next.lines.map(l => l.logicalRect.x))
    if (next.lines[0].logicalRect.x - colMinX >= bodyFontSize * 0.85) return false
  }

  return /^[a-z,;)\]\u4e00-\u9fff]/.test(nextTrimmed) || prevTrimmed.endsWith('-')
}

function mergeSentenceFromTwoBlocks(
  leftBlock: AnalyzedBlock,
  rightBlock: AnalyzedBlock,
  leftTailText: string,
  rightHeadText: string,
  leftFragments: SentenceFragment[],
  rightFragments: SentenceFragment[],
  pageNumber: number
): AnalyzedSentence {
  const trimmedLeft = leftTailText.trimEnd()
  const trimmedRight = rightHeadText.trimStart()
  let combinedText: string
  const hyphenMatch = trimmedLeft.match(/^(.*[A-Za-z])([-\u00AD\u2010])$/)
  if (hyphenMatch && /^[a-z]/.test(trimmedRight)) {
    const stem = hyphenMatch[1]
    combinedText = hyphenMatch[2] === '-' && shouldKeepTrailingHyphen(stem)
      ? `${stem}-${trimmedRight}`
      : `${stem}${trimmedRight}`
  } else if (CJK_CHAR_RE.test(trimmedLeft[trimmedLeft.length - 1] ?? '') && CJK_CHAR_RE.test(trimmedRight[0] ?? '')) {
    combinedText = `${trimmedLeft}${trimmedRight}`
  } else {
    combinedText = `${trimmedLeft} ${trimmedRight}`
  }

  const fragments = [...leftFragments, ...rightFragments]
  const rects = fragments.map(f => f.rect)
  const displayRects = fragments.map(f => f.displayRect)
  const bounds = unionRects(rects)
  const displayBounds = unionRects(displayRects)

  return {
    id: makeSentenceId(pageNumber, 1, combinedText, bounds),
    pageNumber,
    order: 1,
    blockId: leftBlock.id,
    blockKind: 'paragraph',
    columnIndex: leftBlock.columnIndex,
    text: combinedText,
    rects,
    displayRects,
    bounds,
    displayBounds,
    fragments,
    crossColumn: rightBlock.columnIndex !== leftBlock.columnIndex
  }
}

const COMMON_SHORT_ENGLISH_WORDS = new Set([
  'in', 'of', 'to', 'on', 'at', 'by', 'as', 'is', 'be', 'or', 'an', 'we', 'it', 'if', 'do', 'no', 'so', 'up', 'us',
  'for', 'the', 'and', 'not', 'are', 'was', 'can', 'may', 'its', 'our', 'all', 'one', 'two', 'new', 'use', 'see',
  'set', 'sum', 'row', 'now', 'has', 'had', 'but', 'any', 'few', 'via', 'per', 'etc', 'fig', 'sec', 'eq', 'end',
  'let', 'out', 'top', 'add', 'sub', 'max', 'min'
])

interface RawInlineFormulaMatch {
  startInLine: number
  endInLine: number
  fallbackText: string
  displayRect: PageRect
  baselineY: number
  lineFontSize: number
}

function isScriptSpanItem(item: ProjectedTextItem, line: LineSegment): boolean {
  return item.em <= line.em * 0.85 && Math.abs(item.baseline - line.logicalBaseline) >= line.em * 0.14
}

function isMathTokenItem(item: ProjectedTextItem, line: LineSegment, bodyFontName: string): boolean {
  const trimmed = item.str.trim()
  if (!trimmed) return false
  if (isScriptSpanItem(item, line)) return true
  if (
    MATH_OP_TEST_RE.test(trimmed) ||
    /[\u2100-\u214F\u2200-\u22FF\u2A00-\u2AFF]/.test(trimmed) ||
    /@[A-Z]\b/.test(trimmed) ||
    /[′″]/.test(trimmed)
  ) {
    return true
  }
  if (bodyFontName && item.fontName && item.fontName !== bodyFontName && countProseWords(trimmed).long === 0) {
    if (/^[()[\]{}|,=+−\-*/<>:;.'′]+$/.test(trimmed)) return true
    if (
      trimmed.length <= 4 &&
      !COMMON_SHORT_ENGLISH_WORDS.has(trimmed.toLowerCase()) &&
      !/^[A-Z][a-z]{2,}$/.test(trimmed)
    ) {
      return true
    }
  }
  return false
}

function isSandwichedFormulaConnector(
  item: ProjectedTextItem,
  prevItem: ProjectedTextItem,
  nextItem: ProjectedTextItem,
  line: LineSegment
): boolean {
  const trimmed = item.str.trim()
  if (!trimmed || trimmed.length > 4) return false
  if (trimmed === ',') {
    const prevComplex =
      isScriptSpanItem(prevItem, line) ||
      MATH_OP_TEST_RE.test(prevItem.str) ||
      /[()[\]{}]/.test(prevItem.str)
    const nextComplex =
      isScriptSpanItem(nextItem, line) ||
      MATH_OP_TEST_RE.test(nextItem.str) ||
      /[()[\]{}]/.test(nextItem.str)
    return prevComplex || nextComplex
  }
  if (/^(?:min|max|sup|inf|log|ln|exp|det|dim)$/i.test(trimmed)) {
    return /[(\u2200-\u22FF]/.test(prevItem.str) || nextItem.str.trim().startsWith('(')
  }
  return /^[0-9()[\]{}|,+\-−*/:.,'′\s]+$/.test(trimmed)
}

function extractLineInlineFormulas(line: LineSegment, bodyFontName: string): RawInlineFormulaMatch[] {
  if (line.spans.length === 0) return []
  const marked = line.spans.map(span => isMathTokenItem(span.item, line, bodyFontName))

  for (let i = 1; i < line.spans.length - 1; i += 1) {
    if (marked[i] || !marked[i - 1] || !marked[i + 1]) continue
    if (!isSandwichedFormulaConnector(line.spans[i].item, line.spans[i - 1].item, line.spans[i + 1].item, line)) {
      continue
    }
    const prevR = line.spans[i - 1].item.logicalRect
    const curR = line.spans[i].item.logicalRect
    const nextR = line.spans[i + 1].item.logicalRect
    const maxGap = Math.max(line.em * 0.85, 7)
    if (curR.x - (prevR.x + prevR.width) <= maxGap && nextR.x - (curR.x + curR.width) <= maxGap) {
      marked[i] = true
    }
  }

  // 紧贴合并公式边缘的数字/短斜体符号前缀后缀（如 a_{n+1} 被拆成的 an + +1，或 nm+m− 后紧跟的 1）
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false
    for (let i = 0; i < line.spans.length; i += 1) {
      if (marked[i]) continue
      const curItem = line.spans[i].item
      const trimmed = curItem.str.trim()
      if (!trimmed) continue
      const curR = curItem.logicalRect
      if (i > 0 && marked[i - 1]) {
        const prevItem = line.spans[i - 1].item
        const prevR = prevItem.logicalRect
        const gap = curR.x - (prevR.x + prevR.width)
        if (gap <= 1.5 && /[+\-−=*/^_({\[]$/.test(prevItem.str.trim()) && /^\d+$/.test(trimmed)) {
          marked[i] = true
          changed = true
          continue
        }
      }
      if (i + 1 < line.spans.length && marked[i + 1]) {
        const nextItem = line.spans[i + 1].item
        const nextR = nextItem.logicalRect
        const gap = nextR.x - (curR.x + curR.width)
        if (
          gap <= 1.5 &&
          bodyFontName &&
          curItem.fontName &&
          curItem.fontName !== bodyFontName &&
          /^[A-Za-z]{1,3}$/.test(trimmed) &&
          /^[+\-−=^_0-9]/.test(nextItem.str.trim())
        ) {
          marked[i] = true
          changed = true
        }
      }
    }
    if (!changed) break
  }

  const runs: Array<{ startIdx: number; endIdx: number }> = []
  let idx = 0
  while (idx < line.spans.length) {
    if (!marked[idx]) {
      idx += 1
      continue
    }
    const startIdx = idx
    let endIdx = idx
    let groupRight = line.spans[idx].item.logicalRect.x + line.spans[idx].item.logicalRect.width
    while (endIdx + 1 < line.spans.length && marked[endIdx + 1]) {
      const nextRect = line.spans[endIdx + 1].item.logicalRect
      if (nextRect.x - groupRight > Math.max(line.em * 0.9, 8)) break
      endIdx += 1
      groupRight = Math.max(groupRight, nextRect.x + nextRect.width)
    }
    runs.push({ startIdx, endIdx })
    idx = endIdx + 1
  }

  const results: RawInlineFormulaMatch[] = []
  for (const run of runs) {
    let sIdx = run.startIdx
    let eIdx = run.endIdx
    while (sIdx < eIdx) {
      const t = line.spans[sIdx].item.str.trim()
      if (/^[.,;:]+$/.test(t) && (!bodyFontName || line.spans[sIdx].item.fontName === bodyFontName)) {
        sIdx += 1
      } else {
        break
      }
    }
    while (eIdx > sIdx) {
      const t = line.spans[eIdx].item.str.trim()
      if (/^[.,;:]+$/.test(t) && (!bodyFontName || line.spans[eIdx].item.fontName === bodyFontName)) {
        eIdx -= 1
      } else {
        break
      }
    }

    const groupSpans = line.spans.slice(sIdx, eIdx + 1)
    if (groupSpans.length === 0) continue

    const startInLine = groupSpans[0].startInLine
    const endInLine = groupSpans[groupSpans.length - 1].endInLine
    const fallbackText = line.text.slice(startInLine, endInLine).trim()
    if (!fallbackText) continue

    if (/^\[\d+(?:\s*[-–—,]\s*\d+)*\]$/.test(fallbackText)) continue
    if (/^\((?:\d+|[ivx]+|[a-z])\)$/i.test(fallbackText)) continue
    if (/^[.,;:]+$/.test(fallbackText)) continue

    if (
      groupSpans.every(
        sp =>
          (isScriptSpanItem(sp.item, line) && /^(?:\d{1,2}[a-z]?|[*†‡§])$/.test(sp.item.str.trim())) ||
          /^[·.,;:\s]+$/.test(sp.item.str)
      )
    ) {
      continue
    }

    if (
      groupSpans.length === 1 &&
      /^[A-Za-z0-9]$/.test(fallbackText) &&
      !isScriptSpanItem(groupSpans[0].item, line)
    ) {
      continue
    }

    const hasScript = groupSpans.some(sp => isScriptSpanItem(sp.item, line))
    const hasMathSym =
      (MATH_OP_TEST_RE.test(fallbackText) ||
        /[\u2100-\u214F\u2200-\u22FF\u2A00-\u2AFF′″]/.test(fallbackText)) &&
      fallbackText.length >= 2
    const hasMathFontConstruct =
      (groupSpans.length >= 2 &&
        groupSpans.some(sp => Boolean(bodyFontName && sp.item.fontName && sp.item.fontName !== bodyFontName)) &&
        fallbackText.length >= 2) ||
      groupSpans.some(sp => /^[A-Za-z]\d+$/.test(sp.item.str.trim()))

    if (!hasScript && !hasMathSym && !hasMathFontConstruct) continue

    const displayRect = unionRects(groupSpans.map(sp => sp.item.displayRect))
    results.push({
      startInLine,
      endInLine,
      fallbackText,
      displayRect,
      baselineY: line.logicalBaseline,
      lineFontSize: line.em
    })
  }

  return results
}

function buildInlineFormulaLinesText(
  lines: readonly LineSegment[],
  bodyFontName: string
): { translationSourceText: string; inlineFormulas: InlineFormulaSpan[] } | null {
  const inlineFormulas: InlineFormulaSpan[] = []
  let text = ''
  let suppressNextJoinSpace = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const matches = extractLineInlineFormulas(line, bodyFontName)
    const prevLine = i > 0 ? lines[i - 1] : undefined
    const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined
    let lineRaw = line.text
    if (matches.length > 0) {
      let replaced = ''
      let cursor = 0
      for (const m of matches) {
        replaced += lineRaw.slice(cursor, m.startInLine)
        const token = `⟪M${inlineFormulas.length + 1}⟫`
        let top = m.displayRect.y
        let bottom = m.displayRect.y + m.displayRect.height
        const mRight = m.displayRect.x + m.displayRect.width

        if (prevLine) {
          const overlapsPrev = prevLine.spans.some(
            sp =>
              sp.item.displayRect.x + sp.item.displayRect.width > m.displayRect.x &&
              sp.item.displayRect.x < mRight
          )
          if (overlapsPrev) {
            const safeTop = prevLine.logicalBaseline + Math.max(1.8, prevLine.em * 0.22)
            if (safeTop > top && bottom - safeTop >= line.em * 0.65) {
              top = safeTop
            }
          }
        }
        if (nextLine) {
          const overlapsNext = nextLine.spans.some(
            sp =>
              sp.item.displayRect.x + sp.item.displayRect.width > m.displayRect.x &&
              sp.item.displayRect.x < mRight
          )
          if (overlapsNext) {
            const safeBottom = nextLine.logicalBaseline - Math.max(6.8, nextLine.em * 0.72)
            if (safeBottom < bottom && safeBottom - top >= line.em * 0.65) {
              bottom = safeBottom
            }
          }
        }

        inlineFormulas.push({
          token,
          fallbackText: m.fallbackText,
          displayRect: {
            x: m.displayRect.x,
            y: top,
            width: m.displayRect.width,
            height: Math.max(1, bottom - top)
          },
          baselineY: m.baselineY,
          lineFontSize: m.lineFontSize
        })
        replaced += token
        cursor = m.endInLine
      }
      replaced += lineRaw.slice(cursor)
      lineRaw = replaced
    }

    let lineText = lineRaw.trim()
    if (i > 0 && text.length > 0 && !suppressNextJoinSpace) {
      const prevChar = text[text.length - 1]
      const nextChar = lineText[0] ?? ''
      if (!(CJK_CHAR_RE.test(prevChar) && CJK_CHAR_RE.test(nextChar))) {
        text += ' '
      }
    }
    suppressNextJoinSpace = false

    if (i < lines.length - 1) {
      const nextText = lines[i + 1].text.trim()
      const hyphenMatch = lineText.match(/^(.*[A-Za-z])([-\u00AD\u2010])$/)
      if (hyphenMatch && /^[a-z]/.test(nextText)) {
        const stem = hyphenMatch[1]
        if (hyphenMatch[2] === '-' && shouldKeepTrailingHyphen(stem)) {
          lineText = `${stem}-`
        } else {
          lineText = stem
        }
        suppressNextJoinSpace = true
      }
    }

    text += lineText
  }

  if (inlineFormulas.length === 0) return null
  return { translationSourceText: text.trim(), inlineFormulas }
}

function buildBlocksAndSentences(
  bands: readonly LayoutBand[],
  pageNumber: number,
  bodyFontSize: number,
  bodyFontName: string,
  dominantOrientation: ReadingOrientation,
  geometry: PageGeometry | null
): { blocks: AnalyzedBlock[]; sentences: AnalyzedSentence[] } {
  const allBlocks: AnalyzedBlock[] = []

  const materializeDraftBlock = (draft: DraftBlock, blockIndex: number): AnalyzedBlock => {
    const blockId = `p${pageNumber}-b${String(blockIndex + 1).padStart(3, '0')}`
    const lineRects = draft.lines.flatMap(l => (l.trailingEquationTag ? [l.pdfRect, l.trailingEquationTag.pdfRect] : [l.pdfRect]))
    const lineDisplayRects = draft.lines.flatMap(l =>
      l.trailingEquationTag ? [l.displayRect, l.trailingEquationTag.displayRect] : [l.displayRect]
    )
    const bounds = unionRects(lineRects)
    const displayBounds = unionRects(lineDisplayRects)
    const { text, contributions } = assembleLinesText(draft.lines)

    const rawSlices: RawSentenceSlice[] =
      draft.kind === 'heading' || draft.kind === 'formula'
        ? [{ text: text.trim(), startOffset: text.indexOf(text.trim()), endOffset: text.indexOf(text.trim()) + text.trim().length }]
        : splitAcademicSentences(text)

    const sentences: AnalyzedSentence[] = []
    for (const slice of rawSlices) {
      if (!slice.text.trim()) continue
      let cleanText = slice.text
      if (draft.kind === 'formula' && draft.lines.some(l => l.trailingEquationTag)) {
        const tag = draft.lines.find(l => l.trailingEquationTag)?.trailingEquationTag?.text.trim()
        if (tag && !cleanText.endsWith(tag)) {
          cleanText = `${cleanText} ${tag}`
        }
      }
      const fragments = projectSliceRects(contributions, slice.startOffset, slice.endOffset, geometry, pageNumber)
      const rects = fragments.map(f => f.rect)
      const displayRects = fragments.map(f => f.displayRect)
      const sBounds = rects.length > 0 ? unionRects(rects) : bounds
      const sDisplayBounds = displayRects.length > 0 ? unionRects(displayRects) : displayBounds

      sentences.push({
        id: '',
        pageNumber,
        order: 0,
        blockId,
        blockKind: draft.kind,
        columnIndex: draft.columnIndex,
        text: cleanText,
        rects: rects.length > 0 ? rects : [bounds],
        displayRects: displayRects.length > 0 ? displayRects : [displayBounds],
        bounds: sBounds,
        displayBounds: sDisplayBounds,
        fragments,
        crossColumn: false
      })
    }

    const inlineFormulaMeta =
      draft.kind !== 'formula' && dominantOrientation === 0 && draft.lines.length > 0
        ? buildInlineFormulaLinesText(draft.lines, bodyFontName)
        : null

    return {
      id: blockId,
      pageNumber,
      order: blockIndex + 1,
      kind: draft.kind,
      columnIndex: draft.columnIndex,
      fontSize: draft.fontSize,
      isBold: draft.isBold,
      bounds,
      displayBounds,
      sentences,
      ...(inlineFormulaMeta
        ? {
            inlineFormulas: inlineFormulaMeta.inlineFormulas,
            translationSourceText: inlineFormulaMeta.translationSourceText
          }
        : {})
    }
  }

  for (const band of bands) {
    if (band.kind === 'spanning') {
      const spanLines = band.linesByColumn.get(0) ?? []
      for (const draft of groupLinesIntoBlocks(spanLines, 0, bodyFontSize)) {
        allBlocks.push(materializeDraftBlock(draft, allBlocks.length))
      }
      continue
    }

    const colIndices = [...band.linesByColumn.keys()].sort((a, b) => a - b)
    const bandColumns: Array<{ colIndex: number; drafts: DraftBlock[]; blocks: AnalyzedBlock[] }> = []

    for (const colIndex of colIndices) {
      const colLines = band.linesByColumn.get(colIndex) ?? []
      const drafts = groupLinesIntoBlocks(colLines, colIndex, bodyFontSize)
      const materialized = drafts.map(d => {
        const block = materializeDraftBlock(d, allBlocks.length)
        allBlocks.push(block)
        return block
      })
      bandColumns.push({ colIndex, drafts, blocks: materialized })
    }

    // 处理同一 Band 内前栏最后一块向下一栏第一块的跨栏续句
    for (let c = 0; c < bandColumns.length - 1; c += 1) {
      const leftCol = bandColumns[c]
      const rightCol = bandColumns[c + 1]
      if (leftCol.blocks.length === 0 || rightCol.blocks.length === 0) continue
      const leftDraft = leftCol.drafts[leftCol.drafts.length - 1]
      const rightDraft = rightCol.drafts[0]
      const leftBlock = leftCol.blocks[leftCol.blocks.length - 1]
      const rightBlock = rightCol.blocks[0]
      if (leftBlock.sentences.length === 0 || rightBlock.sentences.length === 0) continue

      const leftText = leftBlock.sentences.map(s => s.text).join(' ')
      const rightText = rightBlock.sentences.map(s => s.text).join(' ')
      if (!canMergeCrossColumnBlocks(leftDraft, rightDraft, leftText, rightText, bodyFontSize)) continue

      const leftTail = leftBlock.sentences.pop()!
      const rightHead = rightBlock.sentences.shift()!
      const merged = mergeSentenceFromTwoBlocks(
        leftBlock,
        rightBlock,
        leftTail.text,
        rightHead.text,
        leftTail.fragments,
        rightHead.fragments,
        pageNumber
      )
      leftBlock.sentences.push(merged)
      leftBlock.continuesToNextColumn = true
      leftBlock.continuedSentenceId = merged.id
      if (dominantOrientation === 0 && rightBlock.sentences.length === 0) {
        const rebuiltInline = buildInlineFormulaLinesText([...leftDraft.lines, ...rightDraft.lines], bodyFontName)
        leftBlock.inlineFormulas = rebuiltInline?.inlineFormulas
        leftBlock.translationSourceText = rebuiltInline?.translationSourceText
      } else {
        leftBlock.inlineFormulas = undefined
        leftBlock.translationSourceText = undefined
      }
      rightBlock.inlineFormulas = undefined
      rightBlock.translationSourceText = undefined
      rightBlock.continuedFromPrevColumn = true
      rightBlock.continuedSentenceId = merged.id
    }
  }

  return resequencePageBlocks(allBlocks, pageNumber)
}

function resequencePageBlocks(blocks: AnalyzedBlock[], pageNumber: number): { blocks: AnalyzedBlock[]; sentences: AnalyzedSentence[] } {
  const sentences: AnalyzedSentence[] = []
  const cleanedBlocks: AnalyzedBlock[] = []
  const sentenceIdRemap = new Map<string, string>()
  let sentenceOrder = 0
  let blockOrder = 0

  for (const block of blocks) {
    if (block.sentences.length === 0 && !block.continuedFromPrevColumn) continue
    blockOrder += 1
    const blockId = `p${pageNumber}-b${String(blockOrder).padStart(3, '0')}`
    const updatedSentences: AnalyzedSentence[] = []
    for (const s of block.sentences) {
      sentenceOrder += 1
      const id = makeSentenceId(pageNumber, sentenceOrder, s.text, s.bounds)
      if (s.id) sentenceIdRemap.set(s.id, id)
      const nextSentence: AnalyzedSentence = {
        ...s,
        id,
        order: sentenceOrder,
        blockId
      }
      updatedSentences.push(nextSentence)
      sentences.push(nextSentence)
    }
    cleanedBlocks.push({
      ...block,
      id: blockId,
      order: blockOrder,
      sentences: updatedSentences
    })
  }

  for (const block of cleanedBlocks) {
    if (block.continuedSentenceId) {
      block.continuedSentenceId = sentenceIdRemap.get(block.continuedSentenceId) ?? block.continuedSentenceId
    }
  }

  return { blocks: cleanedBlocks, sentences }
}

export function analyzePageLayout(textContent: PageTextContent, geometry: PageGeometry): PageLayoutResult {
  const { items, dominantOrientation, natWidth, natHeight, logicalHeight, logicalWidth } = projectTextItems(
    textContent,
    geometry
  )

  if (items.length === 0) {
    return {
      pageNumber: geometry.pageNumber,
      naturalWidth: natWidth,
      naturalHeight: natHeight,
      columnCount: 0,
      bodyFontSize: 11,
      hasText: false,
      blocks: [],
      sentences: [],
      filteredItems: []
    }
  }

  const filteredItems: FilteredLayoutItem[] = []
  const readingItems: ProjectedTextItem[] = []
  for (const item of items) {
    if (isMarginStamp(item, dominantOrientation, logicalWidth)) {
      filteredItems.push({
        text: item.str.trim(),
        reason: 'margin-stamp',
        displayRect: item.displayRect,
        pdfRect: item.pdfRect
      })
    } else {
      readingItems.push(item)
    }
  }

  if (readingItems.length === 0) {
    return {
      pageNumber: geometry.pageNumber,
      naturalWidth: natWidth,
      naturalHeight: natHeight,
      columnCount: 0,
      bodyFontSize: 11,
      hasText: true,
      blocks: [],
      sentences: [],
      filteredItems
    }
  }

  const clusteredLines = clusterIntoLineSegments(readingItems)
  const bodyFontSize = weightedMedian(
    clusteredLines.map(line => ({ value: line.em, weight: Math.max(1, line.text.trim().length) }))
  )
  const rawLines = splitEquationTagIfNotFormula(clusteredLines, bodyFontSize)

  const edgeFilter = filterSinglePageEdgeItems(rawLines, logicalHeight, bodyFontSize)
  filteredItems.push(...edgeFilter.filtered)

  const gutters = detectColumnGutters(edgeFilter.bodyLines, bodyFontSize)
  const gutterSplitLines =
    gutters.length > 0
      ? splitEquationTagIfNotFormula(splitLinesAtColumnGutters(edgeFilter.bodyLines, gutters), bodyFontSize)
      : edgeFilter.bodyLines
  const { bands, columnCount } = buildReadingBands(
    gutterSplitLines,
    gutters.map(g => g.splitX),
    bodyFontSize
  )
  const fontWeights = new Map<string, number>()
  for (const item of readingItems) {
    if (!item.fontName) continue
    if (item.em < bodyFontSize * 0.9 || item.em > bodyFontSize * 1.15) continue
    const trimmedLen = item.str.replace(/\s+/g, '').length
    if (trimmedLen === 0) continue
    fontWeights.set(item.fontName, (fontWeights.get(item.fontName) ?? 0) + trimmedLen)
  }
  let bodyFontName = ''
  let maxFontWeight = -1
  for (const [name, weight] of fontWeights.entries()) {
    if (weight > maxFontWeight) {
      maxFontWeight = weight
      bodyFontName = name
    }
  }

  const { blocks, sentences } = buildBlocksAndSentences(
    bands,
    geometry.pageNumber,
    bodyFontSize,
    bodyFontName,
    dominantOrientation,
    geometry
  )

  return {
    pageNumber: geometry.pageNumber,
    naturalWidth: natWidth,
    naturalHeight: natHeight,
    columnCount,
    bodyFontSize,
    hasText: true,
    blocks,
    sentences,
    filteredItems
  }
}

function normalizeRepeatText(text: string): string {
  return text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 跨页重复页眉/页脚二次精炼：当已分析页数 >= 2 时，将在多页同纵坐标带重复出现的孤立短边缘块迁入 filteredItems。
 * 无变化页保持原对象引用不变，避免多余 UI 重渲染。
 */
export function refineDocumentHeadersFooters(pages: Map<number, PageLayoutResult>): Map<number, PageLayoutResult> {
  if (pages.size < 2) return pages

  interface EdgeCandidate {
    pageNumber: number
    blockId: string
    reason: 'header' | 'footer'
    maskedText: string
    quantizedBand: number
  }

  const occurrences = new Map<string, EdgeCandidate[]>()

  for (const [pageNumber, page] of pages) {
    if (!page.hasText || page.naturalHeight <= 0 || page.blocks.length < 2) continue
    const topCutoff = page.naturalHeight * 0.22
    const bottomCutoff = page.naturalHeight * 0.78

    for (const block of page.blocks) {
      const text = block.sentences.map(s => s.text).join(' ').trim()
      if (!text || text.length > 90 || block.sentences.length > 1) continue
      if (CAPTION_RE.test(text) || NUMBERED_HEADING_RE.test(text) || STANDARD_HEADING_RE.test(text)) continue
      if (block.fontSize > page.bodyFontSize * 1.08) continue

      const cy = block.displayBounds.y + block.displayBounds.height / 2
      let reason: 'header' | 'footer' | null = null
      if (cy <= topCutoff) reason = 'header'
      else if (cy >= bottomCutoff) reason = 'footer'
      if (!reason) continue

      const maskedText = normalizeRepeatText(text)
      if (!maskedText || maskedText === '#') continue
      const quantizedBand = Math.round(cy / 12) * 12
      const key = `${reason}:${maskedText}@${quantizedBand}`
      const list = occurrences.get(key)
      const entry: EdgeCandidate = { pageNumber, blockId: block.id, reason, maskedText, quantizedBand }
      if (list) list.push(entry)
      else occurrences.set(key, [entry])
    }
  }

  const removalsByPage = new Map<number, Map<string, 'header' | 'footer'>>()
  for (const entries of occurrences.values()) {
    const distinctPages = new Set(entries.map(e => e.pageNumber))
    if (distinctPages.size < 2) continue
    for (const entry of entries) {
      let map = removalsByPage.get(entry.pageNumber)
      if (!map) {
        map = new Map()
        removalsByPage.set(entry.pageNumber, map)
      }
      map.set(entry.blockId, entry.reason)
    }
  }

  if (removalsByPage.size === 0) return pages

  const refined = new Map(pages)
  for (const [pageNumber, removeMap] of removalsByPage) {
    const existing = pages.get(pageNumber)
    if (!existing) continue
    const extraFiltered: FilteredLayoutItem[] = []
    const keptBlocks: AnalyzedBlock[] = []

    for (const block of existing.blocks) {
      const reason = removeMap.get(block.id)
      if (reason) {
        extraFiltered.push({
          text: block.sentences.map(s => s.text).join(' ').trim(),
          reason,
          displayRect: block.displayBounds,
          pdfRect: block.bounds
        })
      } else {
        keptBlocks.push(block)
      }
    }

    if (extraFiltered.length === 0) continue
    const resequenced = resequencePageBlocks(keptBlocks, pageNumber)
    refined.set(pageNumber, {
      ...existing,
      blocks: resequenced.blocks,
      sentences: resequenced.sentences,
      filteredItems: [...existing.filteredItems, ...extraFiltered]
    })
  }

  return refined
}

/** 供测试与高亮层核对：将任意未缩放 PDF 坐标矩形列表通过 PageGeometry 投影为当前 Viewport CSS 像素矩形。 */
export function projectPdfRectsToViewport(geometry: PageGeometry, rects: readonly PageRect[]): PageRect[] {
  return rects.map(rect => pdfRectToViewport(geometry, rect))
}

/** 计算译文源文本的确定性双重 FNV-1a 64-bit 十六进制签名（16 位小写十六进制）。 */
export function hashTranslationBlockSource(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const rev = [...normalized].reverse().join('')
  return `${fnv1a32Hex(normalized)}${fnv1a32Hex(rev)}`
}

/**
 * 为可翻译语义块生成稳定键（绑定页面、语义类型、量化 PDF 坐标与源文本哈希）。
 * 即使后续跨页精炼移除页眉/页脚导致顺序号微调，已译其它块的缓存键仍保持完全一致。
 */
export function computeStableTranslationBlockKey(block: AnalyzedBlock): string {
  const sourceText = block.sentences.map(s => s.text).join(' ').trim()
  const qx = Math.round(block.bounds.x)
  const qy = Math.round(block.bounds.y)
  const sig = fnv1a32Hex(`${qx},${qy}:${sourceText}`)
  return `p${block.pageNumber}-${block.kind}-${sig}`
}

/**
 * 在渲染就绪的 PDF Canvas 瞬时采样每个待译块四角边缘像素中位底色。
 * 白纸默认归化为 `#ffffff`；彩底/浅灰框自动保留原块底色以便原页底图无痕覆写。
 */
export function sampleBlockBackgroundColors(
  canvas: HTMLCanvasElement,
  layout: PageLayoutResult,
  geometry: PageGeometry
): Record<string, string> {
  const colors: Record<string, string> = {}
  const ctx = canvas.getContext('2d')
  if (!ctx || canvas.width <= 0 || canvas.height <= 0) return colors

  const scaleX = geometry.outputScale.x
  const scaleY = geometry.outputScale.y

  for (const block of layout.blocks) {
    if (block.kind === 'formula') continue
    const key = computeStableTranslationBlockKey(block)
    const viewRect = pdfRectToViewport(geometry, block.bounds)
    const pxLeft = Math.max(0, Math.min(canvas.width - 1, Math.floor(viewRect.x * scaleX) - 1))
    const pxTop = Math.max(0, Math.min(canvas.height - 1, Math.floor(viewRect.y * scaleY) - 1))
    const pxRight = Math.max(pxLeft, Math.min(canvas.width - 1, Math.ceil((viewRect.x + viewRect.width) * scaleX) + 1))
    const pxBottom = Math.max(pxTop, Math.min(canvas.height - 1, Math.ceil((viewRect.y + viewRect.height) * scaleY) + 1))

    const sampleCoords: Array<[number, number]> = [
      [pxLeft, pxTop],
      [pxRight, pxTop],
      [pxLeft, pxBottom],
      [pxRight, pxBottom],
      [Math.floor((pxLeft + pxRight) / 2), pxTop],
      [Math.floor((pxLeft + pxRight) / 2), pxBottom]
    ]

    const bgSamples: Array<[number, number, number]> = []
    for (const [sx, sy] of sampleCoords) {
      try {
        const data = ctx.getImageData(sx, sy, 1, 1).data
        if (data[3] < 200) continue
        // 过滤偶发压在黑字笔画或边框细线上的暗像素
        if (data[0] < 120 && data[1] < 120 && data[2] < 120) continue
        bgSamples.push([data[0], data[1], data[2]])
      } catch {
        // 忽略越界读写错误
      }
    }

    if (bgSamples.length === 0) {
      colors[key] = '#ffffff'
      continue
    }

    const rs = bgSamples.map(s => s[0]).sort((a, b) => a - b)
    const gs = bgSamples.map(s => s[1]).sort((a, b) => a - b)
    const bs = bgSamples.map(s => s[2]).sort((a, b) => a - b)
    const mid = Math.floor(bgSamples.length / 2)
    const r = rs[mid]
    const g = gs[mid]
    const b = bs[mid]
    colors[key] = r >= 244 && g >= 244 && b >= 244 ? '#ffffff' : `rgb(${r}, ${g}, ${b})`
  }

  return colors
}
