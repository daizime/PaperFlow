import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { TranslatedBlockRecord } from '../../../../shared/contracts'
import { ZERO_CROP_INSETS } from '../reader/margin-crop'
import { buildHighlightPolygons } from '../reader/highlight-polygon'
import {
  computeStableTranslationBlockKey,
  hashTranslationBlockSource,
  type AnalyzedSentence,
  type InlineFormulaSpan,
  type PageLayoutResult
} from '../reader/layout-analysis'
import { cleanSelectedQuoteText, type PagePoint, type PageRect } from '../reader/pdf-geometry'
import type { PageBackdropSnapshot, ReaderMirrorState } from '../reader/PdfViewer'
import { mapColorToDarkPaperFilter } from './dark-paper-color'
import {
  alignBlockSentences,
  computeColumnLeftEdges,
  getBlockTranslationSourceText,
  isTranslatableBlock,
  resolveMirrorDragSelection,
  resolveOverlayBlockGeometries,
  splitTextWithInlineFormulas
} from './sentence-alignment'
import './translation.css'

export interface TargetSentenceSelection {
  pageNumber: number
  sentenceIds: string[]
  blockKeys: string[]
  sourceRects: PageRect[]
  selectedText?: string
  toggleIfSame?: boolean
}

export interface BatchQueueProgress {
  currentPage: number
  completedPages: number
  totalPages: number
}

export interface TranslationPanelProps {
  hasDocument: boolean
  mirror: ReaderMirrorState
  layouts: ReadonlyMap<number, PageLayoutResult>
  backdrops: ReadonlyMap<number, PageBackdropSnapshot>
  translationsByPage: ReadonlyMap<number, ReadonlyMap<string, TranslatedBlockRecord>>
  translatingPage: number | null
  retranslatingBlockKeys?: ReadonlySet<string>
  translationError: string | null
  staleScopeNotice?: string | null
  onRefreshStalePage?(pageNumber: number): void
  onRetranslateBlock?(pageNumber: number, blockKey: string): void
  onEditBlockTranslation?(pageNumber: number, blockKey: string, sourceHash: string, translatedText: string): Promise<void>
  onOpenSettings(): void
  onDismissTranslationError(): void
  scrollRef?: (element: HTMLDivElement | null) => void
  activePageNumber: number | null
  activeSentenceIds: ReadonlySet<string>
  onSelectTargetSentences?(selection: TargetSentenceSelection | null): void
  onChangeSplitRatio?(ratio: number | null): void
  onZoomDelta?(delta: number): void
  getSplitDragContext?: () => { leftWidth: number; rightWidth: number } | null
  bottomPill?: React.ReactNode
  splitDropActive?: boolean
  onDragOverSplitTarget?(event: DragEvent<HTMLElement>): void
  onDragLeaveSplitTarget?(event: DragEvent<HTMLElement>): void
  onDropSplitTarget?(event: DragEvent<HTMLElement>): void
}

export function LockIcon({ locked }: { locked: boolean }): React.JSX.Element {
  if (locked) {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5 7V5a3 3 0 0 1 6 0v2" />
      </svg>
    )
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5 7V5a3 3 0 0 1 5.6-1.5" />
    </svg>
  )
}

export function countTranslatedBlocks(
  layout: PageLayoutResult | undefined,
  cache: ReadonlyMap<string, TranslatedBlockRecord> | undefined
): { total: number; translated: number } {
  if (!layout || !layout.hasText) return { total: 0, translated: 0 }
  let total = 0
  let translated = 0
  for (const block of layout.blocks) {
    if (!isTranslatableBlock(block)) continue
    total += 1
    const key = computeStableTranslationBlockKey(block)
    const sourceHash = hashTranslationBlockSource(getBlockTranslationSourceText(block))
    const hit = cache?.get(key)
    if (hit && hit.sourceHash === sourceHash && hit.translatedText.trim()) {
      translated += 1
    }
  }
  return { total, translated }
}

function collectSelectedTranslatedSentences(
  scrollRoot: HTMLElement,
  selection: Selection | null,
  layouts: ReadonlyMap<number, PageLayoutResult>
): TargetSentenceSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const anchorIn = selection.anchorNode ? scrollRoot.contains(selection.anchorNode) : false
  const focusIn = selection.focusNode ? scrollRoot.contains(selection.focusNode) : false
  if (!anchorIn && !focusIn) return null

  const range = selection.getRangeAt(0)
  const spans = scrollRoot.querySelectorAll<HTMLElement>('.translation-overlay-sentence[data-source-sentence-ids]')

  let targetPageNumber: number | null = null
  const sentenceIds: string[] = []
  const blockKeys: string[] = []
  const seenSentences = new Set<string>()
  const seenBlocks = new Set<string>()

  for (const span of spans) {
    if (!span.isConnected || span.childNodes.length === 0) continue
    if (!range.intersectsNode(span)) continue

    let hasSelectedContent = false
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
    let textNode = walker.nextNode() as Text | null
    while (textNode) {
      if (textNode.length > 0) {
        try {
          const startPos = range.comparePoint(textNode, 0)
          const endPos = range.comparePoint(textNode, textNode.length)
          if (endPos >= 0 && startPos <= 0) {
            const selStart = range.startContainer === textNode ? range.startOffset : 0
            const selEnd = range.endContainer === textNode ? range.endOffset : textNode.length
            if (selEnd > selStart && textNode.data.slice(selStart, selEnd).trim()) {
              hasSelectedContent = true
              break
            }
          }
        } catch {
          // ignore cross-tree errors
        }
      }
      textNode = walker.nextNode() as Text | null
    }

    if (!hasSelectedContent) {
      const imgs = span.querySelectorAll<HTMLImageElement>('img.translation-inline-formula')
      for (const img of imgs) {
        const parent = img.parentNode
        if (!parent) continue
        const childIdx = Array.prototype.indexOf.call(parent.childNodes, img)
        if (childIdx < 0) continue
        try {
          const beforeImg = range.comparePoint(parent, childIdx)
          const afterImg = range.comparePoint(parent, childIdx + 1)
          if ((beforeImg < 0 && afterImg > 0) || (beforeImg === 0 && afterImg === 0)) {
            hasSelectedContent = true
            break
          }
        } catch {
          continue
        }
      }
    }
    if (!hasSelectedContent) continue

    const pageEl = span.closest<HTMLElement>('.translation-page[data-page-number]')
    const pageNum = pageEl ? Number.parseInt(pageEl.dataset.pageNumber ?? '', 10) : Number.NaN
    if (!Number.isInteger(pageNum)) continue
    if (targetPageNumber === null) targetPageNumber = pageNum
    if (pageNum !== targetPageNumber) continue

    const blockKey = span.dataset.blockKey ?? ''
    if (blockKey && !seenBlocks.has(blockKey)) {
      seenBlocks.add(blockKey)
      blockKeys.push(blockKey)
    }

    const rawIds = span.dataset.sourceSentenceIds ?? ''
    for (const id of rawIds.split(',')) {
      if (id && !seenSentences.has(id)) {
        seenSentences.add(id)
        sentenceIds.push(id)
      }
    }
  }

  if (targetPageNumber === null || sentenceIds.length === 0) return null
  const layout = layouts.get(targetPageNumber)
  if (!layout) return null

  const sentenceById = new Map(layout.sentences.map(s => [s.id, s]))
  const sourceRects: PageRect[] = []
  for (const id of sentenceIds) {
    const sentence = sentenceById.get(id)
    if (sentence) sourceRects.push(...sentence.rects)
  }
  if (sourceRects.length === 0) return null

  return {
    pageNumber: targetPageNumber,
    sentenceIds,
    blockKeys,
    sourceRects,
    selectedText: cleanSelectedQuoteText(selection.toString()) ?? undefined,
    toggleIfSame: false
  }
}

