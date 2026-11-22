import { test, expect, type Page } from '@playwright/test'
import { createTestData, importFixture, launchApp } from './helpers'
import manifest from '../fixtures/verification/math-highlight/manifest.json'

interface Point { x: number; y: number }
interface Rect extends Point { width: number; height: number }
interface Part { id: string; text: string; font: string; x: number; y: number; size: number; width: number; role: string }
interface WindowSpec { id: string; pdfWindow: Rect }
interface Bridge extends WindowSpec { kind: string; sourcePartIds: string[]; sourceRowIds: string[] }

// 原创公式、正文、标题与哨兵均由本项目生成；不复制用户截图中的论文。
// 用户要求填连所选蓝框空隙。这些预设判据不裁符号字框，也不是已验证结果。
const criteria = {
  whiteMinimumChannel: 245, whiteMaximumSpread: 8,
  referenceMinimumTintDistance: 20, referenceMinimumTintedFraction: 0.8,
  referenceMinimumSamples: 64, referenceMinimumBlueBias: 16,
  maximumBlueChannelDifference: 14,
  minimumWindowSamples: 4, minimumGuardSamples: 32, minimumWindowColumns: 2, minimumWindowRows: 2,
  minimumAxisSamples: 2, minimumBridgeBlueFraction: 0.95, minimumAxisBlueFraction: 0.9,
  minimumGuardWhiteFraction: 0.95,
  inkMaximumBeforeChannel: 100, inkMinimumSamples: 3, inkMinimumContrastFromBlue: 40,
  minimumPreservedInkFraction: 0.9,
  interiorCss: 0.25, maximumGeometryDriftCss: 0.25, rectDeduplicationCss: 0.05
} as const

// 素材契约明确 remove-whitespace-only：验证完整字符序列，保留符号及标点。
const canonical = (value: string): string => value.replace(/\s/g, '')

async function frame(page: Page) {
  return page.locator(`.pdf-page[data-page-number="${manifest.selection.pageNumber}"] canvas`).evaluate(canvas => {
    const root = canvas.closest<HTMLElement>('.pdf-scroll')!
    const box = canvas.getBoundingClientRect(), reader = root.getBoundingClientRect()
    const text = canvas.closest('.pdf-page')!.querySelector('.textLayer span')
    const style = text ? getComputedStyle(text, '::selection') : null
    return {
      canvas: { x: box.x, y: box.y, width: box.width, height: box.height },
      reader: { x: reader.x + root.clientLeft, y: reader.y + root.clientTop, width: root.clientWidth, height: root.clientHeight },
      scrollTop: root.scrollTop, scrollLeft: root.scrollLeft,
      viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio,
      hasFocus: document.hasFocus(), activeElement: { tag: document.activeElement?.tagName ?? null, label: document.activeElement?.getAttribute('aria-label') ?? null },
      selectionStyle: { background: style?.backgroundColor ?? null, color: style?.color ?? null }, forcedColors: matchMedia('(forced-colors: active)').matches
    }
  })
}

function toClient(point: Point, geometry: Awaited<ReturnType<typeof frame>>): Point {
  const specification = manifest.pages.find(value => value.number === manifest.selection.pageNumber)!
  const [x0, y0, x1, y1] = specification.view
  const u = (point.x - x0) / (x1 - x0), v = (point.y - y0) / (y1 - y0)
  const rotated = specification.rotation === 0 ? { x: u, y: 1 - v }
    : specification.rotation === 90 ? { x: v, y: u }
      : specification.rotation === 180 ? { x: 1 - u, y: v } : { x: 1 - v, y: 1 - u }
  return { x: geometry.canvas.x + rotated.x * geometry.canvas.width, y: geometry.canvas.y + rotated.y * geometry.canvas.height }
}

