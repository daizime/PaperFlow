import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import layoutManifest from '../fixtures/verification/layout-analysis/manifest.json'
import { createTestData, importFixture, launchApp } from './helpers'

async function waitForPageReady(page: Page, pageNumber: number): Promise<void> {
  await expect(page.locator(`.pdf-page[data-page-number="${pageNumber}"]`)).toHaveAttribute('data-rendered', 'true', {
    timeout: 30000
  })
  await expect(page.locator(`.translation-page[data-page-number="${pageNumber}"]`)).toHaveAttribute(
    'data-analyzed',
    'true',
    { timeout: 30000 }
  )
  await expect(page.locator(`.translation-page[data-page-number="${pageNumber}"] canvas.translation-page-bg`)).toBeVisible({
    timeout: 15000
  })
}

test('1:1 双栏对照、文献库收起、原页底图覆写译文、OpenAI 兼容 API 与 CLI 切换、SQLite 缓存持久恢复', async () => {
  const info = test.info()
  let httpRequests = 0

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    httpRequests += 1
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: Array<{ role: string; content: string }>
    }
    const userPrompt = body.messages[body.messages.length - 1]?.content ?? ''
    const arrStart = userPrompt.lastIndexOf('[')
    const blocks = JSON.parse(userPrompt.slice(arrStart)) as Array<{ id: string; text: string }>
    const translateFixtureText = (text: string): string => {
      if (text.includes('Deterministic Layout Pipeline')) return '面向本地科研阅读器的确定性版面流水线'
      if (text.startsWith('1. Introduction')) return '1. 引言'
      if (text.includes('Modern readers require')) return '现代阅读器需要稳定的版面架构（如 Smith 等，2025）。如图 1 所示，双栏缩放因子为 3.14 且含自注意力权重。'
      if (text.includes('deterministic layout pipeline')) return '确定性版面流水线可重建栏位边界。'
      if (text.includes('preserves exact PDF coordinates')) return '其精确保留 PDF 原始坐标。'
      if (text.startsWith('Figure 1:')) return '图 1：双栏对齐结构示意图。'
      if (text.startsWith('2. Methods')) return '2. 研究方法'
      if (text.includes('unscaled boxes')) return '每个句子均维持未缩放坐标框。'
      return `译文：${text.slice(0, 18)}`
    }
    const translations = blocks.map(item => ({
      id: item.id,
      text: translateFixtureText(item.text)
    }))
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`

  const cliTempDir = await mkdtemp(join(tmpdir(), 'paperflow-e2e-cli-'))
  const cliStubPath = join(cliTempDir, 'stub-cli.mjs')
  await writeFile(
    cliStubPath,
    [
      "import { readFileSync } from 'node:fs'",
      "const raw = readFileSync(0, 'utf8')",
      "const start = raw.lastIndexOf('[')",
      'const blocks = JSON.parse(raw.slice(start))',
      'const translations = blocks.map(item => ({ id: item.id, text: item.text.includes("Deterministic Layout Pipeline") ? "CLI复译：面向本地科研阅读器的确定性版面流水线" : "CLI复译：" + item.text.slice(0, 16) }))',
      'console.log(JSON.stringify({ translations }))'
    ].join('\n'),
    'utf8'
  )

  const dataDir = await createTestData()
  let running = await launchApp(dataDir, { deviceScaleFactor: 1 })
  const failures: string[] = []
  running.page.on('pageerror', error => failures.push(error.message))

  try {
    const { app, page } = running

    // 1. 导入双栏学术 PDF，验证新打开默认进入「原文」模式并弹出未配置小浮窗，再切至「双栏」验证 1:1 对半展示、文献库可收起与单双栏模式切换
    await importFixture(app, page, 'verification/layout-analysis/' + layoutManifest.file.name)
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    await expect(page.locator('.translation-panel')).toHaveCount(0)
    await expect(
      page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '原文', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('translation-unconfigured-prompt')).toBeVisible({ timeout: 10000 })
    await page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '双栏', exact: true }).click()
    await waitForPageReady(page, 1)

    const initialWidths = await page.evaluate(() => {
      const lib = document.querySelector('.library-panel')!.getBoundingClientRect().width
      const left = document.querySelector('.reader-panel')!.getBoundingClientRect().width
      const right = document.querySelector('.translation-panel')!.getBoundingClientRect().width
      return { lib, left, right }
    })
    expect(initialWidths.lib).toBeGreaterThan(200)
    expect(Math.abs(initialWidths.left - initialWidths.right)).toBeLessThanOrEqual(4)
    await expect(page.getByRole('button', { name: '结构视图' })).toHaveCount(0)
    await expect(page.locator('.translation-panel header button', { hasText: '结构' })).toHaveCount(0)

    // 收起文献库后原文和译文依然保持 1:1 均分
    const sidebarToggle = page.getByRole('button', { name: '切换文献库侧边栏', exact: true })
    await sidebarToggle.click()
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false')
    const collapsedWidths = await page.evaluate(() => {
      const lib = document.querySelector('.library-panel')!.getBoundingClientRect().width
      const left = document.querySelector('.reader-panel')!.getBoundingClientRect().width
      const right = document.querySelector('.translation-panel')!.getBoundingClientRect().width
      return { lib, left, right }
    })
    expect(collapsedWidths.lib).toBeLessThanOrEqual(2)
    expect(collapsedWidths.left).toBeGreaterThan(initialWidths.left + 80)
    expect(Math.abs(collapsedWidths.left - collapsedWidths.right)).toBeLessThanOrEqual(4)

    // 左右拖拽中间分隔条调节分屏比例后必须保持左右并排（绝不塌缩为上下堆叠），双击分隔条恢复 1:1
    const resizerBox = (await page.getByRole('separator', { name: '调整双栏分屏比例', exact: true }).boundingBox())!
    const midY = resizerBox.y + resizerBox.height / 2
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, midY)
    await page.mouse.down()
    await page.mouse.move(resizerBox.x + resizerBox.width / 2 - 140, midY, { steps: 10 })
    await page.mouse.up()

    const draggedLeftMetrics = await page.evaluate(() => {
      const left = document.querySelector('.reader-panel')!.getBoundingClientRect()
      const right = document.querySelector('.translation-panel')!.getBoundingClientRect()
      return { leftTop: left.top, rightTop: right.top, leftRight: left.right, rightLeft: right.left, leftWidth: left.width, rightWidth: right.width }
    })
    expect(Math.abs(draggedLeftMetrics.leftTop - draggedLeftMetrics.rightTop)).toBeLessThanOrEqual(2)
    expect(draggedLeftMetrics.leftRight).toBeLessThanOrEqual(draggedLeftMetrics.rightLeft + 2)
    expect(draggedLeftMetrics.rightWidth).toBeGreaterThan(draggedLeftMetrics.leftWidth + 100)

    const resizerBox2 = (await page.getByRole('separator', { name: '调整双栏分屏比例', exact: true }).boundingBox())!
    await page.mouse.move(resizerBox2.x + resizerBox2.width / 2, resizerBox2.y + resizerBox2.height / 2)
    await page.mouse.down()
    await page.mouse.move(resizerBox2.x + resizerBox2.width / 2 + 220, resizerBox2.y + resizerBox2.height / 2, { steps: 10 })
    await page.mouse.up()

    const draggedRightMetrics = await page.evaluate(() => {
      const left = document.querySelector('.reader-panel')!.getBoundingClientRect()
      const right = document.querySelector('.translation-panel')!.getBoundingClientRect()
      return { leftTop: left.top, rightTop: right.top, leftWidth: left.width, rightWidth: right.width }
    })
    expect(Math.abs(draggedRightMetrics.leftTop - draggedRightMetrics.rightTop)).toBeLessThanOrEqual(2)
    expect(draggedRightMetrics.leftWidth).toBeGreaterThan(draggedRightMetrics.rightWidth + 50)

    await page.getByRole('separator', { name: '调整双栏分屏比例', exact: true }).dblclick()
    const resetWidths = await page.evaluate(() => {
      const left = document.querySelector('.reader-panel')!.getBoundingClientRect()
      const right = document.querySelector('.translation-panel')!.getBoundingClientRect()
      return { diff: Math.abs(left.width - right.width), topDiff: Math.abs(left.top - right.top) }
    })
    expect(resetWidths.topDiff).toBeLessThanOrEqual(2)
    expect(resetWidths.diff).toBeLessThanOrEqual(4)

    // 切「原文」、切「译文」、再切回「双栏」对照
    const viewGroup = page.getByRole('group', { name: '视图模式', exact: true })
    await viewGroup.getByRole('button', { name: '原文', exact: true }).click()
    await expect(page.locator('.translation-panel')).toHaveCount(0)
    await viewGroup.getByRole('button', { name: '译文', exact: true }).click()
    await expect(page.locator('.translation-panel')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.querySelector('.reader-panel')!.getBoundingClientRect().width)).toBeLessThanOrEqual(2)
    await viewGroup.getByRole('button', { name: '双栏', exact: true }).click()
    await expect(page.locator('.translation-panel')).toBeVisible()
    await waitForPageReady(page, 1)

    // 2. 配置 OpenAI 兼容 API（指向本机 127.0.0.1 模拟服务端），验证测试连接、密钥掩码且不泄露
    await page.getByRole('button', { name: '翻译设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByLabel('API Base URL', { exact: true }).fill(apiBaseUrl)
    await page.getByLabel('API 模型名称', { exact: true }).fill('mock-academic-v1')
    await page.getByLabel('API Key', { exact: true }).fill('sk-e2e-test-99998888')
    const apiTestBtn = page.getByTestId('translation-test-btn')
    await expect(apiTestBtn).toContainText('测试 API（mock-academic-v1）')
    await apiTestBtn.click()
    const apiToast = page.getByTestId('translation-test-result')
    await expect(apiToast).toHaveClass(/translation-modal__toast/)
    await expect(apiToast).toContainText('连接成功')
    await expect(apiToast).toContainText('OpenAI 兼容 API')
    await expect(apiToast).toBeHidden({ timeout: 7000 })
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('header-engine-btn')).toContainText('API · mock-academic-v1')

    // 重开弹窗核验 API Key 输入框为空且提示脱敏预览
    await page.getByRole('button', { name: '翻译设置', exact: true }).click()
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('placeholder', /sk-e\*\*\*8888/)
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()

    // 3. 执行整页翻译：原页底图保留图表与公式，仅文本块原位覆写中文译文，且 0px 纵向漂移
    await page.getByRole('button', { name: '翻译本页', exact: true }).click()
    await expect(page.locator('.translation-overlay-block.is-translated')).toHaveCount(8, { timeout: 15000 })

    const overlayAudit = await page.evaluate(() => {
      const bgCanvas = document.querySelector<HTMLCanvasElement>('.translation-page[data-page-number="1"] canvas.translation-page-bg')!
      const ctx = bgCanvas.getContext('2d')!
      // 采样右下区域彩色柱状图区间确认底图非纯白（完整保留原 PDF 图表像素）
      const sample = ctx.getImageData(
        Math.floor(bgCanvas.width * 0.58),
        Math.floor(bgCanvas.height * 0.34),
        Math.floor(bgCanvas.width * 0.3),
        Math.floor(bgCanvas.height * 0.14)
      ).data
      let coloredPixels = 0
      for (let i = 0; i < sample.length; i += 16) {
        if (sample[i] < 235 || sample[i + 1] < 235 || sample[i + 2] < 235) coloredPixels += 1
      }

      const totalOverlayBlocks = document.querySelectorAll(
        '.translation-page[data-page-number="1"] .translation-overlay-block'
      ).length
      const translatedEls = Array.from(
        document.querySelectorAll<HTMLElement>('.translation-page[data-page-number="1"] .translation-overlay-block.is-translated')
      )
      const formulaOverlays = document.querySelectorAll(
        '.translation-page[data-page-number="1"] .translation-overlay-block[data-block-kind="formula"]'
      )
      const overflowCount = translatedEls.filter(el => {
        const text = el.querySelector<HTMLElement>('.translation-overlay-block__text')
        return text ? text.scrollHeight > el.clientHeight : false
      }).length
      const translatedBoxes = translatedEls.map(el => el.getBoundingClientRect())
      let verticalOverlapCount = 0
      for (let i = 0; i < translatedBoxes.length; i += 1) {
        const a = translatedBoxes[i]
        for (let j = i + 1; j < translatedBoxes.length; j += 1) {
          const b = translatedBoxes[j]
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 2) continue
          const upper = a.top <= b.top ? a : b
          const lower = a.top <= b.top ? b : a
          if (upper.bottom > lower.top + 0.5) verticalOverlapCount += 1
        }
      }
      const maskEl = document.querySelector<HTMLElement>('.translation-page[data-page-number="1"] .translation-overlay-mask')
      const nextRightBlock = document.querySelector<HTMLElement>(
        '.translation-page[data-page-number="1"] .translation-overlay-block[data-block-id="p1-b007"]'
      )
      const maskBottom = maskEl ? maskEl.getBoundingClientRect().bottom : 0
      const nextBlockTop = nextRightBlock ? nextRightBlock.getBoundingClientRect().top : 0
      const crossBlockEl = translatedEls.find(el => el.dataset.blockId === 'p1-b005')
      const crossTextEl = crossBlockEl?.querySelector<HTMLElement>('.translation-overlay-block__text') ?? null
      const crossFontPx = crossTextEl ? Number.parseFloat(getComputedStyle(crossTextEl).fontSize) : 0

      return {
        coloredPixels,
        totalOverlayBlocks,
        formulaOverlayCount: formulaOverlays.length,
        overflowCount,
        verticalOverlapCount,
        maskNoOverlapNext: maskEl !== null && nextRightBlock !== null && maskBottom <= nextBlockTop + 0.5,
        crossFontPx,
        firstTitle: translatedEls[0]?.innerText.trim() ?? '',
        hasRightLeftCols:
          translatedEls.some(el => el.dataset.column === '1') && translatedEls.some(el => el.dataset.column === '2')
      }
    })

    expect(overlayAudit.coloredPixels).toBeGreaterThan(20)
    expect(overlayAudit.totalOverlayBlocks).toBe(8)
    expect(overlayAudit.formulaOverlayCount).toBe(0)
    expect(overlayAudit.overflowCount).toBe(0)
    expect(overlayAudit.verticalOverlapCount).toBe(0)
    expect(overlayAudit.maskNoOverlapNext).toBe(true)
    expect(overlayAudit.crossFontPx).toBeGreaterThanOrEqual(8)
    expect(overlayAudit.firstTitle).toBe('面向本地科研阅读器的确定性版面流水线')
    expect(overlayAudit.hasRightLeftCols).toBe(true)

    // 3b. 验证 NeoRead 风格 4 项双向逐句联动：
    // (1) 左点 3 行第 2 句 ("Fig. 1, the scale factor...") -> 左右两侧均渲染为单一连续多边形轮廓（非 3 个碎框）且仅第 2 句高亮
    const leftSecondSentenceSpan = page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'Fig. 1, the scale factor' })
      .first()
    await leftSecondSentenceSpan.scrollIntoViewIfNeeded()
    const leftSentBox = (await leftSecondSentenceSpan.boundingBox())!
    await page.mouse.click(leftSentBox.x + leftSentBox.width / 2, leftSentBox.y + leftSentBox.height / 2)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    const activeTargetAfterLeftClick = page.locator('.translation-page[data-page-number="1"] .translation-overlay-sentence.is-active')
    await expect(activeTargetAfterLeftClick).toHaveCount(1)
    await expect(activeTargetAfterLeftClick.first()).toContainText('如图 1 所示')
    await expect(activeTargetAfterLeftClick.first()).not.toContainText('现代阅读器')

    // 捕获带有双向逐句多边形高亮的完整截图（左 3 行单多边形轮廓 + 右自然句单多边形轮廓）
    await info.attach('translation-dual-pdf2zh-page1', { body: await page.screenshot(), contentType: 'image/png' })

    // (2) 左侧拖选文字 ("Every sentence keeps unscaled boxes.") -> 左右均高亮对应整句多边形
    const dragLeftSpan = page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'Every sentence keeps unscaled boxes.' })
      .first()
    const dragLeftBox = (await dragLeftSpan.boundingBox())!
    await page.mouse.move(dragLeftBox.x + 2, dragLeftBox.y + dragLeftBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(dragLeftBox.x + dragLeftBox.width - 2, dragLeftBox.y + dragLeftBox.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    const activeTargetAfterLeftDrag = page.locator('.translation-page[data-page-number="1"] .translation-overlay-sentence.is-active')
    await expect(activeTargetAfterLeftDrag).toHaveCount(1)
    await expect(activeTargetAfterLeftDrag.first()).toContainText('每个句子均维持未缩放坐标框')

    // (2b) 左侧同行第二句起手处精确拖选 ("As shown in"，紧接同一行上一句 "Smith et al., 2025)." 之后) -> 左右同时仅高亮第 2 句整句，不串扰前一句
    const startSpan = page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'As shown in' })
      .first()
    await startSpan.scrollIntoViewIfNeeded()
    const dragCoords = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll<HTMLElement>('.pdf-page[data-page-number="1"] .textLayer span'))
      const firstSpan = spans.find(el => el.textContent?.includes('As shown in'))
      if (!firstSpan) return null
      const walker = document.createTreeWalker(firstSpan, NodeFilter.SHOW_TEXT)
      let startRect: DOMRect | null = null
      let node = walker.nextNode() as Text | null
      while (node) {
        const text = node.textContent ?? ''
        const idx = text.indexOf('As shown in')
        if (idx !== -1) {
          const range = document.createRange()
          range.setStart(node, idx)
          range.setEnd(node, text.length)
          startRect = range.getBoundingClientRect()
          break
        }
        node = walker.nextNode() as Text | null
      }
      if (!startRect) return null
      return {
        startX: startRect.left + 2,
        startY: startRect.top + startRect.height / 2,
        endX: startRect.right - 2,
        endY: startRect.top + startRect.height / 2
      }
    })
    expect(dragCoords).not.toBeNull()
    await page.mouse.move(dragCoords!.startX, dragCoords!.startY)
    await page.mouse.down()
    await page.mouse.move(dragCoords!.endX, dragCoords!.endY, { steps: 10 })
    await page.mouse.up()
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    const activeTargetAfterMidLineDrag = page.locator(
      '.translation-page[data-page-number="1"] .translation-overlay-sentence.is-active'
    )
    await expect(activeTargetAfterMidLineDrag).toHaveCount(1)
    await expect(activeTargetAfterMidLineDrag.first()).toContainText('如图 1 所示')
    await expect(activeTargetAfterMidLineDrag.first()).not.toContainText('现代阅读器')

    // (2c) 左侧仅框选/划选整句中的单个词 ("scale") -> 左侧保留单词原生选区且整句蓝框，右栏精确高亮对应的整句译文
    const wordSpanBox = (await page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'scale factor' })
      .first()
      .boundingBox())!
    const wordDragCoords = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll<HTMLElement>('.pdf-page[data-page-number="1"] .textLayer span'))
      const targetSpan = spans.find(el => el.textContent?.includes('scale factor'))
      if (!targetSpan) return null
      const walker = document.createTreeWalker(targetSpan, NodeFilter.SHOW_TEXT)
      let wordRect: DOMRect | null = null
      let node = walker.nextNode() as Text | null
      while (node) {
        const text = node.textContent ?? ''
        const idx = text.indexOf('scale')
        if (idx !== -1) {
          const range = document.createRange()
          range.setStart(node, idx)
          range.setEnd(node, idx + 'scale'.length)
          wordRect = range.getBoundingClientRect()
          break
        }
        node = walker.nextNode() as Text | null
      }
      if (!wordRect) return null
      return {
        startX: wordRect.left + 1,
        startY: wordRect.top + wordRect.height / 2,
        endX: wordRect.right - 1,
        endY: wordRect.top + wordRect.height / 2,
        width: wordRect.width
      }
    })
    expect(wordDragCoords).not.toBeNull()
    await page.mouse.move(wordDragCoords!.startX, wordDragCoords!.startY)
    await page.mouse.down()
    await page.mouse.move(wordDragCoords!.endX, wordDragCoords!.endY, { steps: 10 })
    await page.mouse.up()
    const leftSelectedWord = await page.evaluate(() => (window.getSelection()?.toString() ?? '').trim())
    expect(leftSelectedWord).toContain('scale')
    expect(leftSelectedWord.length).toBeLessThanOrEqual(8)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    const activeTargetAfterLeftWordDrag = page.locator(
      '.translation-page[data-page-number="1"] .translation-overlay-sentence.is-active'
    )
    await expect(activeTargetAfterLeftWordDrag).toHaveCount(1)
    await expect(activeTargetAfterLeftWordDrag.first()).toContainText('如图 1 所示')
    await expect(activeTargetAfterLeftWordDrag.first()).not.toContainText('现代阅读器')

    // (2d) 对左栏划选的单个词点击“蓝色高亮” -> 左栏仅对单词加永久蓝色标注（不整句加标注），右栏仍保留对应整句译文蓝框联动（无标注高亮）
    await expect(page.locator('.study-companion-bar')).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: '蓝色高亮', exact: true }).click()
    const leftWordBlueHighlight = page.locator('.pdf-page[data-page-number="1"] .pdf-annotation-highlight--blue').first()
    await expect(leftWordBlueHighlight).toBeVisible({ timeout: 10000 })
    const blueBox = (await leftWordBlueHighlight.boundingBox())!
    expect(blueBox.width).toBeLessThan(wordSpanBox.width * 0.55)
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(0)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    await expect(page.locator('.translation-page[data-page-number="1"] .pdf-annotation-highlight')).toHaveCount(0)
    const activeTargetAfterWordAnnotation = page.locator(
      '.translation-page[data-page-number="1"] .translation-overlay-sentence.is-active'
    )
    await expect(activeTargetAfterWordAnnotation).toHaveCount(1)
    await expect(activeTargetAfterWordAnnotation.first()).toContainText('如图 1 所示')
    await expect(activeTargetAfterWordAnnotation.first()).not.toContainText('现代阅读器')

    // (3) 右点译文 2 行第 1 句 ("现代阅读器需要稳定的版面架构...") -> 左右两侧均渲染单一连续多边形轮廓
    const rightFirstSentenceSpan = page
      .locator('.translation-page[data-page-number="1"] .translation-overlay-sentence')
      .filter({ hasText: '现代阅读器需要稳定的版面架构' })
      .first()
    await rightFirstSentenceSpan.click()
    await expect(rightFirstSentenceSpan).toHaveClass(/is-active/)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)

    // (4) 右侧拖选译文标题片段 -> 左侧高亮对应标题原句单多边形
    const rightTitleSpan = page
      .locator('.translation-page[data-page-number="1"] .translation-overlay-sentence')
      .filter({ hasText: '面向本地科研阅读器的确定性版面流水线' })
      .first()
    const rightTitleBox = (await rightTitleSpan.boundingBox())!
    await page.mouse.move(rightTitleBox.x + 6, rightTitleBox.y + rightTitleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(rightTitleBox.x + rightTitleBox.width * 0.6, rightTitleBox.y + rightTitleBox.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect(rightTitleSpan).toHaveClass(/is-active/)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)

    // (4b) 右侧已译段落精准拖选第 2 句 ("如图 1 所示...") -> 左侧仅高亮对应第 2 句且不串扰上一句 ("现代阅读器...")
    const rightSecondSpan = page
      .locator('.translation-page[data-page-number="1"] .translation-overlay-sentence')
      .filter({ hasText: '如图 1 所示' })
      .first()
    await rightSecondSpan.scrollIntoViewIfNeeded()
    const rightDragPts = await page.evaluate(() => {
      const spans = Array.from(
        document.querySelectorAll<HTMLElement>('.translation-page[data-page-number="1"] .translation-overlay-sentence')
      )
      const target = spans.find(el => el.textContent?.includes('如图 1 所示'))
      const textNode = target?.firstChild
      if (!(textNode instanceof Text) || textNode.length < 4) return null
      const rStart = document.createRange()
      rStart.setStart(textNode, 0)
      rStart.setEnd(textNode, 2)
      const firstRect = rStart.getClientRects()[0]
      const rEnd = document.createRange()
      rEnd.setStart(textNode, Math.max(0, textNode.length - 3))
      rEnd.setEnd(textNode, textNode.length - 1)
      const endRects = rEnd.getClientRects()
      const lastRect = endRects[endRects.length - 1]
      if (!firstRect || !lastRect) return null
      return {
        startX: firstRect.left + 2,
        startY: firstRect.top + firstRect.height / 2,
        endX: lastRect.right - 2,
        endY: lastRect.top + lastRect.height / 2
      }
    })
    expect(rightDragPts).not.toBeNull()
    await page.mouse.move(rightDragPts!.startX, rightDragPts!.startY)
    await page.mouse.down()
    await page.mouse.move(rightDragPts!.endX, rightDragPts!.endY, { steps: 10 })
    await page.mouse.up()
    const activeTargetAfterRightSentenceDrag = page.locator(
      '.translation-page[data-page-number="1"] .translation-overlay-sentence.is-active'
    )
    await expect(activeTargetAfterRightSentenceDrag).toHaveCount(1)
    await expect(activeTargetAfterRightSentenceDrag.first()).toContainText('如图 1 所示')
    await expect(activeTargetAfterRightSentenceDrag.first()).not.toContainText('现代阅读器')
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)

    // (4c) 直接在已有选区内重新起拖，右侧仅划选单个中文词 ("缩放") -> 左右两侧同时仅高亮对应整句且不串扰前一句
    const rightWordCoords = await page.evaluate(() => {
      const spans = Array.from(
        document.querySelectorAll<HTMLElement>('.translation-page[data-page-number="1"] .translation-overlay-sentence')
      )
      const target = spans.find(el => el.textContent?.includes('双栏缩放因子'))
      if (!target) return null
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode() as Text | null
      while (node) {
        const text = node.textContent ?? ''
        const idx = text.indexOf('缩放')
        if (idx !== -1) {
          const range = document.createRange()
          range.setStart(node, idx)
          range.setEnd(node, idx + 2)
          const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)
          const firstRect = rects[0]
          const lastRect = rects[rects.length - 1]
          if (firstRect && lastRect) {
            return {
              startX: firstRect.left + 1,
              startY: firstRect.top + firstRect.height / 2,
              endX: lastRect.right - 1,
              endY: lastRect.top + lastRect.height / 2
            }
          }
        }
        node = walker.nextNode() as Text | null
      }
      return null
    })
    expect(rightWordCoords).not.toBeNull()
    await page.mouse.move(rightWordCoords!.startX, rightWordCoords!.startY)
    await page.mouse.down()
    await page.mouse.move(rightWordCoords!.endX, rightWordCoords!.endY, { steps: 10 })
    await page.mouse.up()
    const rightSelectedWord = await page.evaluate(() => (window.getSelection()?.toString() ?? '').trim())
    expect(rightSelectedWord).toContain('缩放')
    expect(rightSelectedWord.length).toBeLessThanOrEqual(6)
    const activeTargetAfterRightWordDrag = page.locator(
      '.translation-page[data-page-number="1"] .translation-overlay-sentence.is-active'
    )
    await expect(activeTargetAfterRightWordDrag).toHaveCount(1)
    await expect(activeTargetAfterRightWordDrag.first()).toContainText('如图 1 所示')
    await expect(activeTargetAfterRightWordDrag.first()).not.toContainText('现代阅读器')
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(1)
    await expect(page.locator('.translation-drag-marquee')).toHaveCount(0)

    // 4. 重启应用后验证从 SQLite 缓存直接恢复译文（不再请求远端）
    const callsAfterFirstTranslate = httpRequests
    await running.app.close()
    running = await launchApp(dataDir, { deviceScaleFactor: 1 })
    const p2 = running.page
    p2.on('pageerror', error => failures.push(error.message))

    await waitForPageReady(p2, 1)
    await expect(
      p2.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '双栏', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(p2.locator('.translation-overlay-block.is-translated')).toHaveCount(8, { timeout: 15000 })
    await expect(p2.locator('.translation-overlay-block.is-translated').first()).toContainText('面向本地科研阅读器的确定性版面流水线')
    expect(httpRequests).toBe(callsAfterFirstTranslate)

    // 5. 切换为本机 AI CLI / 客户端模式：验证生效状态横幅、无副作用试连（不改生效引擎）、与具名切换按钮
    await p2.getByRole('button', { name: '翻译设置', exact: true }).click()
    await expect(p2.getByTestId('active-engine-banner')).toContainText('OpenAI 兼容 API')
    await p2.getByRole('button', { name: /本机 AI CLI/ }).click()
    await expect(p2.getByTestId('engine-draft-preview-badge')).toBeVisible()
    const clientsPanel = p2.getByTestId('local-ai-clients-panel')
    await expect(clientsPanel).toBeVisible()
    await expect(p2.getByTestId('local-ai-client-claude')).toHaveCount(0)
    await expect(p2.getByTestId('local-ai-client-codex')).toBeVisible()
    await expect(p2.getByTestId('local-ai-client-gemini')).toBeVisible()
    await clientsPanel.getByRole('button', { name: '重新扫描', exact: true }).click()
    await expect(clientsPanel.getByRole('button', { name: '重新扫描', exact: true })).toBeEnabled({ timeout: 15000 })

    // 切回 API 再切回 CLI，确认无残留提示串台
    await p2.getByRole('button', { name: /OpenAI 兼容 API/ }).click()
    await expect(p2.getByTestId('engine-draft-preview-badge')).toHaveCount(0)
    await p2.getByRole('button', { name: /本机 AI CLI/ }).click()

    await p2.getByRole('button', { name: '自定义 CLI', exact: true }).click()
    await running.app.evaluate(({ dialog }, exePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [exePath] })
    }, process.execPath)
    await p2.getByRole('button', { name: '浏览程序…', exact: true }).click()
    await expect(p2.getByLabel('CLI 命令', { exact: true })).toHaveValue(process.execPath)
    await p2.getByLabel('CLI 附加参数', { exact: true }).fill(cliStubPath)
    const cliTestBtn = p2.getByTestId('translation-test-btn')
    await expect(cliTestBtn).toContainText('测试 CLI（自定义 CLI）')
    await cliTestBtn.click()
    await expect(p2.locator('.translation-modal__status--ok')).toContainText('连接成功')
    await expect(p2.locator('.translation-modal__status--ok')).toContainText('本机 AI CLI')
    await expect(p2.locator('.translation-modal__status--ok')).toContainText('仅测试当前草稿')
    // 验证纯试连不会篡改当前已生效引擎
    await expect(p2.getByTestId('active-engine-banner')).toContainText('OpenAI 兼容 API')

    await p2.getByRole('button', { name: '保存并切换为本机 CLI', exact: true }).click()
    await expect(p2.getByRole('dialog')).toHaveCount(0)
    await expect(p2.getByTestId('header-engine-btn')).toContainText('CLI ·')

    await p2.getByRole('button', { name: '重译本页', exact: true }).click()
    await expect(p2.locator('.translation-overlay-block.is-translated').first()).toContainText('CLI复译：', {
      timeout: 15000
    })

    expect(failures).toEqual([])
  } finally {
    await running.app.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(cliTempDir, { recursive: true, force: true })
  }
})

test('翻译本页期间切换其他 PDF 不中止后台翻译，标签页标出译中并在完成后切回即见完整译文', async () => {
  let releaseDelayedTranslation = (): void => {}
  let docATranslateRequestCount = 0

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: Array<{ role: string; content: string }>
    }
    const userPrompt = body.messages[body.messages.length - 1]?.content ?? ''
    const arrStart = userPrompt.lastIndexOf('[')
    const blocks = JSON.parse(userPrompt.slice(arrStart)) as Array<{ id: string; text: string }>
    const isTestPing = blocks.length === 1 && blocks[0]?.id === 'test-b001'
    const isDocA = blocks.some(b => /Deterministic Two-Column|Modern readers/i.test(b.text))
    if (!isTestPing && isDocA) {
      docATranslateRequestCount += 1
      if (docATranslateRequestCount === 1) {
        await new Promise<void>(resolveDelay => {
          releaseDelayedTranslation = resolveDelay
          setTimeout(resolveDelay, 12000)
        })
      }
    }
    const translations = blocks.map(item => ({
      id: item.id,
      text: `后台持久译文：${item.text.slice(0, 20)}`
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }))
  })

  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()))
  const addr = server.address() as { port: number }
  const apiBaseUrl = `http://127.0.0.1:${addr.port}/v1`
  const dataDir = await createTestData()
  const running = await launchApp(dataDir, { deviceScaleFactor: 1 })
  const failures: string[] = []
  running.page.on('pageerror', error => failures.push(error.message))

  try {
    const { app, page } = running
    await importFixture(app, page, 'verification/layout-analysis/' + layoutManifest.file.name)
    await page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '双栏', exact: true }).click()
    await waitForPageReady(page, 1)
    const docsAfterFirst = await page.evaluate(() => window.paperflow.listDocuments())
    const docAId = docsAfterFirst[0].id

    await importFixture(app, page, 'valid.pdf')
    const docsAfterSecond = await page.evaluate(() => window.paperflow.listDocuments())
    const docBId = docsAfterSecond.find(d => d.id !== docAId)!.id

    // 切回 docA 并配置模拟 API 端点
    await page.getByTestId(`pdf-tab-${docAId}`).locator('button.workspace-tab__select').click()
    await waitForPageReady(page, 1)
    await page.getByRole('button', { name: '翻译设置', exact: true }).click()
    await page.getByLabel('API Base URL', { exact: true }).fill(apiBaseUrl)
    await page.getByLabel('API 模型名称', { exact: true }).fill('mock-bg-v1')
    await page.getByLabel('API Key', { exact: true }).fill('sk-bg-123456')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()

    // 在 docA 启动整页翻译（服务端暂挂起响应），随即切换到 docB
    await page.getByRole('button', { name: '翻译本页', exact: true }).click()
    await expect.poll(() => docATranslateRequestCount).toBe(1)

    await page.getByTestId(`pdf-tab-${docBId}`).locator('button.workspace-tab__select').click()
    await expect(page.getByTestId(`pdf-tab-translating-${docAId}`)).toHaveText('译中')

    // 放行 docA 的后台翻译响应，确认其不中止并在后台自动完成写库
    releaseDelayedTranslation()
    await expect(page.getByTestId(`pdf-tab-translating-${docAId}`)).toHaveCount(0, { timeout: 10000 })

    // 切回 docA：译文已从 SQLite 自动加载完成，且没有重发第二轮整页请求
    await page.getByTestId(`pdf-tab-${docAId}`).locator('button.workspace-tab__select').click()
    await expect(page.locator('.translation-overlay-block.is-translated')).toHaveCount(8, { timeout: 10000 })
    await expect(page.locator('.translation-overlay-block.is-translated').first()).toContainText('后台持久译文：')
    expect(docATranslateRequestCount).toBe(1)
    expect(failures).toEqual([])
  } finally {
    releaseDelayedTranslation()
    await running.app.close()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
})

