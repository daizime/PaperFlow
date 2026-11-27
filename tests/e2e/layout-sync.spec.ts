import { expect, test, type Page } from '@playwright/test'
import { createTestData, importFixture, launchApp } from './helpers'
import layoutManifest from '../fixtures/verification/layout-analysis/manifest.json'

async function waitForPageReady(page: Page, pageNumber: number): Promise<void> {
  await expect(page.locator(`.pdf-page[data-page-number="${pageNumber}"]`)).toHaveAttribute('data-rendered', 'true', {
    timeout: 30000
  })
  await expect(page.locator(`.translation-page[data-page-number="${pageNumber}"]`)).toHaveAttribute(
    'data-analyzed',
    'true',
    { timeout: 30000 }
  )
}

async function zoomUntilReadableOverflow(page: Page, targetMinPercent = 180): Promise<void> {
  const zoomIn = page.getByRole('button', { name: '放大', exact: true })
  const zoomOutput = page.getByTestId('zoom-level')
  for (let i = 0; i < 15; i += 1) {
    const raw = await zoomOutput.innerText()
    const value = Number.parseInt(raw, 10)
    if (value >= targetMinPercent) break
    await zoomIn.click()
  }
}

test('双栏学术布局结构对齐、阅读顺序重排、单句高亮与同步滑动锁定/解锁', async () => {
  const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  page.on('console', message => {
    if (/fake worker/i.test(message.text())) failures.push(message.text())
  })

  try {
    await importFixture(app, page, 'verification/layout-analysis/' + layoutManifest.file.name)
    await page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '双栏', exact: true }).click()
    await waitForPageReady(page, 1)

    // 已移除“结构”调试视图按钮，右侧默认直接呈现原页结构镜像 + 双向句级联动
    await expect(page.getByRole('button', { name: '结构视图' })).toHaveCount(0)
    await expect(page.locator('.translation-panel header button', { hasText: '结构' })).toHaveCount(0)

    // 1. 顶部与搜索栏动态头偏移严格对齐
    const headerAlignment = async (): Promise<number> =>
      page.evaluate(() => {
        const left = document.querySelector('.pdf-scroll')!.getBoundingClientRect().top
        const right = document.querySelector('.translation-scroll')!.getBoundingClientRect().top
        return Math.abs(left - right)
      })
    expect(await headerAlignment()).toBeLessThanOrEqual(1)

    await page.getByRole('button', { name: '文内搜索', exact: true }).click()
    await expect(page.locator('.reader-search-bar')).toBeVisible()
    await expect.poll(headerAlignment).toBeLessThanOrEqual(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.reader-search-bar')).toHaveCount(0)
    await expect.poll(headerAlignment).toBeLessThanOrEqual(1)

    // 2. 第 1 页结构与阅读顺序镜像校验（左右分栏 x 偏移、页面高度与顶边对齐）
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-mirror-sentence').first()).toBeVisible()

    const columnGeometry = await page.evaluate(() => {
      const leftBlock = document.querySelector('.translation-page[data-page-number="1"] .translation-overlay-block[data-column="1"]')!
      const rightBlock = document.querySelector('.translation-page[data-page-number="1"] .translation-overlay-block[data-column="2"]')!
      const titleBlock = document.querySelector('.translation-page[data-page-number="1"] .translation-overlay-block[data-column="0"]')!
      return {
        titleLeft: titleBlock.getBoundingClientRect().left,
        leftColLeft: leftBlock.getBoundingClientRect().left,
        rightColLeft: rightBlock.getBoundingClientRect().left
      }
    })
    expect(columnGeometry.rightColLeft).toBeGreaterThan(columnGeometry.leftColLeft + 40)

    const page1Alignment = await page.evaluate(() => {
      const pdfPage = document.querySelector('.pdf-page[data-page-number="1"]')!.getBoundingClientRect()
      const transPage = document.querySelector('.translation-page[data-page-number="1"]')!.getBoundingClientRect()
      return {
        topDiff: Math.abs(pdfPage.top - transPage.top),
        heightDiff: Math.abs(pdfPage.height - transPage.height)
      }
    })
    expect(page1Alignment.topDiff).toBeLessThanOrEqual(2)
    expect(page1Alignment.heightDiff).toBeLessThanOrEqual(2)

    // 3. 双向句级联动：点击左侧原文句 -> 左右同时高亮；点击右侧跨栏句 -> 左侧同步绘制双栏矩形高亮；左侧选字 -> 右侧同步高亮并正常复制
    const targetSpan = page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'Every sentence keeps unscaled boxes.' })
      .first()
    await targetSpan.scrollIntoViewIfNeeded()
    const targetBox = (await targetSpan.boundingBox())!
    await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-mirror-sentence.is-active')).toHaveCount(1)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)

    const crossColBtn = page.locator('.translation-page[data-page-number="1"] .translation-mirror-sentence[data-cross-column="true"]').first()
    await expect(crossColBtn).toBeVisible()
    await crossColBtn.click()
    await expect(crossColBtn).toHaveClass(/is-active/)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(2)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(2)

    const spanBox = (await targetSpan.boundingBox())!
    await page.mouse.move(spanBox.x + 2, spanBox.y + spanBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(spanBox.x + spanBox.width - 2, spanBox.y + spanBox.height / 2, { steps: 12 })
    await page.mouse.up()
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-mirror-sentence.is-active')).toHaveCount(1)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    await page.keyboard.press('Control+C')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Every sentence keeps unscaled boxes')

    // 3b. 右栏未译底图拖拽选句：从第 1 句扫选到第 2 句（左栏同步高亮）+ 仅拖选第 2 句不串扰上一句
    const mirrorDragBoxes = await page.evaluate(() => {
      const mirrors = Array.from(
        document.querySelectorAll<HTMLElement>('.translation-page[data-page-number="1"] .translation-mirror-sentence')
      )
      const byOrder = new Map<number, DOMRect[]>()
      for (const el of mirrors) {
        const order = Number.parseInt(el.dataset.readingOrder ?? '', 10)
        if (!Number.isInteger(order)) continue
        const bucket = byOrder.get(order) ?? []
        bucket.push(el.getBoundingClientRect())
        byOrder.set(order, bucket)
      }
      // 挑选同一双栏正文段内相邻的两句（第 1 句至少 2 行，第 2 句至少 2 行），验证跨句扫选与单句回拖
      for (const [order, rects] of byOrder.entries()) {
        const next = byOrder.get(order + 1)
        if (rects.length >= 2 && next && next.length >= 2) {
          return {
            firstOrder: order,
            secondOrder: order + 1,
            combinedRectCount: rects.length + next.length,
            firstSentence: { x: rects[0].left + rects[0].width * 0.4, y: rects[0].top + rects[0].height / 2 },
            secondStart: { x: next[0].left + 4, y: next[0].top + next[0].height / 2 },
            secondEnd: {
              x: next[next.length - 1].left + next[next.length - 1].width * 0.6,
              y: next[next.length - 1].top + next[next.length - 1].height / 2
            }
          }
        }
      }
      return null
    })
    expect(mirrorDragBoxes).not.toBeNull()

    await page.mouse.move(mirrorDragBoxes!.firstSentence.x, mirrorDragBoxes!.firstSentence.y)
    await page.mouse.down()
    await page.mouse.move(mirrorDragBoxes!.secondEnd.x, mirrorDragBoxes!.secondEnd.y, { steps: 10 })
    await page.mouse.up()
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-mirror-sentence.is-active')).toHaveCount(
      mirrorDragBoxes!.combinedRectCount
    )
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)

    await page.mouse.move(mirrorDragBoxes!.secondStart.x, mirrorDragBoxes!.secondStart.y)
    await page.mouse.down()
    await page.mouse.move(mirrorDragBoxes!.secondEnd.x, mirrorDragBoxes!.secondEnd.y, { steps: 10 })
    await page.mouse.up()
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)
    const activeOrderSetAfterRightDrag = await page.evaluate(() => {
      const els = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.translation-page[data-page-number="1"] .translation-mirror-sentence.is-active'
        )
      )
      return Array.from(new Set(els.map(el => Number.parseInt(el.dataset.readingOrder ?? '', 10))))
    })
    expect(activeOrderSetAfterRightDrag).toEqual([mirrorDragBoxes!.secondOrder])

    // 4. 翻到第 2 页确认热区分析完成，随后返回第 1 页顶部
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2')
    await waitForPageReady(page, 2)
    await expect(page.locator('.translation-page[data-page-number="2"] .translation-mirror-sentence').first()).toBeVisible()

    await page.getByRole('button', { name: '上一页', exact: true }).click()
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('1')
    await waitForPageReady(page, 1)

    // 5. 测试同步滑动锁定/解锁小功能（默认锁定 -> 左右/上下双向同步 -> 手动解锁自由滑 -> 重锁对齐）
    const lockButton = page.getByRole('button', { name: '滚动同步锁定', exact: true })
    await expect(lockButton).toHaveAttribute('aria-pressed', 'true')
    await expect(lockButton).toContainText('同步锁定')

    await zoomUntilReadableOverflow(page, 190)
    await waitForPageReady(page, 1)
    await page.locator('.pdf-scroll').evaluate(el => {
      el.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    })
    await page.locator('.translation-scroll').evaluate(el => {
      el.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    })

    const overflowCheck = await page.evaluate(() => {
      const l = document.querySelector('.pdf-scroll')!
      const r = document.querySelector('.translation-scroll')!
      return {
        leftCanScrollX: l.scrollWidth > l.clientWidth + 20,
        leftCanScrollY: l.scrollHeight > l.clientHeight + 50,
        rightCanScrollX: r.scrollWidth > r.clientWidth + 20,
        rightCanScrollY: r.scrollHeight > r.clientHeight + 50
      }
    })
    expect(overflowCheck).toEqual({
      leftCanScrollX: true,
      leftCanScrollY: true,
      rightCanScrollX: true,
      rightCanScrollY: true
    })

    // 锁定态下：原文上下/左右滑动 -> 译文同步跟随
    const pdfBox = (await page.locator('.pdf-scroll').boundingBox())!
    await page.mouse.move(pdfBox.x + pdfBox.width / 2, pdfBox.y + pdfBox.height / 2)
    await page.mouse.wheel(120, 240)
    await expect.poll(async () => {
      const s = await page.evaluate(() => {
        const l = document.querySelector('.pdf-scroll')!
        const r = document.querySelector('.translation-scroll')!
        return { lt: l.scrollTop, rt: r.scrollTop, ll: l.scrollLeft, rl: r.scrollLeft }
      })
      return s.lt > 120 && s.ll > 30 && Math.abs(s.lt - s.rt) <= 2 && s.rl > 30
    }).toBe(true)

    // 锁定态下：译文主动反向滑动 -> 原文同步跟随
    const transBox = (await page.locator('.translation-scroll').boundingBox())!
    await page.mouse.move(transBox.x + transBox.width / 2, transBox.y + transBox.height / 2)
    await page.mouse.wheel(80, 180)
    await expect.poll(async () => {
      const s = await page.evaluate(() => {
        const l = document.querySelector('.pdf-scroll')!
        const r = document.querySelector('.translation-scroll')!
        return { lt: l.scrollTop, rt: r.scrollTop, ll: l.scrollLeft, rl: r.scrollLeft }
      })
      return s.rt > 320 && Math.abs(s.lt - s.rt) <= 2 && s.ll > 60
    }).toBe(true)

    // 手动解锁 -> 自由滑动
    await lockButton.click()
    await expect(lockButton).toHaveAttribute('aria-pressed', 'false')
    await expect(lockButton).toContainText('自由滑动')

    const beforeUnlock = await page.evaluate(() => {
      const l = document.querySelector('.pdf-scroll')!
      const r = document.querySelector('.translation-scroll')!
      return { lt: l.scrollTop, ll: l.scrollLeft, rt: r.scrollTop, rl: r.scrollLeft }
    })

    // 解锁后仅滑动右侧 -> 左侧位置不能变
    await page.mouse.move(transBox.x + transBox.width / 2, transBox.y + transBox.height / 2)
    await page.mouse.wheel(-100, -200)
    await expect.poll(async () => {
      const s = await page.evaluate(() => {
        const l = document.querySelector('.pdf-scroll')!
        const r = document.querySelector('.translation-scroll')!
        return { lt: l.scrollTop, ll: l.scrollLeft, rt: r.scrollTop, rl: r.scrollLeft }
      })
      return Math.abs(s.rt - beforeUnlock.rt) > 80 && Math.abs(s.rl - beforeUnlock.rl) > 20 &&
        Math.abs(s.lt - beforeUnlock.lt) <= 1 && Math.abs(s.ll - beforeUnlock.ll) <= 1
    }).toBe(true)

    // 解锁后仅滑动左侧 -> 右侧保持自己独立位置不动
    const rightFrozen = await page.evaluate(() => {
      const r = document.querySelector('.translation-scroll')!
      return { rt: r.scrollTop, rl: r.scrollLeft }
    })
    await page.mouse.move(pdfBox.x + pdfBox.width / 2, pdfBox.y + pdfBox.height / 2)
    await page.mouse.wheel(-60, 140)
    await expect.poll(async () => {
      const s = await page.evaluate(() => {
        const l = document.querySelector('.pdf-scroll')!
        const r = document.querySelector('.translation-scroll')!
        return { lt: l.scrollTop, ll: l.scrollLeft, rt: r.scrollTop, rl: r.scrollLeft }
      })
      return s.lt > beforeUnlock.lt + 60 &&
        Math.abs(s.rt - rightFrozen.rt) <= 1 && Math.abs(s.rl - rightFrozen.rl) <= 1
    }).toBe(true)

    // 点击重新锁定 -> 译文立即自动对齐回原文位置
    await lockButton.click()
    await expect(lockButton).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => {
      const s = await page.evaluate(() => {
        const l = document.querySelector('.pdf-scroll')!
        const r = document.querySelector('.translation-scroll')!
        return Math.abs(l.scrollTop - r.scrollTop)
      })
      return s
    }).toBeLessThanOrEqual(2)

    // 6. 鼠标与焦点均在右栏译文区时：Ctrl+= / Ctrl+- / Ctrl+滚轮 / Ctrl+0 均可同步缩放且不触发 Electron 窗口整体缩放
    await page.mouse.move(transBox.x + transBox.width / 2, transBox.y + transBox.height / 2)
    await page.locator('.translation-scroll').focus()
    const zoomOutput = page.getByTestId('zoom-level')
    const zoomBeforeTrans = Number.parseInt(await zoomOutput.innerText(), 10)

    await page.keyboard.press('Control+=')
    await expect(zoomOutput).toHaveText(`${zoomBeforeTrans + 10}%`)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(1)

    await page.keyboard.press('Control+-')
    await expect(zoomOutput).toHaveText(`${zoomBeforeTrans}%`)

    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -120)
    await expect(zoomOutput).toHaveText(`${zoomBeforeTrans + 10}%`)
    await page.mouse.wheel(0, 120)
    await expect(zoomOutput).toHaveText(`${zoomBeforeTrans}%`)
    await page.keyboard.up('Control')

    await page.keyboard.press('Control+0')
    await expect.poll(async () => Number.parseInt(await zoomOutput.innerText(), 10)).toBeLessThan(zoomBeforeTrans)
    await waitForPageReady(page, 1)
    const alignedAfterReset = await page.evaluate(() => {
      const pdfPage = document.querySelector('.pdf-page[data-page-number="1"]')!.getBoundingClientRect()
      const transPage = document.querySelector('.translation-page[data-page-number="1"]')!.getBoundingClientRect()
      return {
        widthDiff: Math.abs(pdfPage.width - transPage.width),
        heightDiff: Math.abs(pdfPage.height - transPage.height)
      }
    })
    expect(alignedAfterReset.widthDiff).toBeLessThanOrEqual(2)
    expect(alignedAfterReset.heightDiff).toBeLessThanOrEqual(2)

    expect(failures).toEqual([])
  } finally {
    await app.close()
  }
})

