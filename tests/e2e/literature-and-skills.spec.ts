import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { readZipBuffer } from '../../src/main/services/zip-archive'
import layoutManifest from '../fixtures/verification/layout-analysis/manifest.json'
import { createTestData, importFixture, launchApp } from './helpers'

test('主动 AI 搜文献、按标签发现并一键导入 PDF，以及 AI 对话一键生成 FOCUS 总结与导出原生 .pptx', async () => {
  const samplePdfBytes = await readFile(
    resolve('tests/fixtures/verification/layout-analysis', layoutManifest.file.name)
  )
  const searchQueries: string[] = []
  const skillPrompts: string[] = []

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1')

    if (reqUrl.pathname === '/openalex/works') {
      const q = reqUrl.searchParams.get('search') ?? ''
      searchQueries.push(q)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          results: [
            {
              id: 'https://openalex.org/W2401001',
              doi: 'https://doi.org/10.1000/paperflow-test-oa',
              title: 'Deterministic Two-Column Scholarly Layout Analysis',
              publication_year: 2025,
              cited_by_count: 142,
              abstract_inverted_index: {
                Deterministic: [0],
                pipeline: [1],
                aligns: [2],
                bilingual: [3],
                'sentences.': [4]
              },
              open_access: { is_oa: true, oa_url: `${serverOrigin}/pdfs/oa-sample.pdf` },
              best_oa_location: {
                pdf_url: `${serverOrigin}/pdfs/oa-sample.pdf`,
                landing_page_url: `${serverOrigin}/landing/oa-sample`,
                source: { display_name: 'IEEE Trans. Document AI' }
              },
              authorships: [{ author: { display_name: 'Linus Scholar' } }],
              topics: [{ display_name: 'Document Layout' }]
            }
          ]
        })
      )
      return
    }

    if (reqUrl.pathname === '/arxiv/api/query') {
      res.writeHead(200, { 'Content-Type': 'application/atom+xml' })
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2501.00099v1</id>
    <published>2025-02-01T00:00:00Z</published>
    <title>ArXiv Complementary Layout Modeling</title>
    <summary>Related arXiv study for tag-based literature discovery.</summary>
    <author><name>Grace Analyst</name></author>
    <link title="pdf" href="${serverOrigin}/pdfs/oa-sample.pdf" type="application/pdf"/>
    <category term="cs.DL"/>
  </entry>
</feed>`)
      return
    }

    if (reqUrl.pathname === '/pdfs/oa-sample.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(samplePdfBytes.length) })
      res.end(samplePdfBytes)
      return
    }

    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(raw || '{}') as { messages?: Array<{ role: string; content: string }> }
      const joined = (body.messages ?? []).map(m => m.content).join('\n')
      skillPrompts.push(joined)

      let reply = '常规回答'
      let useSse = false
      if (joined.includes('academic search strategist')) {
        reply = JSON.stringify(['deterministic layout', 'bilingual reading'])
      } else if (joined.includes('triage assistant')) {
        reply = '本文提出确定性双栏版面分析流水线，实现精准的双语逐句对照。'
      } else if (joined.includes('FOCUS')) {
        useSse = true
        reply =
          '## FOCUS 深度总结\n\n### 1. 核心问题\n双栏学术文献坐标对齐与跨栏复现。\n\n| 指标 | 基线 | 本文 |\n| --- | --- | --- |\n| 漂移误差 | 12px | **0 px** |\n\n### 2. 定量结论\n- 缩放倍率保持 100% 未缩放坐标稳定性。'
      } else if (joined.includes('academic presentation designer')) {
        reply = JSON.stringify({
          deckTitle: '确定性双栏版面流水线汇报',
          subtitle: '组会论文精读 PPT',
          authors: 'PaperFlow Research Team',
          slides: [
            {
              title: '确定性双栏版面流水线',
              subtitle: '组会汇报 · 2025',
              layout: 'cover',
              bullets: ['会议/期刊：PaperFlow Benchmark', '核心议题：双栏阅读与句级对齐'],
              speakerNotes: '开场介绍本文解决的核心痛点。'
            },
            {
              title: '关键实验与对齐指标',
              layout: 'metrics',
              metrics: [
                { value: '0 px', label: '纵向漂移误差', detail: '坐标箱严格锁定' },
                { value: '100%', label: '跨栏句子召回', detail: 'Reading Order 重排' }
              ],
              takeaway: '实现稳定无漂移的双栏对照体验。',
              speakerNotes: '重点强调两个核心定量指标。'
            },
            {
              title: '总结与讨论 (Q&A)',
              layout: 'closing',
              bullets: ['结构化抽取保障复现', '后续可拓展更多图表识别'],
              takeaway: '谢谢各位老师与同学！',
              speakerNotes: '欢迎提问交流。'
            }
          ]
        })
      }

      if (useSse) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache'
        })
        const mid = Math.floor(reply.length / 2)
        const parts = [reply.slice(0, mid), reply.slice(mid)]
        for (const chunk of parts) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
        }
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-lit-skills',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }]
        })
      )
    })
  })

  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()))
  const addr = server.address() as { port: number }
  const serverOrigin = `http://127.0.0.1:${addr.port}`

  const prevTestLitEnv = process.env.PAPERFLOW_TEST_LITERATURE_BASE
  process.env.PAPERFLOW_TEST_LITERATURE_BASE = serverOrigin

  const exportDir = await mkdtemp(join(tmpdir(), 'paperflow-skill-export-'))
  const dataDir = await createTestData()
  const running = await launchApp(dataDir, { deviceScaleFactor: 1 })
  const failures: string[] = []
  running.page.on('pageerror', err => failures.push(err.message))

  try {
    const { app, page } = running

    // 1. 配置 OpenAI 兼容端点，启用 AI 智能扩词与 AI 科研技能
    await page.getByRole('button', { name: '翻译设置', exact: true }).click()
    await page.getByLabel('API Base URL', { exact: true }).fill(`${serverOrigin}/v1`)
    await page.getByLabel('API 模型名称', { exact: true }).fill('mock-skill-v1')
    await page.getByLabel('API Key', { exact: true }).fill('sk-skill-e2e-123456')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // 2. 主动 AI 搜文献 + AI 扩词 + 一键导入 OA PDF 到本地库
    await page.getByTestId('open-literature-search-btn').click()
    const searchModal = page.getByTestId('literature-search-modal')
    await expect(searchModal).toBeVisible()
    await page.getByTestId('literature-search-input').fill('双栏版面分析')
    await page.getByTestId('literature-search-submit').click()

    await expect(page.getByTestId('literature-ai-keywords-badge')).toContainText('deterministic layout', {
      timeout: 10000
    })
    await expect(page.getByTestId('literature-result-card')).toHaveCount(2)
    await expect(searchModal).toContainText('Deterministic Two-Column Scholarly Layout Analysis')
    await expect(searchModal).toContainText('ArXiv Complementary Layout Modeling')

    // 按需生成一句中文摘要速览
    await page.getByTestId('literature-summarize-btn').first().click()
    await expect(page.getByTestId('literature-zh-summary').first()).toContainText('确定性双栏版面分析流水线', {
      timeout: 10000
    })

    await page.getByTestId('literature-import-pdf-btn').first().click()
    await expect(page.getByTestId('literature-open-imported-btn')).toBeVisible({ timeout: 15000 })
    await page.getByTestId('literature-open-imported-btn').click()
    await expect(searchModal).toHaveCount(0)
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', {
      timeout: 20000
    })

    // 3. 给文献打自定义标签 -> 筛选浮层中点「按标签搜相关文献」自动带标签搜出相关文献
    await importFixture(app, page, 'verification/layout-analysis/' + layoutManifest.file.name)
    const docCard = page.locator('.document-entry').first()
    await docCard.hover()
    await docCard.getByRole('button', { name: /添加标签$/ }).click()
    await docCard.getByLabel('添加文献标签', { exact: true }).fill('LayoutPipeline')
    await docCard.getByLabel('添加文献标签', { exact: true }).press('Enter')

    await page.getByTestId('library-filter-toggle').click()
    await page.getByTestId('library-filter-popover').getByRole('button', { name: '#LayoutPipeline', exact: true }).click()
    await page.getByTestId('search-related-by-tag-btn').click()

    await expect(searchModal).toBeVisible()
    await expect(page.getByTestId('literature-tags-bar')).toContainText('#LayoutPipeline')
    await expect(page.getByTestId('literature-result-card').first()).toBeVisible({ timeout: 10000 })
    // 第一篇文献已导入本地库，检索结果自动标出「已在库中」防止重复下载
    await expect(page.getByTestId('literature-in-library-badge').first()).toContainText('已在库中')
    expect(searchQueries.length).toBeGreaterThanOrEqual(2)
    await page.getByRole('button', { name: '关闭文献搜索弹窗', exact: true }).click()

    // 4. 在减负后的 AI 对话框中验证空白态 2×2 科研技能卡、独立「✦ 技能」「📑 读取范围」弹出面板与四边扩展持久记忆
    await page.getByTestId('ai-chat-toggle').click()
    const chatWidget = page.getByTestId('ai-chat-widget')
    await expect(chatWidget).toBeVisible()
    await expect(page.getByTestId('ai-skill-starter-grid')).toBeVisible()
    await expect(page.getByTestId('ai-skill-trigger-btn')).toBeVisible()
    await expect(page.getByTestId('ai-sampling-trigger-btn')).toContainText('全篇均衡')

    // 测试四边向左拖宽（锁定右边界）+ 持久化尺寸恢复
    const beforeResizeBox = (await chatWidget.boundingBox())!
    const leftResizeHandle = page.getByTestId('ai-chat-resize-w')
    const leftHandleBox = (await leftResizeHandle.boundingBox())!
    await page.mouse.move(leftHandleBox.x + leftHandleBox.width / 2, leftHandleBox.y + leftHandleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(leftHandleBox.x - 120, leftHandleBox.y + leftHandleBox.height / 2, { steps: 6 })
    await page.mouse.up()
    const afterResizeBox = (await chatWidget.boundingBox())!
    expect(afterResizeBox.width).toBeGreaterThan(beforeResizeBox.width + 80)

    // 关闭再重开悬浮窗，确认手动扩大的宽度持久生效
    await page.getByTestId('ai-chat-close-btn').click()
    await expect(chatWidget).toHaveCount(0)
    await page.getByTestId('ai-chat-toggle').click()
    await expect(chatWidget).toBeVisible()
    const reopenedBox = (await chatWidget.boundingBox())!
    expect(Math.abs(reopenedBox.width - afterResizeBox.width)).toBeLessThanOrEqual(4)

    // 从空白态 2×2 卡片直接触发「深度总结」（验证流式 SSE + Markdown 表格/标题 DOM 渲染）并导出 .md
    await page.getByTestId('ai-skill-starter-summary-btn').click()
    const summaryBubble = page.getByTestId('ai-chat-msg-assistant').last()
    await expect(summaryBubble).toContainText('FOCUS 深度总结', {
      timeout: 15000
    })
    await expect(summaryBubble.locator('table.ai-md-table')).toContainText('0 px')

    const mdPath = join(exportDir, 'focus-summary.md')
    await app.evaluate(({ dialog }, targetPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath })
    }, mdPath)
    await page.getByTestId('ai-chat-export-md-btn').last().click()
    await expect(page.getByTestId('ai-chat-export-notice')).toContainText('focus-summary.md', { timeout: 10000 })
    const savedMd = await readFile(mdPath, 'utf8')
    expect(savedMd).toContain('FOCUS 深度总结')

    // 5. 测试独立「读取范围」按钮切换，再通过「✦ 技能」菜单触发生成 PPT -> 预览微调 -> 导出 .pptx
    await page.getByTestId('ai-sampling-trigger-btn').click()
    await expect(page.getByTestId('ai-sampling-popover')).toBeVisible()
    await page.getByTestId('ai-sampling-option-custom').click()
    await page.getByTestId('ai-skill-page-range-input').fill('1-2')
    await expect(page.getByTestId('ai-sampling-trigger-btn')).toContainText('P.1-2')
    await page.getByTestId('ai-sampling-option-full-balanced').click()
    await expect(page.getByTestId('ai-sampling-trigger-btn')).toContainText('全篇均衡')

    await page.getByTestId('ai-skill-trigger-btn').click()
    await expect(page.getByTestId('ai-skill-popover')).toBeVisible()
    await page.getByTestId('ai-skill-ppt-btn').click()
    await expect(page.getByTestId('ai-chat-ppt-card')).toContainText('共 3 页 16:9 学术幻灯片', {
      timeout: 15000
    })

    await page.getByTestId('ai-chat-preview-pptx-btn').click()
    const previewModal = page.getByTestId('ppt-preview-modal')
    await expect(previewModal).toBeVisible()
    await page.getByTestId('ppt-edit-title-input').fill('微调后双栏汇报标题')

    const pptxPath = join(exportDir, 'group-report.pptx')
    await app.evaluate(({ dialog }, targetPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath })
    }, pptxPath)
    await page.getByTestId('ppt-preview-export-btn').click()
    await expect(page.getByTestId('ai-chat-export-notice')).toContainText('group-report.pptx', { timeout: 10000 })

    const pptxBytes = await readFile(pptxPath)
    const zipMap = readZipBuffer(pptxBytes)
    expect(zipMap.has('[Content_Types].xml')).toBe(true)
    expect(zipMap.has('ppt/slides/slide1.xml')).toBe(true)
    expect(zipMap.get('ppt/slides/slide1.xml')?.toString('utf8')).toContain('微调后双栏汇报标题')
    expect(zipMap.has('ppt/slides/slide2.xml')).toBe(true)
    expect(zipMap.has('ppt/slides/slide3.xml')).toBe(true)
    expect(zipMap.has('ppt/notesSlides/notesSlide1.xml')).toBe(true)
    expect(skillPrompts.length).toBeGreaterThanOrEqual(2)

    expect(failures).toEqual([])
  } finally {
    if (prevTestLitEnv === undefined) {
      delete process.env.PAPERFLOW_TEST_LITERATURE_BASE
    } else {
      process.env.PAPERFLOW_TEST_LITERATURE_BASE = prevTestLitEnv
    }
    await running.app.close()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    await rm(exportDir, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }
})
