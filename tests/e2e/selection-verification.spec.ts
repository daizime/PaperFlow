import { test, expect, type Page, type ElectronApplication, type TestInfo } from '@playwright/test'
import { createTestData, importFixture, launchApp } from './helpers'
import manifest from '../fixtures/verification/selection/manifest.json'

interface FixturePoint { x: number; y: number; space?: string }
interface FixtureGesture { id: string; group: string; description: string; points: FixturePoint[]; expected: string; mode?: string; diagnosticOnly?: boolean; pages?: number[]; steps?: number }
type ClientPoint = { x: number; y: number }
const compact = (value: string): string => value.replace(/\s/g, '')
const variants = [
  { id: 'page1-100pct-dpr1', number: 1, percent: 100, dpr: 1 },
  { id: 'page1-200pct-dpr2', number: 1, percent: 200, dpr: 2 },
  { id: 'page2-rot90-100pct-dpr1', number: 2, percent: 100, dpr: 1 },
  { id: 'page2-rot90-100pct-dpr3', number: 2, percent: 100, dpr: 3 }
]

async function frame(page: Page, number: number) {
  return page.locator(`.pdf-page[data-page-number="${number}"] canvas`).evaluate(canvas => {
    const element = canvas as HTMLCanvasElement
    const box = canvas.getBoundingClientRect()
    const root = canvas.closest('.pdf-scroll')!
    const reader = root.getBoundingClientRect()
    return { canvas: { x: box.x, y: box.y, width: box.width, height: box.height, pixelsX: element.width, pixelsY: element.height },
      reader: { x: reader.x + root.clientLeft, y: reader.y + root.clientTop, width: root.clientWidth, height: root.clientHeight }, scrollTop: root.scrollTop, scrollLeft: root.scrollLeft, dpr: devicePixelRatio }
  })
}

/** 独立的PDF直角旋转映射；输入只有素材坐标和Canvas CSS框，不读TextLayer位置。 */
function toClient(number: number, point: { x: number; y: number; space?: string }, dimensions: Awaited<ReturnType<typeof frame>>, previous?: ClientPoint): ClientPoint {
  if (point.space === 'reader-gray') return { x: dimensions.reader.x + point.x, y: dimensions.reader.y + point.y }
  if (point.space === 'left-gray') return { x: dimensions.reader.x + point.x, y: previous!.y }
  const specification = manifest.pages.find(value => value.number === number)!
  const [x0, y0, x1, y1] = specification.view
  const u = (point.x - x0) / (x1 - x0)
  const v = (point.y - y0) / (y1 - y0)
  const normalized = specification.rotation === 0 ? { x: u, y: 1 - v }
    : specification.rotation === 90 ? { x: v, y: u }
      : specification.rotation === 180 ? { x: 1 - u, y: v } : { x: 1 - v, y: 1 - u }
  return { x: dimensions.canvas.x + normalized.x * dimensions.canvas.width, y: dimensions.canvas.y + normalized.y * dimensions.canvas.height }
}

