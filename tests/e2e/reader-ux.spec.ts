import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import manifest from '../fixtures/verification/reader-ux/manifest.json'
import { createTestData, importFixture, launchApp } from './helpers'

const compact = (value: string): string => value.replace(/\s+/gu, '')

async function waitForPage(page: Page, pageNumber: number): Promise<void> {
  await expect(page.locator(`.pdf-page[data-page-number="${pageNumber}"]`)).toHaveAttribute('data-rendered', 'true', {
    timeout: 30000
  })
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function pageGeometry(page: Page, pageNumber: number) {
  return page.locator(`.pdf-page[data-page-number="${pageNumber}"]`).evaluate(element => {
    const pageBox = element.getBoundingClientRect()
    const canvas = element.querySelector<HTMLCanvasElement>('canvas')!
    const canvasBox = canvas.getBoundingClientRect()
    const root = element.closest<HTMLElement>('.pdf-scroll')!
    const rootBox = root.getBoundingClientRect()
    const pages = root.querySelector<HTMLElement>('.pdf-pages')!
    const style = getComputedStyle(pages)
    const availableWidth =
      root.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
    return {
      page: { x: pageBox.x, y: pageBox.y, width: pageBox.width, height: pageBox.height },
      canvas: { x: canvasBox.x, y: canvasBox.y, width: canvasBox.width, height: canvasBox.height },
      reader: {
        x: rootBox.x + root.clientLeft,
        y: rootBox.y + root.clientTop,
        width: root.clientWidth,
        height: root.clientHeight,
        availableWidth
      }
    }
  })
}

function pdfToClient(
  point: { x: number; y: number },
  canvasBox: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
  const [x0, y0, x1, y1] = manifest.pages[0].view
  const u = (point.x - x0) / (x1 - x0)
  const v = (point.y - y0) / (y1 - y0)
  return {
    x: canvasBox.x + u * canvasBox.width,
    y: canvasBox.y + (1 - v) * canvasBox.height
  }
}

test('reader UX: 目录空态与嵌套跳转、Ctrl+F搜索高亮与跨页、键盘翻页与Ctrl+滚轮缩放、裁剪白边放大与选字复制', async () => {
  const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  page.on('console', message => {
    if (/fake worker/i.test(message.text())) failures.push(message.text())
  })

  let ctrlHeld = false
  try {
    // 1. 无目录 PDF 空态验证
    await importFixture(app, page, 'valid.pdf')
    await waitForPage(page, 1)

    const outlineToggle = page.getByRole('button', { name: '文档目录', exact: true })
    await expect(outlineToggle).toHaveAttribute('aria-expanded', 'false')
    await outlineToggle.click()
    await expect(outlineToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.reader-body > .reader-outline')).toBeVisible()
    await expect(page.getByText('此 PDF 未包含目录书签', { exact: true })).toBeVisible()
    await outlineToggle.click()
    await expect(outlineToggle).toHaveAttribute('aria-expanded', 'false')

    // 2. 导入带书签、宽白边和搜索词的 3 页验证素材
    await importFixture(app, page, 'verification/reader-ux/' + manifest.file.name)
    await waitForPage(page, 1)
    await expect(page.locator('.pdf-page')).toHaveCount(3)
    await expect(page.locator('.reader-document-title')).toHaveText(manifest.file.name)

    // 目录抽屉开关与嵌套书签跨页跳转
    await outlineToggle.click()
    await expect(outlineToggle).toHaveAttribute('aria-expanded', 'true')
    const nestedTarget = page.getByRole('button', { name: /2\.1 Nested Bookmark Target/ })
    await expect(nestedTarget).toBeVisible()
    await nestedTarget.click()
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2')
    await waitForPage(page, 2)

    await page.getByRole('button', { name: /3\.1 Final Section Target/ }).click()
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('3')
    await waitForPage(page, 3)

    await page.getByRole('button', { name: /1\. Synthetic Overview/ }).click()
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('1')
    await waitForPage(page, 1)
    await outlineToggle.click()

    // 3. Ctrl+F 全文搜索、高亮层、Enter/Shift+Enter、区分大小写、Escape 关闭
    const readerScroll = page.getByLabel('PDF 阅读区域', { exact: true })
    await readerScroll.click()
    await page.keyboard.press('Control+f')

    const searchToggle = page.getByRole('button', { name: '文内搜索', exact: true })
    await expect(searchToggle).toHaveAttribute('aria-expanded', 'true')
    const searchInput = page.getByRole('searchbox', { name: '搜索文档内容' })
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toBeFocused()

    await searchInput.fill(manifest.search.query)
    const searchStatus = page.locator('.reader-search-bar__status')
    await expect(searchStatus).toHaveText(`第 1 / ${manifest.search.caseInsensitiveCount} 处`)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-search-match')).toHaveCount(2)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-search-match--active')).toHaveCount(1)

    // Enter 跳第 2 处 (第1页)，再 Enter 跳第 3 处 (第2页)
    await searchInput.press('Enter')
    await expect(searchStatus).toHaveText(`第 2 / ${manifest.search.caseInsensitiveCount} 处`)
    await searchInput.press('Enter')
    await expect(searchStatus).toHaveText(`第 3 / ${manifest.search.caseInsensitiveCount} 处`)
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2')
    await waitForPage(page, 2)
    await expect(page.locator('.pdf-page[data-page-number="2"] .pdf-search-match--active')).toBeVisible()

    // Shift+Enter 回到第 2 处 (第1页)
    await searchInput.press('Shift+Enter')
    await expect(searchStatus).toHaveText(`第 2 / ${manifest.search.caseInsensitiveCount} 处`)
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('1')
    await waitForPage(page, 1)

    // 区分大小写过滤（6 处 -> 3 处）
    const caseToggle = page.getByRole('button', { name: '区分大小写', exact: true })
    await caseToggle.click()
    await expect(caseToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(searchStatus).toHaveText(`第 1 / ${manifest.search.caseSensitiveCount} 处`)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-search-match')).toHaveCount(1)

    await searchInput.press('Enter')
    await expect(searchStatus).toHaveText(`第 2 / ${manifest.search.caseSensitiveCount} 处`)
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2')
    await waitForPage(page, 2)
    await searchInput.press('Enter')
    await expect(searchStatus).toHaveText(`第 3 / ${manifest.search.caseSensitiveCount} 处`)
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('3')
    await waitForPage(page, 3)
    await searchInput.press('Enter')
    await expect(searchStatus).toHaveText(`第 1 / ${manifest.search.caseSensitiveCount} 处`)
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('1')
    await waitForPage(page, 1)

    // 无匹配词反馈
    await searchInput.fill('NONEXISTENT_READER_UX_TOKEN')
    await expect(searchStatus).toHaveText('无匹配结果')
    await expect(page.locator('.pdf-search-match')).toHaveCount(0)

    // Escape 关闭搜索栏并清空高亮
    await searchInput.press('Escape')
    await expect(searchToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(searchInput).toHaveCount(0)
    await expect(page.locator('.pdf-search-match')).toHaveCount(0)

    // 4. 键盘翻页 (ArrowRight/ArrowLeft/Home/End) 与 Ctrl+滚轮/键盘缩放
    const pageSpin = page.getByRole('spinbutton', { name: '当前页码' })
    await readerScroll.focus()
    await page.keyboard.press('ArrowRight')
    await expect(pageSpin).toHaveValue('2')
    await waitForPage(page, 2)
    await page.keyboard.press('ArrowLeft')
    await expect(pageSpin).toHaveValue('1')
    await waitForPage(page, 1)
    await page.keyboard.press('End')
    await expect(pageSpin).toHaveValue('3')
    await waitForPage(page, 3)
    await page.keyboard.press('Home')
    await expect(pageSpin).toHaveValue('1')
    await waitForPage(page, 1)

    // 聚焦输入框时不触发单键方向键翻页
    await pageSpin.click()
    await expect(pageSpin).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(pageSpin).toHaveValue('1')
    await readerScroll.focus()

    // Ctrl+Wheel 与快捷键缩放
    const fitButton = page.getByRole('button', { name: '适合宽度', exact: true })
    const zoomLevel = page.getByTestId('zoom-level')
    await page.getByRole('button', { name: '缩小', exact: true }).click()
    const shrunkText = await zoomLevel.innerText()
    await fitButton.click()
    await expect(zoomLevel).not.toHaveText(shrunkText)
    const baseZoomPercent = Number((await zoomLevel.innerText()).replace('%', ''))
    await expect
      .poll(async () => Math.abs((await pageGeometry(page, 1)).canvas.width - (manifest.pages[0].width * baseZoomPercent) / 100))
      .toBeLessThan(0.5)
    await waitForPage(page, 1)

    const scrollRect = (await readerScroll.boundingBox())!
    await page.mouse.move(scrollRect.x + scrollRect.width / 2, scrollRect.y + scrollRect.height / 2)
    await page.keyboard.down('Control')
    ctrlHeld = true
    await page.mouse.wheel(0, -120)
    await page.keyboard.up('Control')
    ctrlHeld = false
    await expect(zoomLevel).toHaveText(`${baseZoomPercent + 10}%`)

    await page.keyboard.down('Control')
    ctrlHeld = true
    await page.mouse.wheel(0, 120)
    await page.keyboard.up('Control')
    ctrlHeld = false
    await expect(zoomLevel).toHaveText(`${baseZoomPercent}%`)

    await page.keyboard.press('Control+=')
    await expect(zoomLevel).toHaveText(`${baseZoomPercent + 10}%`)
    await page.keyboard.press('Control+-')
    await expect(zoomLevel).toHaveText(`${baseZoomPercent}%`)
    await page.keyboard.press('Control+0')
    await expect(zoomLevel).toHaveText(`${baseZoomPercent}%`)
    await expect
      .poll(async () => Math.abs((await pageGeometry(page, 1)).canvas.width - (manifest.pages[0].width * baseZoomPercent) / 100))
      .toBeLessThan(0.5)
    await waitForPage(page, 1)

    // 5. 裁剪白边、fitWidth 放大与裁剪视图下的鼠标拖选复制保真
    const beforeCrop = await pageGeometry(page, 1)
    const cropToggle = page.getByRole('button', { name: '裁剪白边', exact: true })
    await expect(cropToggle).toHaveAttribute('aria-pressed', 'false')
    await cropToggle.click()
    await expect(cropToggle).toHaveAttribute('aria-pressed', 'true')
    await settled(page)

    const croppedAtSameScale = await pageGeometry(page, 1)
    expect(croppedAtSameScale.page.width).toBeLessThan(beforeCrop.page.width * 0.75)
    expect(croppedAtSameScale.page.height).toBeLessThan(beforeCrop.page.height * 0.8)
    expect(Math.abs(croppedAtSameScale.canvas.width - beforeCrop.canvas.width)).toBeLessThan(0.5)

    await fitButton.click()
    await expect
      .poll(async () => Number((await zoomLevel.innerText()).replace('%', '')))
      .toBeGreaterThan(baseZoomPercent + 25)
    const enlargedPercent = Number((await zoomLevel.innerText()).replace('%', ''))
    await expect
      .poll(async () => Math.abs((await pageGeometry(page, 1)).canvas.width - (manifest.pages[0].width * enlargedPercent) / 100))
      .toBeLessThan(0.5)
    await waitForPage(page, 1)
    await settled(page)

    const croppedFitted = await pageGeometry(page, 1)
    expect(croppedFitted.page.width).toBeLessThanOrEqual(croppedFitted.reader.availableWidth + 2)

    // 保持裁剪后适合宽度，拖拽选中第 1 页正文并 Ctrl+C 校验真实剪贴板
    const preClientStart = pdfToClient(manifest.selection.start, croppedFitted.canvas)
    const preClientEnd = pdfToClient(manifest.selection.end, croppedFitted.canvas)
    await readerScroll.evaluate(
      (root, delta) => {
        root.scrollTop += delta.y
      },
      { y: (preClientStart.y + preClientEnd.y) / 2 - (croppedFitted.reader.y + croppedFitted.reader.height / 2) }
    )
    await settled(page)

    const dragGeometry = await pageGeometry(page, 1)
    const dragStart = pdfToClient(manifest.selection.start, dragGeometry.canvas)
    const dragEnd = pdfToClient(manifest.selection.end, dragGeometry.canvas)
    expect(dragStart.x).toBeGreaterThan(dragGeometry.page.x + 1)
    expect(dragEnd.x).toBeLessThan(dragGeometry.page.x + dragGeometry.page.width - 1)
    expect(dragStart.y).toBeGreaterThan(dragGeometry.reader.y + 1)
    expect(dragStart.y).toBeLessThan(dragGeometry.reader.y + dragGeometry.reader.height - 1)

    await page.mouse.move(dragStart.x, dragStart.y)
    await page.mouse.down()
    await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 24 })
    await page.mouse.up()

    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('Selectable cropped sentence')
    const sentinel = 'reader-ux-copy-sentinel'
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), sentinel)
    await page.keyboard.press('Control+c')
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(compact(copied)).toBe(compact(manifest.selection.expectedText))

    // 若配置了截图环境变量，展示目录 + 搜索高亮 + 白边裁剪放大全貌
    const shotPath = process.env.PAPERFLOW_READER_UX_SHOT?.trim()
    if (shotPath) {
      await outlineToggle.click()
      await fitButton.click()
      await expect(zoomLevel).not.toHaveText(`${enlargedPercent}%`)
      const shotZoomPercent = Number((await zoomLevel.innerText()).replace('%', ''))
      await expect
        .poll(async () => Math.abs((await pageGeometry(page, 1)).canvas.width - (manifest.pages[0].width * shotZoomPercent) / 100))
        .toBeLessThan(0.5)
      await waitForPage(page, 1)
      await page.keyboard.press('Control+f')
      await page.getByRole('searchbox', { name: '搜索文档内容' }).fill(manifest.search.query)
      await expect(page.locator('.reader-search-bar__status')).toHaveText(`第 1 / ${manifest.search.caseSensitiveCount} 处`)
      await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-search-match--active')).toBeVisible()
      await settled(page)
      await mkdir(dirname(shotPath), { recursive: true })
      await writeFile(shotPath, await page.screenshot({ scale: 'css', animations: 'disabled' }))
    }

    // 取消裁剪白边恢复全页尺寸
    await cropToggle.click()
    await expect(cropToggle).toHaveAttribute('aria-pressed', 'false')
    await settled(page)
    const uncroppedAfter = await pageGeometry(page, 1)
    expect(Math.abs(uncroppedAfter.page.width - uncroppedAfter.canvas.width)).toBeLessThan(0.5)

    expect(failures).toEqual([])
  } finally {
    if (ctrlHeld) await page.keyboard.up('Control').catch(() => {})
    await app.close()
  }
})
