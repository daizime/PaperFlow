import {
  pdfRectToViewport, viewportRectToPdf, type PageGeometry, type PageRect, type PageTextContent
} from './pdf-geometry'
import { selectionBridges, type SelectionRun } from './selection-bridges'
import { selectionInk } from './selection-ink'

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
  textRuns: readonly TextRun[]
  path: SVGPathElement
  ink: WeakMap<Text, PageRect | undefined>
}

const mathSymbol = /[\p{Sm}\u2070-\u209f\u00b7\u2026\u22c5\u22ef]/u
const svgNamespace = 'http://www.w3.org/2000/svg'
const pages = new Set<HighlightPage>()
let scheduled: number | null = null

function selectedPart(range: Range, text: Text): { start: number; end: number } | undefined {
  if (!range.intersectsNode(text)) return
  const start = text === range.startContainer ? range.startOffset : 0
  const end = text === range.endContainer ? range.endOffset : text.length
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

// PDF 纵轴朝上。排版分行用朝下的纵轴，输出时再转回同一个 PDF.js viewport。
function invertY(rect: PageRect): PageRect {
  return { ...rect, y: -rect.y - rect.height }
}

function paint(page: HighlightPage, range: Range): string {
  if (!page.reader.contains(range.startContainer) || !page.reader.contains(range.endContainer) || !range.intersectsNode(page.layer)) return ''
  const bounds = page.surface.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return ''

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
      const pdf = invertY(viewportRectToPdf(page.geometry, local))
      if (!text.trim() && pdf.width > run.em * 1.25) continue
      if (pureMathSymbol && !page.ink.has(run.node)) {
        const measured = selectionInk(page.canvas, local, page.geometry)
        const ink = measured && invertY(viewportRectToPdf(page.geometry, measured))
        page.ink.set(run.node, ink && pdf.height - ink.height > 2 ? { ...pdf, y: ink.y, height: ink.height } : undefined)
      }
      const ink = pureMathSymbol ? page.ink.get(run.node) : undefined
      trimmed ||= Boolean(ink)
      original.push(ink ? pdfRectToViewport(page.geometry, invertY(ink)) : local)
      if (run.horizontal) runs.push({ rect: pdf, ink, baseline: run.baseline, em: run.em, math })
    }
  }
  const bridges = selectionBridges(runs)
  if (!bridges.length && !trimmed) return ''
  const rectangles = [...original, ...bridges.map(rect => pdfRectToViewport(page.geometry, invertY(rect)))]
  // 同一条路径统一施加透明度，交叠处仍只绘制一次蓝色。
  return rectangles.map(({ x, y, width, height }) => `M${x} ${y}h${width}v${height}h${-width}Z`).join(' ')
}

function schedule(): void {
  if (scheduled !== null) return
  scheduled = requestAnimationFrame(() => {
    scheduled = null
    const selection = document.getSelection()
    const range = selection && !selection.isCollapsed && selection.rangeCount === 1 ? selection.getRangeAt(0) : null
    for (const page of pages) {
      const data = range ? paint(page, range) : ''
      if (data) page.path.setAttribute('d', data)
      else page.path.removeAttribute('d')
      page.layer.toggleAttribute('data-continuous-selection', Boolean(data))
    }
  })
}

/** 绘制真实 Selection 的补间区域，不替换文字节点、选区端点或复制内容。 */
export function attachSelectionHighlight(
  surface: HTMLElement, canvas: HTMLCanvasElement, layer: HTMLElement, reader: HTMLElement, geometry: PageGeometry,
  content: PageTextContent, textDivs: readonly HTMLElement[]
): () => void {
  const textRuns: TextRun[] = []
  let index = 0
  for (const item of content.items) {
    if (!('str' in item)) continue
    const node = textDivs[index++]?.firstChild
    if (!(node instanceof Text) || node.data !== item.str) continue
    const [x, y, fontX, fontY, , baseline] = item.transform
    const em = Math.hypot(fontX, fontY)
    if (!Number.isFinite(em) || em <= 0 || !Number.isFinite(baseline)) continue
    const horizontal = item.dir !== 'ttb' && x > 0 && Math.abs(y) <= x * 0.01
    textRuns.push({ node, baseline: -baseline, em, horizontal })
  }
  const svg = document.createElementNS(svgNamespace, 'svg')
  const path = document.createElementNS(svgNamespace, 'path')
  svg.classList.add('pdf-selection-shape')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('viewBox', `0 0 ${geometry.viewport.width} ${geometry.viewport.height}`)
  svg.append(path)
  surface.append(svg)
  const page: HighlightPage = { surface, canvas, layer, reader, geometry, textRuns, path, ink: new WeakMap() }
  if (!pages.size) document.addEventListener('selectionchange', schedule)
  pages.add(page)
  schedule()
  return () => {
    if (!pages.delete(page)) return
    svg.remove()
    layer.removeAttribute('data-continuous-selection')
    if (pages.size) return
    document.removeEventListener('selectionchange', schedule)
    if (scheduled !== null) cancelAnimationFrame(scheduled)
    scheduled = null
  }
}
