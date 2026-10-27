import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DocumentRecord } from '../../../../shared/contracts'
import { loadPdf, pdfErrorMessage, type PDFDocumentProxy } from './pdf-engine'
import { PdfPage, type PdfPageData } from './PdfPage'
import { ReaderToolbar } from './ReaderToolbar'
import { useReaderPersistence } from './useReaderPersistence'
import './reader.css'
export interface PdfViewerProps {
  document: DocumentRecord; onImport(): void; onPageCount(): Promise<void>
  onPageData?(pageNumber: number, data: PdfPageData | null): void
}
const clampScale = (scale: number): number => Math.min(3, Math.max(0.5, Math.round(scale * 100) / 100))
export function PdfViewer({ document: record, onImport, onPageCount, onPageData }: PdfViewerProps): React.JSX.Element {
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [size, setSize] = useState({ width: 612, height: 792 })
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [textStatus, setTextStatus] = useState<Record<number, boolean>>({})
  const current = useRef(1)
  const restoring = useRef(true)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const onPageCountRef = useRef(onPageCount)
  useLayoutEffect(() => { rootRef.current = scrollRoot; onPageCountRef.current = onPageCount }, [scrollRoot, onPageCount])
  useEffect(() => {
    let cancelled = false
    let session: ReturnType<typeof loadPdf> | undefined
    setLoading(true); setError(null); setTextStatus({}); restoring.current = true
    async function open(): Promise<void> {
      try {
        const [bytes, saved] = await Promise.all([window.paperflow.readPdfBytes(record.id), window.paperflow.getReaderState(record.id)])
        if (cancelled) return
        session = loadPdf(bytes)
        const loaded = await session.promise
        const first = await loaded.getPage(1)
        const viewport = first.getViewport({ scale: 1 })
        if (cancelled) return
        const width = rootRef.current?.clientWidth ?? 720
        const initialScale = saved?.scale ?? clampScale((width - 56) / viewport.width)
        const initialPage = Math.min(loaded.numPages, saved?.pageNumber ?? 1)
        current.current = initialPage
        setPageNumber(initialPage); setScale(initialScale)
        setSize({ width: viewport.width, height: viewport.height })
        setPdf(loaded); setLoading(false)
        await window.paperflow.updatePageCount(record.id, loaded.numPages)
        if (!cancelled) await onPageCountRef.current()
      } catch (error: unknown) {
        if (!cancelled) { setError(pdfErrorMessage(error)); setLoading(false) }
      }
    }
    void open()
    return () => { cancelled = true; void session?.destroy().catch(() => {}) }
  }, [record.id])
  const scrollToPage = useCallback((number: number): void => {
    rootRef.current?.querySelector<HTMLElement>('[data-page-number="' + number + '"]')?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [])
  useLayoutEffect(() => {
    if (!pdf) return
    restoring.current = true
    const frame = requestAnimationFrame(() => {
      scrollToPage(current.current)
      requestAnimationFrame(() => { restoring.current = false })
    })
    return () => cancelAnimationFrame(frame)
  }, [pdf, scale, scrollToPage])
  const navigate = useCallback((number: number): void => {
    if (!pdf) return
    const target = Math.max(1, Math.min(pdf.numPages, Math.trunc(number)))
    current.current = target; setPageNumber(target); scrollToPage(target)
  }, [pdf, scrollToPage])
  const onScroll = useCallback((): void => {
    const root = rootRef.current
    if (!root || restoring.current) return
    const line = root.getBoundingClientRect().top + Math.min(160, root.clientHeight * 0.25)
    const pages = root.querySelectorAll<HTMLElement>('.pdf-page')
    for (const page of pages) {
      const box = page.getBoundingClientRect()
      if (box.top <= line && box.bottom > line) {
        const number = Number(page.dataset.pageNumber)
        current.current = number; setPageNumber(number); break
      }
    }
  }, [])
  const textCallback = useCallback((number: number, hasText: boolean): void => {
    setTextStatus(old => old[number] === hasText ? old : { ...old, [number]: hasText })
  }, [])
  const saveError = useReaderPersistence(pdf && !loading ? {
    documentId: record.id, pageNumber, scale, updatedAt: new Date().toISOString()
  } : null)
  return <>
    <div className="reader-document-title" title={record.originalFilename}>{record.originalFilename}</div>
    <ReaderToolbar pageNumber={pageNumber} pageCount={pdf?.numPages ?? 0} scale={scale} disabled={!pdf || loading}
      onNavigate={navigate} onScale={value => setScale(clampScale(value))}
      onFitWidth={() => setScale(clampScale(((rootRef.current?.clientWidth ?? 720) - 56) / size.width))} onImport={onImport} />
    {saveError && <div role="alert" className="reader-notice error-banner">{saveError}</div>}
    {textStatus[pageNumber] === false && <div role="status" className="reader-notice">本页没有可提取文字，可能是扫描页面；当前暂不支持 OCR。</div>}
    {loading && <div className="reader-loading" role="status">正在加载 PDF…</div>}
    {error && <div className="reader-error error-banner" role="alert">{error}</div>}
    <div className="pdf-scroll" ref={setScrollRoot} onScroll={onScroll} aria-label="PDF 阅读区域" tabIndex={0}>
      {pdf && !loading && !error && <div className="pdf-pages">{Array.from({ length: pdf.numPages }, (_, index) =>
        <PdfPage key={index + 1} pdf={pdf} pageNumber={index + 1} scale={scale} scrollRoot={scrollRoot} estimatedSize={size} onTextStatus={textCallback} onPageData={onPageData} />)}</div>}
    </div>
  </>
}
