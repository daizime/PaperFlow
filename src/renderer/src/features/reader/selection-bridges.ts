import type { PageViewport } from './pdf-engine'
import type { PageRect } from './pdf-geometry'

export type AffineMatrix = readonly [number, number, number, number, number, number]

export interface VisualRunProjection {
  baseline: number
  em: number
  horizontal: boolean
}

export function composeAffine(m1: readonly number[], m2: readonly number[]): AffineMatrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ]
}

export function displayScaleForViewport(viewport: Pick<PageViewport, 'scale' | 'userUnit'>): number {
  const userUnit = Number.isFinite(viewport.userUnit) && viewport.userUnit > 0 ? viewport.userUnit : 1
  return viewport.scale * userUnit
}

export function projectVisualRun(
  viewportTransform: readonly number[],
  itemTransform: readonly number[],
  displayScale: number,
  dir?: string
): VisualRunProjection | undefined {
  if (!Number.isFinite(displayScale) || displayScale <= 0) return
  const [va, vb, vc, vd, , vBaseline] = composeAffine(viewportTransform, itemTransform)
  const em = Math.hypot(vc, vd) / displayScale
  const baseline = vBaseline / displayScale
  if (!Number.isFinite(em) || em <= 0 || !Number.isFinite(baseline)) return
  const horizontal = dir !== 'ttb' && va > 0 && Math.abs(vb) <= va * 0.01
  return { baseline, em, horizontal }
}

export function viewportToDisplayRect(rect: PageRect, displayScale: number): PageRect {
  return {
    x: rect.x / displayScale,
    y: rect.y / displayScale,
    width: rect.width / displayScale,
    height: rect.height / displayScale
  }
}

export function displayToViewportRect(rect: PageRect, displayScale: number): PageRect {
  return {
    x: rect.x * displayScale,
    y: rect.y * displayScale,
    width: rect.width * displayScale,
    height: rect.height * displayScale
  }
}

export interface SelectionRun {
  rect: PageRect
  ink?: PageRect
  baseline: number
  em: number
  math: boolean
}

interface AlignedRun extends SelectionRun {
  realigned: boolean
}

interface Line {
  baseline: number
  em: number
  runs: AlignedRun[]
}

interface PreliminaryCluster {
  runs: AlignedRun[]
  band: PageRect
  baseline: number
  em: number
}

interface RunCluster {
  run: AlignedRun
  stackedScripts: AlignedRun[]
  inlineScripts: AlignedRun[]
  left: number
  right: number
}

interface Fragment {
  band: PageRect
  baseline: number
  em: number
  math: boolean
  count: number
  enlargedOperator: boolean
  hasStackedScripts: boolean
  visualTop: number
  visualBottom: number
  runs: readonly AlignedRun[]
  inlineScripts: readonly AlignedRun[]
}

const right = (rect: PageRect): number => rect.x + rect.width
const bottom = (rect: PageRect): number => rect.y + rect.height
const centerX = (rect: PageRect): number => rect.x + rect.width / 2
const centerY = (rect: PageRect): number => rect.y + rect.height / 2
const visualRect = (run: SelectionRun): PageRect => run.ink ?? run.rect

function horizontalOverlap(a: PageRect, b: PageRect): { x: number; width: number } {
  const x = Math.max(a.x, b.x)
  return { x, width: Math.min(right(a), right(b)) - x }
}

function verticalOverlap(a: PageRect, b: PageRect): number {
  return Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y)
}

function horizontalGap(a: PageRect, b: PageRect): number {
  return Math.max(a.x - right(b), b.x - right(a))
}

