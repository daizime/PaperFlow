import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import type { FirstPageCitationSource } from '../../shared/citation'
import type {
  AnnotationColor,
  AnnotationRecord,
  ExplainMode,
  TranslatedBlockRecord,
  TranslationBlockInput,
  TranslationSettings
} from '../../shared/contracts'
import {
  countTranslatedBlocks,
  LockIcon,
  TranslationPanel,
  type BatchQueueProgress,
  type TargetSentenceSelection
} from './features/translation/TranslationPanel'
import { TranslationSettingsModal } from './features/translation/TranslationSettingsModal'
import {
  SelectionCompanionBar,
  type ExplainCardState,
  type ReferencePeekState,
  type SelectionCompanionState
} from './features/study/SelectionCompanionBar'
import { AnnotationsDrawer } from './features/study/AnnotationsDrawer'
import { CitationModal } from './features/study/CitationModal'
import { ShortcutsModal } from './features/study/ShortcutsModal'
import {
  extractReferenceTargets,
  findReferenceMatchInPages,
  type ReferencePeekMatch,
  type ReferencePageSource,
  type ReferenceTarget
} from './features/study/reference-peek'
import './assets/themes.css'
import {
  getBlockTranslationSourceText,
  hitTestPageSentence,
  isTranslatableBlock,
  matchSelectionRegionsToSentences
} from './features/translation/sentence-alignment'
import { useDualScrollSync } from './features/translation/useDualScrollSync'
import { LibraryPanel } from './features/library/LibraryPanel'
import { useLibrary } from './features/library/useLibrary'
import { ReaderToolbar } from './features/reader/ReaderToolbar'
import {
  computeStableTranslationBlockKey,
  hashTranslationBlockSource,
  refineDocumentHeadersFooters,
  type PageLayoutResult
} from './features/reader/layout-analysis'
import type { PageRect } from './features/reader/pdf-geometry'
import type { PdfOutlineItem } from './features/reader/pdf-outline'
import {
  PdfViewer,
  type LeftSourceInteractEvent,
  type PageBackdropSnapshot,
  type ReaderMirrorState,
  type ReaderToolbarActions
} from './features/reader/PdfViewer'

interface ActiveSentenceLink {
  pageNumber: number
  sentenceIds: string[]
  blockKeys: string[]
  sourceRects: PageRect[]
  origin: 'left' | 'right'
  suppressLeftOverlay: boolean
}

type ReadingTheme = 'light' | 'sepia' | 'dark'
type ReaderViewMode = 'source' | 'dual' | 'translation'

const THEME_STORAGE_KEY = 'paperflow:theme'

const THEME_OPTIONS: Array<{ id: ReadingTheme; label: string }> = [
  { id: 'light', label: '明亮' },
  { id: 'sepia', label: '护眼' },
  { id: 'dark', label: '深色' }
]

const INITIAL_MIRROR_STATE: ReaderMirrorState = {
  pageCount: 0,
  currentPage: 1,
  scale: 1,
  cropMargins: false,
  estimatedSize: { width: 612, height: 792 },
  pageSizes: {},
  pageInsets: {},
  pageTextStatus: {},
  headerOffsetPx: 0,
  outlineOpen: false,
  searchOpen: false,
  toolbarDisabled: true
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true
  }
  return target instanceof HTMLElement && target.isContentEditable
}

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types ?? [])
  return types.includes('Files') || dataTransfer.files.length > 0
}

