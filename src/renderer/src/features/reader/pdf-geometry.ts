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

const LIGATURE_RE = /[\uFB00-\uFB06]/g
const LIGATURE_MAP: Record<string, string> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st'
}

/** 清理原生选区文本的控制字符与断词连字符，返回用于批注与划词浮条的精确摘录。 */
export function cleanSelectedQuoteText(raw: string | undefined): string | null {
  if (!raw) return null
  let filtered = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    if (code === 0x7f || (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      continue
    }
    filtered += raw[i]
  }
  const normalized = filtered
    .replace(LIGATURE_RE, ch => LIGATURE_MAP[ch] ?? ch)
    .replace(/([A-Za-z])[-\u00AD\u2010]\s*\r?\n\s*([a-z])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return null
  return normalized.slice(0, 4000)
}

export function samePageRects(a: readonly PageRect[], b: readonly PageRect[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (
      Math.abs(a[i].x - b[i].x) > 0.05 ||
      Math.abs(a[i].y - b[i].y) > 0.05 ||
      Math.abs(a[i].width - b[i].width) > 0.05 ||
      Math.abs(a[i].height - b[i].height) > 0.05
    ) {
      return false
    }
  }
  return true
}

/** 将同一阅读行内的细碎 DOM span 矩形按词间距并合，保留跨栏与换行分隔。 */
export function mergeViewportLineRects(rects: readonly PageRect[]): PageRect[] {
  const valid = rects.filter(
    r =>
      Number.isFinite(r.x) &&
      Number.isFinite(r.y) &&
      Number.isFinite(r.width) &&
      Number.isFinite(r.height) &&
      r.width > 0.5 &&
      r.height > 0.5
  )
  if (valid.length <= 1) return valid.map(r => ({ ...r }))

  const sorted = [...valid].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2) || a.x - b.x)
  const rows: PageRect[][] = []
  for (const rect of sorted) {
    const cy = rect.y + rect.height / 2
    const lastRow = rows[rows.length - 1]
    if (lastRow) {
      const ref = lastRow[0]
      const refCy = ref.y + ref.height / 2
      const maxH = Math.max(rect.height, ref.height)
      if (Math.abs(cy - refCy) <= maxH * 0.45 && Math.abs(rect.height - ref.height) <= maxH * 0.6) {
        lastRow.push(rect)
        continue
      }
    }
    rows.push([rect])
  }

  const merged: PageRect[] = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    const rowMerged: PageRect[] = []
    for (const box of row) {
      const prev = rowMerged[rowMerged.length - 1]
      const gapLimit = prev ? Math.max(4, Math.max(prev.height, box.height) * 0.65) : 0
      if (prev && box.x <= prev.x + prev.width + gapLimit) {
        const right = Math.max(prev.x + prev.width, box.x + box.width)
        const bottom = Math.max(prev.y + prev.height, box.y + box.height)
        prev.x = Math.min(prev.x, box.x)
        prev.y = Math.min(prev.y, box.y)
        prev.width = right - prev.x
        prev.height = bottom - prev.y
      } else {
        rowMerged.push({ ...box })
      }
    }
    merged.push(...rowMerged)
  }
  return merged
}

function selectedTextSlice(range: Range, text: Text): { start: number; end: number } | undefined {
  if (range.collapsed || text.length <= 0 || !range.intersectsNode(text)) return
  try {
    if (text !== range.startContainer && range.comparePoint(text, 0) !== 0) return
    if (text !== range.endContainer && range.comparePoint(text, text.length) !== 0) return
  } catch {
    return
  }
  const start = text === range.startContainer ? Math.max(0, Math.min(text.length, range.startOffset)) : 0
  const end = text === range.endContainer ? Math.max(0, Math.min(text.length, range.endOffset)) : text.length
  return end > start ? { start, end } : undefined
}

