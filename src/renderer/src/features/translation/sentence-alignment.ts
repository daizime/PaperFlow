import {
  computeStableTranslationBlockKey,
  type AnalyzedBlock,
  type AnalyzedSentence,
  type InlineFormulaSpan,
  type PageLayoutResult
} from '../reader/layout-analysis'
import type { PagePoint, PageRect, PdfSelectionRegion } from '../reader/pdf-geometry'

export interface TranslatedSentenceSegment {
  index: number
  text: string
  start: number
  end: number
}

export interface BlockSentenceAlignment {
  segments: TranslatedSentenceSegment[]
  sourceToTarget: Map<string, number[]>
  targetToSource: Map<number, string[]>
}

export interface SentenceHitResult {
  sentence: AnalyzedSentence
  block: AnalyzedBlock
  blockKey: string
}

export interface SelectionSentenceMatch {
  pageNumber: number
  sentenceIds: string[]
  blockKeys: string[]
  sourceRects: PageRect[]
  sentenceRects: PageRect[]
}

const PROTECTED_ABBR_RE =
  /(?:e\.g|i\.e|et\s+al|al|fig|figs|eq|eqs|sect|sec|secs|tab|tabs|ref|refs|dr|prof|mr|mrs|ms|vs|etc|approx|no|nos|vol|vols|pp|inc|ltd|corp|st)$/i

const CLOSING_PUNCT_RE = /[”’」』）】》"')\]\u201d\u2019]/

function absorbTrailingClosersAndSpace(text: string, pos: number): number {
  let cursor = pos
  while (cursor < text.length && CLOSING_PUNCT_RE.test(text[cursor])) {
    cursor += 1
  }
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) {
    cursor += 1
  }
  return cursor
}

function isProtectedLatinPeriod(text: string, dotIndex: number): boolean {
  const prev = dotIndex > 0 ? text[dotIndex - 1] : ''
  const next = dotIndex + 1 < text.length ? text[dotIndex + 1] : ''

  // 小数或版本号如 3.14 / v1.2
  if (/[0-9]/.test(prev) && /[0-9]/.test(next)) return true

  // "." 紧跟非空白且非右引号/括号字符（如 e.g. 内部第一点、网址）
  if (next && !/\s/.test(next) && !CLOSING_PUNCT_RE.test(next) && next !== '.') return true

  // 常见缩写或单字母首字母如 "J. Smith"
  const prefix = text.slice(Math.max(0, dotIndex - 18), dotIndex)
  if (PROTECTED_ABBR_RE.test(prefix)) return true
  if (/(?:^|[\s(])([A-Z])$/.test(prefix)) return true

  return false
}

/**
 * 无损拆分译文为自然句数组（保留精确字符边界与拼接恒等：`segments.map(s => s.text).join('') === text`）。
 * 支持中英文混排句末标点（`。！？.!?`）并保护常见科研缩写与小数点不被误拆。
 */
export function splitTranslatedSentences(text: string): TranslatedSentenceSegment[] {
  if (!text) return []
  const segments: TranslatedSentenceSegment[] = []
  let start = 0
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    if (ch === '。' || ch === '！' || ch === '？') {
      let j = i + 1
      while (j < text.length && (text[j] === '。' || text[j] === '！' || text[j] === '？')) {
        j += 1
      }
      const end = absorbTrailingClosersAndSpace(text, j)
      if (end < text.length) {
        segments.push({ index: segments.length, text: text.slice(start, end), start, end })
        start = end
        i = end
        continue
      }
      break
    }

    if (ch === '.' || ch === '!' || ch === '?') {
      if (ch === '.' && isProtectedLatinPeriod(text, i)) {
        i += 1
        continue
      }
      let j = i + 1
      while (j < text.length && (text[j] === '.' || text[j] === '!' || text[j] === '?')) {
        j += 1
      }
      // 英文句末标点须到达结尾，或紧接右引号/空白后才断句
      const nextAfterPunct = j < text.length ? text[j] : ''
      if (j < text.length && !/\s/.test(nextAfterPunct) && !CLOSING_PUNCT_RE.test(nextAfterPunct)) {
        i = j
        continue
      }
      // 跳过仅引号内部紧随无空格字母的场景（如 `'e.g.'next`）
      let k = j
      while (k < text.length && CLOSING_PUNCT_RE.test(text[k])) k += 1
      if (k < text.length && !/\s/.test(text[k])) {
        i = k
        continue
      }
      const end = absorbTrailingClosersAndSpace(text, j)
      if (end < text.length) {
        segments.push({ index: segments.length, text: text.slice(start, end), start, end })
        start = end
        i = end
        continue
      }
      break
    }

    i += 1
  }

  if (start < text.length) {
    segments.push({ index: segments.length, text: text.slice(start), start, end: text.length })
  }

  return segments
}

/**
 * 构建块内「原文句子 <-> 译文句段」双向对齐映射。
 * 句数相等时 1:1 对应；模型合并或拆分句时按字符占比区间投影保证双向完备覆盖。
 */
