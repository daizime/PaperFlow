import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
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

    // 1. 导入双栏学术 PDF，验证默认 1:1 等宽对半展示、文献库可收起与单双栏模式切换
    await importFixture(app, page, 'verification/layout-analysis/' + layoutManifest.file.name)
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
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.locator('.translation-modal__status--ok')).toContainText('连接成功')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

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
        return text ? text.scrollHeight > el.clientHeight + 2 : false
      }).length
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

    // (2) 左侧拖选文字 ("Every sentence keeps unscaled boxes.") -> 右侧同步渲染多边形高亮对应中文句且不重叠渲染左侧 .pdf-sentence-highlight
    const dragLeftSpan = page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'Every sentence keeps unscaled boxes.' })
      .first()
    const dragLeftBox = (await dragLeftSpan.boundingBox())!
    await page.mouse.move(dragLeftBox.x + 2, dragLeftBox.y + dragLeftBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(dragLeftBox.x + dragLeftBox.width - 2, dragLeftBox.y + dragLeftBox.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(0)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    const activeTargetAfterLeftDrag = page.locator('.translation-page[data-page-number="1"] .translation-overlay-sentence.is-active')
    await expect(activeTargetAfterLeftDrag).toHaveCount(1)
    await expect(activeTargetAfterLeftDrag.first()).toContainText('每个句子均维持未缩放坐标框')

    // (2b) 左侧同行第二句起手处精确拖选 ("As shown in"，紧接同一行上一句 "Smith et al., 2025)." 之后) -> 右侧只高亮第 2 句 ("如图 1 所示...")，不能串扰前半句 ("现代阅读器...")
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
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-highlight-layer .pdf-sentence-highlight')).toHaveCount(0)
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-sentence-polygon')).toHaveCount(1)
    const activeTargetAfterMidLineDrag = page.locator(
      '.translation-page[data-page-number="1"] .translation-overlay-sentence.is-active'
    )
    await expect(activeTargetAfterMidLineDrag).toHaveCount(1)
    await expect(activeTargetAfterMidLineDrag.first()).toContainText('如图 1 所示')
    await expect(activeTargetAfterMidLineDrag.first()).not.toContainText('现代阅读器')

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

    // 4. 重启应用后验证从 SQLite 缓存直接恢复译文（不再请求远端）
    const callsAfterFirstTranslate = httpRequests
    await running.app.close()
    running = await launchApp(dataDir, { deviceScaleFactor: 1 })
    const p2 = running.page
    p2.on('pageerror', error => failures.push(error.message))

    await waitForPageReady(p2, 1)
    await expect(p2.locator('.translation-overlay-block.is-translated')).toHaveCount(8, { timeout: 15000 })
    await expect(p2.locator('.translation-overlay-block.is-translated').first()).toContainText('面向本地科研阅读器的确定性版面流水线')
    expect(httpRequests).toBe(callsAfterFirstTranslate)

    // 5. 切换为本机 CLI 模式（Node 桩脚本），测试连接并执行重译本页
    await p2.getByRole('button', { name: '翻译设置', exact: true }).click()
    await p2.getByRole('button', { name: /本机 AI CLI/ }).click()
    await p2.getByRole('button', { name: '自定义 CLI', exact: true }).click()
    await p2.getByLabel('CLI 命令', { exact: true }).fill(process.execPath)
    await p2.getByLabel('CLI 附加参数', { exact: true }).fill(cliStubPath)
    await p2.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(p2.locator('.translation-modal__status--ok')).toContainText('连接成功')
    await p2.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(p2.getByRole('dialog')).toHaveCount(0)

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
