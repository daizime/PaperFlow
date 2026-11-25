export interface PdfOutlineRef {
  num: number
  gen: number
}

export interface RawOutlineNode {
  title?: string | null
  dest?: string | unknown[] | null
  url?: string | null
  items?: RawOutlineNode[]
}

export interface OutlineDocumentLike {
  numPages: number
  getOutline(): Promise<RawOutlineNode[] | null>
  getDestination(id: string): Promise<unknown[] | null>
  getPageIndex(ref: PdfOutlineRef): Promise<number>
}

export interface PdfOutlineItem {
  id: string
  title: string
  pageNumber: number | null
  items: PdfOutlineItem[]
}

function isOutlineRef(value: unknown): value is PdfOutlineRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    'num' in value &&
    'gen' in value &&
    typeof value.num === 'number' &&
    typeof value.gen === 'number'
  )
}

/** 仅解析文档内部 destination；严禁读取、打开或跳转外部 item.url。 */
export async function extractPdfOutline(
  pdf: OutlineDocumentLike,
  signal?: AbortSignal
): Promise<PdfOutlineItem[]> {
  const rawOutline = await pdf.getOutline()
  if (signal?.aborted || !rawOutline || rawOutline.length === 0) return []

  const destinationCache = new Map<string, unknown[] | null>()
  const pageIndexCache = new Map<string, number | null>()

  async function resolvePageNumber(dest: string | unknown[] | null | undefined): Promise<number | null> {
    if (signal?.aborted || !dest) return null
    let destArray: unknown[] | null = null
    if (typeof dest === 'string') {
      if (destinationCache.has(dest)) {
        destArray = destinationCache.get(dest) ?? null
      } else {
        try {
          destArray = await pdf.getDestination(dest)
        } catch {
          destArray = null
        }
        destinationCache.set(dest, destArray)
      }
    } else if (Array.isArray(dest)) {
      destArray = dest
    }

    if (signal?.aborted || !destArray || destArray.length === 0) return null
    const target = destArray[0]
    if (typeof target === 'number') {
      if (Number.isInteger(target) && target >= 0 && target < pdf.numPages) return target + 1
      return null
    }
    if (!isOutlineRef(target)) return null

    const cacheKey = `${target.num}:${target.gen}`
    let index: number | null
    if (pageIndexCache.has(cacheKey)) {
      index = pageIndexCache.get(cacheKey) ?? null
    } else {
      try {
        const resolved = await pdf.getPageIndex(target)
        index = Number.isInteger(resolved) && resolved >= 0 && resolved < pdf.numPages ? resolved : null
      } catch {
        index = null
      }
      pageIndexCache.set(cacheKey, index)
    }
    return index === null ? null : index + 1
  }

  async function visitNodes(nodes: readonly RawOutlineNode[], prefix: string): Promise<PdfOutlineItem[]> {
    const result: PdfOutlineItem[] = []
    for (let index = 0; index < nodes.length; index++) {
      if (signal?.aborted) return result
      const node = nodes[index]
      const id = prefix ? `${prefix}-${index}` : String(index)
      const children = Array.isArray(node.items) && node.items.length > 0 ? await visitNodes(node.items, id) : []
      if (signal?.aborted) return result
      const pageNumber = await resolvePageNumber(node.dest)
      if (signal?.aborted) return result
      // 纯外部 URL 书签忽略不展示，避免暴露未处理的外部链接节点。
      if (pageNumber === null && node.url && children.length === 0) continue
      const title = (node.title ?? '').trim() || '未命名书签'
      result.push({ id, title, pageNumber, items: children })
    }
    return result
  }

  return visitNodes(rawOutline, 'outline')
}

export type AutoOutlineLineInput = string | { text: string; fontSize?: number }

const CAPTION_SKIP_RE = /^(?:Fig\.?|Figure|Table|Tab\.?|Algorithm|Listing|Theorem|Lemma|Proposition|Definition|Corollary|Example|Proof|Remark|图|表)\s*\d*/i
const REFERENCES_HEADING_RE =
  /^(?:(?:\d+(?:\.\d+)*|[IVX]{1,4})\.?\s+)?(?:References|Bibliography|Works\s+Cited|Literature\s+Cited|参考文献)$/i