function unionRect(rects: readonly PageRect[]): PageRect {
  let minX = rects[0].x
  let minY = rects[0].y
  let maxX = right(rects[0])
  let maxY = bottom(rects[0])
  for (let i = 1; i < rects.length; i++) {
    minX = Math.min(minX, rects[i].x)
    minY = Math.min(minY, rects[i].y)
    maxX = Math.max(maxX, right(rects[i]))
    maxY = Math.max(maxY, bottom(rects[i]))
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function alignLargeOperators(runs: readonly SelectionRun[]): AlignedRun[] {
  return runs.map(run => {
    if (!run.math || run.rect.width > run.em * 1.5 || run.rect.width <= 0) return { ...run, realigned: false }
    const hasRowCompanion = runs.some(other =>
      other !== run &&
      Math.abs(other.baseline - run.baseline) <= Math.min(other.em, run.em) * 0.38 &&
      (!other.math || other.em >= run.em)
    )
    if (hasRowCompanion) return { ...run, realigned: false }
    let anchor: SelectionRun | undefined
    let nearest = Infinity
    for (const candidate of runs) {
      if (candidate === run) continue
      if (candidate.em < run.em * 0.22 || candidate.em > run.em * 0.74) continue
      if (Math.abs(candidate.baseline - run.baseline) > run.em * 0.55) continue
      const xGap = horizontalGap(candidate.rect, run.rect)
      const yOverlap = verticalOverlap(candidate.rect, run.rect)
      if (xGap < -Math.min(candidate.em, run.em) * 0.25 || xGap > candidate.em * 1.5 || yOverlap < candidate.rect.height * 0.6) continue
      const dy = Math.abs(centerY(candidate.rect) - centerY(run.rect))
      if (dy < nearest) { anchor = candidate; nearest = dy }
    }
    // 大运算符的 PDF 基线可能远低于同行字母；按实际显示高度找到所属行。
    return anchor && anchor.baseline !== run.baseline
      ? { ...run, baseline: anchor.baseline, realigned: true }
      : { ...run, realigned: false }
  })
}

function canAnchorCenteredRun(run: AlignedRun, candidate: AlignedRun): boolean {
  if (candidate.realigned) return false
  if (candidate.em < run.em * 0.70 || candidate.em > run.em * 1.45) return false
  if (!run.math && run.em <= candidate.em * 0.78) return false
  if (!candidate.math && candidate.em < run.em * 0.85 && candidate.rect.width < candidate.em * 1.5) return false
  if (run.math) {
    if (!candidate.math) return candidate.rect.width > run.rect.width || candidate.em >= run.em
    return candidate.em > run.em || (candidate.em === run.em && candidate.rect.width > run.rect.width)
  }
  if (!candidate.math) return candidate.rect.width > run.rect.width
  return candidate.em > run.em && candidate.rect.width >= run.rect.width
}

function alignCenteredInlineRuns(runs: readonly AlignedRun[]): AlignedRun[] {
  return runs.map(run => {
    if (run.realigned || run.rect.width <= 0 || run.rect.width > run.em * 3.5) return run
    const runVisual = visualRect(run)
    const vc = centerY(runVisual)
    let anchor: AlignedRun | undefined
    let bestScore = Infinity
    for (const candidate of runs) {
      if (candidate === run || !canAnchorCenteredRun(run, candidate)) continue
      const baselineDiff = Math.abs(candidate.baseline - run.baseline)
      if (baselineDiff <= Math.min(candidate.em, run.em) * 0.38 || baselineDiff > Math.max(candidate.em, run.em) * 0.75) continue
      const xGap = horizontalGap(candidate.rect, run.rect)
      if (xGap < -Math.min(candidate.em, run.em) * 0.25 || xGap > Math.max(candidate.em, run.em) * 2.5) continue
      const candVisual = visualRect(candidate)
      const yOverlap = verticalOverlap(runVisual, candVisual)
      if (yOverlap < Math.min(runVisual.height, candVisual.height) * 0.5) continue
      // 保留真正的上/下标；只有视觉中心落在主体中段内的居中符号/点才归并到同行。
      const margin = run.em <= candidate.em * 0.88 ? candVisual.height * 0.25 : 0
      if (vc < candVisual.y + margin || vc > bottom(candVisual) - margin) continue
      const score = Math.abs(vc - centerY(candVisual)) + Math.max(0, xGap) * 0.01
      if (score < bestScore) { anchor = candidate; bestScore = score }
    }
    return anchor ? { ...run, baseline: anchor.baseline, realigned: true } : run
  })
}

function groupLines(runs: readonly AlignedRun[]): Line[] {
  const lines: Line[] = []
  const anchorWidths: number[] = []
  for (const run of [...runs].sort((a, b) => a.baseline - b.baseline)) {
    const line = lines.at(-1)
    if (line && run.baseline - line.baseline <= Math.min(line.em, run.em) * 0.38) {
      line.runs.push(run)
      const index = lines.length - 1
      if (!run.realigned && run.rect.width > anchorWidths[index]) {
        line.baseline = run.baseline
        line.em = run.em
        anchorWidths[index] = run.rect.width
      }
    } else {
      lines.push({ baseline: run.baseline, em: run.em, runs: [run] })
      anchorWidths.push(run.rect.width)
    }
  }
  return lines
}

function isSameLineInlineScript(run: AlignedRun, host: AlignedRun, rowBodyEm: number): boolean {
  if (run.em > host.em * 0.78 || run.em > rowBodyEm * 0.88) return false
  if (Math.abs(run.baseline - host.baseline) <= Math.min(run.em, host.em) * 0.25) return false
  const gap = run.rect.x - right(host.rect)
  return gap >= -host.em * 0.2 && gap <= host.em * 0.85 && right(run.rect) >= right(host.rect) - host.em * 0.2 &&
    run.rect.width <= Math.max(host.em * 4.0, host.rect.width)
}

function computeRowBodyEm(runs: readonly AlignedRun[]): number {
  const main = runs.filter((run, index) => {
    const prev = index > 0 ? runs[index - 1] : undefined
    return !(prev && isSameLineInlineScript(run, prev, Math.max(prev.em, run.em)))
  })
  const pool = main.length ? main : runs
  const sizes = pool.map(run => run.em).sort((a, b) => a - b)
  const maxBodyEm = sizes[Math.floor((sizes.length - 1) / 2)] * 1.3
  const body = pool.filter(run => run.em <= maxBodyEm)
  const widest = (body.length ? body : pool).reduce((best, run) => run.rect.width > best.rect.width ? run : best)
  return widest.em
}

function clusterLineHorizontally(line: Line): PreliminaryCluster[] {
  const sorted = [...line.runs].sort((a, b) => a.rect.x - b.rect.x)
  const groups: AlignedRun[][] = []
  let edge: AlignedRun | undefined
  for (const run of sorted) {
    if (!edge || run.rect.x - right(edge.rect) > Math.min(edge.em, run.em) * 1.25) {
      groups.push([run])
      edge = run
    } else {
      groups.at(-1)!.push(run)
      if (right(run.rect) > right(edge.rect)) edge = run
    }
  }
  return groups.map(runs => ({
    runs,
    band: unionRect(runs.map(r => r.rect)),
    baseline: line.baseline,
    em: Math.max(...runs.map(r => r.em))
  }))
}

interface ScriptMatch {
  hostLine: number
  host: AlignedRun
  kind: 'stacked' | 'inline'
  score: number
}

function matchScriptToHost(
  cluster: PreliminaryCluster,
  clusterLineIndex: number,
  lines: readonly Line[],
  rowBodyEms: readonly number[]
): ScriptMatch | undefined {
  const { band, baseline, em } = cluster
  let best: ScriptMatch | undefined
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (lineIndex === clusterLineIndex) continue
    const line = lines[lineIndex]
    const hostRowBodyEm = rowBodyEms[lineIndex]
    for (const host of line.runs) {
      if (em > host.em * 0.88 || em > hostRowBodyEm * 0.88) continue
      const baselineDiff = Math.abs(baseline - host.baseline)
      if (baselineDiff > host.em * 1.25) continue

      const overlap = horizontalOverlap(band, host.rect).width
      if (overlap > 0) {
        const hostVisual = visualRect(host)
        const above = band.y < host.rect.y
        const vGap = above ? hostVisual.y - bottom(band) : band.y - bottom(hostVisual)
        const gapLimit = Math.max(em, host.em * 0.5) * 1.2
        if (vGap > gapLimit) continue
        const narrowScript = band.width <= Math.min(host.rect.width, 4 * host.em)
        const wideMathScript = host.math && host.rect.width <= host.em * 3.0 &&
          band.width <= Math.max(host.rect.width * 5, host.em * 6) &&
          Math.abs(centerX(band) - centerX(host.rect)) <= Math.max(host.rect.width, host.em) * 1.5
        if (!narrowScript && !wideMathScript) continue
        const overlapsOtherHost = line.runs.some(other =>
          other !== host && horizontalOverlap(band, other.rect).width > em * 0.5
        )
        if (overlapsOtherHost) continue
        const score = baselineDiff - overlap * 0.01
        if (!best || score < best.score) best = { hostLine: lineIndex, host, kind: 'stacked', score }
        continue
      }

      if (baselineDiff <= Math.min(em, host.em) * 0.25 || baselineDiff > host.em * 0.85) continue
      const xGap = band.x - right(host.rect)
      if (xGap < -host.em * 0.2 || xGap > host.em * 0.85 || right(band) < right(host.rect) - host.em * 0.2) continue
      if (band.width > Math.max(host.em * 4.0, host.rect.width)) continue
      const score = baselineDiff + Math.max(0, xGap)
      if (!best || score < best.score) best = { hostLine: lineIndex, host, kind: 'inline', score }
    }
  }
  return best
}

function buildLineFragments(
  line: Line,
  stackedByHost: ReadonlyMap<AlignedRun, AlignedRun[]>,
  inlineByHost: ReadonlyMap<AlignedRun, AlignedRun[]>,
  claimedScripts: ReadonlySet<AlignedRun>,
  rowBodyEm: number
): Fragment[] {
  const sorted = [...line.runs].filter(run => !claimedScripts.has(run)).sort((a, b) => a.rect.x - b.rect.x)
  if (!sorted.length) return []

  const clusters: RunCluster[] = []
  for (const run of sorted) {
    const prev = clusters.at(-1)
    if (prev && isSameLineInlineScript(run, prev.run, rowBodyEm)) {
      prev.inlineScripts.push(run)
      prev.right = Math.max(prev.right, right(run.rect))
      continue
    }
    const stacked = stackedByHost.get(run) ?? []
    const inline = inlineByHost.get(run) ?? []
    const allRects = [run.rect, ...stacked.map(s => s.rect), ...inline.map(s => s.rect)]
    clusters.push({
      run,
      stackedScripts: stacked,
      inlineScripts: inline,
      left: Math.min(...allRects.map(r => r.x)),
      right: Math.max(...allRects.map(r => right(r)))
    })
  }

  const groups: RunCluster[][] = []
  let edgeRight = -Infinity
  let edgeEm = 0
  for (const cluster of clusters) {
    // 较宽的间隙把同一高度上的两栏或两个独立选区分开；宽上下标/右侧上下标并入宿主有效水平区间。
    if (!groups.length || cluster.left - edgeRight > Math.min(edgeEm, cluster.run.em) * 1.25) {
      groups.push([cluster])
      edgeRight = cluster.right
      edgeEm = cluster.run.em
    } else {
      groups.at(-1)!.push(cluster)
      if (cluster.right > edgeRight) {
        edgeRight = cluster.right
        edgeEm = cluster.run.em
      }
    }
  }

  return groups.map(group => {
    const mainRuns = group.map(c => c.run)
    const stackedScripts = group.flatMap(c => c.stackedScripts)
    const inlineScripts = group.flatMap(c => c.inlineScripts)
    // 用常规字号里的最宽文字段作行带，保留大运算符和上下标自己的高度；排除已重对齐元素以免干扰中位字号。
    const nonRealigned = mainRuns.filter(run => !run.realigned)
    const sizingRuns = nonRealigned.length ? nonRealigned : mainRuns
    const sizes = sizingRuns.map(run => run.em).sort((a, b) => a - b)
    const maxBodyEm = sizes[Math.floor((sizes.length - 1) / 2)] * 1.3
    const body = mainRuns.filter(run => run.em <= maxBodyEm)
    const nativeBody = body.filter(run => !run.realigned)
    const pool = nativeBody.length ? nativeBody : body
    const nonInk = pool.filter(run => !run.ink)
    const candidates = nonInk.length ? nonInk : pool
    const reference = candidates.reduce((widest, run) => run.rect.width > widest.rect.width ? run : widest)
    const refRect = reference.ink && !nonInk.length ? reference.ink : reference.rect
    const x = mainRuns.reduce((minX, run) => Math.min(minX, run.rect.x), mainRuns[0].rect.x)
    const maxX = mainRuns.reduce((maximum, run) => Math.max(maximum, right(run.rect)), x)
    const band: PageRect = { x, y: refRect.y, width: maxX - x, height: refRect.height }
    const visuals = [
      band,
      ...mainRuns.filter(r => r.math).map(visualRect),
      ...stackedScripts.map(visualRect),
      ...inlineScripts.map(visualRect)
    ]
    return {
      band,
      baseline: reference.baseline,
      em: reference.em,
      math: mainRuns.some(run => run.math) || stackedScripts.some(s => s.math) || inlineScripts.some(s => s.math),
      count: mainRuns.length,
      enlargedOperator: mainRuns.some(run => run.math && run.em >= 1.35 * reference.em),
      hasStackedScripts: stackedScripts.length > 0,
      visualTop: Math.min(...visuals.map(r => r.y)),
      visualBottom: Math.max(...visuals.map(bottom)),
      runs: mainRuns,
      inlineScripts
    }
  })
}

function verticalBridgeBetween(upper: PageRect, lower: PageRect, gapLimit: number): PageRect | undefined {
  const { x, width } = horizontalOverlap(upper, lower)
  const y = bottom(upper)
  const height = lower.y - y
  if (width <= 0 || height <= 0 || height > gapLimit) return
  return { x, y, width, height }
}

function flattenBand(fragment: Fragment): PageRect {
  const { band } = fragment
  if (!fragment.math && !fragment.inlineScripts.length) return band
  const details = fragment.runs.flatMap(run => run.ink ? [run.ink] : [])
  details.push(...fragment.inlineScripts.map(s => s.rect))
  // 平整行带。真正高出行带的大符号仍用其自己的字形区域覆盖；堆叠上下标另行纵向连接。
  const padding = fragment.em * 0.4
  const top = Math.max(band.y - padding, details.reduce((y, rect) => Math.min(y, rect.y), band.y))
  const end = Math.min(bottom(band) + padding, details.reduce((y, rect) => Math.max(y, bottom(rect)), bottom(band)))
  return { ...band, y: top, height: end - top }
}

/** 只补实际选框之间的短空白，坐标为与页面旋转无关的 PDF 单位。 */
export function selectionBridges(runs: readonly SelectionRun[]): PageRect[] {
  if (!runs.length) return []
  const aligned = alignCenteredInlineRuns(alignLargeOperators(runs))
  const lines = groupLines(aligned)
  const rowBodyEms = lines.map(line => computeRowBodyEm(line.runs))

  const preliminary = lines.map(clusterLineHorizontally)
  const stackedByHost = new Map<AlignedRun, AlignedRun[]>()
  const inlineByHost = new Map<AlignedRun, AlignedRun[]>()
  const claimedScripts = new Set<AlignedRun>()
  const matchedPairs: { host: AlignedRun; scriptBand: PageRect; scriptEm: number; kind: 'stacked' | 'inline' }[] = []

  // 先匹配非行内主体的上下标（大字号宿主优先），确保不会误把下一行普通正文当作宽下标。
  const pendingMatches: { cluster: PreliminaryCluster; match: ScriptMatch }[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    for (const cluster of preliminary[lineIndex]) {
      const match = matchScriptToHost(cluster, lineIndex, lines, rowBodyEms)
      if (match) pendingMatches.push({ cluster, match })
    }
  }
  // 确保宿主本身不是被别的行认领的下标。
  const scriptRunSet = new Set<AlignedRun>(pendingMatches.map(item => item.cluster.runs).flat())
  for (const { cluster, match } of pendingMatches) {
    if (scriptRunSet.has(match.host)) continue
    for (const r of cluster.runs) claimedScripts.add(r)
    const targetMap = match.kind === 'stacked' ? stackedByHost : inlineByHost
    const list = targetMap.get(match.host) ?? []
    list.push(...cluster.runs)
    targetMap.set(match.host, list)
    matchedPairs.push({ host: match.host, scriptBand: cluster.band, scriptEm: cluster.em, kind: match.kind })
  }

  const rows = lines
    .map((line, index) => buildLineFragments(line, stackedByHost, inlineByHost, claimedScripts, rowBodyEms[index]))
    .filter(row => row.length > 0)

  const fragmentByRun = new Map<AlignedRun, Fragment>()
  for (const row of rows) {
    for (const fragment of row) {
      for (const run of fragment.runs) fragmentByRun.set(run, fragment)
    }
  }

  const connectedBands = new Set<Fragment>()
  const bridges: PageRect[] = []

  for (const row of rows) {
    for (const fragment of row) {
      if (fragment.count > 1) connectedBands.add(fragment)
      for (const script of fragment.inlineScripts) {
        const gap = script.rect.x - right(fragment.band)
        if (gap > 0 && gap <= fragment.em * 0.85) {
          const bridgeY = Math.max(fragment.band.y, script.rect.y)
          const bridgeBottom = Math.min(bottom(fragment.band), bottom(script.rect))
          if (bridgeBottom > bridgeY) {
            bridges.push({ x: right(fragment.band), y: bridgeY, width: gap, height: bridgeBottom - bridgeY })
          }
        }
      }
    }
  }

  for (const { host, scriptBand, scriptEm, kind } of matchedPairs) {
    const parent = fragmentByRun.get(host)
    if (!parent) continue
    if (kind === 'stacked') {
      const above = scriptBand.y < parent.band.y
      const gapLimit = Math.max(scriptEm, host.em * 0.5) * 1.2
      const bridge = above
        ? verticalBridgeBetween(scriptBand, parent.band, gapLimit)
        : verticalBridgeBetween(parent.band, scriptBand, gapLimit)
      if (bridge) {
        bridges.push(bridge)
        if (parent.count > 1) connectedBands.add(parent)
      }
    }
  }

  for (let index = 0; index < rows.length; index++) {
    for (const upper of rows[index]) {
      for (let next = index + 1; next < rows.length; next++) {
        const nextRow = rows[next]
        const maxNextEm = nextRow.reduce((m, f) => Math.max(m, f.em), upper.em)
        if (nextRow[0].baseline - upper.baseline > Math.max(upper.em, maxNextEm) * 4.5) break
        const adjacent = nextRow.filter(lower => horizontalOverlap(upper.band, lower.band).width > 0)
        if (!adjacent.length) continue
        for (const lower of adjacent) {
          // 独立公式行通常给大运算符和上下标多留一段行距。
          const displayMath =
            upper.enlargedOperator ||
            lower.enlargedOperator ||
            upper.hasStackedScripts ||
            lower.hasStackedScripts ||
            upper.em >= lower.em * 1.35 ||
            lower.em >= upper.em * 1.35
          const em = Math.min(upper.em, lower.em)
          const baselineDiff = lower.baseline - upper.baseline
          if (displayMath) {
            if (baselineDiff > em * 4.2) continue
            if (lower.visualTop - upper.visualBottom > em * 1.95) continue
          } else if (baselineDiff > em * 2.3) {
            continue
          }
          const bridge = verticalBridgeBetween(upper.band, lower.band, em * (displayMath ? 2.6 : 1.0))
          if (bridge) bridges.push(bridge)
          if (bridge || (upper.band.y <= bottom(lower.band) && lower.band.y <= bottom(upper.band))) {
            if (upper.count > 1) connectedBands.add(upper)
            if (lower.count > 1) connectedBands.add(lower)
          }
        }
        break
      }
    }
  }

  return [...bridges, ...Array.from(connectedBands, flattenBand)]
}