function clientWindow(window: Rect, geometry: Awaited<ReturnType<typeof frame>>): Rect {
  const a = toClient(window, geometry), b = toClient({ x: window.x + window.width, y: window.y + window.height }, geometry)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function snapshot(page: Page) {
  return page.evaluate(({ parts, tolerance, number }) => {
    const rectData = (rect: DOMRect): Rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    const deduplicate = (rects: Rect[]) => rects.filter((rect, index) => rect.width > 0 && rect.height > 0 && !rects.slice(0, index).some(other => (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(rect[key] - other[key]) <= tolerance)))
    const selection = window.getSelection()
    const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, index) => selection!.getRangeAt(index))
    const data = (node: Node | null) => ({ type: node?.nodeName ?? null, text: node?.textContent ?? null, page: node?.parentElement?.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber ?? null })
    const root = document.querySelector(`.pdf-page[data-page-number="${number}"] .textLayer`)!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes: Text[] = []
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
    const streamIndices: number[] = []
    let normalizedStream = ''
    for (let index = 0; index < stream.length; index++) if (!/\s/.test(stream[index])) { normalizedStream += stream[index]; streamIndices.push(index) }
    const absolutePosition = (node: Node, offset: number): number | null => {
      let consumed = 0
      for (const text of nodes) { if (text === node) return consumed + offset; consumed += text.length }
      return null
    }
    const firstRange = ranges[0]
    const selectedStart = firstRange ? absolutePosition(firstRange.startContainer, firstRange.startOffset) : null
    const selectedEnd = firstRange ? absolutePosition(firstRange.endContainer, firstRange.endOffset) : null
    let cursor = selectedStart === null ? normalizedStream.length : streamIndices.findIndex(index => index >= selectedStart)
    if (cursor < 0) cursor = normalizedStream.length
    // 手势完成后只读测量原始制作顺序中的parts；这些Range不写入Selection、不用于瞄点。
    const measuredParts = parts.map(part => {
      const content = part.text.replace(/\s/g, '')
      const index = normalizedStream.indexOf(content, cursor)
      const originalStart = streamIndices[index], originalEnd = streamIndices[index + content.length - 1] + 1
      const withinSelection = index >= 0 && selectedEnd !== null && originalEnd <= selectedEnd
      const start = withinSelection ? boundary(originalStart, false) : null, end = withinSelection ? boundary(originalEnd, true) : null
      if (!start || !end) return { id: part.id, text: part.text, role: part.role, found: false, fullySelected: false, rects: [] as Rect[] }
      cursor = index + content.length
      const range = document.createRange()
      range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset)
      return { id: part.id, text: part.text, role: part.role, found: true, fullySelected: ranges.some(selected => selected.compareBoundaryPoints(Range.START_TO_START, range) <= 0 && selected.compareBoundaryPoints(Range.END_TO_END, range) >= 0), rects: deduplicate(Array.from(range.getClientRects(), rectData)) }
    })
    const rawRangeRects = ranges.flatMap(range => Array.from(range.getClientRects(), rectData))
    return { text: selection?.toString() ?? '', anchor: data(selection?.anchorNode ?? null), focus: data(selection?.focusNode ?? null), anchorOffset: selection?.anchorOffset ?? null, focusOffset: selection?.focusOffset ?? null, rawRangeRects, rangeRects: deduplicate(rawRangeRects), measuredParts, stream }
  }, { parts: manifest.parts as Part[], tolerance: criteria.rectDeduplicationCss, number: manifest.selection.pageNumber })
}

