import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { createTestData, importFixture, launchApp } from './helpers'
import manifest from '../fixtures/verification/reader/manifest.json'

const fixture = (name: string): string => 'verification/reader/' + name
async function waitForPage(page: Page, number: number): Promise<void> {
  await expect(page.locator(`.pdf-page[data-page-number="${number}"]`)).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
}
async function navigate(page: Page, number: number): Promise<void> {
  const input = page.getByRole('spinbutton', { name: '当前页码' })
  await input.fill(String(number))
  await input.press('Enter')
  await expect(input).toHaveValue(String(number))
  await waitForPage(page, number)
}
async function attach(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' })
}
function observeFailures(page: Page): string[] {
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  page.on('console', message => { if (/fake worker/i.test(message.text())) failures.push(message.text()) })
  return failures
}
async function observeNavigation(page: Page, number: number, durationMs: number) {
  return page.evaluate(async ({ number, durationMs }) => {
    const started = performance.now()
    const observations = []
    do {
      // RO 在 rAF 之后补偿布局；渲染阶段结束后取样，避免把绘制前中间态当作可见漂移。
      await new Promise<void>(resolve => requestAnimationFrame(() => { setTimeout(resolve, 0) }))
      const root = document.querySelector<HTMLElement>('.pdf-scroll')!
      const element = root.querySelector<HTMLElement>(`[data-page-number="${number}"]`)
      const bounds = root.getBoundingClientRect()
      const box = element?.getBoundingClientRect()
      const rootTop = bounds.top + root.clientTop
      const rootLeft = bounds.left + root.clientLeft
      const rootBottom = rootTop + root.clientHeight
      const rootRight = rootLeft + root.clientWidth
      observations.push({
        elapsedMs: performance.now() - started,
        current: document.querySelector<HTMLInputElement>('input[aria-label="当前页码"]')?.value ?? null,
        rendered: element?.dataset.rendered === 'true',
        canvas: !!element?.querySelector('canvas'),
        text: element?.querySelector('.textLayer')?.textContent?.includes('Geometry marker ' + number) ?? false,
        visible: !!box && box.top >= rootTop - 1 && box.top < rootBottom && Math.min(box.right, rootRight) > Math.max(box.left, rootLeft),
        top: box?.top ?? null, bottom: box?.bottom ?? null, rootTop, rootBottom,
        scrollTop: root.scrollTop, scrollLeft: root.scrollLeft
      })
    } while (performance.now() - started < durationMs)
    return observations
  }, { number, durationMs })
}
function expectNavigationStable(observations: Awaited<ReturnType<typeof observeNavigation>>, number: number): void {
  expect(observations.length).toBeGreaterThan(1)
  const firstFailure = observations.find(sample => sample.current !== String(number) || !sample.rendered || !sample.canvas || !sample.text || !sample.visible)
  expect(firstFailure ?? null, '目标页应持续可见、保持当前页且保有真实Canvas和TextLayer').toBeNull()
}

test('PFV encrypted original PDF is rejected without adding a document', async () => {
  const { app, page } = await launchApp(await createTestData())
  const failures = observeFailures(page)
  try {
    const before = await page.locator('.document-item').count()
    await importFixture(app, page, fixture('encrypted-r2.pdf'))
    await expect(page.getByRole('alert').filter({ hasText: '此 PDF 已加密或需要密码' })).toBeVisible()
    await expect(page.locator('.document-item')).toHaveCount(before)
    expect(failures).toEqual([])
  } finally { await app.close() }
})