/** 将跨页鼠标选区裁到本页并合并同行片段，再转换为与缩放无关的 PDF 坐标矩形。 */
export function selectionToPdfRects(selection: Selection | null, pageElement: HTMLElement, geometry: PageGeometry): PdfSelectionRegion[] {
  if (!selection || selection.isCollapsed || !pageElement.isConnected) return []
  const bounds = pageElement.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return []
  const localRects: PageRect[] = []
  const pushClippedRect = (rect: DOMRect): PageRect | null => {
    const left = Math.max(rect.left, bounds.left)
    const top = Math.max(rect.top, bounds.top)
    const right = Math.min(rect.right, bounds.right)
    const bottom = Math.min(rect.bottom, bounds.bottom)
    if (right <= left || bottom <= top) return null
    return {
      x: (left - bounds.left) * geometry.viewport.width / bounds.width,
      y: (top - bounds.top) * geometry.viewport.height / bounds.height,
      width: (right - left) * geometry.viewport.width / bounds.width,
      height: (bottom - top) * geometry.viewport.height / bounds.height
    }
  }

  const textLayer = pageElement.querySelector<HTMLElement>('.textLayer')
  const textNodes: Text[] = []
  if (textLayer) {
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT)
    let curr: Node | null
    while ((curr = walker.nextNode())) {
      if (curr instanceof Text && curr.length > 0) textNodes.push(curr)
    }
  }
  const slice = textNodes.length > 0 ? document.createRange() : null

  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index)
    if (!range.intersectsNode(pageElement)) continue
    if (textLayer && slice && range.intersectsNode(textLayer)) {
      for (const node of textNodes) {
        const part = selectedTextSlice(range, node)
        if (!part) continue
        const partText = node.data.slice(part.start, part.end)
        slice.setStart(node, part.start)
        slice.setEnd(node, part.end)
        for (const rect of slice.getClientRects()) {
          const local = pushClippedRect(rect)
          if (!local) continue
          if (!partText.trim() && local.width > local.height * 1.35) continue
          localRects.push(local)
        }
      }
      continue
    }
    for (const rect of range.getClientRects()) {
      const local = pushClippedRect(rect)
      if (local) localRects.push(local)
    }
  }

  const regions: PdfSelectionRegion[] = []
  const seen = new Set<string>()
  for (const local of mergeViewportLineRects(localRects)) {
    const pdfRect = viewportRectToPdf(geometry, local)
    const key = [pdfRect.x, pdfRect.y, pdfRect.width, pdfRect.height].map(value => value.toFixed(4)).join(',')
    if (!seen.has(key)) {
      regions.push({ pageNumber: geometry.pageNumber, rect: pdfRect })
      seen.add(key)
      if (regions.length >= 200) break
    }
  }
  return regions
}

export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024
export const MAX_CANVAS_DIMENSION = 8192

/**
 * 计算 PDF.js 画布物理像素倍率：在低 DPR 屏与窄分栏缩放下自动启用 2x–3x 过采样以消除锯齿发虚，
 * 同时受限于最大总像素（16M）与最大单边（8192px）安全阈值。
 */
export function computeCanvasRenderRatio(
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
  devicePixelRatio: number
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const safeW = Math.max(1, Number.isFinite(viewportWidth) ? viewportWidth : 1)
  const safeH = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 1)

  let desired: number
  if (dpr < 1.75) {
    const multiplier = scale > 0 && scale < 0.85 && dpr <= 1.25 ? 3 : 2
    desired = Math.min(4, Math.max(2, dpr * multiplier))
  } else {
    desired = scale > 0 && scale < 0.9 ? Math.min(4, dpr * 1.5) : Math.min(3, dpr)
  }

  const pixelCap = Math.sqrt(MAX_CANVAS_PIXELS / (safeW * safeH))
  const dimCap = Math.min(MAX_CANVAS_DIMENSION / safeW, MAX_CANVAS_DIMENSION / safeH)
  return Math.max(1, Math.min(desired, pixelCap, dimCap))
}

/**
 * 按未缩放 PDF 坐标在当页已有批注高亮中命中点击目标：
 * 优先命中内部（dist === 0）与面积更小的局部标注（如单词高亮优先于包裹它的整句高亮）。
 */
export function hitTestPageAnnotation<T extends { rects: readonly PageRect[]; updatedAt?: string }>(
  annotations: readonly T[] | undefined,
  pdfPoint: PagePoint,
  paddingPt = 2
): T | null {
  if (!annotations || annotations.length === 0) return null
  let best: T | null = null
  let bestDist = Number.POSITIVE_INFINITY
  let bestArea = Number.POSITIVE_INFINITY
  let bestUpdated = ''
  let bestIndex = -1

  for (let i = 0; i < annotations.length; i += 1) {
    const ann = annotations[i]
    if (!ann.rects || ann.rects.length === 0) continue
    let minDist = Number.POSITIVE_INFINITY
    let totalArea = 0
    for (const r of ann.rects) {
      totalArea += Math.max(1, r.width * r.height)
      const dx = pdfPoint.x < r.x ? r.x - pdfPoint.x : pdfPoint.x > r.x + r.width ? pdfPoint.x - (r.x + r.width) : 0
      const dy = pdfPoint.y < r.y ? r.y - pdfPoint.y : pdfPoint.y > r.y + r.height ? pdfPoint.y - (r.y + r.height) : 0
      const dist = Math.hypot(dx, dy)
      if (dist < minDist) minDist = dist
    }
    if (minDist > paddingPt) continue

    const updated = ann.updatedAt ?? ''
    const isCloser = minDist < bestDist - 1e-6
    const isSameDist = Math.abs(minDist - bestDist) <= 1e-6
    const isSmallerArea = isSameDist && totalArea < bestArea - 1e-3
    const isSameArea = isSameDist && Math.abs(totalArea - bestArea) <= 1e-3
    const isNewer = isSameArea && (updated > bestUpdated || (updated === bestUpdated && i > bestIndex))

    if (isCloser || isSmallerArea || isNewer) {
      best = ann
      bestDist = minDist
      bestArea = totalArea
      bestUpdated = updated
      bestIndex = i
    }
  }

  return best
}