async function selectionSnapshot(page: Page, pointer: ClientPoint | null) {
  return page.evaluate(pointer => {
    const selection = window.getSelection()
    const nodeData = (node: Node | null) => ({ type: node?.nodeName ?? null, text: node?.textContent?.slice(0, 1000) ?? null,
      page: node?.parentElement?.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber ?? null })
    const rects = []
    for (let index = 0; selection && index < selection.rangeCount; index++) {
      for (const rect of selection.getRangeAt(index).getClientRects()) rects.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
    const hit = pointer ? document.elementFromPoint(pointer.x, pointer.y) : null
    return { text: selection?.toString() ?? '', anchor: nodeData(selection?.anchorNode ?? null), focus: nodeData(selection?.focusNode ?? null), anchorOffset: selection?.anchorOffset ?? null, focusOffset: selection?.focusOffset ?? null, rects,
      hit: { tag: hit?.tagName ?? null, className: hit?.getAttribute('class') ?? null, text: hit?.textContent?.slice(0, 150) ?? null } }
  }, pointer)
}

async function preparePoints(page: Page, number: number, gesture: FixtureGesture) {
  let dimensions = await frame(page, number)
  const pdfPoints = gesture.points.filter(point => !point.space)
  // 仅拖拽前将已知Canvas区域移到可见客户区；不在手势中或断言失败后纠正。
  if (pdfPoints.length) {
    const points = pdfPoints.map(point => toClient(number, point, dimensions))
    const middle = { x: (Math.min(...points.map(point => point.x)) + Math.max(...points.map(point => point.x))) / 2,
      y: (Math.min(...points.map(point => point.y)) + Math.max(...points.map(point => point.y))) / 2 }
    await page.getByLabel('PDF 阅读区域', { exact: true }).evaluate((root, delta) => {
      root.scrollTop += delta.y
      root.scrollLeft += delta.x
    }, { x: middle.x - dimensions.reader.x - dimensions.reader.width / 2, y: middle.y - dimensions.reader.y - dimensions.reader.height / 2 })
  }
  if (gesture.points.some(point => point.space)) await page.getByLabel('PDF 阅读区域', { exact: true }).evaluate(root => { root.scrollLeft = 0 })
  await expect(page.locator(`.pdf-page[data-page-number="${number}"]`)).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
  dimensions = await frame(page, number)
  const points: ClientPoint[] = []
  for (const point of gesture.points) points.push(toClient(number, point, dimensions, points.at(-1)))
  for (const point of points) {
    expect(point.x).toBeGreaterThan(dimensions.reader.x + 1)
    expect(point.x).toBeLessThan(dimensions.reader.x + dimensions.reader.width - 1)
    expect(point.y).toBeGreaterThan(dimensions.reader.y + 1)
    expect(point.y).toBeLessThan(dimensions.reader.y + dimensions.reader.height - 1)
  }
  if (gesture.points.some(point => point.space)) expect(dimensions.reader.x + 8).toBeLessThan(dimensions.canvas.x)
  return { dimensions, points }
}

async function perform(app: ElectronApplication, page: Page, info: TestInfo, number: number, gesture: FixtureGesture, observations: unknown[]): Promise<void> {
  const setup = await preparePoints(page, number, gesture)
  const record = { id: gesture.id, description: gesture.description, expected: gesture.expected, pdfPoints: gesture.points, setup, phases: [] as unknown[], clipboard: '' }
  observations.push(record)
  const sentinel = 'paperflow-copy-sentinel-' + gesture.id
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), sentinel)
  await info.attach(gesture.id + '-before', { body: await page.screenshot({ scale: 'css', animations: 'disabled' }), contentType: 'image/png' })
  if (gesture.mode === 'double-click') {
    await page.mouse.dblclick(setup.points[0].x, setup.points[0].y)
  } else {
    await page.mouse.move(setup.points[0].x, setup.points[0].y)
    await page.mouse.down()
    try {
      record.phases.push({ phase: 'mousedown', pointer: setup.points[0], ...(await selectionSnapshot(page, setup.points[0])) })
      for (const point of setup.points.slice(1)) {
        await page.mouse.move(point.x, point.y, { steps: gesture.steps ?? 24 })
        record.phases.push({ phase: 'mousemove', pointer: point, ...(await selectionSnapshot(page, point)) })
      }
    } finally { await page.mouse.up() }
  }
  const selected = await selectionSnapshot(page, setup.points.at(-1)!)
  record.phases.push({ phase: 'mouseup', ...selected })
  await page.keyboard.press('Control+C')
  record.clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
  await info.attach(gesture.id + '-after', { body: await page.screenshot({ scale: 'css', animations: 'disabled' }), contentType: 'image/png' })
  if (gesture.diagnosticOnly) return
  expect(compact(selected.text), gesture.id + ':精确目标，不删除任何干扰字符').toBe(compact(gesture.expected))
  if (gesture.expected) expect(compact(record.clipboard), gesture.id + ':实际Ctrl+C').toBe(compact(gesture.expected))
  else {
    expect(selected.text, gesture.id + ':必须是真实空选区').toBe('')
    expect(['', sentinel], gesture.id + ':空选区只允许空剪贴板或原哨兵，不接受正文').toContain(record.clipboard)
  }
  const forbidden = manifest.runs.filter(run => (run.text.includes('OTHER') || run.id.startsWith('remote-')) && !gesture.expected.includes(run.text))
  for (const run of forbidden) expect(selected.text).not.toContain(run.text)
}

