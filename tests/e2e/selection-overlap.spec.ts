import { test, expect, type Page } from '@playwright/test'
import { createTestData, importFixture, launchApp } from './helpers'
import manifest from '../fixtures/verification/selection-overlap/manifest.json'

interface PdfPoint { x: number; y: number }
interface Rect { x: number; y: number; width: number; height: number }
interface OverlapCase {
  id: string
  pageNumber: number
  lines: { id: string; text: string; x: number; y: number; size: number; width: number }[]
  start: PdfPoint
  end: PdfPoint
  expectedLines: string[]
  expectRectOverlap: boolean
}

// 原创合成正文和未选标题来自素材manifest，不引用或转录用户截图中的论文。
// 以下常数是预先声明的测试判据，尚不是任何候选版本的实测结果。
const criteria = {
  minimumRowOverlapCss: 1,
  looseMaximumOverlapCss: 0.25,
  rectDeduplicationCss: 0.05,
  pixelInteriorCss: 0.25,
  beforeWhiteMinimumChannel: 245,
  beforeWhiteMaximumChannelSpread: 8,
  selectedMinimumWhiteDistance: 20,
  minimumSamplesPerBand: 64,
  minimumSharedColumns: 32,
  minimumTintedFraction: 0.9,
  maximumMeanRgbChannelDifference: 12,
  maximumMedianWhiteDistanceDifference: 12,
  maximumGeometryDriftCss: 0.25,
  sampleColumnStepCss: 2
} as const

// 只规范换行及其两侧空白；正文内部空格、字符和标点全部保留。
const canonical = (value: string): string => value.replace(/\r\n?/g, '\n').replace(/[ \t]*\n+[ \t]*/g, ' ').trim()

async function frame(page: Page, number: number) {
  return page.locator(`.pdf-page[data-page-number="${number}"] canvas`).evaluate(canvas => {
    const root = canvas.closest<HTMLElement>('.pdf-scroll')!
    const box = canvas.getBoundingClientRect()
    const reader = root.getBoundingClientRect()
    const text = canvas.closest('.pdf-page')!.querySelector('.textLayer span')
    const selectionStyle = text ? getComputedStyle(text, '::selection') : null
    return {
      canvas: { x: box.x, y: box.y, width: box.width, height: box.height },
      reader: { x: reader.x + root.clientLeft, y: reader.y + root.clientTop, width: root.clientWidth, height: root.clientHeight },
      scrollTop: root.scrollTop, scrollLeft: root.scrollLeft,
      viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, documentHasFocus: document.hasFocus(),
      activeElement: { tag: document.activeElement?.tagName ?? null, label: document.activeElement?.getAttribute('aria-label') ?? null },
      selectionStyle: { background: selectionStyle?.backgroundColor ?? null, color: selectionStyle?.color ?? null, forcedColors: matchMedia('(forced-colors: active)').matches }
    }
  })
}

