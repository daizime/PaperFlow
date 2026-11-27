export interface BatchReferenceBlock {
  kind: string
  text: string
}

/**
 * 解析批量翻译页码范围（例如 "1-5, 8"）；为空时回退为 fallbackStart..totalPages。
 */
export function parseBatchPageRange(raw: string, totalPages: number, fallbackStart = 1): number[] {
  const maxPage = Math.max(0, Math.trunc(totalPages))
  if (maxPage <= 0) return []
  const clampedStart = Math.max(1, Math.min(Math.trunc(fallbackStart) || 1, maxPage))
  const trimmed = raw.trim()
  if (!trimmed) {
    const pages: number[] = []
    for (let p = clampedStart; p <= maxPage; p += 1) pages.push(p)
    return pages
  }

  const picked = new Set<number>()
  for (const part of trimmed.split(/[,，\s]+/)) {
    const token = part.trim()
    if (!token) continue
    const rangeMatch = /^(\d{1,5})\s*[-~至到]\s*(\d{1,5})$/.exec(token)
    if (rangeMatch) {
      const a = Math.max(1, Math.min(maxPage, Number.parseInt(rangeMatch[1], 10)))
      const b = Math.max(1, Math.min(maxPage, Number.parseInt(rangeMatch[2], 10)))
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      for (let p = lo; p <= hi; p += 1) picked.add(p)
      continue
    }
    const singleMatch = /^(\d{1,5})$/.exec(token)
    if (singleMatch) {
      const num = Number.parseInt(singleMatch[1], 10)
      if (num >= 1 && num <= maxPage) picked.add(num)
    }
  }

  return Array.from(picked).sort((a, b) => a - b)
}

const REFERENCES_HEADING_RE =
  /^(?:(?:\d{1,2}(?:\.\d{1,2})?|[ivxlcdm]{1,6})\s*[.)、]?\s*)?(?:references|bibliography|works\s+cited|literature\s+cited|cited\s+literature|参考文献|引用文献)\s*[:：.]?$/i

/**
 * 在一页的文本块中识别独立的“参考文献 (References)”章节标题所在索引，未命中返回 -1。
 */
export function findReferencesHeadingBlockIndex(blocks: readonly BatchReferenceBlock[]): number {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const clean = block.text.replace(/\s+/g, ' ').trim()
    if (!clean || clean.length > 64) continue
    if (block.kind === 'heading' || clean.length <= 36) {
      if (REFERENCES_HEADING_RE.test(clean)) {
        return i
      }
    }
  }
  return -1
}
