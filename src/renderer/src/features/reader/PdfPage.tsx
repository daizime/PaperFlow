import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ZERO_CROP_INSETS, measureCanvasCropInsets, type CropInsets } from './margin-crop'
import { TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from './pdf-engine'
import type { PageGeometry, PageTextContent } from './pdf-geometry'
import { buildPageTextIndex, findTextRangesForMatch, type SearchMatch, type TextSpan } from './pdf-search'
import { attachSelectionHighlight } from './selection-highlight'
import { alignSingleCharacterAdvances } from './text-layer-layout'
import { attachTextSelection } from './text-selection'
import 'pdfjs-dist/web/pdf_viewer.css'
import './page.css'

export interface PdfPageData {
  geometry: PageGeometry
  textContent: PageTextContent
  textLayer: TextLayer
  element: HTMLDivElement
}

export interface PdfPageProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  scrollRoot: HTMLDivElement | null
  estimatedSize: { width: number; height: number }
  cropMargins?: boolean
  searchMatches?: readonly SearchMatch[]
  activeMatchId?: string | null
  onTextStatus(pageNumber: number, hasText: boolean): void
  /** 临时页面资源的借用接口；离开渲染范围/缩放/卸载时以 null 撤销。 */
  onPageData?(pageNumber: number, data: PdfPageData | null): void
  onPageInsets?(pageNumber: number, insets: CropInsets): void
  onActiveMatchRendered?(matchId: string, element: HTMLElement): void
}

type PageStatus = 'idle' | 'loading' | 'ready' | 'error'
const MAX_CANVAS_PIXELS = 8 * 1024 * 1024
const MAX_CANVAS_DIMENSION = 8192

interface RenderedHighlightContext {
  surface: HTMLDivElement
  highlightLayer: HTMLDivElement
  spans: TextSpan[]
  textDivs: readonly HTMLElement[]
}

interface HighlightBox {
  left: number
  top: number
  width: number
  height: number
}

function mergeLineBoxes(boxes: HighlightBox[]): HighlightBox[] {
  if (boxes.length <= 1) return boxes
  const merged: HighlightBox[] = []
  for (const box of boxes) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      Math.abs(previous.top - box.top) <= 2 &&
      Math.abs(previous.height - box.height) <= 2 &&
      box.left <= previous.left + previous.width + 1.5 &&
      previous.left <= box.left + box.width + 1.5
    ) {
      const right = Math.max(previous.left + previous.width, box.left + box.width)
      const bottom = Math.max(previous.top + previous.height, box.top + box.height)
      previous.left = Math.min(previous.left, box.left)
      previous.top = Math.min(previous.top, box.top)
      previous.width = right - previous.left
      previous.height = bottom - previous.top
    } else {
      merged.push({ ...box })
    }
  }
  return merged
}