const APPENDIX_HEADING_RE =
  /^(?:Appendix(?:\s+[A-Z0-9]+(?:[:.\s-][^\n]{1,60})?)?|[A-Z]\.\s+[A-Za-z][^\n]{2,60}|附录(?:\s*[A-Z0-9一二三四五六七八九十]+[^\n]{0,40})?)$/i
const AUTHOR_HEADER_RE = /\bet\s+al\.?$/i
const ABBREV_DOT_RE = /\b(?:vs|e\.g|i\.e|etc|Dr|Mr|Ms|Prof|Fig|Eq|Sec|No|Vol)\.\s+[A-Z]/gi
const NUMBERED_SECTION_RE = /^(\d+(?:\.\d+){0,2})\.?\s+([A-Za-z\u4e00-\u9fff][^\n]{1,95})$/
const ROMAN_SECTION_RE = /^([IVX]{1,4})\.\s+([A-Za-z][^\n]{2,80})$/
const CHINESE_CHAPTER_RE = /^(第[一二三四五六七八九十百\d]+[章节编]\s*[^\n]{1,60})$/
const STANDARD_HEADINGS_RE =
  /^(?:Abstract|Introduction|Related\s+Work|Background|Preliminaries|Problem\s+Statement|Overview|System\s+Design|Architecture|Methodology|Methods|Approach|Implementation|Evaluation|Experiments?|Experimental\s+Setup|Results?|Discussion|Limitations?|Future\s+Work|Conclusion(?:s)?(?:\s+and\s+Future\s+Work)?|Acknowledg(?:e)?ments?|References|Bibliography|Appendix(?:\s+[A-Z0-9]+)?|摘要|引言|绪论|相关工作|研究背景|方法(?:与设计)?|实验(?:设置|结果)?|结果与分析|讨论|结论|参考文献|致谢|附录)$/i

// 常见参考文献条目（如 "1. Abadi, D.J., ..."）、代码行、表格指标行和句首普通正文拦截
const BIB_ENTRY_RE = /^\d+\.\s+[A-Z][A-Za-zÀ-ÿ'`-]+,\s*[A-Z]\./
const CODE_SYNTAX_RE = /[{};]|::|\/\/|=>|->|\b(?:bool|void|int|float|double|return|struct|class|std::|nullptr|printf)\b/
const TABLE_METRIC_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:GiB|TiB|MiB|KiB|GB|MB|KB|ms|us|ns|%|Threads?|Nodes?|Compute\s+Nodes?)\b|\b\d{1,3}(?:,\d{3})+K?\b/i
const PROSE_STARTER_RE =
  /^(?:to|when|where|while|if|in|for|we|the|this|that|these|those|each|every|note|let|here|since|because|however|therefore|moreover|furthermore|although|as|at|by|from|with|without|using|given|assume|suppose|consider|byte|bytes|sums?|categorical)\b/i

