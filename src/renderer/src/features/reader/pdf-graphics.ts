import type { PageGeometry, PageRect } from './pdf-geometry'
import { composeAffine, displayScaleForViewport } from './selection-bridges'

export interface PdfOperatorListLike {
  fnArray: ArrayLike<number>
  argsArray: ArrayLike<unknown>
}

export interface PageGraphicHints {
  imageRects: PageRect[]
  vectorDiagramRects: PageRect[]
  horizontalRules: PageRect[]
  verticalRules: PageRect[]
  tableRuleRegions: PageRect[]
  fractionBars: PageRect[]
}

const OPS_SAVE = 10
const OPS_RESTORE = 11
const OPS_TRANSFORM = 12
const OPS_PAINT_FORM_XOBJECT_BEGIN = 74
const OPS_PAINT_FORM_XOBJECT_END = 75
const OPS_BEGIN_GROUP = 76
const OPS_END_GROUP = 77
const OPS_PAINT_IMAGE_MASK_XOBJECT = 83
const OPS_PAINT_IMAGE_XOBJECT = 85
const OPS_PAINT_INLINE_IMAGE_XOBJECT = 86
const OPS_CONSTRUCT_PATH = 91

const PATH_STROKE = 20
const PATH_CLOSE_STROKE = 21
const PATH_FILL = 22
const PATH_EO_FILL = 23
const PATH_FILL_STROKE = 24
const PATH_EO_FILL_STROKE = 25
const PATH_CLOSE_FILL_STROKE = 26
const PATH_CLOSE_EO_FILL_STROKE = 27

const DRAW_PATH_OPS = new Set([
  PATH_STROKE,
  PATH_CLOSE_STROKE,
  PATH_FILL,
  PATH_EO_FILL,
  PATH_FILL_STROKE,
  PATH_EO_FILL_STROKE,
  PATH_CLOSE_FILL_STROKE,
  PATH_CLOSE_EO_FILL_STROKE
])

function isFillOnlyPathOp(op: number): boolean {
  return op === PATH_FILL || op === PATH_EO_FILL
}

function isArrayLikeNumbers(val: unknown, minLen: number): val is ArrayLike<number> {
  if (!val || typeof val !== 'object') return false
  const candidate = val as { length?: unknown; [idx: number]: unknown }
  if (typeof candidate.length !== 'number' || candidate.length < minLen) return false
  for (let i = 0; i < minLen; i += 1) {
    if (typeof candidate[i] !== 'number' || !Number.isFinite(candidate[i] as number)) return false
  }
  return true
}

function transformBoxToDisplay(
  box: ArrayLike<number>,
  matrix: readonly number[],
  displayScale: number
): PageRect | null {
  const x0 = box[0]
  const y0 = box[1]
  const x1 = box[2]
  const y1 = box[3]
  const xs = [
    matrix[0] * x0 + matrix[2] * y0 + matrix[4],
    matrix[0] * x1 + matrix[2] * y0 + matrix[4],
    matrix[0] * x0 + matrix[2] * y1 + matrix[4],
    matrix[0] * x1 + matrix[2] * y1 + matrix[4]
  ]
  const ys = [
    matrix[1] * x0 + matrix[3] * y0 + matrix[5],
    matrix[1] * x1 + matrix[3] * y0 + matrix[5],
    matrix[1] * x0 + matrix[3] * y1 + matrix[5],
    matrix[1] * x1 + matrix[3] * y1 + matrix[5]
  ]
  const minX = Math.min(...xs) / displayScale
  const minY = Math.min(...ys) / displayScale
  const maxX = Math.max(...xs) / displayScale
  const maxY = Math.max(...ys) / displayScale
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  }
}

function unionGraphicRects(rects: readonly PageRect[]): PageRect {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  }
}

function rectsNearOrOverlapping(a: PageRect, b: PageRect, gap = 0): boolean {
  return (
    a.x <= b.x + b.width + gap &&
    b.x <= a.x + a.width + gap &&
    a.y <= b.y + b.height + gap &&
    b.y <= a.y + a.height + gap
  )
}

