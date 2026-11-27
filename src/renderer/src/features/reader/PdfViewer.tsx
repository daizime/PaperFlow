import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { FirstPageCitationSource, FirstPageTextItem } from '../../../../shared/citation'
import type { AnnotationRecord, DocumentRecord } from '../../../../shared/contracts'
import { computeTightFigureCropBox } from '../study/figure-crop'
import { DEFAULT_SHORTCUTS, matchesShortcutEvent, type ShortcutMap } from '../study/shortcuts'
import { analyzePageLayout, sampleBlockBackgroundColors, type PageLayoutResult } from './layout-analysis'
import { extractPageGraphicHints, type PdfOperatorListLike } from './pdf-graphics'
import { type CropInsets } from './margin-crop'
import { PdfOutline } from './PdfOutline'
import { PdfPage, type PdfPageData } from './PdfPage'
import { PdfSearchBar } from './PdfSearchBar'
import { ReaderToolbar } from './ReaderToolbar'
import { loadPdf, pdfErrorMessage, type PDFDocumentProxy } from './pdf-engine'
import {
  clientPointToPdf,
  hitTestPageAnnotation,
  pdfRectToViewport,
  selectionToPdfRects,
  type PageGeometry,
  type PagePoint,
  type PageRect,
  type PdfSelectionRegion
} from './pdf-geometry'
import { extractAutoOutlineFromPdf, extractPdfOutline, type PdfOutlineItem } from './pdf-outline'
import { PdfSearchService, type SearchMatch } from './pdf-search'
import { useReaderPersistence } from './useReaderPersistence'
import './reader.css'
import './reader-ux.css'

export interface PageBackdropSnapshot {
  bitmap: ImageBitmap
  blockColors: Record<string, string>
}

export interface ReaderMirrorState {
  pageCount: number
  currentPage: number
  scale: number
  cropMargins: boolean
  estimatedSize: { width: number; height: number }
  pageSizes: Record<number, { width: number; height: number }>
  pageInsets: Record<number, CropInsets>
  pageTextStatus: Record<number, boolean>
  headerOffsetPx: number
  outlineOpen: boolean
  searchOpen: boolean
  toolbarDisabled: boolean
}

export interface ReaderToolbarActions {
  toggleOutline(): void
  toggleSearch(): void
  setScale(scale: number): void
  adjustScale(delta: number): void
  fitWidth(): void
  toggleCropMargins(): void
}

export type LeftSourceInteractEvent =
  | { type: 'point'; pageNumber: number; pdfPoint: PagePoint }
  | { type: 'selection'; regions: PdfSelectionRegion[]; selectedText?: string }
  | { type: 'clear' }

export interface PdfViewerProps {
  document: DocumentRecord; onPageCount(): Promise<void>
  layoutKey?: string
  onPageData?(pageNumber: number, data: PdfPageData | null): void
  onPageLayout?(pageNumber: number, result: PageLayoutResult | null): void
  onPageBackdrop?(pageNumber: number, backdrop: PageBackdropSnapshot | null): void
  onScrollRootChange?(element: HTMLDivElement | null): void
  onMirrorStateChange?(state: ReaderMirrorState): void
  cancelNavigationRef?: MutableRefObject<(() => void) | null>
  navigateToPageRef?: MutableRefObject<((pageNumber: number) => void) | null>
  analyzePageRef?: MutableRefObject<((pageNumber: number) => Promise<PageLayoutResult | null>) | null>
  extractPageTextRef?: MutableRefObject<((pageNumber: number) => Promise<string | null>) | null>
  extractCitationSourceRef?: MutableRefObject<(() => Promise<FirstPageCitationSource | null>) | null>
  renderRegionPreviewRef?: MutableRefObject<
    | ((
        pageNumber: number,
        kind: 'figure' | 'table',
        captionBounds?: PageRect,
        obstacleBounds?: readonly PageRect[]
      ) => Promise<string | null>)
    | null
  >
  toolbarActionsRef?: MutableRefObject<ReaderToolbarActions | null>
  hideFloatingPill?: boolean
  annotationsByPage?: ReadonlyMap<number, readonly AnnotationRecord[]>
  editingAnnotationId?: string | null
  activeSentence?: { pageNumber: number; rects: readonly PageRect[] } | null
  isActivePane?: boolean
  shortcuts?: ShortcutMap
  onSourceSentenceInteract?(event: LeftSourceInteractEvent): void
  onAnnotationClick?(annotation: AnnotationRecord): void
  onOutlineNavigate?(item: PdfOutlineItem): void
}

interface NavigationAnchor {
  documentId: string; pdf: PDFDocumentProxy; root: HTMLDivElement; pageNumber: number
  scrollTop: number; scrollLeft: number; resetHorizontal: boolean
}

const clampScale = (scale: number): number => Math.min(3, Math.max(0.5, Math.round(scale * 100) / 100))

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  return target instanceof HTMLElement && target.isContentEditable
}

function isInsideDialog(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[role="dialog"]'))
}