function cleanHeadingCandidate(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

function hasSufficientTextQuality(body: string): boolean {
  const hasRealWord = /[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}/.test(body)
  if (!hasRealWord) return false
  const nonSpace = body.replace(/\s+/g, '')
  if (nonSpace.length < 2) return false
  const letterCount = (nonSpace.match(/[A-Za-z\u4e00-\u9fff]/g) ?? []).length
  if (letterCount / nonSpace.length < 0.55) return false
  // 排除表格数据行（含多个独立数字）
  const standaloneNumbers = body.match(/\b\d+(?:[.,]\d+)?[KMG%]?\b/g) ?? []
  if (standaloneNumbers.length >= 2) return false
  return true
}

function computeMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

interface ParsedHeadingCandidate {
  title: string
  depth: 1 | 2
  arabicParts?: number[]
  isReferences?: boolean
  isAppendix?: boolean
}

function isValidAppendixHeading(
  clean: string,
  fontSize: number | undefined,
  medianBodyFont: number | null,
  hasSeenSections: boolean
): boolean {
  if (!APPENDIX_HEADING_RE.test(clean)) return false
  if (BIB_ENTRY_RE.test(clean) || AUTHOR_HEADER_RE.test(clean) || /[.!?]$/.test(clean)) return false
  // 字母编号附录（如 "A. Proofs"）要求字号不小于正文且正文已经过章节，避免把人名首字母 "A. Kara ..." 误判为附录
  if (/^[A-Z]\.\s+/.test(clean)) {
    if (!hasSeenSections) return false
    if (fontSize !== undefined && medianBodyFont !== null && fontSize < medianBodyFont * 0.96) return false
  }
  return true
}

function parseAutoHeading(
  rawLine: string,
  fontSize: number | undefined,
  medianBodyFont: number | null,
  lastTopNumber: number,
  hasSeenSections: boolean
): ParsedHeadingCandidate | null {
  const clean = cleanHeadingCandidate(rawLine)
  if (clean.length < 2 || clean.length > 105) return null
  if (/https?:\/\/|doi:|@/i.test(clean)) return null
  if (AUTHOR_HEADER_RE.test(clean)) return null

  if (REFERENCES_HEADING_RE.test(clean)) {
    return { title: clean, depth: 1, isReferences: true }
  }
  if (isValidAppendixHeading(clean, fontSize, medianBodyFont, hasSeenSections)) {
    return { title: clean, depth: 1, isAppendix: true }
  }

  if (CAPTION_SKIP_RE.test(clean)) return null
  if (BIB_ENTRY_RE.test(clean)) return null
  if (CODE_SYNTAX_RE.test(clean)) return null
  if (TABLE_METRIC_RE.test(clean)) return null
  if (/[,;，；。]$/.test(clean)) return null
  if (/^\d+$/.test(clean)) return null

  if (CHINESE_CHAPTER_RE.test(clean)) {
    return { title: clean, depth: 1 }
  }

  if (STANDARD_HEADINGS_RE.test(clean)) {
    if (fontSize !== undefined && medianBodyFont !== null && fontSize < medianBodyFont * 0.9) {
      return null
    }
    return { title: clean, depth: 1 }
  }

  const numMatch = clean.match(NUMBERED_SECTION_RE)
  if (numMatch) {
    const numStr = numMatch[1]
    let body = numMatch[2].trim()

    // 若为三级嵌套段落内小标题（如 "3.4.1 Busy Polling. The naïve approach..."），仅截出标题头
    if (numStr.split('.').length === 3) {
      const runIn = body.match(/^([A-Z][A-Za-z0-9\s\-/()]{1,46}?)\s*\.\s+[A-Z]/)
      if (runIn) {
        body = runIn[1].trim()
      }
    }

    const bodyWithoutAbbrevs = body.replace(ABBREV_DOT_RE, ' ')
    if (/[.!?]$/.test(body) || /\.\s+[A-Z]/.test(bodyWithoutAbbrevs)) return null
    if (/^(?:19|20)\d{2}\b/.test(numStr)) return null
    if (!hasSufficientTextQuality(body)) return null
    const words = body.split(/\s+/).filter(Boolean)
    if (words.length > 12) return null
    if (/^[a-z]/.test(body) || PROSE_STARTER_RE.test(body)) return null

    // 结合字号过滤图内标注、脚注编号与小字表格行
    if (fontSize !== undefined && medianBodyFont !== null && fontSize < medianBodyFont * 0.94) {
      return null
    }

    const parts = numStr.split('.').map(p => Number.parseInt(p, 10))
    if (parts.some(n => !Number.isInteger(n) || n <= 0 || n > 40)) return null

    if (parts.length === 1) {
      const n = parts[0]
      // 顶层编号单调性保护：避免正文/图例中偶发 "1 Ownership..."、"12 categorical..."、"2 c 2" 干扰
      if (lastTopNumber === 0) {
        if (n > 2) return null
      } else if (n < lastTopNumber + 1 || n > lastTopNumber + 3) {
        return null
      }
      return { title: `${numStr}${clean.startsWith(`${numStr}.`) ? '.' : ''} ${body}`, depth: 1, arabicParts: parts }
    }

    const topNum = parts[0]
    const subNum = parts[1]
    if (subNum > 25) return null
    if (lastTopNumber > 0) {
      if (topNum < lastTopNumber || topNum > lastTopNumber + 1) return null
    } else if (topNum > 2) {
      return null
    }
    return { title: `${numStr} ${body}`, depth: 2, arabicParts: parts }
  }

  const romanMatch = clean.match(ROMAN_SECTION_RE)
  if (romanMatch) {
    const body = romanMatch[2].trim()
    if (!/[.!?]$/.test(body) && hasSufficientTextQuality(body) && body.split(/\s+/).length <= 10) {
      if (fontSize === undefined || medianBodyFont === null || fontSize >= medianBodyFont * 0.94) {
        return { title: clean, depth: 1 }
      }
    }
  }

  return null
}

/** 当 PDF 未内嵌书签时，从页面文本行（可选字号）自动识别学术章节标题生成目录树；自动忽略 References 后的文献条目。 */
export function extractAutoOutlineFromPages(
  pages: ReadonlyArray<{ pageNumber: number; lines: readonly AutoOutlineLineInput[] }>
): PdfOutlineItem[] {
  const fontSamples: number[] = []
  const linePageCounts = new Map<string, Set<number>>()
  for (const page of pages) {
    for (const entry of page.lines) {
      const text = cleanHeadingCandidate(typeof entry === 'string' ? entry : entry.text)
      if (text) {
        const key = text.toLowerCase()
        let set = linePageCounts.get(key)
        if (!set) {
          set = new Set<number>()
          linePageCounts.set(key, set)
        }
        set.add(page.pageNumber)
      }
      if (typeof entry !== 'string' && typeof entry.fontSize === 'number' && Number.isFinite(entry.fontSize) && entry.fontSize > 4) {
        if (entry.text.trim().length >= 20) {
          fontSamples.push(entry.fontSize)
        }
      }
    }
  }
  const medianBodyFont = computeMedian(fontSamples)
  // 跨两页及以上完全重复出现的短行属于页眉/页脚（如 "A. Kara et al."），排除出目录识别
  const repeatedRunningLines = new Set<string>()
  if (pages.length >= 3) {
    for (const [key, pageSet] of linePageCounts.entries()) {
      if (pageSet.size >= 2) repeatedRunningLines.add(key)
    }
  }

  const roots: PdfOutlineItem[] = []
  let currentTopSection: PdfOutlineItem | null = null
  let lastTopNumber = 0
  let inReferences = false
  const seenPerPage = new Set<string>()
  let count = 0

  for (const page of pages) {
    for (const rawEntry of page.lines) {
      const rawLine = typeof rawEntry === 'string' ? rawEntry : rawEntry.text
      const fontSize = typeof rawEntry === 'string' ? undefined : rawEntry.fontSize
      const cleanLine = cleanHeadingCandidate(rawLine)
      if (!cleanLine || repeatedRunningLines.has(cleanLine.toLowerCase())) continue

      if (inReferences) {
        if (!isValidAppendixHeading(cleanLine, fontSize, medianBodyFont, roots.length >= 2)) {
          continue
        }
        inReferences = false
      }

      const parsed = parseAutoHeading(cleanLine, fontSize, medianBodyFont, lastTopNumber, roots.length >= 2)
      if (!parsed) continue

      const key = `${page.pageNumber}:${parsed.title.toLowerCase()}`
      if (seenPerPage.has(key)) continue
      seenPerPage.add(key)

      const item: PdfOutlineItem = {
        id: `auto-${page.pageNumber}-${count++}`,
        title: parsed.title,
        pageNumber: page.pageNumber,
        items: []
      }

      if (parsed.isReferences) {
        roots.push(item)
        currentTopSection = null
        inReferences = true
      } else if (parsed.depth === 2 && currentTopSection) {
        currentTopSection.items.push(item)
      } else {
        roots.push(item)
        currentTopSection = parsed.depth === 1 ? item : null
        if (parsed.arabicParts && parsed.arabicParts.length === 1) {
          lastTopNumber = parsed.arabicParts[0]
        }
      }

      if (count >= 120) return roots
    }
  }

  return roots
}

export interface AutoOutlinePageTextItem {
  str?: string
  width?: number
  hasEOL?: boolean
  transform?: readonly number[]
}

export interface AutoOutlineDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: readonly unknown[] }>
    cleanup(): void
    destroyed?: boolean
  }>
}

