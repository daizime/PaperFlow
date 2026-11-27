export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string }

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(cell => cell.trim())
}

function isTableSeparatorRow(line: string): boolean {
  const cells = splitTableCells(line)
  return cells.length >= 2 && cells.every(cell => /^:?-{2,}:?$/.test(cell))
}

/**
 * 纯函数结构化解析 Markdown 块，避免任何 HTML 注入风险并便于单元测试。
 */
export function parseMarkdownBlocks(raw: string): MarkdownBlock[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    const fenceMatch = /^```([^\s`]*)/.exec(trimmed)
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? ''
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length && /^```\s*$/.test(lines[i].trim())) {
        i += 1
      }
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') })
      continue
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      const level = Math.min(4, headingMatch[1].length) as 1 | 2 | 3 | 4
      blocks.push({ type: 'heading', level, text: headingMatch[2].trim() })
      i += 1
      continue
    }

    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      const headers = splitTableCells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().includes('|') && !isTableSeparatorRow(lines[i])) {
        const rowCells = splitTableCells(lines[i])
        while (rowCells.length < headers.length) rowCells.push('')
        rows.push(rowCells.slice(0, headers.length))
        i += 1
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    if (/^(?:[-*•])\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^(?:[-*•])\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^(?:[-*•])\s+/, ''))
        i += 1
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''))
        i += 1
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    const paraLines: string[] = [trimmed]
    i += 1
    while (i < lines.length) {
      const nextTrim = lines[i].trim()
      if (
        !nextTrim ||
        /^```/.test(nextTrim) ||
        /^(?:-{3,}|\*{3,}|_{3,})$/.test(nextTrim) ||
        /^#{1,4}\s+/.test(nextTrim) ||
        /^>\s?/.test(nextTrim) ||
        /^(?:[-*•])\s+/.test(nextTrim) ||
        /^\d+[.)]\s+/.test(nextTrim) ||
        (nextTrim.includes('|') && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1]))
      ) {
        break
      }
      paraLines.push(nextTrim)
      i += 1
    }
    blocks.push({ type: 'paragraph', text: paraLines.join('\n') })
  }

  return blocks
}
