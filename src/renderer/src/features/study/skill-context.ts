import type { AnnotationRecord } from '../../../../shared/contracts'

export type SkillSamplingMode = 'full-balanced' | 'around-current' | 'custom'

export interface SkillSamplingOptions {
  mode: SkillSamplingMode
  customRange?: string
}

const KEY_SECTION_PATTERN =
  /\b(?:abstract|introduction|related work|method(?:ology)?|approach|architecture|experiment(?:s|al)?|evaluation|ablation|result(?:s)?|discussion|conclusion(?:s)?)\b|摘要|引言|相关工作|研究方法|实验|消融|结果|结论/i

/**
 * 解析形如 "1-3, 6-9, 14" 的页码输入为去重升序页码数组。
 */
export function parsePageRangeInput(raw: string, pageCount: number): number[] {
  const maxPage = Math.max(1, pageCount)
  const pages = new Set<number>()
  for (const part of raw.split(/[,，\s]+/)) {
    const token = part.trim()
    if (!token) continue
    const rangeMatch = /^(\d+)\s*[-–—~]\s*(\d+)$/.exec(token)
    if (rangeMatch) {
      const start = Math.max(1, Math.min(maxPage, Number.parseInt(rangeMatch[1], 10)))
      const end = Math.max(1, Math.min(maxPage, Number.parseInt(rangeMatch[2], 10)))
      const lo = Math.min(start, end)
      const hi = Math.max(start, end)
      for (let p = lo; p <= hi; p += 1) {
        pages.add(p)
        if (pages.size >= 16) break
      }
    } else if (/^\d+$/.test(token)) {
      const p = Math.max(1, Math.min(maxPage, Number.parseInt(token, 10)))
      pages.add(p)
    }
    if (pages.size >= 16) break
  }
  return Array.from(pages).sort((a, b) => a - b)
}

/**
 * 为长论文精选覆盖“开篇引言 + 中段方法与消融实验 + 当前页 + 结语”的均衡页码列表，避免第 6-12 页核心数据漏读。
 */
export function selectBalancedSkillPages(options: {
  pageCount: number
  currentPage: number
  mode?: SkillSamplingMode
  customRange?: string
}): number[] {
  const pageCount = Math.max(1, options.pageCount)
  const current = Math.max(1, Math.min(pageCount, options.currentPage))
  const mode = options.mode ?? 'full-balanced'

  if (mode === 'custom') {
    const parsed = parsePageRangeInput(options.customRange ?? '', pageCount)
    if (parsed.length > 0) return parsed
  }

  if (mode === 'around-current') {
    const nearby = new Set<number>([1, current - 1, current, current + 1])
    return Array.from(nearby)
      .filter(p => p >= 1 && p <= pageCount)
      .sort((a, b) => a - b)
  }

  if (pageCount <= 8) {
    return Array.from({ length: pageCount }, (_, i) => i + 1)
  }

  const chosen = new Set<number>([1, 2, current, pageCount - 1, pageCount])
  const midStart = 3
  const midEnd = pageCount - 2
  const middleBudget = 5
  const span = Math.max(1, midEnd - midStart)
  for (let slot = 0; slot < middleBudget; slot += 1) {
    const candidate = Math.round(midStart + (span * slot) / Math.max(1, middleBudget - 1))
    if (candidate >= 1 && candidate <= pageCount) {
      chosen.add(candidate)
    }
  }

  return Array.from(chosen)
    .sort((a, b) => a - b)
    .slice(0, 10)
}

/**
 * 在 15,600 字上下文预算内按“含核心章节标题页优先、整体均匀分配”的策略组装多页正文与批注。
 */
export function assembleSkillExcerpt(options: {
  pageTexts: ReadonlyArray<{ pageNumber: number; text: string }>
  annotations?: readonly AnnotationRecord[]
  maxChars?: number
}): { excerpt: string; sampledPages: number[] } {
  const maxChars = options.maxChars ?? 15_600
  const nonEmpty = options.pageTexts
    .map(item => ({
      pageNumber: item.pageNumber,
      cleaned: item.text.replace(/\s+/g, ' ').trim()
    }))
    .filter(item => item.cleaned.length > 0)

  const annotations = options.annotations ?? []
  const annotationBlock =
    annotations.length > 0
      ? `\n\n用户批注与笔记：\n${annotations
          .slice(0, 12)
          .map(
            ann =>
              `- (P.${ann.pageNumber}) "${ann.quoteText.slice(0, 120)}"${ann.note ? ` | 笔记: ${ann.note.slice(0, 160)}` : ''}`
          )
          .join('\n')}`.slice(0, 1800)
      : ''

  if (nonEmpty.length === 0) {
    return { excerpt: annotationBlock.trim().slice(0, maxChars), sampledPages: [] }
  }

  const textBudget = Math.max(2000, maxChars - annotationBlock.length - 60)
  const baseShare = Math.max(900, Math.floor(textBudget / nonEmpty.length))
  const chunks: string[] = []
  const sampledPages: number[] = []
  let used = 0

  for (const item of nonEmpty) {
    if (used >= textBudget) break
    const hasKeySection = KEY_SECTION_PATTERN.test(item.cleaned.slice(0, 500))
    const targetSlice = hasKeySection ? Math.min(2600, Math.round(baseShare * 1.25)) : baseShare
    const room = textBudget - used
    const take = Math.max(240, Math.min(targetSlice, room - 16))
    const piece = `[P.${item.pageNumber}] ${item.cleaned.slice(0, take)}`
    chunks.push(piece)
    sampledPages.push(item.pageNumber)
    used += piece.length + 1
  }

  const combined = `${chunks.join('\n')}${annotationBlock}`.trim().slice(0, maxChars)
  return { excerpt: combined, sampledPages }
}