function asOutlineTextItem(raw: unknown): AutoOutlinePageTextItem | null {
  if (!raw || typeof raw !== 'object' || !('str' in raw)) return null
  return raw as AutoOutlinePageTextItem
}

function reconstructLinesFromItems(items: readonly unknown[]): Array<{ text: string; fontSize?: number }> {
  const lines: Array<{ text: string; fontSize?: number }> = []
  let buf = ''
  let weightedFontSum = 0
  let weightChars = 0
  let lastY: number | null = null
  let lastEndX: number | null = null

  const flush = (): void => {
    const clean = buf.replace(/\s+/g, ' ').trim()
    if (clean) {
      lines.push({
        text: clean,
        fontSize: weightChars > 0 ? weightedFontSum / weightChars : undefined
      })
    }
    buf = ''
    weightedFontSum = 0
    weightChars = 0
  }

  for (const rawItem of items) {
    const item = asOutlineTextItem(rawItem)
    if (!item || typeof item.str !== 'string') continue
    const t = Array.isArray(item.transform) ? item.transform : null
    const x = t && typeof t[4] === 'number' ? t[4] : null
    const y = t && typeof t[5] === 'number' ? t[5] : null
    const size = t && typeof t[0] === 'number' && typeof t[1] === 'number' ? Math.hypot(t[0], t[1]) : null

    const yChanged = lastY !== null && y !== null && Math.abs(y - lastY) > 4.5
    const largeHorizontalJump = lastEndX !== null && x !== null && Math.abs(x - lastEndX) > 45
    if ((yChanged || largeHorizontalJump) && buf.trim().length > 0) {
      flush()
    }
    if (item.str) {
      if (buf && !buf.endsWith(' ') && !item.str.startsWith(' ')) {
        buf += ' '
      }
      buf += item.str
      const trimmedLen = item.str.trim().length
      if (trimmedLen > 0 && size !== null && Number.isFinite(size) && size > 0) {
        weightedFontSum += size * trimmedLen
        weightChars += trimmedLen
      }
    }
    if (item.hasEOL) {
      flush()
      lastY = null
      lastEndX = null
    } else {
      if (y !== null) lastY = y
      if (x !== null) {
        lastEndX = x + (typeof item.width === 'number' ? Math.max(0, item.width) : item.str.length * 4)
      }
    }
  }
  flush()
  return lines
}

/** 对无书签 PDF 在后台轻量扫描前 maxPages 页文本与字号并生成章节大纲。 */
export async function extractAutoOutlineFromPdf(
  pdf: AutoOutlineDocumentLike,
  signal?: AbortSignal,
  maxPages = 60
): Promise<PdfOutlineItem[]> {
  const limit = Math.min(pdf.numPages, maxPages)
  const pages: Array<{ pageNumber: number; lines: Array<{ text: string; fontSize?: number }> }> = []

  for (let p = 1; p <= limit; p += 1) {
    if (signal?.aborted) return []
    const page = await pdf.getPage(p)
    try {
      const content = await page.getTextContent()
      if (signal?.aborted) return []
      const lines = reconstructLinesFromItems(content.items ?? [])
      if (lines.length > 0) {
        pages.push({ pageNumber: p, lines })
      }
    } finally {
      if (!page.destroyed) page.cleanup()
    }
  }

  if (signal?.aborted) return []
  return extractAutoOutlineFromPages(pages)
}
