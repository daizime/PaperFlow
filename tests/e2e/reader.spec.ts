import { test, expect, type Page } from '@playwright/test'
import { createTestData, importFixture, launchApp } from './helpers'
async function waitForPage(page: Page, number: number): Promise<void> {
  await expect(page.locator('.pdf-page[data-page-number="' + number + '"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
}
test('T03 真实多页Canvas、Worker、文字选取复制、缩放与关闭恢复', async () => {
  const data = await createTestData()
  let running = await launchApp(data)
  const failures: string[] = []
  running.page.on('pageerror', error => failures.push(error.message))
  running.page.on('console', message => { if (/fake worker/i.test(message.text())) failures.push(message.text()) })
  try {
    const { app, page } = running
    await importFixture(app, page, 'valid.pdf')
    await page.getByRole('button', { name: '切换文献库侧边栏', exact: true }).click()
    await waitForPage(page, 1)
    await page.getByRole('button', { name: '适合宽度', exact: true }).click()
    await waitForPage(page, 1)
    await expect(page.locator('.pdf-page')).toHaveCount(3)
    expect(page.workers().some(worker => /pdf.worker.*\.mjs/.test(worker.url()) && worker.url().startsWith('app://bundle/'))).toBe(true)
    await expect.poll(() => page.locator('.pdf-page canvas').count()).toBeLessThan(3)
    const pixels = await page.locator('.pdf-page[data-page-number="1"] canvas').evaluate(canvas => {
      const element = canvas as HTMLCanvasElement
      const context = element.getContext('2d')!
      const image = context.getImageData(0, 0, element.width, element.height).data
      let ink = 0
      for (let index = 0; index < image.length; index += 64) if (image[index] < 180 && image[index + 3] > 0) ink++
      return { ink, width: element.width, cssWidth: element.getBoundingClientRect().width, dpr: devicePixelRatio }
    })
    expect(pixels.ink).toBeGreaterThan(100)
    expect(pixels.width / pixels.cssWidth).toBeGreaterThanOrEqual(Math.max(2, Math.min(pixels.dpr, 2)) - 0.05)
    const text = page.locator('.pdf-page[data-page-number="1"] .textLayer span').filter({ hasText: 'Selectable text on page 1' }).first()
    await expect(text).toHaveCount(1)
    await text.scrollIntoViewIfNeeded()
    const box = (await text.boundingBox())!
    await page.mouse.move(box.x + 1, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 20 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim() ?? '')).toContain('Selectable')
    await page.keyboard.press('Control+C')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Selectable')
    const originalZoom = await page.getByTestId('zoom-level').innerText()
    await page.getByRole('button', { name: '放大', exact: true }).click()
    await expect(page.getByTestId('zoom-level')).not.toHaveText(originalZoom)
    await waitForPage(page, 1)
    const alignment = await page.locator('.pdf-page[data-page-number="1"]').evaluate(element => {
      const canvas = element.querySelector('canvas')!.getBoundingClientRect()
      const text = element.querySelector('.textLayer')!.getBoundingClientRect()
      return { x: Math.abs(canvas.x-text.x), y: Math.abs(canvas.y-text.y), width: Math.abs(canvas.width-text.width), height: Math.abs(canvas.height-text.height) }
    })
    for (const distance of Object.values(alignment)) expect(distance).toBeLessThan(2)
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2')
    await waitForPage(page, 2)
    await page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '双栏', exact: true }).click()
    await expect(page.locator('.translation-page[data-page-number="2"]')).toHaveAttribute('data-analyzed', 'true', {
      timeout: 30000
    })
    const scrollBox = (await page.getByLabel('PDF 阅读区域', { exact: true }).boundingBox())!
    await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2)
    await page.mouse.wheel(0, scrollBox.height * 3)
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('3')
    await expect.poll(async () => {
      const positions = await page.evaluate(() => ({
        left: document.querySelector('.pdf-scroll')?.scrollTop ?? -1,
        right: document.querySelector('.translation-scroll')?.scrollTop ?? -1
      }))
      return positions.right > 100 ? Math.abs(positions.left - positions.right) : 999
    }).toBeLessThanOrEqual(2)
    await page.getByRole('spinbutton', { name: '当前页码' }).fill('3')
    await page.getByRole('spinbutton', { name: '当前页码' }).press('Enter')
    await waitForPage(page, 3)
    const expectedZoom = await page.getByTestId('zoom-level').innerText()
    // 不等待450ms防抖；窗口关闭握手必须刷新最后状态。
    await app.close()
    running = await launchApp(data)
    await expect(running.page.locator('.document-item')).toHaveCount(1)
    await expect(running.page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('3')
    await expect(running.page.getByTestId('zoom-level')).toHaveText(expectedZoom)
    await waitForPage(running.page, 3)
    expect(failures).toEqual([])
  } finally { await running.app.close() }
})
test('T03 快速缩放切换与扫描页提示', async () => {
  const { app, page } = await launchApp(await createTestData())
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  try {
    await importFixture(app, page, 'same-name-a/paper.pdf')
    await waitForPage(page, 1)
    await importFixture(app, page, 'same-name-b/paper.pdf')
    await waitForPage(page, 1)
    for (let index = 0; index < 8; index++) {
      await page.getByRole('button', { name: index % 2 ? '缩小' : '放大', exact: true }).click()
      await page.locator('.library-tree-doc-btn').nth(index % 2).click()
    }
    await waitForPage(page, 1)
    await importFixture(app, page, 'scanned.pdf')
    await waitForPage(page, 1)
    await expect(page.getByRole('status').filter({ hasText: '暂不支持 OCR' })).toBeVisible()
    expect(failures).toEqual([])
  } finally { await app.close() }
})
