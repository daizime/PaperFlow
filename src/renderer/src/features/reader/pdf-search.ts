export interface TextSpan {
  divIndex: number
  startOffset: number
  endOffset: number
}

export interface PageTextIndex {
  text: string
  spans: TextSpan[]
}

export interface SearchMatch {
  id: string
  pageNumber: number
  matchIndexOnPage: number
  startOffset: number
  endOffset: number
}

export interface SearchOptions {
  caseSensitive: boolean
}

export interface TextRangeSegment {
  divIndex: number
  localStart: number
  localEnd: number
}

export interface SearchDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<{
    getTextContent(params?: { includeMarkedContent?: boolean }): Promise<{ items: ReadonlyArray<unknown> }>
  }>
}

function isTextContentItem(item: unknown): item is { str: string; hasEOL?: boolean } {
  return item !== null && typeof item === 'object' && 'str' in item && typeof item.str === 'string'
}

/**
 * 将 PDF.js 页面 TextContent 拼接为连续 UTF-16 字符串与 span 偏移映射。
 * divIndex 与 PDF.js TextLayer.textDivs 保持严格一一对应（仅计入含 str 的项）。
 */
export function buildPageTextIndex(content: { items: ReadonlyArray<unknown> }): PageTextIndex {
  const parts: string[] = []
  const spans: TextSpan[] = []
  let divIndex = 0
  let offset = 0

  for (const item of content.items) {
    if (!isTextContentItem(item)) continue
    const currentDivIndex = divIndex++
    if (item.str.length > 0) {
      const startOffset = offset
      parts.push(item.str)
      offset += item.str.length
      spans.push({ divIndex: currentDivIndex, startOffset, endOffset: offset })
    }
    if (item.hasEOL) {
      parts.push('\n')
      offset += 1
    }
  }

  return { text: parts.join(''), spans }
}

function foldWithOffsets(input: string): { folded: string; toSource: number[] } {
  const folded = input.toLowerCase()
  if (folded.length === input.length) {
    return { folded, toSource: [] }
  }
  let output = ''
  const toSource: number[] = []
  for (let index = 0; index < input.length; ) {
    const codePoint = input.codePointAt(index)!
    const ch = String.fromCodePoint(codePoint)
    const lower = ch.toLowerCase()
    for (let j = 0; j < lower.length; j++) toSource.push(index)
    output += lower
    index += ch.length
  }
  toSource.push(input.length)
  return { folded: output, toSource }
}

export function findMatchesInText(
  text: string,
  query: string,
  pageNumber: number,
  options: SearchOptions
): SearchMatch[] {
  if (!query || !text) return []

  const matches: SearchMatch[] = []
  let matchIndexOnPage = 0

  if (options.caseSensitive) {
    let cursor = 0
    while (cursor <= text.length - query.length) {
      const found = text.indexOf(query, cursor)
      if (found === -1) break
      const endOffset = found + query.length
      matches.push({
        id: `${pageNumber}:${matchIndexOnPage}:${found}:${endOffset}`,
        pageNumber,
        matchIndexOnPage,
        startOffset: found,
        endOffset
      })
      matchIndexOnPage++
      cursor = endOffset
    }
    return matches
  }

  const foldedQuery = query.toLowerCase()
  if (!foldedQuery) return []
  const { folded, toSource } = foldWithOffsets(text)
  const directOffsets = toSource.length === 0

  let cursor = 0
  while (cursor <= folded.length - foldedQuery.length) {
    const found = folded.indexOf(foldedQuery, cursor)
    if (found === -1) break
    const foldedEnd = found + foldedQuery.length
    const startOffset = directOffsets ? found : toSource[found]
    const endOffset = directOffsets ? foldedEnd : toSource[foldedEnd]
    matches.push({
      id: `${pageNumber}:${matchIndexOnPage}:${startOffset}:${endOffset}`,
      pageNumber,
      matchIndexOnPage,
      startOffset,
      endOffset
    })
    matchIndexOnPage++
    cursor = foldedEnd
  }
  return matches
}

