import { analyzePageLayout, sampleBlockBackgroundColors, type PageLayoutResult } from './layout-analysis'
import { measureCanvasCropInsets, ZERO_CROP_INSETS, type CropInsets } from './margin-crop'
import { computeCanvasRenderRatio, type PageGeometry } from './pdf-geometry'
import { extractPageGraphicHints, type PdfOperatorListLike } from './pdf-graphics'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from './pdf-engine'
import type { PageBackdropSnapshot } from './PdfViewer'

export interface RenderedTranslationPage {
  layout: PageLayoutResult
  backdrop: PageBackdropSnapshot
  size: { width: number; height: number }
  insets: CropInsets
}

/** 使用阅读器已加载的本地 PDF；后台只生成可视译文页的底图，不创建隐藏 TextLayer。 */
export async function renderTranslationPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
  devicePixelRatio: number,
  signal: AbortSignal
): Promise<RenderedTranslationPage | null> {
  let page: PDFPageProxy | undefined
  let render: RenderTask | undefined
  let canvas: HTMLCanvasElement | undefined
  let bitmap: ImageBitmap | undefined
  const cancel = (): void => render?.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) return null
    page = await pdf.getPage(pageNumber)
    if (signal.aborted) return null
    const viewport = page.getViewport({ scale })
    const natural = page.getViewport({ scale: 1 })
    if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0) return null
    const ratio = Math.min(computeCanvasRenderRatio(viewport.width, viewport.height, scale, devicePixelRatio),
      Math.sqrt(8 * 1024 * 1024 / (viewport.width * viewport.height)), 8192 / viewport.width, 8192 / viewport.height)
    canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    const outputScale = { x: canvas.width / viewport.width, y: canvas.height / viewport.height }
    render = page.render({ canvas, viewport, transform: [outputScale.x, 0, 0, outputScale.y, 0, 0] })
    await render.promise
    if (signal.aborted) return null
    const textContent = await page.getTextContent({ includeMarkedContent: true })
    const operators = await page.getOperatorList()
    if (signal.aborted) return null
    const geometry: PageGeometry = { pageNumber, viewport, outputScale }
    const graphicHints = extractPageGraphicHints(operators as unknown as PdfOperatorListLike, geometry)
    const layout = analyzePageLayout(textContent, geometry, { graphicHints })
    const context = canvas.getContext('2d')
    let insets = ZERO_CROP_INSETS
    if (context) {
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      insets = measureCanvasCropInsets(image.data, canvas.width, canvas.height, Math.max(4, Math.round(8 * Math.min(outputScale.x, outputScale.y))))
    }
    const blockColors = sampleBlockBackgroundColors(canvas, layout, geometry)
    bitmap = await createImageBitmap(canvas)
    if (signal.aborted) { bitmap.close(); bitmap = undefined; return null }
    return { layout, backdrop: { bitmap, blockColors }, size: { width: natural.width, height: natural.height }, insets }
  } catch {
    bitmap?.close()
    return null
  } finally {
    signal.removeEventListener('abort', cancel)
    if (render) await render.promise.catch(() => {})
    if (canvas) { canvas.width = 0; canvas.height = 0 }
    if (page && !page.destroyed) page.cleanup()
  }
}