for (const variant of variants) {
  for (const group of ['blank', 'text', 'formula', 'fraction', 'recovery']) {
    test(`PFV selection ${group} ${variant.id}`, async () => {
      const info = test.info()
      const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: variant.dpr })
      const observations: unknown[] = []
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      try {
        await importFixture(app, page, 'verification/selection/' + manifest.file.name)
        await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
        const input = page.getByRole('spinbutton', { name: '当前页码' })
        await input.fill(String(variant.number))
        await input.press('Enter')
        for (let attempts = 0; attempts < 30; attempts++) {
          const percent = Number((await page.getByTestId('zoom-level').innerText()).replace('%', ''))
          if (percent === 50) break
          await page.getByRole('button', { name: '缩小', exact: true }).click()
        }
        await expect(page.getByTestId('zoom-level')).toHaveText('50%')
        for (let step = 0; step < (variant.percent - 50) / 10; step++) await page.getByRole('button', { name: '放大', exact: true }).click()
        await expect(page.getByTestId('zoom-level')).toHaveText(variant.percent + '%')
        const specification = manifest.pages.find(value => value.number === variant.number)!
        const naturalWidth = specification.rotation % 180 === 0 ? specification.view[2] - specification.view[0] : specification.view[3] - specification.view[1]
        await expect.poll(async () => Math.abs((await frame(page, variant.number)).canvas.width - naturalWidth * variant.percent / 100)).toBeLessThan(0.1)
        const gestures = (manifest.gestures as FixtureGesture[]).filter(gesture => gesture.group === group && (!gesture.pages || gesture.pages.includes(variant.number)))
        for (const gesture of gestures) await perform(app, page, info, variant.number, gesture, observations)
        expect(errors).toEqual([])
      } finally {
        try { await info.attach('selection-observations', { body: Buffer.from(JSON.stringify({ fixture: manifest.file, variant, group, observations, errors, final: await selectionSnapshot(page, null).catch(() => null), method: 'Known PDF/reader-gray points -> independent rotation -> Canvas CSS bbox. No TextLayer aiming or programmatic selection reset.' }, null, 2)), contentType: 'application/json' }) }
        finally { await app.close() }
      }
    })
  }
}

// PFV-READER-004 revision8: appended real-interaction checks.
// Original 20 cases and their fixture points/assertions remain the byte-identical prefix.
async function hOpen(percent = 100, dpr = 1) {
  const running = await launchApp(await createTestData(), { deviceScaleFactor: dpr })
  try {
    await importFixture(running.app, running.page, 'verification/selection/' + manifest.file.name)
    await expect(running.page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    for (let attempts = 0; attempts < 30; attempts++) {
      if (await running.page.getByTestId('zoom-level').innerText() === '50%') break
      await running.page.getByRole('button', { name: '缩小', exact: true }).click()
    }
    await expect(running.page.getByTestId('zoom-level')).toHaveText('50%')
    for (let step = 0; step < (percent - 50) / 10; step++) await running.page.getByRole('button', { name: '放大', exact: true }).click()
    await expect(running.page.getByTestId('zoom-level')).toHaveText(percent + '%')
    await expect.poll(async () => Math.abs((await frame(running.page, 1)).canvas.width - 600 * percent / 100)).toBeLessThan(0.1)
    await expect(running.page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true')
    return running
  } catch (error) { await running.app.close(); throw error }
}

function hGesture(id: string): FixtureGesture {
  const value = (manifest.gestures as FixtureGesture[]).find(gesture => gesture.id === id)
  if (!value) throw new Error('Missing original synthetic gesture: ' + id)
  return { ...value, id: 'H-' + value.id }
}

async function hAim(page: Page, number: number, points: FixturePoint[], id: string) {
  return preparePoints(page, number, { id, group: 'H', description: 'Known synthetic PDF coordinates', points, expected: '' })
}

async function hObserve(page: Page, durationMs: number) {
  return page.evaluate(async durationMs => {
    const started = performance.now()
    const samples = []
    do {
      const selection = window.getSelection()
      const root = document.querySelector<HTMLElement>('.pdf-scroll')!
      samples.push({
        elapsedMs: performance.now() - started, text: selection?.toString() ?? '',
        anchorText: selection?.anchorNode?.textContent ?? null, focusText: selection?.focusNode?.textContent ?? null,
        anchorOffset: selection?.anchorOffset ?? null, focusOffset: selection?.focusOffset ?? null,
        anchorPage: selection?.anchorNode?.parentElement?.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber ?? null,
        focusPage: selection?.focusNode?.parentElement?.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber ?? null,
        scrollTop: root.scrollTop, scrollLeft: root.scrollLeft,
        maxScrollTop: Math.max(0, root.scrollHeight - root.clientHeight),
        canvasPages: Array.from(root.querySelectorAll<HTMLElement>('.pdf-page[data-rendered="true"]')).map(element => element.dataset.pageNumber)
      })
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    } while (performance.now() - started < durationMs)
    return samples
  }, durationMs)
}

async function hCopy(app: ElectronApplication, page: Page, expected: string, id: string) {
  const selected = await selectionSnapshot(page, null)
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), 'H-copy-sentinel-' + id)
  await page.keyboard.press('Control+C')
  const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(compact(selected.text), id + ': authored character sequence').toBe(compact(expected))
  expect(compact(clipboard), id + ': real Ctrl+C').toBe(compact(expected))
  return { selected, clipboard }
}