test('裁剪白边与放大模式下保持结构镜像尺寸与上下对齐', async () => {
  const info = test.info()
  const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
  try {
    await importFixture(app, page, 'verification/reader-ux/reader-ux-fixture.pdf')
    await page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '双栏', exact: true }).click()
    await waitForPageReady(page, 1)

    await page.getByRole('button', { name: '裁剪白边', exact: true }).click()
    await zoomUntilReadableOverflow(page, 240)
    await waitForPageReady(page, 1)

    const metrics = await page.evaluate(() => {
      const leftScroll = document.querySelector('.pdf-scroll')!
      const rightScroll = document.querySelector('.translation-scroll')!
      const pdfPage = document.querySelector('.pdf-page[data-page-number="1"]')!.getBoundingClientRect()
      const transPage = document.querySelector('.translation-page[data-page-number="1"]')!.getBoundingClientRect()
      return {
        headerOffsetDiff: Math.abs(leftScroll.getBoundingClientRect().top - rightScroll.getBoundingClientRect().top),
        pageTopDiff: Math.abs(pdfPage.top - transPage.top),
        pageWidthDiff: Math.abs(pdfPage.width - transPage.width),
        pageHeightDiff: Math.abs(pdfPage.height - transPage.height),
        rightScrollCanHoriz: rightScroll.scrollWidth > rightScroll.clientWidth,
        rightBlocks: document.querySelectorAll('.translation-page[data-page-number="1"] .translation-overlay-block').length,
        hasBackdropCanvas: Boolean(document.querySelector('.translation-page[data-page-number="1"] canvas.translation-page-bg'))
      }
    })

    expect(metrics.headerOffsetDiff).toBeLessThanOrEqual(1)
    expect(metrics.pageTopDiff).toBeLessThanOrEqual(2)
    expect(metrics.pageWidthDiff).toBeLessThanOrEqual(2)
    expect(metrics.pageHeightDiff).toBeLessThanOrEqual(2)
    expect(metrics.rightScrollCanHoriz).toBe(true)
    expect(metrics.rightBlocks).toBeGreaterThanOrEqual(3)
    expect(metrics.hasBackdropCanvas).toBe(true)

    await info.attach('layout-sync-reader-ux-cropped', { body: await page.screenshot(), contentType: 'image/png' })
  } finally {
    await app.close()
  }
})