// 独立的直角旋转归一化；瞄点只读已知PDF坐标、page view和Canvas CSS框。
function toClient(number: number, point: PdfPoint, geometry: Awaited<ReturnType<typeof frame>>): PdfPoint {
  const specification = manifest.pages.find(value => value.number === number)!
  const [x0, y0, x1, y1] = specification.view
  const u = (point.x - x0) / (x1 - x0)
  const v = (point.y - y0) / (y1 - y0)
  const normalized = specification.rotation === 0 ? { x: u, y: 1 - v }
    : specification.rotation === 90 ? { x: v, y: u }
      : specification.rotation === 180 ? { x: 1 - u, y: v } : { x: 1 - v, y: 1 - u }
  return { x: geometry.canvas.x + normalized.x * geometry.canvas.width, y: geometry.canvas.y + normalized.y * geometry.canvas.height }
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function selectionSnapshot(page: Page, example: OverlapCase) {
  return page.evaluate(({ example, tolerance }) => {
    const rectData = (rect: DOMRect): Rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    const deduplicate = (rects: Rect[]): Rect[] => {
      const unique: Rect[] = []
      for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0) continue
        if (!unique.some(other => ['x', 'y', 'width', 'height'].every(key => Math.abs(other[key as keyof Rect] - rect[key as keyof Rect]) <= tolerance))) unique.push(rect)
      }
      return unique
    }
    const selection = window.getSelection()
    const selectedRanges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, index) => selection!.getRangeAt(index))
    const nodeData = (node: Node | null) => ({
      type: node?.nodeName ?? null, text: node?.textContent ?? null,
      page: node?.parentElement?.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber ?? null
    })
    const root = document.querySelector(`.pdf-page[data-page-number="${example.pageNumber}"] .textLayer`)!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let next: Node | null
    while ((next = walker.nextNode())) nodes.push(next as Text)
    const stream = nodes.map(node => node.data).join('')
    const boundary = (position: number, end: boolean) => {
      let consumed = 0
      for (const node of nodes) {
        if (position < consumed + node.length || (end && position === consumed + node.length)) return { node, offset: position - consumed }
        consumed += node.length
      }
      return null
    }
    // 只在手势完成后读正文节点构造测量Range，不用于瞄点，也不改DOM Selection。
    const rows = example.lines.map(line => {
      const index = stream.indexOf(line.text)
      const unique = index >= 0 && stream.indexOf(line.text, index + 1) < 0
      const start = index >= 0 ? boundary(index, false) : null
      const end = index >= 0 ? boundary(index + line.text.length, true) : null
      if (!start || !end) return { id: line.id, text: line.text, found: false, unique, fullySelected: false, rects: [] as Rect[] }
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      const fullySelected = selectedRanges.some(selected => selected.compareBoundaryPoints(Range.START_TO_START, range) <= 0 && selected.compareBoundaryPoints(Range.END_TO_END, range) >= 0)
      return { id: line.id, text: line.text, found: true, unique, fullySelected, rects: deduplicate(Array.from(range.getClientRects(), rectData)) }
    })
    const rawRangeRects = selectedRanges.flatMap(range => Array.from(range.getClientRects(), rectData))
    return {
      text: selection?.toString() ?? '', anchor: nodeData(selection?.anchorNode ?? null), focus: nodeData(selection?.focusNode ?? null),
      anchorOffset: selection?.anchorOffset ?? null, focusOffset: selection?.focusOffset ?? null,
      rawRangeRects, rangeRects: deduplicate(rawRangeRects), rows
    }
  }, { example, tolerance: criteria.rectDeduplicationCss })
}