async function pixelEvidence(page: Page, before: Buffer, after: Buffer, referenceRects: Rect[], bridges: (Bridge & { client: Rect })[], guards: (WindowSpec & { client: Rect })[], glyphs: { id: string; rects: Rect[] }[]) {
  return page.evaluate(async ({ before, after, referenceRects, bridges, guards, glyphs, criteria }) => {
    async function decode(base64: string) {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], { type: 'image/png' }))
      const canvas = document.createElement('canvas') // detached，仅解码原样PNG，不写产品DOM或配色。
      canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(bitmap, 0, 0); bitmap.close()
      return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data }
    }
    const [a, b] = await Promise.all([decode(before), decode(after)])
    const white = (rgb: number[]) => Math.min(...rgb) >= criteria.whiteMinimumChannel && Math.max(...rgb) - Math.min(...rgb) <= criteria.whiteMaximumSpread
    const whiteDistance = (rgb: number[]) => Math.hypot(255 - rgb[0], 255 - rgb[1], 255 - rgb[2])
    const median = (values: number[]) => values.length ? [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] : null
    const colorAt = (image: typeof a, x: number, y: number) => Array.from(image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3))
    // tuple: x,y,beforeRGB,afterRGB,beforeWhiteDistance,afterWhiteDistance,deltaToReference。
    type Sample = [number, number, number, number, number, number, number, number, number, number, number | null]
    const collect = (rects: Rect[], mode: 'white' | 'ink'): Sample[] => {
      const result: Sample[] = [], seen = new Set<string>()
      for (const rect of rects) {
        for (let y = Math.ceil(rect.y); y + 0.5 < rect.y + rect.height - criteria.interiorCss; y++) {
          for (let x = Math.ceil(rect.x); x + 0.5 < rect.x + rect.width - criteria.interiorCss; x++) {
            if (x + 0.5 <= rect.x + criteria.interiorCss || y + 0.5 <= rect.y + criteria.interiorCss || x < 0 || y < 0 || x >= a.width || y >= a.height || x >= b.width || y >= b.height || seen.has(x + ',' + y)) continue
            seen.add(x + ',' + y)
            const original = colorAt(a, x, y), selected = colorAt(b, x, y)
            if (mode === 'white' ? !white(original) : Math.max(...original) > criteria.inkMaximumBeforeChannel) continue
            result.push([x, y, original[0], original[1], original[2], selected[0], selected[1], selected[2], whiteDistance(original), whiteDistance(selected), null])
          }
        }
      }
      return result
    }
    const referenceRaw = collect(referenceRects, 'white')
    const tinted = referenceRaw.filter(sample => sample[9] >= criteria.referenceMinimumTintDistance)
    const referenceColor = [5, 6, 7].map(channel => median(tinted.map(sample => sample[channel] as number)))
    const referenceValid = referenceColor.every(channel => channel !== null)
    const difference = (sample: Sample) => referenceValid ? Math.max(...[5, 6, 7].map((channel, index) => Math.abs((sample[channel] as number) - referenceColor[index]!))) : null
    for (const sample of referenceRaw) sample[10] = difference(sample)
    const matching = (sample: Sample) => sample[10] !== null && sample[10] <= criteria.maximumBlueChannelDifference
    function axis(raw: Sample[], coordinate: 0 | 1) {
      const groups = new Map<number, Sample[]>()
      for (const sample of raw) { const group = groups.get(sample[coordinate]) ?? []; group.push(sample); groups.set(sample[coordinate], group) }
      return [...groups].map(([position, samples]) => ({ position, count: samples.length, blueFraction: samples.filter(matching).length / samples.length })).filter(group => group.count >= criteria.minimumAxisSamples)
    }
    const measuredBridges = bridges.map(bridge => {
      const raw = collect([bridge.client], 'white')
      for (const sample of raw) sample[10] = difference(sample)
      const columns = axis(raw, 0), rows = axis(raw, 1)
      return { ...bridge, raw, samples: raw.length, columns, rows, blueFraction: raw.length ? raw.filter(matching).length / raw.length : null, whiteFractionAfter: raw.length ? raw.filter(sample => white(sample.slice(5, 8) as number[])).length / raw.length : null, minimumColumnBlueFraction: columns.length ? Math.min(...columns.map(group => group.blueFraction)) : null, minimumRowBlueFraction: rows.length ? Math.min(...rows.map(group => group.blueFraction)) : null }
    })
    const measuredGuards = guards.map(guard => {
      const raw = collect([guard.client], 'white')
      for (const sample of raw) sample[10] = difference(sample)
      return { ...guard, raw, samples: raw.length, whiteFractionAfter: raw.length ? raw.filter(sample => white(sample.slice(5, 8) as number[])).length / raw.length : null }
    })
    const measuredGlyphs = glyphs.map(glyph => {
      const raw = collect(glyph.rects, 'ink')
      for (const sample of raw) sample[10] = difference(sample)
      return { ...glyph, raw, samples: raw.length, preservedInkFraction: raw.length && referenceValid ? raw.filter(sample => sample[10]! >= criteria.inkMinimumContrastFromBlue).length / raw.length : null }
    })
    return {
      beforeSize: { width: a.width, height: a.height }, afterSize: { width: b.width, height: b.height },
      sampleTuple: ['x', 'y', 'beforeR', 'beforeG', 'beforeB', 'afterR', 'afterG', 'afterB', 'beforeWhiteDistance', 'afterWhiteDistance', 'maximumChannelDifferenceFromReference'],
      reference: { color: referenceColor, raw: referenceRaw, samples: referenceRaw.length, tintedSamples: tinted.length, tintedFraction: referenceRaw.length ? tinted.length / referenceRaw.length : 0, blueBias: referenceValid ? referenceColor[2]! - referenceColor[0]! : null },
      bridges: measuredBridges, guards: measuredGuards, glyphs: measuredGlyphs
    }
  }, { before: before.toString('base64'), after: after.toString('base64'), referenceRects, bridges, guards, glyphs, criteria })
}

