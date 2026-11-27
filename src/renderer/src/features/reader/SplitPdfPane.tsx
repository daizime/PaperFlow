import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { FirstPageCitationSource } from '../../../../shared/citation'
import type { AnnotationRecord, DocumentRecord, TranslatePageResult } from '../../../../shared/contracts'
import type { ShortcutMap } from '../study/shortcuts'
import { LockIcon, TranslationPanel } from '../translation/TranslationPanel'
import { usePaneTranslation } from '../translation/usePaneTranslation'
import { computeStableTranslationBlockKey, type PageLayoutResult } from './layout-analysis'
import type { PageRect } from './pdf-geometry'
import { scoreOutlineHeadingMatch, type PdfOutlineItem } from './pdf-outline'
import { PdfViewer, type ReaderMirrorState, type ReaderToolbarActions } from './PdfViewer'
import { ReaderToolbar } from './ReaderToolbar'
import {
  describeDropAction,
  DOC_DRAG_MIME,
  formatPaneSlotLabel,
  getPaneViewMode,
  PANE_DRAG_MIME,
  setActiveWorkspaceDrag,
  type SplitDropZone,
  type SplitPane,
  type SplitPaneViewMode
} from './split-panes'

export function PaneOutlineIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <line x1="3" y1="4" x2="13" y2="4" />
      <line x1="3" y1="8" x2="11" y2="8" />
      <line x1="3" y1="12" x2="12" y2="12" />
    </svg>
  )
}

export function PaneSearchIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" />
      <line x1="10.2" y1="10.2" x2="13.5" y2="13.5" />
    </svg>
  )
}

export function PaneExpandIcon({ expanded }: { expanded: boolean }): React.JSX.Element {
  if (expanded) {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="6 2.5 6 6 2.5 6" />
        <line x1="2.5" y1="2.5" x2="6" y2="6" />
        <polyline points="10 13.5 10 10 13.5 10" />
        <line x1="13.5" y1="13.5" x2="10" y2="10" />
      </svg>
    )
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="10 2.5 13.5 2.5 13.5 6" />
      <line x1="13.5" y1="2.5" x2="9.5" y2="6.5" />
      <polyline points="6 13.5 2.5 13.5 2.5 10" />
      <line x1="2.5" y1="13.5" x2="6.5" y2="9.5" />
    </svg>
  )
}

export interface PaneStudyHandle {
  paneId: string
  documentId: string
  getPageNumber(): number
  getPageCount(): number
  getViewMode(): SplitPaneViewMode
  getLayouts(): ReadonlyMap<number, PageLayoutResult>
  getScrollElements(): { pdf: HTMLDivElement | null; translation: HTMLDivElement | null }
  extractCurrentPageText(): Promise<string | null>
  extractPageText(pageNumber: number): Promise<string | null>
  analyzePage(pageNumber: number): Promise<PageLayoutResult | null>
  extractCitationSource(): Promise<FirstPageCitationSource | null>
  renderRegionPreview(
    pageNumber: number,
    kind: 'figure' | 'table',
    captionBounds?: PageRect,
    obstacleBounds?: readonly PageRect[]
  ): Promise<string | null>
  navigateToPage(pageNumber: number): void
  highlightAnnotation(annotation: AnnotationRecord): void
  syncPostHighlightSentence(info: {
    pageNumber: number
    sentenceIds: string[]
    blockKeys: string[]
    sourceRects: PageRect[]
    sentenceRects: PageRect[]
    selectedText?: string
  }): void
  clearSelection(): void
  applyAnalyzedLayout(pageNumber: number, layout: PageLayoutResult): void
  retranslateBlock(pageNumber: number, blockKey: string): Promise<void>
}

export interface PaneSelectionSnapshot {
  paneId: string
  documentId: string
  pageNumber: number
  quoteText: string
  contextText: string
  isFormulaLikely: boolean
  sentenceIds: string[]
  blockKeys: string[]
  sourceRects: PageRect[]
}

