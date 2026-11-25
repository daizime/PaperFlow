import type { PageRect } from '../reader/pdf-geometry'

export type ReferenceKind = 'figure' | 'table' | 'citation'

export interface ReferenceTarget {
  kind: ReferenceKind
  label: string
  key: string
  author?: string
  year?: string
}

export interface ReferencePageSource {
  text: string
  blocks?: ReadonlyArray<{ kind: string; text: string; bounds?: PageRect }>
}

export interface ReferencePeekMatch {
  target: ReferenceTarget
  pageNumber: number
  title: string
  excerpt: string
  captionBounds?: PageRect
  imageDataUrl?: string
}

const MAX_REFERENCE_TARGETS = 6

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function trimExcerpt(text: string, maxLen = 280): string {
  const clean = normalizeWhitespace(text)
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`
}

/** 从选中文本或句子中提取图表引用与参考文献引用标识（最多保留 6 项，自动去重）。 */
export function extractReferenceTargets(text: string): ReferenceTarget[] {
  const normalized = text.trim()
  if (!normalized) return []

  const results: ReferenceTarget[] = []
  const seen = new Set<string>()
  const push = (target: ReferenceTarget): void => {
    if (results.length >= MAX_REFERENCE_TARGETS) return
    const dedupeKey = `${target.kind}:${target.key.toLowerCase()}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    results.push(target)
  }

  const figRegex = /(?:\b(?:Figures?|Figs?\.?)\s*(\d+[a-zA-Z]?)\b|图\s*(\d+[a-zA-Z]?))/gi
  for (const match of normalized.matchAll(figRegex)) {
    const key = (match[1] ?? match[2] ?? '').trim()
    if (key) {
      push({ kind: 'figure', label: `Fig. ${key}`, key })
    }
  }

  const tableRegex = /(?:\b(?:Tables?|Tabs?\.?)\s*(\d+[a-zA-Z]?)\b|表\s*(\d+[a-zA-Z]?))/gi
  for (const match of normalized.matchAll(tableRegex)) {
    const key = (match[1] ?? match[2] ?? '').trim()
    if (key) {
      push({ kind: 'table', label: `Table ${key}`, key })
    }
  }

  const numericCiteRegex = /\[(\d+(?:\s*[-–,]\s*\d+)*)\]/g
  for (const match of normalized.matchAll(numericCiteRegex)) {
    const inner = match[1]
    for (const part of inner.split(',')) {
      const cleaned = part.trim()
      const rangeMatch = cleaned.match(/^(\d+)\s*[-–]\s*(\d+)$/)
      if (rangeMatch) {
        const start = Number.parseInt(rangeMatch[1], 10)
        const end = Number.parseInt(rangeMatch[2], 10)
        if (Number.isInteger(start) && Number.isInteger(end) && end >= start && end - start <= 5) {
          for (let n = start; n <= end; n += 1) {
            push({ kind: 'citation', label: `[${n}]`, key: String(n) })
          }
          continue
        }
      }
      if (/^\d{1,4}$/.test(cleaned)) {
        push({ kind: 'citation', label: `[${cleaned}]`, key: cleaned })
      }
    }
  }

  const authorYearRegex = /\((?:[^()]*?\b)?([A-Z][a-zA-Z\-']{1,30})(?:\s+(?:et\s+al\.|and\s+[A-Z][a-zA-Z\-']+))?,?\s*((?:19|20)\d{2}[a-z]?)\)/g
  for (const match of normalized.matchAll(authorYearRegex)) {
    const author = match[1]?.trim()
    const year = match[2]?.trim()
    if (!author || !year) continue
    push({
      kind: 'citation',
      label: `${author} (${year})`,
      key: `${author}-${year}`,
      author,
      year
    })
  }

  return results
}

