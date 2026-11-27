import type { TranslatedBlockRecord, TranslationBlockInput } from '../../../../shared/contracts'
import {
  computeStableTranslationBlockKey,
  hashTranslationBlockSource,
  type PageLayoutResult
} from '../reader/layout-analysis'
import type { LeftSourceInteractEvent } from '../reader/PdfViewer'
import { cleanSelectedQuoteText, samePageRects, type PageRect } from '../reader/pdf-geometry'
import {
  getBlockTranslationSourceText,
  hitTestPageSentence,
  isTranslatableBlock,
  matchSelectionRegionsToSentences
} from './sentence-alignment'
import type { TargetSentenceSelection } from './TranslationPanel'

export interface ActiveSentenceLink {
  pageNumber: number
  sentenceIds: string[]
  blockKeys: string[]
  sourceRects: PageRect[]
  sentenceRects?: PageRect[]
  selectedText?: string
  origin: 'left' | 'right'
  suppressLeftOverlay: boolean
}

export type SentenceLinkStep =
  | { kind: 'noop' }
  | { kind: 'clear' }
  | { kind: 'unchanged'; fromSelection: boolean }
  | { kind: 'set'; link: ActiveSentenceLink }

export function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, idx) => v === b[idx])
}

export function isSamePageLayout(existing: PageLayoutResult | undefined, next: PageLayoutResult): boolean {
  return Boolean(
    existing &&
      existing.hasText === next.hasText &&
      existing.blocks.length === next.blocks.length &&
      existing.sentences.length === next.sentences.length &&
      existing.filteredItems.length === next.filteredItems.length &&
      existing.sentences[0]?.id === next.sentences[0]?.id &&
      existing.sentences[existing.sentences.length - 1]?.id === next.sentences[next.sentences.length - 1]?.id
  )
}

export function mergePageTranslationRecords(
  prev: Map<number, Map<string, TranslatedBlockRecord>>,
  pageNumber: number,
  items: readonly TranslatedBlockRecord[]
): Map<number, Map<string, TranslatedBlockRecord>> {
  const next = new Map(prev)
  const pageMap = new Map(next.get(pageNumber) ?? [])
  for (const row of items) {
    pageMap.set(row.blockId, row)
  }
  next.set(pageNumber, pageMap)
  return next
}

export function buildPageTranslationInputs(layout: PageLayoutResult | undefined): TranslationBlockInput[] {
  if (!layout || !layout.hasText) return []
  const blocks: TranslationBlockInput[] = []
  for (const block of layout.blocks) {
    if (!isTranslatableBlock(block)) continue
    const sourceText = getBlockTranslationSourceText(block)
    if (!sourceText) continue
    blocks.push({
      blockId: computeStableTranslationBlockKey(block),
      kind: block.kind,
      sourceText,
      sourceHash: hashTranslationBlockSource(sourceText)
    })
  }
  return blocks
}

export function buildSingleBlockTranslationInput(
  layout: PageLayoutResult | undefined,
  blockKey: string
): TranslationBlockInput | null {
  if (!layout) return null
  const targetBlock = layout.blocks.find(
    block => isTranslatableBlock(block) && computeStableTranslationBlockKey(block) === blockKey
  )
  if (!targetBlock || !isTranslatableBlock(targetBlock)) return null
  const sourceText = getBlockTranslationSourceText(targetBlock)
  if (!sourceText) return null
  return {
    blockId: blockKey,
    kind: targetBlock.kind,
    sourceText,
    sourceHash: hashTranslationBlockSource(sourceText)
  }
}