test('支持余额接口时翻译后自动刷新顶栏与 5 秒完成浮窗、触发低余额预警，并可在设置卡刷新与统计用量', async () => {
  let currentBalance = '18.42'
  let chatCalls = 0
  let balanceCalls = 0

  const server = createServer(async (req, res) => {
    if (req.url === '/deepseek/user/balance') {
      balanceCalls += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: 'CNY',
              total_balance: currentBalance,
              granted_balance: '0.00',
              topped_up_balance: currentBalance
            }
          ]
        })
      )
      return
    }

    chatCalls += 1
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: Array<{ role: string; content: string }>
    }
    const userPrompt = body.messages[body.messages.length - 1]?.content ?? ''
    const arrStart = userPrompt.lastIndexOf('[')
    const blocks = JSON.parse(userPrompt.slice(arrStart)) as Array<{ id: string; text: string }>
    const translations = blocks.map(item => ({
      id: item.id,
      text: `余额联动译文：${item.text.slice(0, 18)}`
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ translations }) } }],
        usage: { prompt_tokens: 1120, completion_tokens: 720, total_tokens: 1840 }
      })
    )
  })

  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()))
  const addr = server.address() as { port: number }
  const deepseekMockBase = `http://127.0.0.1:${addr.port}/deepseek/v1`

  const dataDir = await createTestData()
  const running = await launchApp(dataDir, { deviceScaleFactor: 1 })
  const failures: string[] = []
  running.page.on('pageerror', error => failures.push(error.message))

  try {
    const { app, page } = running
    await importFixture(app, page, 'verification/layout-analysis/' + layoutManifest.file.name)
    await page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '双栏', exact: true }).click()
    await waitForPageReady(page, 1)

    await page.getByRole('button', { name: '翻译设置', exact: true }).click()
    await page.getByLabel('API Base URL', { exact: true }).fill(deepseekMockBase)
    await page.getByLabel('API 模型名称', { exact: true }).fill('deepseek-chat')
    await page.getByLabel('API Key', { exact: true }).fill('sk-deepseek-e2e-9999')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const engineBtn = page.getByTestId('header-engine-btn')
    await expect(engineBtn).toContainText('API · deepseek-chat · 余 ¥18.42')
    await expect(engineBtn).toHaveAttribute('data-billing-tone', 'ok')

    await page.getByRole('button', { name: '翻译本页', exact: true }).click()
    const usageToast = page.getByTestId('translation-usage-toast')
    await expect(usageToast).toBeVisible({ timeout: 15000 })
    await expect(usageToast).toHaveAttribute('data-tone', 'ok')
    await expect(usageToast).toContainText('1,840 tokens')
    await expect(usageToast).toContainText('¥18.42')
    // 5 秒后自动消失
    await expect(usageToast).toBeHidden({ timeout: 7500 })

    // 模拟余额降至 ¥1.20（低于默认预警阈值 ¥2.00），重译本页后变橙色低余额预警
    currentBalance = '1.20'
    await page.getByRole('button', { name: '重译本页', exact: true }).click()
    await expect(usageToast).toBeVisible({ timeout: 15000 })
    await expect(usageToast).toHaveAttribute('data-tone', 'warn')
    await expect(usageToast).toContainText('余额偏低：剩余 ¥1.20')
    await expect(engineBtn).toContainText('余 ¥1.20 ⚠')
    await expect(engineBtn).toHaveAttribute('data-billing-tone', 'warn')

    // 打开设置弹窗查看余额与累计 Token 明细卡并测试手动刷新
    await page.getByRole('button', { name: '翻译设置', exact: true }).click()
    const usageCard = page.getByTestId('usage-balance-card')
    await expect(usageCard).toBeVisible()
    await expect(page.getByTestId('usage-balance-value')).toContainText('¥ 1.20')
    await expect(page.getByTestId('usage-today-tokens')).toContainText('3,680 tok')

    currentBalance = '25.00'
    await page.getByTestId('refresh-balance-btn').click()
    await expect(page.getByTestId('usage-balance-value')).toContainText('¥ 25.00')

    // 切到「本机 AI CLI」页签时实时跟随切换且隐藏 API 计价输入框；切回「OpenAI 兼容 API」不再串台残留 CLI 文案
    await page.getByRole('button', { name: /本机 AI CLI/ }).click()
    await expect(page.getByTestId('usage-balance-value')).toHaveText('CLI 订阅配额')
    await expect(page.getByTestId('refresh-balance-btn')).toHaveCount(0)
    await expect(page.getByLabel('低余额预警线', { exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: /OpenAI 兼容 API/ }).click()
    await expect(page.getByTestId('usage-balance-value')).toContainText('¥ 25.00')
    await expect(page.getByTestId('refresh-balance-btn')).toBeVisible()
    await expect(page.getByLabel('低余额预警线', { exact: true })).toBeVisible()
    await expect(usageCard).not.toContainText('CLI 订阅配额')
    await expect(usageCard).not.toContainText('本机 AI CLI')

    // 点击 OpenAI / Ollama 预设时，余额卡片状态同步切换而不沿用旧服务商余额
    await page.getByRole('button', { name: 'OpenAI', exact: true }).click()
    await expect(page.getByTestId('usage-balance-value')).toHaveText('服务商未开放')
    await page.getByRole('button', { name: 'Ollama（本机离线）', exact: true }).click()
    await expect(page.getByTestId('usage-balance-value')).toHaveText('本机离线免费')

    await page.getByRole('button', { name: '关闭设置', exact: true }).click()

    expect(chatCalls).toBe(2)
    expect(balanceCalls).toBeGreaterThanOrEqual(4)
    expect(failures).toEqual([])
  } finally {
    await running.app.close()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
})

