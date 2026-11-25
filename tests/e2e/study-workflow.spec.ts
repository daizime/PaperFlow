import { expect, test, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('方案三固定顶栏防抖动、连续译、单段重译、术语表、划句解释与批注持久化导出', async () => {
  const recordedPrompts: string[] = []
  let singleRetranslateMode = false

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      const body = JSON.parse(await readRequestBody(req)) as {
        messages?: Array<{ role: string; content: string }>
      }
      const userMsg = body.messages?.[body.messages.length - 1]?.content ?? ''
      recordedPrompts.push(userMsg)

      if (/Reply strictly with:\s*OK/i.test(userMsg)) {
        writeJson(res, 200, { choices: [{ message: { content: 'OK' } }] })
        return
      }

      if (userMsg.includes('目标公式/表达式')) {
        writeJson(res, 200, {
          choices: [{ message: { content: '公式精解：E 代表总能量，m 为静止质量，c 为光速常数，alpha 为偏移系数。' } }]
        })
        return
      }

      if (userMsg.includes('对下方选中的论文片段做精要解读')) {
        writeJson(res, 200, {
          choices: [{ message: { content: 'AI精读：该句说明每个句子均保持未缩放坐标框，用于确定性版面流水线对齐。' } }]
        })
        return
      }

      const rawJson = userMsg.slice(userMsg.lastIndexOf('\n') + 1)
      const items = JSON.parse(rawJson) as Array<{ id: string; text: string }>
      const translations = items.map(item => ({
        id: item.id,
        text:
          singleRetranslateMode && items.length === 1
            ? '单段重译完成：确定性版面流水线（已刷新译文）'
            : `测试译文：${item.text}`
      }))
      writeJson(res, 200, { choices: [{ message: { content: JSON.stringify({ translations }) } }] })
      return
    }
    writeJson(res, 404, { error: 'not found' })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Mock OpenAI server failed to bind')
  const apiBaseUrl = `http://127.0.0.1:${addr.port}/v1`

  const exportTempDir = await mkdtemp(join(tmpdir(), 'paperflow-md-export-'))
  const exportFilePath = join(exportTempDir, 'study-notes.md')
  const dataDir = await createTestData()
  let running = await launchApp(dataDir, { deviceScaleFactor: 1 })
  const failures: string[] = []
  running.page.on('pageerror', error => failures.push(error.message))

  try {
    const { app, page } = running
    await importFixture(app, page, 'verification/layout-analysis/' + layoutManifest.file.name)
    await waitForPageReady(page, 1)

    // 1. 验证方案三：拖拽中间分屏轴时，顶部统一工具栏按钮 0 位移、底部悬浮胶囊保持单行且不与正文顶边错位
    const topbarSelectors = [
      { role: 'button' as const, name: '文档目录' },
      { role: 'button' as const, name: '文内搜索' },
      { role: 'button' as const, name: '原文' },
      { role: 'button' as const, name: '双栏' },
      { role: 'button' as const, name: '译文' },
      { role: 'button' as const, name: '翻译本页' },
      { role: 'button' as const, name: '连续翻译后续页' },
      { role: 'button' as const, name: '打开新 PDF' }
    ]
    const initialTopbarBoxes = await Promise.all(
      topbarSelectors.map(async sel => (await page.getByRole(sel.role, { name: sel.name, exact: true }).boundingBox())!)
    )
    const initialPillBox = (await page.locator('.reader-floating-pill').boundingBox())!
    expect(initialPillBox.height).toBeLessThanOrEqual(44)

    const resizerBox = (await page.getByRole('separator', { name: '调整双栏分屏比例', exact: true }).boundingBox())!
    const midY = resizerBox.y + resizerBox.height / 2
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, midY)
    await page.mouse.down()
    await page.mouse.move(resizerBox.x + resizerBox.width / 2 - 150, midY, { steps: 10 })
    await page.mouse.up()

    for (let i = 0; i < topbarSelectors.length; i += 1) {
      const boxAfterLeft = (await page.getByRole(topbarSelectors[i].role, { name: topbarSelectors[i].name, exact: true }).boundingBox())!
      expect(Math.abs(boxAfterLeft.x - initialTopbarBoxes[i].x)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(boxAfterLeft.y - initialTopbarBoxes[i].y)).toBeLessThanOrEqual(0.5)
    }
    const pillAfterLeft = (await page.locator('.reader-floating-pill').boundingBox())!
    expect(pillAfterLeft.height).toBeLessThanOrEqual(44)

    const scrollTopDiff = await page.evaluate(() => {
      const l = document.querySelector('.pdf-scroll')!.getBoundingClientRect().top
      const r = document.querySelector('.translation-scroll')!.getBoundingClientRect().top
      return Math.abs(l - r)
    })
    expect(scrollTopDiff).toBeLessThanOrEqual(1)

    // 恢复 1:1 分屏
    await page.getByRole('separator', { name: '调整双栏分屏比例', exact: true }).dblclick()

    // 2. 配置 OpenAI 兼容服务 + 自定义术语表并保存
    await page.getByRole('button', { name: '翻译设置', exact: true }).click()
    await page.getByLabel('API Base URL', { exact: true }).fill(apiBaseUrl)
    await page.getByLabel('API 模型名称', { exact: true }).fill('mock-study-v1')
    await page.getByLabel('API Key', { exact: true }).fill('sk-study-e2e-998877')
    await page.getByLabel('自定义术语表', { exact: true }).fill('layout pipeline => 版面流水线')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // 3. 点击「连续译」，验证两页均译出且提示词包含术语表
    await page.getByRole('button', { name: '连续翻译后续页', exact: true }).click()
    await expect(page.locator('.translation-page[data-page-number="1"] .translation-overlay-block.is-translated').first()).toBeVisible({
      timeout: 15000
    })
    await expect(page.locator('.translation-page[data-page-number="2"] .translation-overlay-block.is-translated').first()).toBeVisible({
      timeout: 15000
    })
    expect(recordedPrompts.some(p => p.includes('- layout pipeline => 版面流水线'))).toBe(true)

    // 4. 悬停并点击第一块译文的单段重译按钮「↻」
    singleRetranslateMode = true
    const firstBlock = page.locator('.translation-page[data-page-number="1"] .translation-overlay-block.is-translated').first()
    await firstBlock.scrollIntoViewIfNeeded()
    await firstBlock.hover()
    await firstBlock.getByRole('button', { name: '重译此段', exact: true }).click()
    await expect(firstBlock).toContainText('单段重译完成：确定性版面流水线（已刷新译文）', { timeout: 10000 })

    // 5. 划句联动伴读工具栏 + AI 解释 + 存为笔记 + SVG 多色高亮
    const sentenceSpan = page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'Every sentence keeps unscaled boxes.' })
      .first()
    await sentenceSpan.scrollIntoViewIfNeeded()
    const sentenceBox = (await sentenceSpan.boundingBox())!
    await page.mouse.click(sentenceBox.x + sentenceBox.width / 2, sentenceBox.y + sentenceBox.height / 2)

    const companionBar = page.locator('.study-companion-bar')
    await expect(companionBar).toBeVisible()
    // 确认伴读条位于底部悬浮胶囊之上且不重叠
    const companionBox = (await companionBar.boundingBox())!
    const currentPillBox = (await page.locator('.reader-floating-pill').boundingBox())!
    expect(companionBox.y + companionBox.height).toBeLessThanOrEqual(currentPillBox.y + 1)

    await page.getByRole('button', { name: 'AI 解释选中内容', exact: true }).click()
    await expect(page.locator('.study-explain-card__answer')).toContainText('确定性版面流水线对齐', { timeout: 10000 })
    await page.getByRole('button', { name: '存为笔记', exact: true }).click()
    await expect(page.getByRole('button', { name: '批注与笔记', exact: true })).toContainText('批注 (1)')
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-annotation-highlight--blue').first()).toBeVisible()

    await page.getByRole('button', { name: '关闭解读卡片', exact: true }).click()

    // 6. 测试公式解析 & 添加第二条黄色高亮笔记
    const secondSpan = page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'Fig. 1, the scale factor' })
      .first()
    await secondSpan.scrollIntoViewIfNeeded()
    const secondBox = (await secondSpan.boundingBox())!
    await page.mouse.click(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2)

    await page.getByRole('button', { name: '解释公式', exact: true }).click()
    await expect(page.locator('.study-explain-card__answer')).toContainText('光速常数', { timeout: 10000 })
    await page.getByRole('button', { name: '关闭解读卡片', exact: true }).click()

    await page.getByRole('button', { name: '添加批注笔记', exact: true }).click()
    await page.getByLabel('批注笔记输入框', { exact: true }).fill('第二条精读笔记')
    await page.getByRole('button', { name: '保存批注', exact: true }).click()
    await expect(page.getByRole('button', { name: '批注与笔记', exact: true })).toContainText('批注 (2)')
    await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-annotation-highlight--yellow').first()).toBeVisible()

    // 7. 打开批注面板，验证筛选、编辑及重启持久化
    await page.getByRole('button', { name: '批注与笔记', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: '批注与笔记面板', exact: true })
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.study-annotation-card')).toHaveCount(2)

    await drawer.getByRole('button', { name: '蓝', exact: true }).click()
    await expect(drawer.locator('.study-annotation-card')).toHaveCount(1)
    await drawer.getByRole('button', { name: '全部', exact: true }).click()
    await expect(drawer.locator('.study-annotation-card')).toHaveCount(2)

    // 重启应用确认 SQLite v3 批注与高亮完整恢复
    await running.app.close()
    running = await launchApp(dataDir, { deviceScaleFactor: 1 })
    const p2 = running.page
    p2.on('pageerror', error => failures.push(error.message))

    await waitForPageReady(p2, 1)
    await expect(p2.getByRole('button', { name: '批注与笔记', exact: true })).toContainText('批注 (2)', {
      timeout: 15000
    })
    await expect(p2.locator('.pdf-page[data-page-number="1"] .pdf-annotation-highlight--blue').first()).toBeVisible()
    await expect(p2.locator('.pdf-page[data-page-number="1"] .pdf-annotation-highlight--yellow').first()).toBeVisible()

    // 8. 模拟保存对话框导出 Markdown 并在面板中删除一条批注
    await p2.getByRole('button', { name: '批注与笔记', exact: true }).click()
    const drawer2 = p2.getByRole('dialog', { name: '批注与笔记面板', exact: true })
    await running.app.evaluate(({ dialog }, targetPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath })
    }, exportFilePath)
    await drawer2.getByRole('button', { name: /导出 Markdown/ }).click()
    await expect(drawer2.locator('.study-drawer__status')).toContainText('study-notes.md', { timeout: 10000 })
    // 确认 UI 状态栏不泄露完整本地绝对路径，且磁盘文件真实写入 UTF-8 Markdown
    await expect(drawer2.locator('.study-drawer__status')).not.toContainText(exportTempDir)

    const exportedMd = await readFile(exportFilePath, 'utf8')
    expect(exportedMd).toContain('## 第 1 页')
    expect(exportedMd).toContain('Every sentence keeps unscaled boxes.')
    expect(exportedMd).toContain('第二条精读笔记')

    await drawer2.locator('.study-annotation-card').first().getByRole('button', { name: '删除', exact: true }).click()
    await expect(p2.getByRole('button', { name: '批注与笔记', exact: true })).toContainText('批注 (1)')

    expect(failures).toEqual([])
  } finally {
    await running.app.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(exportTempDir, { recursive: true, force: true })
  }
})
