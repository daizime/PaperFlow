import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AnnotationRecord,
  TranslatePageResult,
  TranslatedBlockRecord
} from '../../../../shared/contracts'
import {
  computeStableTranslationBlockKey,
  refineDocumentHeadersFooters,
  type PageLayoutResult
} from '../reader/layout-analysis'
import type { LeftSourceInteractEvent, PageBackdropSnapshot, ReaderMirrorState } from '../reader/PdfViewer'
import { type PageRect } from '../reader/pdf-geometry'
import type { SplitPaneViewMode } from '../reader/split-panes'
import {
  buildPageTranslationInputs,
  buildSingleBlockTranslationInput,
  isSamePageLayout,
  mergePageTranslationRecords,
  reduceLeftSourceInteract,
  reduceRightSentenceSelect,
  scrollOppositePaneToActiveLink,
  type ActiveSentenceLink
} from './pane-translation-helpers'
import { buildPageTranslationContext } from './translation-context'
import { hitTestPageSentence, matchSelectionRegionsToSentences } from './sentence-alignment'
import { countTranslatedBlocks, type TargetSentenceSelection } from './TranslationPanel'
import { useDualScrollSync } from './useDualScrollSync'
import { normalizeTranslationPages, sameTranslationPages } from './translation-viewport'

export type ActivePaneSentenceLink = ActiveSentenceLink

export interface UsePaneTranslationOptions {
  documentId: string
  mirror: ReaderMirrorState
  viewMode: SplitPaneViewMode
  translationRevision: number
  externalTranslatingPage?: number | null
  onTranslatingPageChange?(docId: string, pageNumber: number | null): void
  onTranslationComplete?(docId: string, result: TranslatePageResult): void
  onTranslationError?(docId: string, message: string): void
  onRightDrivingLeft?: () => void
}