test('默认原文显示（恢复关闭前双栏/译文）、未配置引擎可点击小窗跳设置、非中文 PDF 自动预译前两页而中文 PDF 不触发（合成素材）', async () => {
  const requests: Array<{ firstText: string }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: Array<{ role: string; content: string }>
    }
    const userPrompt = body.messages[body.messages.length - 1]?.content ?? ''
    const arrStart = userPrompt.lastIndexOf('[')
    const blocks = JSON.parse(userPrompt.slice(arrStart)) as Array<{ id: string; text: string }>
    const isTestPing = blocks.length === 1 && blocks[0]?.id === 'test-b001'
    if (!isTestPing && blocks[0]?.text) {
      requests.push({ firstText: blocks[0].text })
    }
    const translations = blocks.map(item => ({
      id: item.id,
      text: `预译：${item.text.slice(0, 22)}`
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }))
  })

  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()))
  const apiBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`

  const workDir = await mkdtemp(join(tmpdir(), 'paperflow-auto-pretrans-'))
  const zhPdfPath = join(workDir, 'synthetic-zh-paper.pdf')
  const en1Path = join(workDir, 'synthetic-en-paper-1.pdf')
  const en2Path = join(workDir, 'synthetic-en-paper-2.pdf')

  const makeEnglishPdf = async (filePath: string, prefix: string): Promise<void> => {
    const doc = await PDFDocument.create()
    for (let p = 1; p <= 3; p += 1) {
      const page = doc.addPage()
      page.drawText(
        `${prefix} Page ${p} Marker: Distributed in-memory transaction processing across RDMA clusters.`,
        { x: 48, y: 720, size: 12 }
      )
      page.drawText(
        `This English academic paragraph evaluates cache coherence and tail latency on page ${p}.`,
        { x: 48, y: 696, size: 10.5 }
      )
    }
    await writeFile(filePath, new Uint8Array(await doc.save()))
  }
  await makeEnglishPdf(en1Path, 'EN1')
  await makeEnglishPdf(en2Path, 'EN2')

  const importLocalPath = async (
    appInstance: Awaited<ReturnType<typeof launchApp>>['app'],
    pageInstance: Page,
    filePath: string
  ): Promise<void> => {
    await appInstance.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
    }, filePath)
    await pageInstance.getByRole('button', { name: '导入 PDF', exact: true }).click()
    await expect(pageInstance.getByRole('button', { name: '导入 PDF', exact: true })).toBeEnabled({ timeout: 30000 })
  }

  const dataDir = await createTestData()
  let running = await launchApp(dataDir, { deviceScaleFactor: 1 })
  const failures: string[] = []
  running.page.on('pageerror', error => failures.push(error.message))

  try {
    const { app, page } = running

    // 生成真实包含中文可提取文本的双页合成中文 PDF（合成素材）
    const zhPdfBytes = await app.evaluate(async ({ BrowserWindow }) => {
      const win = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true } })
      try {
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;padding:48px;font-size:15px;line-height:1.8;} .p2{page-break-before:always;}</style></head><body><h1>基于分布式内存架构的高性能事务引擎研究</h1><p>随着高速互联网络与非易失性存储硬件的发展，传统单机数据库在扩展性与尾延迟控制方面面临显著挑战。本文提出一种面向分布式存储集群的协同缓冲池机制。</p><div class="p2"><h2>第二节 核心架构</h2><p>通过局部性感知调度与远程内存访问优化，系统实现了稳定且高效的多节点事务处理吞吐。</p></div></body></html>`
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        const buf = await win.webContents.printToPDF({ printBackground: false })
        return Array.from(buf)
      } finally {
        win.destroy()
      }
    })
    await writeFile(zhPdfPath, Buffer.from(zhPdfBytes))

    // 1. 未配置引擎时打开中文 PDF：默认显示原文，且不弹出未配置提醒、不发起翻译
    await importLocalPath(app, page, zhPdfPath)
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', {
      timeout: 30000
    })
    await expect(page.locator('.pdf-page[data-page-number="1"] .textLayer')).toContainText('高性能事务引擎', {
      timeout: 15000
    })
    await expect(page.locator('.translation-panel')).toHaveCount(0)
    await page.waitForTimeout(800)
    await expect(page.getByTestId('translation-unconfigured-prompt')).toHaveCount(0)
    expect(requests.length).toBe(0)

    // 2. 未配置引擎时打开英文 3 页 PDF（en1）：默认显示原文，弹出可点击的未配置小窗口；点击后跳到「翻译与 AI 引擎设置」
    await importLocalPath(app, page, en1Path)
    await expect(page.locator('.pdf-page[data-page-number="1"] .textLayer')).toContainText('EN1 Page 1 Marker', {
      timeout: 20000
    })
    await expect(page.locator('.translation-panel')).toHaveCount(0)
    await expect(
      page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '原文', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')

    const promptToast = page.getByTestId('translation-unconfigured-prompt')
    await expect(promptToast).toBeVisible({ timeout: 10000 })
    await promptToast.click()

    const settingsDialog = page.getByRole('dialog', { name: '翻译与 AI 引擎设置', exact: true })
    await expect(settingsDialog).toBeVisible()
    await page.getByLabel('API Base URL', { exact: true }).fill(apiBaseUrl)
    await page.getByLabel('API 模型名称', { exact: true }).fill('mock-auto-pretrans-v1')
    await page.getByLabel('API Key', { exact: true }).fill('sk-auto-e2e-123456')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(settingsDialog).toHaveCount(0)

    // 保存后仍停留在「原文」模式，同时后台自动预译前 2 页（第 3 页不预译）
    await expect.poll(() => requests.filter(r => r.firstText.includes('EN1 Page 1 Marker')).length, { timeout: 15000 }).toBe(1)
    await expect.poll(() => requests.filter(r => r.firstText.includes('EN1 Page 2 Marker')).length, { timeout: 15000 }).toBe(1)
    await expect(requests.filter(r => r.firstText.includes('EN1 Page 3 Marker')).length).toBe(0)

    // 切换至「双栏」验证前两页译文已就绪，第 3 页未翻译
    await page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '双栏', exact: true }).click()
    await waitForPageReady(page, 1)
    await expect(
      page.locator('.translation-page[data-page-number="1"] .translation-overlay-block.is-translated').first()
    ).toContainText('预译：', { timeout: 15000 })
    await page.getByRole('spinbutton', { name: '当前页码' }).fill('2')
    await page.getByRole('spinbutton', { name: '当前页码' }).press('Enter')
    await waitForPageReady(page, 2)
    await expect(
      page.locator('.translation-page[data-page-number="2"] .translation-overlay-block.is-translated').first()
    ).toContainText('预译：', { timeout: 15000 })
    await page.getByRole('spinbutton', { name: '当前页码' }).fill('3')
    await page.getByRole('spinbutton', { name: '当前页码' }).press('Enter')
    await waitForPageReady(page, 3)
    await expect(page.locator('.translation-page[data-page-number="3"] .translation-overlay-block.is-translated')).toHaveCount(0)

    // 3. 已配置状态下打开全新英文 PDF（en2）：默认显示原文，且自动后台预译第 1-2 页（第 3 页不译）
    await importLocalPath(app, page, en2Path)
    await expect(page.locator('.pdf-page[data-page-number="1"] .textLayer')).toContainText('EN2 Page 1 Marker', {
      timeout: 20000
    })
    await expect(page.locator('.translation-panel')).toHaveCount(0)
    await expect(promptToast).toHaveCount(0)
    await expect.poll(() => requests.filter(r => r.firstText.includes('EN2 Page 1 Marker')).length, { timeout: 15000 }).toBe(1)
    await expect.poll(() => requests.filter(r => r.firstText.includes('EN2 Page 2 Marker')).length, { timeout: 15000 }).toBe(1)
    expect(requests.filter(r => r.firstText.includes('EN2 Page 3 Marker')).length).toBe(0)

    // 4. 切回 en1 并设为「译文」模式，重启后应恢复「译文」模式；切回中文 PDF 仍保持「原文」模式且不翻译
    const docs = await page.evaluate(() => window.paperflow.listDocuments())
    const zhDoc = docs.find(d => d.originalFilename === 'synthetic-zh-paper.pdf')!
    const en1Doc = docs.find(d => d.originalFilename === 'synthetic-en-paper-1.pdf')!
    await page.getByTestId(`pdf-tab-${en1Doc.id}`).locator('button.workspace-tab__select').click()
    await page.getByRole('spinbutton', { name: '当前页码' }).fill('1')
    await page.getByRole('spinbutton', { name: '当前页码' }).press('Enter')
    await waitForPageReady(page, 1)
    await page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '译文', exact: true }).click()
    await expect(
      page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '译文', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')

    await running.app.close()
    running = await launchApp(dataDir, { deviceScaleFactor: 1 })
    const p2 = running.page
    p2.on('pageerror', error => failures.push(error.message))

    await expect(
      p2.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '译文', exact: true })
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 })
    await expect(p2.locator('.translation-page[data-page-number="1"] .translation-overlay-block.is-translated').first()).toBeVisible({
      timeout: 15000
    })

    await p2.getByTestId(`pdf-tab-${zhDoc.id}`).locator('button.workspace-tab__select').click()
    await expect(p2.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', {
      timeout: 20000
    })
    await expect(
      p2.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '原文', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(p2.locator('.translation-panel')).toHaveCount(0)
    expect(requests.filter(r => r.firstText.includes('分布式') || r.firstText.includes('协同缓冲池')).length).toBe(0)

    expect(failures).toEqual([])
  } finally {
    await running.app.close()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    await rm(workDir, { recursive: true, force: true })
  }
})