test('PFV math selected formula and next row have continuous blue at 100pct DPR1', async () => {
  const info = test.info(), { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
  const evidence: Record<string, unknown> = { fixture: manifest.file, selection: manifest.selection, selectedRows: manifest.selectedRows, criteria, phases: [] }
  const phases = evidence.phases as unknown[]
  let before: Buffer | undefined, after: Buffer | undefined, held = false
  let stage = 'script-precondition'
  try {
    await importFixture(app, page, 'verification/math-highlight/' + manifest.file.name)
    const element = page.locator(`.pdf-page[data-page-number="${manifest.selection.pageNumber}"]`)
    await expect(element).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await page.getByTestId('zoom-level').innerText() === '50%') break
      await page.getByRole('button', { name: '缩小', exact: true }).click()
    }
    await expect(page.getByTestId('zoom-level')).toHaveText('50%')
    for (let step = 0; step < 5; step++) await page.getByRole('button', { name: '放大', exact: true }).click()
    await expect(page.getByTestId('zoom-level')).toHaveText('100%')
    const specification = manifest.pages.find(value => value.number === manifest.selection.pageNumber)!
    expect(specification.rotation, '初版只验证100%水平两行').toBe(0)
    expect(manifest.selection.normalization).toBe('remove-whitespace-only')
    await expect.poll(async () => Math.abs((await frame(page)).canvas.width - specification.width)).toBeLessThan(0.1)
    await expect(element).toHaveAttribute('data-rendered', 'true')
    const initial = await frame(page)
    const initialStart = toClient(manifest.selection.start, initial), initialEnd = toClient(manifest.selection.end, initial)
    await page.getByLabel('PDF 阅读区域', { exact: true }).evaluate((root, delta) => { root.scrollTop += delta.y; root.scrollLeft += delta.x }, { x: (initialStart.x + initialEnd.x) / 2 - initial.reader.x - initial.reader.width / 2, y: (initialStart.y + initialEnd.y) / 2 - initial.reader.y - initial.reader.height / 2 })
    await settled(page)
    const prepared = await frame(page), start = toClient(manifest.selection.start, prepared), end = toClient(manifest.selection.end, prepared)
    const bridges = (manifest.bridgeCandidates as Bridge[]).map(bridge => ({ ...bridge, client: clientWindow(bridge.pdfWindow, prepared) }))
    const guards = (manifest.guardWindows as WindowSpec[]).map(guard => ({ ...guard, client: clientWindow(guard.pdfWindow, prepared) }))
    evidence.setup = { initial, prepared, start, end, bridges, guards }
    before = await page.screenshot({ scale: 'css', animations: 'disabled' })
    for (const point of [start, end]) {
      expect(point.x, '固定PDF点不得触发36px边缘自动滚动').toBeGreaterThan(prepared.reader.x + 36)
      expect(point.x).toBeLessThan(prepared.reader.x + prepared.reader.width - 36)
      expect(point.y).toBeGreaterThan(prepared.reader.y + 36)
      expect(point.y).toBeLessThan(prepared.reader.y + prepared.reader.height - 36)
    }
    for (const window of [...bridges, ...guards]) {
      expect(window.client.x, window.id + ':像素窗必须完整可见').toBeGreaterThanOrEqual(prepared.reader.x + 1)
      expect(window.client.y).toBeGreaterThanOrEqual(prepared.reader.y + 1)
      expect(window.client.x + window.client.width).toBeLessThanOrEqual(prepared.reader.x + prepared.reader.width - 1)
      expect(window.client.y + window.client.height).toBeLessThanOrEqual(prepared.reader.y + prepared.reader.height - 1)
    }
    expect(prepared.hasFocus).toBe(true)
    await page.mouse.move(start.x, start.y)
    before = await page.screenshot({ scale: 'css', animations: 'disabled' })
    await page.mouse.down(); held = true
    phases.push({ phase: 'mousedown', pointer: start, geometry: await frame(page), selection: await snapshot(page) })
    await page.mouse.move(end.x, end.y, { steps: 32 })
    phases.push({ phase: 'mousemove', pointer: end, geometry: await frame(page), selection: await snapshot(page) })
    await page.mouse.up(); held = false
    await settled(page)
    after = await page.screenshot({ scale: 'css', animations: 'disabled' })
    const selected = await snapshot(page), finished = await frame(page)
    phases.push({ phase: 'mouseup', pointer: end, geometry: finished, selection: selected })
    await app.evaluate(({ clipboard }) => clipboard.writeText('math-highlight-copy-sentinel'))
    await page.keyboard.press('Control+C')
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
    evidence.clipboard = clipboard
    // 先过真实内容门禁；内容失败不能被后续视觉结果包装成“形状失败”。
    stage = 'selection-content'
    expect(canonical(selected.text), '真实Selection必须含完整公式和下一行正文').toBe(canonical(manifest.selection.expectedText))
    expect(canonical(clipboard), '真实Ctrl+C完整字符序列').toBe(canonical(manifest.selection.expectedText))
    expect(selected.anchor.page).toBe(String(manifest.selection.pageNumber))
    expect(selected.focus.page).toBe(String(manifest.selection.pageNumber))
    evidence.contentVerified = true
    stage = 'script-precondition'
    expect(finished.hasFocus).toBe(prepared.hasFocus)
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(finished.canvas[key] - prepared.canvas[key]), '前后Canvas必须匹配').toBeLessThanOrEqual(criteria.maximumGeometryDriftCss)
      expect(Math.abs(finished.reader[key] - prepared.reader[key])).toBeLessThanOrEqual(criteria.maximumGeometryDriftCss)
    }
    for (const key of ['scrollTop', 'scrollLeft'] as const) expect(Math.abs(finished[key] - prepared[key])).toBeLessThanOrEqual(criteria.maximumGeometryDriftCss)
    const selectedIds = manifest.selectedRows.flatMap(row => row.partIds)
    const selectedParts = selected.measuredParts.filter(part => selectedIds.includes(part.id))
    expect(selectedParts.length).toBe(selectedIds.length)
    for (const part of selectedParts) expect(part.found && part.fullySelected && part.rects.length > 0, part.id + ':只读Range必须属于实际完整选区').toBe(true)
    const referenceRects = selectedParts.filter(part => manifest.reference.bodyPartIds.includes(part.id)).flatMap(part => part.rects)
    const bounds = (rects: Rect[]): Rect => ({ x: Math.min(...rects.map(rect => rect.x)), y: Math.min(...rects.map(rect => rect.y)), width: Math.max(...rects.map(rect => rect.x + rect.width)) - Math.min(...rects.map(rect => rect.x)), height: Math.max(...rects.map(rect => rect.y + rect.height)) - Math.min(...rects.map(rect => rect.y)) })
    evidence.bridgeGeometry = bridges.map(bridge => {
      const sources = bridge.sourcePartIds.map(id => ({ id, bounds: bounds(selectedParts.find(part => part.id === id)!.rects) }))
      const [a, b] = sources.map(source => source.bounds)
      return { id: bridge.id, kind: bridge.kind, sourceRowIds: bridge.sourceRowIds, sources, gapCss: bridge.kind === 'horizontal' ? b.x - a.x - a.width : b.y - a.y - a.height, sharedXWidthCss: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), windowWidthCss: bridge.client.width, windowHeightCss: bridge.client.height }
    })
    const measured = await pixelEvidence(page, before, after, referenceRects, bridges, guards, selectedParts)
    evidence.pixels = measured
    evidence.scope = 'Active-window DPR1 CSS screenshot; same before-white pixels only. Reference blue is measured from selected ordinary body. Glyph ink is measured separately; no trimming of operator, superscript, or subscript.'
    expect(measured.beforeSize).toEqual(prepared.viewport)
    expect(measured.afterSize).toEqual(measured.beforeSize)
    expect(measured.reference.samples, '参考正文白底样本不足').toBeGreaterThanOrEqual(criteria.referenceMinimumSamples)
    expect(measured.reference.tintedSamples).toBeGreaterThanOrEqual(criteria.referenceMinimumSamples)
    expect(measured.reference.tintedFraction, '参考正文必须已着色').toBeGreaterThanOrEqual(criteria.referenceMinimumTintedFraction)
    expect(measured.reference.blueBias!, '必须能从普通正文估计蓝色，不使用截图硬编码色').toBeGreaterThanOrEqual(criteria.referenceMinimumBlueBias)
    expect(measured.bridges.some(bridge => bridge.kind === 'horizontal')).toBe(true)
    expect(measured.bridges.some(bridge => bridge.kind === 'vertical')).toBe(true)
    for (const window of measured.bridges) {
      expect(window.samples, window.id + ':连接窗白底样本不足').toBeGreaterThanOrEqual(criteria.minimumWindowSamples)
      expect(window.columns.length).toBeGreaterThanOrEqual(criteria.minimumWindowColumns)
      expect(window.rows.length).toBeGreaterThanOrEqual(criteria.minimumWindowRows)
    }
    for (const guard of measured.guards) expect(guard.samples, guard.id + ':守卫白底样本不足').toBeGreaterThanOrEqual(criteria.minimumGuardSamples)
    for (const glyph of measured.glyphs) expect(glyph.samples, glyph.id + ':真实glyph ink样本不足').toBeGreaterThanOrEqual(criteria.inkMinimumSamples)
    evidence.samplingPrerequisitesVerified = true
    stage = 'product-selection-shape'
    for (const window of measured.bridges) {
      expect(window.blueFraction!, window.id + ':所选短横空档或上下行接缝应连续同蓝').toBeGreaterThanOrEqual(criteria.minimumBridgeBlueFraction)
      expect(window.minimumColumnBlueFraction!, window.id + ':不可残留竖向白缝').toBeGreaterThanOrEqual(criteria.minimumAxisBlueFraction)
      expect(window.minimumRowBlueFraction!, window.id + ':不可残留横向白缝').toBeGreaterThanOrEqual(criteria.minimumAxisBlueFraction)
    }
    for (const guard of measured.guards) expect(guard.whiteFractionAfter!, guard.id + ':未选标题/末尾/远段/宽缝仍应留白').toBeGreaterThanOrEqual(criteria.minimumGuardWhiteFraction)
    for (const glyph of measured.glyphs) expect(glyph.preservedInkFraction!, glyph.id + ':不得把真实glyph抹成蓝色空白').toBeGreaterThanOrEqual(criteria.minimumPreservedInkFraction)
  } catch (error) {
    evidence.failure = { category: stage, message: error instanceof Error ? error.message : String(error) }
    throw error
  } finally {
    if (held) await page.mouse.up().catch(() => {})
    try {
      if (before) await info.attach('math-highlight-before', { body: before, contentType: 'image/png' })
      after ??= await page.screenshot({ scale: 'css', animations: 'disabled' }).catch(() => undefined)
      if (after) await info.attach('math-highlight-after', { body: after, contentType: 'image/png' })
      evidence.finalSelection = await snapshot(page).catch(() => null)
      evidence.finalGeometry = await frame(page).catch(() => null)
      await info.attach('math-highlight-observations', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' })
    } finally { await app.close() }
  }
})

