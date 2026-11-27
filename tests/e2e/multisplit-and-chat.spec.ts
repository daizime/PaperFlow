import { test, expect, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { createTestData, launchApp } from './helpers'

async function makeSyntheticPdf(
  filePath: string,
  title: string,
  pages: string | Array<string | { heading?: string; body: string }>
): Promise<void> {
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  const pageList = Array.isArray(pages) ? pages : [pages]
  for (const entry of pageList) {
    const page = doc.addPage()
    if (typeof entry === 'string') {
      page.drawText(entry, { x: 48, y: 720, size: 12 })
    } else {
      if (entry.heading) {
        page.drawText(entry.heading, { x: 48, y: 744, size: 15 })
      }
      page.drawText(entry.body, { x: 48, y: 716, size: 10.5 })
    }
  }
  await writeFile(filePath, new Uint8Array(await doc.save()))
}

async function html5Drag(page: Page, sourceSelector: string, targetSelector: string, dropXRatio: number): Promise<void> {
  await page.evaluate(
    async ({ srcSel, dstSel, xRatio }) => {
      const src = document.querySelector(srcSel)
      const dst = document.querySelector(dstSel)
      if (!src || !dst) throw new Error(`Missing drag endpoint: ${srcSel} -> ${dstSel}`)
      const dt = new DataTransfer()
      const rect = dst.getBoundingClientRect()
      const clientX = Math.round(rect.left + rect.width * xRatio)
      const clientY = Math.round(rect.top + Math.min(rect.height * 0.5, 180))

      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }))
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }))
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    },
    { srcSel: sourceSelector, dstSel: targetSelector, xRatio: dropXRatio }
  )
}

