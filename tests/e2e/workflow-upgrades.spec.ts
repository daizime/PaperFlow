import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { createTestData, launchApp } from './helpers'

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

async function importPdfPath(app: ElectronApplication, page: Page, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, filePath)
  await page.getByRole('button', { name: '导入 PDF', exact: true }).click()
  await expect(page.getByRole('button', { name: '导入 PDF', exact: true })).toBeEnabled({ timeout: 30000 })
}

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

test('全量三大工作流优化：后台连续译与分片跳过、手工改译导出、AI 页码跳转与自定义技能、阅读状态与 OpenAlex/BibTeX 导出', async () => {
  const recordedTranslatedTexts: string[] = []
  const customSkillPrompts: string[] = []
  let chatCallCount = 0

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (
      req.method === 'GET' &&
      (reqUrl.pathname === '/openalex/works' || reqUrl.pathname.startsWith('/openalex/works/'))
    ) {
      const mockWork = {
        id: 'https://openalex.org/W99001',
        doi: 'https://doi.org/10.1145/3514221',
        title: 'ScaleStore: A Fast and Cost-Efficient Storage Engine',
        publication_year: 2022,
        primary_location: { source: { display_name: 'SIGMOD 2022' } },
        authorships: [{ author: { display_name: 'Tobias Ziegler' } }]
      }
      if (reqUrl.pathname.startsWith('/openalex/works/')) {
        writeJson(res, 200, mockWork)
      } else {
        writeJson(res, 200, { results: [mockWork] })
      }
      return
    }

    if (req.method === 'POST' && reqUrl.pathname.endsWith('/chat/completions')) {
      const body = JSON.parse(await readRequestBody(req)) as {
        messages?: Array<{ role: string; content: string }>
      }
      const joined = (body.messages ?? []).map(m => m.content).join('\n')
      const userMsg = body.messages?.[body.messages.length - 1]?.content ?? ''

      if (/Reply strictly with:\s*OK/i.test(userMsg)) {
        writeJson(res, 200, { choices: [{ message: { content: 'OK' } }] })
        return
      }

      if (joined.includes('请逐条列出实验瓶颈与基线不足')) {
        customSkillPrompts.push(joined)
        writeJson(res, 200, {
          choices: [
            {
              message: {
                content: '自定义技能结论：P.2 显示实验仍缺少更大规模多节点故障恢复测试。'
              }
            }
          ]
        })
        return
      }

      const rawJson = userMsg.slice(userMsg.lastIndexOf('\n') + 1).trim()
      if (rawJson.startsWith('[')) {
        try {
          const items = JSON.parse(rawJson) as Array<{ id: string; text: string }>
          let hasPage2 = false
          for (const item of items) {
            recordedTranslatedTexts.push(item.text)
            if (item.text.includes('Experiments show higher throughput')) {
              hasPage2 = true
            }
          }
          if (hasPage2) {
            await new Promise(resolve => setTimeout(resolve, 650))
          }
          const translations = items.map(item => ({
            id: item.id,
            text: `译文：${item.text}`
          }))
          writeJson(res, 200, { choices: [{ message: { content: JSON.stringify({ translations }) } }] })
          return
        } catch {
          // 落入常规对话分支
        }
      }

      chatCallCount += 1
      const reply =
        chatCallCount === 1
          ? '核心结论见 P.2，实验吞吐量提升显著。'
          : '重新生成的回答：详见 P.1 架构。'
      writeJson(res, 200, {
        choices: [{ message: { role: 'assistant', content: reply } }]
      })
      return
    }

    writeJson(res, 404, { error: 'not found' })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Mock server failed to bind')
  const serverOrigin = `http://127.0.0.1:${addr.port}`

  const prevTestLitEnv = process.env.PAPERFLOW_TEST_LITERATURE_BASE
  process.env.PAPERFLOW_TEST_LITERATURE_BASE = serverOrigin

  const workDir = await mkdtemp(join(tmpdir(), 'paperflow-upgrades-e2e-'))
  const dataDir = await createTestData()

  // 合成双 PDF：3 页论文 A（含第 3 页 References）+ 1 页独立论文 B（用于验证切走不中断后台连续译）
  const pdfADoc = await PDFDocument.create()
  const p1 = pdfADoc.addPage()
  p1.drawText('ScaleStore introduces a fast distributed storage engine with low latency.', { x: 48, y: 720, size: 12 })
  const p2 = pdfADoc.addPage()
  p2.drawText('Experiments show higher throughput on NVMe and RDMA clusters.', { x: 48, y: 720, size: 12 })
  const p3 = pdfADoc.addPage()
  p3.drawText('References', { x: 48, y: 740, size: 14 })
  p3.drawText('[1] Baseline Study on Distributed Storage.', { x: 48, y: 710, size: 11 })
  const pdfAPath = join(workDir, 'paper-a.pdf')
  await writeFile(pdfAPath, await pdfADoc.save())

  const pdfBDoc = await PDFDocument.create()
  const bp1 = pdfBDoc.addPage()
  bp1.drawText('Independent paper B for switching during background batch translation.', { x: 48, y: 720, size: 12 })
  const pdfBPath = join(workDir, 'paper-b.pdf')
  await writeFile(pdfBPath, await pdfBDoc.save())

  let running = await launchApp(dataDir, { deviceScaleFactor: 1 })
  const failures: string[] = []
  running.page.on('pageerror', err => failures.push(err.message))

  try {
    let { app, page } = running

    await importPdfPath(app, page, pdfBPath)
    await waitForPageReady(page, 1)
    await importPdfPath(app, page, pdfAPath)
    await waitForPageReady(page, 1)

    const docs = await page.evaluate(() => window.paperflow.listDocuments())
    const docA = docs.find(d => d.originalFilename === 'paper-a.pdf')!
    const docB = docs.find(d => d.originalFilename === 'paper-b.pdf')!
    expect(docA).toBeTruthy()
    expect(docB).toBeTruthy()

    // 1. 轨道一：配置 OpenAI 与可选预译开关，验证区间+自动跳过 References 后台连续译
    await page.getByRole('button', { name: '翻译设置', exact: true }).click()
    await page.getByLabel('API Base URL', { exact: true }).fill(`${serverOrigin}/v1`)
    await page.getByLabel('API 模型名称', { exact: true }).fill('mock-upgrade-v1')
    await page.getByLabel('API Key', { exact: true }).fill('sk-upgrade-e2e-123')

    const prefetchToggle = page.getByTestId('prefetch-next-page-toggle')
    await expect(prefetchToggle).not.toBeChecked()
    await prefetchToggle.check()
    expect(await page.evaluate(() => window.localStorage.getItem('paperflow:prefetch-next-page'))).toBe('true')
    await prefetchToggle.uncheck()
    expect(await page.evaluate(() => window.localStorage.getItem('paperflow:prefetch-next-page'))).toBe('false')

    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.getByTestId('batch-translate-options-btn').click()
    await expect(page.getByTestId('batch-translate-popover')).toBeVisible()
    await page.getByTestId('batch-range-input').fill('1-3')
    await expect(page.getByTestId('batch-skip-references-checkbox')).toBeChecked()
    await page.getByTestId('batch-translate-start-btn').click()

    // 立即切往论文 B，确认论文 A 后台连续译不被打断，侧栏展示状态指示
    await page.getByTestId(`tree-doc-${docB.id}`).locator('.library-tree-doc-btn').click()
    await expect(page.locator('.pdf-page[data-page-number="1"] .textLayer')).toContainText('Independent paper B', {
      timeout: 15000
    })
    await expect(page.getByTestId(`library-doc-translating-${docA.id}`)).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId(`library-doc-translating-${docA.id}`)).toBeHidden({ timeout: 25000 })

    // 切回论文 A，验证第 1-2 页已译且第 3 页 References 未提交给翻译模型
    await page.getByTestId(`tree-doc-${docA.id}`).locator('.library-tree-doc-btn').click()
    await waitForPageReady(page, 1)
    await expect(
      page.locator('.translation-page[data-page-number="1"] .translation-overlay-block.is-translated').first()
    ).toContainText('译文：', { timeout: 15000 })
    await expect(
      page.locator('.translation-page[data-page-number="2"] .translation-overlay-block.is-translated').first()
    ).toContainText('译文：', { timeout: 15000 })
    await expect(
      page.locator('.translation-page[data-page-number="3"] .translation-overlay-block.is-translated')
    ).toHaveCount(0)
    expect(recordedTranslatedTexts.some(t => t.includes('ScaleStore'))).toBe(true)
    expect(recordedTranslatedTexts.some(t => t.includes('Experiments show higher throughput'))).toBe(true)
    expect(recordedTranslatedTexts.some(t => t.includes('Baseline Study on Distributed Storage'))).toBe(false)

    // 2. 轨道一：单段手工修改译文 + 导出双语 Markdown 与纯译文 PDF
    const p1Block = page.locator('.translation-page[data-page-number="1"] .translation-overlay-block.is-translated').first()
    await p1Block.scrollIntoViewIfNeeded()
    await p1Block.hover()
    await p1Block.getByTestId('translation-block-edit-btn').click()
    await expect(page.getByTestId('translation-block-editor')).toBeVisible()
    await page.getByTestId('translation-block-edit-input').fill('人工精修译文：ScaleStore 分布式存储引擎')
    await page.getByTestId('translation-block-edit-save').click()
    await expect(p1Block).toContainText('人工精修译文：ScaleStore 分布式存储引擎')

    const exportMdPath = join(workDir, 'paper-a-bilingual.md')
    await app.evaluate(({ dialog }, targetPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath })
    }, exportMdPath)
    await page.getByTestId('translation-export-btn').click()
    await expect(page.getByTestId('translation-export-popover')).toBeVisible()
    await page.getByTestId('translation-export-bilingual-md').click()
    await expect.poll(async () => {
      try {
        return await readFile(exportMdPath, 'utf8')
      } catch {
        return ''
      }
    }).toContain('人工精修译文：ScaleStore 分布式存储引擎')
    const mdText = await readFile(exportMdPath, 'utf8')
    expect(mdText).toContain('ScaleStore introduces a fast distributed storage engine')

    const exportPdfPath = join(workDir, 'paper-a-zh.pdf')
    await app.evaluate(({ dialog }, targetPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath })
    }, exportPdfPath)
    await page.getByTestId('translation-export-btn').click()
    await page.getByTestId('translation-export-zh-pdf').click()
    await expect.poll(async () => {
      try {
        const bytes = await readFile(exportPdfPath)
        return bytes.subarray(0, 5).toString('utf8')
      } catch {
        return ''
      }
    }, { timeout: 20000 }).toBe('%PDF-')
    const pdfBytes = await readFile(exportPdfPath)
    expect(pdfBytes.byteLength).toBeGreaterThan(1000)

    // 3. 轨道二：AI 对话页码跳转、存为批注、重新生成、自定义研究技能模板
    await page.getByTestId('ai-chat-toggle').click()
    const chatWidget = page.getByTestId('ai-chat-widget')
    await expect(chatWidget).toBeVisible()

    const chatInput = page.getByTestId('ai-chat-input')
    await chatInput.fill('总结存储引擎并标注页码')
    await page.getByTestId('ai-chat-send-btn').click()

    const assistantMsg = page.getByTestId('ai-chat-msg-assistant').last()
    await expect(assistantMsg).toContainText('实验吞吐量提升显著', { timeout: 15000 })
    const jumpPage2Btn = assistantMsg.getByTestId('ai-page-jump-2')
    await expect(jumpPage2Btn).toBeVisible()
    await jumpPage2Btn.click()
    await expect(page.getByLabel('当前页码', { exact: true })).toHaveValue('2')

    // 存为批注（rects 为空：不捏造 PDF 假框，抽屉显示「AI 笔记」）
    await page.getByTestId('ai-chat-save-note-btn').last().click()
    await expect(page.getByRole('button', { name: '批注与笔记', exact: true })).toContainText('批注 (1)', {
      timeout: 10000
    })
    await page.getByRole('button', { name: '批注与笔记', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: '批注与笔记面板', exact: true })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('AI 笔记', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭批注面板', exact: true }).click()
    await expect(page.locator('.pdf-annotation-highlight')).toHaveCount(0)

    // 重试重新生成回答
    await page.getByTestId('ai-chat-regenerate-btn').last().click()
    await expect(page.getByTestId('ai-chat-msg-assistant').last()).toContainText('重新生成的回答：详见 P.1 架构', {
      timeout: 15000
    })

    // 新建并执行自定义技能模板
    await page.getByTestId('ai-skill-trigger-btn').click()
    await expect(page.getByTestId('ai-skill-popover')).toBeVisible()
    await page.getByTestId('ai-custom-skill-new-btn').click()
    await expect(page.getByTestId('ai-custom-skill-form')).toBeVisible()
    await page.getByTestId('ai-custom-skill-name-input').fill('实验瓶颈排查')
    await page.getByTestId('ai-custom-skill-desc-input').fill('检查实验指标与局限性')
    await page.getByTestId('ai-custom-skill-prompt-input').fill('请逐条列出实验瓶颈与基线不足。')
    await page.getByTestId('ai-custom-skill-save-btn').click()

    const customSkillRunBtn = page.locator('[data-testid^="ai-custom-skill-run-"]').first()
    await expect(customSkillRunBtn).toBeVisible()
    await expect(customSkillRunBtn).toContainText('实验瓶颈排查')
    await customSkillRunBtn.click()
    await expect(page.getByTestId('ai-chat-msg-assistant').last()).toContainText('自定义技能结论', { timeout: 15000 })
    expect(customSkillPrompts.length).toBeGreaterThanOrEqual(1)

    // 4. 轨道三：三态阅读状态切换与筛选
    const docAStatusBtn = page.getByTestId(`doc-status-btn-${docA.id}`)
    await expect(docAStatusBtn).toHaveAttribute('data-reading-status', 'unread')
    await docAStatusBtn.click()
    await expect(docAStatusBtn).toHaveAttribute('data-reading-status', 'reading')
    await docAStatusBtn.click()
    await expect(docAStatusBtn).toHaveAttribute('data-reading-status', 'done')
    await expect(docAStatusBtn).toContainText('已读')

    await page.getByTestId('library-filter-toggle').click()
    await page.getByTestId('library-status-filter-done').click()
    await expect(page.locator('.library-tree-doc')).toHaveCount(1)
    await page.getByTestId('library-status-filter-all').click()
    await expect(page.locator('.library-tree-doc')).toHaveCount(2)
    await page.getByTestId('library-filter-toggle').click()

    // 5. 重启应用验证 DB v7 阅读状态、手工译文编辑、自定义技能持久保存及删除
    await app.close()
    running = await launchApp(dataDir, { deviceScaleFactor: 1 })
    app = running.app
    page = running.page
    page.on('pageerror', err => failures.push(err.message))

    await expect(page.getByTestId(`doc-status-btn-${docA.id}`)).toHaveAttribute('data-reading-status', 'done', {
      timeout: 15000
    })

    await page.getByTestId(`tree-doc-${docA.id}`).locator('.library-tree-doc-btn').click()
    await waitForPageReady(page, 1)
    await expect(
      page.locator('.translation-page[data-page-number="1"] .translation-overlay-block.is-translated').first()
    ).toContainText('人工精修译文：ScaleStore 分布式存储引擎', { timeout: 15000 })

    // 验证自定义技能持久化后可删
    if (!(await page.getByTestId('ai-chat-widget').isVisible().catch(() => false))) {
      await page.getByTestId('ai-chat-toggle').click()
    }
    await page.getByTestId('ai-skill-trigger-btn').click()
    await expect(page.locator('[data-testid^="ai-custom-skill-run-"]')).toHaveCount(1)
    await page.locator('[data-testid^="ai-custom-skill-delete-"]').first().click()
    await expect(page.locator('[data-testid^="ai-custom-skill-run-"]')).toHaveCount(0)
    await page.getByTestId('ai-chat-close-btn').click()

    // 6. 轨道三：OpenAlex 联网精准校对 + 全库/批量导出 .bib
    await page.getByRole('button', { name: '复制文献引用', exact: true }).click()
    const citationModal = page.getByRole('dialog', { name: '一键复制引用', exact: true })
    await expect(citationModal).toBeVisible()
    await citationModal.locator('#citation-title-input').fill('ScaleStore: A Fast and Cost-Efficient Storage Engine')
    await page.getByTestId('citation-enrich-btn').click()
    await expect(page.getByTestId('citation-enrich-status')).toContainText('OpenAlex', { timeout: 10000 })
    await expect(citationModal).toContainText('Tobias Ziegler')
    await expect(citationModal).toContainText('10.1145/3514221')
    await page.getByRole('button', { name: '关闭引用窗口', exact: true }).click()

    const bibPath = join(workDir, 'all-library.bib')
    await app.evaluate(({ dialog }, targetPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath })
    }, bibPath)
    await page.getByTestId('library-more-menu-btn').click()
    await page.getByTestId('library-export-all-bib-btn').click()
    await expect.poll(async () => {
      try {
        return await readFile(bibPath, 'utf8')
      } catch {
        return ''
      }
    }).toContain('Tobias Ziegler')
    const bibText = await readFile(bibPath, 'utf8')
    expect(bibText).toContain('10.1145/3514221')
    expect((bibText.match(/@(?:article|inproceedings|misc)\{/g) ?? []).length).toBe(2)

    expect(failures).toEqual([])
  } finally {
    if (prevTestLitEnv === undefined) {
      delete process.env.PAPERFLOW_TEST_LITERATURE_BASE
    } else {
      process.env.PAPERFLOW_TEST_LITERATURE_BASE = prevTestLitEnv
    }
    await running.app.close().catch(() => {})
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    await rm(workDir, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }
})