interface MirrorBackdropCanvasProps {
  bitmap: ImageBitmap | undefined
}

const MirrorBackdropCanvas = memo(function MirrorBackdropCanvas({
  bitmap
}: MirrorBackdropCanvasProps): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bitmap) return
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0)
  }, [bitmap])

  if (!bitmap) return null
  return <canvas ref={canvasRef} className="translation-page-bg" aria-hidden="true" />
})

const inlineFormulaCropCache = new WeakMap<ImageBitmap, Map<string, string>>()

interface CroppedInlineFormulaImage {
  dataUrl: string
  widthEm: number
  heightEm: number
  verticalAlignEm: number
}

function cropInlineFormulaDataUrl(
  bitmap: ImageBitmap | undefined,
  layout: PageLayoutResult,
  formula: InlineFormulaSpan
): CroppedInlineFormulaImage | null {
  if (!bitmap || layout.naturalWidth <= 0 || layout.naturalHeight <= 0) return null
  const r = formula.displayRect
  if (r.width <= 0 || r.height <= 0) return null

  const padX = 0.7
  const padY = 0.15
  const cropX = Math.max(0, r.x - padX)
  const cropY = Math.max(0, r.y - padY)
  const cropRight = Math.min(layout.naturalWidth, r.x + r.width + padX)
  const cropBottom = Math.min(layout.naturalHeight, r.y + r.height + padY)
  const cropW = Math.max(1, cropRight - cropX)
  const cropH = Math.max(1, cropBottom - cropY)

  const pxPerPtX = bitmap.width / layout.naturalWidth
  const pxPerPtY = bitmap.height / layout.naturalHeight
  const sx = Math.max(0, Math.floor(cropX * pxPerPtX))
  const sy = Math.max(0, Math.floor(cropY * pxPerPtY))
  const sw = Math.min(bitmap.width - sx, Math.max(1, Math.ceil(cropW * pxPerPtX)))
  const sh = Math.min(bitmap.height - sy, Math.max(1, Math.ceil(cropH * pxPerPtY)))
  if (sw <= 0 || sh <= 0) return null

  let pageMap = inlineFormulaCropCache.get(bitmap)
  if (!pageMap) {
    pageMap = new Map<string, string>()
    inlineFormulaCropCache.set(bitmap, pageMap)
  }
  const cacheKey = `${sx},${sy},${sw},${sh}`
  let dataUrl = pageMap.get(cacheKey)
  if (!dataUrl) {
    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
    dataUrl = canvas.toDataURL('image/png')
    pageMap.set(cacheKey, dataUrl)
  }

  const baseEm = Math.max(6, formula.lineFontSize)
  const widthEm = Math.round((cropW / baseEm) * 1000) / 1000
  const heightEm = Math.round((cropH / baseEm) * 1000) / 1000
  const descentBelowBaseline = cropY + cropH - formula.baselineY
  const verticalAlignEm = Math.round((-descentBelowBaseline / baseEm) * 1000) / 1000
  return { dataUrl, widthEm, heightEm, verticalAlignEm }
}

interface OverlayPageContentProps {
  layout: PageLayoutResult
  scale: number
  backdropBitmap?: ImageBitmap
  blockColors?: Record<string, string>
  translations?: ReadonlyMap<string, TranslatedBlockRecord>
  isTranslating: boolean
  retranslatingBlockKeys?: ReadonlySet<string>
  isActivePage: boolean
  activeSentenceIds: ReadonlySet<string>
  suppressNextClickRef: MutableRefObject<boolean>
  onSelectTargetSentences?(selection: TargetSentenceSelection | null): void
  onRetranslateBlock?(pageNumber: number, blockKey: string): void
  onEditBlockTranslation?(pageNumber: number, blockKey: string, sourceHash: string, translatedText: string): Promise<void>
}

interface EditingBlockState {
  blockKey: string
  sourceHash: string
  draft: string
  left: number
  top: number
  width: number
  saving: boolean
  error: string | null
}