export function PdfPage({
  pdf,
  pageNumber,
  scale,
  scrollRoot,
  estimatedSize,
  cropMargins = false,
  searchMatches,
  activeMatchId = null,
  onTextStatus,
  onPageData,
  onPageInsets,
  onActiveMatchRendered
}: PdfPageProps): React.JSX.Element {
  const elementRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const renderQueue = useRef<Promise<void>>(Promise.resolve())
  const callbacks = useRef({ onTextStatus, onPageData, onPageInsets, onActiveMatchRendered })
  const measuredRef = useRef<{ pdf: PDFDocumentProxy; pageNumber: number } | null>(null)
  const renderedRef = useRef<RenderedHighlightContext | null>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [size, setSize] = useState(estimatedSize)
  const [insets, setInsets] = useState<CropInsets>(ZERO_CROP_INSETS)
  const [status, setStatus] = useState<PageStatus>('idle')
  const [renderVersion, setRenderVersion] = useState(0)

  useLayoutEffect(() => {
    callbacks.current = { onTextStatus, onPageData, onPageInsets, onActiveMatchRendered }
  }, [onTextStatus, onPageData, onPageInsets, onActiveMatchRendered])

  useEffect(() => {
    measuredRef.current = null
    setInsets(ZERO_CROP_INSETS)
  }, [pdf, pageNumber])

  useEffect(() => {
    const element = elementRef.current
    if (!element || !scrollRoot) return
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0]
      if (entry) setNearViewport(entry.isIntersecting)
    }, { root: scrollRoot, rootMargin: '800px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRoot])

  useEffect(() => {
    const mount = mountRef.current
    const element = elementRef.current
    if (!nearViewport || !mount || !element) {
      renderedRef.current = null
      setStatus('idle')
      return
    }
    let cancelled = false
    let renderTask: RenderTask | undefined
    let textLayer: TextLayer | undefined
    let surface: HTMLDivElement | undefined
    let canvas: HTMLCanvasElement | undefined
    let page: PDFPageProxy | undefined
    let completed = false
    let releaseSelection: (() => void) | undefined
    let releaseHighlight: (() => void) | undefined
    const tasks: Promise<unknown>[] = []
    setStatus('loading')

    // 同页的新任务等待旧任务彻底结束；每轮使用独立 DOM 与 Canvas。
    const work = renderQueue.current.then(async () => {
      try {
        if (cancelled) return
        page = await pdf.getPage(pageNumber)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        if (viewport.width <= 0 || viewport.height <= 0 || !Number.isFinite(viewport.width * viewport.height)) throw new Error('无效页面尺寸')
        const natural = page.getViewport({ scale: 1 })
        setSize(previous => previous.width === natural.width && previous.height === natural.height ? previous : { width: natural.width, height: natural.height })
        surface = document.createElement('div')
        surface.className = 'pdf-page-surface'
        surface.style.width = viewport.width + 'px'
        surface.style.height = viewport.height + 'px'
        surface.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
        // 保留 PDF.js 6 的舍入变量，同时使 CSS 尺寸与统一 viewport 仅有亚像素误差。
        surface.style.setProperty('--scale-round-x', '0.000001px')
        surface.style.setProperty('--scale-round-y', '0.000001px')
        canvas = document.createElement('canvas')
        canvas.setAttribute('aria-hidden', 'true')
        canvas.style.width = viewport.width + 'px'
        canvas.style.height = viewport.height + 'px'
        const ratio = Math.min(window.devicePixelRatio || 1, 3,
          Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
          MAX_CANVAS_DIMENSION / viewport.width, MAX_CANVAS_DIMENSION / viewport.height)
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
        const outputScale = { x: canvas.width / viewport.width, y: canvas.height / viewport.height }
        const textElement = document.createElement('div')
        textElement.className = 'textLayer'
        const highlightLayer = document.createElement('div')
        highlightLayer.className = 'pdf-highlight-layer'
        highlightLayer.setAttribute('aria-hidden', 'true')
        surface.append(canvas, textElement, highlightLayer)
        mount.replaceChildren(surface)
        renderTask = page.render({ canvas, viewport, transform: [outputScale.x, 0, 0, outputScale.y, 0, 0] })
        tasks.push(renderTask.promise)
        // 尽早捕获拒绝，避免文字提取期间 Canvas 错误成为未处理 rejection。
        void renderTask.promise.catch(() => {})
        const textContent = await page.getTextContent({ includeMarkedContent: true })
        // Canvas 渲染负责加载 PDF 字体；等待字体就绪后再测量 TextLayer，避免使用回退字体。
        await renderTask.promise
        if (cancelled) return
        textLayer = new TextLayer({ textContentSource: textContent, container: textElement, viewport })
        tasks.push(textLayer.render())
        await Promise.all(tasks)
        if (cancelled) return
        alignSingleCharacterAdvances(textContent, textLayer.textDivs, viewport)
        if (measuredRef.current?.pdf !== pdf || measuredRef.current?.pageNumber !== pageNumber) {
          try {
            const context = canvas.getContext('2d')
            if (context) {
              const image = context.getImageData(0, 0, canvas.width, canvas.height)
              const marginPx = Math.max(4, Math.round(8 * Math.min(outputScale.x, outputScale.y)))
              const measured = measureCanvasCropInsets(image.data, canvas.width, canvas.height, marginPx)
              measuredRef.current = { pdf, pageNumber }
              setInsets(measured)
              callbacks.current.onPageInsets?.(pageNumber, measured)
            }
          } catch {
            // 测量白边失败时回退为不裁剪，不阻断页面显示。
          }
        }
        const geometry = { pageNumber, viewport, outputScale }
        if (scrollRoot) {
          releaseSelection = attachTextSelection(textElement, textLayer.textDivs, scrollRoot)
          releaseHighlight = attachSelectionHighlight(surface, canvas, textElement, scrollRoot, geometry, textContent, textLayer.textDivs)
        }
        renderedRef.current = {
          surface,
          highlightLayer,
          spans: buildPageTextIndex(textContent).spans,
          textDivs: textLayer.textDivs
        }
        callbacks.current.onTextStatus(pageNumber, textContent.items.some(item => 'str' in item && item.str.trim().length > 0))
        callbacks.current.onPageData?.(pageNumber, { geometry, textContent, textLayer, element })
        completed = true
        setRenderVersion(version => version + 1)
        setStatus('ready')
      } catch (error: unknown) {
        if (!cancelled) {
          renderedRef.current = null
          renderTask?.cancel()
          textLayer?.cancel()
          setStatus('error')
          // 页面级错误通过状态呈现，不将 PDF 正文或内部路径输出到日志。
          void error
        }
      } finally {
        await Promise.allSettled(tasks)
        if (cancelled || !completed) {
          renderedRef.current = null
          releaseHighlight?.()
          releaseSelection?.()
          surface?.remove()
          if (canvas) { canvas.width = 0; canvas.height = 0 }
        }
        if (page && !page.destroyed) page.cleanup()
      }
    })
    // 队列始终保持 fulfilled，文献销毁等异常不会阻断下一轮渲染。
    renderQueue.current = work.catch(() => {})
    return () => {
      cancelled = true
      renderedRef.current = null
      releaseHighlight?.()
      releaseSelection?.()
      renderTask?.cancel()
      textLayer?.cancel()
      surface?.remove()
      callbacks.current.onPageData?.(pageNumber, null)
      // 成功任务已离开 finally，离屏时仍需释放其物理像素。
      void work.finally(() => { if (canvas) { canvas.width = 0; canvas.height = 0 } }).catch(() => {})
    }
  }, [pdf, pageNumber, scale, nearViewport, scrollRoot])

  useLayoutEffect(() => {
    const rendered = renderedRef.current
    if (status !== 'ready' || !rendered) return
    const { surface, highlightLayer, spans, textDivs } = rendered
    if (!searchMatches || searchMatches.length === 0) {
      highlightLayer.replaceChildren()
      return
    }
    const bounds = surface.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return

    const range = document.createRange()
    const nodes: HTMLDivElement[] = []
    let activeElement: HTMLElement | null = null

    for (const match of searchMatches) {
      const segments = findTextRangesForMatch(spans, match.startOffset, match.endOffset)
      const boxes: HighlightBox[] = []
      for (const segment of segments) {
        const div = textDivs[segment.divIndex]
        const textNode = div?.firstChild
        if (!(textNode instanceof Text) || !div.isConnected) continue
        const start = Math.max(0, Math.min(textNode.length, segment.localStart))
        const end = Math.max(start, Math.min(textNode.length, segment.localEnd))
        if (end <= start) continue
        range.setStart(textNode, start)
        range.setEnd(textNode, end)
        for (const rect of range.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue
          boxes.push({
            left: rect.left - bounds.left,
            top: rect.top - bounds.top,
            width: rect.width,
            height: rect.height
          })
        }
      }
      const isActive = activeMatchId !== null && match.id === activeMatchId
      for (const box of mergeLineBoxes(boxes)) {
        const marker = document.createElement('div')
        marker.className = isActive ? 'pdf-search-match pdf-search-match--active' : 'pdf-search-match'
        marker.dataset.matchId = match.id
        marker.style.left = `${box.left}px`
        marker.style.top = `${box.top}px`
        marker.style.width = `${box.width}px`
        marker.style.height = `${box.height}px`
        nodes.push(marker)
        if (isActive && !activeElement) activeElement = marker
      }
    }

    highlightLayer.replaceChildren(...nodes)
    if (activeElement && activeMatchId) {
      callbacks.current.onActiveMatchRendered?.(activeMatchId, activeElement)
    }
  }, [status, renderVersion, searchMatches, activeMatchId])

  const activeInsets = cropMargins ? insets : ZERO_CROP_INSETS
  const fullWidth = size.width * scale
  const fullHeight = size.height * scale
  const style: CSSProperties = {
    width: fullWidth * (1 - activeInsets.left - activeInsets.right),
    height: fullHeight * (1 - activeInsets.top - activeInsets.bottom)
  }
  const mountStyle: CSSProperties = {
    left: -(fullWidth * activeInsets.left),
    top: -(fullHeight * activeInsets.top),
    width: fullWidth,
    height: fullHeight
  }

  return <div ref={elementRef} className="pdf-page" style={style} data-page-number={pageNumber} data-rendered={status === 'ready'} role="region" aria-label={'PDF 第 ' + pageNumber + ' 页'}>
    <div ref={mountRef} className="pdf-page-mount" style={mountStyle} />
    {status !== 'ready' && <div className={'pdf-page-status' + (status === 'error' ? ' pdf-page-error' : '')} role={status === 'error' ? 'alert' : undefined}>
      {status === 'error' ? '第 ' + pageNumber + ' 页无法渲染，文件可能已损坏。请重新导入或选择其他文献。' : status === 'loading' ? '正在渲染第 ' + pageNumber + ' 页…' : '第 ' + pageNumber + ' 页'}
    </div>}
  </div>
}