function mergeOverlappingRects(rects: readonly PageRect[], gap = 2): PageRect[] {
  if (rects.length <= 1) return [...rects]
  const remaining = [...rects]
  let mergedAny = true
  while (mergedAny) {
    mergedAny = false
    for (let i = 0; i < remaining.length; i += 1) {
      for (let j = i + 1; j < remaining.length; j += 1) {
        if (rectsNearOrOverlapping(remaining[i], remaining[j], gap)) {
          remaining[i] = unionGraphicRects([remaining[i], remaining[j]])
          remaining.splice(j, 1)
          mergedAny = true
          break
        }
      }
      if (mergedAny) break
    }
  }
  return remaining
}

function deriveTableRuleRegions(
  horizontalRules: readonly PageRect[],
  verticalRules: readonly PageRect[],
  natHeight: number,
  pageArea: number
): PageRect[] {
  const regions: PageRect[] = []
  const maxVerticalGap = Math.min(natHeight * 0.35, 280)

  // 1. 水平表线聚簇（兼容 LaTeX booktabs 三线表等无竖线表格）
  const sortedH = [...horizontalRules].sort((a, b) => a.y - b.y || a.x - b.x)
  const used = new Array<boolean>(sortedH.length).fill(false)

  for (let i = 0; i < sortedH.length; i += 1) {
    if (used[i]) continue
    used[i] = true
    const cluster: PageRect[] = [sortedH[i]]
    let lastBottom = sortedH[i].y + sortedH[i].height

    for (let j = i + 1; j < sortedH.length; j += 1) {
      if (used[j]) continue
      const candidate = sortedH[j]
      if (candidate.y - lastBottom > maxVerticalGap) continue

      const ref = cluster[0]
      const overlapX = Math.min(ref.x + ref.width, candidate.x + candidate.width) - Math.max(ref.x, candidate.x)
      const maxW = Math.max(ref.width, candidate.width)
      const edgesAligned = Math.abs(ref.x - candidate.x) <= 18 && Math.abs(ref.x + ref.width - (candidate.x + candidate.width)) <= 18
      if (overlapX >= maxW * 0.72 || edgesAligned) {
        cluster.push(candidate)
        used[j] = true
        lastBottom = Math.max(lastBottom, candidate.y + candidate.height)
      }
    }

    if (cluster.length >= 2) {
      const box = unionGraphicRects(cluster)
      if (box.height >= 18 && box.height <= natHeight * 0.75 && box.width * box.height < pageArea * 0.78) {
        regions.push(box)
      }
    }
  }

  // 2. 网格交叉线表格（>= 2 条水平线与 >= 2 条竖线相交构成网格）
  if (horizontalRules.length >= 2 && verticalRules.length >= 2) {
    const hCount = horizontalRules.length
    const vCount = verticalRules.length
    const hVisited = new Array<boolean>(hCount).fill(false)
    const vVisited = new Array<boolean>(vCount).fill(false)

    for (let hi = 0; hi < hCount; hi += 1) {
      if (hVisited[hi]) continue
      const hGroup: number[] = []
      const vGroup: number[] = []
      const queue: Array<{ kind: 'h' | 'v'; index: number }> = [{ kind: 'h', index: hi }]
      hVisited[hi] = true

      while (queue.length > 0) {
        const current = queue.shift()!
        if (current.kind === 'h') {
          hGroup.push(current.index)
          const hr = horizontalRules[current.index]
          for (let vi = 0; vi < vCount; vi += 1) {
            if (!vVisited[vi] && rectsNearOrOverlapping(hr, verticalRules[vi], 4)) {
              vVisited[vi] = true
              queue.push({ kind: 'v', index: vi })
            }
          }
        } else {
          vGroup.push(current.index)
          const vr = verticalRules[current.index]
          for (let hj = 0; hj < hCount; hj += 1) {
            if (!hVisited[hj] && rectsNearOrOverlapping(vr, horizontalRules[hj], 4)) {
              hVisited[hj] = true
              queue.push({ kind: 'h', index: hj })
            }
          }
        }
      }

      if (hGroup.length >= 2 && vGroup.length >= 2) {
        const box = unionGraphicRects([
          ...hGroup.map(idx => horizontalRules[idx]),
          ...vGroup.map(idx => verticalRules[idx])
        ])
        if (box.height >= 18 && box.height <= natHeight * 0.75 && box.width * box.height < pageArea * 0.78) {
          regions.push(box)
        }
      }
    }
  }

  return mergeOverlappingRects(regions, 4)
}