async function pixels(page: Page, before: Buffer, after: Buffer, rows: { id: string; rects: Rect[] }[]) {
  return page.evaluate(async ({ before, after, rows, criteria }) => {
    async function decode(base64: string) {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const canvas = document.createElement('canvas') // detached，不接入产品DOM。
      canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data }
    }
    const [original, selected] = await Promise.all([decode(before), decode(after)])
    const distance = (rgb: number[]) => Math.hypot(255 - rgb[0], 255 - rgb[1], 255 - rgb[2])
    const inside = (rect: Rect, x: number, y: number) => x > rect.x + criteria.pixelInteriorCss && x < rect.x + rect.width - criteria.pixelInteriorCss && y > rect.y + criteria.pixelInteriorCss && y < rect.y + rect.height - criteria.pixelInteriorCss
    const coverage = (x: number, y: number) => rows.filter(row => row.rects.some(rect => inside(rect, x, y))).length
    // 原始像素tuple末两列是after/before到纯白的RGB欧氏距离。
    type Sample = [number, number, number, number, number, number, number, number, number, number, number]
    const sampleAt = (x: number, y: number): Sample | null => {
      if (x < 0 || y < 0 || x >= original.width || y >= original.height || x >= selected.width || y >= selected.height) return null
      const index = (y * original.width + x) * 4
      const nextIndex = (y * selected.width + x) * 4
      const rgb = Array.from(original.data.slice(index, index + 3))
      if (Math.min(...rgb) < criteria.beforeWhiteMinimumChannel || Math.max(...rgb) - Math.min(...rgb) > criteria.beforeWhiteMaximumChannelSpread) return null
      const next = Array.from(selected.data.slice(nextIndex, nextIndex + 3))
      return [x, y, rgb[0], rgb[1], rgb[2], next[0], next[1], next[2], coverage(x + 0.5, y + 0.5), distance(next), distance(rgb)]
    }
    const summarize = (samples: Sample[]) => {
      const distances = samples.map(sample => sample[9]).sort((a, b) => a - b)
      return {
        count: samples.length,
        meanRgb: [5, 6, 7].map(channel => samples.length ? samples.reduce((sum, sample) => sum + sample[channel], 0) / samples.length : null),
        medianWhiteDistance: distances.length ? distances[Math.floor(distances.length / 2)] : null,
        tintedFraction: samples.length ? samples.filter(sample => sample[9] >= criteria.selectedMinimumWhiteDistance).length / samples.length : 0
      }
    }
    const pairs = []
    for (let index = 0; index + 1 < rows.length; index++) {
      const first = rows[index], second = rows[index + 1]
      let best: { a: Rect; b: Rect; left: number; right: number; top: number; bottom: number } | null = null
      for (const a of first.rects) for (const b of second.rects) {
        const candidate = { a, b, left: Math.max(a.x, b.x), right: Math.min(a.x + a.width, b.x + b.width), top: Math.max(a.y, b.y), bottom: Math.min(a.y + a.height, b.y + b.height) }
        if (candidate.right <= candidate.left) continue
        if (!best || candidate.bottom - candidate.top > best.bottom - best.top) best = candidate
      }
      if (!best) { pairs.push({ ids: [first.id, second.id], overlapHeight: null, overlap: summarize([]), exclusive: summarize([]), sharedColumns: 0, rawOverlap: [], rawExclusive: [], meanRgbDifference: null, medianWhiteDistanceDifference: null }); continue }
      const overlap: Sample[] = [], exclusive: Sample[] = []
      const top = Math.floor(Math.min(best.a.y, best.b.y))
      const bottom = Math.ceil(Math.max(best.a.y + best.a.height, best.b.y + best.b.height))
      for (let x = Math.ceil(best.left); x < Math.floor(best.right); x += criteria.sampleColumnStepCss) {
        for (let y = top; y < bottom; y++) {
          const sample = sampleAt(x, y)
          if (!sample) continue
          const inPair = inside(best.a, x + 0.5, y + 0.5) || inside(best.b, x + 0.5, y + 0.5)
          if (inPair && sample[8] >= 2 && y + 0.5 > best.top + criteria.pixelInteriorCss && y + 0.5 < best.bottom - criteria.pixelInteriorCss) overlap.push(sample)
          else if (inPair && sample[8] === 1) exclusive.push(sample)
        }
      }
      const overlapColumns = new Set(overlap.map(sample => sample[0]))
      const exclusiveColumns = new Set(exclusive.map(sample => sample[0]))
      const shared = new Set([...overlapColumns].filter(column => exclusiveColumns.has(column)))
      // 松行距无重叠，保留独占带作为颜色存在性对照；密集组必须同x列配对。
      const rawOverlap = overlap.filter(sample => shared.has(sample[0]))
      const rawExclusive = overlap.length ? exclusive.filter(sample => shared.has(sample[0])) : exclusive
      const overlapSummary = summarize(rawOverlap), exclusiveSummary = summarize(rawExclusive)
      const meanRgbDifference = rawOverlap.length && rawExclusive.length ? Math.max(...overlapSummary.meanRgb.map((value, channel) => Math.abs(value! - exclusiveSummary.meanRgb[channel]!))) : null
      const medianWhiteDistanceDifference = overlapSummary.medianWhiteDistance !== null && exclusiveSummary.medianWhiteDistance !== null ? overlapSummary.medianWhiteDistance - exclusiveSummary.medianWhiteDistance : null
      pairs.push({ ids: [first.id, second.id], overlapHeight: Math.max(0, best.bottom - best.top), overlap: overlapSummary, exclusive: exclusiveSummary, sharedColumns: shared.size, rawOverlap, rawExclusive, meanRgbDifference, medianWhiteDistanceDifference })
    }
    return {
      beforeSize: { width: original.width, height: original.height }, afterSize: { width: selected.width, height: selected.height },
      sampleTuple: ['x', 'y', 'beforeR', 'beforeG', 'beforeB', 'afterR', 'afterG', 'afterB', 'rowCoverage', 'afterWhiteDistance', 'beforeWhiteDistance'], pairs
    }
  }, { before: before.toString('base64'), after: after.toString('base64'), rows, criteria })
}