test('PFV 600-page PDF imports, navigates and releases distant canvases', async () => {
  const testInfo = test.info()
  test.setTimeout(180000)
  const { app, page } = await launchApp(await createTestData())
  const failures = observeFailures(page)
  const samples: unknown[] = []
  let importAndFirstRenderMs: number | null = null
  try {
    const started = performance.now()
    // Product's existing 20-second validator limit is kept unchanged.
    await importFixture(app, page, fixture('long-600.pdf'))
    await waitForPage(page, 1)
    importAndFirstRenderMs = performance.now() - started
    await expect(page.locator('.pdf-page')).toHaveCount(600)
    await expect(page.getByLabel('总页数', { exact: true })).toHaveText('/ 600')
    for (const number of [1, 300, 600, 1]) {
      await navigate(page, number)
      await expect(page.locator(`.pdf-page[data-page-number="${number}"] .textLayer`)).toContainText(`Long document page ${number} of 600`)
      await expect.poll(() => page.locator('.pdf-page canvas').count()).toBeLessThanOrEqual(8)
      const distant = number === 1 ? 600 : 1
      await expect.poll(() => page.locator(`.pdf-page[data-page-number="${distant}"] canvas`).count()).toBe(0)
      samples.push(await page.evaluate(() => ({ canvases: document.querySelectorAll('.pdf-page canvas').length, placeholders: document.querySelectorAll('.pdf-page').length,
        pixels: Array.from(document.querySelectorAll<HTMLCanvasElement>('.pdf-page canvas')).reduce((sum, canvas) => sum + canvas.width * canvas.height, 0) })))
    }
    expect(page.workers().some(worker => /pdf.worker.*\.mjs/.test(worker.url()) && worker.url().startsWith('app://bundle/'))).toBe(true)
    expect(failures).toEqual([])
  } finally {
    try { await attach(testInfo, 'long-document-observations', { importAndFirstRenderMs, samples, failures, limitation: 'Bounds canvas residency only; all 600 placeholder DOM nodes/observers remain. Does not measure process-memory growth or extreme-length hardware performance.' }) }
    finally { await app.close() }
  }
})

test('PFV mixed-size current page fits available reader width', async () => {
  const testInfo = test.info()
  const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
  const failures = observeFailures(page)
  const samples: unknown[] = []
  // Page 1 is 612 units wide; page 13 has an offset CropBox and UserUnit=2.5.
  // Its natural viewport width is 1250 CSS pixels, so these pages need different fits.
  const currentPage = 13
  const root = page.getByLabel('PDF 阅读区域', { exact: true })
  async function measure() {
    return root.evaluate((element, number) => {
      const canvas = element.querySelector<HTMLCanvasElement>(`[data-page-number="${number}"] canvas`)
      const pageElement = element.querySelector<HTMLElement>(`[data-page-number="${number}"]`)
      const pages = element.querySelector<HTMLElement>('.pdf-pages')!
      const style = getComputedStyle(pages)
      const bounds = element.getBoundingClientRect()
      const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
      const paddingRight = Number.parseFloat(style.paddingRight) || 0
      const clientLeft = bounds.left + element.clientLeft
      const box = canvas?.getBoundingClientRect()
      return {
        targetPage: number,
        currentPage: document.querySelector<HTMLInputElement>('input[aria-label="当前页码"]')?.value ?? null,
        zoom: document.querySelector('[data-testid="zoom-level"]')?.textContent ?? null,
        rendered: pageElement?.dataset.rendered === 'true',
        availableWidth: element.clientWidth - paddingLeft - paddingRight,
        availableLeft: clientLeft + paddingLeft,
        availableRight: clientLeft + element.clientWidth - paddingRight,
        canvasWidth: box?.width ?? 0, canvasLeft: box?.left ?? null, canvasRight: box?.right ?? null,
        scrollLeft: element.scrollLeft, paddingLeft, paddingRight
      }
    }, currentPage)
  }
  try {
    await importFixture(app, page, fixture('geometry.pdf'))
    await waitForPage(page, 1)
    await navigate(page, currentPage)
    await expect(page.locator(`.pdf-page[data-page-number="${currentPage}"] .textLayer`)).toContainText('Geometry marker 13')
    const before = await measure()
    samples.push({ phase: 'before-fit', ...before })
    // Verify fitting is possible at the supported minimum zoom; do not derive the expected fit scale.
    expect(before.availableWidth, '阅读区域应能容纳此样本在最低倍率下的页面').toBeGreaterThanOrEqual(625)
    await page.getByRole('button', { name: '适合宽度', exact: true }).click()
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue(String(currentPage))
    await expect.poll(async () => {
      const sample = await measure()
      samples.push({ phase: 'after-fit', ...sample })
      // Test visible bounds directly instead of deriving the expected scale from product code.
      return sample.currentPage === String(currentPage) && sample.rendered && sample.canvasWidth > 0 && sample.canvasWidth <= sample.availableWidth + 1 &&
        sample.canvasLeft !== null && sample.canvasRight !== null &&
        sample.canvasLeft >= sample.availableLeft - 1 && sample.canvasRight <= sample.availableRight + 1
    }, { timeout: 15000, message: '适合宽度后，当前页Canvas应完整落在阅读区域的可用水平范围内' }).toBe(true)
    expect(failures).toEqual([])
  } finally {
    try { await attach(testInfo, 'mixed-size-fit-width-observations', { samples, failures, assertion: 'Current-page Canvas must fit the measured reader client area after actual content padding; one CSS pixel tolerance. No implementation-derived scale formula.' }) }
    finally { await app.close() }
  }
})