const OverlayPageContent = memo(function OverlayPageContent({
  layout,
  scale,
  backdropBitmap,
  blockColors,
  translations,
  isTranslating,
  retranslatingBlockKeys,
  isActivePage,
  activeSentenceIds,
  suppressNextClickRef,
  onSelectTargetSentences,
  onRetranslateBlock,
  onEditBlockTranslation
}: OverlayPageContentProps): React.JSX.Element {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const highlightSvgRef = useRef<SVGSVGElement | null>(null)
  const mirrorDragRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    startDisplayPoint: PagePoint
    active: boolean
  } | null>(null)
  const [marqueeBox, setMarqueeBox] = useState<PageRect | null>(null)
  const [editingBlock, setEditingBlock] = useState<EditingBlockState | null>(null)

  useEffect(() => {
    setEditingBlock(null)
  }, [layout.pageNumber])

  const columnRightByIndex = new Map<number, number>()
  const columnLeftByIndex = computeColumnLeftEdges(layout.blocks)
  for (const b of layout.blocks) {
    if (b.columnIndex > 0) {
      const rightEdge = b.displayBounds.x + b.displayBounds.width
      const prev = columnRightByIndex.get(b.columnIndex) ?? 0
      if (rightEdge > prev) columnRightByIndex.set(b.columnIndex, rightEdge)
    }
  }
  const overlayBoxGeometries = resolveOverlayBlockGeometries(
    layout,
    scale,
    columnLeftByIndex,
    columnRightByIndex
  )

  const hasTranslatedBlocks =
    Boolean(translations && translations.size > 0) &&
    layout.blocks.some(block => {
      if (block.sentences.length === 0 || !isTranslatableBlock(block)) return false
      const key = computeStableTranslationBlockKey(block)
      const sourceHash = hashTranslationBlockSource(getBlockTranslationSourceText(block))
      const cached = translations?.get(key)
      return Boolean(cached && cached.sourceHash === sourceHash && cached.translatedText.trim())
    })

  // 先利用同栏右侧安全留白与下侧无碰撞留白避免无谓缩微字号，再严格零溢出微调字号/行高
  useLayoutEffect(() => {
    const root = layerRef.current
    if (!root) return
    const items = root.querySelectorAll<HTMLElement>('.translation-overlay-block.is-translated')
    for (const blockEl of items) {
      const textEl = blockEl.querySelector<HTMLElement>('.translation-overlay-block__text')
      if (!textEl) continue
      const initialPx = Number.parseFloat(blockEl.dataset.baseFontPx || '11')
      const baseWidthPx = Number.parseFloat(blockEl.dataset.baseWidthPx || String(blockEl.clientWidth))
      const maxWidthPx = Number.parseFloat(blockEl.dataset.maxWidthPx || String(baseWidthPx))
      const baseHeightPx = Number.parseFloat(blockEl.dataset.baseHeightPx || String(blockEl.clientHeight))
      const maxHeightPx = Number.parseFloat(blockEl.dataset.maxHeightPx || String(baseHeightPx))

      blockEl.style.width = `${baseWidthPx}px`
      blockEl.style.height = `${baseHeightPx}px`
      const computed = window.getComputedStyle(blockEl)
      const padY = (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0)
      const getAvailableHeight = (): number => Math.max(4, Math.floor(blockEl.clientHeight - padY))

      let fontPx = initialPx
      textEl.style.fontSize = `${fontPx}px`
      textEl.style.lineHeight = '1.36'

      if (textEl.scrollHeight > getAvailableHeight() && maxWidthPx > baseWidthPx + 2) {
        blockEl.style.width = `${maxWidthPx}px`
      }
      if (textEl.scrollHeight > getAvailableHeight()) {
        textEl.style.lineHeight = '1.24'
      }
      if (textEl.scrollHeight > getAvailableHeight() && maxHeightPx > baseHeightPx + 1) {
        blockEl.style.height = `${Math.min(maxHeightPx, Math.ceil(textEl.scrollHeight + padY))}px`
      }

      let guard = 0
      while (textEl.scrollHeight > getAvailableHeight() && fontPx > 6.5 && guard < 18) {
        fontPx = Math.max(6.5, Math.round(fontPx * 0.9 * 10) / 10)
        textEl.style.fontSize = `${fontPx}px`
        guard += 1
      }
      if (textEl.scrollHeight > getAvailableHeight()) {
        textEl.style.lineHeight = '1.14'
        const minFontPx = Math.max(4.5, Math.min(5.5, Math.round(initialPx * 0.55 * 10) / 10))
        while (textEl.scrollHeight > getAvailableHeight() && fontPx > minFontPx && guard < 24) {
          fontPx = Math.max(minFontPx, Math.round(fontPx * 0.9 * 10) / 10)
          textEl.style.fontSize = `${fontPx}px`
          guard += 1
        }
      }
      if (textEl.scrollHeight > getAvailableHeight()) {
        textEl.style.lineHeight = '1.06'
        while (textEl.scrollHeight > getAvailableHeight() && fontPx > 4.5 && guard < 28) {
          fontPx = Math.max(4.5, Math.round(fontPx * 0.9 * 10) / 10)
          textEl.style.fontSize = `${fontPx}px`
          guard += 1
        }
      } else if (
        fontPx === initialPx &&
        (blockEl.dataset.blockKind === 'paragraph' || blockEl.dataset.blockKind === 'list-item') &&
        blockEl.clientHeight >= fontPx * 2.6 &&
        textEl.scrollHeight <= getAvailableHeight() - fontPx * 0.65
      ) {
        for (const relaxedLineHeight of ['1.44', '1.52', '1.6']) {
          const prevLineHeight = textEl.style.lineHeight
          textEl.style.lineHeight = relaxedLineHeight
          if (textEl.scrollHeight > getAvailableHeight()) {
            textEl.style.lineHeight = prevLineHeight
            break
          }
          if (textEl.scrollHeight >= getAvailableHeight() * 0.88) break
        }
      }
    }
  }, [layout, scale, translations, backdropBitmap])

  // 在排版自适应完成后，统一由正交并集多边形 SVG 描绘当前选中译文句或未译热区的连续轮廓
  useLayoutEffect(() => {
    const root = layerRef.current
    const svg = highlightSvgRef.current
    if (!root || !svg) return

    if (!isActivePage || activeSentenceIds.size === 0) {
      svg.replaceChildren()
      return
    }

    const layerRect = root.getBoundingClientRect()
    if (layerRect.width <= 0 || layerRect.height <= 0) {
      svg.replaceChildren()
      return
    }

    const collectedRects: PageRect[] = []
    const range = document.createRange()

    const activeTranslated = root.querySelectorAll<HTMLElement>('.translation-overlay-sentence.is-active')
    for (const span of activeTranslated) {
      if (span.childNodes.length === 0) continue
      range.selectNodeContents(span)
      for (const r of range.getClientRects()) {
        if (r.width <= 0 || r.height <= 0) continue
        collectedRects.push({
          x: r.left - layerRect.left,
          y: r.top - layerRect.top,
          width: r.width,
          height: r.height
        })
      }
    }

    const activeMirrors = root.querySelectorAll<HTMLElement>('.translation-mirror-sentence.is-active')
    for (const mirrorEl of activeMirrors) {
      const r = mirrorEl.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      collectedRects.push({
        x: r.left - layerRect.left,
        y: r.top - layerRect.top,
        width: r.width,
        height: r.height
      })
    }

    const polygons = buildHighlightPolygons(collectedRects, { padX: 2, padY: 1, radius: 3.5 })
    if (polygons.length === 0) {
      svg.replaceChildren()
      return
    }

    const svgNs = 'http://www.w3.org/2000/svg'
    const pathNodes: SVGPathElement[] = []
    for (const poly of polygons) {
      const path = document.createElementNS(svgNs, 'path')
      path.setAttribute('class', 'translation-sentence-polygon')
      path.setAttribute('d', poly.path)
      pathNodes.push(path)
    }
    svg.replaceChildren(...pathNodes)
  }, [layout, scale, translations, backdropBitmap, isActivePage, activeSentenceIds])

  const toDisplayPoint = useCallback(
    (clientX: number, clientY: number): PagePoint | null => {
      const layer = layerRef.current
      if (!layer || scale <= 0) return null
      const rect = layer.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      return {
        x: Math.max(0, Math.min(layout.naturalWidth, (clientX - rect.left) / scale)),
        y: Math.max(0, Math.min(layout.naturalHeight, (clientY - rect.top) / scale))
      }
    },
    [layout.naturalHeight, layout.naturalWidth, scale]
  )

  const handleLayerMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (
      event.button !== 0 ||
      event.detail !== 1 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return
    }
    const targetEl = event.target instanceof Element ? event.target : null
    if (targetEl?.closest('button')) return
    const insideTranslatedBlock = Boolean(targetEl?.closest('.translation-overlay-block.is-translated'))
    const insideMirrorHotspot = Boolean(targetEl?.closest('.translation-mirror-sentence'))
    if (insideTranslatedBlock || (hasTranslatedBlocks && !insideMirrorHotspot)) {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) {
        sel.removeAllRanges()
      }
    }
  }

  const handleLayerPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const targetEl = event.target instanceof Element ? event.target : null
    if (targetEl?.closest('.translation-overlay-block.is-translated')) {
      return
    }
    if (hasTranslatedBlocks && !targetEl?.closest('.translation-mirror-sentence')) {
      return
    }
    const startDisplayPoint = toDisplayPoint(event.clientX, event.clientY)
    if (!startDisplayPoint) return
    mirrorDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startDisplayPoint,
      active: false
    }
  }

  const handleLayerPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = mirrorDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) < 5) return
      drag.active = true
      window.getSelection()?.removeAllRanges()
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId)
      }
    }
    event.preventDefault()
    const currentDisplayPoint = toDisplayPoint(event.clientX, event.clientY)
    if (!currentDisplayPoint) return
    const matched = resolveMirrorDragSelection(layout, drag.startDisplayPoint, currentDisplayPoint)
    const dragBoxPx: PageRect = {
      x: Math.min(drag.startDisplayPoint.x, currentDisplayPoint.x) * scale,
      y: Math.min(drag.startDisplayPoint.y, currentDisplayPoint.y) * scale,
      width: Math.abs(currentDisplayPoint.x - drag.startDisplayPoint.x) * scale,
      height: Math.abs(currentDisplayPoint.y - drag.startDisplayPoint.y) * scale
    }
    const useMarquee = !matched || matched.usedMarquee
    if (useMarquee && (dragBoxPx.width >= 2 || dragBoxPx.height >= 2)) {
      setMarqueeBox(dragBoxPx)
    } else {
      setMarqueeBox(null)
    }

    if (matched) {
      onSelectTargetSentences?.({
        pageNumber: matched.pageNumber,
        sentenceIds: matched.sentenceIds,
        blockKeys: matched.blockKeys,
        sourceRects: matched.sourceRects,
        toggleIfSame: false
      })
    }
  }

  const handleLayerPointerUpOrCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = mirrorDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const wasActive = drag.active
    mirrorDragRef.current = null
    setMarqueeBox(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (wasActive) {
      suppressNextClickRef.current = true
      window.setTimeout(() => {
        suppressNextClickRef.current = false
      }, 0)
    }
  }

  return (
    <div
      ref={layerRef}
      className={hasTranslatedBlocks ? 'translation-overlay-layer has-translations' : 'translation-overlay-layer'}
      onMouseDown={handleLayerMouseDown}
      onDragStart={event => event.preventDefault()}
      onPointerDown={handleLayerPointerDown}
      onPointerMove={handleLayerPointerMove}
      onPointerUp={handleLayerPointerUpOrCancel}
      onPointerCancel={handleLayerPointerUpOrCancel}
    >
      {layout.blocks.map(block => {
        const blockKey = computeStableTranslationBlockKey(block)
        const boxGeom = overlayBoxGeometries.get(block.id)
        const bgColor = blockColors?.[blockKey] ?? '#ffffff'
        const darkBgColor = mapColorToDarkPaperFilter(bgColor)

        if (block.sentences.length === 0) {
          if (
            block.kind !== 'formula' &&
            block.kind !== 'table' &&
            block.kind !== 'figure' &&
            block.continuedFromPrevColumn &&
            translations &&
            translations.size > 0 &&
            boxGeom
          ) {
            return (
              <div
                key={block.id}
                className="translation-overlay-mask"
                aria-hidden="true"
                style={{
                  left: boxGeom.left,
                  top: boxGeom.top,
                  width: boxGeom.baseWidth,
                  height: boxGeom.height,
                  '--overlay-bg': bgColor,
                  '--overlay-bg-dark': darkBgColor
                } as CSSProperties}
              />
            )
          }
          return null
        }

        // 公式/表格/插图内部标注及纯数字/符号不可译碎片保留底图原样不覆盖译文，同时提供句子级透明镜像高亮与双向点击定位
        if (!isTranslatableBlock(block)) {
          return block.sentences.map(sentence => {
            const rects = sentence.displayRects.length > 0 ? sentence.displayRects : [block.displayBounds]
            const isActive = isActivePage && activeSentenceIds.has(sentence.id)
            const handleMirrorFormulaSelect = (event: { stopPropagation(): void }): void => {
              if (suppressNextClickRef.current) {
                suppressNextClickRef.current = false
                return
              }
              const sel = window.getSelection()
              if (sel && !sel.isCollapsed) return
              event.stopPropagation()
              onSelectTargetSentences?.({
                pageNumber: block.pageNumber,
                sentenceIds: [sentence.id],
                blockKeys: [blockKey],
                sourceRects: sentence.rects.length > 0 ? [...sentence.rects] : [block.bounds],
                toggleIfSame: true
              })
            }
            const nonTranslatableLabel =
              block.kind === 'formula'
                ? `公式第 ${sentence.order} 项`
                : block.kind === 'table'
                  ? `表格第 ${sentence.order} 项`
                  : block.kind === 'figure'
                    ? `图表第 ${sentence.order} 项`
                    : `原文第 ${sentence.order} 项`
            return rects.map((r, rIdx) => (
              <div
                key={`${sentence.id}-m-${rIdx}`}
                tabIndex={0}
                role="button"
                aria-label={nonTranslatableLabel}
                className={isActive ? 'translation-mirror-sentence is-active' : 'translation-mirror-sentence'}
                style={{
                  left: Math.max(0, r.x * scale - 1),
                  top: Math.max(0, r.y * scale - 1),
                  width: Math.max(8, r.width * scale + 2),
                  height: Math.max(12, r.height * scale + 3)
                }}
                data-sentence-id={sentence.id}
                data-block-key={blockKey}
                data-reading-order={sentence.order}
                data-cross-column={sentence.crossColumn ? 'true' : undefined}
                onClick={handleMirrorFormulaSelect}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    handleMirrorFormulaSelect(event)
                  }
                }}
              />
            ))
          })
        }

        if (!boxGeom) return null
        const boxLeft = boxGeom.left
        const boxTop = boxGeom.top
        const baseWidth = boxGeom.baseWidth
        const maxSafeWidth = boxGeom.maxSafeWidth
        const boxHeight = boxGeom.height
        const maxSafeHeight = boxGeom.maxSafeHeight
        const firstLineIndentPx = boxGeom.firstLineIndentPx

        const sourceText = getBlockTranslationSourceText(block)
        const sourceHash = hashTranslationBlockSource(sourceText)
        const cached = translations?.get(blockKey)
        const translatedText =
          cached && cached.sourceHash === sourceHash && cached.translatedText.trim()
            ? cached.translatedText
            : null

        const baseFontPx = Math.max(9.5, Math.min(26, Math.round(block.fontSize * scale * 0.95 * 10) / 10))
        const statusClass = translatedText
          ? 'is-translated'
          : isTranslating
            ? 'is-pending'
            : 'is-untranslated'

        const style = {
          left: boxLeft,
          top: boxTop,
          width: baseWidth,
          height: boxHeight,
          ...(translatedText
            ? {
                '--overlay-bg': bgColor,
                '--overlay-bg-dark': darkBgColor
              }
            : {})
        } as CSSProperties

        const sentenceById = new Map<string, AnalyzedSentence>(block.sentences.map(s => [s.id, s]))

        const handleSelectWholeBlock = (event: { stopPropagation(): void }): void => {
          const sel = window.getSelection()
          if (sel && !sel.isCollapsed) return
          event.stopPropagation()
          const allRects = block.sentences.flatMap(s => s.rects)
          onSelectTargetSentences?.({
            pageNumber: block.pageNumber,
            sentenceIds: block.sentences.map(s => s.id),
            blockKeys: [blockKey],
            sourceRects: allRects.length > 0 ? allRects : [block.bounds],
            toggleIfSame: true
          })
        }

        if (!translatedText) {
          return (
            <div key={block.id} className="translation-untranslated-group">
              <div
                className={`translation-overlay-block translation-overlay-block--${block.kind} ${statusClass}`}
                style={style}
                data-block-id={block.id}
                data-block-key={blockKey}
                data-block-kind={block.kind}
                data-column={block.columnIndex}
                data-base-font-px={baseFontPx}
                data-base-width-px={baseWidth}
                data-max-width-px={maxSafeWidth}
                data-base-height-px={boxHeight}
                data-max-height-px={maxSafeHeight}
              >
                {isTranslating ? <span>翻译中…</span> : null}
              </div>
              {block.sentences.map(sentence => {
                const rects = sentence.displayRects.length > 0 ? sentence.displayRects : [block.displayBounds]
                const isSentActive = isActivePage && activeSentenceIds.has(sentence.id)
                const handleMirrorClick = (event: { stopPropagation(): void }): void => {
                  if (suppressNextClickRef.current) {
                    suppressNextClickRef.current = false
                    return
                  }
                  const sel = window.getSelection()
                  if (sel && !sel.isCollapsed) return
                  event.stopPropagation()
                  onSelectTargetSentences?.({
                    pageNumber: block.pageNumber,
                    sentenceIds: [sentence.id],
                    blockKeys: [blockKey],
                    sourceRects: sentence.rects.length > 0 ? [...sentence.rects] : [block.bounds],
                    toggleIfSame: true
                  })
                }
                return rects.map((r, rIdx) => (
                  <div
                    key={`${sentence.id}-m-${rIdx}`}
                    tabIndex={0}
                    role="button"
                    aria-label={`原文第 ${sentence.order} 句`}
                    className={isSentActive ? 'translation-mirror-sentence is-active' : 'translation-mirror-sentence'}
                    style={{
                      left: Math.max(0, r.x * scale - 1),
                      top: Math.max(0, r.y * scale - 1),
                      width: Math.max(8, r.width * scale + 2),
                      height: Math.max(12, r.height * scale + 3)
                    }}
                    data-sentence-id={sentence.id}
                    data-block-key={blockKey}
                    data-reading-order={sentence.order}
                    data-cross-column={sentence.crossColumn ? 'true' : undefined}
                    onClick={handleMirrorClick}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        handleMirrorClick(event)
                      }
                    }}
                  />
                ))
              })}
            </div>
          )
        }

        const alignment = alignBlockSentences(block.sentences, translatedText)
        const isBlockRetranslating = Boolean(retranslatingBlockKeys?.has(blockKey))
        const isTopEdgeBlock = boxTop < 24

        return (
          <div
            key={block.id}
            tabIndex={0}
            className={`translation-overlay-block translation-overlay-block--${block.kind} ${statusClass}${
              isBlockRetranslating ? ' is-retranslating' : ''
            }${isTopEdgeBlock ? ' is-top-edge' : ''}${boxGeom.tightBottom ? ' has-tight-bottom' : ''}${
              boxGeom.tightTop ? ' has-tight-top' : ''
            }`}
            style={style}
            data-block-id={block.id}
            data-block-key={blockKey}
            data-block-kind={block.kind}
            data-column={block.columnIndex}
            data-base-font-px={baseFontPx}
            data-base-width-px={baseWidth}
            data-max-width-px={maxSafeWidth}
            data-base-height-px={boxHeight}
            data-max-height-px={maxSafeHeight}
            data-first-line-indent-px={firstLineIndentPx > 0 ? firstLineIndentPx : undefined}
            onClick={handleSelectWholeBlock}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                handleSelectWholeBlock(event)
              }
            }}
          >
            {onRetranslateBlock || onEditBlockTranslation ? (
              <div className="translation-block-actions" onClick={event => event.stopPropagation()}>
                {onEditBlockTranslation ? (
                  <button
                    type="button"
                    className="translation-block-edit-btn"
                    data-testid="translation-block-edit-btn"
                    aria-label="编辑此段译文"
                    title="手动修改此段译文（自动保存到本地缓存）"
                    disabled={isBlockRetranslating || isTranslating}
                    onClick={event => {
                      event.stopPropagation()
                      const pageWidth = Math.max(280, layout.naturalWidth * scale)
                      const popWidth = Math.min(Math.max(250, baseWidth), Math.max(250, pageWidth - 16))
                      const popLeft = Math.max(8, Math.min(boxLeft, pageWidth - popWidth - 8))
                      const popTop = Math.max(8, boxTop + Math.min(boxHeight, 26))
                      setEditingBlock({
                        blockKey,
                        sourceHash,
                        draft: translatedText,
                        left: popLeft,
                        top: popTop,
                        width: popWidth,
                        saving: false,
                        error: null
                      })
                    }}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M11.5 2.5a1.8 1.8 0 0 1 2.5 2.5L5.7 13.3l-3.4.9.9-3.4 8.3-8.3Z" />
                    </svg>
                  </button>
                ) : null}
                {onRetranslateBlock ? (
                  <button
                    type="button"
                    className="translation-block-retranslate-btn"
                    aria-label="重译此段"
                    title="仅重新翻译此段落"
                    disabled={isBlockRetranslating || isTranslating}
                    onClick={event => {
                      event.stopPropagation()
                      onRetranslateBlock(block.pageNumber, blockKey)
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.65" />
                      <path d="M13.5 2.5v2.75h-2.75" />
                    </svg>
                  </button>
                ) : null}
              </div>
            ) : null}
            <p
              className="translation-overlay-block__text"
              style={{
                fontSize: `${baseFontPx}px`,
                ...(firstLineIndentPx > 0 ? { textIndent: `${firstLineIndentPx}px` } : {})
              }}
            >
              {alignment.segments.map(seg => {
                const sourceIds = alignment.targetToSource.get(seg.index) ?? []
                const isSegActive = isActivePage && sourceIds.some(id => activeSentenceIds.has(id))
                const mappedRects = sourceIds.flatMap(id => sentenceById.get(id)?.rects ?? [])
                return (
                  <span
                    key={seg.index}
                    className={isSegActive ? 'translation-overlay-sentence is-active' : 'translation-overlay-sentence'}
                    data-sentence-index={seg.index}
                    data-source-sentence-ids={sourceIds.join(',')}
                    data-block-key={blockKey}
                    onClick={event => {
                      const sel = window.getSelection()
                      if (sel && !sel.isCollapsed) return
                      event.stopPropagation()
                      onSelectTargetSentences?.({
                        pageNumber: block.pageNumber,
                        sentenceIds: sourceIds.length > 0 ? sourceIds : block.sentences.map(s => s.id),
                        blockKeys: [blockKey],
                        sourceRects: mappedRects.length > 0 ? mappedRects : [block.bounds],
                        toggleIfSame: true
                      })
                    }}
                  >
                    {block.inlineFormulas && block.inlineFormulas.length > 0
                      ? splitTextWithInlineFormulas(seg.text, block.inlineFormulas).map((part, pIdx) => {
                          if (part.kind === 'text') return part.text
                          const crop = cropInlineFormulaDataUrl(backdropBitmap, layout, part.formula)
                          if (crop) {
                            return (
                              <img
                                key={`${seg.index}-f-${pIdx}`}
                                className="translation-inline-formula"
                                src={crop.dataUrl}
                                alt={part.formula.fallbackText}
                                title={part.formula.fallbackText}
                                data-formula-token={part.formula.token}
                                draggable={false}
                                style={{
                                  width: `${crop.widthEm}em`,
                                  height: `${crop.heightEm}em`,
                                  verticalAlign: `${crop.verticalAlignEm}em`
                                }}
                              />
                            )
                          }
                          return (
                            <span key={`${seg.index}-f-${pIdx}`} className="translation-inline-formula-fallback">
                              {part.formula.fallbackText}
                            </span>
                          )
                        })
                      : seg.text}
                  </span>
                )
              })}
            </p>
          </div>
        )
      })}
      <svg
        ref={highlightSvgRef}
        className="translation-highlight-svg"
        width={Math.max(1, layout.naturalWidth * scale)}
        height={Math.max(1, layout.naturalHeight * scale)}
        viewBox={`0 0 ${Math.max(1, layout.naturalWidth * scale)} ${Math.max(1, layout.naturalHeight * scale)}`}
        aria-hidden="true"
      />
      {marqueeBox ? (
        <div
          className="translation-drag-marquee"
          style={{
            left: marqueeBox.x,
            top: marqueeBox.y,
            width: marqueeBox.width,
            height: marqueeBox.height
          }}
          aria-hidden="true"
        />
      ) : null}
      {editingBlock && onEditBlockTranslation ? (
        <div
          className="translation-block-editor-popover"
          data-testid="translation-block-editor"
          style={{
            left: editingBlock.left,
            top: editingBlock.top,
            width: editingBlock.width
          }}
          onMouseDown={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <div className="translation-block-editor-popover__head">
            <span>手动校对本段译文（Ctrl+Enter 保存）</span>
            <button
              type="button"
              aria-label="关闭译文编辑框"
              disabled={editingBlock.saving}
              onClick={() => setEditingBlock(null)}
            >
              ×
            </button>
          </div>
          <textarea
            data-testid="translation-block-edit-input"
            aria-label="手动校对译文内容"
            rows={4}
            autoFocus
            value={editingBlock.draft}
            disabled={editingBlock.saving}
            onChange={e =>
              setEditingBlock(curr => (curr ? { ...curr, draft: e.target.value, error: null } : curr))
            }
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault()
                if (!editingBlock.saving) setEditingBlock(null)
              } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                const clean = editingBlock.draft.trim()
                if (!clean || editingBlock.saving) return
                setEditingBlock(curr => (curr ? { ...curr, saving: true, error: null } : curr))
                void onEditBlockTranslation(layout.pageNumber, editingBlock.blockKey, editingBlock.sourceHash, clean)
                  .then(() => {
                    setEditingBlock(null)
                  })
                  .catch((err: unknown) => {
                    setEditingBlock(curr =>
                      curr
                        ? {
                            ...curr,
                            saving: false,
                            error: err instanceof Error ? err.message : String(err)
                          }
                        : curr
                    )
                  })
              }
            }}
          />
          {editingBlock.error ? (
            <div className="translation-block-editor-popover__err" role="alert">
              {editingBlock.error}
            </div>
          ) : null}
          <div className="translation-block-editor-popover__actions">
            <button type="button" disabled={editingBlock.saving} onClick={() => setEditingBlock(null)}>
              取消
            </button>
            <button
              type="button"
              className="is-primary"
              data-testid="translation-block-edit-save"
              disabled={editingBlock.saving || !editingBlock.draft.trim()}
              onClick={() => {
                const clean = editingBlock.draft.trim()
                if (!clean || editingBlock.saving) return
                setEditingBlock(curr => (curr ? { ...curr, saving: true, error: null } : curr))
                void onEditBlockTranslation(layout.pageNumber, editingBlock.blockKey, editingBlock.sourceHash, clean)
                  .then(() => {
                    setEditingBlock(null)
                  })
                  .catch((err: unknown) => {
                    setEditingBlock(curr =>
                      curr
                        ? {
                            ...curr,
                            saving: false,
                            error: err instanceof Error ? err.message : String(err)
                          }
                        : curr
                    )
                  })
              }}
            >
              {editingBlock.saving ? '保存中…' : '保存译文'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
})