async function hFinish(app: ElectronApplication, page: Page, info: TestInfo, evidence: unknown) {
  try {
    await info.attach('H-interaction-observations', { body: Buffer.from(JSON.stringify({
      fixture: manifest.file, evidence, final: await selectionSnapshot(page, null).catch(() => null),
      method: 'Real pointer/keyboard input. Aiming uses original PDF coordinates and Canvas CSS geometry only; no programmatic DOM Selection mutation.'
    }, null, 2)), contentType: 'application/json' })
    await info.attach('H-final', { body: await page.screenshot({ scale: 'css', animations: 'disabled' }), contentType: 'image/png' })
  } finally { await app.close() }
}

async function hStartEdge(page: Page, info: TestInfo, evidence: unknown[]) {
  const source = hGesture('right-to-margin').points[0]
  await hAim(page, 1, [source], 'H-edge-origin')
  await expect(page.locator('.pdf-page[data-page-number="2"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
  const first = await frame(page, 1)
  const second = await frame(page, 2)
  const start = toClient(1, source, first)
  // On the rotated adjacent page the two alpha rows share this known PDF-y lane.
  const edge = { x: toClient(2, { x: 48.4, y: 705 }, second).x, y: first.reader.y + first.reader.height - 8 }
  expect(start.x).toBeGreaterThan(first.reader.x + 1)
  expect(start.y).toBeGreaterThan(first.reader.y + 1)
  expect(edge.x).toBeGreaterThan(first.reader.x + 36)
  expect(edge.x).toBeLessThan(first.reader.x + first.reader.width - 36)
  expect(edge.y).toBeLessThan(first.reader.y + first.reader.height - 1)
  await info.attach('H-edge-before', { body: await page.screenshot({ scale: 'css', animations: 'disabled' }), contentType: 'image/png' })
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  evidence.push({ phase: 'edge-down', start, edge, first, second, selection: await selectionSnapshot(page, start) })
  await page.mouse.move(edge.x, edge.y, { steps: 1 })
  evidence.push({ phase: 'edge-arrival', pointer: edge, selection: await selectionSnapshot(page, edge), samples: await hObserve(page, 0) })
  return { start, edge, beforeScrollTop: first.scrollTop }
}

test('PFV H ordinary mouseup endpoints remain stable and copy at 200pct DPR2', async () => {
  const info = test.info()
  const { app, page } = await hOpen(200, 2)
  const evidence: unknown[] = []
  try {
    await perform(app, page, info, 1, hGesture('text-to-reader-gray'), evidence)
    const initial = await selectionSnapshot(page, null)
    const stable = await hObserve(page, 400)
    evidence.push({ phase: 'post-mouseup-passive', initial, stable })
    expect(stable.length).toBeGreaterThan(1)
    for (const sample of stable) {
      expect(compact(sample.text)).toBe('DOUBLECHECK')
      expect(sample.anchorOffset).toBe(initial.anchorOffset)
      expect(sample.focusOffset).toBe(initial.focusOffset)
      expect(sample.anchorText).toBe(initial.anchor.text)
      expect(sample.focusText).toBe(initial.focus.text)
    }
    evidence.push({ phase: 'stable-copy', ...await hCopy(app, page, 'DOUBLECHECK', 'stable-mouseup') })
  } finally { await hFinish(app, page, info, evidence) }
})

test('PFV H native double triple and Shift selection remain usable', async () => {
  const info = test.info()
  const { app, page } = await hOpen()
  const evidence: unknown[] = []
  try {
    const double = await hAim(page, 1, [{ x: 348.6, y: 612 }], 'H-double')
    await info.attach('H-native-before', { body: await page.screenshot({ scale: 'css', animations: 'disabled' }), contentType: 'image/png' })
    await page.mouse.dblclick(double.points[0].x, double.points[0].y)
    evidence.push({ phase: 'native-double', setup: double, ...await hCopy(app, page, 'RESETWORD', 'native-double') })
    const triple = await hAim(page, 1, [{ x: 129, y: 748 }], 'H-triple-heading')
    await page.mouse.click(triple.points[0].x, triple.points[0].y, { clickCount: 3 })
    const heading = manifest.runs.find(run => run.id === 'heading')!.text
    evidence.push({ phase: 'native-triple-isolated-line', setup: triple, ...await hCopy(app, page, heading, 'native-triple') })
    const shift = await hAim(page, 1, [{ x: 48.4, y: 612 }, { x: 166.4, y: 612 }], 'H-native-shift')
    await page.mouse.click(shift.points[0].x, shift.points[0].y, { clickCount: 1 })
    await page.keyboard.down('Shift')
    try { await page.mouse.click(shift.points[1].x, shift.points[1].y, { clickCount: 1 }) }
    finally { await page.keyboard.up('Shift') }
    evidence.push({ phase: 'native-shift-click', setup: shift, ...await hCopy(app, page, 'DOUBLECHECK', 'native-shift') })
  } finally { await hFinish(app, page, info, evidence) }
})

test('PFV H stationary edge drag updates from latest viewport into adjacent page', async () => {
  const info = test.info()
  const { app, page } = await hOpen()
  const evidence: unknown[] = []
  let held = false
  try {
    const setup = await hStartEdge(page, info, evidence)
    held = true
    const root = page.getByLabel('PDF 阅读区域', { exact: true })
    const atArrival = await selectionSnapshot(page, setup.edge)
    // No more mouse moves until release: every later endpoint must follow scrolling geometry.
    await expect.poll(() => root.evaluate(element => element.scrollTop)).toBeGreaterThan(setup.beforeScrollTop + 100)
    await expect.poll(async () => (await selectionSnapshot(page, setup.edge)).focus.page).toBe('2')
    evidence.push({ phase: 'stationary-reached-neighbor', atArrival, selection: await selectionSnapshot(page, setup.edge), samples: await hObserve(page, 0), frames: [await frame(page, 1), await frame(page, 2)] })
    await expect.poll(() => root.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
    const selected = await selectionSnapshot(page, setup.edge)
    evidence.push({ phase: 'stationary-at-end', selection: selected, samples: await hObserve(page, 0) })
    expect(selected.anchor.page).toBe('1')
    expect(selected.focus.page).toBe('2')
    expect(selected.focus.text).toBe('RIGHT_ALPHA_OTHER_12345678')
    expect(selected.focusOffset).toBe(26)
    const rightIndex = manifest.runs.findIndex(run => run.id === 'right-alpha')
    const expected = manifest.runs.slice(rightIndex).map(run => run.text).join('') + manifest.runs.slice(0, rightIndex + 1).map(run => run.text).join('')
    await page.mouse.up()
    held = false
    evidence.push({ phase: 'adjacent-page-copy', ...await hCopy(app, page, expected, 'adjacent-page') })
  } finally {
    if (held) await page.mouse.up().catch(() => {})
    await hFinish(app, page, info, evidence)
  }
})

test('PFV H mouseup and Escape stop edge scrolling before the boundary', async () => {
  const info = test.info()
  const { app, page } = await hOpen()
  const evidence: unknown[] = []
  let held = false
  try {
    for (const release of ['mouseup', 'Escape'] as const) {
      const setup = await hStartEdge(page, info, evidence)
      held = true
      const root = page.getByLabel('PDF 阅读区域', { exact: true })
      await expect.poll(() => root.evaluate(element => element.scrollTop)).toBeGreaterThan(setup.beforeScrollTop + 40)
      if (release === 'mouseup') { await page.mouse.up(); held = false }
      else await page.keyboard.press('Escape')
      const stopped = await root.evaluate(element => ({ top: element.scrollTop, remaining: element.scrollHeight - element.clientHeight - element.scrollTop }))
      expect(stopped.remaining, 'stop must be tested while scrolling still has room').toBeGreaterThan(40)
      const samples = await hObserve(page, 400)
      evidence.push({ phase: 'edge-stop-' + release, setup, stopped, samples, selection: await selectionSnapshot(page, setup.edge) })
      expect(samples.length).toBeGreaterThan(1)
      for (const sample of samples) expect(Math.abs(sample.scrollTop - stopped.top)).toBeLessThanOrEqual(1)
      if (held) { await page.mouse.up(); held = false }
    }
  } finally {
    if (held) await page.mouse.up().catch(() => {})
    await hFinish(app, page, info, evidence)
  }
})

test('PFV H unchanged focused page input permits one direct PDF drag', async () => {
  const info = test.info()
  const { app, page } = await hOpen()
  const evidence: unknown[] = []
  try {
    const input = page.getByRole('spinbutton', { name: '当前页码' })
    await expect(input).toHaveValue('1')
    await input.click()
    await expect(input).toBeFocused()
    evidence.push({ phase: 'unchanged-page-input-focused', selection: await selectionSnapshot(page, null) })
    await perform(app, page, info, 1, hGesture('normal-after-mouseup'), evidence)
    await expect(input).toHaveValue('1')
    evidence.push({ phase: 'direct-drag-copy', ...await hCopy(app, page, 'DOUBLECHECK', 'unchanged-input') })
  } finally { await hFinish(app, page, info, evidence) }
})

test('PFV H changed page draft commits navigation and cancels stale-coordinate drag', async () => {
  const info = test.info()
  const { app, page } = await hOpen()
  const evidence: unknown[] = []
  let held = false
  try {
    const setup = await hAim(page, 1, [{ x: 48.4, y: 612 }, { x: 166.4, y: 612 }], 'H-before-page-draft')
    const input = page.getByRole('spinbutton', { name: '当前页码' })
    await input.fill('2')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('2')
    await info.attach('H-draft-before', { body: await page.screenshot({ scale: 'css', animations: 'disabled' }), contentType: 'image/png' })
    evidence.push({ phase: 'uncommitted-other-page', setup, firstFrame: await frame(page, 1) })
    await page.mouse.move(setup.points[0].x, setup.points[0].y)
    await page.mouse.down()
    held = true
    evidence.push({ phase: 'draft-blur-mousedown', selection: await selectionSnapshot(page, setup.points[0]) })
    await page.mouse.move(setup.points[1].x, setup.points[1].y, { steps: 12 })
    await page.mouse.up()
    held = false
    await expect(input).toHaveValue('2')
    await expect(page.locator('.pdf-page[data-page-number="2"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    const dimensions = await frame(page, 2)
    expect(dimensions.canvas.y).toBeGreaterThanOrEqual(dimensions.reader.y - 1)
    expect(dimensions.canvas.y).toBeLessThan(dimensions.reader.y + dimensions.reader.height)
    const selected = await selectionSnapshot(page, null)
    expect(selected.text).toBe('')
    const sentinel = 'H-draft-navigation-empty'
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), sentinel)
    await page.keyboard.press('Control+C')
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(['', sentinel]).toContain(clipboard)
    evidence.push({ phase: 'navigation-preserved-empty-copy', dimensions, selected, clipboard })
  } finally {
    if (held) await page.mouse.up().catch(() => {})
    await hFinish(app, page, info, evidence)
  }
})