for (const percent of [100, 150]) for (const example of manifest.cases as OverlapCase[]) {
  test(`PFV overlap ${example.id} ${percent}pct DPR1`, async () => {
    const info = test.info()
    const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
    const evidence: Record<string, unknown> = { fixture: manifest.file, example, percent, criteria, phases: [] }
    const phases = evidence.phases as unknown[]
    let before: Buffer | undefined, after: Buffer | undefined
    let held = false
    try {
      await importFixture(app, page, 'verification/selection-overlap/' + manifest.file.name)
      const element = page.locator(`.pdf-page[data-page-number="${example.pageNumber}"]`)
      await expect(element).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
      const input = page.getByRole('spinbutton', { name: '当前页码' })
      await input.fill(String(example.pageNumber)); await input.press('Enter')
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await page.getByTestId('zoom-level').innerText() === '50%') break
        await page.getByRole('button', { name: '缩小', exact: true }).click()
      }
      await expect(page.getByTestId('zoom-level')).toHaveText('50%')
      for (let step = 0; step < (percent - 50) / 10; step++) await page.getByRole('button', { name: '放大', exact: true }).click()
      await expect(page.getByTestId('zoom-level')).toHaveText(percent + '%')
      const specification = manifest.pages.find(value => value.number === example.pageNumber)!
      expect(specification.rotation, '像素带分析当前限定为原创水平正文').toBe(0)
      await expect.poll(async () => Math.abs((await frame(page, example.pageNumber)).canvas.width - specification.width * percent / 100)).toBeLessThan(0.1)
      await expect(element).toHaveAttribute('data-rendered', 'true')
      const initial = await frame(page, example.pageNumber)
      const corners = example.lines.flatMap(line => [toClient(example.pageNumber, { x: line.x, y: line.y + line.size }, initial), toClient(example.pageNumber, { x: line.x + line.width, y: line.y - line.size / 3 }, initial)])
      const center = { x: (Math.min(...corners.map(point => point.x)) + Math.max(...corners.map(point => point.x))) / 2, y: (Math.min(...corners.map(point => point.y)) + Math.max(...corners.map(point => point.y))) / 2 }
      // 只在手势前居中已知PDF正文块；不改窗口、不从TextLayer取瞄点、不在失败后纠正。
      await page.getByLabel('PDF 阅读区域', { exact: true }).evaluate((root, delta) => { root.scrollLeft += delta.x; root.scrollTop += delta.y }, { x: center.x - initial.reader.x - initial.reader.width / 2, y: center.y - initial.reader.y - initial.reader.height / 2 })
      await settled(page)
      const prepared = await frame(page, example.pageNumber)
      const start = toClient(example.pageNumber, example.start, prepared), end = toClient(example.pageNumber, example.end, prepared)
      evidence.setup = { initial, prepared, start, end, pdfStart: example.start, pdfEnd: example.end }
      before = await page.screenshot({ scale: 'css', animations: 'disabled' })
      for (const point of [start, end]) {
        expect(point.x, '固定PDF点必须避开阅读区左右36px自动滚动边带').toBeGreaterThan(prepared.reader.x + 36)
        expect(point.x).toBeLessThan(prepared.reader.x + prepared.reader.width - 36)
        expect(point.y, '固定PDF点必须避开阅读区上下36px自动滚动边带').toBeGreaterThan(prepared.reader.y + 36)
        expect(point.y).toBeLessThan(prepared.reader.y + prepared.reader.height - 36)
      }
      expect(prepared.documentHasFocus, '此组验证活动窗口选区颜色').toBe(true)
      await page.mouse.move(start.x, start.y)
      before = await page.screenshot({ scale: 'css', animations: 'disabled' })
      await page.mouse.down(); held = true
      phases.push({ phase: 'mousedown', pointer: start, geometry: await frame(page, example.pageNumber), selection: await selectionSnapshot(page, example) })
      await page.mouse.move(end.x, end.y, { steps: 24 })
      phases.push({ phase: 'mousemove', pointer: end, geometry: await frame(page, example.pageNumber), selection: await selectionSnapshot(page, example) })
      await page.mouse.up(); held = false
      await settled(page)
      after = await page.screenshot({ scale: 'css', animations: 'disabled' })
      const finished = await frame(page, example.pageNumber)
      const selected = await selectionSnapshot(page, example)
      phases.push({ phase: 'mouseup', pointer: end, geometry: finished, selection: selected })
      const sentinel = 'overlap-copy-sentinel-' + example.id
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), sentinel)
      await page.keyboard.press('Control+C')
      const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
      evidence.clipboard = clipboard
      const measured = await pixels(page, before, after, selected.rows)
      evidence.pixelMeasurements = measured
      evidence.pixelScope = 'Same CSS screenshot pixels; before-white paired background only. Does not establish glyph readability, inactive-window colors, arbitrary PDFs, or physical-monitor DPI behavior.'
      const expected = canonical(example.expectedLines.join('\n'))
      expect(canonical(selected.text), '真实Selection正文，仅规范换行空白，禁止标题或第二页内容').toBe(expected)
      expect(canonical(clipboard), '真实Ctrl+C正文').toBe(expected)
      expect(selected.anchor.page).toBe(String(example.pageNumber))
      expect(selected.focus.page).toBe(String(example.pageNumber))
      expect(selected.anchor.text).toContain(example.expectedLines[0])
      expect(selected.anchorOffset).toBe(0)
      expect(selected.focus.text).toContain(example.expectedLines.at(-1)!)
      expect(selected.focusOffset).toBe(selected.focus.text!.length)
      expect(finished.documentHasFocus).toBe(prepared.documentHasFocus)
      expect(measured.beforeSize).toEqual(prepared.viewport)
      expect(measured.afterSize).toEqual(measured.beforeSize)
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(finished.canvas[key] - prepared.canvas[key]), '前后Canvas几何应稳定').toBeLessThanOrEqual(criteria.maximumGeometryDriftCss)
        expect(Math.abs(finished.reader[key] - prepared.reader[key]), '前后阅读区客户几何应稳定').toBeLessThanOrEqual(criteria.maximumGeometryDriftCss)
      }
      for (const key of ['scrollTop', 'scrollLeft'] as const) expect(Math.abs(finished[key] - prepared[key]), '拖选不能通过滚动改变像素配对').toBeLessThanOrEqual(criteria.maximumGeometryDriftCss)
      for (const row of selected.rows) {
        expect(row.found && row.unique && row.fullySelected, row.id + ':不同原创行必须唯一存在且实际选全').toBe(true)
        expect(row.rects.length).toBeGreaterThan(0)
      }
      expect(measured.pairs.length).toBe(example.lines.length - 1)
      for (const pair of measured.pairs) {
        expect(pair.overlapHeight, pair.ids.join('/') + ':必须有可测量的不同行Range').not.toBeNull()
        expect(pair.exclusive.count, '独占带白底样本不足须明确失败').toBeGreaterThanOrEqual(criteria.minimumSamplesPerBand)
        expect(pair.exclusive.tintedFraction, '独占带必须显示真实选区颜色').toBeGreaterThanOrEqual(criteria.minimumTintedFraction)
        if (example.expectRectOverlap) {
          expect(pair.overlapHeight!, '密集行Range必须实际纵向交叠').toBeGreaterThanOrEqual(criteria.minimumRowOverlapCss)
          expect(pair.sharedColumns, '同x列配对白底不足须明确失败').toBeGreaterThanOrEqual(criteria.minimumSharedColumns)
          expect(pair.overlap.count, '重叠带白底样本不足须明确失败').toBeGreaterThanOrEqual(criteria.minimumSamplesPerBand)
          expect(pair.overlap.tintedFraction, '重叠带也必须有选区颜色').toBeGreaterThanOrEqual(criteria.minimumTintedFraction)
          expect(pair.meanRgbDifference!, '重叠带与独占带不应叠出另一种深色').toBeLessThanOrEqual(criteria.maximumMeanRgbChannelDifference)
          expect(pair.medianWhiteDistanceDifference!, '重叠带白色距离不应额外变深').toBeLessThanOrEqual(criteria.maximumMedianWhiteDistanceDifference)
        } else expect(pair.overlapHeight!).toBeLessThanOrEqual(criteria.looseMaximumOverlapCss)
      }
    } finally {
      if (held) await page.mouse.up().catch(() => {})
      try {
        if (before) await info.attach('overlap-before', { body: before, contentType: 'image/png' })
        after ??= await page.screenshot({ scale: 'css', animations: 'disabled' }).catch(() => undefined)
        if (after) await info.attach('overlap-after', { body: after, contentType: 'image/png' })
        evidence.finalSelection = await selectionSnapshot(page, example).catch(() => null)
        evidence.finalGeometry = await frame(page, example.pageNumber).catch(() => null)
        await info.attach('overlap-observations', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' })
      } finally { await app.close() }
    }
  })
}
