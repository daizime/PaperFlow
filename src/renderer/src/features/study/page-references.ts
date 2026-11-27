export type PageReferenceSegment =
  | { kind: 'text'; value: string }
  | { kind: 'page-ref'; label: string; pageNumber: number }

const PAGE_REF_RE =
  /(第\s*\d{1,4}\s*页|(?<![A-Za-z0-9_.])(?:[Pp]age\s*|[Pp]\.\s*)\d{1,4}(?![A-Za-z0-9_.]))/g

/**
 * 识别 AI 回复纯文本中的页码引用（如 P.3 / p. 12 / Page 5 / 第 3 页），切分为可点击跳转的片段。
 */
export function splitTextWithPageReferences(text: string): PageReferenceSegment[] {
  if (!text) return []
  const segments: PageReferenceSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  PAGE_REF_RE.lastIndex = 0
  while ((match = PAGE_REF_RE.exec(text)) !== null) {
    const rawLabel = match[0]
    const numMatch = /(\d{1,4})/.exec(rawLabel)
    const pageNumber = numMatch ? Number.parseInt(numMatch[1], 10) : 0
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 2000) {
      continue
    }
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, match.index) })
    }
    segments.push({
      kind: 'page-ref',
      label: rawLabel.replace(/\s+/g, ' ').trim(),
      pageNumber
    })
    lastIndex = PAGE_REF_RE.lastIndex
  }

  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) })
  }
  return segments
}
