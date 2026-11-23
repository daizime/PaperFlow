import './forced-colors.css'
import type { PageGeometry, PageRect, PageTextContent } from './pdf-geometry'
import {
  composeAffine,
  displayScaleForViewport,
  displayToViewportRect,
  projectVisualRun,
  selectionBridges,
  viewportToDisplayRect,
  type AffineMatrix,
  type SelectionRun,
  type VisualRunProjection
} from './selection-bridges'
import { selectionInk } from './selection-ink'

export {
  composeAffine,
  displayScaleForViewport,
  displayToViewportRect,
  projectVisualRun,
  viewportToDisplayRect,
  type AffineMatrix,
  type VisualRunProjection
}

export interface TextNodeLike {
  readonly length: number
}

export interface TextSelectionRange {
  collapsed: boolean
  startContainer: Node | TextNodeLike
  startOffset: number
  endContainer: Node | TextNodeLike
  endOffset: number
  intersectsNode(node: Node): boolean
  comparePoint?(node: Node, offset: number): number
}

interface TextRun {
  node: Text
  baseline: number
  em: number
  horizontal: boolean
}

interface HighlightPage {
  surface: HTMLElement
  layer: HTMLElement
  reader: HTMLElement
  canvas: HTMLCanvasElement
  geometry: PageGeometry
  displayScale: number
  textRuns: readonly TextRun[]
  path: SVGPathElement
  ink: WeakMap<Text, PageRect | undefined>
}

interface PagePaintResult {
  original: PageRect[]
  bridges: PageRect[]
  trimmed: boolean
}

const mathSymbol = /[\p{Sm}\u2070-\u209f\u00b7\u2026\u22c5\u22ef]/u
const svgNamespace = 'http://www.w3.org/2000/svg'
const pages = new Set<HighlightPage>()
let scheduled: number | null = null

export function selectedPart(range: TextSelectionRange, text: Text | TextNodeLike): { start: number; end: number } | undefined {
  if (range.collapsed || text.length <= 0 || !range.intersectsNode(text as unknown as Node)) return
  if (typeof range.comparePoint === 'function') {
    try {
      // Text 是叶节点：非端点节点若部分或全部落入选区，其起止边界必都在选区内。
      if (text !== range.startContainer && range.comparePoint(text as unknown as Node, 0) !== 0) return
      if (text !== range.endContainer && range.comparePoint(text as unknown as Node, text.length) !== 0) return
    } catch {
      return
    }
  }
  const start = text === range.startContainer ? Math.max(0, Math.min(text.length, range.startOffset)) : 0
  const end = text === range.endContainer ? Math.max(0, Math.min(text.length, range.endOffset)) : text.length
  return end > start ? { start, end } : undefined
}

function pageRect(rect: DOMRect, bounds: DOMRect, geometry: PageGeometry): PageRect | undefined {
  const left = Math.max(bounds.left, rect.left)
  const top = Math.max(bounds.top, rect.top)
  const right = Math.min(bounds.right, rect.right)
  const bottom = Math.min(bounds.bottom, rect.bottom)
  if (right <= left || bottom <= top) return
  const scaleX = geometry.viewport.width / bounds.width
  const scaleY = geometry.viewport.height / bounds.height
  return { x: (left - bounds.left) * scaleX, y: (top - bounds.top) * scaleY, width: (right - left) * scaleX, height: (bottom - top) * scaleY }
}

function pageElementOf(node: Node | null): HTMLElement | null {
  if (!node) return null
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest<HTMLElement>('.pdf-page') ?? null
}