interface RawShapeEntry {
  rect: PageRect
  isStroke: boolean
}

function clusterVectorDiagramRects(shapes: readonly RawShapeEntry[], pageArea: number): PageRect[] {
  if (shapes.length === 0) return []
  const visited = new Array<boolean>(shapes.length).fill(false)
  const results: PageRect[] = []

  for (let i = 0; i < shapes.length; i += 1) {
    if (visited[i]) continue
    visited[i] = true
    const component: RawShapeEntry[] = []
    const queue = [i]

    while (queue.length > 0) {
      const idx = queue.shift()!
      const cur = shapes[idx]
      component.push(cur)
      for (let j = 0; j < shapes.length; j += 1) {
        if (!visited[j] && rectsNearOrOverlapping(cur.rect, shapes[j].rect, 14)) {
          visited[j] = true
          queue.push(j)
        }
      }
    }

    const hasStroke = component.some(entry => entry.isStroke)
    const box = unionGraphicRects(component.map(entry => entry.rect))
    const area = box.width * box.height
    if (
      (component.length >= 4 || (hasStroke && component.length >= 2 && area >= 600)) &&
      box.width >= 40 &&
      box.height >= 28 &&
      area < pageArea * 0.72
    ) {
      results.push(box)
    }
  }

  return mergeOverlappingRects(results, 4)
}

/**
 * 从 PDF.js 页面绘制操作序列 (`page.getOperatorList()`) 提取归算至 scale=1 显示坐标的图形边界线索，
 * 辅助版面分析精确识别表格线框、嵌入式插图/矢量图以及公式分式线，零 OCR / 模型依赖。
 */