export interface SplitPdfPaneProps {
  pane: SplitPane
  index: number
  totalPanes: number
  document: DocumentRecord
  allDocuments: readonly DocumentRecord[]
  annotationsByPage?: ReadonlyMap<number, readonly AnnotationRecord[]>
  editingAnnotationId?: string | null
  isFocused: boolean
  isExpanded: boolean
  isDimmed: boolean
  activeDropZone: SplitDropZone | null
  activeDropIsPane: boolean
  translationRevision: number
  activeTranslatingPage?: number | null
  shortcuts?: ShortcutMap
  onTranslatingPageChange?(docId: string, pageNumber: number | null): void
  onTranslationComplete?(docId: string, result: TranslatePageResult): void
  onTranslationError?(docId: string, message: string): void
  toolbarActionsRef: MutableRefObject<ReaderToolbarActions | null>
  extractPageTextRef: MutableRefObject<((pageNumber: number) => Promise<string | null>) | null>
  onFocus(): void
  onSelectDocument(documentId: string): void
  onChangeViewMode(viewMode: SplitPaneViewMode): void
  onToggleExpand(): void
  onSelectionChange(paneId: string, selection: PaneSelectionSnapshot | null): void
  onAnnotationClick?(paneId: string, annotation: AnnotationRecord): void
  onOpenSettings(): void
  onClose(): void
  onPageCount(): Promise<void>
  onResizerPointerDown(event: ReactPointerEvent<HTMLDivElement>): void
  onResizerPointerMove(event: ReactPointerEvent<HTMLDivElement>): void
  onResizerPointerUp(event: ReactPointerEvent<HTMLDivElement>): void
  onResetWeights(): void
  onDragOverPane(event: DragEvent<HTMLElement>): void
  onDragLeavePane(event: DragEvent<HTMLElement>): void
  onDropOnPane(event: DragEvent<HTMLElement>): void
  onRegisterStudyHandle(paneId: string, handle: PaneStudyHandle | null): void
}