export function TranslationPanel({
  hasDocument,
  mirror,
  layouts,
  backdrops,
  translationsByPage,
  translatingPage,
  retranslatingBlockKeys,
  translationError,
  staleScopeNotice,
  onRefreshStalePage,
  onRetranslateBlock,
  onEditBlockTranslation,
  onOpenSettings,
  onDismissTranslationError,
  scrollRef,
  activePageNumber,
  activeSentenceIds,
  onSelectTargetSentences,
  onChangeSplitRatio,
  onZoomDelta,
  getSplitDragContext,
  bottomPill,
  splitDropActive = false,
  onDragOverSplitTarget,
  onDragLeaveSplitTarget,
  onDropSplitTarget
}: TranslationPanelProps): React.JSX.Element {
  const dragStateRef = useRef<{ startX: number; startRightWidth: number; totalWidth: number } | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null)
  const suppressNextClickRef = useRef(false)
  const layoutsRef = useRef(layouts)
  const onSelectTargetRef = useRef(onSelectTargetSentences)
  const onZoomDeltaRef = useRef(onZoomDelta)
  layoutsRef.current = layouts
  onSelectTargetRef.current = onSelectTargetSentences
  onZoomDeltaRef.current = onZoomDelta

  const handleScrollRef = useCallback(
    (element: HTMLDivElement | null): void => {
      setScrollContainerEl(element)
      scrollRef?.(element)
    },
    [scrollRef]
  )

  useEffect(() => {
    if (!hasDocument || !scrollContainerEl) return
    let rafId: number | null = null
    const syncFromRightSelection = (): void => {
      const sel = window.getSelection()
      const matched = collectSelectedTranslatedSentences(scrollContainerEl, sel, layoutsRef.current)
      if (matched) {
        onSelectTargetRef.current?.(matched)
      }
    }
    const onSelectionChange = (): void => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        syncFromRightSelection()
      })
    }
    const onMouseUp = (): void => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
        rafId = null
      }
      syncFromRightSelection()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [hasDocument, scrollContainerEl])

  useEffect(() => {
    const target = panelRef.current ?? scrollContainerEl
    if (!hasDocument || !target) return
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      if (!onZoomDeltaRef.current) return
      event.preventDefault()
      if (event.deltaY === 0) return
      onZoomDeltaRef.current(event.deltaY > 0 ? -0.1 : 0.1)
    }
    target.addEventListener('wheel', handleWheel, { passive: false })
    return () => target.removeEventListener('wheel', handleWheel)
  }, [hasDocument, scrollContainerEl])

  if (!hasDocument) {
    return (
      <aside className="translation-panel" aria-label="译文区域">
        <div className="panel-heading"><h2>译文</h2></div>
        <div className="translation-scroll translation-scroll--empty">
          <div className="translation-empty"><h3>尚未翻译</h3></div>
        </div>
      </aside>
    )
  }

  const handleResizerPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!onChangeSplitRatio || !panelRef.current) return
    event.preventDefault()
    const ctx = getSplitDragContext?.()
    const totalWidth = ctx ? ctx.leftWidth + ctx.rightWidth : panelRef.current.getBoundingClientRect().width * 2
    const startRightWidth = ctx ? ctx.rightWidth : panelRef.current.getBoundingClientRect().width
    dragStateRef.current = { startX: event.clientX, startRightWidth, totalWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.classList.add('is-dragging')
  }

  const handleResizerPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragStateRef.current
    if (!drag || !onChangeSplitRatio || drag.totalWidth <= 0) return
    const delta = drag.startX - event.clientX
    const nextRight = drag.startRightWidth + delta
    const leftRatio = Math.max(0.25, Math.min(0.75, 1 - nextRight / drag.totalWidth))
    onChangeSplitRatio(Number(leftRatio.toFixed(4)))
  }

  const handleResizerPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragStateRef.current) return
    dragStateRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.currentTarget.classList.remove('is-dragging')
  }

  return (
    <aside
      ref={panelRef}
      className="translation-panel"
      aria-label="译文区域"
      onDragOver={onDragOverSplitTarget}
      onDragLeave={onDragLeaveSplitTarget}
      onDrop={onDropSplitTarget}
    >
      {onChangeSplitRatio ? (
        <div
          className="translation-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整双栏分屏比例"
          title="左右拖拽调整原文与译文比例，双击恢复 1:1 等宽"
          onPointerDown={handleResizerPointerDown}
          onPointerMove={handleResizerPointerMove}
          onPointerUp={handleResizerPointerUp}
          onPointerCancel={handleResizerPointerUp}
          onDoubleClick={() => onChangeSplitRatio(null)}
        />
      ) : null}
      {mirror.headerOffsetPx > 0 ? (
        <div
          className="translation-header-spacer"
          style={{ height: `${mirror.headerOffsetPx}px` }}
          aria-hidden="true"
        />
      ) : null}
      {translationError ? (
        <div role="alert" className="translation-header__error">
          <span>{translationError}</span>
          <div className="translation-header__error-actions">
            <button
              type="button"
              onClick={() => {
                onDismissTranslationError()
                onOpenSettings()
              }}
            >
              打开设置
            </button>
            <button type="button" onClick={onDismissTranslationError}>关闭</button>
          </div>
        </div>
      ) : null}
      {staleScopeNotice && !translatingPage ? (
        <div role="status" className="translation-stale-banner" data-testid="translation-stale-scope-banner">
          <span>{staleScopeNotice}</span>
          {onRefreshStalePage ? (
            <button
              type="button"
              data-testid="translation-stale-refresh-btn"
              onClick={() => onRefreshStalePage(mirror.currentPage)}
            >
              按新词库重译本页
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        className="translation-scroll"
        ref={handleScrollRef}
        tabIndex={0}
        aria-label="译文结构对照区域"
        onMouseUp={() => {
          if (!scrollContainerEl) return
          const matched = collectSelectedTranslatedSentences(scrollContainerEl, window.getSelection(), layouts)
          if (matched) onSelectTargetSentences?.(matched)
        }}
        onClick={() => {
          if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false
            return
          }
          const sel = window.getSelection()
          if (sel && !sel.isCollapsed) return
          onSelectTargetSentences?.(null)
        }}
      >
        {mirror.pageCount > 0 ? (
          <div className="translation-pages">
            {Array.from({ length: mirror.pageCount }, (_, index) => {
              const pageNumber = index + 1
              const natural = mirror.pageSizes[pageNumber] ?? mirror.estimatedSize
              const insets = mirror.cropMargins
                ? (mirror.pageInsets[pageNumber] ?? ZERO_CROP_INSETS)
                : ZERO_CROP_INSETS
              const fullWidth = natural.width * mirror.scale
              const fullHeight = natural.height * mirror.scale
              const pageStyle: CSSProperties = {
                width: fullWidth * (1 - insets.left - insets.right),
                height: fullHeight * (1 - insets.top - insets.bottom)
              }
              const mountStyle: CSSProperties = {
                left: -(fullWidth * insets.left),
                top: -(fullHeight * insets.top),
                width: fullWidth,
                height: fullHeight
              }
              const isNearCurrent = Math.abs(pageNumber - mirror.currentPage) <= 3
              const pageLayout = layouts.get(pageNumber)
              const backdrop = backdrops.get(pageNumber)
              const pageCache = translationsByPage.get(pageNumber)
              const hasNoText = mirror.pageTextStatus[pageNumber] === false || (pageLayout && !pageLayout.hasText)

              return (
                <div
                  key={pageNumber}
                  className="translation-page"
                  style={pageStyle}
                  data-page-number={pageNumber}
                  data-analyzed={Boolean(pageLayout)}
                >
                  <div className="translation-page-mount" style={mountStyle}>
                    {isNearCurrent ? (
                      <>
                        <MirrorBackdropCanvas bitmap={backdrop?.bitmap} />
                        {hasNoText ? (
                          <div className="translation-page-status">本页没有可提取文字（扫描页），当前暂不支持 OCR。</div>
                        ) : pageLayout ? (
                          <OverlayPageContent
                            layout={pageLayout}
                            scale={mirror.scale}
                            backdropBitmap={backdrop?.bitmap}
                            blockColors={backdrop?.blockColors}
                            translations={pageCache}
                            isTranslating={translatingPage === pageNumber}
                            retranslatingBlockKeys={retranslatingBlockKeys}
                            isActivePage={activePageNumber === pageNumber}
                            activeSentenceIds={activeSentenceIds}
                            suppressNextClickRef={suppressNextClickRef}
                            onSelectTargetSentences={onSelectTargetSentences}
                            onRetranslateBlock={onRetranslateBlock}
                            onEditBlockTranslation={onEditBlockTranslation}
                          />
                        ) : (
                          <div className="translation-page-status">正在分析第 {pageNumber} 页版面结构…</div>
                        )}
                      </>
                    ) : (
                      <div className="translation-page-status">第 {pageNumber} 页</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="translation-empty"><h3>正在准备版面结构</h3></div>
        )}
      </div>
      {bottomPill ? <div className="translation-bottom-dock">{bottomPill}</div> : null}
      {splitDropActive ? (
        <div className="split-drop-overlay split-drop-overlay--full" aria-hidden="true">
          <div className="split-drop-overlay__badge">放到右侧形成双开对照</div>
        </div>
      ) : null}
    </aside>
  )
}
