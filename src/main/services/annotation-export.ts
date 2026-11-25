import type { AnnotationColor, AnnotationRecord, DocumentRecord } from '../../shared/contracts'

const COLOR_LABELS: Record<AnnotationColor, string> = {
  yellow: '黄色高亮',
  green: '绿色高亮',
  blue: '蓝色高亮',
  pink: '粉色高亮'
}

export function formatAnnotationsMarkdown(
  document: Pick<DocumentRecord, 'displayTitle' | 'originalFilename'>,
  annotations: readonly AnnotationRecord[]
): string {
  const lines: string[] = [
    `# ${document.displayTitle} — 阅读批注`,
    '',
    `- 原文件：\`${document.originalFilename}\``,
    `- 批注数量：${annotations.length} 条`,
    `- 导出时间：${new Date().toISOString()}`,
    ''
  ]

  if (annotations.length === 0) {
    lines.push('暂无高亮或批注记录。', '')
    return lines.join('\n')
  }

  let currentPage: number | null = null
  for (const ann of annotations) {
    if (ann.pageNumber !== currentPage) {
      currentPage = ann.pageNumber
      lines.push(`## 第 ${currentPage} 页`, '')
    }
    const label = COLOR_LABELS[ann.color] ?? ann.color
    const quoteLines = ann.quoteText.split(/\r?\n/).map(line => `> ${line}`)
    lines.push(`### [${label}]`, ...quoteLines, '')
    if (ann.note.trim()) {
      lines.push(ann.note.trim(), '')
    }
  }

  return lines.join('\n')
}