function collectPageSelection(page: HighlightPage, range: Range): PagePaintResult | null {
  if (!page.reader.contains(range.startContainer) || !page.reader.contains(range.endContainer) || !range.intersectsNode(page.layer)) return null
  if (!Number.isFinite(page.displayScale) || page.displayScale <= 0) return null
  const bounds = page.surface.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return null

  const original: PageRect[] = []
  const runs: SelectionRun[] = []
  const slice = document.createRange()
  let trimmed = false
  for (const run of page.textRuns) {
    const part = selectedPart(range, run.node)
    if (!part) continue
    const text = run.node.data.slice(part.start, part.end)
    const math = mathSymbol.test(text)
    const chars = [...text.replace(/\s+/g, '')]
    const pureMathSymbol = run.horizontal && math && part.start === 0 && part.end === run.node.length &&
      chars.length >= 1 && chars.length <= 3 && chars.every(ch => mathSymbol.test(ch))
    slice.setStart(run.node, part.start)
    slice.setEnd(run.node, part.end)
    for (const rect of slice.getClientRects()) {
      const local = pageRect(rect, bounds, page.geometry)
      if (!local) continue
      const displayRect = viewportToDisplayRect(local, page.displayScale)
      if (!text.trim() && displayRect.width > run.em * 1.25) continue
      if (pureMathSymbol && !page.ink.has(run.node)) {
        const measured = selectionInk(page.canvas, local, page.geometry)
        const ink = measured && viewportToDisplayRect(measured, page.displayScale)
        page.ink.set(run.node, ink && displayRect.height - ink.height > 2 ? { ...displayRect, y: ink.y, height: ink.height } : undefined)
      }
      const ink = pureMathSymbol ? page.ink.get(run.node) : undefined
      trimmed ||= Boolean(ink)
      original.push(ink ? displayToViewportRect(ink, page.displayScale) : local)
      if (run.horizontal) runs.push({ rect: displayRect, ink, baseline: run.baseline, em: run.em, math })
    }
  }
  return { original, bridges: selectionBridges(runs), trimmed }
}

function schedule(): void {
  if (scheduled !== null) return
  scheduled = requestAnimationFrame(() => {
    scheduled = null
    const selection = document.getSelection()
    const range = selection && !selection.isCollapsed && selection.rangeCount === 1 ? selection.getRangeAt(0) : null
    if (!range) {
      for (const page of pages) {
        page.path.removeAttribute('d')
        page.layer.removeAttribute('data-continuous-selection')
      }
      return
    }
    const collected = new Map<HighlightPage, PagePaintResult>()
    let activePages = 0
    for (const page of pages) {
      const result = collectPageSelection(page, range)
      if (!result) continue
      collected.set(page, result)
      if (result.original.length > 0) activePages++
    }
    const startPage = pageElementOf(range.startContainer)
    const endPage = pageElementOf(range.endContainer)
    const crossPage = activePages > 1 || Boolean(startPage && endPage && startPage !== endPage)
    for (const page of pages) {
      const result = collected.get(page)
      const shouldPaint = Boolean(result && result.original.length > 0 && (result.bridges.length > 0 || result.trimmed || crossPage))
      if (!shouldPaint || !result) {
        page.path.removeAttribute('d')
        page.layer.removeAttribute('data-continuous-selection')
        continue
      }
      const rectangles = [...result.original, ...result.bridges.map(rect => displayToViewportRect(rect, page.displayScale))]
      // 同一条路径统一施加透明度，交叠处仍只绘制一次蓝色。
      const data = rectangles.map(({ x, y, width, height }) => `M${x} ${y}h${width}v${height}h${-width}Z`).join(' ')
      page.path.setAttribute('d', data)
      page.layer.toggleAttribute('data-continuous-selection', true)
    }
  })
}

/** 绘制真实 Selection 的补间区域，不替换文字节点、选区端点或复制内容。 */
export function attachSelectionHighlight(
  surface: HTMLElement, canvas: HTMLCanvasElement, layer: HTMLElement, reader: HTMLElement, geometry: PageGeometry,
  content: PageTextContent, textDivs: readonly HTMLElement[]
): () => void {
  const displayScale = displayScaleForViewport(geometry.viewport)
  const textRuns: TextRun[] = []
  let index = 0
  for (const item of content.items) {
    if (!('str' in item)) continue
    const node = textDivs[index++]?.firstChild
    if (!(node instanceof Text) || node.data !== item.str) continue
    const projected = projectVisualRun(geometry.viewport.transform, item.transform, displayScale, item.dir)
    if (!projected) continue
    textRuns.push({ node, ...projected })
  }
  const svg = document.createElementNS(svgNamespace, 'svg')
  const path = document.createElementNS(svgNamespace, 'path')
  svg.classList.add('pdf-selection-shape')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('viewBox', `0 0 ${geometry.viewport.width} ${geometry.viewport.height}`)
  svg.append(path)
  surface.append(svg)
  const page: HighlightPage = { surface, canvas, layer, reader, geometry, displayScale, textRuns, path, ink: new WeakMap() }
  if (!pages.size) document.addEventListener('selectionchange', schedule)
  pages.add(page)
  schedule()
  return () => {
    if (!pages.delete(page)) return
    svg.remove()
    layer.removeAttribute('data-continuous-selection')
    if (pages.size) {
      schedule()
      return
    }
    document.removeEventListener('selectionchange', schedule)
    if (scheduled !== null) cancelAnimationFrame(scheduled)
    scheduled = null
  }
}