function matchFigureOrTableOnPage(
  target: ReferenceTarget,
  pageNumber: number,
  source: ReferencePageSource
): ReferencePeekMatch | null {
  const escapedKey = escapeRegex(target.key)
  const prefixRe =
    target.kind === 'figure'
      ? new RegExp(`^(?:Figure|Fig\\.?|图)\\s*${escapedKey}(?:\\b|[:.：])`, 'i')
      : new RegExp(`^(?:Table|Tab\\.?|表)\\s*${escapedKey}(?:\\b|[:.：])`, 'i')
  const titleLabel = target.kind === 'figure' ? `图 Fig. ${target.key}` : `表 Table ${target.key}`

  if (source.blocks && source.blocks.length > 0) {
    const captionBlock = source.blocks.find(
      block => block.kind === 'caption' && prefixRe.test(block.text.trim())
    )
    if (captionBlock) {
      return {
        target,
        pageNumber,
        title: `${titleLabel}（第 ${pageNumber} 页）`,
        excerpt: trimExcerpt(captionBlock.text),
        captionBounds: captionBlock.bounds
      }
    }
    const lineMatchBlock = source.blocks.find(block => prefixRe.test(block.text.trim()))
    if (lineMatchBlock) {
      return {
        target,
        pageNumber,
        title: `${titleLabel}（第 ${pageNumber} 页）`,
        excerpt: trimExcerpt(lineMatchBlock.text),
        captionBounds: lineMatchBlock.bounds
      }
    }
  }

  const lines = source.text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!prefixRe.test(line)) continue
    const combined = [line, lines[i + 1]?.trim() ?? ''].filter(Boolean).join(' ')
    return {
      target,
      pageNumber,
      title: `${titleLabel}（第 ${pageNumber} 页）`,
      excerpt: trimExcerpt(combined)
    }
  }

  return null
}

function matchCitationOnPage(
  target: ReferenceTarget,
  pageNumber: number,
  source: ReferencePageSource,
  currentPage?: number
): ReferencePeekMatch | null {
  if (target.author && target.year) {
    const authorRe = new RegExp(`\\b${escapeRegex(target.author)}\\b`)
    const yearRe = new RegExp(`\\b${escapeRegex(target.year)}\\b`)
    const candidates: string[] = []
    if (source.blocks) {
      for (const b of source.blocks) candidates.push(b.text)
    }
    for (const line of source.text.split(/\r?\n/)) {
      candidates.push(line)
    }

    for (const candidate of candidates) {
      const clean = normalizeWhitespace(candidate)
      if (!authorRe.test(clean) || !yearRe.test(clean)) continue
      // 同页自引用（如 "(e.g., Smith et al., 2025)"）跳过，优先找文末参考文献或完整条目
      if (pageNumber === currentPage && clean.includes(`(${target.author}`) && clean.length < 180) {
        continue
      }
      return {
        target,
        pageNumber,
        title: `文献 ${target.label}（第 ${pageNumber} 页）`,
        excerpt: trimExcerpt(clean)
      }
    }
    return null
  }

  const keyEsc = escapeRegex(target.key)
  const bracketRe = new RegExp(`(?:^|\\n)\\s*\\[${keyEsc}\\]\\s+([^\\n]{6,280}(?:\\n[^\\n\\[]{2,140})?)`)
  const bracketMatch = source.text.match(bracketRe)
  if (bracketMatch?.[1]) {
    return {
      target,
      pageNumber,
      title: `文献 [${target.key}]（第 ${pageNumber} 页）`,
      excerpt: trimExcerpt(bracketMatch[1])
    }
  }

  const numberedRe = new RegExp(`(?:^|\\n)\\s*${keyEsc}\\.\\s+([A-Z][^\\n]{8,280}(?:\\n[^\\n]{2,140})?)`)
  const numberedMatch = source.text.match(numberedRe)
  if (numberedMatch?.[1]) {
    return {
      target,
      pageNumber,
      title: `文献 [${target.key}]（第 ${pageNumber} 页）`,
      excerpt: trimExcerpt(numberedMatch[1])
    }
  }

  return null
}

/** 在已提取的页面文本与版面块中定位图表题注或参考文献条目。 */
export function findReferenceMatchInPages(
  target: ReferenceTarget,
  pages: ReadonlyMap<number, ReferencePageSource>,
  currentPage?: number
): ReferencePeekMatch | null {
  const orderedPages = Array.from(pages.keys()).sort((a, b) => a - b)
  if (orderedPages.length === 0) return null

  if (target.kind === 'citation') {
    for (let i = orderedPages.length - 1; i >= 0; i -= 1) {
      const pageNumber = orderedPages[i]
      const source = pages.get(pageNumber)
      if (!source) continue
      const hit = matchCitationOnPage(target, pageNumber, source, currentPage)
      if (hit) return hit
    }
    return null
  }

  for (const pageNumber of orderedPages) {
    const source = pages.get(pageNumber)
    if (!source) continue
    const hit = matchFigureOrTableOnPage(target, pageNumber, source)
    if (hit) return hit
  }
  return null
}