/** 提取版面块的原始可读纯文本（不含翻译阶段专用的 ⟪M1⟫ 公式占位符），用于题注速览、复制、目录匹配与 AI 上下文。 */
function getBlockPlainText(block: PageLayoutResult['blocks'][number]): string {
  return block.sentences
    .map(sentence => sentence.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export default function App(): React.JSX.Element {
  const library = useLibrary()
  const [dropActive, setDropActive] = useState(false)
  const [libraryCollapsed, setLibraryCollapsed] = useState(false)
  const [viewMode, setViewMode] = useState<ReaderViewMode>('dual')
  const [scrollSyncLocked, setScrollSyncLocked] = useState(true)
  const [pdfScrollEl, setPdfScrollEl] = useState<HTMLDivElement | null>(null)
  const [translationScrollEl, setTranslationScrollEl] = useState<HTMLDivElement | null>(null)
  const [mirrorState, setMirrorState] = useState<ReaderMirrorState>(INITIAL_MIRROR_STATE)
  const [rawLayouts, setRawLayouts] = useState<Map<number, PageLayoutResult>>(() => new Map())
  const [backdrops, setBackdrops] = useState<Map<number, PageBackdropSnapshot>>(() => new Map())
  const [translationsByPage, setTranslationsByPage] = useState<Map<number, Map<string, TranslatedBlockRecord>>>(() => new Map())
  const [translatingPage, setTranslatingPage] = useState<number | null>(null)
  const [batchQueue, setBatchQueue] = useState<BatchQueueProgress | null>(null)
  const [retranslatingBlockKeys, setRetranslatingBlockKeys] = useState<Set<string>>(() => new Set())
  const [translationError, setTranslationError] = useState<string | null>(null)
  const [translationSettings, setTranslationSettings] = useState<TranslationSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [citationOpen, setCitationOpen] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [activeLink, setActiveLink] = useState<ActiveSentenceLink | null>(null)
  const [dualSplitRatio, setDualSplitRatio] = useState<number | null>(null)
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([])
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [savingAnnotation, setSavingAnnotation] = useState(false)
  const [explainState, setExplainState] = useState<ExplainCardState | null>(null)
  const [peekState, setPeekState] = useState<ReferencePeekState | null>(null)
  const [peekPinned, setPeekPinned] = useState(false)
  const [returnPageNumber, setReturnPageNumber] = useState<number | null>(null)
  const [theme, setTheme] = useState<ReadingTheme>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return saved === 'sepia' || saved === 'dark' ? saved : 'light'
  })

  const dragDepthRef = useRef(0)
  const cancelNavigationRef = useRef<(() => void) | null>(null)
  const navigateToPageRef = useRef<((pageNumber: number) => void) | null>(null)
  const analyzePageRef = useRef<((pageNumber: number) => Promise<PageLayoutResult | null>) | null>(null)
  const extractPageTextRef = useRef<((pageNumber: number) => Promise<string | null>) | null>(null)
  const extractCitationSourceRef = useRef<(() => Promise<FirstPageCitationSource | null>) | null>(null)
  const renderRegionPreviewRef = useRef<
    | ((
        pageNumber: number,
        kind: 'figure' | 'table',
        captionBounds?: PageRect,
        obstacleBounds?: readonly PageRect[]
      ) => Promise<string | null>)
    | null
  >(null)
  const outlineRequestIdRef = useRef(0)
  const toolbarActionsRef = useRef<ReaderToolbarActions | null>(null)
  const batchQueueAbortRef = useRef(false)
  const explainRequestIdRef = useRef(0)
  const peekRequestIdRef = useRef(0)
  const pendingJumpRef = useRef<{ documentId: string; pageNumber: number } | null>(null)
  const explainAnchorRef = useRef<{ pageNumber: number; rects: PageRect[]; sentenceIds: string[] } | null>(null)
  const readerPanelRef = useRef<HTMLElement | null>(null)
  const workspaceRef = useRef<HTMLElement | null>(null)
  const backdropMapRef = useRef<Map<number, PageBackdropSnapshot>>(new Map())
  const queriedCachePagesRef = useRef<Set<number>>(new Set())
  const layoutsRef = useRef<Map<number, PageLayoutResult>>(new Map())
  const translationsByPageRef = useRef<Map<number, Map<string, TranslatedBlockRecord>>>(new Map())
  translationsByPageRef.current = translationsByPage

  const selectedDocumentId = library.selected?.id ?? null
  const selectedDocumentIdRef = useRef<string | null>(selectedDocumentId)
  selectedDocumentIdRef.current = selectedDocumentId

  useEffect(() => {
    let cancelled = false
    void window.paperflow
      .getTranslationSettings()
      .then(settings => {
        if (!cancelled) setTranslationSettings(settings)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const clearAllBackdrops = useCallback((): void => {
    for (const snap of backdropMapRef.current.values()) {
      snap.bitmap.close()
    }
    backdropMapRef.current.clear()
    setBackdrops(new Map())
  }, [])

  useEffect(() => {
    queriedCachePagesRef.current.clear()
    batchQueueAbortRef.current = true
    explainRequestIdRef.current += 1
    peekRequestIdRef.current += 1
    setRawLayouts(new Map())
    clearAllBackdrops()
    setTranslationsByPage(new Map())
    setTranslatingPage(null)
    setBatchQueue(null)
    setRetranslatingBlockKeys(new Set())
    setTranslationError(null)
    setActiveLink(null)
    setExplainState(null)
    setPeekState(null)
    setPeekPinned(false)
    setReturnPageNumber(null)
    setCitationOpen(false)
    outlineRequestIdRef.current += 1
    setAnnotations([])
    setAnnotationsOpen(false)
    setMirrorState(INITIAL_MIRROR_STATE)
    if (selectedDocumentId) {
      const targetId = selectedDocumentId
      void window.paperflow
        .listAnnotations(targetId)
        .then(items => {
          if (selectedDocumentIdRef.current === targetId) {
            setAnnotations(items)
          }
        })
        .catch(() => {})
    }
    return () => {
      batchQueueAbortRef.current = true
      if (selectedDocumentId) {
        void window.paperflow.cancelTranslation(selectedDocumentId).catch(() => {})
      }
      clearAllBackdrops()
    }
  }, [selectedDocumentId, clearAllBackdrops])

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  const updateLocalProgress = library.updateLocalProgress
  useEffect(() => {
    if (selectedDocumentId && mirrorState.pageCount > 0 && mirrorState.currentPage >= 1) {
      updateLocalProgress(selectedDocumentId, mirrorState.currentPage)
    }
  }, [selectedDocumentId, mirrorState.pageCount, mirrorState.currentPage, updateLocalProgress])

  useEffect(() => {
    const pending = pendingJumpRef.current
    if (!pending || pending.documentId !== selectedDocumentId || mirrorState.pageCount <= 0 || mirrorState.toolbarDisabled) {
      return
    }
    pendingJumpRef.current = null
    navigateToPageRef.current?.(pending.pageNumber)
  }, [selectedDocumentId, mirrorState.pageCount, mirrorState.toolbarDisabled])

  useEffect(() => {
    return window.paperflow.onTranslationProgress(event => {
      if (selectedDocumentIdRef.current !== event.documentId || event.items.length === 0) return
      setTranslationsByPage(prev => {
        const next = new Map(prev)
        const pageMap = new Map(next.get(event.pageNumber) ?? [])
        for (const row of event.items) {
          pageMap.set(row.blockId, row)
        }
        next.set(event.pageNumber, pageMap)
        return next
      })
    })
  }, [])

  const layouts = useMemo(() => refineDocumentHeadersFooters(rawLayouts), [rawLayouts])
  layoutsRef.current = layouts

  const handlePageLayout = useCallback((pageNumber: number, result: PageLayoutResult | null): void => {
    if (!result) return
    setRawLayouts(prev => {
      const existing = prev.get(pageNumber)
      if (
        existing &&
        existing.hasText === result.hasText &&
        existing.blocks.length === result.blocks.length &&
        existing.sentences.length === result.sentences.length &&
        existing.filteredItems.length === result.filteredItems.length &&
        existing.sentences[0]?.id === result.sentences[0]?.id &&
        existing.sentences[existing.sentences.length - 1]?.id === result.sentences[existing.sentences.length - 1]?.id
      ) {
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

  const loadPageCache = useCallback(async (documentId: string, pageNumber: number): Promise<void> => {
    try {
      const records = await window.paperflow.getPageTranslations(documentId, pageNumber)
      if (selectedDocumentIdRef.current !== documentId || records.length === 0) return
      setTranslationsByPage(prev => {
        const next = new Map(prev)
        const pageMap = new Map(next.get(pageNumber) ?? [])
        for (const row of records) {
          pageMap.set(row.blockId, row)
        }
        next.set(pageNumber, pageMap)
        return next
      })
    } catch {
      // 忽略页面切换瞬间的缓存读取错误
    }
  }, [])

  // 翻页时清理前一页遗留的翻译错误横幅，并预读邻近页 SQLite 缓存
  useEffect(() => {
    setTranslationError(null)
  }, [mirrorState.currentPage])

  useEffect(() => {
    if (!selectedDocumentId || mirrorState.pageCount <= 0) return
    const minPage = Math.max(1, mirrorState.currentPage - 1)
    const maxPage = Math.min(mirrorState.pageCount, mirrorState.currentPage + 1)
    for (let p = minPage; p <= maxPage; p += 1) {
      if (!queriedCachePagesRef.current.has(p)) {
        queriedCachePagesRef.current.add(p)
        void loadPageCache(selectedDocumentId, p)
      }
    }
  }, [selectedDocumentId, mirrorState.currentPage, mirrorState.pageCount, loadPageCache])

  const handleTranslatePage = useCallback(
    async (pageNumber: number, force = false): Promise<void> => {
      const targetDocumentId = selectedDocumentId
      if (!targetDocumentId) return
      const layout = layouts.get(pageNumber)
      if (!layout || !layout.hasText) return

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
      if (blocks.length === 0) return

      setTranslationError(null)
      setTranslatingPage(pageNumber)
      try {
        const result = await window.paperflow.translatePage({
          documentId: targetDocumentId,
          pageNumber,
          blocks,
          force
        })
        if (selectedDocumentIdRef.current !== targetDocumentId) return
        setTranslationsByPage(prev => {
          const next = new Map(prev)
          const pageMap = new Map(next.get(pageNumber) ?? [])
          for (const row of result.items) {
            pageMap.set(row.blockId, row)
          }
          next.set(pageNumber, pageMap)
          return next
        })
      } catch (err: unknown) {
        if (selectedDocumentIdRef.current === targetDocumentId) {
          void loadPageCache(targetDocumentId, pageNumber)
          const message = err instanceof Error ? err.message : String(err)
          if (!/已取消/.test(message)) {
            setTranslationError(message)
          }
        }
      } finally {
        if (selectedDocumentIdRef.current === targetDocumentId) {
          setTranslatingPage(curr => (curr === pageNumber ? null : curr))
        }
      }
    },
    [selectedDocumentId, layouts, loadPageCache]
  )

  const handleCancelTranslation = useCallback((): void => {
    batchQueueAbortRef.current = true
    setBatchQueue(null)
    void window.paperflow.cancelTranslation(selectedDocumentId ?? undefined).catch(() => {})
    setTranslatingPage(null)
  }, [selectedDocumentId])

  const buildPageBlockInputs = useCallback((layout: PageLayoutResult | undefined): TranslationBlockInput[] => {
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
  }, [])

  const handleRetranslateBlock = useCallback(
    async (pageNumber: number, blockKey: string): Promise<void> => {
      const targetDocumentId = selectedDocumentId
      if (!targetDocumentId) return
      const layout = layoutsRef.current.get(pageNumber)
      if (!layout) return
      const targetBlock = layout.blocks.find(
        block => isTranslatableBlock(block) && computeStableTranslationBlockKey(block) === blockKey
      )
      if (!targetBlock || targetBlock.kind === 'formula') return
      const sourceText = getBlockTranslationSourceText(targetBlock)
      if (!sourceText) return

      const input: TranslationBlockInput = {
        blockId: blockKey,
        kind: targetBlock.kind,
        sourceText,
        sourceHash: hashTranslationBlockSource(sourceText)
      }

      setTranslationError(null)
      setRetranslatingBlockKeys(prev => {
        const next = new Set(prev)
        next.add(blockKey)
        return next
      })
      try {
        const result = await window.paperflow.translatePage({
          documentId: targetDocumentId,
          pageNumber,
          blocks: [input],
          force: true
        })
        if (selectedDocumentIdRef.current !== targetDocumentId) return
        setTranslationsByPage(prev => {
          const next = new Map(prev)
          const pageMap = new Map(next.get(pageNumber) ?? [])
          for (const row of result.items) {
            pageMap.set(row.blockId, row)
          }
          next.set(pageNumber, pageMap)
          return next
        })
      } catch (err: unknown) {
        if (selectedDocumentIdRef.current === targetDocumentId) {
          const message = err instanceof Error ? err.message : String(err)
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
    [selectedDocumentId]
  )

  const handleTranslateBatch = useCallback(
    async (startPage: number): Promise<void> => {
      const targetDocumentId = selectedDocumentId
      const totalPageCount = mirrorState.pageCount
      if (!targetDocumentId || totalPageCount <= 0) return
      const clampedStart = Math.max(1, Math.min(startPage, totalPageCount))
      const pagesToProcess = totalPageCount - clampedStart + 1

      batchQueueAbortRef.current = false
      setTranslationError(null)
      setBatchQueue({
        currentPage: clampedStart,
        completedPages: 0,
        totalPages: pagesToProcess
      })

      try {
        for (let pageNumber = clampedStart; pageNumber <= totalPageCount; pageNumber += 1) {
          if (batchQueueAbortRef.current || selectedDocumentIdRef.current !== targetDocumentId) break
          setBatchQueue({
            currentPage: pageNumber,
            completedPages: pageNumber - clampedStart,
            totalPages: pagesToProcess
          })

          let layout = layoutsRef.current.get(pageNumber)
          if (!layout && analyzePageRef.current) {
            const analyzed = await analyzePageRef.current(pageNumber)
            if (analyzed) {
              handlePageLayout(pageNumber, analyzed)
              layout = analyzed
            }
          }
          if (batchQueueAbortRef.current || selectedDocumentIdRef.current !== targetDocumentId) break

          const blocks = buildPageBlockInputs(layout)
          if (blocks.length === 0) continue

          // 检查缓存：若所有块均已命中且无需重译，则跳过模型调用
          let pageMap = translationsByPageRef.current.get(pageNumber)
          if (!pageMap || pageMap.size < blocks.length) {
            const cachedRows = await window.paperflow
              .getPageTranslations(targetDocumentId, pageNumber)
              .catch(() => [] as TranslatedBlockRecord[])
            if (cachedRows.length > 0 && selectedDocumentIdRef.current === targetDocumentId) {
              const merged = new Map(pageMap ?? [])
              for (const row of cachedRows) merged.set(row.blockId, row)
              pageMap = merged
              setTranslationsByPage(prev => {
                const next = new Map(prev)
                next.set(pageNumber, merged)
                return next
              })
            }
          }

          const allCached = blocks.every(block => {
            const cached = pageMap?.get(block.blockId)
            return Boolean(cached && cached.sourceHash === block.sourceHash && cached.translatedText.trim().length > 0)
          })
          if (allCached) continue

          setTranslatingPage(pageNumber)
          const result = await window.paperflow.translatePage({
            documentId: targetDocumentId,
            pageNumber,
            blocks,
            force: false
          })
          if (selectedDocumentIdRef.current !== targetDocumentId) break
          setTranslationsByPage(prev => {
            const next = new Map(prev)
            const nextPageMap = new Map(next.get(pageNumber) ?? [])
            for (const row of result.items) {
              nextPageMap.set(row.blockId, row)
            }
            next.set(pageNumber, nextPageMap)
            return next
          })
        }
      } catch (err: unknown) {
        if (selectedDocumentIdRef.current === targetDocumentId) {
          const message = err instanceof Error ? err.message : String(err)
          if (!/已取消/.test(message)) {
            setTranslationError(message)
          }
        }
      } finally {
        batchQueueAbortRef.current = true
        if (selectedDocumentIdRef.current === targetDocumentId) {
          setTranslatingPage(null)
          setBatchQueue(null)
        }
      }
    },
    [selectedDocumentId, mirrorState.pageCount, handlePageLayout, buildPageBlockInputs]
  )

  const sameStringList = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((v, idx) => v === b[idx])

  const handleLeftSourceInteract = useCallback(
    (event: LeftSourceInteractEvent): void => {
      if (event.type === 'clear') {
        setActiveLink(null)
        return
      }
      if (event.type === 'point') {
        const hit = hitTestPageSentence(layouts.get(event.pageNumber), event.pdfPoint)
        if (!hit) {
          setActiveLink(null)
          return
        }
        const nextIds = [hit.sentence.id]
        const nextBlocks = [hit.blockKey]
        const nextRects = hit.sentence.rects.length > 0 ? hit.sentence.rects : [hit.block.bounds]
        setActiveLink(prev => {
          if (
            prev &&
            prev.origin === 'left' &&
            !prev.suppressLeftOverlay &&
            prev.pageNumber === event.pageNumber &&
            sameStringList(prev.sentenceIds, nextIds)
          ) {
            return null
          }
          return {
            pageNumber: event.pageNumber,
            sentenceIds: nextIds,
            blockKeys: nextBlocks,
            sourceRects: nextRects,
            origin: 'left',
            suppressLeftOverlay: false
          }
        })
        return
      }
      const matched = matchSelectionRegionsToSentences(layouts, event.regions, event.selectedText)
      if (!matched) return
      setActiveLink(prev => {
        if (
          prev &&
          prev.origin === 'left' &&
          prev.suppressLeftOverlay &&
          prev.pageNumber === matched.pageNumber &&
          sameStringList(prev.sentenceIds, matched.sentenceIds)
        ) {
          return prev
        }
        return {
          pageNumber: matched.pageNumber,
          sentenceIds: matched.sentenceIds,
          blockKeys: matched.blockKeys,
          sourceRects: matched.sourceRects,
          origin: 'left',
          suppressLeftOverlay: true
        }
      })
    },
    [layouts]
  )

  const handleRightSentenceSelect = useCallback((selection: TargetSentenceSelection | null): void => {
    if (!selection) {
      setActiveLink(null)
      return
    }
    setActiveLink(prev => {
      if (
        selection.toggleIfSame &&
        prev &&
        !prev.suppressLeftOverlay &&
        prev.pageNumber === selection.pageNumber &&
        sameStringList(prev.sentenceIds, selection.sentenceIds)
      ) {
        return null
      }
      if (
        !selection.toggleIfSame &&
        prev &&
        prev.origin === 'right' &&
        !prev.suppressLeftOverlay &&
        prev.pageNumber === selection.pageNumber &&
        sameStringList(prev.sentenceIds, selection.sentenceIds)
      ) {
        return prev
      }
      return {
        pageNumber: selection.pageNumber,
        sentenceIds: selection.sentenceIds,
        blockKeys: selection.blockKeys,
        sourceRects: selection.sourceRects,
        origin: 'right',
        suppressLeftOverlay: false
      }
    })
  }, [])

  useEffect(() => {
    if (!activeLink || scrollSyncLocked || viewMode !== 'dual') return
    const rafId = window.requestAnimationFrame(() => {
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
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [activeLink, scrollSyncLocked, viewMode, pdfScrollEl, translationScrollEl])

  const activeSentenceIds = useMemo(() => new Set(activeLink?.sentenceIds ?? []), [activeLink])
  const activeSourceSentence = useMemo(
    () =>
      activeLink && !activeLink.suppressLeftOverlay
        ? { pageNumber: activeLink.pageNumber, rects: activeLink.sourceRects }
        : null,
    [activeLink]
  )

  const annotationsByPage = useMemo(() => {
    const map = new Map<number, AnnotationRecord[]>()
    for (const item of annotations) {
      const list = map.get(item.pageNumber)
      if (list) {
        list.push(item)
      } else {
        map.set(item.pageNumber, [item])
      }
    }
    return map
  }, [annotations])

  const selectionCompanion = useMemo((): SelectionCompanionState | null => {
    if (!activeLink || !selectedDocumentId) return null
    const layout = layouts.get(activeLink.pageNumber)
    if (!layout) return null
    const selectedSentences = layout.sentences.filter(sentence => activeSentenceIds.has(sentence.id))
    if (selectedSentences.length === 0) return null

    const quoteText = selectedSentences
      .map(sentence => sentence.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!quoteText) return null

    const blockKeySet = new Set(activeLink.blockKeys)
    const matchedBlocks = layout.blocks.filter(block => blockKeySet.has(computeStableTranslationBlockKey(block)))
    const contextText =
      matchedBlocks
        .map(block => getBlockPlainText(block))
        .filter(Boolean)
        .join('\n') || quoteText

    const isFormulaLikely =
      selectedSentences.some(sentence => sentence.blockKind === 'formula') ||
      matchedBlocks.some(block => block.kind === 'formula' || Boolean(block.inlineFormulas?.length))

    return {
      pageNumber: activeLink.pageNumber,
      quoteText,
      contextText,
      isFormulaLikely
    }
  }, [activeLink, selectedDocumentId, layouts, activeSentenceIds])

  const handleCreateHighlight = useCallback(
    async (color: AnnotationColor, note?: string): Promise<void> => {
      const targetDocumentId = selectedDocumentId
      if (!targetDocumentId || !activeLink || !selectionCompanion) return
      setSavingAnnotation(true)
      try {
        const created = await window.paperflow.createAnnotation({
          documentId: targetDocumentId,
          pageNumber: activeLink.pageNumber,
          color,
          quoteText: selectionCompanion.quoteText,
          note: note?.trim() ? note.trim() : undefined,
          rects: activeLink.sourceRects.map(({ x, y, width, height }) => ({ x, y, width, height })),
          sentenceIds: activeLink.sentenceIds
        })
        if (selectedDocumentIdRef.current !== targetDocumentId) return
        setAnnotations(prev => [...prev, created])
      } catch (err: unknown) {
        if (selectedDocumentIdRef.current === targetDocumentId) {
          setTranslationError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        setSavingAnnotation(false)
      }
    },
    [selectedDocumentId, activeLink, selectionCompanion]
  )

  const handleExplainSelection = useCallback(
    (mode: ExplainMode): void => {
      const targetDocumentId = selectedDocumentId
      if (!targetDocumentId || !selectionCompanion || !activeLink) return
      const requestId = explainRequestIdRef.current + 1
      explainRequestIdRef.current = requestId
      const snapshot = selectionCompanion
      explainAnchorRef.current = {
        pageNumber: activeLink.pageNumber,
        rects: activeLink.sourceRects.map(({ x, y, width, height }) => ({ x, y, width, height })),
        sentenceIds: [...activeLink.sentenceIds]
      }

      setExplainState({
        loading: true,
        mode,
        quoteText: snapshot.quoteText,
        pageNumber: snapshot.pageNumber,
        answer: null,
        error: null
      })

      void window.paperflow
        .explainSelection({
          documentId: targetDocumentId,
          pageNumber: snapshot.pageNumber,
          selectedText: snapshot.quoteText,
          contextText: snapshot.contextText,
          mode
        })
        .then(res => {
          if (selectedDocumentIdRef.current !== targetDocumentId || explainRequestIdRef.current !== requestId) {
            return
          }
          setExplainState({
            loading: false,
            mode: res.mode,
            quoteText: snapshot.quoteText,
            pageNumber: snapshot.pageNumber,
            answer: res.answer,
            error: null
          })
        })
        .catch((err: unknown) => {
          if (selectedDocumentIdRef.current !== targetDocumentId || explainRequestIdRef.current !== requestId) {
            return
          }
          setExplainState({
            loading: false,
            mode,
            quoteText: snapshot.quoteText,
            pageNumber: snapshot.pageNumber,
            answer: null,
            error: err instanceof Error ? err.message : String(err)
          })
        })
    },
    [selectedDocumentId, selectionCompanion, activeLink]
  )

  const handleSaveExplainAsNote = useCallback(async (): Promise<void> => {
    const targetDocumentId = selectedDocumentId
    if (!targetDocumentId || !explainState?.answer) return
    setSavingAnnotation(true)
    try {
      const fallbackAnchor =
        explainAnchorRef.current && explainAnchorRef.current.pageNumber === explainState.pageNumber
          ? explainAnchorRef.current
          : null
      const rects =
        activeLink && activeLink.pageNumber === explainState.pageNumber && activeLink.sourceRects.length > 0
          ? activeLink.sourceRects.map(({ x, y, width, height }) => ({ x, y, width, height }))
          : fallbackAnchor && fallbackAnchor.rects.length > 0
            ? fallbackAnchor.rects
            : [{ x: 0, y: 0, width: 1, height: 1 }]
      const sentenceIds =
        activeLink && activeLink.pageNumber === explainState.pageNumber
          ? activeLink.sentenceIds
          : (fallbackAnchor?.sentenceIds ?? [])
      const created = await window.paperflow.createAnnotation({
        documentId: targetDocumentId,
        pageNumber: explainState.pageNumber,
        color: 'blue',
        quoteText: explainState.quoteText,
        note: explainState.answer,
        rects,
        sentenceIds
      })
      if (selectedDocumentIdRef.current !== targetDocumentId) return
      setAnnotations(prev => [...prev, created])
    } catch (err: unknown) {
      if (selectedDocumentIdRef.current === targetDocumentId) {
        setTranslationError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSavingAnnotation(false)
    }
  }, [selectedDocumentId, explainState, activeLink])

  const handleUpdateAnnotation = useCallback(
    async (id: string, patch: { color?: AnnotationColor; note?: string }): Promise<void> => {
      const updated = await window.paperflow.updateAnnotation({ id, ...patch })
      setAnnotations(prev => prev.map(item => (item.id === id ? updated : item)))
    },
    []
  )

  const handleDeleteAnnotation = useCallback(async (id: string): Promise<void> => {
    await window.paperflow.deleteAnnotation(id)
    setAnnotations(prev => prev.filter(item => item.id !== id))
  }, [])

  const handleExportAnnotationsMarkdown = useCallback(async () => {
    if (!selectedDocumentId) return null
    return await window.paperflow.exportAnnotationsMarkdown(selectedDocumentId)
  }, [selectedDocumentId])

  const handleJumpToAnnotation = useCallback((annotation: AnnotationRecord): void => {
    navigateToPageRef.current?.(annotation.pageNumber)
    const layout = layoutsRef.current.get(annotation.pageNumber)
    const matchedBlockKeys = new Set<string>()
    if (layout && annotation.sentenceIds.length > 0) {
      const targetIds = new Set(annotation.sentenceIds)
      for (const block of layout.blocks) {
        if (block.sentences.some(sentence => targetIds.has(sentence.id))) {
          matchedBlockKeys.add(computeStableTranslationBlockKey(block))
        }
      }
    }
    setActiveLink({
      pageNumber: annotation.pageNumber,
      sentenceIds: annotation.sentenceIds,
      blockKeys: Array.from(matchedBlockKeys),
      sourceRects: annotation.rects.map(({ x, y, width, height }) => ({ x, y, width, height })),
      origin: 'right',
      suppressLeftOverlay: false
    })
  }, [])

  const referenceTargets = useMemo(
    () => (selectionCompanion ? extractReferenceTargets(selectionCompanion.quoteText) : []),
    [selectionCompanion]
  )

  const handlePeekReference = useCallback(
    (target: ReferenceTarget): void => {
      const targetDocId = selectedDocumentId
      if (!targetDocId) return
      const reqId = peekRequestIdRef.current + 1
      peekRequestIdRef.current = reqId
      const currentPage = mirrorState.currentPage
      const totalPages = mirrorState.pageCount

      const attachFigureThumbnail = async (baseMatch: ReferencePeekMatch): Promise<void> => {
        if (target.kind !== 'figure' && target.kind !== 'table') return
        const renderer = renderRegionPreviewRef.current
        if (!renderer) return
        let captionBounds = baseMatch.captionBounds
        let targetLayout = layoutsRef.current.get(baseMatch.pageNumber) ?? null
        if (!targetLayout && analyzePageRef.current) {
          const analyzed = await analyzePageRef.current(baseMatch.pageNumber).catch(() => null)
          if (selectedDocumentIdRef.current !== targetDocId || peekRequestIdRef.current !== reqId) return
          if (analyzed) {
            handlePageLayout(baseMatch.pageNumber, analyzed)
            targetLayout = analyzed
          }
        }
        if (!captionBounds && targetLayout) {
          const refined = findReferenceMatchInPages(
            target,
            new Map<number, ReferencePageSource>([
              [
                baseMatch.pageNumber,
                {
                  text: targetLayout.blocks.map(block => getBlockPlainText(block)).join('\n'),
                  blocks: targetLayout.blocks.map(block => ({
                    kind: block.kind,
                    text: getBlockPlainText(block),
                    bounds: block.bounds
                  }))
                }
              ]
            ]),
            currentPage
          )
          if (refined?.captionBounds) captionBounds = refined.captionBounds
        }
        // 提取同页正文段落与章节标题作为硬边界障碍，防止紧密排版下把上方/下方正文误裁进速览图
        const obstacleBounds = targetLayout
          ? targetLayout.blocks
              .filter(block => {
                if (block.kind === 'heading') return true
                if (block.kind !== 'paragraph') return false
                const textLen = getBlockPlainText(block).length
                const widthRatio = targetLayout!.naturalWidth > 0 ? block.displayBounds.width / targetLayout!.naturalWidth : 0
                return textLen >= 55 && widthRatio >= 0.28
              })
              .map(block => block.bounds)
          : undefined
        const imageDataUrl = await renderer(baseMatch.pageNumber, target.kind, captionBounds, obstacleBounds).catch(() => null)
        if (!imageDataUrl || selectedDocumentIdRef.current !== targetDocId || peekRequestIdRef.current !== reqId) {
          return
        }
        setPeekState(prev =>
          prev && prev.match
            ? {
                ...prev,
                match: { ...prev.match, captionBounds, imageDataUrl }
              }
            : prev
        )
      }

      const pageMap = new Map<number, ReferencePageSource>()
      for (const [pNum, layout] of layoutsRef.current.entries()) {
        pageMap.set(pNum, {
          text: layout.blocks.map(block => getBlockPlainText(block)).join('\n'),
          blocks: layout.blocks.map(block => ({
            kind: block.kind,
            text: getBlockPlainText(block),
            bounds: block.bounds
          }))
        })
      }

      const immediate = findReferenceMatchInPages(target, pageMap, currentPage)
      if (immediate) {
        setPeekState({ loading: false, target, match: immediate })
        void attachFigureThumbnail(immediate)
        return
      }

      setPeekState({ loading: true, target, match: null })
      void (async () => {
        const extractor = extractPageTextRef.current
        if (extractor && totalPages > 0) {
          const order =
            target.kind === 'citation'
              ? Array.from({ length: totalPages }, (_, i) => totalPages - i)
              : Array.from({ length: totalPages }, (_, i) => i + 1)

          for (const pNum of order) {
            if (selectedDocumentIdRef.current !== targetDocId || peekRequestIdRef.current !== reqId) return
            if (pageMap.has(pNum)) continue
            const text = await extractor(pNum)
            if (selectedDocumentIdRef.current !== targetDocId || peekRequestIdRef.current !== reqId) return
            if (!text) continue
            const singleMap = new Map<number, ReferencePageSource>([[pNum, { text }]])
            const found = findReferenceMatchInPages(target, singleMap, currentPage)
            if (found) {
              setPeekState({ loading: false, target, match: found })
              void attachFigureThumbnail(found)
              return
            }
          }
        }
        if (selectedDocumentIdRef.current === targetDocId && peekRequestIdRef.current === reqId) {
          setPeekState({ loading: false, target, match: null })
        }
      })()
    },
    [selectedDocumentId, mirrorState.currentPage, mirrorState.pageCount, handlePageLayout]
  )

  const handleJumpToPage = useCallback(
    (targetPage: number, fromPage?: number): void => {
      if (fromPage && fromPage !== targetPage) {
        setReturnPageNumber(fromPage)
      }
      navigateToPageRef.current?.(targetPage)
      if (viewMode === 'translation' && translationScrollEl) {
        translationScrollEl
          .querySelector<HTMLElement>(`.translation-page[data-page-number="${targetPage}"]`)
          ?.scrollIntoView({ block: 'start' })
      }
      setPeekState(null)
      setPeekPinned(false)
    },
    [viewMode, translationScrollEl]
  )

  // 未固定速览卡片：点击阅读正文区域或滚动超过 120px 时自动收起，省去每次手动点 ×
  useEffect(() => {
    if (!peekState || peekPinned) return
    const startPdfTop = pdfScrollEl?.scrollTop ?? 0
    const startTransTop = translationScrollEl?.scrollTop ?? 0

    const dismiss = (): void => {
      peekRequestIdRef.current += 1
      setPeekState(null)
    }

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      if (target.closest('.study-companion-dock')) return
      if (target.closest('.reader-panel') || target.closest('.translation-panel')) {
        dismiss()
      }
    }

    const onPdfScroll = (): void => {
      if (pdfScrollEl && Math.abs(pdfScrollEl.scrollTop - startPdfTop) > 120) {
        dismiss()
      }
    }

    const onTransScroll = (): void => {
      if (translationScrollEl && Math.abs(translationScrollEl.scrollTop - startTransTop) > 120) {
        dismiss()
      }
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    pdfScrollEl?.addEventListener('scroll', onPdfScroll, { passive: true })
    translationScrollEl?.addEventListener('scroll', onTransScroll, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      pdfScrollEl?.removeEventListener('scroll', onPdfScroll)
      translationScrollEl?.removeEventListener('scroll', onTransScroll)
    }
  }, [peekState, peekPinned, pdfScrollEl, translationScrollEl])

  // 点击目录标题：跳转目标页并同步在原文 / 双栏 / 译文中高亮定位该章节标题
  const handleOutlineNavigate = useCallback(
    (item: PdfOutlineItem): void => {
      const targetPage = item.pageNumber
      const targetDocId = selectedDocumentIdRef.current
      if (!targetPage || !targetDocId) return
      const reqId = ++outlineRequestIdRef.current

      const normalizeHeading = (value: string): string =>
        value
          .toLowerCase()
          .replace(/[\s\p{P}\p{S}]+/gu, ' ')
          .trim()

      const stripLeadingNum = (value: string): string =>
        value.replace(/^(?:\d+(?:\.\d+)*|[ivx]{1,4}|[a-z])\s+/i, '').trim()

      const pickMatchedBlock = (layout: PageLayoutResult) => {
        const wanted = normalizeHeading(item.title)
        const wantedBody = stripLeadingNum(wanted)
        if (!wanted) return null
        let bestBlock: PageLayoutResult['blocks'][number] | null = null
        let bestScore = 0
        for (const block of layout.blocks) {
          const text = normalizeHeading(getBlockPlainText(block))
          if (!text) continue
          const textBody = stripLeadingNum(text)
          let score = 0
          if (text === wanted) score = 100
          else if (wantedBody.length >= 3 && textBody === wantedBody) score = 92
          else if (text.startsWith(wanted) || wanted.startsWith(text)) score = 82
          else if (wantedBody.length >= 4 && (text.includes(wantedBody) || wantedBody.includes(textBody))) score = 68
          if (score > 0 && block.kind === 'heading') score += 20
          if (score > bestScore) {
            bestScore = score
            bestBlock = block
          }
        }
        return bestScore >= 68 ? bestBlock : null
      }

      const scrollHighlightIntoView = (pageNum: number, attempt = 0): void => {
        if (outlineRequestIdRef.current !== reqId || selectedDocumentIdRef.current !== targetDocId) return
        const leftHighlight = pdfScrollEl?.querySelector<HTMLElement>(
          `.pdf-page[data-page-number="${pageNum}"] .pdf-sentence-highlight`
        )
        const rightHighlight =
          translationScrollEl?.querySelector<HTMLElement>(
            `.translation-page[data-page-number="${pageNum}"] .translation-overlay-sentence.is-active`
          ) ??
          translationScrollEl?.querySelector<HTMLElement>(
            `.translation-page[data-page-number="${pageNum}"] .translation-mirror-sentence.is-active`
          )
        if (leftHighlight && pdfScrollEl) {
          const pageEl = pdfScrollEl.querySelector<HTMLElement>(`.pdf-page[data-page-number="${pageNum}"]`)
          const rootBox = pdfScrollEl.getBoundingClientRect()
          const hlBox = leftHighlight.getBoundingClientRect()
          const pageTopScroll = pageEl
            ? pdfScrollEl.scrollTop + (pageEl.getBoundingClientRect().top - rootBox.top - pdfScrollEl.clientTop)
            : 0
          const offsetFromTop = Math.min(96, pdfScrollEl.clientHeight * 0.16)
          const desired = pdfScrollEl.scrollTop + (hlBox.top - rootBox.top - pdfScrollEl.clientTop) - offsetFromTop
          const clamped = Math.max(
            pageTopScroll,
            Math.min(Math.max(0, pdfScrollEl.scrollHeight - pdfScrollEl.clientHeight), desired)
          )
          if (Math.abs(pdfScrollEl.scrollTop - clamped) > 4) {
            cancelNavigationRef.current?.()
            pdfScrollEl.scrollTop = clamped
          }
        }
        if (rightHighlight && translationScrollEl && (viewMode === 'translation' || !scrollSyncLocked)) {
          const pageEl = translationScrollEl.querySelector<HTMLElement>(`.translation-page[data-page-number="${pageNum}"]`)
          const rootBox = translationScrollEl.getBoundingClientRect()
          const hlBox = rightHighlight.getBoundingClientRect()
          const pageTopScroll = pageEl
            ? translationScrollEl.scrollTop + (pageEl.getBoundingClientRect().top - rootBox.top - translationScrollEl.clientTop)
            : 0
          const offsetFromTop = Math.min(96, translationScrollEl.clientHeight * 0.16)
          const desired =
            translationScrollEl.scrollTop + (hlBox.top - rootBox.top - translationScrollEl.clientTop) - offsetFromTop
          const clamped = Math.max(
            pageTopScroll,
            Math.min(Math.max(0, translationScrollEl.scrollHeight - translationScrollEl.clientHeight), desired)
          )
          if (Math.abs(translationScrollEl.scrollTop - clamped) > 4) {
            translationScrollEl.scrollTop = clamped
          }
        }
        if (!leftHighlight && !rightHighlight && attempt < 12) {
          window.setTimeout(() => scrollHighlightIntoView(pageNum, attempt + 1), 80)
        }
      }

      void (async () => {
        let layout = layoutsRef.current.get(targetPage) ?? null
        if (!layout && analyzePageRef.current) {
          layout = await analyzePageRef.current(targetPage).catch(() => null)
          if (layout && selectedDocumentIdRef.current === targetDocId) {
            handlePageLayout(targetPage, layout)
          }
        }
        if (!layout || selectedDocumentIdRef.current !== targetDocId || outlineRequestIdRef.current !== reqId) return
        const block = pickMatchedBlock(layout)
        if (!block) return
        const sentenceIds = block.sentences.map(s => s.id)
        const sourceRects = block.sentences.flatMap(s => s.rects)
        setActiveLink({
          pageNumber: targetPage,
          sentenceIds,
          blockKeys: [computeStableTranslationBlockKey(block)],
          sourceRects: sourceRects.length > 0 ? sourceRects : [block.bounds],
          origin: 'right',
          suppressLeftOverlay: false
        })
        window.requestAnimationFrame(() => scrollHighlightIntoView(targetPage, 0))
      })()
    },
    [handlePageLayout, pdfScrollEl, translationScrollEl, viewMode, scrollSyncLocked]
  )

  const handleReturnToPage = useCallback((): void => {
    if (returnPageNumber === null) return
    navigateToPageRef.current?.(returnPageNumber)
    setReturnPageNumber(null)
  }, [returnPageNumber])

  const selectDocument = library.select
  const handleJumpToSearchHit = useCallback(
    (documentId: string, pageNumber: number | null): void => {
      if (documentId !== selectedDocumentIdRef.current) {
        pendingJumpRef.current = pageNumber !== null ? { documentId, pageNumber } : null
        selectDocument(documentId)
        return
      }
      if (pageNumber !== null) {
        navigateToPageRef.current?.(pageNumber)
      }
    },
    [selectDocument]
  )

  const handleRightDrivingLeft = useCallback((): void => {
    cancelNavigationRef.current?.()
  }, [])

  const { syncRightToLeft } = useDualScrollSync({
    leftEl: pdfScrollEl,
    rightEl: viewMode === 'dual' ? translationScrollEl : null,
    locked: scrollSyncLocked && viewMode === 'dual',
    onRightDrivingLeft: handleRightDrivingLeft
  })

  const pageSizeCount = Object.keys(mirrorState.pageSizes).length
  const pageInsetCount = Object.keys(mirrorState.pageInsets).length
  useLayoutEffect(() => {
    if (!scrollSyncLocked || viewMode !== 'dual' || !pdfScrollEl || !translationScrollEl || mirrorState.pageCount <= 0) {
      return
    }
    syncRightToLeft(true)
  }, [
    scrollSyncLocked,
    viewMode,
    pdfScrollEl,
    translationScrollEl,
    mirrorState.pageCount,
    mirrorState.scale,
    mirrorState.cropMargins,
    mirrorState.headerOffsetPx,
    pageSizeCount,
    pageInsetCount,
    dualSplitRatio,
    libraryCollapsed,
    syncRightToLeft
  ])

  const getSplitDragContext = useCallback((): { leftWidth: number; rightWidth: number } | null => {
    const reader = readerPanelRef.current
    const workspace = workspaceRef.current
    if (!reader || !workspace) return null
    const rightEl = workspace.querySelector<HTMLElement>('.translation-panel')
    if (!rightEl) return null
    return {
      leftWidth: reader.getBoundingClientRect().width,
      rightWidth: rightEl.getBoundingClientRect().width
    }
  }, [])

  const importPdf = (): void => { void library.importPdf() }
  const retryLibrary = (): void => { void library.refresh() }

  const handleExportBackup = useCallback(async (): Promise<void> => {
    if (backingUp) return
    setBackingUp(true)
    try {
      const result = await window.paperflow.exportBackup()
      if (!result.canceled) {
        library.reportNotice(
          `已导出备份 ${result.fileName ?? '.zip'}：${result.documentCount} 篇文献、${result.annotationCount} 条批注、${result.glossaryCount} 条术语（含 Zotero/EndNote/Obsidian 兼容文件）`
        )
      }
    } catch (err: unknown) {
      library.reportError(err instanceof Error ? err.message : '导出备份失败，请重试。')
    } finally {
      setBackingUp(false)
    }
  }, [backingUp, library])

  const handleImportBackup = useCallback(async (): Promise<void> => {
    if (backingUp) return
    setBackingUp(true)
    try {
      const result = await window.paperflow.importBackup()
      if (!result.canceled) {
        await library.refresh()
        const settings = await window.paperflow.getTranslationSettings().catch(() => null)
        if (settings) setTranslationSettings(settings)
        const docId = selectedDocumentIdRef.current
        if (docId) {
          const items = await window.paperflow.listAnnotations(docId).catch(() => null)
          if (items && selectedDocumentIdRef.current === docId) setAnnotations(items)
          queriedCachePagesRef.current.clear()
        }
        library.reportNotice(
          `已恢复 ${result.fileName ?? '备份'}：新增 ${result.importedDocuments} 篇、已有 ${result.existingDocuments} 篇、批注 ${result.restoredAnnotations} 条、译文 ${result.restoredTranslations} 块、术语 ${result.restoredGlossary} 条`
        )
      }
    } catch (err: unknown) {
      library.reportError(err instanceof Error ? err.message : '恢复备份失败，请确认压缩包有效。')
    } finally {
      setBackingUp(false)
    }
  }, [backingUp, library])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (shortcutsOpen) {
          setShortcutsOpen(false)
        } else if (citationOpen) {
          setCitationOpen(false)
        } else if (!settingsOpen) {
          if (peekState) {
            peekRequestIdRef.current += 1
            setPeekState(null)
          } else if (explainState) {
            explainRequestIdRef.current += 1
            setExplainState(null)
          } else {
            setActiveLink(null)
            window.getSelection()?.removeAllRanges()
          }
        }
        return
      }

      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return
      if (settingsOpen) return

      if (event.key === '?' || (event.code === 'Slash' && event.shiftKey)) {
        event.preventDefault()
        setCitationOpen(false)
        setShortcutsOpen(open => !open)
        return
      }

      if (event.shiftKey || shortcutsOpen || citationOpen) return

      const lower = event.key.toLowerCase()
      if (lower === 't') {
        event.preventDefault()
        setTheme(curr => (curr === 'light' ? 'sepia' : curr === 'sepia' ? 'dark' : 'light'))
        return
      }
      if (lower === 'b') {
        event.preventDefault()
        setLibraryCollapsed(c => !c)
        return
      }
      if (!selectedDocumentId) return
      if (lower === 'v') {
        event.preventDefault()
        setViewMode(curr => (curr === 'dual' ? 'translation' : curr === 'translation' ? 'source' : 'dual'))
      } else if (lower === 'o') {
        event.preventDefault()
        toolbarActionsRef.current?.toggleOutline()
      } else if (lower === 'a') {
        event.preventDefault()
        setAnnotationsOpen(open => !open)
      } else if (lower === 'c') {
        event.preventDefault()
        setCitationOpen(true)
      } else if (lower === 'h' && selectionCompanion && !savingAnnotation) {
        event.preventDefault()
        void handleCreateHighlight('yellow')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    settingsOpen,
    shortcutsOpen,
    citationOpen,
    peekState,
    explainState,
    selectedDocumentId,
    selectionCompanion,
    savingAnnotation,
    handleCreateHighlight
  ])

  useEffect(() => {
    const resetDrop = (): void => {
      dragDepthRef.current = 0
      setDropActive(false)
    }
    window.addEventListener('blur', resetDrop)
    window.addEventListener('dragend', resetDrop)
    return () => {
      window.removeEventListener('blur', resetDrop)
      window.removeEventListener('dragend', resetDrop)
    }
  }, [])

  const onShellDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (hasDraggedFiles(event.dataTransfer)) event.preventDefault()
  }

  const onShellDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (hasDraggedFiles(event.dataTransfer)) event.preventDefault()
  }

  const onWorkspaceDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDropActive(true)
  }

  const onWorkspaceDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const onWorkspaceDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDropActive(false)
  }

  const onWorkspaceDrop = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDropActive(false)
    const files = event.dataTransfer.files
    if (files.length > 0 && !library.importing) {
      void library.importDroppedFiles(files)
    }
  }

  const hasDocument = Boolean(library.selected)
  const shownTitle = useMemo(() => {
    const doc = library.selected
    if (!doc) return ''
    const defaultTitle = doc.originalFilename.replace(/\.pdf$/i, '') || doc.originalFilename
    return doc.displayTitle !== defaultTitle ? doc.displayTitle : doc.originalFilename
  }, [library.selected])

  const engineLabel = useMemo(() => {
    if (!translationSettings) return undefined
    if (translationSettings.provider === 'openai-compatible') {
      return translationSettings.openai.model || undefined
    }
    if (translationSettings.cli.preset === 'codex') return 'Codex CLI'
    if (translationSettings.cli.preset === 'claude') return 'Claude CLI'
    if (translationSettings.cli.preset === 'gemini') return 'Gemini CLI'
    return translationSettings.cli.command || '自定义 CLI'
  }, [translationSettings])

  const currentLayout = layouts.get(mirrorState.currentPage)
  const currentCache = translationsByPage.get(mirrorState.currentPage)
  const currentProgress = countTranslatedBlocks(currentLayout, currentCache)
  const isCurrentTranslating = translatingPage === mirrorState.currentPage
  const isCurrentNoText =
    mirrorState.pageTextStatus[mirrorState.currentPage] === false ||
    (currentLayout !== undefined && !currentLayout.hasText)
  const isCurrentFullyTranslated =
    currentProgress.total > 0 && currentProgress.translated === currentProgress.total

  let summaryText = ''
  if (hasDocument) {
    if (batchQueue) {
      summaryText = `连续翻译 第 ${batchQueue.currentPage}/${batchQueue.totalPages} 页 (已完成 ${batchQueue.completedPages} 页)…`
    } else if (isCurrentNoText) {
      summaryText = `第 ${mirrorState.currentPage} 页 · 扫描页`
    } else if (!currentLayout) {
      summaryText = `第 ${mirrorState.currentPage} 页 · 待解析`
    } else if (isCurrentTranslating) {
      summaryText = `第 ${mirrorState.currentPage} 页 · 正在翻译 (${currentProgress.translated}/${currentProgress.total})…`
    } else if (isCurrentFullyTranslated || currentProgress.translated > 0) {
      summaryText = `第 ${mirrorState.currentPage} 页 · 已译 ${currentProgress.translated}/${currentProgress.total}`
    } else {
      const colLabel = currentLayout.columnCount >= 2 ? `${currentLayout.columnCount} 栏` : '单栏'
      summaryText = `第 ${mirrorState.currentPage} 页 · ${colLabel} · ${currentProgress.total} 块待译`
    }
  }
  const fullSummary = engineLabel ? `${summaryText} · ${engineLabel}` : summaryText

  const workspaceClasses = ['workspace']
  if (dropActive) workspaceClasses.push('workspace--drop-active')
  if (libraryCollapsed) workspaceClasses.push('workspace--library-collapsed')
  if (hasDocument) {
    workspaceClasses.push(
      viewMode === 'dual'
        ? 'workspace--reading-dual'
        : viewMode === 'translation'
          ? 'workspace--reading-translation'
          : 'workspace--reading-single'
    )
  }

  const workspaceStyle: CSSProperties | undefined =
    hasDocument && viewMode === 'dual' && dualSplitRatio !== null
      ? ({
          '--dual-left-fr': `${dualSplitRatio}fr`,
          '--dual-right-fr': `${Number((1 - dualSplitRatio).toFixed(4))}fr`
        } as CSSProperties)
      : undefined

  return (
    <div className="app-shell" onDragOver={onShellDragOver} onDrop={onShellDrop}>
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">P</div>
        <strong>PaperFlow</strong>
        <button
          type="button"
          className={libraryCollapsed ? 'app-header__sidebar-toggle is-collapsed' : 'app-header__sidebar-toggle'}
          aria-label="切换文献库侧边栏"
          aria-expanded={!libraryCollapsed}
          onClick={() => setLibraryCollapsed(collapsed => !collapsed)}
        >
          {libraryCollapsed ? '展开文献库' : '收起文献库'}
        </button>
        <div className="theme-switcher" role="group" aria-label="阅读主题">
          {THEME_OPTIONS.map(option => (
            <button
              key={option.id}
              type="button"
              className={theme === option.id ? 'is-selected' : undefined}
              aria-pressed={theme === option.id}
              onClick={() => setTheme(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="app-header__sidebar-toggle"
          aria-label="快捷键帮助"
          title="快捷键一览 (?)"
          aria-expanded={shortcutsOpen}
          onClick={() => setShortcutsOpen(open => !open)}
        >
          ?
        </button>
        <span className="local-badge">本地 PDF 阅读器</span>
      </header>
      {library.selected ? (
        <div className="workspace-topbar reader-toolbar" role="toolbar" aria-label="PDF 阅读工具栏">
          <div className="workspace-topbar__left">
            <span className="reader-document-title" title={library.selected.originalFilename}>
              {shownTitle}
            </span>
            <span className="reader-toolbar__divider" aria-hidden="true" />
            <button
              type="button"
              className={mirrorState.outlineOpen ? 'is-active' : undefined}
              aria-label="文档目录"
              aria-expanded={mirrorState.outlineOpen}
              disabled={mirrorState.toolbarDisabled}
              onClick={() => toolbarActionsRef.current?.toggleOutline()}
            >
              目录
            </button>
            <button
              type="button"
              className={mirrorState.searchOpen ? 'is-active' : undefined}
              aria-label="文内搜索"
              aria-expanded={mirrorState.searchOpen}
              disabled={mirrorState.toolbarDisabled}
              onClick={() => toolbarActionsRef.current?.toggleSearch()}
            >
              搜索
            </button>
          </div>
          <div className="workspace-topbar__right">
            {viewMode !== 'source' ? (
              <span className="translation-structure-meta" title={fullSummary}>
                {fullSummary}
              </span>
            ) : null}
            <div className="view-mode-switcher" role="group" aria-label="视图模式">
              {(
                [
                  { id: 'source', label: '原文' },
                  { id: 'dual', label: '双栏' },
                  { id: 'translation', label: '译文' }
                ] as const
              ).map(mode => (
                <button
                  key={mode.id}
                  type="button"
                  className={viewMode === mode.id ? 'is-selected' : undefined}
                  aria-pressed={viewMode === mode.id}
                  onClick={() => setViewMode(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {viewMode !== 'source' ? (
              <>
                {translatingPage !== null || batchQueue ? (
                  <button
                    type="button"
                    className="translation-header__btn translation-header__btn--danger"
                    aria-label="取消翻译"
                    onClick={handleCancelTranslation}
                  >
                    取消翻译
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="translation-header__btn translation-header__btn--primary"
                      aria-label={isCurrentFullyTranslated ? '重译本页' : '翻译本页'}
                      title={
                        isCurrentFullyTranslated
                          ? '忽略本页本地 SQLite 缓存并重新调用翻译引擎'
                          : '优先命中本地 SQLite 译文缓存，仅对未译文本块调用翻译引擎'
                      }
                      disabled={!currentLayout || currentProgress.total === 0 || isCurrentNoText}
                      onClick={() => {
                        void handleTranslatePage(mirrorState.currentPage, isCurrentFullyTranslated)
                      }}
                    >
                      {isCurrentFullyTranslated ? '重译本页' : '翻译本页'}
                    </button>
                    {mirrorState.pageCount > 1 ? (
                      <button
                        type="button"
                        className="translation-header__btn"
                        aria-label="连续翻译后续页"
                        title="从当前页起后台逐页翻译至文末，每批结果实时显示"
                        onClick={() => {
                          void handleTranslateBatch(mirrorState.currentPage)
                        }}
                      >
                        连续译
                      </button>
                    ) : null}
                  </>
                )}
                {viewMode === 'dual' ? (
                  <button
                    type="button"
                    className={scrollSyncLocked ? 'translation-sync-toggle is-locked' : 'translation-sync-toggle'}
                    aria-label="滚动同步锁定"
                    aria-pressed={scrollSyncLocked}
                    title={
                      scrollSyncLocked
                        ? '已锁定：原文与译文同步上下/左右滑动；点击解锁可各自独立滑动'
                        : '已解锁：两侧可各自上下/左右独立滑动；点击重新锁定并对齐原文'
                    }
                    onClick={() => setScrollSyncLocked(locked => !locked)}
                  >
                    <span className="translation-sync-toggle__icon" aria-hidden="true">
                      <LockIcon locked={scrollSyncLocked} />
                    </span>
                    <span>{scrollSyncLocked ? '同步锁定' : '自由滑动'}</span>
                  </button>
                ) : null}
              </>
            ) : null}
            <button
              type="button"
              className={annotationsOpen ? 'translation-header__btn is-active' : 'translation-header__btn'}
              aria-label="批注与笔记"
              aria-expanded={annotationsOpen}
              onClick={() => setAnnotationsOpen(open => !open)}
            >
              批注{annotations.length > 0 ? ` (${annotations.length})` : ''}
            </button>
            <button
              type="button"
              className={citationOpen ? 'translation-header__btn is-active' : 'translation-header__btn'}
              aria-label="复制文献引用"
              title="一键复制 BibTeX / IEEE / GB/T 7714 引用 (C)"
              onClick={() => setCitationOpen(true)}
            >
              引用
            </button>
            <button
              type="button"
              className="translation-header__btn"
              aria-label="翻译设置"
              onClick={() => setSettingsOpen(true)}
            >
              设置
            </button>
            <span className="reader-toolbar__divider" aria-hidden="true" />
            <button
              type="button"
              className="reader-toolbar__import"
              aria-label="打开新 PDF"
              disabled={library.importing}
              aria-busy={library.importing}
              onClick={importPdf}
            >
              打开新 PDF
            </button>
          </div>
        </div>
      ) : null}
      <main
        ref={workspaceRef}
        className={workspaceClasses.join(' ')}
        style={workspaceStyle}
        onDragEnter={onWorkspaceDragEnter}
        onDragOver={onWorkspaceDragOver}
        onDragLeave={onWorkspaceDragLeave}
        onDrop={onWorkspaceDrop}
      >
        <LibraryPanel
          documents={library.documents}
          readerProgress={library.readerProgress}
          selectedId={library.selected?.id}
          loading={library.loading}
          loadError={library.loadError}
          importing={library.importing}
          error={library.error}
          errorDetails={library.errorDetails}
          notice={library.notice}
          onImport={importPdf}
          onRetry={retryLibrary}
          onSelect={library.select}
          onRename={library.renameDocument}
          onUpdateMeta={library.updateDocumentMeta}
          onJumpToSearchHit={handleJumpToSearchHit}
          onDelete={library.deleteDocument}
          backingUp={backingUp}
          onExportBackup={() => void handleExportBackup()}
          onImportBackup={() => void handleImportBackup()}
          onDismissError={library.dismissErrors}
          onReportError={library.reportError}
        />
        <section ref={readerPanelRef} className="reader-panel" aria-label="PDF 阅读器">
          {library.selected ? (
            <PdfViewer
              key={library.selected.id}
              document={library.selected}
              onPageCount={library.refresh}
              onPageLayout={handlePageLayout}
              onPageBackdrop={handlePageBackdrop}
              onScrollRootChange={setPdfScrollEl}
              onMirrorStateChange={setMirrorState}
              cancelNavigationRef={cancelNavigationRef}
              navigateToPageRef={navigateToPageRef}
              analyzePageRef={analyzePageRef}
              extractPageTextRef={extractPageTextRef}
              extractCitationSourceRef={extractCitationSourceRef}
              renderRegionPreviewRef={renderRegionPreviewRef}
              toolbarActionsRef={toolbarActionsRef}
              hideFloatingPill={viewMode === 'translation'}
              annotationsByPage={annotationsByPage}
              activeSentence={activeSourceSentence}
              onSourceSentenceInteract={handleLeftSourceInteract}
              onOutlineNavigate={handleOutlineNavigate}
            />
          ) : library.loading ? (
            <div className="reader-placeholder" aria-busy="true"><h1>正在打开文献库</h1></div>
          ) : library.loadError ? (
            <div className="reader-placeholder">
              <h1>无法打开文献库</h1>
              <button type="button" className="reader-placeholder__import" onClick={retryLibrary}>重新读取文献库</button>
            </div>
          ) : (
            <div className="reader-placeholder">
              <h1>打开一篇 PDF</h1>
              <p>在本地阅读、翻页和缩放。拖选原文后按 <kbd>Ctrl</kbd> + <kbd>C</kbd> 复制。</p>
              <button type="button" className="reader-placeholder__import" aria-label="选择 PDF 文件"
                disabled={library.importing} onClick={importPdf}>
                {library.importing ? '正在导入…' : '选择 PDF 文件'}
              </button>
              <p className="reader-placeholder__detail">支持拖拽 PDF 到此窗口；重新打开文献时会恢复上次的页码和缩放。</p>
            </div>
          )}
        </section>
        {!hasDocument || viewMode !== 'source' ? (
          <TranslationPanel
            hasDocument={hasDocument}
            mirror={mirrorState}
            layouts={layouts}
            backdrops={backdrops}
            translationsByPage={translationsByPage}
            translatingPage={translatingPage}
            retranslatingBlockKeys={retranslatingBlockKeys}
            translationError={translationError}
            onRetranslateBlock={(pageNumber, blockKey) => { void handleRetranslateBlock(pageNumber, blockKey) }}
            onOpenSettings={() => setSettingsOpen(true)}
            onDismissTranslationError={() => setTranslationError(null)}
            scrollRef={setTranslationScrollEl}
            activePageNumber={activeLink?.pageNumber ?? null}
            activeSentenceIds={activeSentenceIds}
            onSelectTargetSentences={handleRightSentenceSelect}
            onChangeSplitRatio={viewMode === 'dual' ? setDualSplitRatio : undefined}
            getSplitDragContext={getSplitDragContext}
            bottomPill={
              hasDocument && viewMode === 'translation' ? (
                <ReaderToolbar
                  pageNumber={mirrorState.currentPage}
                  pageCount={mirrorState.pageCount}
                  scale={mirrorState.scale}
                  disabled={mirrorState.toolbarDisabled}
                  cropMargins={mirrorState.cropMargins}
                  onNavigate={page => handleJumpToPage(page)}
                  onScale={next => toolbarActionsRef.current?.setScale(next)}
                  onFitWidth={() => toolbarActionsRef.current?.fitWidth()}
                  onToggleCropMargins={() => toolbarActionsRef.current?.toggleCropMargins()}
                />
              ) : undefined
            }
          />
        ) : null}
        {hasDocument && (
          <SelectionCompanionBar
            selection={selectionCompanion}
            explainState={explainState}
            savingAnnotation={savingAnnotation}
            referenceTargets={referenceTargets}
            peekState={peekState}
            peekPinned={peekPinned}
            returnPageNumber={returnPageNumber}
            onCreateHighlight={handleCreateHighlight}
            onExplain={handleExplainSelection}
            onSaveExplainAsNote={handleSaveExplainAsNote}
            onCloseExplain={() => {
              explainRequestIdRef.current += 1
              setExplainState(null)
            }}
            onClearSelection={() => {
              setActiveLink(null)
              window.getSelection()?.removeAllRanges()
            }}
            onPeekReference={handlePeekReference}
            onClosePeek={() => {
              peekRequestIdRef.current += 1
              setPeekState(null)
              setPeekPinned(false)
            }}
            onTogglePeekPin={() => setPeekPinned(p => !p)}
            onJumpToPage={handleJumpToPage}
            onReturnToPage={handleReturnToPage}
          />
        )}
        <AnnotationsDrawer
          open={annotationsOpen && hasDocument}
          documentId={selectedDocumentId}
          annotations={annotations}
          onClose={() => setAnnotationsOpen(false)}
          onSelectAnnotation={handleJumpToAnnotation}
          onUpdateAnnotation={handleUpdateAnnotation}
          onDeleteAnnotation={handleDeleteAnnotation}
          onExportMarkdown={handleExportAnnotationsMarkdown}
        />
        {dropActive && (
          <div className="workspace-dropzone" role="status" aria-live="polite">
            <div className="workspace-dropzone__card">
              <strong>释放以导入 PDF 文献</strong>
              <span>仅在本地校验并存入您的文献库，不上传任何文件</span>
            </div>
          </div>
        )}
      </main>
      <TranslationSettingsModal
        open={settingsOpen}
        documentId={selectedDocumentId}
        onClose={() => setSettingsOpen(false)}
        onSaved={settings => {
          setTranslationSettings(settings)
          setTranslationError(null)
          if (selectedDocumentId && mirrorState.pageCount > 0) {
            queriedCachePagesRef.current.clear()
            setTranslationsByPage(new Map())
            const minPage = Math.max(1, mirrorState.currentPage - 1)
            const maxPage = Math.min(mirrorState.pageCount, mirrorState.currentPage + 1)
            for (let p = minPage; p <= maxPage; p += 1) {
              queriedCachePagesRef.current.add(p)
              void loadPageCache(selectedDocumentId, p)
            }
          }
        }}
        onDocumentCacheCleared={() => {
          queriedCachePagesRef.current.clear()
          setTranslationsByPage(new Map())
        }}
      />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CitationModal
        open={citationOpen && hasDocument}
        document={library.selected}
        extractCitationSource={() => extractCitationSourceRef.current?.() ?? Promise.resolve(null)}
        onClose={() => setCitationOpen(false)}
      />
    </div>
  )
}
