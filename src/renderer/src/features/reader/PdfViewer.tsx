import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DocumentRecord } from '../../../../shared/contracts'
import { loadPdf, pdfErrorMessage, type PDFDocumentProxy } from './pdf-engine'
import { PdfPage, type PdfPageData } from './PdfPage'
import { ReaderToolbar } from './ReaderToolbar'
import { useReaderPersistence } from './useReaderPersistence'
import './reader.css'
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
  const current = useRef(1)
  const navigationAnchor = useRef<NavigationAnchor | null>(null)
  const anchorIntent = useRef<{ request: number; pageNumber: number; resetHorizontal: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const activePdf = useRef<PDFDocumentProxy | null>(null)
  const activeDocument = useRef<string | null>(null)
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
  useLayoutEffect(() => { rootRef.current = scrollRoot; onPageCountRef.current = onPageCount }, [scrollRoot, onPageCount])
  useLayoutEffect(() => {
    activeDocument.current = record.id
    activePdf.current = null
    cancelNavigation()
    return () => { activeDocument.current = null; activePdf.current = null; cancelNavigation() }
  }, [record.id, cancelNavigation])
  useEffect(() => {
    let cancelled = false
    let session: ReturnType<typeof loadPdf> | undefined
    setLoading(true); setError(null); setTextStatus({})
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
        anchorIntent.current = { request: fitRequest.current, pageNumber: initialPage, resetHorizontal: false }
        setPageNumber(initialPage); setScale(initialScale)
        setSize({ width: viewport.width, height: viewport.height })
        activePdf.current = loaded
        setPdf(loaded); setLoading(false)
        await window.paperflow.updatePageCount(record.id, loaded.numPages)
        if (!cancelled) await onPageCountRef.current()
      } catch (error: unknown) {
        if (!cancelled && activeDocument.current === record.id) { setError(pdfErrorMessage(error)); setLoading(false) }
      }
    }
    void open()
    return () => { cancelled = true; void session?.destroy().catch(() => {}) }
  }, [record.id])
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
    const pdf = activePdf.current
    const documentId = activeDocument.current
    if (!root || !pdf || !documentId) return
    navigationAnchor.current = { documentId, pdf, root, pageNumber: number, scrollTop: root.scrollTop, scrollLeft: root.scrollLeft, resetHorizontal }
    root.dataset.navigationAnchor = 'true'
    alignAnchor()
  }, [alignAnchor, cancelAnchor])
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
      anchorIntent.current = { request, pageNumber: number, resetHorizontal: true }
      // 向下保留两位，避免四舍五入使较宽页面超出可用区域。
      setScale(clampScale(Math.floor(available / viewport.width * 100) / 100))
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
    current.current = target; setPageNumber(target); beginAnchor(target)
  }, [pdf, beginAnchor, cancelNavigation])
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
  const persistenceState = useMemo(
    () => (pdf && !loading ? { documentId: record.id, pageNumber, scale } : null),
    [pdf, loading, record.id, pageNumber, scale]
  )
  const saveError = useReaderPersistence(persistenceState)
  return <>
    <div className="reader-document-title" title={record.originalFilename}>{record.originalFilename}</div>
    <ReaderToolbar pageNumber={pageNumber} pageCount={pdf?.numPages ?? 0} scale={scale} disabled={!pdf || loading}
      onNavigate={navigate} onScale={value => {
        cancelNavigation()
        anchorIntent.current = { request: fitRequest.current, pageNumber: current.current, resetHorizontal: false }
        setScale(clampScale(value))
      }}
      onFitWidth={() => { void fitWidth() }} importing={importing} onImport={onImport} />
    {saveError && <div role="alert" className="reader-notice error-banner">{saveError}</div>}
    {textStatus[pageNumber] === false && <div role="status" className="reader-notice">本页没有可提取文字，可能是扫描页面；当前暂不支持 OCR。</div>}
    {loading && <div className="reader-loading" role="status">正在加载 PDF…</div>}
    {error && <div className="reader-error error-banner" role="alert">{error}</div>}
    <div className="pdf-scroll" ref={setScrollRoot} onScroll={onScroll}
      onWheelCapture={cancelNavigation} onTouchStartCapture={cancelNavigation} onPointerDownCapture={cancelNavigation}
      onKeyDownCapture={event => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelNavigation() }}
      aria-label="PDF 阅读区域" tabIndex={0}>
      {pdf && !loading && !error && <div className="pdf-pages">{Array.from({ length: pdf.numPages }, (_, index) =>
        <PdfPage key={index + 1} pdf={pdf} pageNumber={index + 1} scale={scale} scrollRoot={scrollRoot} estimatedSize={size} onTextStatus={textCallback} onPageData={onPageData} />)}</div>}
    </div>
  </>
}
