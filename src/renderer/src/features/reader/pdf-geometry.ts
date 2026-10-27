import type { PageViewport, PDFPageProxy } from './pdf-engine'

export interface PagePoint { x: number; y: number }
export interface PageRect extends PagePoint { width: number; height: number }
export interface PageGeometry {
  pageNumber: number
  /** 所有浏览器坐标均为 CSS 像素，不包含 Canvas 的物理像素缩放。 */
  viewport: PageViewport
  outputScale: { x: number; y: number }
}
export type PageTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
export interface PdfSelectionRegion { pageNumber: number; rect: PageRect }

function pointFromCoordinates(coordinates: unknown): PagePoint {
  if (!Array.isArray(coordinates)) throw new Error('PDF 坐标转换结果无效。')
  const x: unknown = coordinates[0]
  const y: unknown = coordinates[1]
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('PDF 坐标转换结果无效。')
  }
  return { x, y }
}

export function pdfPointToViewport(geometry: PageGeometry, point: PagePoint): PagePoint {
  return pointFromCoordinates(geometry.viewport.convertToViewportPoint(point.x, point.y))
}

export function viewportPointToPdf(geometry: PageGeometry, point: PagePoint): PagePoint {
  return pointFromCoordinates(geometry.viewport.convertToPdfPoint(point.x, point.y))
}

function mappedRect(rect: PageRect, map: (point: PagePoint) => PagePoint): PageRect {
  const points = [
    map({ x: rect.x, y: rect.y }),
    map({ x: rect.x + rect.width, y: rect.y }),
    map({ x: rect.x, y: rect.y + rect.height }),
    map({ x: rect.x + rect.width, y: rect.y + rect.height })
  ]
  const left = Math.min(...points.map(point => point.x))
  const bottom = Math.min(...points.map(point => point.y))
  return {
    x: left, y: bottom,
    width: Math.max(...points.map(point => point.x)) - left,
    height: Math.max(...points.map(point => point.y)) - bottom
  }
}

/** 同时处理 CropBox、UserUnit、缩放和页面固有旋转。 */
export function pdfRectToViewport(geometry: PageGeometry, rect: PageRect): PageRect {
  return mappedRect(rect, point => pdfPointToViewport(geometry, point))
}

export function viewportRectToPdf(geometry: PageGeometry, rect: PageRect): PageRect {
  return mappedRect(rect, point => viewportPointToPdf(geometry, point))
}

export function clientPointToPdf(geometry: PageGeometry, pageBounds: DOMRectReadOnly, point: PagePoint): PagePoint {
  if (pageBounds.width <= 0 || pageBounds.height <= 0) throw new Error('PDF 页面尚未布局。')
  return viewportPointToPdf(geometry, {
    x: (point.x - pageBounds.left) * geometry.viewport.width / pageBounds.width,
    y: (point.y - pageBounds.top) * geometry.viewport.height / pageBounds.height
  })
}

/** 将跨页鼠标选区裁到本页，再转换为与缩放无关的 PDF 坐标矩形。 */
export function selectionToPdfRects(selection: Selection | null, pageElement: HTMLElement, geometry: PageGeometry): PdfSelectionRegion[] {
  if (!selection || selection.isCollapsed || !pageElement.isConnected) return []
  const bounds = pageElement.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return []
  const regions: PdfSelectionRegion[] = []
  const seen = new Set<string>()
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index)
    if (!range.intersectsNode(pageElement)) continue
    for (const rect of range.getClientRects()) {
      const left = Math.max(rect.left, bounds.left)
      const top = Math.max(rect.top, bounds.top)
      const right = Math.min(rect.right, bounds.right)
      const bottom = Math.min(rect.bottom, bounds.bottom)
      if (right <= left || bottom <= top) continue
      const local = {
        x: (left - bounds.left) * geometry.viewport.width / bounds.width,
        y: (top - bounds.top) * geometry.viewport.height / bounds.height,
        width: (right - left) * geometry.viewport.width / bounds.width,
        height: (bottom - top) * geometry.viewport.height / bounds.height
      }
      const pdfRect = viewportRectToPdf(geometry, local)
      const key = [pdfRect.x, pdfRect.y, pdfRect.width, pdfRect.height].map(value => value.toFixed(4)).join(',')
      if (!seen.has(key)) { regions.push({ pageNumber: geometry.pageNumber, rect: pdfRect }); seen.add(key) }
    }
  }
  return regions
}