export function alignBlockSentences(
  sourceSentences: readonly AnalyzedSentence[],
  translatedText: string
): BlockSentenceAlignment {
  const segments = splitTranslatedSentences(translatedText)
  const sourceToTarget = new Map<string, number[]>()
  const targetToSource = new Map<number, string[]>()

  if (sourceSentences.length === 0 || segments.length === 0) {
    return { segments, sourceToTarget, targetToSource }
  }

  for (const s of sourceSentences) sourceToTarget.set(s.id, [])
  for (const seg of segments) targetToSource.set(seg.index, [])

  const link = (sourceId: string, segIndex: number): void => {
    const tList = sourceToTarget.get(sourceId)
    if (tList && !tList.includes(segIndex)) tList.push(segIndex)
    const sList = targetToSource.get(segIndex)
    if (sList && !sList.includes(sourceId)) sList.push(sourceId)
  }

  if (sourceSentences.length === 1) {
    for (const seg of segments) link(sourceSentences[0].id, seg.index)
    return { segments, sourceToTarget, targetToSource }
  }

  if (segments.length === 1) {
    for (const s of sourceSentences) link(s.id, 0)
    return { segments, sourceToTarget, targetToSource }
  }

  if (sourceSentences.length === segments.length) {
    for (let i = 0; i < sourceSentences.length; i += 1) {
      link(sourceSentences[i].id, segments[i].index)
    }
    return { segments, sourceToTarget, targetToSource }
  }

  const buildRanges = (lengths: readonly number[]): Array<{ start: number; end: number; mid: number }> => {
    const total = Math.max(1, lengths.reduce((sum, v) => sum + v, 0))
    let acc = 0
    return lengths.map(len => {
      const start = acc / total
      acc += len
      const end = acc / total
      return { start, end, mid: (start + end) / 2 }
    })
  }

  const sourceRanges = buildRanges(sourceSentences.map(s => Math.max(1, s.text.trim().length)))
  const targetRanges = buildRanges(segments.map(seg => Math.max(1, seg.text.trim().length)))

  for (let i = 0; i < sourceSentences.length; i += 1) {
    const sr = sourceRanges[i]
    for (let j = 0; j < segments.length; j += 1) {
      const tr = targetRanges[j]
      if (Math.min(sr.end, tr.end) > Math.max(sr.start, tr.start) + 1e-9) {
        link(sourceSentences[i].id, segments[j].index)
      }
    }
  }

  // 兜底保证每句原文与每段译文均至少映射一个对端片段
  for (let i = 0; i < sourceSentences.length; i += 1) {
    if ((sourceToTarget.get(sourceSentences[i].id)?.length ?? 0) > 0) continue
    let bestIdx = 0
    let bestDist = Number.POSITIVE_INFINITY
    for (let j = 0; j < targetRanges.length; j += 1) {
      const dist = Math.abs(sourceRanges[i].mid - targetRanges[j].mid)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = j
      }
    }
    link(sourceSentences[i].id, segments[bestIdx].index)
  }

  for (let j = 0; j < segments.length; j += 1) {
    if ((targetToSource.get(segments[j].index)?.length ?? 0) > 0) continue
    let bestIdx = 0
    let bestDist = Number.POSITIVE_INFINITY
    for (let i = 0; i < sourceRanges.length; i += 1) {
      const dist = Math.abs(targetRanges[j].mid - sourceRanges[i].mid)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
    }
    link(sourceSentences[bestIdx].id, segments[j].index)
  }

  return { segments, sourceToTarget, targetToSource }
}

function pointToRectDistance(point: PagePoint, rect: PageRect): number {
  const dx = point.x < rect.x ? rect.x - point.x : point.x > rect.x + rect.width ? point.x - (rect.x + rect.width) : 0
  const dy = point.y < rect.y ? rect.y - point.y : point.y > rect.y + rect.height ? point.y - (rect.y + rect.height) : 0
  return Math.hypot(dx, dy)
}

/**
 * 按未缩放 PDF 坐标在页面版面中命中最贴近的原文句子（优先精确内部命中，再回退轻量边沿容差）。
 */
export function hitTestPageSentence(
  layout: PageLayoutResult | undefined,
  pdfPoint: PagePoint,
  maxDist = 4
): SentenceHitResult | null {
  if (!layout || !layout.hasText || layout.blocks.length === 0) return null

  let best: SentenceHitResult | null = null
  let bestDist = Number.POSITIVE_INFINITY
  let bestArea = Number.POSITIVE_INFINITY

  for (const block of layout.blocks) {
    for (const sentence of block.sentences) {
      for (const rect of sentence.rects) {
        const dist = pointToRectDistance(pdfPoint, rect)
        if (dist > maxDist) continue
        const area = Math.max(1, rect.width * rect.height)
        if (dist < bestDist - 1e-6 || (Math.abs(dist - bestDist) <= 1e-6 && area < bestArea)) {
          bestDist = dist
          bestArea = area
          best = {
            sentence,
            block,
            blockKey: computeStableTranslationBlockKey(block)
          }
        }
      }
    }
  }

  return best
}

const LIGATURE_RE = /[\uFB00-\uFB06]/g
const LIGATURE_MAP: Record<string, string> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st'
}

interface RectOverlap {
  ow: number
  oh: number
  area: number
}

interface ScoredSentenceCandidate {
  sentence: AnalyzedSentence
  blockKey: string
  strictOverlapArea: number
  looseOverlapArea: number
  sentenceArea: number
}

function computeRectOverlap(a: PageRect, b: PageRect): RectOverlap | null {
  const ow = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const oh = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (ow <= 0 || oh <= 0) return null
  return { ow, oh, area: ow * oh }
}