/** 将全局页内 UTF-16 匹配区间映射为各个 textDiv 的局部字符偏移。 */
export function findTextRangesForMatch(
  spans: readonly TextSpan[],
  startOffset: number,
  endOffset: number
): TextRangeSegment[] {
  if (endOffset <= startOffset || spans.length === 0) return []
  const segments: TextRangeSegment[] = []
  for (const span of spans) {
    if (span.endOffset <= startOffset) continue
    if (span.startOffset >= endOffset) break
    const localStart = Math.max(0, startOffset - span.startOffset)
    const localEnd = Math.min(span.endOffset - span.startOffset, endOffset - span.startOffset)
    if (localEnd > localStart) {
      segments.push({ divIndex: span.divIndex, localStart, localEnd })
    }
  }
  return segments
}

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

export interface SearchRunCallbacks {
  signal?: AbortSignal
  yieldEvery?: number
  onProgress?(matches: SearchMatch[], done: boolean): void
}

/** 仅按需通过 getTextContent() 惰性缓存整本 PDF 的页内文字，绝不离屏渲染 Canvas。 */
export class PdfSearchService {
  private readonly cache = new Map<number, PageTextIndex>()
  private readonly pending = new Map<number, Promise<PageTextIndex>>()
  private disposed = false

  constructor(private readonly pdf: SearchDocumentLike) {}

  dispose(): void {
    this.disposed = true
    this.cache.clear()
    this.pending.clear()
  }

  seedPage(pageNumber: number, content: { items: ReadonlyArray<unknown> }): PageTextIndex {
    const existing = this.cache.get(pageNumber)
    if (existing) return existing
    const built = buildPageTextIndex(content)
    if (!this.disposed) this.cache.set(pageNumber, built)
    return built
  }

  async getPageText(pageNumber: number): Promise<PageTextIndex> {
    const cached = this.cache.get(pageNumber)
    if (cached) return cached

    const inflight = this.pending.get(pageNumber)
    if (inflight) return inflight

    const task = (async (): Promise<PageTextIndex> => {
      const page = await this.pdf.getPage(pageNumber)
      const content = await page.getTextContent({ includeMarkedContent: true })
      const index = buildPageTextIndex(content)
      if (!this.disposed) this.cache.set(pageNumber, index)
      return index
    })().finally(() => {
      this.pending.delete(pageNumber)
    })

    this.pending.set(pageNumber, task)
    return task
  }

  async search(query: string, options: SearchOptions, callbacks?: SearchRunCallbacks): Promise<SearchMatch[]> {
    const signal = callbacks?.signal
    if (!query || signal?.aborted || this.disposed) {
      if (!signal?.aborted && !this.disposed) callbacks?.onProgress?.([], true)
      return []
    }

    const yieldEvery = Math.max(1, callbacks?.yieldEvery ?? 20)
    const allMatches: SearchMatch[] = []
    let processedSinceYield = 0

    for (let pageNumber = 1; pageNumber <= this.pdf.numPages; pageNumber++) {
      if (signal?.aborted || this.disposed) return []
      const pageIndex = await this.getPageText(pageNumber)
      if (signal?.aborted || this.disposed) return []

      const pageMatches = findMatchesInText(pageIndex.text, query, pageNumber, options)
      if (pageMatches.length > 0) {
        allMatches.push(...pageMatches)
      }

      processedSinceYield++
      if (processedSinceYield >= yieldEvery && pageNumber < this.pdf.numPages) {
        processedSinceYield = 0
        callbacks?.onProgress?.([...allMatches], false)
        await yieldToEventLoop()
        if (signal?.aborted || this.disposed) return []
      }
    }

    if (!signal?.aborted && !this.disposed) {
      callbacks?.onProgress?.([...allMatches], true)
    }
    return allMatches
  }
}