const INITIAL_MIRROR: ReaderMirrorState = {
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

const PANE_VIEW_MODES: ReadonlyArray<{ id: SplitPaneViewMode; short: string; full: string }> = [
  { id: 'source', short: '原', full: '原文模式' },
  { id: 'dual', short: '双', full: '双栏对照' },
  { id: 'translation', short: '译', full: '纯译文' }
]

export function SplitPdfPane({
  pane,
  index,
  totalPanes,
  document,
  allDocuments,
  annotationsByPage,
  editingAnnotationId = null,
  isFocused,
  isExpanded,
  isDimmed,
  activeDropZone,
  activeDropIsPane,
  translationRevision,
  activeTranslatingPage = null,
  shortcuts,
  onTranslatingPageChange,
  onTranslationComplete,
  onTranslationError,
  toolbarActionsRef,
  extractPageTextRef,
  onFocus,
  onSelectDocument,
  onChangeViewMode,
  onToggleExpand,
  onSelectionChange,
  onAnnotationClick,
  onOpenSettings,
  onClose,
  onPageCount,
  onResizerPointerDown,
  onResizerPointerMove,
  onResizerPointerUp,
  onResetWeights,
  onDragOverPane,
  onDragLeavePane,
  onDropOnPane,
  onRegisterStudyHandle
}: SplitPdfPaneProps): React.JSX.Element {
  const [mirror, setMirror] = useState<ReaderMirrorState>(INITIAL_MIRROR)
  const mirrorRef = useRef(mirror)
  mirrorRef.current = mirror
  const navigateToPageRef = useRef<((pageNumber: number) => void) | null>(null)
  const cancelNavigationRef = useRef<(() => void) | null>(null)
  const analyzePageRef = useRef<((pageNumber: number) => Promise<PageLayoutResult | null>) | null>(null)
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

  const paneViewMode = getPaneViewMode(pane)
  const paneViewModeRef = useRef(paneViewMode)
  paneViewModeRef.current = paneViewMode

  const paneTranslation = usePaneTranslation({
    documentId: document.id,
    mirror,
    viewMode: paneViewMode,
    translationRevision,
    externalTranslatingPage: activeTranslatingPage,
    onTranslatingPageChange,
    onTranslationComplete,
    onTranslationError,
    onRightDrivingLeft: () => cancelNavigationRef.current?.()
  })

  const paneTranslationRef = useRef(paneTranslation)
  paneTranslationRef.current = paneTranslation
  const documentIdRef = useRef(document.id)
  documentIdRef.current = document.id
  const outlineRequestIdRef = useRef(0)

  useEffect(() => {
    outlineRequestIdRef.current += 1
  }, [document.id])

  const handleOutlineNavigate = useCallback((item: PdfOutlineItem): void => {
    const targetPage = item.pageNumber
    const targetDocId = documentIdRef.current
    if (!targetPage || !targetDocId) return
    const reqId = ++outlineRequestIdRef.current

    const pickMatchedBlock = (layout: PageLayoutResult) => {
      let bestBlock: PageLayoutResult['blocks'][number] | null = null
      let bestScore = 0
      for (const block of layout.blocks) {
        const text = block.sentences
          .map(sentence => sentence.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        const score = scoreOutlineHeadingMatch(text, block.kind, item.title)
        if (score > bestScore) {
          bestScore = score
          bestBlock = block
        }
      }
      return bestScore >= 68 ? bestBlock : null
    }

    const scrollHighlightIntoView = (pageNum: number, attempt = 0): void => {
      if (outlineRequestIdRef.current !== reqId || documentIdRef.current !== targetDocId) return
      const pdfScrollEl = paneTranslationRef.current.pdfScrollEl
      const translationScrollEl = paneTranslationRef.current.translationScrollEl
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
      if (
        rightHighlight &&
        translationScrollEl &&
        (paneViewModeRef.current === 'translation' || !paneTranslationRef.current.scrollSyncLocked)
      ) {
        const pageEl = translationScrollEl.querySelector<HTMLElement>(
          `.translation-page[data-page-number="${pageNum}"]`
        )
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
      let layout = paneTranslationRef.current.layouts.get(targetPage) ?? null
      if (!layout && analyzePageRef.current) {
        layout = await analyzePageRef.current(targetPage).catch(() => null)
        if (layout && documentIdRef.current === targetDocId) {
          paneTranslationRef.current.handlePageLayout(targetPage, layout)
        }
      }
      if (!layout || documentIdRef.current !== targetDocId || outlineRequestIdRef.current !== reqId) return
      const block = pickMatchedBlock(layout)
      if (!block) return
      paneTranslationRef.current.highlightOutlineBlock(targetPage, block)
      window.requestAnimationFrame(() => scrollHighlightIntoView(targetPage, 0))
    })()
  }, [])

  const selectionSnapshot = useMemo((): PaneSelectionSnapshot | null => {
    const link = paneTranslation.activeLink
    if (!link) return null
    const hasSelectedText = Boolean(link.selectedText?.trim()) && link.sourceRects.length > 0
    if (link.sentenceIds.length === 0 && !hasSelectedText) return null
    const layout = paneTranslation.layouts.get(link.pageNumber)
    if (!layout && !hasSelectedText) return null
    const selectedSet = new Set(link.sentenceIds)
    const selectedSentences = layout ? layout.sentences.filter(sentence => selectedSet.has(sentence.id)) : []
    if (selectedSentences.length === 0 && !hasSelectedText) return null

    const sentenceQuote = selectedSentences
      .map(sentence => sentence.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    const quoteText = link.selectedText?.trim() || sentenceQuote
    if (!quoteText) return null

    const blockKeySet = new Set(link.blockKeys)
    const matchedBlocks = layout
      ? layout.blocks.filter(block => blockKeySet.has(computeStableTranslationBlockKey(block)))
      : []
    const contextText =
      matchedBlocks
        .map(block =>
          block.sentences
            .map(sentence => sentence.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
        )
        .filter(Boolean)
        .join('\n') ||
      sentenceQuote ||
      quoteText

    const isFormulaLikely =
      selectedSentences.some(sentence => sentence.blockKind === 'formula') ||
      matchedBlocks.some(block => block.kind === 'formula' || Boolean(block.inlineFormulas?.length))

    return {
      paneId: pane.id,
      documentId: document.id,
      pageNumber: link.pageNumber,
      quoteText,
      contextText,
      isFormulaLikely,
      sentenceIds: link.sentenceIds,
      blockKeys: link.blockKeys,
      sourceRects: link.sourceRects
    }
  }, [pane.id, document.id, paneTranslation.activeLink, paneTranslation.layouts])

  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const hadSelectionRef = useRef(false)

  useEffect(() => {
    if (selectionSnapshot) {
      hadSelectionRef.current = true
      onSelectionChangeRef.current(pane.id, selectionSnapshot)
    } else if (hadSelectionRef.current) {
      hadSelectionRef.current = false
      onSelectionChangeRef.current(pane.id, null)
    }
  }, [pane.id, selectionSnapshot])

  useEffect(() => {
    return () => {
      if (hadSelectionRef.current) {
        hadSelectionRef.current = false
        onSelectionChangeRef.current(pane.id, null)
      }
    }
  }, [pane.id])

  useEffect(() => {
    const handle: PaneStudyHandle = {
      paneId: pane.id,
      get documentId() {
        return documentIdRef.current
      },
      getPageNumber: () => mirrorRef.current.currentPage,
      getPageCount: () => mirrorRef.current.pageCount,
      getViewMode: () => paneViewModeRef.current,
      getLayouts: () => paneTranslationRef.current.layouts,
      getScrollElements: () => ({
        pdf: paneTranslationRef.current.pdfScrollEl,
        translation: paneTranslationRef.current.translationScrollEl
      }),
      extractCurrentPageText: async () => {
        const fn = extractPageTextRef.current
        if (!fn) return null
        return fn(mirrorRef.current.currentPage)
      },
      extractPageText: async pageNumber => {
        const fn = extractPageTextRef.current
        if (!fn) return null
        return fn(pageNumber)
      },
      analyzePage: async pageNumber => {
        const fn = analyzePageRef.current
        if (!fn) return null
        return fn(pageNumber)
      },
      extractCitationSource: async () => {
        const fn = extractCitationSourceRef.current
        if (!fn) return null
        return fn()
      },
      renderRegionPreview: async (pageNumber, kind, captionBounds, obstacleBounds) => {
        const fn = renderRegionPreviewRef.current
        if (!fn) return null
        return fn(pageNumber, kind, captionBounds, obstacleBounds)
      },
      navigateToPage: pageNumber => {
        navigateToPageRef.current?.(pageNumber)
        if (paneViewModeRef.current === 'translation') {
          paneTranslationRef.current.translationScrollEl
            ?.querySelector<HTMLElement>(`.translation-page[data-page-number="${pageNumber}"]`)
            ?.scrollIntoView({ block: 'start' })
        }
      },
      highlightAnnotation: annotation => {
        paneTranslationRef.current.highlightAnnotation(annotation)
      },
      syncPostHighlightSentence: info => {
        paneTranslationRef.current.syncPostHighlightSentence(info)
      },
      clearSelection: () => {
        paneTranslationRef.current.clearSelection()
      },
      applyAnalyzedLayout: (pageNumber, layout) => {
        paneTranslationRef.current.handlePageLayout(pageNumber, layout)
      },
      retranslateBlock: async (pageNumber, blockKey) => {
        await paneTranslationRef.current.handleRetranslateBlock(pageNumber, blockKey)
      }
    }
    onRegisterStudyHandle(pane.id, handle)
    return () => {
      onRegisterStudyHandle(pane.id, null)
    }
  }, [pane.id, extractPageTextRef, onRegisterStudyHandle])

  const slotLabel = formatPaneSlotLabel(index, totalPanes)
  const testId = index === 1 ? 'split-pane-secondary' : `split-pane-${index}`
  const selectTestId = index === 1 ? 'secondary-pane-select' : `pane-select-${index}`
  const closeTestId = index === 1 ? 'close-secondary-pane-btn' : `close-pane-btn-${index}`

  const panelClasses = ['reader-panel', 'reader-panel--secondary']
  if (isFocused) panelClasses.push('is-pane-focused')
  if (paneViewMode === 'dual') panelClasses.push('is-pane-dual')
  if (isExpanded) panelClasses.push('is-pane-expanded')
  if (isDimmed) panelClasses.push('is-pane-dimmed')

  const renderPaneReaderToolbar = (): React.JSX.Element => (
    <ReaderToolbar
      pageNumber={mirror.currentPage}
      pageCount={mirror.pageCount}
      scale={mirror.scale}
      disabled={mirror.toolbarDisabled}
      cropMargins={mirror.cropMargins}
      onNavigate={page => {
        navigateToPageRef.current?.(page)
        if (paneViewMode === 'translation') {
          const el = paneTranslation.translationScrollEl?.querySelector<HTMLElement>(
            `.translation-page[data-page-number="${page}"]`
          )
          el?.scrollIntoView({ block: 'start', behavior: 'auto' })
        }
      }}
      onScale={next => toolbarActionsRef.current?.setScale(next)}
      onFitWidth={() => toolbarActionsRef.current?.fitWidth()}
      onToggleCropMargins={() => toolbarActionsRef.current?.toggleCropMargins()}
    />
  )

  return (
    <section
      className={panelClasses.join(' ')}
      data-testid={testId}
      data-pane-index={index}
      data-pane-id={pane.id}
      data-document-id={document.id}
      data-pane-view-mode={paneViewMode}
      data-pane-expanded={isExpanded ? 'true' : 'false'}
      style={{ '--pane-weight': pane.weight } as CSSProperties}
      aria-label={`${slotLabel} PDF 阅读器`}
      onMouseDown={onFocus}
      onDragOver={onDragOverPane}
      onDragLeave={onDragLeavePane}
      onDrop={onDropOnPane}
    >
      <div
        className="compare-split-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={`调整 ${slotLabel} 宽度比例`}
        title="左右拖拽调整分栏宽度，双击恢复等宽"
        onPointerDown={onResizerPointerDown}
        onPointerMove={onResizerPointerMove}
        onPointerUp={onResizerPointerUp}
        onPointerCancel={onResizerPointerUp}
        onDoubleClick={onResetWeights}
      />
      <div className="split-pane-header">
        <div className="split-pane-header__left">
          <div
            className="split-pane-header__drag-zone"
            draggable
            data-testid={`pane-drag-handle-${index}`}
            title="按住此区域拖拽到其它分栏可互换或重排位置；双击临时放大/还原"
            onDoubleClick={onToggleExpand}
            onDragStart={event => {
              event.dataTransfer.setData(PANE_DRAG_MIME, pane.id)
              event.dataTransfer.setData(DOC_DRAG_MIME, document.id)
              event.dataTransfer.effectAllowed = 'move'
              setActiveWorkspaceDrag({ kind: 'pane', paneId: pane.id, documentId: document.id })
            }}
            onDragEnd={() => setActiveWorkspaceDrag(null)}
          >
            <span className="split-pane-header__grip" aria-hidden="true">
              ⋮⋮
            </span>
            <span className="split-pane-header__badge">{slotLabel}</span>
          </div>
          <select
            className="split-pane-header__select"
            data-testid={selectTestId}
            aria-label={`切换${slotLabel}对照文献`}
            value={document.id}
            onChange={event => onSelectDocument(event.target.value)}
          >
            {allDocuments.map(doc => (
              <option key={doc.id} value={doc.id}>
                {doc.displayTitle || doc.originalFilename}
              </option>
            ))}
          </select>
        </div>
        <div className="split-pane-header__right">
          <div className="split-pane-mode-switcher" role="group" aria-label={`${slotLabel}视图模式`}>
            {PANE_VIEW_MODES.map(mode => (
              <button
                key={mode.id}
                type="button"
                data-testid={`pane-mode-${index}-${mode.id}`}
                className={paneViewMode === mode.id ? 'is-selected' : undefined}
                aria-label={`${slotLabel}${mode.full}`}
                aria-pressed={paneViewMode === mode.id}
                title={mode.full}
                onClick={() => onChangeViewMode(mode.id)}
              >
                {mode.short}
              </button>
            ))}
          </div>
          {paneViewMode !== 'source' ? (
            <>
              {paneTranslation.translatingPage !== null ? (
                <button
                  type="button"
                  className="split-pane-header__translate-btn is-danger"
                  data-testid={`pane-translate-btn-${index}`}
                  aria-label={`取消${slotLabel}翻译`}
                  onClick={paneTranslation.handleCancelTranslation}
                >
                  取消
                </button>
              ) : (
                <button
                  type="button"
                  className={
                    paneTranslation.isCurrentFullyTranslated
                      ? 'split-pane-header__translate-btn'
                      : 'split-pane-header__translate-btn is-primary'
                  }
                  data-testid={`pane-translate-btn-${index}`}
                  aria-label={`${slotLabel}${paneTranslation.isCurrentFullyTranslated ? '重译本页' : '翻译本页'}`}
                  title={
                    paneTranslation.isCurrentFullyTranslated
                      ? '忽略本页本地 SQLite 缓存并重新调用翻译引擎'
                      : '翻译当前分栏这一页'
                  }
                  disabled={
                    !paneTranslation.currentLayout ||
                    paneTranslation.currentProgress.total === 0 ||
                    paneTranslation.isCurrentNoText
                  }
                  onClick={() => {
                    void paneTranslation.handleTranslatePage(
                      mirror.currentPage,
                      paneTranslation.isCurrentFullyTranslated
                    )
                  }}
                >
                  {paneTranslation.isCurrentFullyTranslated ? '重译' : '翻译'}
                </button>
              )}
              {paneViewMode === 'dual' ? (
                <button
                  type="button"
                  className={`split-pane-header__icon-btn${paneTranslation.scrollSyncLocked ? ' is-active' : ''}`}
                  data-testid={`pane-sync-toggle-${index}`}
                  aria-label={`${slotLabel}滚动同步锁定`}
                  aria-pressed={paneTranslation.scrollSyncLocked}
                  title={paneTranslation.scrollSyncLocked ? '已锁定同步滚动（点击解锁）' : '已解锁自由滚动（点击锁定）'}
                  onClick={() => paneTranslation.setScrollSyncLocked(locked => !locked)}
                >
                  <LockIcon locked={paneTranslation.scrollSyncLocked} />
                </button>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            className={`split-pane-header__outline-btn${mirror.outlineOpen ? ' is-active' : ''}`}
            data-testid={`pane-outline-btn-${index}`}
            aria-label={`${slotLabel}文档目录`}
            aria-expanded={mirror.outlineOpen}
            title={`${slotLabel}文档目录 (聚焦本栏按 O)`}
            disabled={mirror.toolbarDisabled}
            onClick={() => {
              onFocus()
              if (paneViewMode === 'translation') onChangeViewMode('dual')
              toolbarActionsRef.current?.toggleOutline()
            }}
          >
            <PaneOutlineIcon />
            <span className="split-pane-header__btn-label">目录</span>
          </button>
          <button
            type="button"
            className={`split-pane-header__icon-btn${mirror.searchOpen ? ' is-active' : ''}`}
            aria-label={`${slotLabel}文内搜索`}
            aria-expanded={mirror.searchOpen}
            title="文内搜索"
            disabled={mirror.toolbarDisabled}
            onClick={() => {
              onFocus()
              if (paneViewMode === 'translation') onChangeViewMode('dual')
              toolbarActionsRef.current?.toggleSearch()
            }}
          >
            <PaneSearchIcon />
          </button>
          <button
            type="button"
            className={`split-pane-header__icon-btn${isExpanded ? ' is-active' : ''}`}
            data-testid={`pane-expand-btn-${index}`}
            aria-label={isExpanded ? `还原${slotLabel}多开比例` : `临时放大${slotLabel}`}
            aria-pressed={isExpanded}
            title={isExpanded ? '还原多开分栏比例' : '临时放大本栏聚焦精读'}
            onClick={onToggleExpand}
          >
            <PaneExpandIcon expanded={isExpanded} />
          </button>
          <button
            type="button"
            className="split-pane-header__icon-btn"
            data-testid={closeTestId}
            aria-label={`关闭${slotLabel}`}
            title={`关闭${slotLabel}`}
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>
      <div className={`split-pane-body split-pane-body--${paneViewMode}`}>
        <div className="split-pane-source-slot">
          <PdfViewer
            key={`${pane.id}-${document.id}`}
            document={document}
            layoutKey={paneViewMode}
            isActivePane={isFocused}
            shortcuts={shortcuts}
            onPageCount={onPageCount}
            onPageLayout={paneTranslation.handlePageLayout}
            onPageBackdrop={paneTranslation.handlePageBackdrop}
            onScrollRootChange={paneTranslation.setPdfScrollEl}
            onMirrorStateChange={setMirror}
            cancelNavigationRef={cancelNavigationRef}
            navigateToPageRef={navigateToPageRef}
            analyzePageRef={analyzePageRef}
            extractPageTextRef={extractPageTextRef}
            extractCitationSourceRef={extractCitationSourceRef}
            renderRegionPreviewRef={renderRegionPreviewRef}
            toolbarActionsRef={toolbarActionsRef}
            hideFloatingPill={paneViewMode !== 'source'}
            annotationsByPage={annotationsByPage}
            editingAnnotationId={editingAnnotationId}
            activeSentence={paneTranslation.activeSourceSentence}
            onSourceSentenceInteract={paneTranslation.handleLeftSourceInteract}
            onAnnotationClick={onAnnotationClick ? ann => onAnnotationClick(pane.id, ann) : undefined}
            onOutlineNavigate={handleOutlineNavigate}
          />
        </div>
        {paneViewMode !== 'source' ? (
          <TranslationPanel
            hasDocument
            mirror={mirror}
            layouts={paneTranslation.layouts}
            backdrops={paneTranslation.backdrops}
            translationsByPage={paneTranslation.translationsByPage}
            translatingPage={paneTranslation.translatingPage}
            retranslatingBlockKeys={paneTranslation.retranslatingBlockKeys}
            translationError={paneTranslation.translationError}
            onRetranslateBlock={(pageNumber, blockKey) => {
              void paneTranslation.handleRetranslateBlock(pageNumber, blockKey)
            }}
            onEditBlockTranslation={(pageNumber, blockKey, sourceHash, translatedText) =>
              paneTranslation.handleEditBlockTranslation(pageNumber, blockKey, sourceHash, translatedText)
            }
            onOpenSettings={onOpenSettings}
            onDismissTranslationError={() => paneTranslation.setTranslationError(null)}
            scrollRef={paneTranslation.setTranslationScrollEl}
            activePageNumber={paneTranslation.activeLink?.pageNumber ?? null}
            activeSentenceIds={paneTranslation.activeSentenceIds}
            onSelectTargetSentences={paneTranslation.handleRightSentenceSelect}
            onZoomDelta={delta => toolbarActionsRef.current?.adjustScale(delta)}
            bottomPill={paneViewMode === 'translation' ? renderPaneReaderToolbar() : undefined}
          />
        ) : null}
        {paneViewMode === 'dual' ? (
          <div className="split-pane-dual-pill-dock" data-testid={`pane-dual-pill-dock-${index}`}>
            {renderPaneReaderToolbar()}
          </div>
        ) : null}
      </div>
      {activeDropZone ? (
        <div className={`split-drop-overlay split-drop-overlay--${activeDropZone}`} aria-hidden="true">
          <div className="split-drop-overlay__badge">
            {describeDropAction(activeDropZone, activeDropIsPane)}
          </div>
        </div>
      ) : null}
    </section>
  )
}