function normalizeSelectionText(raw: string): string {
  return raw
    .replace(LIGATURE_RE, ch => LIGATURE_MAP[ch] ?? ch)
    .replace(/([A-Za-z])[-\u00AD\u2010]\s+([a-z])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function toCompactAlphaCjk(normText: string): string {
  return normText.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

function extractBoundaryTokens(normText: string): string[] {
  const tokens: string[] = []
  const matches = normText.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g)
  if (!matches) return tokens

  for (const seg of matches) {
    if (/^[\u4e00-\u9fff]+$/.test(seg)) {
      if (seg.length === 1) {
        tokens.push(seg)
      } else {
        for (let i = 0; i < seg.length - 1; i += 1) {
          tokens.push(seg.slice(i, i + 2))
        }
      }
      continue
    }
    if (seg.length >= 2) {
      tokens.push(seg)
    }
  }
  return tokens
}

function hasTokenOverlap(
  tokens: readonly string[],
  targetTokenSet: ReadonlySet<string>,
  targetCompact: string
): boolean {
  for (const token of tokens) {
    if (targetTokenSet.has(token)) return true
    if (token.length >= 4 && targetCompact.includes(token)) return true
  }
  return false
}

function hasInternalSentenceBoundary(selectedText: string | undefined): boolean {
  if (!selectedText) return false
  const cleaned = selectedText.replace(/\s+/g, ' ').trim()
  if (!cleaned) return false
  return splitTranslatedSentences(cleaned).length > 1
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sentenceContainsFragment(sentenceText: string, normFrag: string, normFragCompact: string): boolean {
  if (!normFrag) return false
  const normCand = normalizeSelectionText(sentenceText)
  if (!/[\u4e00-\u9fff]/.test(normFrag) && /[a-z0-9]/.test(normFrag) && normFrag.length < 4) {
    const escaped = escapeRegExp(normFrag)
    const boundaryRe =
      normFrag.length === 1
        ? new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`)
        : new RegExp(`(?:^|[^a-z0-9])${escaped}`)
    if (boundaryRe.test(normCand)) return true
    return false
  }
  if (normCand.includes(normFrag)) return true
  return normFragCompact.length >= 2 && toCompactAlphaCjk(normCand).includes(normFragCompact)
}

function pruneBoundarySelectionCandidates(
  candidates: ScoredSentenceCandidate[],
  selectedText: string | undefined
): ScoredSentenceCandidate[] {
  if (!selectedText || candidates.length <= 1) return candidates
  const normSel = normalizeSelectionText(selectedText)
  if (normSel.length < 1) return candidates

  const normSelCompact = toCompactAlphaCjk(normSel)
  const normSelTokens = extractBoundaryTokens(normSel)
  const normSelTokenSet = new Set(normSelTokens)
  const normSelHead = normSel.slice(0, Math.min(normSel.length, 64))
  const normSelHeadCompact = toCompactAlphaCjk(normSelHead)
  const normSelHeadSet = new Set(extractBoundaryTokens(normSelHead))
  const selLeadTokens = normSelTokens.slice(0, 2)

  const normSelTail = normSel.slice(Math.max(0, normSel.length - 64))
  const normSelTailCompact = toCompactAlphaCjk(normSelTail)
  const normSelTailSet = new Set(extractBoundaryTokens(normSelTail))
  const selTailTokens = normSelTokens.slice(-2)
  const hasCjk = /[\u4e00-\u9fff]/.test(normSel)

  const sentenceMatchesSelection = (candidate: ScoredSentenceCandidate): boolean => {
    const normCand = normalizeSelectionText(candidate.sentence.text)
    if (normSelCompact.length === 1) {
      return hasCjk
        ? toCompactAlphaCjk(normCand).includes(normSelCompact)
        : sentenceContainsFragment(candidate.sentence.text, normSel, normSelCompact)
    }
    const tokens = extractBoundaryTokens(normCand)
    if (tokens.length > 0 && hasTokenOverlap(tokens, normSelTokenSet, normSelCompact)) return true
    return normSelCompact.length >= 2 && toCompactAlphaCjk(normCand).includes(normSelCompact)
  }

  const kept = [...candidates]

  while (kept.length > 1) {
    const first = kept[0]
    if (first.strictOverlapArea / first.sentenceArea >= 0.35) break
    const firstNorm = normalizeSelectionText(first.sentence.text)
    const firstTokens = extractBoundaryTokens(firstNorm)
    const firstTailWindow = firstNorm.slice(Math.max(0, firstNorm.length - 24))
    const firstTailWindowCompact = toCompactAlphaCjk(firstTailWindow)
    if (firstTokens.length === 0 && !firstTailWindowCompact) break
    const firstTailTokens = firstTokens.slice(-3)
    const firstTailTokenSet = new Set(firstTailTokens)

    const matchesHead =
      normSelCompact.length === 1
        ? hasCjk && firstTailWindowCompact.includes(normSelCompact)
        : hasTokenOverlap(firstTailTokens, normSelHeadSet, normSelHeadCompact) ||
          hasTokenOverlap(selLeadTokens, firstTailTokenSet, firstTailWindowCompact) ||
          ((hasCjk || normSelHeadCompact.length >= 4) && firstTailWindowCompact.includes(normSelHeadCompact))
    if (matchesHead) break

    const rest = kept.slice(1)
    if (!rest.some(sentenceMatchesSelection)) break
    kept.shift()
  }

  while (kept.length > 1) {
    const last = kept[kept.length - 1]
    if (last.strictOverlapArea / last.sentenceArea >= 0.35) break
    const lastNorm = normalizeSelectionText(last.sentence.text)
    const lastTokens = extractBoundaryTokens(lastNorm)
    const lastHeadWindow = lastNorm.slice(0, Math.min(lastNorm.length, 24))
    const lastHeadWindowCompact = toCompactAlphaCjk(lastHeadWindow)
    if (lastTokens.length === 0 && !lastHeadWindowCompact) break
    const lastHeadTokens = lastTokens.slice(0, 3)
    const lastHeadTokenSet = new Set(lastHeadTokens)

    const matchesTail =
      normSelCompact.length === 1
        ? hasCjk && lastHeadWindowCompact.includes(normSelCompact)
        : hasTokenOverlap(lastHeadTokens, normSelTailSet, normSelTailCompact) ||
          hasTokenOverlap(selTailTokens, lastHeadTokenSet, lastHeadWindowCompact) ||
          ((hasCjk || normSelTailCompact.length >= 4) && lastHeadWindowCompact.includes(normSelTailCompact))
    if (matchesTail) break

    const rest = kept.slice(0, -1)
    if (!rest.some(sentenceMatchesSelection)) break
    kept.pop()
  }

  return kept
}

function disambiguateSingleLineFragmentCandidates(
  layout: PageLayoutResult,
  pageRegions: readonly PdfSelectionRegion[],
  chosen: ScoredSentenceCandidate[],
  selectedText: string | undefined
): ScoredSentenceCandidate[] {
  if (pageRegions.length !== 1 || chosen.length === 0 || hasInternalSentenceBoundary(selectedText)) {
    return chosen
  }

  const pr = pageRegions[0].rect
  const normSel = selectedText ? normalizeSelectionText(selectedText) : ''
  const normSelCompact = toCompactAlphaCjk(normSel)

  if (chosen.length > 1) {
    if (normSel.length >= 1) {
      const textMatched = chosen.filter(candidate =>
        sentenceContainsFragment(candidate.sentence.text, normSel, normSelCompact)
      )
      if (textMatched.length === 1) {
        return [textMatched[0]]
      }
    }

    const scoreOf = (candidate: ScoredSentenceCandidate): number =>
      candidate.strictOverlapArea > 0 ? candidate.strictOverlapArea : candidate.looseOverlapArea
    const ranked = [...chosen].sort((a, b) => scoreOf(b) - scoreOf(a))
    const total = ranked.reduce((sum, item) => sum + scoreOf(item), 0)
    const best = scoreOf(ranked[0])
    const second = scoreOf(ranked[1])
    if (total > 0 && (best / total >= 0.62 || best >= second * 1.45)) {
      return [ranked[0]]
    }
    return chosen
  }

  const sole = chosen[0]
  const canCheckSeamDrift = normSel.length >= 2 || /[\u4e00-\u9fff]/.test(normSel)
  if (!canCheckSeamDrift || sentenceContainsFragment(sole.sentence.text, normSel, normSelCompact)) {
    return chosen
  }

  const hostBlock = layout.blocks.find(block => computeStableTranslationBlockKey(block) === sole.blockKey)
  if (!hostBlock || hostBlock.sentences.length <= 1) return chosen

  let bestNeighbor: { sentence: AnalyzedSentence; gapX: number } | null = null
  for (const neighbor of hostBlock.sentences) {
    if (neighbor.order !== sole.sentence.order - 1 && neighbor.order !== sole.sentence.order + 1) continue

    const normNeighbor = normalizeSelectionText(neighbor.text)
    const windowText =
      neighbor.order > sole.sentence.order
        ? normNeighbor.slice(0, Math.min(normNeighbor.length, 72))
        : normNeighbor.slice(Math.max(0, normNeighbor.length - 72))
    const windowCompact = toCompactAlphaCjk(windowText)
    const matchesWindow =
      windowText.includes(normSel) || (normSelCompact.length >= 2 && windowCompact.includes(normSelCompact))
    if (!matchesWindow) continue

    let minGapX = Number.POSITIVE_INFINITY
    for (const sr of neighbor.rects) {
      const overlapY = Math.min(sr.y + sr.height, pr.y + pr.height) - Math.max(sr.y, pr.y)
      if (overlapY < Math.min(sr.height, pr.height) * 0.25) continue
      const gapX = Math.max(0, sr.x - (pr.x + pr.width), pr.x - (sr.x + sr.width))
      if (gapX <= 28 && gapX < minGapX) {
        minGapX = gapX
      }
    }
    if (minGapX <= 28 && (!bestNeighbor || minGapX < bestNeighbor.gapX)) {
      bestNeighbor = { sentence: neighbor, gapX: minGapX }
    }
  }

  if (bestNeighbor) {
    return [
      {
        sentence: bestNeighbor.sentence,
        blockKey: sole.blockKey,
        strictOverlapArea: 1,
        looseOverlapArea: 1,
        sentenceArea: 1
      }
    ]
  }

  return chosen
}

/**
 * 将左栏真实文字选区返回的 PDF 坐标矩形列表反查为对应的原文句子与块键列表。
 */
export function matchSelectionRegionsToSentences(
  layouts: ReadonlyMap<number, PageLayoutResult>,
  regions: readonly PdfSelectionRegion[],
  selectedText?: string
): SelectionSentenceMatch | null {
  if (regions.length === 0) return null

  let targetPageNumber: number | null = null
  let targetLayout: PageLayoutResult | undefined
  for (const region of regions) {
    const candidate = layouts.get(region.pageNumber)
    if (candidate && candidate.hasText && candidate.blocks.length > 0) {
      targetPageNumber = region.pageNumber
      targetLayout = candidate
      break
    }
  }

  if (targetPageNumber === null || !targetLayout) return null

  const pageRegions = regions.filter(r => r.pageNumber === targetPageNumber)
  const scored = scoreLayoutSentencesAgainstRects(
    targetLayout,
    pageRegions.map(r => r.rect),
    sentence => sentence.rects
  )

  let chosen: ScoredSentenceCandidate[]
  if (scored.length > 0) {
    const strictCandidates = scored.filter(candidate => candidate.strictOverlapArea > 0)
    chosen =
      strictCandidates.length > 0
        ? pruneBoundarySelectionCandidates(strictCandidates, selectedText)
        : [pickMaxLooseCandidate(scored)]
  } else {
    const seenFallback = new Set<string>()
    const fallbackCandidates: ScoredSentenceCandidate[] = []
    for (const region of pageRegions) {
      const center = {
        x: region.rect.x + region.rect.width / 2,
        y: region.rect.y + region.rect.height / 2
      }
      const hit = hitTestPageSentence(targetLayout, center, 12)
      if (hit && !seenFallback.has(hit.sentence.id)) {
        seenFallback.add(hit.sentence.id)
        const area = hit.sentence.rects.reduce((sum, sr) => sum + Math.max(1, sr.width * sr.height), 0)
        fallbackCandidates.push({
          sentence: hit.sentence,
          blockKey: hit.blockKey,
          strictOverlapArea: 0,
          looseOverlapArea: 1,
          sentenceArea: Math.max(1, area)
        })
      }
    }
    if (fallbackCandidates.length === 0) return null
    chosen = pruneBoundarySelectionCandidates(fallbackCandidates, selectedText)
  }

  chosen = disambiguateSingleLineFragmentCandidates(targetLayout, pageRegions, chosen, selectedText)

  const match = buildSelectionMatchFromChosen(targetPageNumber, chosen)
  if (!match) return null

  const exactRects = pageRegions
    .map(r => r.rect)
    .filter(r => Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0)
    .slice(0, 200)
  return exactRects.length > 0 ? { ...match, sourceRects: exactRects, sentenceRects: match.sentenceRects } : match
}

function scoreLayoutSentencesAgainstRects(
  layout: PageLayoutResult,
  targetRects: readonly PageRect[],
  getCandidateRects: (sentence: AnalyzedSentence, block: AnalyzedBlock) => readonly PageRect[]
): ScoredSentenceCandidate[] {
  const scored: ScoredSentenceCandidate[] = []

  for (const block of layout.blocks) {
    const blockKey = computeStableTranslationBlockKey(block)
    for (const sentence of block.sentences) {
      const candidateRects = getCandidateRects(sentence, block)
      let strictOverlapArea = 0
      let looseOverlapArea = 0
      let sentenceArea = 0

      for (const sr of candidateRects) {
        sentenceArea += Math.max(1, sr.width * sr.height)
        for (const pr of targetRects) {
          const overlap = computeRectOverlap(sr, pr)
          if (!overlap) continue
          const minH = Math.max(0.5, Math.min(sr.height, pr.height))
          const minW = Math.max(0.5, Math.min(sr.width, pr.width))
          const isNarrowTarget = pr.width < 10
          const looseMinH = isNarrowTarget ? 0.25 : 0.35
          const looseMinW = isNarrowTarget ? Math.min(0.6, minW * 0.4) : 1.5
          const strictMinH = isNarrowTarget ? 0.4 : 0.45
          const strictMinW = isNarrowTarget ? Math.min(0.8, minW * 0.5) : 1.5
          if (overlap.oh >= minH * looseMinH && overlap.ow >= looseMinW) {
            looseOverlapArea += overlap.area
          }
          if (overlap.oh >= minH * strictMinH && overlap.ow >= strictMinW && overlap.ow >= Math.min(minW * 0.5, 14)) {
            strictOverlapArea += overlap.area
          }
        }
      }

      if (strictOverlapArea > 0 || looseOverlapArea > 0) {
        scored.push({
          sentence,
          blockKey,
          strictOverlapArea,
          looseOverlapArea,
          sentenceArea: Math.max(1, sentenceArea)
        })
      }
    }
  }

  return scored
}

function pickMaxLooseCandidate(scored: readonly ScoredSentenceCandidate[]): ScoredSentenceCandidate {
  let best = scored[0]
  for (let i = 1; i < scored.length; i += 1) {
    if (scored[i].looseOverlapArea > best.looseOverlapArea) {
      best = scored[i]
    }
  }
  return best
}

function buildSelectionMatchFromChosen(
  pageNumber: number,
  chosen: readonly { sentence: AnalyzedSentence; blockKey: string; blockBounds?: PageRect }[]
): SelectionSentenceMatch | null {
  const sentenceIds: string[] = []
  const blockKeys: string[] = []
  const sentenceRects: PageRect[] = []
  const seenSentences = new Set<string>()
  const seenBlocks = new Set<string>()

  for (const candidate of chosen) {
    if (!seenSentences.has(candidate.sentence.id)) {
      seenSentences.add(candidate.sentence.id)
      sentenceIds.push(candidate.sentence.id)
      if (candidate.sentence.rects.length > 0) {
        sentenceRects.push(...candidate.sentence.rects)
      } else if (candidate.blockBounds) {
        sentenceRects.push(candidate.blockBounds)
      }
    }
    if (!seenBlocks.has(candidate.blockKey)) {
      seenBlocks.add(candidate.blockKey)
      blockKeys.push(candidate.blockKey)
    }
  }

  if (sentenceIds.length === 0) return null
  return {
    pageNumber,
    sentenceIds,
    blockKeys,
    sourceRects: [...sentenceRects],
    sentenceRects
  }
}

export interface MirrorDragSelectionResult extends SelectionSentenceMatch {
  usedMarquee: boolean
}

interface DisplaySentenceHit {
  sentence: AnalyzedSentence
  block: AnalyzedBlock
  blockKey: string
  dist: number
}

function hitTestDisplaySentence(
  layout: PageLayoutResult,
  displayPoint: PagePoint,
  maxDist: number,
  columnFilter?: number
): DisplaySentenceHit | null {
  let best: DisplaySentenceHit | null = null
  let bestDist = Number.POSITIVE_INFINITY
  let bestArea = Number.POSITIVE_INFINITY

  for (const block of layout.blocks) {
    for (const sentence of block.sentences) {
      if (columnFilter !== undefined && sentence.columnIndex !== columnFilter) continue
      const rects = sentence.displayRects.length > 0 ? sentence.displayRects : [block.displayBounds]
      for (const rect of rects) {
        const dist = pointToRectDistance(displayPoint, rect)
        if (dist > maxDist) continue
        const area = Math.max(1, rect.width * rect.height)
        if (dist < bestDist - 1e-6 || (Math.abs(dist - bestDist) <= 1e-6 && area < bestArea)) {
          bestDist = dist
          bestArea = area
          best = {
            sentence,
            block,
            blockKey: computeStableTranslationBlockKey(block),
            dist
          }
        }
      }
    }
  }

  return best
}

/**
 * 解析右栏未译镜像底图或公式区域上的拖拽选择（支持从句内扫选连续阅读序与空白区起拖框选）。
 */
export function resolveMirrorDragSelection(
  layout: PageLayoutResult | undefined,
  startDisplayPoint: PagePoint,
  currentDisplayPoint: PagePoint
): MirrorDragSelectionResult | null {
  if (!layout || !layout.hasText || layout.blocks.length === 0) return null

  const startHit = hitTestDisplaySentence(layout, startDisplayPoint, 4)
  if (startHit) {
    let endHit = hitTestDisplaySentence(layout, currentDisplayPoint, 10)
    if (!endHit && startHit.sentence.columnIndex > 0) {
      endHit = hitTestDisplaySentence(layout, currentDisplayPoint, 36, startHit.sentence.columnIndex)
    }
    if (!endHit) {
      endHit = hitTestDisplaySentence(layout, currentDisplayPoint, 36) ?? startHit
    }

    const minOrder = Math.min(startHit.sentence.order, endHit.sentence.order)
    const maxOrder = Math.max(startHit.sentence.order, endHit.sentence.order)
    const sweepChosen: Array<{ sentence: AnalyzedSentence; blockKey: string; blockBounds: PageRect }> = []
    for (const block of layout.blocks) {
      const blockKey = computeStableTranslationBlockKey(block)
      for (const sentence of block.sentences) {
        if (sentence.order >= minOrder && sentence.order <= maxOrder) {
          sweepChosen.push({ sentence, blockKey, blockBounds: block.bounds })
        }
      }
    }

    const match = buildSelectionMatchFromChosen(layout.pageNumber, sweepChosen)
    return match ? { ...match, usedMarquee: false } : null
  }

  const dragRect: PageRect = {
    x: Math.min(startDisplayPoint.x, currentDisplayPoint.x),
    y: Math.min(startDisplayPoint.y, currentDisplayPoint.y),
    width: Math.abs(currentDisplayPoint.x - startDisplayPoint.x),
    height: Math.abs(currentDisplayPoint.y - startDisplayPoint.y)
  }
  if (dragRect.width < 2 && dragRect.height < 2) return null

  const scored = scoreLayoutSentencesAgainstRects(layout, [dragRect], (sentence, block) =>
    sentence.displayRects.length > 0 ? sentence.displayRects : [block.displayBounds]
  )
  if (scored.length === 0) return null

  const strictCandidates = scored.filter(candidate => candidate.strictOverlapArea > 0)
  let chosen = strictCandidates.length > 0 ? strictCandidates : [pickMaxLooseCandidate(scored)]
  if (strictCandidates.length > 1 && dragRect.height <= Math.max(layout.bodyFontSize * 2.2, 24)) {
    const totalStrict = strictCandidates.reduce((sum, item) => sum + item.strictOverlapArea, 0)
    const sortedStrict = [...strictCandidates].sort((a, b) => b.strictOverlapArea - a.strictOverlapArea)
    if (totalStrict > 0 && sortedStrict[0].strictOverlapArea / totalStrict >= 0.72) {
      chosen = [sortedStrict[0]]
    }
  }
  const match = buildSelectionMatchFromChosen(layout.pageNumber, chosen)
  return match ? { ...match, usedMarquee: true } : null
}

export interface OverlayBlockIndentGeometry {
  anchorX: number
  anchorWidth: number
  firstLineIndent: number
}

/**
 * 判定一个版面块是否属于需要送译并覆写译文的文本块（公式、表格、插图内部标注及纯数字/无字母符号碎片保留原底图）。
 */
export function isTranslatableBlock(
  block: AnalyzedBlock
): block is AnalyzedBlock & { kind: Exclude<AnalyzedBlock['kind'], 'formula' | 'table' | 'figure'> } {
  if (block.kind === 'formula' || block.kind === 'table' || block.kind === 'figure' || block.sentences.length === 0) {
    return false
  }
  const raw = block.sentences.map(s => s.text).join(' ')
  let cleaned = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    if (code < 32 || code === 127) continue
    cleaned += raw[i]
  }
  const trimmed = cleaned.trim()
  if (!trimmed) return false
  return /[A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(trimmed)
}

/**
 * 获取送译与哈希校验用的原文文本（存在行内公式占位符时优先使用占位符版本，以在译文中原样嵌回公式切片）。
 */
export function getBlockTranslationSourceText(block: AnalyzedBlock): string {
  if (block.translationSourceText && block.translationSourceText.trim()) {
    return block.translationSourceText.trim()
  }
  return block.sentences.map(s => s.text).join(' ').trim()
}

export const INLINE_FORMULA_TOKEN_RE = /⟪M(\d+)⟫/g

export type InlineFormulaSegmentPart =
  | { kind: 'text'; text: string }
  | { kind: 'formula'; formula: InlineFormulaSpan }

/**
 * 将含 ⟪M#⟫ 占位符的译文句切分为纯文本片段与行内公式切片引用；未识别占位符会被安全剔除。
 */
export function splitTextWithInlineFormulas(
  text: string,
  formulas: readonly InlineFormulaSpan[] | undefined
): InlineFormulaSegmentPart[] {
  if (!text) return []
  if (!formulas || formulas.length === 0 || !text.includes('⟪M')) {
    const cleaned = text.replace(/⟪M\d+⟫/g, '')
    return cleaned ? [{ kind: 'text', text: cleaned }] : []
  }

  const byToken = new Map(formulas.map(f => [f.token, f]))
  const parts: InlineFormulaSegmentPart[] = []
  let lastIdx = 0

  for (const match of text.matchAll(INLINE_FORMULA_TOKEN_RE)) {
    const start = match.index ?? 0
    if (start > lastIdx) {
      parts.push({ kind: 'text', text: text.slice(lastIdx, start) })
    }
    const formula = byToken.get(match[0])
    if (formula) {
      parts.push({ kind: 'formula', formula })
    }
    lastIdx = start + match[0].length
  }

  if (lastIdx < text.length) {
    parts.push({ kind: 'text', text: text.slice(lastIdx) })
  }

  return parts.length > 0 ? parts : [{ kind: 'text', text: '' }]
}

/**
 * 统计各正文栏的基准左边缘坐标（排除极窄片段与公式块，避免公式缩进拉偏整栏基准）；
 * `columnIndex === 0` 时仅统计非标题宽块，避免居中大标题拉偏单栏/通栏正文左边界。
 */
export function computeColumnLeftEdges(blocks: readonly AnalyzedBlock[]): Map<number, number> {
  const columnLeftByIndex = new Map<number, number>()
  for (const block of blocks) {
    if (!isTranslatableBlock(block)) continue
    if (block.displayBounds.width < 60) continue
    if (block.columnIndex === 0 && block.kind === 'heading') continue
    const leftEdge = block.displayBounds.x
    const prev = columnLeftByIndex.get(block.columnIndex)
    if (prev === undefined || leftEdge < prev) {
      columnLeftByIndex.set(block.columnIndex, leftEdge)
    }
  }
  return columnLeftByIndex
}

/**
 * 统计各正文栏及单栏/通栏（columnIndex === 0）的安全右边界坐标：
 * - 多栏（columnIndex > 0）：取同栏宽块的右边缘最大值，并避免越过右邻栏左边界；
 * - 单栏/通栏（columnIndex === 0）：取整页宽正文块的统一内容右边缘，防止单栏段落在空白处外溢导致右侧参差不齐。
 */
export function computeColumnRightEdges(
  blocks: readonly AnalyzedBlock[],
  columnLeftByIndex?: ReadonlyMap<number, number>
): Map<number, number> {
  const columnRightByIndex = new Map<number, number>()
  let wideContentRight: number | null = null
  let fallbackContentRight: number | null = null

  for (const block of blocks) {
    if (!isTranslatableBlock(block)) continue
    const w = block.displayBounds.width
    const rightEdge = block.displayBounds.x + w
    if (w >= 60) {
      if (wideContentRight === null || rightEdge > wideContentRight) {
        wideContentRight = rightEdge
      }
    }
    if (w >= 40) {
      if (fallbackContentRight === null || rightEdge > fallbackContentRight) {
        fallbackContentRight = rightEdge
      }
      if (block.columnIndex > 0) {
        const prev = columnRightByIndex.get(block.columnIndex) ?? 0
        if (rightEdge > prev) columnRightByIndex.set(block.columnIndex, rightEdge)
      }
    }
  }

  if (columnLeftByIndex) {
    for (const [col, right] of columnRightByIndex.entries()) {
      const nextColLeft = columnLeftByIndex.get(col + 1)
      if (nextColLeft !== undefined && right > nextColLeft - 4) {
        const curColLeft = columnLeftByIndex.get(col) ?? 0
        columnRightByIndex.set(col, Math.max(curColLeft + 40, nextColLeft - 4))
      }
    }
  }

  const contentRight = wideContentRight ?? fallbackContentRight
  if (contentRight !== null) {
    columnRightByIndex.set(0, contentRight)
  }

  return columnRightByIndex
}

/**
 * 根据原版面多行首行偏移与单行段相对栏左边缘偏移，计算译文叠加块的安全锚点与首行缩进（未缩放 pt）。
 */
export function computeOverlayBlockIndent(
  block: AnalyzedBlock,
  columnLeftByIndex: ReadonlyMap<number, number>
): OverlayBlockIndentGeometry {
  const fallback: OverlayBlockIndentGeometry = {
    anchorX: block.displayBounds.x,
    anchorWidth: block.displayBounds.width,
    firstLineIndent: 0
  }
  if ((block.kind !== 'paragraph' && block.kind !== 'list-item') || block.sentences.length === 0) {
    return fallback
  }

  const minIndent = Math.max(4, block.fontSize * 0.45)
  const maxIndent = Math.min(36, block.fontSize * 3.2)

  const firstRect = block.sentences[0].displayRects[0]
  const indentInBlock = firstRect ? firstRect.x - block.displayBounds.x : 0
  if (indentInBlock >= minIndent && indentInBlock <= maxIndent) {
    return {
      anchorX: block.displayBounds.x,
      anchorWidth: block.displayBounds.width,
      firstLineIndent: Math.round(indentInBlock * 10) / 10
    }
  }

  if (block.kind === 'paragraph' && block.columnIndex >= 0) {
    const colLeft = columnLeftByIndex.get(block.columnIndex)
    if (colLeft !== undefined) {
      const offsetFromCol = block.displayBounds.x - colLeft
      if (
        offsetFromCol >= minIndent &&
        offsetFromCol <= maxIndent &&
        block.displayBounds.height <= block.fontSize * 1.85 &&
        block.displayBounds.width >= 60
      ) {
        return {
          anchorX: colLeft,
          anchorWidth: Math.round((block.displayBounds.width + offsetFromCol) * 10) / 10,
          firstLineIndent: Math.round(offsetFromCol * 10) / 10
        }
      }
    }
  }

  return fallback
}

export interface ResolvedOverlayBoxGeometry {
  left: number
  top: number
  baseWidth: number
  maxSafeWidth: number
  height: number
  maxSafeHeight: number
  firstLineIndentPx: number
  tightBottom: boolean
  tightTop: boolean
}

type OverlayLayoutRole = 'translatable' | 'mask' | 'obstacle'

interface InternalOverlayBoxEntry {
  id: string
  block: AnalyzedBlock
  role: OverlayLayoutRole
  rawTop: number
  rawBottom: number
  rawCenterY: number
  left: number
  baseWidth: number
  top: number
  bottom: number
  tightTop: boolean
  tightBottom: boolean
  firstLineIndentPx: number
}

function roundPxTenths(value: number): number {
  return Math.round(value * 10) / 10
}

function rangesOverlapHorizontally(aLeft: number, aRight: number, bLeft: number, bRight: number): boolean {
  return Math.min(aRight, bRight) - Math.max(aLeft, bLeft) > 2
}

function entriesOverlapHorizontally(a: InternalOverlayBoxEntry, b: InternalOverlayBoxEntry): boolean {
  return rangesOverlapHorizontally(a.left, a.left + a.baseWidth, b.left, b.left + b.baseWidth)
}

/**
 * 统一求解整页译文覆盖框的安全边界，消除上下/对角邻接块互相遮挡并预留不可译障碍物安全间距。
 */
export function resolveOverlayBlockGeometries(
  layout: PageLayoutResult,
  scale: number,
  columnLeftByIndex: ReadonlyMap<number, number>,
  columnRightByIndex: ReadonlyMap<number, number>
): Map<string, ResolvedOverlayBoxGeometry> {
  const result = new Map<string, ResolvedOverlayBoxGeometry>()
  if (!Number.isFinite(scale) || scale <= 0 || layout.blocks.length === 0) {
    return result
  }

  const pageWidthPx = Math.max(1, layout.naturalWidth * scale)
  const pageHeightPx = Math.max(1, layout.naturalHeight * scale)
  const entries: InternalOverlayBoxEntry[] = []

  for (const block of layout.blocks) {
    let role: OverlayLayoutRole | null = null
    if (block.sentences.length > 0) {
      role = isTranslatableBlock(block) ? 'translatable' : 'obstacle'
    } else if (
      block.kind !== 'formula' &&
      block.kind !== 'table' &&
      block.kind !== 'figure' &&
      Boolean(block.continuedFromPrevColumn)
    ) {
      role = 'mask'
    }
    if (!role) continue

    const indentGeom = computeOverlayBlockIndent(block, columnLeftByIndex)
    const rawLeft = Math.max(0, indentGeom.anchorX * scale)
    const rawRight = Math.max(rawLeft + 4, (indentGeom.anchorX + indentGeom.anchorWidth) * scale)
    const rawTop = Math.max(0, block.displayBounds.y * scale)
    const rawBottom = Math.max(rawTop + 1, (block.displayBounds.y + block.displayBounds.height) * scale)
    const rawCenterY = (rawTop + rawBottom) / 2

    let left = rawLeft
    let baseWidth = rawRight - rawLeft
    let top = rawTop
    let bottom = rawBottom

    if (role === 'mask') {
      left = Math.max(0, rawLeft - 1)
      baseWidth = Math.max(24, rawRight - rawLeft + 2)
      top = Math.max(0, rawTop - 1)
      bottom = Math.min(pageHeightPx, Math.max(top + 4, rawBottom + 1))
    } else if (role === 'translatable') {
      const bottomPad = Math.min(2.5, Math.max(1.5, block.fontSize * scale * 0.18))
      const minSingleLineH = Math.min(14, Math.max(8, block.fontSize * scale * 1.18))
      left = Math.max(0, rawLeft - 1)
      baseWidth = Math.max(24, rawRight - rawLeft + 2)
      top = Math.max(0, rawTop - 1.5)
      bottom = Math.min(pageHeightPx, Math.max(top + minSingleLineH, rawBottom + bottomPad))
    }

    const firstLineIndentPx =
      indentGeom.firstLineIndent > 0 ? roundPxTenths(indentGeom.firstLineIndent * scale) : 0

    entries.push({
      id: block.id,
      block,
      role,
      rawTop,
      rawBottom,
      rawCenterY,
      left,
      baseWidth,
      top,
      bottom,
      tightTop: false,
      tightBottom: false,
      firstLineIndentPx
    })
  }

  entries.sort((a, b) => a.rawTop - b.rawTop || a.rawBottom - b.rawBottom || a.left - b.left)

  // 1. 纵向碰撞消解：在相邻两块水平有交集时，保证零叠压且不推低原块顶边露字
  for (let i = 0; i < entries.length; i += 1) {
    const a = entries[i]
    for (let j = i + 1; j < entries.length; j += 1) {
      const b = entries[j]
      if (!entriesOverlapHorizontally(a, b)) continue
      if (a.bottom <= b.top) continue

      if (a.role === 'obstacle' && b.role !== 'obstacle') {
        b.top = Math.min(b.bottom - 4, Math.max(b.top, Math.ceil(a.bottom)))
        b.tightTop = true
      } else if (a.role !== 'obstacle' && b.role === 'obstacle') {
        a.bottom = Math.max(a.top + 4, Math.min(a.bottom, Math.floor(b.top)))
        a.tightBottom = true
      } else if (a.role !== 'obstacle' && b.role !== 'obstacle') {
        if (b.rawTop >= a.rawBottom) {
          const rawMid = (a.rawBottom + b.rawTop) / 2
          a.bottom = Math.min(a.bottom, Math.max(a.rawBottom, Math.floor(rawMid)))
          b.top = Math.max(b.top, Math.min(b.rawTop, Math.ceil(rawMid)))
        } else {
          const splitY = Math.round((a.rawBottom + b.rawTop) / 2)
          const minSplit = Math.ceil(a.top + 4)
          const maxSplit = Math.floor(b.bottom - 4)
          if (minSplit <= maxSplit) {
            const safeSplitY = Math.max(minSplit, Math.min(maxSplit, splitY))
            a.bottom = Math.min(a.bottom, safeSplitY)
            b.top = Math.max(b.top, safeSplitY)
          }
        }
        a.tightBottom = true
        b.tightTop = true
      }
    }
  }

  // 2. 紧邻边标记：两块垂直间距 <= 2.5px 时启用内边距防贴边
  for (let i = 0; i < entries.length; i += 1) {
    const a = entries[i]
    for (let j = i + 1; j < entries.length; j += 1) {
      const b = entries[j]
      if (!entriesOverlapHorizontally(a, b)) continue
      if (b.top - a.bottom <= 2.5 && b.bottom >= a.top) {
        if (a.role !== 'obstacle') a.tightBottom = true
        if (b.role !== 'obstacle') b.tightTop = true
      }
    }
  }

  // 3A. 固化基础坐标盒
  const finalizedTopHeight = new Map<string, { left: number; baseWidth: number; top: number; height: number }>()
  for (const e of entries) {
    const left = roundPxTenths(e.left)
    const baseWidth = roundPxTenths(e.baseWidth)
    const top = roundPxTenths(e.top)
    const height = Math.max(4, Math.floor((e.bottom - top + 1e-6) * 10) / 10)
    finalizedTopHeight.set(e.id, { left, baseWidth, top, height })
  }

  // 3B. 先求解每块所属栏（含单栏/通栏 columnIndex === 0）及右侧无碰撞的安全扩宽上限 maxSafeWidth
  const derivedColRights = computeColumnRightEdges(layout.blocks, columnLeftByIndex)
  const maxWidthById = new Map<string, number>()
  for (const a of entries) {
    if (a.role === 'obstacle') continue
    const geom = finalizedTopHeight.get(a.id)!
    const pageSafeWidth = Math.max(geom.baseWidth, pageWidthPx - 16 - geom.left)
    const colRightPt =
      columnRightByIndex.get(a.block.columnIndex) ??
      (a.block.columnIndex === 0 ? derivedColRights.get(0) : undefined)
    const symmetricFallbackWidth = Math.max(
      geom.baseWidth,
      pageWidthPx - Math.max(16, Math.min(geom.left, pageWidthPx * 0.25)) - geom.left
    )
    let maxSafeWidth =
      colRightPt !== undefined
        ? Math.max(geom.baseWidth, colRightPt * scale + 2 - geom.left)
        : symmetricFallbackWidth
    maxSafeWidth = Math.min(pageSafeWidth, maxSafeWidth)

    const estimatedMaxBottom = geom.top + geom.height + Math.round(Math.max(4, a.block.fontSize * scale * 0.85))
    for (const o of entries) {
      if (o.id === a.id) continue
      const oGeom = finalizedTopHeight.get(o.id)!
      if (oGeom.left <= geom.left + 4) continue
      if (oGeom.top + oGeom.height >= geom.top - 1 && oGeom.top <= estimatedMaxBottom + 1) {
        maxSafeWidth = Math.min(maxSafeWidth, Math.max(geom.baseWidth, oGeom.left - 4 - geom.left))
      }
    }
    const roundedMaxWidth = roundPxTenths(maxSafeWidth)
    maxWidthById.set(a.id, roundedMaxWidth)

    // 多行满栏正文/列表/图注若右缘原本即贴近同栏统一右边界，将 baseWidth 齐平贴靠，避免相邻段右缘参差
    if (
      a.role === 'translatable' &&
      colRightPt !== undefined &&
      (a.block.kind === 'paragraph' || a.block.kind === 'list-item' || a.block.kind === 'caption') &&
      a.rawBottom - a.rawTop > a.block.fontSize * scale * 1.6 &&
      roundedMaxWidth > geom.baseWidth
    ) {
      const colLeftPt = columnLeftByIndex.get(a.block.columnIndex) ?? a.block.displayBounds.x
      const colWidthPx = Math.max(1, (colRightPt - colLeftPt) * scale)
      const colRightPx = colRightPt * scale
      const rawBlockRightPx = (a.block.displayBounds.x + a.block.displayBounds.width) * scale
      const nearRightEdgeGap = colRightPx - rawBlockRightPx
      if (nearRightEdgeGap >= -2 && nearRightEdgeGap <= Math.max(colWidthPx * 0.14, 24 * scale)) {
        geom.baseWidth = roundedMaxWidth
      }
    }
  }

  // 3C. 再按扩宽后的水平区间 [left, left + maxSafeWidth] 扫描下方最近块求解安全扩高 maxSafeHeight，杜绝对角遮挡
  for (const a of entries) {
    if (a.role === 'obstacle') continue
    const geom = finalizedTopHeight.get(a.id)!
    const aMaxWidth = maxWidthById.get(a.id) ?? geom.baseWidth
    const aMaxRight = geom.left + aMaxWidth

    let maxSafeHeight = geom.height
    if (a.role === 'translatable') {
      let nearestBelowTop = pageHeightPx
      for (const b of entries) {
        if (b.id === a.id) continue
        const bGeom = finalizedTopHeight.get(b.id)!
        if (b.rawCenterY <= a.rawCenterY + 0.5 && bGeom.top < geom.top + geom.height - 0.5) continue
        const bMaxWidth = maxWidthById.get(b.id) ?? bGeom.baseWidth
        if (!rangesOverlapHorizontally(geom.left, aMaxRight, bGeom.left, bGeom.left + bMaxWidth)) continue
        if (bGeom.top >= geom.top + geom.height - 0.5 && bGeom.top < nearestBelowTop) {
          nearestBelowTop = bGeom.top
        }
      }

      if (!a.tightBottom && nearestBelowTop - (geom.top + geom.height) > 3) {
        const freeBelow = Math.max(0, Math.floor(nearestBelowTop - 3) - (geom.top + geom.height))
        const maxGrow = Math.min(freeBelow, Math.round(Math.max(4, a.block.fontSize * scale * 0.75)))
        maxSafeHeight = roundPxTenths(geom.height + maxGrow)
      }
    }

    result.set(a.id, {
      left: geom.left,
      top: geom.top,
      baseWidth: geom.baseWidth,
      maxSafeWidth: aMaxWidth,
      height: geom.height,
      maxSafeHeight,
      firstLineIndentPx: a.firstLineIndentPx,
      tightBottom: a.tightBottom,
      tightTop: a.tightTop
    })
  }

  return result
}