export function extractPageGraphicHints(
  operatorList: PdfOperatorListLike,
  geometry: PageGeometry
): PageGraphicHints {
  const empty: PageGraphicHints = {
    imageRects: [],
    vectorDiagramRects: [],
    horizontalRules: [],
    verticalRules: [],
    tableRuleRegions: [],
    fractionBars: []
  }

  const displayScale = displayScaleForViewport(geometry.viewport)
  if (!Number.isFinite(displayScale) || displayScale <= 0) return empty

  const natWidth = geometry.viewport.width / displayScale
  const natHeight = geometry.viewport.height / displayScale
  const pageArea = natWidth * natHeight
  if (!Number.isFinite(pageArea) || pageArea <= 0) return empty

  const imageRects: PageRect[] = []
  const vectorDiagramRects: PageRect[] = []
  const horizontalRules: PageRect[] = []
  const verticalRules: PageRect[] = []
  const fractionBars: PageRect[] = []
  const rawShapes: RawShapeEntry[] = []

  let ctm: number[] = [...geometry.viewport.transform]
  const ctmStack: number[][] = []
  const formStack: Array<{
    bboxRect: PageRect | null
    drawOps: number
    strokeOps: number
    imageOps: number
  }> = []

  const bumpFormCounts = (delta: { drawOps?: number; strokeOps?: number; imageOps?: number }): void => {
    const top = formStack[formStack.length - 1]
    if (!top) return
    if (delta.drawOps) top.drawOps += delta.drawOps
    if (delta.strokeOps) top.strokeOps += delta.strokeOps
    if (delta.imageOps) top.imageOps += delta.imageOps
  }

  const count = operatorList.fnArray.length
  for (let i = 0; i < count; i += 1) {
    const fn = operatorList.fnArray[i]
    const args = operatorList.argsArray[i]

    if (fn === OPS_SAVE) {
      ctmStack.push([...ctm])
      continue
    }

    if (fn === OPS_RESTORE) {
      if (ctmStack.length > 0) ctm = ctmStack.pop()!
      continue
    }

    if (fn === OPS_TRANSFORM) {
      if (isArrayLikeNumbers(args, 6)) {
        ctm = [...composeAffine(ctm, args as unknown as readonly number[])]
      }
      continue
    }

    if (fn === OPS_BEGIN_GROUP) {
      // PDF.js beginGroup 内部调用 save()，group.matrix 仅用于局部裁剪框而不叠加正文 CTM
      ctmStack.push([...ctm])
      continue
    }

    if (fn === OPS_END_GROUP) {
      if (ctmStack.length > 0) ctm = ctmStack.pop()!
      continue
    }

    if (fn === OPS_PAINT_FORM_XOBJECT_BEGIN) {
      ctmStack.push([...ctm])
      const formArgs = Array.isArray(args) ? args : []
      const matrix = formArgs[0]
      const bbox = formArgs[1]
      if (isArrayLikeNumbers(matrix, 6)) {
        ctm = [...composeAffine(ctm, matrix as unknown as readonly number[])]
      }
      const bboxRect = isArrayLikeNumbers(bbox, 4) ? transformBoxToDisplay(bbox, ctm, displayScale) : null
      formStack.push({ bboxRect, drawOps: 0, strokeOps: 0, imageOps: 0 })
      continue
    }

    if (fn === OPS_PAINT_FORM_XOBJECT_END) {
      const finished = formStack.pop()
      if (ctmStack.length > 0) ctm = ctmStack.pop()!
      if (finished) {
        bumpFormCounts({
          drawOps: finished.drawOps,
          strokeOps: finished.strokeOps,
          imageOps: finished.imageOps
        })
        const br = finished.bboxRect
        if (
          br &&
          br.width >= 36 &&
          br.height >= 24 &&
          br.width * br.height < pageArea * 0.72 &&
          (finished.strokeOps >= 3 || finished.drawOps >= 6 || finished.imageOps >= 1)
        ) {
          vectorDiagramRects.push(br)
        }
      }
      continue
    }

    if (
      fn === OPS_PAINT_IMAGE_XOBJECT ||
      fn === OPS_PAINT_INLINE_IMAGE_XOBJECT ||
      fn === OPS_PAINT_IMAGE_MASK_XOBJECT
    ) {
      const imgRect = transformBoxToDisplay([0, 0, 1, 1], ctm, displayScale)
      bumpFormCounts({ imageOps: 1 })
      if (imgRect && imgRect.width >= 28 && imgRect.height >= 20 && imgRect.width * imgRect.height < pageArea * 0.78) {
        imageRects.push(imgRect)
      }
      continue
    }

    if (fn === OPS_CONSTRUCT_PATH && Array.isArray(args)) {
      const paintOp = args[0]
      const minMax = args[2]
      if (typeof paintOp !== 'number' || !DRAW_PATH_OPS.has(paintOp)) continue
      if (!isArrayLikeNumbers(minMax, 4)) continue

      const rect = transformBoxToDisplay(minMax, ctm, displayScale)
      if (!rect) continue
      const area = rect.width * rect.height
      if ((rect.width > natWidth * 0.92 && rect.height > natHeight * 0.92) || area > pageArea * 0.75) {
        continue
      }

      const fillOnly = isFillOnlyPathOp(paintOp)
      bumpFormCounts({ drawOps: 1, strokeOps: fillOnly ? 0 : 1 })
      const insideForm = formStack.length > 0

      if (
        !insideForm &&
        rect.height <= 3.5 &&
        rect.width >= 40 &&
        rect.width <= natWidth * 0.92 &&
        rect.y >= natHeight * 0.06 &&
        rect.y <= natHeight * 0.94
      ) {
        horizontalRules.push(rect)
        continue
      }

      if (!insideForm && rect.height <= 2.4 && rect.width >= 8 && rect.width < 40) {
        fractionBars.push(rect)
        continue
      }

      if (!insideForm && rect.width <= 3.5 && rect.height >= 16 && rect.height <= natHeight * 0.85) {
        verticalRules.push(rect)
        rawShapes.push({ rect, isStroke: !fillOnly })
        continue
      }

      if (rect.height <= 2.2) continue
      if (fillOnly && rect.width > 180 && rect.height > 45) continue
      if (rect.width >= 4 && rect.height >= 4) {
        rawShapes.push({ rect, isStroke: !fillOnly })
      }
    }
  }

  const tableRuleRegions = deriveTableRuleRegions(horizontalRules, verticalRules, natHeight, pageArea)
  const clusteredDiagrams = clusterVectorDiagramRects(rawShapes, pageArea)
  for (const diagRect of clusteredDiagrams) {
    vectorDiagramRects.push(diagRect)
  }

  return {
    imageRects: mergeOverlappingRects(imageRects, 2),
    vectorDiagramRects: mergeOverlappingRects(vectorDiagramRects, 4),
    horizontalRules,
    verticalRules,
    tableRuleRegions,
    fractionBars
  }
}