// PFV-READER-006追加：原两行100%用例及helpers/判据逐byte保留。
// 只选公式；下一行的负向窗取普通tail字列，避开大Symbol固有字框padding。
async function runFormulaOnly(percent: 100 | 150): Promise<void> {
  const info = test.info()
  const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
  const formulaRows = manifest.selectedRows.filter(row => row.role === 'formula')
  const lowerRows = manifest.selectedRows.filter(row => row.role === 'body')
  const selectedIds = formulaRows.flatMap(row => row.partIds)
  const lowerIds = lowerRows.flatMap(row => row.partIds)
  const tail = manifest.parts.find(part => part.id === 'formula-tail')!
  const lower = manifest.parts.find(part => lowerIds.includes(part.id))!
  const lowerGuard: WindowSpec & { reason: string } = {
    id: 'formula-only-unselected-lower-tail-column',
    pdfWindow: { x: tail.x + 5, y: lower.y, width: 15, height: 12 },
    reason: '未选下一行的普通tail字列；不以Symbol下方已有大字框padding判新连接'
  }
  const evidence: Record<string, unknown> = {
    fixture: manifest.file, mode: 'formula-only', percent, formula: manifest.formula,
    selectedRows: formulaRows, selectedPartIds: selectedIds, lowerRows, criteria, phases: []
  }
  const phases = evidence.phases as unknown[]
  let before: Buffer | undefined, after: Buffer | undefined, held = false
  let stage = 'script-precondition'
  try {
    expect(manifest.formula.pageNumber).toBe(manifest.selection.pageNumber)
    expect(selectedIds.length).toBe(6)
    expect(lowerRows.length).toBe(1)
    expect(manifest.selection.normalization).toBe('remove-whitespace-only')
    await importFixture(app, page, 'verification/math-highlight/' + manifest.file.name)
    const element = page.locator('.pdf-page[data-page-number="' + manifest.formula.pageNumber + '"]')
    await expect(element).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await page.getByTestId('zoom-level').innerText() === '50%') break
      await page.getByRole('button', { name: '缩小', exact: true }).click()
    }
    await expect(page.getByTestId('zoom-level')).toHaveText('50%')
    for (let step = 0; step < (percent - 50) / 10; step++) await page.getByRole('button', { name: '放大', exact: true }).click()
    await expect(page.getByTestId('zoom-level')).toHaveText(percent + '%')
    const specification = manifest.pages.find(value => value.number === manifest.formula.pageNumber)!
    expect(specification.rotation).toBe(0)
    await expect.poll(async () => Math.abs((await frame(page)).canvas.width - specification.width * percent / 100)).toBeLessThan(0.1)
    await expect(element).toHaveAttribute('data-rendered', 'true')
    const initial = await frame(page)
    const initialStart = toClient(manifest.formula.start, initial), initialEnd = toClient(manifest.formula.end, initial)
    await page.getByLabel('PDF 阅读区域', { exact: true }).evaluate((root, delta) => { root.scrollTop += delta.y; root.scrollLeft += delta.x }, {
      x: (initialStart.x + initialEnd.x) / 2 - initial.reader.x - initial.reader.width / 2,
      y: (initialStart.y + initialEnd.y) / 2 - initial.reader.y - initial.reader.height / 2
    })
    await settled(page)
    const prepared = await frame(page)
    const start = toClient(manifest.formula.start, prepared), end = toClient(manifest.formula.end, prepared)
    const bridges = (manifest.bridgeCandidates as Bridge[]).filter(bridge => bridge.kind === 'horizontal').map(bridge => ({ ...bridge, client: clientWindow(bridge.pdfWindow, prepared) }))
    const guards = [...manifest.guardWindows, lowerGuard].map(guard => ({ ...guard, client: clientWindow(guard.pdfWindow, prepared) }))
    evidence.setup = { initial, prepared, pdfStart: manifest.formula.start, pdfEnd: manifest.formula.end, start, end, bridges, guards, lowerGuard }
    before = await page.screenshot({ scale: 'css', animations: 'disabled' })
    expect(bridges.length).toBe(3)
    for (const bridge of bridges) for (const id of bridge.sourcePartIds) expect(selectedIds).toContain(id)
    for (const point of [start, end]) {
      expect(point.x, '固定公式点不得触发36px边缘自动滚动').toBeGreaterThan(prepared.reader.x + 36)
      expect(point.x).toBeLessThan(prepared.reader.x + prepared.reader.width - 36)
      expect(point.y).toBeGreaterThan(prepared.reader.y + 36)
      expect(point.y).toBeLessThan(prepared.reader.y + prepared.reader.height - 36)
    }
    for (const window of [...bridges, ...guards]) {
      expect(window.client.x, window.id + ':像素窗须完整可见').toBeGreaterThanOrEqual(prepared.reader.x + 1)
      expect(window.client.y).toBeGreaterThanOrEqual(prepared.reader.y + 1)
      expect(window.client.x + window.client.width).toBeLessThanOrEqual(prepared.reader.x + prepared.reader.width - 1)
      expect(window.client.y + window.client.height).toBeLessThanOrEqual(prepared.reader.y + prepared.reader.height - 1)
    }
    expect(prepared.hasFocus).toBe(true)
    await page.mouse.move(start.x, start.y)
    before = await page.screenshot({ scale: 'css', animations: 'disabled' })
    await page.mouse.down(); held = true
    phases.push({ phase: 'mousedown', pointer: start, geometry: await frame(page), selection: await snapshot(page) })
    await page.mouse.move(end.x, end.y, { steps: 32 })
    phases.push({ phase: 'mousemove', pointer: end, geometry: await frame(page), selection: await snapshot(page) })
    await page.mouse.up(); held = false
    await settled(page)
    after = await page.screenshot({ scale: 'css', animations: 'disabled' })
    const selected = await snapshot(page), finished = await frame(page)
    phases.push({ phase: 'mouseup', pointer: end, geometry: finished, selection: selected })
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), 'math-formula-only-copy-sentinel-' + percent)
    await page.keyboard.press('Control+C')
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
    evidence.clipboard = clipboard
    evidence.lowerRowState = {
      rows: lowerRows, guard: lowerGuard,
      measurements: selected.measuredParts.filter(part => lowerIds.includes(part.id)),
      domTextPresent: lowerRows.map(row => ({ id: row.id, present: canonical(selected.stream).includes(canonical(row.text)) })),
      selectionContainsLower: lowerRows.map(row => ({ id: row.id, contains: canonical(selected.text).includes(canonical(row.text)) })),
      clipboardContainsLower: lowerRows.map(row => ({ id: row.id, contains: canonical(clipboard).includes(canonical(row.text)) }))
    }
    stage = 'selection-content'
    expect(canonical(selected.text), '真实Selection仅含完整公式').toBe(canonical(manifest.formula.expectedText))
    expect(canonical(clipboard), '真实Ctrl+C仅含完整公式').toBe(canonical(manifest.formula.expectedText))
    for (const row of lowerRows) {
      expect(canonical(selected.text), '下一行不得进入Selection').not.toContain(canonical(row.text))
      expect(canonical(clipboard), '下一行不得进入Clipboard').not.toContain(canonical(row.text))
    }
    expect(selected.anchor.page).toBe(String(manifest.formula.pageNumber))
    expect(selected.focus.page).toBe(String(manifest.formula.pageNumber))
    evidence.contentVerified = true
    stage = 'script-precondition'
    expect(finished.hasFocus).toBe(prepared.hasFocus)
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(finished.canvas[key] - prepared.canvas[key])).toBeLessThanOrEqual(criteria.maximumGeometryDriftCss)
      expect(Math.abs(finished.reader[key] - prepared.reader[key])).toBeLessThanOrEqual(criteria.maximumGeometryDriftCss)
    }
    for (const key of ['scrollTop', 'scrollLeft'] as const) expect(Math.abs(finished[key] - prepared[key])).toBeLessThanOrEqual(criteria.maximumGeometryDriftCss)
    const selectedParts = selected.measuredParts.filter(part => selectedIds.includes(part.id))
    expect(selectedParts.length).toBe(selectedIds.length)
    for (const part of selectedParts) expect(part.found && part.fullySelected && part.rects.length > 0, part.id + ':公式glyph须完整选中').toBe(true)
    for (const row of lowerRows) expect(canonical(selected.stream), '未选下行DOM正文仍须存在').toContain(canonical(row.text))
    const lowerMeasurements = selected.measuredParts.filter(part => lowerIds.includes(part.id))
    expect(lowerMeasurements.length).toBe(lowerIds.length)
    for (const part of lowerMeasurements) {
      expect(part.found, part.id + ':snapshot只在实际Selection内找part，下行found=false属预期').toBe(false)
      expect(part.fullySelected).toBe(false)
    }
    // 原reference中的下行body此处未选，严格只取公式尾部普通正文作颜色参考。
    const referenceIds = manifest.reference.bodyPartIds.filter(id => selectedIds.includes(id))
    expect(referenceIds).toEqual([tail.id])
    const referenceRects = selectedParts.filter(part => referenceIds.includes(part.id)).flatMap(part => part.rects)
    evidence.referencePartIds = referenceIds
    const bounds = (rects: Rect[]): Rect => ({ x: Math.min(...rects.map(rect => rect.x)), y: Math.min(...rects.map(rect => rect.y)), width: Math.max(...rects.map(rect => rect.x + rect.width)) - Math.min(...rects.map(rect => rect.x)), height: Math.max(...rects.map(rect => rect.y + rect.height)) - Math.min(...rects.map(rect => rect.y)) })
    evidence.bridgeGeometry = bridges.map(bridge => {
      const sources = bridge.sourcePartIds.map(id => ({ id, bounds: bounds(selectedParts.find(part => part.id === id)!.rects) }))
      const [a, b] = sources.map(source => source.bounds)
      return { id: bridge.id, kind: bridge.kind, sources, gapCss: b.x - a.x - a.width, windowWidthCss: bridge.client.width, windowHeightCss: bridge.client.height }
    })
    const measured = await pixelEvidence(page, before, after, referenceRects, bridges, guards, selectedParts)
    evidence.pixels = measured
    evidence.scope = 'Formula-only at declared CSS zoom, DPR1. Reference is selected formula-tail only; ordinary tail-column lower-row guard is outside the large operator. No vertical bridge is required or inferred for this single-row selection.'
    expect(measured.beforeSize).toEqual(prepared.viewport)
    expect(measured.afterSize).toEqual(measured.beforeSize)
    expect(measured.reference.samples).toBeGreaterThanOrEqual(criteria.referenceMinimumSamples)
    expect(measured.reference.tintedSamples).toBeGreaterThanOrEqual(criteria.referenceMinimumSamples)
    expect(measured.reference.tintedFraction).toBeGreaterThanOrEqual(criteria.referenceMinimumTintedFraction)
    expect(measured.reference.blueBias!).toBeGreaterThanOrEqual(criteria.referenceMinimumBlueBias)
    for (const window of measured.bridges) {
      expect(window.samples, window.id + ':连接窗样本不足').toBeGreaterThanOrEqual(criteria.minimumWindowSamples)
      expect(window.columns.length).toBeGreaterThanOrEqual(criteria.minimumWindowColumns)
      expect(window.rows.length).toBeGreaterThanOrEqual(criteria.minimumWindowRows)
    }
    for (const guard of measured.guards) expect(guard.samples, guard.id + ':守卫样本不足').toBeGreaterThanOrEqual(criteria.minimumGuardSamples)
    for (const glyph of measured.glyphs) expect(glyph.samples, glyph.id + ':真实glyph ink不足').toBeGreaterThanOrEqual(criteria.inkMinimumSamples)
    evidence.samplingPrerequisitesVerified = true
    stage = 'product-selection-shape'
    for (const window of measured.bridges) {
      expect(window.blueFraction!, window.id + ':同一完整公式内短横空档应连蓝').toBeGreaterThanOrEqual(criteria.minimumBridgeBlueFraction)
      expect(window.minimumColumnBlueFraction!).toBeGreaterThanOrEqual(criteria.minimumAxisBlueFraction)
      expect(window.minimumRowBlueFraction!).toBeGreaterThanOrEqual(criteria.minimumAxisBlueFraction)
    }
    for (const guard of measured.guards) expect(guard.whiteFractionAfter!, guard.id + ':未选下行/公式末尾/远处宽缝应保持白底').toBeGreaterThanOrEqual(criteria.minimumGuardWhiteFraction)
    for (const glyph of measured.glyphs) expect(glyph.preservedInkFraction!, glyph.id + ':公式及上下标真实ink须保留').toBeGreaterThanOrEqual(criteria.minimumPreservedInkFraction)
  } catch (error) {
    evidence.failure = { category: stage, message: error instanceof Error ? error.message : String(error) }
    throw error
  } finally {
    if (held) await page.mouse.up().catch(() => {})
    try {
      if (before) await info.attach('math-formula-only-before', { body: before, contentType: 'image/png' })
      after ??= await page.screenshot({ scale: 'css', animations: 'disabled' }).catch(() => undefined)
      if (after) await info.attach('math-formula-only-after', { body: after, contentType: 'image/png' })
      evidence.finalSelection = await snapshot(page).catch(() => null)
      evidence.finalGeometry = await frame(page).catch(() => null)
      await info.attach('math-formula-only-observations', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' })
    } finally { await app.close() }
  }
}

for (const percent of [100, 150] as const) {
  test('PFV math formula-only has continuous blue and leaves lower row unselected at ' + percent + 'pct DPR1', async () => {
    await runFormulaOnly(percent)
  })
}