export function PdfViewer({
  document: record,
  onPageCount,
  layoutKey,
  onPageData,
  onPageLayout,
  onPageBackdrop,
  onScrollRootChange,
  onMirrorStateChange,
  cancelNavigationRef,
  navigateToPageRef,
  analyzePageRef,
  extractPageTextRef,
  extractCitationSourceRef,
  renderRegionPreviewRef,
  toolbarActionsRef,
  hideFloatingPill = false,
  annotationsByPage,
  editingAnnotationId = null,
  activeSentence,
  isActivePane = true,
  shortcuts = DEFAULT_SHORTCUTS,
  onSourceSentenceInteract,
  onAnnotationClick,
  onOutlineNavigate
}: PdfViewerProps): React.JSX.Element {
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [size, setSize] = useState({ width: 612, height: 792 })
  const [pageSizes, setPageSizes] = useState<Record<number, { width: number; height: number }>>({})
  const [pageInsets, setPageInsets] = useState<Record<number, CropInsets>>({})
  const [headerOffsetPx, setHeaderOffsetPx] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1)
  const [fitCommit, setFitCommit] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [textStatus, setTextStatus] = useState<Record<number, boolean>>({})

  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outlineItems, setOutlineItems] = useState<PdfOutlineItem[]>([])
  const [outlineLoading, setOutlineLoading] = useState(false)
  const [outlineAutoGenerated, setOutlineAutoGenerated] = useState(false)
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null)

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([])
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const [searching, setSearching] = useState(false)

  const [cropMargins, setCropMargins] = useState(false)
  const [cropCommit, setCropCommit] = useState(0)
  const [devicePixelRatio, setDevicePixelRatio] = useState(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
    const update = (): void => {
      setDevicePixelRatio(window.devicePixelRatio || 1)
    }
    query.addEventListener('change', update)
    return () => {
      query.removeEventListener('change', update)
    }
  }, [devicePixelRatio])

  const current = useRef(1)
  const scaleRef = useRef(1)
  const loadingRef = useRef(true)
  const cropMarginsRef = useRef(false)
  const navigationAnchor = useRef<NavigationAnchor | null>(null)
  const anchorIntent = useRef<{ request: number; pageNumber: number; resetHorizontal: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const activePdf = useRef<PDFDocumentProxy | null>(null)
  const activeDocument = useRef<string | null>(null)
  const searchServiceRef = useRef<PdfSearchService | null>(null)
  const pageInsetsRef = useRef<Record<number, CropInsets>>({})
  const pendingScrollMatchIdRef = useRef<string | null>(null)
  const fitRequest = useRef(0)
  const autoFitWidthRef = useRef(true)
  const lastAutoFitWidthRef = useRef(0)
  const sizeRef = useRef(size)
  const pageSizesRef = useRef<Record<number, { width: number; height: number }>>({})

  const invalidateFit = useCallback((): void => { fitRequest.current++ }, [])
  const cancelAnchor = useCallback((): void => {
    const anchor = navigationAnchor.current
    navigationAnchor.current = null
    if (anchor) delete anchor.root.dataset.navigationAnchor
  }, [])
  const cancelNavigation = useCallback((): void => {
    anchorIntent.current = null
    cancelAnchor()
    invalidateFit()
  }, [cancelAnchor, invalidateFit])

  const onPageCountRef = useRef(onPageCount)
  const onPageDataRef = useRef(onPageData)
  const onPageLayoutRef = useRef(onPageLayout)
  const onPageBackdropRef = useRef(onPageBackdrop)
  const onScrollRootChangeRef = useRef(onScrollRootChange)
  const onMirrorStateChangeRef = useRef(onMirrorStateChange)
  const onSourceSentenceInteractRef = useRef(onSourceSentenceInteract)
  const onAnnotationClickRef = useRef(onAnnotationClick)
  const annotationsByPageRef = useRef(annotationsByPage)
  const onOutlineNavigateRef = useRef(onOutlineNavigate)
  const searchOpenRef = useRef(searchOpen)
  const shortcutsRef = useRef(shortcuts)
  const backdropTokensRef = useRef<Map<number, number>>(new Map())
  const renderedPagesRef = useRef<Map<number, { geometry: PageGeometry; surface: HTMLElement }>>(new Map())

  useLayoutEffect(() => {
    rootRef.current = scrollRoot
    onPageCountRef.current = onPageCount
    onPageDataRef.current = onPageData
    onPageLayoutRef.current = onPageLayout
    onPageBackdropRef.current = onPageBackdrop
    onScrollRootChangeRef.current = onScrollRootChange
    onMirrorStateChangeRef.current = onMirrorStateChange
    onSourceSentenceInteractRef.current = onSourceSentenceInteract
    onAnnotationClickRef.current = onAnnotationClick
    annotationsByPageRef.current = annotationsByPage
    onOutlineNavigateRef.current = onOutlineNavigate
    scaleRef.current = scale
    loadingRef.current = loading
    cropMarginsRef.current = cropMargins
    searchOpenRef.current = searchOpen
    shortcutsRef.current = shortcuts
    sizeRef.current = size
    pageSizesRef.current = pageSizes
  }, [scrollRoot, onPageCount, onPageData, onPageLayout, onPageBackdrop, onScrollRootChange, onMirrorStateChange, onSourceSentenceInteract, onAnnotationClick, annotationsByPage, onOutlineNavigate, scale, loading, cropMargins, searchOpen, shortcuts, size, pageSizes])

  useLayoutEffect(() => {
    if (!cancelNavigationRef) return
    cancelNavigationRef.current = cancelNavigation
    return () => {
      if (cancelNavigationRef.current === cancelNavigation) {
        cancelNavigationRef.current = null
      }
    }
  }, [cancelNavigationRef, cancelNavigation])

  const handleScrollRootRef = useCallback((element: HTMLDivElement | null): void => {
    setScrollRoot(element)
    onScrollRootChangeRef.current?.(element)
  }, [])

  useLayoutEffect(() => {
    const tokens = backdropTokensRef.current
    const pagesMap = renderedPagesRef.current
    activeDocument.current = record.id
    activePdf.current = null
    pageInsetsRef.current = {}
    pageSizesRef.current = {}
    autoFitWidthRef.current = true
    lastAutoFitWidthRef.current = 0
    tokens.clear()
    pagesMap.clear()
    pendingScrollMatchIdRef.current = null
    cancelNavigation()
    return () => {
      activeDocument.current = null
      activePdf.current = null
      tokens.clear()
      pagesMap.clear()
      cancelNavigation()
    }
  }, [record.id, cancelNavigation])

  useEffect(() => {
    if (!scrollRoot) return
    let rafId: number | null = null
    const emitSelection = (): void => {
      const interact = onSourceSentenceInteractRef.current
      if (!interact) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) return
      const anchorInRoot = sel.anchorNode ? scrollRoot.contains(sel.anchorNode) : false
      const focusInRoot = sel.focusNode ? scrollRoot.contains(sel.focusNode) : false
      if (!anchorInRoot && !focusInRoot) return

      const regions: PdfSelectionRegion[] = []
      for (const entry of renderedPagesRef.current.values()) {
        if (!entry.surface.isConnected) continue
        regions.push(...selectionToPdfRects(sel, entry.surface, entry.geometry))
      }
      if (regions.length > 0) {
        interact({ type: 'selection', regions, selectedText: sel.toString() })
      }
    }

    const onSelectionChange = (): void => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        emitSelection()
      })
    }

    const onMouseUp = (): void => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
        rafId = null
      }
      emitSelection()
    }

    document.addEventListener('selectionchange', onSelectionChange)
    scrollRoot.addEventListener('mouseup', onMouseUp)
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      document.removeEventListener('selectionchange', onSelectionChange)
      scrollRoot.removeEventListener('mouseup', onMouseUp)
    }
  }, [scrollRoot])

  useEffect(() => {
    let cancelled = false
    let session: ReturnType<typeof loadPdf> | undefined
    searchServiceRef.current?.dispose()
    searchServiceRef.current = null
    setLoading(true); setError(null); setTextStatus({})
    setPageSizes({}); setPageInsets({})
    setOutlineOpen(false); setOutlineItems([]); setOutlineLoading(false); setOutlineAutoGenerated(false); setActiveOutlineId(null)
    setSearchOpen(false); setSearchQuery(''); setCaseSensitive(false)
    setSearchMatches([]); setActiveMatchIndex(0); setSearching(false)
    setCropMargins(false)
    pageInsetsRef.current = {}

    async function open(): Promise<void> {
      try {
        const [bytes, saved] = await Promise.all([window.paperflow.readPdfBytes(record.id), window.paperflow.getReaderState(record.id)])
        if (cancelled || activeDocument.current !== record.id) return
        session = loadPdf(bytes)
        const loaded = await session.promise
        const first = await loaded.getPage(1)
        const viewport = first.getViewport({ scale: 1 })
        if (cancelled || activeDocument.current !== record.id) return
        const measuredWidth = rootRef.current?.clientWidth ?? 0
        const width = measuredWidth > 100 ? measuredWidth : 720
        const fitEstimate = clampScale((width - 56) / viewport.width)
        const initialScale = saved?.scale ?? fitEstimate
        autoFitWidthRef.current =
          saved?.scale === undefined || (measuredWidth > 100 && Math.abs(saved.scale - fitEstimate) <= 0.03)
        lastAutoFitWidthRef.current = measuredWidth > 100 ? measuredWidth : 0
        sizeRef.current = { width: viewport.width, height: viewport.height }
        const initialPage = Math.min(loaded.numPages, saved?.pageNumber ?? 1)
        current.current = initialPage
        scaleRef.current = initialScale
        anchorIntent.current = { request: fitRequest.current, pageNumber: initialPage, resetHorizontal: false }
        setPageNumber(initialPage); setScale(initialScale)
        setSize({ width: viewport.width, height: viewport.height })
        activePdf.current = loaded
        searchServiceRef.current = new PdfSearchService(loaded)
        setPdf(loaded); setLoading(false)
        await window.paperflow.updatePageCount(record.id, loaded.numPages)
        if (!cancelled) await onPageCountRef.current()
      } catch (error: unknown) {
        if (!cancelled && activeDocument.current === record.id) { setError(pdfErrorMessage(error)); setLoading(false) }
      }
    }
    void open()
    return () => {
      cancelled = true
      searchServiceRef.current?.dispose()
      searchServiceRef.current = null
      void session?.destroy().catch(() => {})
    }
  }, [record.id])

  useEffect(() => {
    if (!pdf || loading || error) return
    const controller = new AbortController()
    setOutlineLoading(true)
    setOutlineAutoGenerated(false)
    void (async () => {
      try {
        const items = await extractPdfOutline(pdf, controller.signal)
        if (controller.signal.aborted || activePdf.current !== pdf) return
        if (items.length > 0) {
          setOutlineItems(items)
          setOutlineAutoGenerated(false)
          setOutlineLoading(false)
          return
        }
        const autoItems = await extractAutoOutlineFromPdf(pdf, controller.signal)
        if (!controller.signal.aborted && activePdf.current === pdf) {
          setOutlineItems(autoItems)
          setOutlineAutoGenerated(autoItems.length > 0)
          setOutlineLoading(false)
        }
      } catch {
        if (!controller.signal.aborted && activePdf.current === pdf) {
          setOutlineItems([])
          setOutlineAutoGenerated(false)
          setOutlineLoading(false)
        }
      }
    })()
    return () => controller.abort()
  }, [pdf, loading, error])

  const alignAnchor = useCallback((): void => {
    const anchor = navigationAnchor.current
    if (!anchor) return
    const root = rootRef.current
    if (root !== anchor.root || activePdf.current !== anchor.pdf || activeDocument.current !== anchor.documentId || current.current !== anchor.pageNumber) {
      cancelAnchor()
      return
    }
    const page = root.querySelector<HTMLElement>('[data-page-number="' + anchor.pageNumber + '"]')
    if (!page) return
    const top = page.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop
    const desired = Math.max(0, Math.min(root.scrollHeight - root.clientHeight, root.scrollTop + top))
    if (Math.abs(root.scrollTop - desired) > 0.5) root.scrollTop = desired
    if (anchor.resetHorizontal) root.scrollLeft = 0
    // 使用浏览器钳制/舍入后的值，识别下一次非本次补偿的滚动。
    anchor.scrollTop = root.scrollTop
    anchor.scrollLeft = root.scrollLeft
  }, [cancelAnchor])

  const beginAnchor = useCallback((number: number, resetHorizontal = false): void => {
    cancelAnchor()
    const root = rootRef.current
    const active = activePdf.current
    const documentId = activeDocument.current
    if (!root || !active || !documentId) return
    navigationAnchor.current = { documentId, pdf: active, root, pageNumber: number, scrollTop: root.scrollTop, scrollLeft: root.scrollLeft, resetHorizontal }
    root.dataset.navigationAnchor = 'true'
    alignAnchor()
  }, [alignAnchor, cancelAnchor])

  const applyScale = useCallback((value: number): void => {
    const next = clampScale(value)
    cancelNavigation()
    autoFitWidthRef.current = false
    if (next === scaleRef.current) return
    scaleRef.current = next
    anchorIntent.current = { request: fitRequest.current, pageNumber: current.current, resetHorizontal: false }
    setScale(next)
  }, [cancelNavigation])

  const fitWidth = useCallback(async (): Promise<void> => {
    const root = rootRef.current
    if (!pdf || loading || !root || activePdf.current !== pdf) return
    const request = ++fitRequest.current
    const number = current.current
    try {
      const page = await pdf.getPage(number)
      if (request !== fitRequest.current || activePdf.current !== pdf || current.current !== number || rootRef.current !== root) return
      const viewport = page.getViewport({ scale: 1 })
      const pages = root.querySelector<HTMLElement>('.pdf-pages')
      if (!pages || !Number.isFinite(viewport.width) || viewport.width <= 0) return
      const style = getComputedStyle(pages)
      const available = root.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
      if (available <= 0) return
      const insets = cropMarginsRef.current ? pageInsetsRef.current[number] : undefined
      const contentFraction = insets ? Math.max(0.35, 1 - insets.left - insets.right) : 1
      const targetWidth = viewport.width * contentFraction
      if (!Number.isFinite(targetWidth) || targetWidth <= 0) return
      autoFitWidthRef.current = true
      lastAutoFitWidthRef.current = root.clientWidth
      anchorIntent.current = { request, pageNumber: number, resetHorizontal: true }
      // 向下保留两位，避免四舍五入使较宽页面超出可用区域。
      const next = clampScale(Math.floor((available / targetWidth) * 100) / 100)
      scaleRef.current = next
      setScale(next)
      // 同倍率的 fit 也需要纠正旧的横向滚动位置。
      setFitCommit(request)
    } catch {
      // 页面错误由 PdfPage 呈现；销毁或过期的请求不覆盖阅读状态。
    }
  }, [pdf, loading])

  useLayoutEffect(() => {
    if (!pdf || loading || error || !layoutKey) return
    const root = rootRef.current
    if (!root || activePdf.current !== pdf || !autoFitWidthRef.current) return
    if (root.clientWidth <= 100) return
    if (Math.abs(root.clientWidth - lastAutoFitWidthRef.current) <= 40) return
    const pages = root.querySelector<HTMLElement>('.pdf-pages')
    const pageSize = pageSizesRef.current[current.current] ?? sizeRef.current
    if (!pages || !Number.isFinite(pageSize.width) || pageSize.width <= 0) return
    const style = getComputedStyle(pages)
    const available =
      root.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
    if (available <= 0) return
    const insets = cropMarginsRef.current ? pageInsetsRef.current[current.current] : undefined
    const contentFraction = insets ? Math.max(0.35, 1 - insets.left - insets.right) : 1
    const targetWidth = pageSize.width * contentFraction
    if (!Number.isFinite(targetWidth) || targetWidth <= 0) return
    const request = ++fitRequest.current
    const next = clampScale(Math.floor((available / targetWidth) * 100) / 100)
    lastAutoFitWidthRef.current = root.clientWidth
    anchorIntent.current = { request, pageNumber: current.current, resetHorizontal: true }
    scaleRef.current = next
    setScale(next)
    setFitCommit(request)
  }, [layoutKey, pdf, loading, error])

  useLayoutEffect(() => {
    const intent = anchorIntent.current
    if (!pdf || activePdf.current !== pdf || !intent || intent.request !== fitRequest.current || intent.pageNumber !== current.current) return
    anchorIntent.current = null
    beginAnchor(intent.pageNumber, intent.resetHorizontal)
  }, [pdf, scale, fitCommit, beginAnchor])

  useLayoutEffect(() => {
    if (cropCommit === 0 || !pdf || activePdf.current !== pdf) return
    beginAnchor(current.current)
  }, [pdf, cropCommit, beginAnchor])

  useLayoutEffect(() => {
    if (!pdf || !scrollRoot || loading || error) return
    const pages = scrollRoot.querySelector('.pdf-pages')
    if (!pages) return
    // 一次批量通知只补偿一次；逐页观察可捕获总高度相抵的重排。
    const observer = new ResizeObserver(() => { if (activePdf.current === pdf) alignAnchor() })
    observer.observe(scrollRoot)
    for (const page of pages.children) observer.observe(page)
    return () => observer.disconnect()
  }, [pdf, scrollRoot, loading, error, alignAnchor])

  const navigate = useCallback((number: number): void => {
    if (!pdf) return
    const target = Math.max(1, Math.min(pdf.numPages, Math.trunc(number)))
    cancelNavigation()
    current.current = target
    setPageNumber(target)
    beginAnchor(target)
  }, [pdf, beginAnchor, cancelNavigation])

  useLayoutEffect(() => {
    if (!navigateToPageRef) return
    navigateToPageRef.current = navigate
    return () => {
      if (navigateToPageRef.current === navigate) {
        navigateToPageRef.current = null
      }
    }
  }, [navigateToPageRef, navigate])

  useLayoutEffect(() => {
    if (!analyzePageRef) return
    const analyze = async (targetPage: number): Promise<PageLayoutResult | null> => {
      const active = activePdf.current
      if (!active || loadingRef.current || targetPage < 1 || targetPage > active.numPages) return null
      try {
        const pageObj = await active.getPage(targetPage)
        try {
          const viewport = pageObj.getViewport({ scale: 1 })
          const geometry: PageGeometry = {
            pageNumber: targetPage,
            viewport,
            outputScale: { x: 1, y: 1 }
          }
          const textContent = (await pageObj.getTextContent({ includeMarkedContent: true })) as Parameters<
            typeof analyzePageLayout
          >[0]
          const operatorList = await pageObj.getOperatorList().catch(() => null)
          const graphicHints = operatorList
            ? extractPageGraphicHints(operatorList as unknown as PdfOperatorListLike, geometry)
            : undefined
          return analyzePageLayout(textContent, geometry, { graphicHints })
        } finally {
          if (!pageObj.destroyed) pageObj.cleanup()
        }
      } catch {
        return null
      }
    }
    analyzePageRef.current = analyze
    return () => {
      if (analyzePageRef.current === analyze) {
        analyzePageRef.current = null
      }
    }
  }, [analyzePageRef, pdf, loading])

  useLayoutEffect(() => {
    if (!extractPageTextRef) return
    const cache = new Map<number, string>()
    const extractText = async (targetPage: number): Promise<string | null> => {
      const cached = cache.get(targetPage)
      if (cached !== undefined) return cached
      const active = activePdf.current
      if (!active || loadingRef.current || targetPage < 1 || targetPage > active.numPages) return null
      try {
        const pageObj = await active.getPage(targetPage)
        try {
          const textContent = (await pageObj.getTextContent()) as { items?: Array<{ str?: string; hasEOL?: boolean }> }
          let out = ''
          for (const item of textContent.items ?? []) {
            if (!item || typeof item.str !== 'string') continue
            out += item.str
            out += item.hasEOL ? '\n' : ' '
          }
          const normalized = out.replace(/[ \t]+\n/g, '\n').trim()
          cache.set(targetPage, normalized)
          return normalized
        } finally {
          if (!pageObj.destroyed) pageObj.cleanup()
        }
      } catch {
        return null
      }
    }
    extractPageTextRef.current = extractText
    return () => {
      if (extractPageTextRef.current === extractText) {
        extractPageTextRef.current = null
      }
    }
  }, [extractPageTextRef, pdf, loading, record.id])

  useLayoutEffect(() => {
    if (!extractCitationSourceRef) return
    const extractCitation = async (): Promise<FirstPageCitationSource | null> => {
      const active = activePdf.current
      if (!active || loadingRef.current || active.numPages < 1) return null
      try {
        const metaRaw = await active.getMetadata().catch(() => null)
        const infoObj = (metaRaw?.info ?? {}) as Record<string, unknown>
        const pdfInfo = {
          title: typeof infoObj.Title === 'string' ? infoObj.Title : undefined,
          author: typeof infoObj.Author === 'string' ? infoObj.Author : undefined,
          subject: typeof infoObj.Subject === 'string' ? infoObj.Subject : undefined,
          creationDate: typeof infoObj.CreationDate === 'string' ? infoObj.CreationDate : undefined
        }

        const pageObj = await active.getPage(1)
        try {
          const textContent = (await pageObj.getTextContent()) as { items?: readonly unknown[] }
          const items: FirstPageTextItem[] = []
          let page1Text = ''
          for (const raw of textContent.items ?? []) {
            if (!raw || typeof raw !== 'object' || !('str' in raw)) continue
            const it = raw as { str?: unknown; width?: unknown; hasEOL?: unknown; transform?: unknown }
            if (typeof it.str !== 'string') continue
            page1Text += it.str + (it.hasEOL ? '\n' : ' ')
            const t = Array.isArray(it.transform) ? it.transform : null
            const fontSize =
              t && typeof t[0] === 'number' && typeof t[1] === 'number' ? Math.hypot(t[0], t[1]) : 10
            const x = t && typeof t[4] === 'number' ? t[4] : 0
            const y = t && typeof t[5] === 'number' ? t[5] : 0
            items.push({
              str: it.str,
              fontSize,
              x,
              y,
              width: typeof it.width === 'number' ? it.width : undefined,
              hasEOL: Boolean(it.hasEOL)
            })
          }
          return {
            page1Text: page1Text.replace(/[ \t]+\n/g, '\n').trim(),
            items,
            pdfInfo
          }
        } finally {
          if (!pageObj.destroyed) pageObj.cleanup()
        }
      } catch {
        return null
      }
    }
    extractCitationSourceRef.current = extractCitation
    return () => {
      if (extractCitationSourceRef.current === extractCitation) {
        extractCitationSourceRef.current = null
      }
    }
  }, [extractCitationSourceRef, pdf, loading, record.id])

  useLayoutEffect(() => {
    if (!renderRegionPreviewRef) return
    const renderPreview = async (
      targetPage: number,
      kind: 'figure' | 'table',
      captionBounds?: PageRect,
      obstacleBounds?: readonly PageRect[]
    ): Promise<string | null> => {
      const active = activePdf.current
      if (!active || loadingRef.current || targetPage < 1 || targetPage > active.numPages) return null
      try {
        const pageObj = await active.getPage(targetPage)
        try {
          const renderScale = 2.4
          const viewport = pageObj.getViewport({ scale: renderScale })
          const widthPx = Math.max(1, Math.round(viewport.width))
          const heightPx = Math.max(1, Math.round(viewport.height))
          const fullCanvas = document.createElement('canvas')
          fullCanvas.width = widthPx
          fullCanvas.height = heightPx
          const ctx = fullCanvas.getContext('2d', { willReadFrequently: true })
          if (!ctx) return null
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, widthPx, heightPx)
          await pageObj.render({ canvas: fullCanvas, canvasContext: ctx, viewport }).promise

          const geom = { pageNumber: targetPage, viewport, outputScale: { x: 1, y: 1 } }
          const capVp =
            captionBounds && captionBounds.width > 0 && captionBounds.height > 0
              ? pdfRectToViewport(geom, captionBounds)
              : undefined
          const obsVp = obstacleBounds?.map(rect => pdfRectToViewport(geom, rect))

          const imageData = ctx.getImageData(0, 0, widthPx, heightPx)
          const box = computeTightFigureCropBox(imageData.data, widthPx, heightPx, kind, capVp, obsVp)
          if (!box) return null

          const maxOutW = 1440
          const ratio = box.sw > maxOutW ? maxOutW / box.sw : 1
          const outW = Math.max(1, Math.round(box.sw * ratio))
          const outH = Math.max(1, Math.round(box.sh * ratio))
          const cropCanvas = document.createElement('canvas')
          cropCanvas.width = outW
          cropCanvas.height = outH
          const outCtx = cropCanvas.getContext('2d')
          if (!outCtx) return null
          outCtx.fillStyle = '#ffffff'
          outCtx.fillRect(0, 0, outW, outH)
          outCtx.drawImage(fullCanvas, box.sx, box.sy, box.sw, box.sh, 0, 0, outW, outH)
          return cropCanvas.toDataURL('image/png')
        } finally {
          if (!pageObj.destroyed) pageObj.cleanup()
        }
      } catch {
        return null
      }
    }
    renderRegionPreviewRef.current = renderPreview
    return () => {
      if (renderRegionPreviewRef.current === renderPreview) {
        renderRegionPreviewRef.current = null
      }
    }
  }, [renderRegionPreviewRef, pdf, loading, record.id])

  const scrollElementIntoReader = useCallback((element: HTMLElement): void => {
    const root = rootRef.current
    if (!root || !element.isConnected) return
    const rootBox = root.getBoundingClientRect()
    const rootTop = rootBox.top + root.clientTop
    const rootBottom = rootTop + root.clientHeight
    const rootLeft = rootBox.left + root.clientLeft
    const rootRight = rootLeft + root.clientWidth
    const box = element.getBoundingClientRect()
    const margin = 24
    const offscreenY = box.top < rootTop + margin || box.bottom > rootBottom - margin
    const offscreenX = box.left < rootLeft + margin || box.right > rootRight - margin
    if (!offscreenY && !offscreenX) return

    cancelNavigation()
    const nextTop = offscreenY
      ? Math.max(0, Math.min(root.scrollHeight - root.clientHeight,
          root.scrollTop + (box.top + box.height / 2) - (rootTop + root.clientHeight / 2)))
      : root.scrollTop
    const nextLeft = offscreenX
      ? Math.max(0, Math.min(root.scrollWidth - root.clientWidth,
          root.scrollLeft + (box.left + box.width / 2) - (rootLeft + root.clientWidth / 2)))
      : root.scrollLeft
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    root.scrollTo({ top: nextTop, left: nextLeft, behavior: reduced ? 'auto' : 'smooth' })
  }, [cancelNavigation])

  const handleActiveMatchRendered = useCallback((matchId: string, element: HTMLElement): void => {
    if (pendingScrollMatchIdRef.current !== matchId) return
    pendingScrollMatchIdRef.current = null
    scrollElementIntoReader(element)
  }, [scrollElementIntoReader])

  useEffect(() => {
    const service = searchServiceRef.current
    if (!pdf || loading || error || !service || !searchOpen || searchQuery.length === 0) {
      setSearchMatches([])
      setActiveMatchIndex(0)
      setSearching(false)
      pendingScrollMatchIdRef.current = null
      return
    }
    const controller = new AbortController()
    let jumpedInitial = false
    setSearching(true)

    void service.search(searchQuery, { caseSensitive }, {
      signal: controller.signal,
      onProgress: (matches, done) => {
        if (controller.signal.aborted || activePdf.current !== pdf) return
        setSearchMatches(matches)
        if (!jumpedInitial) {
          const forwardIndex = matches.findIndex(match => match.pageNumber >= current.current)
          const initialIndex = forwardIndex !== -1 ? forwardIndex : (done && matches.length > 0 ? 0 : -1)
          if (initialIndex !== -1) {
            jumpedInitial = true
            const target = matches[initialIndex]
            setActiveMatchIndex(initialIndex)
            pendingScrollMatchIdRef.current = target.id
            if (target.pageNumber !== current.current) navigate(target.pageNumber)
          }
        }
        if (done) {
          setSearching(false)
          if (matches.length === 0) setActiveMatchIndex(0)
        }
      }
    })

    return () => controller.abort()
  }, [pdf, loading, error, searchOpen, searchQuery, caseSensitive, navigate])

  const stepSearchMatch = useCallback((delta: number): void => {
    if (searchMatches.length === 0) return
    const nextIndex = ((activeMatchIndex + delta) % searchMatches.length + searchMatches.length) % searchMatches.length
    const target = searchMatches[nextIndex]
    setActiveMatchIndex(nextIndex)
    pendingScrollMatchIdRef.current = target.id

    const pageEl = rootRef.current?.querySelector<HTMLElement>(`.pdf-page[data-page-number="${target.pageNumber}"]`)
    const rendered = pageEl?.dataset.rendered === 'true'
    if (target.pageNumber !== current.current || !rendered) {
      navigate(target.pageNumber)
      return
    }
    if (nextIndex === activeMatchIndex) {
      const existing = pageEl.querySelector<HTMLElement>('.pdf-search-match--active')
      if (existing) {
        pendingScrollMatchIdRef.current = null
        scrollElementIntoReader(existing)
      }
    }
  }, [searchMatches, activeMatchIndex, navigate, scrollElementIntoReader])

  const openAndFocusSearch = useCallback((): void => {
    setSearchOpen(true)
    const input = searchInputRef.current
    if (input) {
      input.focus({ preventScroll: true })
      input.select()
    }
    requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true })
      searchInputRef.current?.select()
    })
  }, [])

  const closeSearch = useCallback((): void => {
    setSearchOpen(false)
    pendingScrollMatchIdRef.current = null
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!scrollRoot) return
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      if (!activePdf.current || loadingRef.current || event.deltaY === 0) return
      applyScale(scaleRef.current + (event.deltaY > 0 ? -0.1 : 0.1))
    }
    scrollRoot.addEventListener('wheel', handleWheel, { passive: false })
    return () => scrollRoot.removeEventListener('wheel', handleWheel)
  }, [scrollRoot, applyScale])

  useEffect(() => {
    const panel = bodyRef.current?.closest<HTMLElement>('.reader-panel') ?? null

    const dispatchPdfShortcut = (event: KeyboardEvent): void => {
      if (!activePdf.current || loadingRef.current) return
      const activeShortcuts = shortcutsRef.current
      const editable = isEditableElement(document.activeElement) || isEditableElement(event.target)
      const hasModifier = event.ctrlKey || event.metaKey || event.altKey
      if (editable && !hasModifier) return

      if (matchesShortcutEvent(event, activeShortcuts.findInDoc)) {
        event.preventDefault()
        openAndFocusSearch()
        return
      }
      if (editable) return

      if (matchesShortcutEvent(event, activeShortcuts.zoomIn)) {
        event.preventDefault()
        applyScale(scaleRef.current + 0.1)
      } else if (matchesShortcutEvent(event, activeShortcuts.zoomOut)) {
        event.preventDefault()
        applyScale(scaleRef.current - 0.1)
      } else if (matchesShortcutEvent(event, activeShortcuts.zoomReset)) {
        event.preventDefault()
        void fitWidth()
      } else if (matchesShortcutEvent(event, activeShortcuts.prevPage)) {
        event.preventDefault()
        navigate(current.current - 1)
      } else if (matchesShortcutEvent(event, activeShortcuts.nextPage)) {
        event.preventDefault()
        navigate(current.current + 1)
      } else if (matchesShortcutEvent(event, activeShortcuts.firstPage)) {
        event.preventDefault()
        navigate(1)
      } else if (matchesShortcutEvent(event, activeShortcuts.lastPage)) {
        event.preventDefault()
        navigate(activePdf.current.numPages)
      } else if (!hasModifier && !event.shiftKey && event.key === 'PageUp') {
        event.preventDefault()
        navigate(current.current - 1)
      } else if (!hasModifier && !event.shiftKey && event.key === 'PageDown') {
        event.preventDefault()
        navigate(current.current + 1)
      }
    }

    const handlePanelKeyDown = (event: KeyboardEvent): void => {
      dispatchPdfShortcut(event)
    }

    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (!isActivePane || event.defaultPrevented) return
      if (isInsideDialog(event.target) || isInsideDialog(document.activeElement)) return
      dispatchPdfShortcut(event)
    }

    panel?.addEventListener('keydown', handlePanelKeyDown)
    window.addEventListener('keydown', handleWindowKeyDown)
    return () => {
      panel?.removeEventListener('keydown', handlePanelKeyDown)
      window.removeEventListener('keydown', handleWindowKeyDown)
    }
  }, [applyScale, fitWidth, isActivePane, navigate, openAndFocusSearch])

  const onScroll = useCallback((): void => {
    const root = rootRef.current
    if (!root || !activePdf.current) return
    const anchor = navigationAnchor.current
    if (anchor) {
      if (Math.abs(root.scrollTop - anchor.scrollTop) <= 0.5 && Math.abs(root.scrollLeft - anchor.scrollLeft) <= 0.5) return
      // 原生滚动条或外部定位没有输入事件时，也不锁住用户的新位置。
      cancelNavigation()
    }
    const line = root.getBoundingClientRect().top + Math.min(160, root.clientHeight * 0.25)
    const pages = root.querySelectorAll<HTMLElement>('.pdf-page')
    for (const page of pages) {
      const box = page.getBoundingClientRect()
      if (box.top <= line && box.bottom > line) {
        const number = Number(page.dataset.pageNumber)
        if (number !== current.current) invalidateFit()
        current.current = number; setPageNumber(number); break
      }
    }
  }, [invalidateFit, cancelNavigation])

  const textCallback = useCallback((number: number, hasText: boolean): void => {
    setTextStatus(old => old[number] === hasText ? old : { ...old, [number]: hasText })
  }, [])

  const sizeCallback = useCallback((number: number, pageSize: { width: number; height: number }): void => {
    pageSizesRef.current[number] = pageSize
    setPageSizes(old => {
      const existing = old[number]
      if (existing && existing.width === pageSize.width && existing.height === pageSize.height) return old
      return { ...old, [number]: pageSize }
    })
  }, [])

  const insetsCallback = useCallback((number: number, insets: CropInsets): void => {
    pageInsetsRef.current[number] = insets
    setPageInsets(old => {
      const existing = old[number]
      if (
        existing &&
        existing.left === insets.left &&
        existing.top === insets.top &&
        existing.right === insets.right &&
        existing.bottom === insets.bottom
      ) {
        return old
      }
      return { ...old, [number]: insets }
    })
  }, [])

  const handlePageData = useCallback((number: number, data: PdfPageData | null): void => {
    const nextToken = (backdropTokensRef.current.get(number) ?? 0) + 1
    backdropTokensRef.current.set(number, nextToken)
    if (data) {
      const surface = data.element.querySelector<HTMLElement>('.pdf-page-surface')
      if (surface) {
        renderedPagesRef.current.set(number, { geometry: data.geometry, surface })
      } else {
        renderedPagesRef.current.delete(number)
      }
      const layoutResult = analyzePageLayout(data.textContent, data.geometry, {
        graphicHints: data.graphicHints
      })
      onPageLayoutRef.current?.(number, layoutResult)
      if (onPageBackdropRef.current && data.canvas.width > 0 && data.canvas.height > 0 && typeof createImageBitmap === 'function') {
        const docId = record.id
        const blockColors = sampleBlockBackgroundColors(data.canvas, layoutResult, data.geometry)
        void createImageBitmap(data.canvas)
          .then(bitmap => {
            if (backdropTokensRef.current.get(number) !== nextToken || activeDocument.current !== docId) {
              bitmap.close()
              return
            }
            onPageBackdropRef.current?.(number, { bitmap, blockColors })
          })
          .catch(() => {})
      }
    } else {
      renderedPagesRef.current.delete(number)
      onPageBackdropRef.current?.(number, null)
    }
    onPageDataRef.current?.(number, data)
  }, [record.id])

  const measureHeaderOffset = useCallback((): void => {
    const body = bodyRef.current
    const container =
      body?.closest<HTMLElement>('.split-pane-source-slot') ?? body?.closest<HTMLElement>('.reader-panel') ?? null
    if (!body || !container) return
    const offset = Math.max(0, Math.round(body.getBoundingClientRect().top - container.getBoundingClientRect().top))
    setHeaderOffsetPx(prev => (prev === offset ? prev : offset))
  }, [])

  useEffect(() => {
    const body = bodyRef.current
    const container =
      body?.closest<HTMLElement>('.split-pane-source-slot') ?? body?.closest<HTMLElement>('.reader-panel') ?? null
    if (!body || !container) return
    const observer = new ResizeObserver(() => measureHeaderOffset())
    observer.observe(container)
    observer.observe(body)
    return () => observer.disconnect()
  }, [measureHeaderOffset])

  const mirrorState = useMemo<ReaderMirrorState>(
    () => ({
      pageCount: pdf && !loading && !error ? pdf.numPages : 0,
      currentPage: pageNumber,
      scale,
      cropMargins,
      estimatedSize: size,
      pageSizes,
      pageInsets,
      pageTextStatus: textStatus,
      headerOffsetPx,
      outlineOpen,
      searchOpen,
      toolbarDisabled: !pdf || loading
    }),
    [pdf, loading, error, pageNumber, scale, cropMargins, size, pageSizes, pageInsets, textStatus, headerOffsetPx, outlineOpen, searchOpen]
  )

  useLayoutEffect(() => {
    if (!toolbarActionsRef) return
    const actions: ReaderToolbarActions = {
      toggleOutline: () => setOutlineOpen(open => !open),
      toggleSearch: () => {
        if (searchOpenRef.current) closeSearch()
        else openAndFocusSearch()
      },
      setScale: applyScale,
      adjustScale: delta => applyScale(scaleRef.current + delta),
      fitWidth: () => { void fitWidth() },
      toggleCropMargins: () => {
        cancelNavigation()
        setCropMargins(crop => !crop)
        setCropCommit(value => value + 1)
      }
    }
    toolbarActionsRef.current = actions
    return () => {
      if (toolbarActionsRef.current === actions) {
        toolbarActionsRef.current = null
      }
    }
  }, [toolbarActionsRef, applyScale, fitWidth, cancelNavigation, closeSearch, openAndFocusSearch])

  useEffect(() => {
    onMirrorStateChangeRef.current?.(mirrorState)
  }, [mirrorState])

  const matchesByPage = useMemo(() => {
    const grouped = new Map<number, SearchMatch[]>()
    if (!searchOpen || searchMatches.length === 0) return grouped
    for (const match of searchMatches) {
      let bucket = grouped.get(match.pageNumber)
      if (!bucket) {
        bucket = []
        grouped.set(match.pageNumber, bucket)
      }
      bucket.push(match)
    }
    return grouped
  }, [searchOpen, searchMatches])

  const activeMatch = searchOpen && searchMatches.length > 0 ? (searchMatches[activeMatchIndex] ?? null) : null

  const persistenceState = useMemo(
    () => (pdf && !loading ? { documentId: record.id, pageNumber, scale } : null),
    [pdf, loading, record.id, pageNumber, scale]
  )
  const saveError = useReaderPersistence(persistenceState)

  useLayoutEffect(() => {
    measureHeaderOffset()
  }, [measureHeaderOffset, searchOpen, saveError, textStatus, pageNumber, loading, error, cropMargins, scale])

  return <>
    {searchOpen && (
      <PdfSearchBar
        query={searchQuery}
        caseSensitive={caseSensitive}
        activeIndex={activeMatchIndex}
        totalMatches={searchMatches.length}
        searching={searching}
        inputRef={searchInputRef}
        onQueryChange={setSearchQuery}
        onToggleCaseSensitive={() => setCaseSensitive(value => !value)}
        onPrev={() => stepSearchMatch(-1)}
        onNext={() => stepSearchMatch(1)}
        onClose={closeSearch}
      />
    )}
    {saveError && <div role="alert" className="reader-notice error-banner">{saveError}</div>}
    {textStatus[pageNumber] === false && <div role="status" className="reader-notice">本页没有可提取文字，可能是扫描页面；当前暂不支持 OCR。</div>}
    {loading && <div className="reader-loading" role="status">正在加载 PDF…</div>}
    {error && <div className="reader-error error-banner" role="alert">{error}</div>}
    <div className="reader-body" ref={bodyRef}>
      {outlineOpen && (
        <PdfOutline
          items={outlineItems}
          loading={outlineLoading}
          autoGenerated={outlineAutoGenerated}
          currentPage={pageNumber}
          activeItemId={activeOutlineId}
          onNavigate={item => {
            if (item.pageNumber !== null) {
              setActiveOutlineId(item.id)
              navigate(item.pageNumber)
              onOutlineNavigateRef.current?.(item)
            }
          }}
          onClose={() => setOutlineOpen(false)}
        />
      )}
      <div className="reader-viewport">
        <div className="pdf-scroll" ref={handleScrollRootRef} onScroll={onScroll}
        onClick={event => {
          const interact = onSourceSentenceInteractRef.current
          if (!interact || event.button !== 0) return
          const sel = window.getSelection()
          if (sel && !sel.isCollapsed) return
          const pageEl =
            event.target instanceof Element ? event.target.closest<HTMLElement>('.pdf-page[data-page-number]') : null
          const targetPage = pageEl ? Number.parseInt(pageEl.dataset.pageNumber ?? '', 10) : Number.NaN
          const entry = Number.isInteger(targetPage) ? renderedPagesRef.current.get(targetPage) : undefined
          if (!entry || !entry.surface.isConnected) {
            interact({ type: 'clear' })
            return
          }
          try {
            const pdfPoint = clientPointToPdf(entry.geometry, entry.surface.getBoundingClientRect(), {
              x: event.clientX,
              y: event.clientY
            })
            const hitAnnotation = hitTestPageAnnotation(annotationsByPageRef.current?.get(targetPage), pdfPoint)
            if (hitAnnotation && onAnnotationClickRef.current) {
              onAnnotationClickRef.current(hitAnnotation)
              return
            }
            interact({ type: 'point', pageNumber: targetPage, pdfPoint })
          } catch {
            interact({ type: 'clear' })
          }
        }}
        onWheelCapture={event => { if (!event.ctrlKey && !event.metaKey) cancelNavigation() }}
        onTouchStartCapture={cancelNavigation} onPointerDownCapture={cancelNavigation}
        onKeyDownCapture={event => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelNavigation() }}
        aria-label="PDF 阅读区域" tabIndex={0}>
        {pdf && !loading && !error && <div className="pdf-pages">{Array.from({ length: pdf.numPages }, (_, index) => {
          const number = index + 1
          return <PdfPage
            key={number}
            pdf={pdf}
            pageNumber={number}
            scale={scale}
            devicePixelRatio={devicePixelRatio}
            scrollRoot={scrollRoot}
            estimatedSize={size}
            cropMargins={cropMargins}
            searchMatches={matchesByPage.get(number)}
            activeMatchId={activeMatch?.pageNumber === number ? activeMatch.id : null}
            activeSentenceRects={activeSentence?.pageNumber === number ? activeSentence.rects : undefined}
            annotations={annotationsByPage?.get(number)}
            editingAnnotationId={editingAnnotationId}
            isFallbackActive={Math.abs(number - pageNumber) <= 1}
            onTextStatus={textCallback}
            onPageData={handlePageData}
            onPageSize={sizeCallback}
            onPageInsets={insetsCallback}
            onActiveMatchRendered={handleActiveMatchRendered}
          />
        })}</div>}
        </div>
        {!hideFloatingPill ? (
          <div className="reader-pill-dock">
            <ReaderToolbar
              pageNumber={pageNumber}
              pageCount={pdf?.numPages ?? 0}
              scale={scale}
              disabled={!pdf || loading}
              cropMargins={cropMargins}
              onNavigate={navigate}
              onScale={applyScale}
              onFitWidth={() => { void fitWidth() }}
              onToggleCropMargins={() => {
                cancelNavigation()
                setCropMargins(crop => !crop)
                setCropCommit(value => value + 1)
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  </>
}