test('多选批量导入、用户自由拖拽多开与换位、悬浮+抽屉混合 AI 论文对话及持久化', async () => {
  const dataDir = await createTestData()
  const pdfDir = await mkdtemp(join(tmpdir(), 'paperflow-multi-import-'))
  const pdfA = join(pdfDir, 'Paper-Alpha.pdf')
  const pdfB = join(pdfDir, 'Paper-Beta.pdf')
  const pdfC = join(pdfDir, 'Paper-Gamma.pdf')
  const pdfD = join(pdfDir, 'Paper-Delta.pdf')

  await makeSyntheticPdf(pdfA, 'Paper Alpha', [
    { heading: '1. Introduction', body: 'Alpha electrocatalysis catalyst performance study.' },
    { heading: '2. Method', body: 'Alpha page two catalysis kinetics analysis.' }
  ])
  await makeSyntheticPdf(pdfB, 'Paper Beta', [
    { heading: '1. Introduction', body: 'Beta database page buffer architecture study.' },
    { heading: '2. Method', body: 'Beta page two buffer pool eviction policy.' }
  ])
  await makeSyntheticPdf(pdfC, 'Paper Gamma', [
    { heading: '1. Introduction', body: 'Gamma ultrasound clinical focusing study [1].' },
    { heading: '2. Method', body: '[1] Smith et al. Focused Ultrasound Reference Study, 2025.' }
  ])
  await makeSyntheticPdf(pdfD, 'Paper Delta', [
    { heading: '1. Introduction', body: 'Delta autonomous split layout study.' },
    { heading: '2. Method', body: 'Delta page two layout verification study.' }
  ])

  const requests: string[] = []
  const chatRequests: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += String(chunk)
    })
    req.on('end', () => {
      requests.push(body)
      const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> }
      const userPrompt = parsed.messages?.[parsed.messages.length - 1]?.content ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (userPrompt.includes('{"translations"')) {
        const matches = Array.from(userPrompt.matchAll(/\[\s*\{\s*"id"\s*:/g))
        const lastMatch = matches[matches.length - 1]
        const blocks = lastMatch?.index !== undefined
          ? (JSON.parse(userPrompt.slice(lastMatch.index)) as Array<{ id: string; text: string }>)
          : []
        const translations = blocks.map(item => ({
          id: item.id,
          text: `中文分栏译文：${item.text}`
        }))
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }))
        return
      }
      chatRequests.push(body)
      res.end(
        JSON.stringify({
          choices: [{ message: { content: `AI对比回复(#${chatRequests.length})：Alpha侧重催化，Beta侧重数据库，Gamma侧重声学。` } }]
        })
      )
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  let running = await launchApp(dataDir, { deviceScaleFactor: 1 })
  try {
    const { app, page } = running

    // 1. 「+ 导入」按钮一次多选导入 4 篇 PDF
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files })
    }, [pdfA, pdfB, pdfC, pdfD])
    await page.getByRole('button', { name: '导入 PDF', exact: true }).click()
    await expect(page.locator('.library-tree-doc')).toHaveCount(4, { timeout: 20000 })
    await expect(page.getByTestId('library-floating-toast')).toContainText(/批量导入完成：新增 4 篇/)

    const docs = await page.evaluate(() => window.paperflow.listDocuments())
    const docAlpha = docs.find(d => d.originalFilename === 'Paper-Alpha.pdf')!
    const docBeta = docs.find(d => d.originalFilename === 'Paper-Beta.pdf')!
    const docGamma = docs.find(d => d.originalFilename === 'Paper-Gamma.pdf')!
    const docDelta = docs.find(d => d.originalFilename === 'Paper-Delta.pdf')!

    // 打开 Alpha 为当前主阅读文献，确认第 1 页就绪
    await page.getByTestId(`tree-doc-${docAlpha.id}`).locator('.library-tree-doc-btn').click()
    await expect(page.locator('.reader-panel--primary .pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', {
      timeout: 30000
    })

    // 2. 从左侧拖 Beta 到主阅读区右侧边缘 -> 自动形成双开 [Alpha, Beta]
    await html5Drag(page, `[data-testid="tree-doc-${docBeta.id}"]`, '.reader-panel--primary', 0.9)
    await expect(page.getByTestId('split-panes-stage')).toHaveAttribute('data-pane-count', '2')
    await expect(page.getByTestId('split-pane-primary')).toHaveAttribute('data-document-id', docAlpha.id)
    await expect(page.getByTestId('split-pane-secondary')).toHaveAttribute('data-document-id', docBeta.id)

    // 3. 拖 Gamma 到右栏左侧边缘 -> 自由插入中间，形成三开 [Alpha, Gamma, Beta]
    await html5Drag(page, `[data-testid="tree-doc-${docGamma.id}"]`, '[data-testid="split-pane-secondary"]', 0.12)
    await expect(page.getByTestId('split-panes-stage')).toHaveAttribute('data-pane-count', '3')
    await expect(page.locator('[data-testid="split-panes-stage"] .reader-panel')).toHaveCount(3)
    expect(await page.locator('[data-testid="split-pane-secondary"]').getAttribute('data-document-id')).toBe(docGamma.id)
    expect(await page.locator('[data-testid="split-pane-2"]').getAttribute('data-document-id')).toBe(docBeta.id)

    // 4. 拖 Delta 到第 3 栏右侧边缘 -> 用户可自由四开（不受 3 栏硬上限限制）
    await html5Drag(page, `[data-testid="tree-doc-${docDelta.id}"]`, '[data-testid="split-pane-2"]', 0.92)
    await expect(page.getByTestId('split-panes-stage')).toHaveAttribute('data-pane-count', '4')
    await expect(page.locator('[data-testid="split-pane-3"]')).toHaveAttribute('data-document-id', docDelta.id)

    // 关闭第 4 栏恢复 3 开，验证精简两层顶栏（总高 <=80px、无重复 workspace-topbar、多开全局设置/批注入口可达、准确多开计数、无 ←/→ 按钮、宽拖柄、无按钮文字换行），测试左侧栏拖拽调宽、临时放大分栏及拖动手柄互换
    await page.getByTestId('close-pane-btn-3').click()
    await expect(page.getByTestId('split-panes-stage')).toHaveAttribute('data-pane-count', '3')
    await expect(page.locator('.workspace-topbar')).toHaveCount(0)
    await expect(page.locator('[data-testid^="pane-move-"]')).toHaveCount(0)
    await expect(page.getByTestId('compare-mode-toggle')).toContainText('退出多开 (3)')
    await expect(page.getByRole('button', { name: '翻译设置', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '批注与笔记', exact: true })).toBeVisible()

    const chromeMetrics = await page.evaluate(() => {
      const h1 = document.querySelector('.app-header')?.getBoundingClientRect().height ?? 0
      const h2 = document.querySelector('.workspace-tabs')?.getBoundingClientRect().height ?? 0
      const libWidth = document.querySelector('.library-panel')?.getBoundingClientRect().width ?? 0
      return { chromeHeight: h1 + h2, libWidth }
    })
    expect(chromeMetrics.chromeHeight).toBeLessThanOrEqual(80)

    const libResizerBox = (await page.getByTestId('library-sidebar-resizer').boundingBox())!
    await page.mouse.move(libResizerBox.x + libResizerBox.width / 2, libResizerBox.y + 160)
    await page.mouse.down()
    await page.mouse.move(libResizerBox.x + libResizerBox.width / 2 + 70, libResizerBox.y + 160, { steps: 5 })
    await page.mouse.up()
    const widenedLibWidth = await page.evaluate(
      () => document.querySelector('.library-panel')?.getBoundingClientRect().width ?? 0
    )
    expect(widenedLibWidth).toBeGreaterThan(chromeMetrics.libWidth + 40)
    const updatedResizerBox = (await page.getByTestId('library-sidebar-resizer').boundingBox())!
    await page.mouse.dblclick(updatedResizerBox.x + updatedResizerBox.width / 2, updatedResizerBox.y + 160)
    const resetLibWidth = await page.evaluate(
      () => document.querySelector('.library-panel')?.getBoundingClientRect().width ?? 0
    )
    expect(Math.abs(resetLibWidth - 252)).toBeLessThanOrEqual(4)

    await page.getByTestId('pane-expand-btn-1').click()
    await expect(page.getByTestId('split-pane-secondary')).toHaveAttribute('data-pane-expanded', 'true')
    const expandedWidths = await page.evaluate(() => ({
      mid: document.querySelector('[data-testid="split-pane-secondary"]')?.getBoundingClientRect().width ?? 0,
      right: document.querySelector('[data-testid="split-pane-2"]')?.getBoundingClientRect().width ?? 0
    }))
    expect(expandedWidths.mid).toBeGreaterThan(expandedWidths.right * 1.5)
    await page.getByTestId('pane-expand-btn-1').click()
    await expect(page.getByTestId('split-pane-secondary')).toHaveAttribute('data-pane-expanded', 'false')

    const layoutMetrics = await page.evaluate(() => {
      const handleRect = document.querySelector('[data-testid="pane-drag-handle-0"]')?.getBoundingClientRect()
      const maxBtnHeight = Math.max(
        0,
        ...Array.from(document.querySelectorAll('.split-pane-header button')).map(
          el => el.getBoundingClientRect().height
        )
      )
      return { handleWidth: handleRect?.width ?? 0, maxBtnHeight }
    })
    expect(layoutMetrics.handleWidth).toBeGreaterThanOrEqual(64)
    expect(layoutMetrics.maxBtnHeight).toBeLessThanOrEqual(28)

    await html5Drag(page, '[data-testid="pane-drag-handle-2"]', '[data-testid="split-pane-primary"]', 0.5)
    await expect(page.getByTestId('split-pane-primary')).toHaveAttribute('data-document-id', docBeta.id)
    await expect(page.getByTestId('split-pane-2')).toHaveAttribute('data-document-id', docAlpha.id)

    // 4.5 验证左 / 中 / 右每一栏独立目录功能（含下拉切篇后重建 ref、同时展开互不挤压、点击标题跳转高亮、O 快捷键与纯译文点目录自动双栏）
    for (const sel of ['[data-testid="split-pane-primary"]', '[data-testid="split-pane-secondary"]', '[data-testid="split-pane-2"]']) {
      await expect(page.locator(`${sel} .pdf-page[data-page-number="1"]`)).toHaveAttribute('data-rendered', 'true', {
        timeout: 20000
      })
    }

    // 中栏切换一篇文献再切回，确认旧 PdfViewer 卸载清理不会抹掉 toolbarActionsRef
    await page.getByTestId('secondary-pane-select').selectOption(docDelta.id)
    await expect(page.getByTestId('split-pane-secondary')).toHaveAttribute('data-document-id', docDelta.id)
    await expect(page.locator('[data-testid="split-pane-secondary"] .pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', {
      timeout: 20000
    })
    await page.getByTestId('secondary-pane-select').selectOption(docGamma.id)
    await expect(page.getByTestId('split-pane-secondary')).toHaveAttribute('data-document-id', docGamma.id)
    await expect(page.locator('[data-testid="split-pane-secondary"] .pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', {
      timeout: 20000
    })

    const viewportWidthsBefore = await page.evaluate(() => ({
      left: document.querySelector('[data-testid="split-pane-primary"] .reader-viewport')?.getBoundingClientRect().width ?? 0,
      mid: document.querySelector('[data-testid="split-pane-secondary"] .reader-viewport')?.getBoundingClientRect().width ?? 0,
      right: document.querySelector('[data-testid="split-pane-2"] .reader-viewport')?.getBoundingClientRect().width ?? 0
    }))

    await page.getByTestId('pane-outline-btn-0').click()
    await page.getByTestId('pane-outline-btn-1').click()
    await page.getByTestId('pane-outline-btn-2').click()

    const outlineLeft = page.locator('[data-testid="split-pane-primary"] aside[aria-label="文档目录"]')
    const outlineMid = page.locator('[data-testid="split-pane-secondary"] aside[aria-label="文档目录"]')
    const outlineRight = page.locator('[data-testid="split-pane-2"] aside[aria-label="文档目录"]')
    await expect(outlineLeft).toBeVisible()
    await expect(outlineMid).toBeVisible()
    await expect(outlineRight).toBeVisible()
    await expect(outlineLeft).toContainText('2. Method', { timeout: 15000 })
    await expect(outlineMid).toContainText('2. Method', { timeout: 15000 })
    await expect(outlineRight).toContainText('2. Method', { timeout: 15000 })

    // 目录以栏内浮层抽屉展示：不得挤压正文阅读视口宽度，且关闭按钮不被裁剪
    const outlineGeometry = await page.evaluate(() => {
      const checkPane = (paneSel: string) => {
        const pane = document.querySelector(paneSel)!
        const vp = pane.querySelector('.reader-viewport')!
        const closeBtn = pane.querySelector('.reader-outline__close')!
        const pr = pane.getBoundingClientRect()
        const cr = closeBtn.getBoundingClientRect()
        return {
          vpWidth: vp.getBoundingClientRect().width,
          closeInside: cr.width > 0 && cr.left >= pr.left - 1 && cr.right <= pr.right + 1
        }
      }
      return {
        left: checkPane('[data-testid="split-pane-primary"]'),
        mid: checkPane('[data-testid="split-pane-secondary"]'),
        right: checkPane('[data-testid="split-pane-2"]')
      }
    })
    expect(outlineGeometry.left.vpWidth).toBeGreaterThanOrEqual(viewportWidthsBefore.left - 2)
    expect(outlineGeometry.mid.vpWidth).toBeGreaterThanOrEqual(viewportWidthsBefore.mid - 2)
    expect(outlineGeometry.right.vpWidth).toBeGreaterThanOrEqual(viewportWidthsBefore.right - 2)
    expect(outlineGeometry.left.closeInside).toBe(true)
    expect(outlineGeometry.mid.closeInside).toBe(true)
    expect(outlineGeometry.right.closeInside).toBe(true)

    // 中栏 / 右栏点击目录章节跳转第 2 页并同步高亮标题
    await outlineMid.getByRole('button', { name: /2\. Method/ }).click()
    await expect(page.locator('[data-testid="split-pane-secondary"]').getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2', { timeout: 10000 })
    await expect(page.locator('[data-testid="split-pane-secondary"] .pdf-page[data-page-number="2"] .pdf-sentence-highlight').first()).toBeVisible({ timeout: 15000 })

    await outlineRight.getByRole('button', { name: /2\. Method/ }).click()
    await expect(page.locator('[data-testid="split-pane-2"]').getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2', { timeout: 10000 })
    await expect(page.locator('[data-testid="split-pane-2"] .pdf-page[data-page-number="2"] .pdf-sentence-highlight').first()).toBeVisible({ timeout: 15000 })

    // 回第 1 页并关闭左/中目录，测试聚焦右栏按 O 仅开关右栏目录
    await outlineMid.getByRole('button', { name: /1\. Introduction/ }).click()
    await expect(page.locator('[data-testid="split-pane-secondary"]').getByRole('spinbutton', { name: '当前页码' })).toHaveValue('1', { timeout: 10000 })
    await outlineRight.getByRole('button', { name: /1\. Introduction/ }).click()
    await expect(page.locator('[data-testid="split-pane-2"]').getByRole('spinbutton', { name: '当前页码' })).toHaveValue('1', { timeout: 10000 })

    await outlineLeft.getByRole('button', { name: '关闭目录', exact: true }).click()
    await outlineMid.getByRole('button', { name: '关闭目录', exact: true }).click()
    await expect(outlineLeft).toHaveCount(0)
    await expect(outlineMid).toHaveCount(0)

    const rightBoxForShortcut = (await page.getByTestId('split-pane-2').boundingBox())!
    await page.mouse.click(rightBoxForShortcut.x + rightBoxForShortcut.width - 28, rightBoxForShortcut.y + 80)
    await page.keyboard.press('o')
    await expect(outlineRight).toHaveCount(0)
    await expect(outlineLeft).toHaveCount(0)

    // 右栏切至「译」模式时点击目录：自动切至双栏并打开右栏目录，随后还原回「原」模式
    await page.getByTestId('pane-mode-2-translation').click()
    await expect(page.getByTestId('split-pane-2')).toHaveAttribute('data-pane-view-mode', 'translation')
    await page.getByTestId('pane-outline-btn-2').click()
    await expect(page.getByTestId('split-pane-2')).toHaveAttribute('data-pane-view-mode', 'dual')
    await expect(outlineRight).toBeVisible()
    await outlineRight.getByRole('button', { name: '关闭目录', exact: true }).click()
    await page.getByTestId('pane-mode-2-source').click()

    // 5. 配置本地模型接口后，打开可拖拽浮窗 + 阅读区抽屉折叠的 AI 对话助手
    await page.evaluate(async serverPort => {
      await window.paperflow.saveTranslationSettings({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        glossary: [],
        openai: {
          baseUrl: `http://127.0.0.1:${serverPort}/v1`,
          model: 'mock-chat-model',
          apiKey: 'sk-test-chat'
        },
        cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 30 }
      })
    }, port)

    await page.getByTestId('ai-chat-toggle').click()
    const chatWidget = page.getByTestId('ai-chat-widget')
    await expect(chatWidget).toBeVisible()
    await expect(chatWidget).toHaveAttribute('data-dock-mode', 'floating')
    await expect(chatWidget).toHaveAttribute('data-drawer-expanded', 'true')

    // 将悬浮窗拖到「中栏」中心 -> 自动识别出中栏 Paper-Gamma
    const paneMidBox = (await page.getByTestId('split-pane-secondary').boundingBox())!
    const handleBox1 = (await page.getByTestId('ai-chat-drag-handle').boundingBox())!
    const targetXMid = paneMidBox.x + paneMidBox.width * 0.5 - (handleBox1.x + handleBox1.width / 2)
    await page.mouse.move(handleBox1.x + handleBox1.width / 2, handleBox1.y + handleBox1.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox1.x + handleBox1.width / 2 + targetXMid, handleBox1.y + handleBox1.height / 2 + 24, { steps: 6 })
    await page.mouse.up()
    await expect(page.getByTestId('ai-chat-context-indicator')).toContainText('中栏')
    await expect(page.getByTestId('ai-chat-context-indicator')).toContainText('Paper-Gamma')

    // 拖到「右栏」区域 -> 自动识别出右栏 Paper-Alpha；再拖回「左栏」聚焦 Paper-Beta
    const paneRightBox = (await page.getByTestId('split-pane-2').boundingBox())!
    const handleBox2 = (await page.getByTestId('ai-chat-drag-handle').boundingBox())!
    await page.mouse.move(handleBox2.x + handleBox2.width / 2, handleBox2.y + handleBox2.height / 2)
    await page.mouse.down()
    await page.mouse.move(paneRightBox.x + paneRightBox.width * 0.45, handleBox2.y + handleBox2.height / 2, { steps: 6 })
    await page.mouse.up()
    await expect(page.getByTestId('ai-chat-context-indicator')).toContainText('右栏')
    await expect(page.getByTestId('ai-chat-context-indicator')).toContainText('Paper-Alpha')

    const paneLeftBox = (await page.getByTestId('split-pane-primary').boundingBox())!
    const handleBox3 = (await page.getByTestId('ai-chat-drag-handle').boundingBox())!
    await page.mouse.move(handleBox3.x + handleBox3.width / 2, handleBox3.y + handleBox3.height / 2)
    await page.mouse.down()
    await page.mouse.move(paneLeftBox.x + 110, handleBox3.y + handleBox3.height / 2, { steps: 6 })
    await page.mouse.up()
    // 浮窗贴近左栏但不应误触左侧边缘停靠（光标未贴到最外侧 <=8px 边线）
    await expect(chatWidget).toHaveAttribute('data-dock-mode', 'floating')
    await expect(page.getByTestId('ai-chat-context-indicator')).toContainText('左栏')
    await expect(page.getByTestId('ai-chat-context-indicator')).toContainText('Paper-Beta')

    // 刻意将鼠标拖到阅读区最右侧边缘（<=8px）松手时才触发停靠为右侧抽屉
    const overlayBox = (await page.getByTestId('ai-chat-overlay').boundingBox())!
    const handleBox4 = (await page.getByTestId('ai-chat-drag-handle').boundingBox())!
    await page.mouse.move(handleBox4.x + handleBox4.width / 2, handleBox4.y + handleBox4.height / 2)
    await page.mouse.down()
    await page.mouse.move(overlayBox.x + overlayBox.width - 3, handleBox4.y + handleBox4.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(chatWidget).toHaveAttribute('data-dock-mode', 'dock-right')

    // 切回浮窗测试悬浮原地折叠，再点击停靠为右侧抽屉
    await page.getByTestId('ai-chat-dock-toggle').click()
    await expect(chatWidget).toHaveAttribute('data-dock-mode', 'floating')

    // 悬浮状态下如抽屉一样原地折叠缩藏 / 再展开
    await page.getByTestId('ai-chat-drawer-toggle').click()
    await expect(chatWidget).toHaveAttribute('data-drawer-expanded', 'false')
    await expect(page.getByTestId('ai-chat-body')).toHaveCount(0)
    await page.getByTestId('ai-chat-drawer-toggle').click()
    await expect(chatWidget).toHaveAttribute('data-drawer-expanded', 'true')
    await expect(page.getByTestId('ai-chat-body')).toBeVisible()

    // 停靠到阅读区右侧抽屉，测试边缘抽屉把手展开/收起
    await page.getByTestId('ai-chat-dock-toggle').click()
    await expect(chatWidget).toHaveAttribute('data-dock-mode', 'dock-right')
    await page.getByTestId('ai-chat-drawer-toggle').click()
    await expect(chatWidget).toHaveAttribute('data-drawer-expanded', 'false')
    await page.getByTestId('ai-chat-drawer-toggle').click()
    await expect(chatWidget).toHaveAttribute('data-drawer-expanded', 'true')

    // 选中左栏上下文并选择「同屏 3 篇」发送对比提问，校验持久保存
    await page.getByTestId('ai-chat-context-indicator').click()
    const scopePopover = page.getByTestId('ai-chat-scope-popover')
    await expect(scopePopover).toBeVisible()
    await scopePopover.getByRole('button', { name: '左栏', exact: true }).click()
    await page.getByTestId('ai-chat-context-indicator').click()
    await page.getByTestId('ai-chat-scope-all-open').click()
    await page.getByTestId('ai-chat-input').fill('请对比当前同屏打开的 3 篇论文重点。')
    await page.getByTestId('ai-chat-send-btn').click()

    await expect(page.getByTestId('ai-chat-msg-assistant')).toContainText('AI对比回复(#1)', { timeout: 15000 })
    expect(chatRequests.length).toBe(1)
    expect(chatRequests[0]).toContain('Paper-Beta')
    expect(chatRequests[0]).toContain('Paper-Gamma')
    expect(chatRequests[0]).toContain('Paper-Alpha')

    await page.getByTestId('ai-chat-close-btn').click()
    await expect(chatWidget).toHaveCount(0)

    // 5.5 验证多开状态下「记笔记 / 速览」划词浮条及顶栏「批注」均按焦点分栏精确生效（左/中/右全支持）
    const gammaSpan = page
      .locator('[data-testid="split-pane-secondary"] .pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'Gamma ultrasound' })
      .first()
    await expect(gammaSpan).toBeVisible({ timeout: 20000 })
    const gammaBox = (await gammaSpan.boundingBox())!
    await page.mouse.click(gammaBox.x + gammaBox.width * 0.5, gammaBox.y + gammaBox.height * 0.5)

    await expect(page.getByTestId('companion-pane-badge')).toHaveText('中栏')
    await page.getByRole('button', { name: '速览 [1]', exact: true }).click()
    const peekDialog = page.getByRole('dialog', { name: '引用与图表速览', exact: true })
    await expect(peekDialog).toBeVisible({ timeout: 10000 })
    await expect(peekDialog).toContainText('中栏')
    await expect(peekDialog).toContainText('Smith et al. Focused Ultrasound Reference Study', { timeout: 10000 })
    await page.getByRole('button', { name: '关闭速览卡片', exact: true }).click()

    await page.getByRole('button', { name: '黄色高亮', exact: true }).click()
    await page.getByLabel('批注笔记输入框', { exact: true }).fill('中栏独立批注测试')
    await page.getByRole('button', { name: '保存批注', exact: true }).click()
    await expect(
      page.locator('[data-testid="split-pane-secondary"] .pdf-annotation-highlight').first()
    ).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('header-active-pane-badge')).toHaveText('中栏')
    await expect(page.getByRole('button', { name: '批注与笔记', exact: true })).toContainText('批注 (1)')

    // 点击右栏空白处切换焦点 -> 顶栏标识切为「右栏」，且批注计数不再误显示中栏批注
    const rightPaneBox = (await page.getByTestId('split-pane-2').boundingBox())!
    await page.mouse.click(rightPaneBox.x + rightPaneBox.width * 0.5, rightPaneBox.y + 120)
    await expect(page.getByTestId('header-active-pane-badge')).toHaveText('右栏')
    await expect(page.getByRole('button', { name: '批注与笔记', exact: true })).toHaveText('批注')

    // 打开批注抽屉验证可清晰按「左栏 / 中栏 / 右栏」切换对应 PDF 的批注
    await page.getByRole('button', { name: '批注与笔记', exact: true }).click()
    const paneSwitcher = page.getByTestId('annotations-pane-switcher')
    await expect(paneSwitcher).toBeVisible()
    await paneSwitcher.getByRole('tab', { name: /中栏 \(1\)/ }).click()
    await expect(page.getByRole('dialog', { name: '批注与笔记面板', exact: true })).toContainText('中栏独立批注测试')
    await page.getByRole('button', { name: '关闭批注面板', exact: true }).click()

    // 6. 多开状态下每个分栏各自独立切换 原文 / 双栏 / 译文 并独立翻译本页
    await page.getByTestId('pane-mode-0-dual').click()
    await page.getByTestId('pane-mode-1-translation').click()
    await expect(page.getByTestId('split-pane-primary')).toHaveAttribute('data-pane-view-mode', 'dual')
    await expect(page.getByTestId('split-pane-secondary')).toHaveAttribute('data-pane-view-mode', 'translation')
    await expect(page.getByTestId('split-pane-2')).toHaveAttribute('data-pane-view-mode', 'source')

    await expect(page.locator('[data-testid="split-pane-primary"] .translation-panel')).toBeVisible()
    await expect(page.locator('[data-testid="split-pane-secondary"] .translation-panel')).toBeVisible()
    await expect(page.locator('[data-testid="split-pane-secondary"] .reader-toolbar')).toBeVisible()
    await expect(page.locator('[data-testid="split-pane-2"] .translation-panel')).toHaveCount(0)

    const dualHeaderMetrics = await page.evaluate(() => {
      const handleRect = document.querySelector('[data-testid="pane-drag-handle-0"]')?.getBoundingClientRect()
      const maxBtnHeight = Math.max(
        0,
        ...Array.from(document.querySelectorAll('.split-pane-header button')).map(
          el => el.getBoundingClientRect().height
        )
      )
      return { handleWidth: handleRect?.width ?? 0, maxBtnHeight }
    })
    expect(dualHeaderMetrics.handleWidth).toBeGreaterThanOrEqual(64)
    expect(dualHeaderMetrics.maxBtnHeight).toBeLessThanOrEqual(28)

    await expect(
      page.locator('[data-testid="split-pane-secondary"] .translation-page[data-page-number="1"]')
    ).toHaveAttribute('data-analyzed', 'true', { timeout: 20000 })
    await page.getByTestId('pane-translate-btn-1').click()
    await expect(
      page.locator('[data-testid="split-pane-secondary"] .translation-panel')
    ).toContainText('中文分栏译文', { timeout: 15000 })

    // 重启应用，验证多开分栏顺序、各栏视图模式（双栏/译文/原文）和 AI 对话记录均从本地持久化恢复
    await app.close()
    running = await launchApp(dataDir, { deviceScaleFactor: 1 })
    await expect(running.page.getByTestId('split-panes-stage')).toHaveAttribute('data-pane-count', '3')
    await expect(running.page.getByTestId('split-pane-primary')).toHaveAttribute('data-document-id', docBeta.id)
    await expect(running.page.getByTestId('split-pane-primary')).toHaveAttribute('data-pane-view-mode', 'dual')
    await expect(running.page.getByTestId('split-pane-secondary')).toHaveAttribute('data-pane-view-mode', 'translation')
    await expect(running.page.getByTestId('split-pane-2')).toHaveAttribute('data-pane-view-mode', 'source')

    await running.page.getByTestId('ai-chat-toggle').click()
    await expect(running.page.getByTestId('ai-chat-msg-user')).toContainText('请对比当前同屏打开的 3 篇论文重点。')
    await expect(running.page.getByTestId('ai-chat-msg-assistant')).toContainText('AI对比回复(#1)')

    // 重启后纯译文模式下的中栏也应自动完成版面分析并展示已缓存的中文译文
    await expect(
      running.page.locator('[data-testid="split-pane-secondary"] .translation-panel')
    ).toContainText('中文分栏译文', { timeout: 20000 })

    // 回归图 2 Bug：在单栏纯「译文」模式下进入「并排多开」再点击「退出多开」，第 1 页应正常完成分析并显示译文而非一直卡在「正在分析第 1 页版面结构…」
    await running.page.getByTestId('compare-mode-toggle').click()
    await expect(running.page.getByTestId('split-panes-stage')).toHaveCount(0)
    await running.page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '译文', exact: true }).click()
    await running.page.getByTestId('compare-mode-toggle').click()
    await expect(running.page.getByTestId('split-panes-stage')).toHaveAttribute('data-pane-count', '2')
    // 焦点落在右栏（未渲染单页），再点「退出多开」重建纯译文主视图
    await running.page.getByTestId('compare-mode-toggle').click()
    await expect(running.page.getByTestId('split-panes-stage')).toHaveCount(0)
    await expect(running.page.locator('.translation-page[data-page-number="1"]')).toHaveAttribute('data-analyzed', 'true', {
      timeout: 20000
    })
    await expect(running.page.locator('.translation-page[data-page-number="1"]')).not.toContainText('正在分析第 1 页版面结构')
  } finally {
    await running.app.close()
    await rm(pdfDir, { recursive: true, force: true })
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
