import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DocumentRecord } from '../../../../shared/contracts'
import { type CropInsets } from './margin-crop'
import { PdfOutline } from './PdfOutline'
import { PdfPage, type PdfPageData } from './PdfPage'
import { PdfSearchBar } from './PdfSearchBar'
import { ReaderToolbar } from './ReaderToolbar'
import { loadPdf, pdfErrorMessage, type PDFDocumentProxy } from './pdf-engine'
import { extractPdfOutline, type PdfOutlineItem } from './pdf-outline'
import { PdfSearchService, type SearchMatch } from './pdf-search'
import { useReaderPersistence } from './useReaderPersistence'
import './reader.css'
import './reader-ux.css'

export interface PdfViewerProps {
  document: DocumentRecord; onImport(): void; onPageCount(): Promise<void>
  importing: boolean
  onPageData?(pageNumber: number, data: PdfPageData | null): void
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

export function PdfViewer({ document: record, importing, onImport, onPageCount, onPageData }: PdfViewerProps): React.JSX.Element {
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [size, setSize] = useState({ width: 612, height: 792 })
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1)
  const [fitCommit, setFitCommit] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [textStatus, setTextStatus] = useState<Record<number, boolean>>({})

  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outlineItems, setOutlineItems] = useState<PdfOutlineItem[]>([])
  const [outlineLoading, setOutlineLoading] = useState(false)

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([])
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const [searching, setSearching] = useState(false)

  const [cropMargins, setCropMargins] = useState(false)
  const [cropCommit, setCropCommit] = useState(0)

  const current = useRef(1)
  const scaleRef = useRef(1)
  const loadingRef = useRef(true)
  const cropMarginsRef = useRef(false)
  const navigationAnchor = useRef<NavigationAnchor | null>(null)
  const anchorIntent = useRef<{ request: number; pageNumber: number; resetHorizontal: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const activePdf = useRef<PDFDocumentProxy | null>(null)
  const activeDocument = useRef<string | null>(null)
  const searchServiceRef = useRef<PdfSearchService | null>(null)
  const pageInsetsRef = useRef<Record<number, CropInsets>>({})
  const pendingScrollMatchIdRef = useRef<string | null>(null)
  const fitRequest = useRef(0)

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
  useLayoutEffect(() => {
    rootRef.current = scrollRoot
    onPageCountRef.current = onPageCount
    scaleRef.current = scale
    loadingRef.current = loading
    cropMarginsRef.current = cropMargins
  }, [scrollRoot, onPageCount, scale, loading, cropMargins])

  useLayoutEffect(() => {
    activeDocument.current = record.id
    activePdf.current = null
    pageInsetsRef.current = {}
    pendingScrollMatchIdRef.current = null
    cancelNavigation()
    return () => {
      activeDocument.current = null
      activePdf.current = null
      cancelNavigation()
    }
  }, [record.id, cancelNavigation])

  useEffect(() => {
    let cancelled = false
    let session: ReturnType<typeof loadPdf> | undefined
    searchServiceRef.current?.dispose()
    searchServiceRef.current = null
    setLoading(true); setError(null); setTextStatus({})
    setOutlineOpen(false); setOutlineItems([]); setOutlineLoading(false)
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
        const width = rootRef.current?.clientWidth ?? 720
        const initialScale = saved?.scale ?? clampScale((width - 56) / viewport.width)
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
    void extractPdfOutline(pdf, controller.signal)
      .then(items => {
        if (!controller.signal.aborted && activePdf.current === pdf) {
          setOutlineItems(items)
          setOutlineLoading(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && activePdf.current === pdf) {
          setOutlineItems([])
          setOutlineLoading(false)
        }
      })
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
    const panel = titleRef.current?.closest<HTMLElement>('.reader-panel') ?? null
    const handlePanelKeyDown = (event: KeyboardEvent): void => {
      if (!activePdf.current || loadingRef.current) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && !event.altKey) {
        const lower = event.key.toLowerCase()
        if (lower === 'f') {
          event.preventDefault()
          openAndFocusSearch()
          return
        }
        if (event.key === '=' || event.key === '+') {
          event.preventDefault()
          applyScale(scaleRef.current + 0.1)
          return
        }
        if (event.key === '-' || event.key === '_') {
          event.preventDefault()
          applyScale(scaleRef.current - 0.1)
          return
        }
        if (event.key === '0') {
          event.preventDefault()
          void fitWidth()
          return
        }
      }
      if (mod || event.altKey || event.shiftKey) return
      if (isEditableElement(document.activeElement) || isEditableElement(event.target)) return

      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        navigate(current.current - 1)
      } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault()
        navigate(current.current + 1)
      } else if (event.key === 'Home') {
        event.preventDefault()
        navigate(1)
      } else if (event.key === 'End') {
        event.preventDefault()
        navigate(activePdf.current.numPages)
      }
    }

    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !activePdf.current || loadingRef.current) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openAndFocusSearch()
      }
    }

    panel?.addEventListener('keydown', handlePanelKeyDown)
    window.addEventListener('keydown', handleWindowKeyDown)
    return () => {
      panel?.removeEventListener('keydown', handlePanelKeyDown)
      window.removeEventListener('keydown', handleWindowKeyDown)
    }
  }, [applyScale, fitWidth, navigate, openAndFocusSearch])

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

  const insetsCallback = useCallback((number: number, insets: CropInsets): void => {
    pageInsetsRef.current[number] = insets
  }, [])

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

  const defaultTitle = record.originalFilename.replace(/\.pdf$/i, '') || record.originalFilename
  const shownTitle = record.displayTitle !== defaultTitle ? record.displayTitle : record.originalFilename

  return <>
    <div ref={titleRef} className="reader-document-title" title={record.originalFilename}>{shownTitle}</div>
    <ReaderToolbar
      pageNumber={pageNumber}
      pageCount={pdf?.numPages ?? 0}
      scale={scale}
      disabled={!pdf || loading}
      importing={importing}
      outlineOpen={outlineOpen}
      searchOpen={searchOpen}
      cropMargins={cropMargins}
      onNavigate={navigate}
      onScale={applyScale}
      onFitWidth={() => { void fitWidth() }}
      onToggleOutline={() => setOutlineOpen(open => !open)}
      onToggleSearch={() => {
        if (searchOpen) closeSearch()
        else openAndFocusSearch()
      }}
      onToggleCropMargins={() => {
        cancelNavigation()
        setCropMargins(crop => !crop)
        setCropCommit(value => value + 1)
      }}
      onImport={onImport}
    />
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
    <div className="reader-body">
      {outlineOpen && (
        <PdfOutline
          items={outlineItems}
          loading={outlineLoading}
          currentPage={pageNumber}
          onNavigate={navigate}
          onClose={() => setOutlineOpen(false)}
        />
      )}
      <div className="pdf-scroll" ref={setScrollRoot} onScroll={onScroll}
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
            scrollRoot={scrollRoot}
            estimatedSize={size}
            cropMargins={cropMargins}
            searchMatches={matchesByPage.get(number)}
            activeMatchId={activeMatch?.pageNumber === number ? activeMatch.id : null}
            onTextStatus={textCallback}
            onPageData={onPageData}
            onPageInsets={insetsCallback}
            onActiveMatchRendered={handleActiveMatchRendered}
          />
        })}</div>}
      </div>
    </div>
  </>
}