export function usePaneTranslation({
  documentId,
  mirror,
  viewMode,
  translationRevision,
  externalTranslatingPage = null,
  onTranslatingPageChange,
  onTranslationComplete,
  onTranslationError,
  onRightDrivingLeft
}: UsePaneTranslationOptions) {
  const [rawLayouts, setRawLayouts] = useState<Map<number, PageLayoutResult>>(() => new Map())
  const [backdrops, setBackdrops] = useState<Map<number, PageBackdropSnapshot>>(() => new Map())
  const [translationsByPage, setTranslationsByPage] = useState<Map<number, Map<string, TranslatedBlockRecord>>>(() => new Map())
  const [localTranslatingPage, setLocalTranslatingPage] = useState<number | null>(null)
  const translatingPage = localTranslatingPage ?? externalTranslatingPage ?? null
  const [retranslatingBlockKeys, setRetranslatingBlockKeys] = useState<Set<string>>(() => new Set())
  const [translationError, setTranslationError] = useState<string | null>(null)
  const [scrollSyncLocked, setScrollSyncLocked] = useState(true)
  const [pdfScrollEl, setPdfScrollEl] = useState<HTMLDivElement | null>(null)
  const [translationScrollEl, setTranslationScrollEl] = useState<HTMLDivElement | null>(null)
  const [activeLink, setActiveLink] = useState<ActivePaneSentenceLink | null>(null)
  const [visiblePageNumbers, setVisiblePageNumbers] = useState<readonly number[]>([])

  const documentIdRef = useRef(documentId)
  documentIdRef.current = documentId
  const translatingPageRef = useRef<number | null>(translatingPage)
  translatingPageRef.current = translatingPage
  const backdropMapRef = useRef<Map<number, PageBackdropSnapshot>>(new Map())
  const queriedCachePagesRef = useRef<Set<number>>(new Set())
  const layoutsRef = useRef<Map<number, PageLayoutResult>>(new Map())
  const translationsByPageRef = useRef<Map<number, Map<string, TranslatedBlockRecord>>>(new Map())
  translationsByPageRef.current = translationsByPage

  const clearAllBackdrops = useCallback((): void => {
    for (const snap of backdropMapRef.current.values()) {
      snap.bitmap.close()
    }
    backdropMapRef.current.clear()
    setBackdrops(new Map())
  }, [])

  useEffect(() => {
    queriedCachePagesRef.current.clear()
    setRawLayouts(new Map())
    clearAllBackdrops()
    setTranslationsByPage(new Map())
    setLocalTranslatingPage(null)
    setRetranslatingBlockKeys(new Set())
    setTranslationError(null)
    setActiveLink(null)
    setVisiblePageNumbers([])

    return () => {
      // 切换或关闭分栏时保留主进程正在执行的整页翻译任务，让其继续写完 SQLite 缓存
      clearAllBackdrops()
    }
  }, [documentId, clearAllBackdrops])

  useEffect(() => {
    return window.paperflow.onTranslationProgress(event => {
      if (documentIdRef.current !== event.documentId || event.items.length === 0) return
      setTranslationsByPage(prev => mergePageTranslationRecords(prev, event.pageNumber, event.items))
    })
  }, [])

  const handleVisiblePagesChange = useCallback((pages: readonly number[]): void => {
    const normalized = normalizeTranslationPages(pages, mirror.pageCount)
    setVisiblePageNumbers(previous => sameTranslationPages(previous, normalized) ? previous : normalized)
  }, [mirror.pageCount])

  const loadPageCache = useCallback(async (targetDocId: string, pageNumber: number): Promise<void> => {
    try {
      const records = await window.paperflow.getPageTranslations(targetDocId, pageNumber)
      if (documentIdRef.current !== targetDocId || records.length === 0) return
      setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, records))
    } catch {
      // 忽略页面切换瞬间的缓存读取错误
    }
  }, [])

  useEffect(() => {
    if (translationRevision <= 0) return
    queriedCachePagesRef.current.clear()
    setTranslationsByPage(new Map())
    setTranslationError(null)
    if (viewMode !== 'source' && mirror.pageCount > 0) {
      const minPage = Math.max(1, mirror.currentPage - 1)
      const maxPage = Math.min(mirror.pageCount, mirror.currentPage + 1)
      for (const p of new Set([...visiblePageNumbers, ...Array.from({ length: maxPage - minPage + 1 }, (_, index) => minPage + index)])) {
        queriedCachePagesRef.current.add(p)
        void loadPageCache(documentId, p)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationRevision])

  useEffect(() => {
    setTranslationError(null)
  }, [mirror.currentPage])

  useEffect(() => {
    if (viewMode === 'source' || !documentId || mirror.pageCount <= 0) return
    const minPage = Math.max(1, mirror.currentPage - 1)
    const maxPage = Math.min(mirror.pageCount, mirror.currentPage + 1)
    for (const p of new Set([...visiblePageNumbers, ...Array.from({ length: maxPage - minPage + 1 }, (_, index) => minPage + index)])) {
      if (!queriedCachePagesRef.current.has(p)) {
        queriedCachePagesRef.current.add(p)
        void loadPageCache(documentId, p)
      }
    }
  }, [viewMode, documentId, mirror.currentPage, mirror.pageCount, visiblePageNumbers, loadPageCache])

  const layouts = useMemo(() => refineDocumentHeadersFooters(rawLayouts), [rawLayouts])
  layoutsRef.current = layouts

  const handlePageLayout = useCallback((pageNumber: number, result: PageLayoutResult | null): void => {
    if (!result) return
    setRawLayouts(prev => {
      if (isSamePageLayout(prev.get(pageNumber), result)) {
        return prev
      }
      const next = new Map(prev)
      next.set(pageNumber, result)
      return next
    })
  }, [])

  const handlePageBackdrop = useCallback((pageNumber: number, snapshot: PageBackdropSnapshot | null): void => {
    const existing = backdropMapRef.current.get(pageNumber)
    if (existing && existing.bitmap !== snapshot?.bitmap) {
      existing.bitmap.close()
    }
    if (snapshot) {
      backdropMapRef.current.set(pageNumber, snapshot)
    } else {
      backdropMapRef.current.delete(pageNumber)
    }
    setBackdrops(new Map(backdropMapRef.current))
  }, [])

  const handleTranslatePage = useCallback(
    async (pageNumber: number, force = false): Promise<void> => {
      const targetDocId = documentId
      if (!targetDocId) return
      const blocks = buildPageTranslationInputs(layoutsRef.current.get(pageNumber))
      if (blocks.length === 0) return

      setTranslationError(null)
      setLocalTranslatingPage(pageNumber)
      onTranslatingPageChange?.(targetDocId, pageNumber)
      try {
        const context = buildPageTranslationContext(
          layoutsRef.current,
          pageNumber,
          translationsByPageRef.current
        )
        const result = await window.paperflow.translatePage({
          documentId: targetDocId,
          pageNumber,
          blocks,
          force,
          ...(context ? { context } : {})
        })
        onTranslationComplete?.(targetDocId, result)
        if (documentIdRef.current !== targetDocId) return
        setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, result.items))
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/已取消/.test(message)) {
          onTranslationError?.(targetDocId, message)
        }
        if (documentIdRef.current === targetDocId) {
          void loadPageCache(targetDocId, pageNumber)
          if (!/已取消/.test(message)) {
            setTranslationError(message)
          }
        }
      } finally {
        onTranslatingPageChange?.(targetDocId, null)
        if (documentIdRef.current === targetDocId) {
          setLocalTranslatingPage(curr => (curr === pageNumber ? null : curr))
        }
      }
    },
    [documentId, loadPageCache, onTranslatingPageChange, onTranslationComplete, onTranslationError]
  )

  const handleRetranslateBlock = useCallback(
    async (pageNumber: number, blockKey: string): Promise<void> => {
      const targetDocId = documentId
      if (!targetDocId) return
      const input = buildSingleBlockTranslationInput(layoutsRef.current.get(pageNumber), blockKey)
      if (!input) return

      setTranslationError(null)
      setRetranslatingBlockKeys(prev => {
        const next = new Set(prev)
        next.add(blockKey)
        return next
      })
      try {
        const context = buildPageTranslationContext(
          layoutsRef.current,
          pageNumber,
          translationsByPageRef.current,
          blockKey
        )
        const result = await window.paperflow.translatePage({
          documentId: targetDocId,
          pageNumber,
          blocks: [input],
          force: true,
          ...(context ? { context } : {})
        })
        onTranslationComplete?.(targetDocId, result)
        if (documentIdRef.current !== targetDocId) return
        setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, result.items))
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/已取消/.test(message)) {
          onTranslationError?.(targetDocId, message)
        }
        if (documentIdRef.current === targetDocId) {
          if (!/已取消/.test(message)) {
            setTranslationError(message)
          }
        }
      } finally {
        setRetranslatingBlockKeys(prev => {
          const next = new Set(prev)
          next.delete(blockKey)
          return next
        })
      }
    },
    [documentId, onTranslationComplete, onTranslationError]
  )

  const handleCancelTranslation = useCallback((): void => {
    void window.paperflow.cancelTranslation(documentId).catch(() => {})
    setLocalTranslatingPage(null)
    onTranslatingPageChange?.(documentId, null)
  }, [documentId, onTranslatingPageChange])

  const handleEditBlockTranslation = useCallback(
    async (pageNumber: number, blockKey: string, sourceHash: string, translatedText: string): Promise<void> => {
      const targetDocId = documentId
      if (!targetDocId) return
      const updated = await window.paperflow.updateBlockTranslation({
        documentId: targetDocId,
        pageNumber,
        blockId: blockKey,
        sourceHash,
        translatedText
      })
      if (documentIdRef.current !== targetDocId) return
      setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, [updated]))
    },
    [documentId]
  )

  const highlightAnnotation = useCallback((annotation: AnnotationRecord): void => {
    const layout = layoutsRef.current.get(annotation.pageNumber)
    let resolvedSentenceIds = [...annotation.sentenceIds]
    const matchedBlockKeys = new Set<string>()
    const matchedSentenceRects: PageRect[] = []
    if (layout && resolvedSentenceIds.length === 0 && annotation.rects.length > 0) {
      const recovered = matchSelectionRegionsToSentences(
        new Map([[annotation.pageNumber, layout]]),
        annotation.rects.map(rect => ({ pageNumber: annotation.pageNumber, rect })),
        annotation.quoteText
      )
      if (recovered && recovered.sentenceIds.length > 0) {
        resolvedSentenceIds = [...recovered.sentenceIds]
      } else {
        const firstRect = annotation.rects[0]
        const hit = hitTestPageSentence(
          layout,
          { x: firstRect.x + firstRect.width / 2, y: firstRect.y + firstRect.height / 2 },
          18
        )
        if (hit) resolvedSentenceIds = [hit.sentence.id]
      }
    }
    if (layout && resolvedSentenceIds.length > 0) {
      const targetIds = new Set(resolvedSentenceIds)
      for (const block of layout.blocks) {
        if (block.sentences.some(sentence => targetIds.has(sentence.id))) {
          matchedBlockKeys.add(computeStableTranslationBlockKey(block))
        }
      }
      for (const sentence of layout.sentences) {
        if (targetIds.has(sentence.id) && sentence.rects.length > 0) {
          matchedSentenceRects.push(...sentence.rects)
        }
      }
    }
    setActiveLink({
      pageNumber: annotation.pageNumber,
      sentenceIds: resolvedSentenceIds,
      blockKeys: Array.from(matchedBlockKeys),
      sourceRects: annotation.rects.map(({ x, y, width, height }) => ({ x, y, width, height })),
      sentenceRects: matchedSentenceRects.length > 0 ? matchedSentenceRects : undefined,
      selectedText: annotation.quoteText,
      origin: 'right',
      suppressLeftOverlay: false
    })
  }, [])

  const syncPostHighlightSentence = useCallback(
    (info: {
      pageNumber: number
      sentenceIds: string[]
      blockKeys: string[]
      sourceRects: PageRect[]
      sentenceRects: PageRect[]
      selectedText?: string
    }): void => {
      setActiveLink({
        pageNumber: info.pageNumber,
        sentenceIds: info.sentenceIds,
        blockKeys: info.blockKeys,
        sourceRects: info.sourceRects,
        sentenceRects: info.sentenceRects.length > 0 ? info.sentenceRects : undefined,
        selectedText: info.selectedText,
        origin: 'left',
        suppressLeftOverlay: true
      })
    },
    []
  )

  const highlightOutlineBlock = useCallback((pageNumber: number, block: PageLayoutResult['blocks'][number]): void => {
    const sentenceIds = block.sentences.map(sentence => sentence.id)
    const blockRects = block.sentences.flatMap(sentence => sentence.rects)
    const nextSentenceRects = blockRects.length > 0 ? blockRects : [block.bounds]
    setActiveLink({
      pageNumber,
      sentenceIds,
      blockKeys: [computeStableTranslationBlockKey(block)],
      sourceRects: nextSentenceRects,
      sentenceRects: nextSentenceRects,
      origin: 'right',
      suppressLeftOverlay: false
    })
  }, [])

  const clearSelection = useCallback((): void => {
    setActiveLink(null)
  }, [])

  const handleLeftSourceInteract = useCallback((event: LeftSourceInteractEvent): void => {
    setActiveLink(prev => {
      const step = reduceLeftSourceInteract(prev, event, layoutsRef.current)
      if (step.kind === 'clear') return null
      if (step.kind === 'set') return step.link
      return prev
    })
  }, [])

  const handleRightSentenceSelect = useCallback((selection: TargetSentenceSelection | null): void => {
    setActiveLink(prev => {
      const step = reduceRightSentenceSelect(prev, selection)
      if (step.kind === 'clear') return null
      if (step.kind === 'set') return step.link
      return prev
    })
  }, [])

  const { syncRightToLeft } = useDualScrollSync({
    leftEl: pdfScrollEl,
    rightEl: viewMode === 'dual' ? translationScrollEl : null,
    locked: scrollSyncLocked && viewMode === 'dual',
    onRightDrivingLeft
  })

  const pageSizeCount = Object.keys(mirror.pageSizes).length
  const pageInsetCount = Object.keys(mirror.pageInsets).length

  useLayoutEffect(() => {
    if (!scrollSyncLocked || viewMode !== 'dual' || !pdfScrollEl || !translationScrollEl || mirror.pageCount <= 0) {
      return
    }
    syncRightToLeft(true)
  }, [
    scrollSyncLocked,
    viewMode,
    pdfScrollEl,
    translationScrollEl,
    mirror.pageCount,
    mirror.scale,
    mirror.cropMargins,
    mirror.headerOffsetPx,
    pageSizeCount,
    pageInsetCount,
    syncRightToLeft
  ])

  const currentLayout = layouts.get(mirror.currentPage)
  const currentCache = translationsByPage.get(mirror.currentPage)
  const currentProgress = countTranslatedBlocks(currentLayout, currentCache)
  const isCurrentNoText =
    mirror.pageTextStatus[mirror.currentPage] === false ||
    (currentLayout !== undefined && !currentLayout.hasText)
  const isCurrentFullyTranslated =
    currentProgress.total > 0 && currentProgress.translated === currentProgress.total

  const activeSentenceIds = useMemo(() => new Set(activeLink?.sentenceIds ?? []), [activeLink])
  const activeSourceSentence = useMemo(
    () =>
      activeLink && !activeLink.suppressLeftOverlay
        ? {
            pageNumber: activeLink.pageNumber,
            rects:
              activeLink.sentenceRects && activeLink.sentenceRects.length > 0
                ? activeLink.sentenceRects
                : activeLink.sourceRects
          }
        : null,
    [activeLink]
  )

  useEffect(() => {
    if (!activeLink || scrollSyncLocked || viewMode !== 'dual') return
    const rafId = window.requestAnimationFrame(() => {
      scrollOppositePaneToActiveLink(activeLink, pdfScrollEl, translationScrollEl)
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [activeLink, scrollSyncLocked, viewMode, pdfScrollEl, translationScrollEl])

  return {
    visiblePageNumbers,
    handleVisiblePagesChange,
    layouts,
    backdrops,
    translationsByPage,
    translatingPage,
    retranslatingBlockKeys,
    translationError,
    scrollSyncLocked,
    setScrollSyncLocked,
    pdfScrollEl,
    setPdfScrollEl,
    translationScrollEl,
    setTranslationScrollEl,
    setTranslationError,
    activeLink,
    activeSentenceIds,
    activeSourceSentence,
    currentLayout,
    currentProgress,
    isCurrentNoText,
    isCurrentFullyTranslated,
    handlePageLayout,
    handlePageBackdrop,
    handleTranslatePage,
    handleRetranslateBlock,
    handleEditBlockTranslation,
    handleCancelTranslation,
    handleLeftSourceInteract,
    handleRightSentenceSelect,
    highlightOutlineBlock,
    highlightAnnotation,
    syncPostHighlightSentence,
    clearSelection
  }
}
