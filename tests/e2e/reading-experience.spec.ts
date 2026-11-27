import { expect, test, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
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

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

test('方向二阅读体验：主题切换、收藏与标签、阅读进度、跨库批注译文检索与图表引用速览', async () => {
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && (req.url ?? '').endsWith('/chat/completions')) {
      const body = JSON.parse(await readRequestBody(req)) as {
        messages?: Array<{ role: string; content: string }>
      }
      const userMsg = body.messages?.[body.messages.length - 1]?.content ?? ''
      if (/Reply strictly with:\s*OK/i.test(userMsg)) {
        writeJson(res, 200, { choices: [{ message: { content: 'OK' } }] })
        return
      }
      const rawJson = userMsg.slice(userMsg.lastIndexOf('\n') + 1)
      const items = JSON.parse(rawJson) as Array<{ id: string; text: string }>
      writeJson(res, 200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                translations: items.map(item => ({ id: item.id, text: `第二页检索译文Omega：${item.text}` }))
              })
            }
          }
        ]
      })
      return
    }
    writeJson(res, 404, { error: 'not found' })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Mock server failed')
  const apiBaseUrl = `http://127.0.0.1:${addr.port}/v1`

  const dataDir = await createTestData()
  let running = await launchApp(dataDir, { deviceScaleFactor: 1 })
  const failures: string[] = []
  running.page.on('pageerror', error => failures.push(error.message))

  try {
    const { app, page } = running
    await importFixture(app, page, 'verification/layout-analysis/' + layoutManifest.file.name)
    await page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '双栏', exact: true }).click()
    await waitForPageReady(page, 1)

    // 1. 主题切换：明亮 -> 护眼（验证 PDF multiply 暖纸层） -> 深色
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    await page.getByTestId('theme-menu-trigger').click()
    const themeGroup = page.getByRole('group', { name: '阅读主题', exact: true })
    await themeGroup.getByRole('button', { name: '护眼', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('sepia')
    const sepiaBlend = await page.evaluate(() => {
      const pdfPage = document.querySelector('.pdf-page[data-page-number="1"]')
      return pdfPage ? getComputedStyle(pdfPage, '::after').mixBlendMode : ''
    })
    expect(sepiaBlend).toBe('multiply')

    // 2. 文献库样式 B（悬停浮现图标栏 + 0px 高度变化）、星标收藏、自定义标签筛选与阅读进度显示
    const docCard = page.locator('.document-entry').first()
    await expect(docCard).toContainText('已读 P.1/2')
    const restHeight = (await docCard.boundingBox())!.height
    await docCard.hover()
    const hoverHeight = (await docCard.boundingBox())!.height
    expect(Math.abs(hoverHeight - restHeight)).toBeLessThanOrEqual(0.5)

    const starBtn = docCard.getByRole('button', { name: /^收藏 / })
    await starBtn.click()
    await expect(docCard.getByRole('button', { name: /^取消收藏 / })).toHaveAttribute('aria-pressed', 'true')

    await docCard.getByRole('button', { name: /添加标签$/ }).click()
    await docCard.getByLabel('添加文献标签', { exact: true }).fill('VLDB')
    await docCard.getByLabel('添加文献标签', { exact: true }).press('Enter')
    await expect(docCard.locator('.document-tag-pill')).toContainText('#VLDB')

    await page.getByTestId('library-filter-toggle').click()
    const filterGroup = page.getByRole('group', { name: '文献筛选', exact: true })
    await filterGroup.getByRole('button', { name: '#VLDB', exact: true }).click()
    await expect(page.locator('.document-entry')).toHaveCount(1)
    await filterGroup.getByRole('button', { name: '★ 收藏', exact: true }).click()
    await expect(page.locator('.document-entry')).toHaveCount(1)
    await filterGroup.getByRole('button', { name: '全部', exact: true }).click()
    await page.getByTestId('library-filter-toggle').click()

    // 3. 图表引用速览（点击含 Fig. 1 的句子 -> 速览 Fig. 1 -> 验证图注并截图演示）
    const figSentenceSpan = page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'Fig. 1, the scale factor' })
      .first()
    await figSentenceSpan.scrollIntoViewIfNeeded()
    const figBox = (await figSentenceSpan.boundingBox())!
    await page.mouse.click(figBox.x + figBox.width / 2, figBox.y + figBox.height / 2)

    const peekBtn = page.getByRole('button', { name: '速览 Fig. 1', exact: true })
    await expect(peekBtn).toBeVisible()
    await peekBtn.click()
    const peekDialog = page.getByRole('dialog', { name: '引用与图表速览', exact: true })
    await expect(peekDialog).toBeVisible()
    await expect(peekDialog).toContainText('Figure 1: Synthetic two-column alignment diagram.')

    if (process.env.PAPERFLOW_DEMO_SHOT) {
      await docCard.hover()
      await page.screenshot({ path: process.env.PAPERFLOW_DEMO_SHOT })
    }

    await page.getByTestId('theme-menu-trigger').click()
    await page.getByRole('group', { name: '阅读主题', exact: true }).getByRole('button', { name: '深色', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    const darkPalette = await page.evaluate(() => ({
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      yellow: getComputedStyle(document.querySelector('.study-color-dot--yellow')!).backgroundColor,
      green: getComputedStyle(document.querySelector('.study-color-dot--green')!).backgroundColor,
      blue: getComputedStyle(document.querySelector('.study-color-dot--blue')!).backgroundColor,
      pink: getComputedStyle(document.querySelector('.study-color-dot--pink')!).backgroundColor
    }))
    expect(darkPalette.colorScheme).toBe('dark')
    expect(darkPalette.yellow).toBe('rgb(253, 224, 71)')
    expect(darkPalette.green).toBe('rgb(134, 239, 172)')
    expect(darkPalette.blue).toBe('rgb(147, 197, 253)')
    expect(darkPalette.pink).toBe('rgb(249, 168, 212)')
    await page.getByRole('button', { name: '关闭速览卡片', exact: true }).click()
    await expect(peekDialog).toHaveCount(0)

    // 4. 在第 2 页添加批注、翻译第 2 页，并验证纯「译文」阅读模式与跨库检索跳转
    const viewGroup = page.getByRole('group', { name: '视图模式', exact: true })
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await waitForPageReady(page, 2)
    await expect(docCard).toContainText('已读 P.2/2')

    const page2Span = page
      .locator('.pdf-page[data-page-number="2"] .textLayer span')
      .filter({ hasText: 'Left lower band resumes' })
      .first()
    await page2Span.scrollIntoViewIfNeeded()
    const page2Box = (await page2Span.boundingBox())!
    await page.mouse.click(page2Box.x + page2Box.width / 2, page2Box.y + page2Box.height / 2)
    await page.getByRole('button', { name: '黄色高亮', exact: true }).click()
    await page.getByLabel('批注笔记输入框', { exact: true }).fill('跨库检索专属笔记Alpha')
    await page.getByRole('button', { name: '保存批注', exact: true }).click()
    await expect(page.getByRole('button', { name: '批注与笔记', exact: true })).toContainText('批注 (1)')

    await page.getByRole('button', { name: '翻译设置', exact: true }).click()
    await page.getByLabel('API Base URL', { exact: true }).fill(apiBaseUrl)
    await page.getByLabel('API 模型名称', { exact: true }).fill('mock-search-v1')
    await page.getByLabel('API Key', { exact: true }).fill('sk-search-12345678')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()

    await page.getByRole('button', { name: '翻译本页', exact: true }).click()
    await expect(
      page.locator('.translation-page[data-page-number="2"] .translation-overlay-block.is-translated').first()
    ).toContainText('第二页检索译文Omega', { timeout: 15000 })

    // 深色模式下翻译页面底纸与译文块/跨栏遮罩/文字颜色应与暗黑底图统一，禁止残留白底黑字
    const darkTranslationPalette = await page.evaluate(() => {
      const parseRgb = (raw: string): [number, number, number] => {
        const m = raw.match(/\d+/g)
        return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [-1, -1, -1]
      }
      const transPage = document.querySelector<HTMLElement>('.translation-page[data-page-number="2"]')
      const blocks = Array.from(
        document.querySelectorAll<HTMLElement>('.translation-page[data-page-number="2"] .translation-overlay-block.is-translated')
      )
      const mask = document.querySelector<HTMLElement>('.translation-page[data-page-number="2"] .translation-overlay-mask')
      return {
        pageBg: transPage ? getComputedStyle(transPage).backgroundColor : '',
        maskBg: mask ? getComputedStyle(mask).backgroundColor : null,
        blockCount: blocks.length,
        blocks: blocks.map(block => {
          const textEl = block.querySelector<HTMLElement>('.translation-overlay-block__text')
          return {
            kind: block.dataset.blockKind ?? '',
            bg: parseRgb(getComputedStyle(block).backgroundColor),
            fg: parseRgb(getComputedStyle(textEl ?? block).color)
          }
        })
      }
    })
    expect(darkTranslationPalette.pageBg).toBe('rgb(35, 35, 35)')
    if (darkTranslationPalette.maskBg !== null) {
      expect(darkTranslationPalette.maskBg).toBe('rgb(35, 35, 35)')
    }
    expect(darkTranslationPalette.blockCount).toBeGreaterThan(0)
    for (const blk of darkTranslationPalette.blocks) {
      expect(Math.max(...blk.bg)).toBeLessThan(70)
      expect(Math.min(...blk.fg)).toBeGreaterThan(170)
    }

    // 切换到「译文」模式：译文区铺满且底部悬浮胶囊可用
    await viewGroup.getByRole('button', { name: '译文', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.querySelector('.reader-panel')!.getBoundingClientRect().width)).toBeLessThanOrEqual(2)
    await expect(page.locator('.translation-bottom-dock .reader-floating-pill')).toBeVisible()
    await page.getByRole('button', { name: '上一页', exact: true }).click()
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('1')
    await viewGroup.getByRole('button', { name: '双栏', exact: true }).click()
    await waitForPageReady(page, 1)

    // 用文献库检索批注与译文并点击跳转回第 2 页
    const searchInput = page.locator('#library-search-input')
    await searchInput.fill('Alpha')
    const crossHitBtn = page.locator('.library-cross-hit-btn').first()
    await expect(crossHitBtn).toContainText('批注', { timeout: 10000 })
    await expect(crossHitBtn).toContainText('P.2')
    await crossHitBtn.click()
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2', { timeout: 10000 })

    await searchInput.fill('Omega')
    await expect(page.locator('.library-cross-hit-btn').first()).toContainText('译文', { timeout: 10000 })
    await searchInput.fill('')

    // 5. 重启验证主题、星标、标签与阅读进度持久化
    await running.app.close()
    running = await launchApp(dataDir, { deviceScaleFactor: 1 })
    const p2 = running.page
    p2.on('pageerror', error => failures.push(error.message))

    await waitForPageReady(p2, 2)
    await expect.poll(() => p2.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    const restartedCard = p2.locator('.document-entry').first()
    await expect(restartedCard.getByRole('button', { name: /^取消收藏 / })).toHaveAttribute('aria-pressed', 'true')
    await expect(restartedCard.locator('.document-tag-pill')).toContainText('#VLDB')
    await expect(restartedCard).toContainText('已读 P.2/2')

    expect(failures).toEqual([])
  } finally {
    await running.app.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
