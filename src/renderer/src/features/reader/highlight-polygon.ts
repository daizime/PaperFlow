import type { PagePoint, PageRect } from './pdf-geometry'

export interface HighlightPolygon {
  points: PagePoint[]
  path: string
}

export interface HighlightPolygonOptions {
  padX?: number
  padY?: number
  radius?: number
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

interface GridEdge {
  x0: number
  y0: number
  x1: number
  y1: number
  dx: number
  dy: number
  used: boolean
}

function snapCoordinates(values: number[], tolerance: number): Map<number, number> {
  const uniqueSorted = [...new Set(values)].sort((a, b) => a - b)
  const map = new Map<number, number>()
  if (uniqueSorted.length === 0) return map

  let cluster: number[] = [uniqueSorted[0]]
  const flushCluster = (): void => {
    const avg = cluster.reduce((sum, v) => sum + v, 0) / cluster.length
    const rounded = Math.round(avg * 100) / 100
    for (const v of cluster) {
      map.set(v, rounded)
    }
    cluster = []
  }

  for (let i = 1; i < uniqueSorted.length; i += 1) {
    if (uniqueSorted[i] - cluster[0] <= tolerance) {
      cluster.push(uniqueSorted[i])
    } else {
      flushCluster()
      cluster = [uniqueSorted[i]]
    }
  }
  flushCluster()
  return map
}

function mergeHorizontalSameRowBoxes(boxes: Box[]): Box[][] {
  if (boxes.length === 0) return []
  const sorted = [...boxes].sort((a, b) => (a.top + b.bottom) / 2 - (b.top + b.bottom) / 2 || a.left - b.left)

  const rows: Box[][] = []
  for (const box of sorted) {
    const cy = (box.top + box.bottom) / 2
    const h = box.bottom - box.top
    const lastRow = rows[rows.length - 1]
    if (lastRow) {
      const ref = lastRow[0]
      const refCy = (ref.top + ref.bottom) / 2
      const refH = ref.bottom - ref.top
      if (Math.abs(cy - refCy) <= Math.max(h, refH) * 0.55) {
        lastRow.push(box)
        continue
      }
    }
    rows.push([box])
  }

  return rows.map(row => {
    const ordered = [...row].sort((a, b) => a.left - b.left)
    const merged: Box[] = []
    for (const box of ordered) {
      const prev = merged[merged.length - 1]
      if (prev && box.left <= prev.right + 4) {
        prev.left = Math.min(prev.left, box.left)
        prev.top = Math.min(prev.top, box.top)
        prev.right = Math.max(prev.right, box.right)
        prev.bottom = Math.max(prev.bottom, box.bottom)
      } else {
        merged.push({ ...box })
      }
    }
    return merged
  })
}

function bridgeVerticalLeadingBetweenRows(rows: Box[][]): void {
  for (let r = 0; r < rows.length - 1; r += 1) {
    const upperRow = rows[r]
    const lowerRow = rows[r + 1]
    for (const u of upperRow) {
      for (const l of lowerRow) {
        const overlapX = Math.min(u.right, l.right) - Math.max(u.left, l.left)
        if (overlapX <= 2) continue
        const gapY = l.top - u.bottom
        const maxH = Math.max(u.bottom - u.top, l.bottom - l.top)
        if (gapY > 0 && gapY <= maxH * 0.9) {
          const midY = (u.bottom + l.top) / 2
          u.bottom = midY
          l.top = midY
        }
      }
    }
  }
}

function removeCollinearVertices(points: PagePoint[]): PagePoint[] {
  if (points.length <= 3) return points
  const result: PagePoint[] = []
  const n = points.length
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n]
    const curr = points[i]
    const next = points[(i + 1) % n]
    const dx1 = curr.x - prev.x
    const dy1 = curr.y - prev.y
    const dx2 = next.x - curr.x
    const dy2 = next.y - curr.y
    if (Math.abs(dx1 * dy2 - dy1 * dx2) <= 1e-4) continue
    result.push(curr)
  }
  return result
}

function signedAreaYDown(points: readonly PagePoint[]): number {
  let sum = 0
  const n = points.length
  for (let i = 0; i < n; i += 1) {
    const p1 = points[i]
    const p2 = points[(i + 1) % n]
    sum += p1.x * p2.y - p2.x * p1.y
  }
  return sum / 2
}

function polygonToRoundedSvgPath(points: readonly PagePoint[], radius: number): string {
  const n = points.length
  if (n < 3) return ''
  const corners = points.map((curr, i) => {
    const prev = points[(i - 1 + n) % n]
    const next = points[(i + 1) % n]
    const v1x = prev.x - curr.x
    const v1y = prev.y - curr.y
    const v2x = next.x - curr.x
    const v2y = next.y - curr.y
    const d1 = Math.hypot(v1x, v1y)
    const d2 = Math.hypot(v2x, v2y)
    const r = Math.max(0, Math.min(radius, d1 * 0.45, d2 * 0.45))
    const inX = d1 > 0 ? curr.x + (v1x / d1) * r : curr.x
    const inY = d1 > 0 ? curr.y + (v1y / d1) * r : curr.y
    const outX = d2 > 0 ? curr.x + (v2x / d2) * r : curr.x
    const outY = d2 > 0 ? curr.y + (v2y / d2) * r : curr.y
    return {
      inPt: { x: Math.round(inX * 100) / 100, y: Math.round(inY * 100) / 100 },
      ctrl: { x: Math.round(curr.x * 100) / 100, y: Math.round(curr.y * 100) / 100 },
      outPt: { x: Math.round(outX * 100) / 100, y: Math.round(outY * 100) / 100 },
      r
    }
  })

  const firstOut = corners[n - 1].outPt
  const parts = [`M ${firstOut.x} ${firstOut.y}`]
  for (const corner of corners) {
    parts.push(`L ${corner.inPt.x} ${corner.inPt.y}`)
    if (corner.r > 0.05) {
      parts.push(`Q ${corner.ctrl.x} ${corner.ctrl.y} ${corner.outPt.x} ${corner.outPt.y}`)
    }
  }
  parts.push('Z')
  return parts.join(' ')
}