test('PFV DPR3 navigation yields to wheel and the latest page request', async () => {
  const testInfo = test.info()
  const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 3 })
  const failures = observeFailures(page)
  const observations: unknown[] = []
  try {
    await importFixture(app, page, fixture('geometry.pdf'))
    await waitForPage(page, 1)
    await navigate(page, 13)
    const initial = await observeNavigation(page, 13, 4000)
    observations.push({ phase: 'initial-navigation', samples: initial })
    expectNavigationStable(initial, 13)
    const root = page.getByLabel('PDF 阅读区域', { exact: true })
    const beforeWheel = await root.evaluate(element => element.scrollTop)
    const bounds = (await root.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.wheel(0, bounds.height * 2)
    await expect.poll(() => root.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeWheel + 50)
    const afterWheel = await observeNavigation(page, 13, 1000)
    observations.push({ phase: 'after-user-wheel', beforeWheel, samples: afterWheel })
    expect(afterWheel.every(sample => sample.scrollTop > beforeWheel + 50), '用户滚动后不应被旧导航拉回').toBe(true)
    expect(afterWheel.every(sample => sample.top !== null && sample.top < sample.rootTop - 20), '目标页应保留用户滚动后的相对位置').toBe(true)
    const input = page.getByRole('spinbutton', { name: '当前页码' })
    await input.fill('14')
    await input.press('Enter')
    await input.fill('16')
    await input.press('Enter')
    await waitForPage(page, 16)
    const latest = await observeNavigation(page, 16, 2000)
    observations.push({ phase: 'latest-navigation', samples: latest })
    expectNavigationStable(latest, 16)
    expect(failures).toEqual([])
  } finally {
    try { await attach(testInfo, 'navigation-cancellation-observations', { observations, failures, final: await observeNavigation(page, 16, 0).catch(() => []) }) }
    finally { await app.close() }
  }
})