export function reduceLeftSourceInteract(
  prev: ActiveSentenceLink | null,
  event: LeftSourceInteractEvent,
  layouts: ReadonlyMap<number, PageLayoutResult>
): SentenceLinkStep {
  if (event.type === 'clear') {
    return { kind: 'clear' }
  }
  if (event.type === 'point') {
    const hit = hitTestPageSentence(layouts.get(event.pageNumber), event.pdfPoint)
    if (!hit) {
      return { kind: 'clear' }
    }
    const nextIds = [hit.sentence.id]
    const nextBlocks = [hit.blockKey]
    const nextRects = hit.sentence.rects.length > 0 ? hit.sentence.rects : [hit.block.bounds]
    if (
      prev &&
      prev.origin === 'left' &&
      !prev.suppressLeftOverlay &&
      prev.pageNumber === event.pageNumber &&
      sameStringList(prev.sentenceIds, nextIds)
    ) {
      return { kind: 'clear' }
    }
    return {
      kind: 'set',
      link: {
        pageNumber: event.pageNumber,
        sentenceIds: nextIds,
        blockKeys: nextBlocks,
        sourceRects: nextRects,
        sentenceRects: nextRects,
        origin: 'left',
        suppressLeftOverlay: false
      }
    }
  }
  const cleanedQuote = cleanSelectedQuoteText(event.selectedText) ?? undefined
  const matched = matchSelectionRegionsToSentences(layouts, event.regions, event.selectedText)
  const targetPageNumber = matched?.pageNumber ?? event.regions[0]?.pageNumber
  if (targetPageNumber === undefined) return { kind: 'noop' }
  const exactRects = event.regions
    .filter(region => region.pageNumber === targetPageNumber)
    .map(region => region.rect)
    .slice(0, 200)
  if (!matched && (!cleanedQuote || exactRects.length === 0)) return { kind: 'noop' }
  const nextSentenceIds = matched?.sentenceIds ?? []
  const nextBlockKeys = matched?.blockKeys ?? []
  const nextRects = exactRects.length > 0 ? exactRects : (matched?.sourceRects ?? [])
  if (nextRects.length === 0) return { kind: 'noop' }
  const nextSentenceRects = matched?.sentenceRects ?? []
  const nextSuppressLeftOverlay = nextSentenceRects.length === 0

  if (
    prev &&
    prev.origin === 'left' &&
    prev.suppressLeftOverlay === nextSuppressLeftOverlay &&
    prev.pageNumber === targetPageNumber &&
    sameStringList(prev.sentenceIds, nextSentenceIds) &&
    prev.selectedText === cleanedQuote &&
    samePageRects(prev.sourceRects, nextRects) &&
    samePageRects(prev.sentenceRects ?? [], nextSentenceRects)
  ) {
    return { kind: 'unchanged', fromSelection: true }
  }
  return {
    kind: 'set',
    link: {
      pageNumber: targetPageNumber,
      sentenceIds: nextSentenceIds,
      blockKeys: nextBlockKeys,
      sourceRects: nextRects,
      sentenceRects: nextSentenceRects,
      selectedText: cleanedQuote,
      origin: 'left',
      suppressLeftOverlay: nextSuppressLeftOverlay
    }
  }
}

export function reduceRightSentenceSelect(
  prev: ActiveSentenceLink | null,
  selection: TargetSentenceSelection | null
): SentenceLinkStep {
  if (!selection) {
    return { kind: 'clear' }
  }
  if (
    selection.toggleIfSame &&
    prev &&
    !prev.suppressLeftOverlay &&
    prev.pageNumber === selection.pageNumber &&
    sameStringList(prev.sentenceIds, selection.sentenceIds)
  ) {
    return { kind: 'clear' }
  }
  if (
    !selection.toggleIfSame &&
    prev &&
    prev.origin === 'right' &&
    !prev.suppressLeftOverlay &&
    prev.pageNumber === selection.pageNumber &&
    sameStringList(prev.sentenceIds, selection.sentenceIds)
  ) {
    return { kind: 'unchanged', fromSelection: true }
  }
  return {
    kind: 'set',
    link: {
      pageNumber: selection.pageNumber,
      sentenceIds: selection.sentenceIds,
      blockKeys: selection.blockKeys,
      sourceRects: selection.sourceRects,
      sentenceRects: selection.sourceRects,
      origin: 'right',
      suppressLeftOverlay: false
    }
  }
}

export function scrollOppositePaneToActiveLink(
  activeLink: ActiveSentenceLink,
  pdfScrollEl: HTMLElement | null,
  translationScrollEl: HTMLElement | null
): void {
  if (activeLink.origin === 'left' && translationScrollEl) {
    const target =
      translationScrollEl.querySelector<HTMLElement>(
        `.translation-page[data-page-number="${activeLink.pageNumber}"] .translation-overlay-sentence.is-active`
      ) ??
      translationScrollEl.querySelector<HTMLElement>(
        `.translation-page[data-page-number="${activeLink.pageNumber}"] .translation-mirror-sentence.is-active`
      )
    if (target) {
      const rootRect = translationScrollEl.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      if (targetRect.bottom <= rootRect.top || targetRect.top >= rootRect.bottom) {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }
  } else if (activeLink.origin === 'right' && pdfScrollEl) {
    const source = pdfScrollEl.querySelector<HTMLElement>(
      `.pdf-page[data-page-number="${activeLink.pageNumber}"] .pdf-sentence-highlight`
    )
    if (source) {
      const rootRect = pdfScrollEl.getBoundingClientRect()
      const sourceRect = source.getBoundingClientRect()
      if (sourceRect.bottom <= rootRect.top || sourceRect.top >= rootRect.bottom) {
        source.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }
  }
}