function chooseClockwiseTurnEdge(prevEdge: GridEdge, candidates: GridEdge[]): GridEdge {
  if (candidates.length === 1) return candidates[0]
  // 在屏幕 Y 向下坐标系下，顺时针外轮廓向右拐角（dx', dy'）优先；方向排序依次为 右转(+90°)、直行(0°)、左转(-90°)
  const turnScore = (next: GridEdge): number => {
    const cross = prevEdge.dx * next.dy - prevEdge.dy * next.dx
    const dot = prevEdge.dx * next.dx + prevEdge.dy * next.dy
    if (cross > 0) return 0 // 向右拐（Y 向下右手顺时针为 +1）
    if (dot > 0) return 1 // 直行
    if (cross < 0) return 2 // 向左拐
    return 3
  }
  return [...candidates].sort((a, b) => turnScore(a) - turnScore(b))[0]
}

/**
 * 将同句或相邻多行矩形集合先按行距融合，再求解正交并集外轮廓并转为单一平滑圆角 SVG 多边形路径。
 */
export function buildHighlightPolygons(
  rects: readonly PageRect[],
  options: HighlightPolygonOptions = {}
): HighlightPolygon[] {
  const padX = options.padX ?? 2
  const padY = options.padY ?? 1
  const radius = options.radius ?? 3.5

  const padded: Box[] = []
  for (const rect of rects) {
    if (
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      continue
    }
    padded.push({
      left: rect.x - padX,
      top: rect.y - padY,
      right: rect.x + rect.width + padX,
      bottom: rect.y + rect.height + padY
    })
  }
  if (padded.length === 0) return []

  const rows = mergeHorizontalSameRowBoxes(padded)
  bridgeVerticalLeadingBetweenRows(rows)
  const boxes = rows.flat()

  const xSnap = snapCoordinates(
    boxes.flatMap(b => [b.left, b.right]),
    0.6
  )
  const ySnap = snapCoordinates(
    boxes.flatMap(b => [b.top, b.bottom]),
    0.6
  )

  const snappedBoxes: Box[] = []
  for (const box of boxes) {
    const left = xSnap.get(box.left) ?? box.left
    const right = xSnap.get(box.right) ?? box.right
    const top = ySnap.get(box.top) ?? box.top
    const bottom = ySnap.get(box.bottom) ?? box.bottom
    if (right > left && bottom > top) {
      snappedBoxes.push({ left, top, right, bottom })
    }
  }
  if (snappedBoxes.length === 0) return []

  const xs = [...new Set(snappedBoxes.flatMap(b => [b.left, b.right]))].sort((a, b) => a - b)
  const ys = [...new Set(snappedBoxes.flatMap(b => [b.top, b.bottom]))].sort((a, b) => a - b)
  if (xs.length < 2 || ys.length < 2) return []

  const cols = xs.length - 1
  const rowCount = ys.length - 1
  const filled: boolean[][] = Array.from({ length: rowCount }, () => Array<boolean>(cols).fill(false))

  for (let r = 0; r < rowCount; r += 1) {
    const cy = (ys[r] + ys[r + 1]) / 2
    for (let c = 0; c < cols; c += 1) {
      const cx = (xs[c] + xs[c + 1]) / 2
      filled[r][c] = snappedBoxes.some(b => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom)
    }
  }

  const edges: GridEdge[] = []
  const byStart = new Map<string, GridEdge[]>()
  const addEdge = (x0: number, y0: number, x1: number, y1: number, dx: number, dy: number): void => {
    const edge: GridEdge = { x0, y0, x1, y1, dx, dy, used: false }
    edges.push(edge)
    const key = `${x0},${y0}`
    const list = byStart.get(key)
    if (list) list.push(edge)
    else byStart.set(key, [edge])
  }

  for (let r = 0; r < rowCount; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (!filled[r][c]) continue
      if (r === 0 || !filled[r - 1][c]) addEdge(c, r, c + 1, r, 1, 0)
      if (c === cols - 1 || !filled[r][c + 1]) addEdge(c + 1, r, c + 1, r + 1, 0, 1)
      if (r === rowCount - 1 || !filled[r + 1][c]) addEdge(c + 1, r + 1, c, r + 1, -1, 0)
      if (c === 0 || !filled[r][c - 1]) addEdge(c, r + 1, c, r, 0, -1)
    }
  }

  const polygons: HighlightPolygon[] = []
  for (const startEdge of edges) {
    if (startEdge.used) continue
    const loopPoints: PagePoint[] = []
    let curr: GridEdge = startEdge
    let guard = 0
    while (!curr.used && guard <= edges.length + 2) {
      curr.used = true
      loopPoints.push({ x: xs[curr.x0], y: ys[curr.y0] })
      guard += 1
      if (curr.x1 === startEdge.x0 && curr.y1 === startEdge.y0) break
      const candidates = (byStart.get(`${curr.x1},${curr.y1}`) ?? []).filter(e => !e.used)
      if (candidates.length === 0) break
      curr = chooseClockwiseTurnEdge(curr, candidates)
    }

    const simplified = removeCollinearVertices(loopPoints)
    if (simplified.length < 4) continue
    if (signedAreaYDown(simplified) <= 0) continue
    const path = polygonToRoundedSvgPath(simplified, radius)
    if (path) polygons.push({ points: simplified, path })
  }

  return polygons
}