for (const dpr of [1, 1.25, 1.5, 2, 3]) {
  test(`PFV rotated CropBox/UserUnit layers and selection at simulated DPR ${dpr}`, async () => {
    const testInfo = test.info()
    test.setTimeout(180000)
    const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: dpr })
    const failures = observeFailures(page)
    const samples: unknown[] = []
    const navigationSamples: unknown[] = []
    try {
      expect(await page.evaluate(() => devicePixelRatio)).toBeCloseTo(dpr, 6)
      await importFixture(app, page, fixture('geometry.pdf'))
      await waitForPage(page, 1)
      // Shifted CropBox and UserUnit=2.5, with each of the four right-angle rotations.
      for (const specification of manifest.geometry.filter(value => value.number >= 13)) {
        await navigate(page, specification.number)
        if (dpr === 3 && specification.number === 13) {
          // 先被动观察重排，禁止让后面的fit或选字辅助滚动纠正导航。
          const observations = await observeNavigation(page, specification.number, 4000)
          navigationSamples.push(...observations)
          expectNavigationStable(observations, specification.number)
        }
        for (const zoom of ['fit', 'larger', 'smaller'] as const) {
          if (zoom === 'fit') await page.getByRole('button', { name: '适合宽度', exact: true }).click()
          else await page.getByRole('button', { name: zoom === 'larger' ? '放大' : '缩小', exact: true }).click()
          const element = page.locator(`.pdf-page[data-page-number="${specification.number}"]`)
          const scale = Number((await page.getByTestId('zoom-level').innerText()).replace('%', '')) / 100
          const cropWidth = specification.view[2] - specification.view[0]
          const cropHeight = specification.view[3] - specification.view[1]
          const sideways = specification.rotation % 180 !== 0
          const expectedWidth = (sideways ? cropHeight : cropWidth) * specification.userUnit * scale
          // A previous render may still have data-rendered=true just after the click.
          await expect.poll(async () => element.locator('canvas').evaluate((canvas, width) => Math.abs(canvas.getBoundingClientRect().width - width), expectedWidth).catch(() => Infinity)).toBeLessThan(0.1)
          await waitForPage(page, specification.number)
          const geometry = await element.evaluate(element => {
            const canvas = element.querySelector('canvas')!
            const box = canvas.getBoundingClientRect()
            const text = element.querySelector('.textLayer')!.getBoundingClientRect()
            return { width: box.width, height: box.height, pixelsX: canvas.width, pixelsY: canvas.height, dpr: devicePixelRatio,
              alignment: [Math.abs(box.x - text.x), Math.abs(box.y - text.y), Math.abs(box.width - text.width), Math.abs(box.height - text.height)] }
          })
          samples.push({ page: specification.number, rotation: specification.rotation, zoom, scale, ...geometry })
          expect(Math.abs(geometry.width - (sideways ? cropHeight : cropWidth) * specification.userUnit * scale)).toBeLessThan(0.1)
          expect(Math.abs(geometry.height - (sideways ? cropWidth : cropHeight) * specification.userUnit * scale)).toBeLessThan(0.1)
          for (const distance of geometry.alignment) expect(distance).toBeLessThan(0.1)
          const expectedRatio = Math.min(dpr, 3, Math.sqrt(8 * 1024 * 1024 / (geometry.width * geometry.height)), 8192 / geometry.width, 8192 / geometry.height)
          expect(Math.abs(geometry.pixelsX / geometry.width - expectedRatio)).toBeLessThan(1 / geometry.width + 0.001)
          expect(Math.abs(geometry.pixelsY / geometry.height - expectedRatio)).toBeLessThan(1 / geometry.height + 0.001)
          expect(geometry.pixelsX * geometry.pixelsY).toBeLessThanOrEqual(8 * 1024 * 1024)
          const text = element.locator('.textLayer span').filter({ hasText: `Geometry marker ${specification.number}` }).first()
          await text.scrollIntoViewIfNeeded()
          await page.evaluate(() => window.getSelection()?.removeAllRanges())
          const box = (await text.boundingBox())!
          const reverse = specification.rotation === 180 || specification.rotation === 270
          const start = sideways ? { x: box.x + box.width / 2, y: box.y + (reverse ? box.height - 1 : 1) }
            : { x: box.x + (reverse ? box.width - 1 : 1), y: box.y + box.height / 2 }
          const end = sideways ? { x: start.x, y: box.y + (reverse ? 1 : box.height - 1) }
            : { x: box.x + (reverse ? 1 : box.width - 1), y: start.y }
          await page.mouse.move(start.x, start.y)
          await page.mouse.down()
          await page.mouse.move(end.x, end.y, { steps: 16 })
          await page.mouse.up()
          await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim() ?? '')).toContain(`Geometry marker ${specification.number}`)
        }
      }
      expect(failures).toEqual([])
    } finally {
      try { await attach(testInfo, 'simulated-dpi-observations', { simulation: 'Electron launch device-scale-factor via shared helper; not a physical monitor or Windows per-monitor DPI transition', samples, navigationSamples, failures }) }
      finally { await app.close() }
    }
  })
}
