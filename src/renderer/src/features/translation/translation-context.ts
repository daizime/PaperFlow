import type {
  TranslatableBlockKind,
  TranslatedBlockRecord,
  TranslationContextEntry,
  TranslationPageContext
} from '../../../../shared/contracts'
import {
  computeStableTranslationBlockKey,
  type PageLayoutResult
} from '../reader/layout-analysis'
import { getBlockTranslationSourceText, isTranslatableBlock } from './sentence-alignment'

const DOC_SUMMARY_MAX_CHARS = 480
const CONTEXT_TEXT_MAX_CHARS = 320

function collapseWhitespaceClip(raw: string, maxChars: number): string {
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (!clean || clean.length <= maxChars) return clean
  return `${clean.slice(0, maxChars - 1).trimEnd()}…`
}

/** 从第 1 页版面分析结果提取轻量论文背景（标题 + 摘要/导言首段），不触发模型请求。 */
export function buildDocumentSummaryFromLayout(page1Layout: PageLayoutResult | undefined): string | undefined {
  if (!page1Layout || !page1Layout.hasText || page1Layout.blocks.length === 0) return undefined
  const translatable = page1Layout.blocks.filter(isTranslatableBlock)
  if (translatable.length === 0) return undefined

  const titleBlock = translatable.find(b => b.kind === 'heading') ?? translatable[0]
  const titleText = getBlockTranslationSourceText(titleBlock)

  const abstractHeadingIdx = translatable.findIndex(
    b => b.kind === 'heading' && /^abstract\b/i.test(getBlockTranslationSourceText(b).trim())
  )
  let summaryPara: string | undefined
  if (abstractHeadingIdx >= 0) {
    const nextPara = translatable.slice(abstractHeadingIdx + 1).find(b => b.kind === 'paragraph')
    if (nextPara) summaryPara = getBlockTranslationSourceText(nextPara)
  }
  if (!summaryPara) {
    const firstLongPara = translatable.find(
      b => b.kind === 'paragraph' && getBlockTranslationSourceText(b).length >= 60
    )
    if (firstLongPara) summaryPara = getBlockTranslationSourceText(firstLongPara)
  }

  const parts: string[] = []
  if (titleText) parts.push(`标题：${collapseWhitespaceClip(titleText, 180)}`)
  if (summaryPara && summaryPara !== titleText) {
    parts.push(`摘要：${collapseWhitespaceClip(summaryPara, DOC_SUMMARY_MAX_CHARS - 200)}`)
  }
  const combined = parts.join('；')
  return combined ? collapseWhitespaceClip(combined, DOC_SUMMARY_MAX_CHARS) : undefined
}

/** 组装单页或单块重译请求所需的多层只读上下文（论文背景、当前节标题、前序句段及已有译文）。 */
export function buildPageTranslationContext(
  layouts: ReadonlyMap<number, PageLayoutResult>,
  pageNumber: number,
  translationsByPage?: ReadonlyMap<number, ReadonlyMap<string, TranslatedBlockRecord>>,
  targetBlockKey?: string
): TranslationPageContext | undefined {
  const documentSummary = buildDocumentSummaryFromLayout(layouts.get(1))
  const curLayout = layouts.get(pageNumber)
  const prevLayout = pageNumber > 1 ? layouts.get(pageNumber - 1) : undefined

  const headingTextsFrom = (layout: PageLayoutResult | undefined, beforeBlockKey?: string): string[] => {
    if (!layout || !layout.hasText) return []
    const headings: string[] = []
    for (const block of layout.blocks) {
      if (!isTranslatableBlock(block)) continue
      const key = computeStableTranslationBlockKey(block)
      if (beforeBlockKey && key === beforeBlockKey) break
      if (block.kind === 'heading') {
        const text = collapseWhitespaceClip(getBlockTranslationSourceText(block), 120)
        if (text) headings.push(text)
      }
    }
    return headings
  }

  let sectionHeading: string | undefined
  if (targetBlockKey) {
    const inPageHeadings = headingTextsFrom(curLayout, targetBlockKey)
    const picked = inPageHeadings.length > 0 ? inPageHeadings.slice(-2) : headingTextsFrom(prevLayout).slice(-2)
    if (picked.length > 0) sectionHeading = collapseWhitespaceClip(picked.join(' > '), 240)
  } else if (prevLayout) {
    const prevHeadings = headingTextsFrom(prevLayout).slice(-2)
    if (prevHeadings.length > 0) sectionHeading = collapseWhitespaceClip(prevHeadings.join(' > '), 240)
  }

  const collectPrecedingEntries = (
    layout: PageLayoutResult | undefined,
    pageNum: number,
    beforeBlockKey?: string,
    limit = 3
  ): TranslationContextEntry[] => {
    if (!layout || !layout.hasText) return []
    const pageCache = translationsByPage?.get(pageNum)
    const candidates: Array<{ kind: TranslatableBlockKind; sourceText: string; translatedText?: string }> = []
    for (const block of layout.blocks) {
      if (!isTranslatableBlock(block)) continue
      const key = computeStableTranslationBlockKey(block)
      if (beforeBlockKey && key === beforeBlockKey) break
      const sourceText = collapseWhitespaceClip(getBlockTranslationSourceText(block), CONTEXT_TEXT_MAX_CHARS)
      if (!sourceText) continue
      const cached = pageCache?.get(key)
      const translatedText =
        cached && cached.translatedText.trim()
          ? collapseWhitespaceClip(cached.translatedText, CONTEXT_TEXT_MAX_CHARS)
          : undefined
      candidates.push({ kind: block.kind, sourceText, ...(translatedText ? { translatedText } : {}) })
    }
    const nonCaptions = candidates.filter(c => c.kind !== 'caption')
    const pool = nonCaptions.length > 0 ? nonCaptions : candidates
    return pool.slice(-limit)
  }

  let precedingBlocks: TranslationContextEntry[] | undefined
  if (targetBlockKey) {
    const samePage = collectPrecedingEntries(curLayout, pageNumber, targetBlockKey, 3)
    if (samePage.length > 0) {
      precedingBlocks = samePage
    } else if (prevLayout) {
      const prevTail = collectPrecedingEntries(prevLayout, pageNumber - 1, undefined, 2).filter(e =>
        Boolean(e.translatedText)
      )
      if (prevTail.length > 0) precedingBlocks = prevTail
    }
  } else if (prevLayout) {
    const prevTail = collectPrecedingEntries(prevLayout, pageNumber - 1, undefined, 2).filter(e =>
      Boolean(e.translatedText)
    )
    if (prevTail.length > 0) precedingBlocks = prevTail
  }

  if (!documentSummary && !sectionHeading && (!precedingBlocks || precedingBlocks.length === 0)) {
    return undefined
  }

  return {
    ...(documentSummary ? { documentSummary } : {}),
    ...(sectionHeading ? { sectionHeading } : {}),
    ...(precedingBlocks && precedingBlocks.length > 0 ? { precedingBlocks } : {})
  }
}
