import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readZipBuffer } from '../../src/main/services/zip-archive'
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
}

test('高级阅读与研究工作流：紧致原图速览/自动收起/一键复制、自动大纲双向高亮、引用复制与跨库 ZIP 一键备份恢复', async () => {
  const dataDirA = await createTestData()
  const runningA = await launchApp(dataDirA, { deviceScaleFactor: 1 })
  const failures: string[] = []
  runningA.page.on('pageerror', error => failures.push(error.message))

  const backupZipPath = join(dataDirA, 'exported-library-backup.zip')
  const nativeUnzipDir = join(dataDirA, 'native-unzip-check')

  try {
    const { app, page } = runningA
    await importFixture(app, page, 'verification/layout-analysis/' + layoutManifest.file.name)
    await waitForPageReady(page, 1)

    // 1. 无书签 PDF 自动识别章节大纲：点击标题跳转后，目录单选高亮 + 原文/双栏同步高亮对应标题
    await page.getByRole('button', { name: '文档目录', exact: true }).click()
    const outlineAside = page.getByRole('complementary', { name: '文档目录', exact: true })
    await expect(outlineAside).toBeVisible()
    await expect(outlineAside).toContainText('自动识别', { timeout: 10000 })
    const sec21 = outlineAside.getByRole('button', { name: /2\.1 Band Segmentation/ })
    await expect(sec21).toBeVisible({ timeout: 10000 })
    await sec21.click()
    await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2')
    await expect(outlineAside.locator('.reader-outline__item.is-active')).toHaveCount(1)
    await expect(outlineAside.locator('.reader-outline__item.is-active')).toContainText('2.1 Band Segmentation')
    await waitForPageReady(page, 2)
    await expect(page.locator('.pdf-page[data-page-number="2"] .pdf-sentence-highlight').first()).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.translation-page[data-page-number="2"] .is-active').first()).toBeVisible({ timeout: 10000 })

    await page.getByRole('button', { name: '上一页', exact: true }).click()
    await waitForPageReady(page, 1)
    await page.getByRole('button', { name: '关闭目录', exact: true }).click()

    // 2. 图表速览卡片：紧致裁剪图 + 一键复制图片/题注写入系统剪贴板 + 固定与点击正文自动收起
    const figSpan = page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'Fig. 1, the scale factor' })
      .first()
    await figSpan.scrollIntoViewIfNeeded()
    const figBox = (await figSpan.boundingBox())!
    await page.mouse.click(figBox.x + figBox.width / 2, figBox.y + figBox.height / 2)

    await page.getByRole('button', { name: '速览 Fig. 1', exact: true }).click()
    const peekDialog = page.getByRole('dialog', { name: '引用与图表速览', exact: true })
    await expect(peekDialog).toBeVisible()
    const peekImg = peekDialog.locator('img.study-peek-card__image')
    await expect(peekImg).toBeVisible({ timeout: 15000 })
    const dims = await peekImg.evaluate(img => ({
      w: (img as HTMLImageElement).naturalWidth,
      h: (img as HTMLImageElement).naturalHeight
    }))
    expect(dims.w).toBeGreaterThan(40)
    expect(dims.h).toBeGreaterThan(20)

    // 一键复制图片与题注到真实系统剪贴板
    await peekDialog.getByRole('button', { name: '复制速览图片', exact: true }).click()
    await expect(peekDialog.getByRole('button', { name: '复制速览图片', exact: true })).toContainText('已复制图片')
    const hasCopiedPng = await app.evaluate(({ clipboard }) => clipboard.has('image/png'))
    expect(hasCopiedPng).toBe(true)

    await peekDialog.getByRole('button', { name: '复制速览文本', exact: true }).click()
    await expect(peekDialog.getByRole('button', { name: '复制速览文本', exact: true })).toContainText('已复制')
    const copiedCaption = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copiedCaption).toContain('Figure 1: Synthetic two-column alignment diagram.')
    expect(copiedCaption).not.toMatch(/⟪M\d+⟫/)
    await expect(peekDialog).toHaveClass(/study-peek-card--visual/)

    // 验证「固定」与「未固定时点击正文自动关闭」
    const otherSpan = page
      .locator('.pdf-page[data-page-number="1"] .textLayer span')
      .filter({ hasText: 'Every sentence keeps unscaled boxes' })
      .first()
    await otherSpan.scrollIntoViewIfNeeded()
    const otherBox = (await otherSpan.boundingBox())!
    await peekDialog.getByRole('button', { name: '固定速览卡片', exact: true }).click()
    await page.mouse.click(otherBox.x + otherBox.width / 2, otherBox.y + otherBox.height / 2)
    await expect(peekDialog).toBeVisible()
    await peekDialog.getByRole('button', { name: '取消固定速览卡片', exact: true }).click()
    await page.mouse.click(otherBox.x + otherBox.width / 2, otherBox.y + otherBox.height / 2)
    await expect(peekDialog).toHaveCount(0)

    // 3. 快捷键面板 (?) 与阅读快捷键 (t / v / c / Escape)
    await page.keyboard.press('Shift+/')
    const shortcutsDialog = page.getByRole('dialog', { name: '快捷键一览', exact: true })
    await expect(shortcutsDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(shortcutsDialog).toHaveCount(0)

    await page.keyboard.press('t')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('sepia')
    await page.keyboard.press('t')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.keyboard.press('t')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')

    await page.keyboard.press('v')
    await expect.poll(() => page.evaluate(() => document.querySelector('.reader-panel')!.getBoundingClientRect().width)).toBeLessThanOrEqual(2)
    await page.keyboard.press('v')
    await page.keyboard.press('v')
    await expect.poll(() => page.evaluate(() => document.querySelector('.reader-panel')!.getBoundingClientRect().width)).toBeGreaterThan(100)

    // 4. 一键复制引用面板 (BibTeX / IEEE / GB/T 7714) 并校验写入系统剪贴板
    await page.keyboard.press('c')
    const citationDialog = page.getByRole('dialog', { name: '一键复制引用', exact: true })
    await expect(citationDialog).toBeVisible()
    const preview = citationDialog.getByLabel('引用预览', { exact: true })
    await expect(preview).toContainText('@')
    await citationDialog.getByRole('button', { name: '复制当前引用格式', exact: true }).click()
    await expect(citationDialog.getByRole('button', { name: '复制当前引用格式', exact: true })).toContainText('已复制引用')
    const copiedBib = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copiedBib).toContain('Deterministic Layout Pipeline')
    await citationDialog.getByRole('tab', { name: 'IEEE', exact: true }).click()
    await expect(preview).toContainText('Deterministic Layout Pipeline')
    await citationDialog.getByRole('tab', { name: 'GB/T 7714', exact: true }).click()
    await expect(preview).toContainText('[J]')
    await page.keyboard.press('Escape')
    await expect(citationDialog).toHaveCount(0)

    // 5. 添加星标、标签与批注，导出便携 ZIP 备份包并校验内部兼容文件 + Windows 原生解压互通性
    const docCard = page.locator('.document-entry').first()
    await docCard.hover()
    await docCard.getByRole('button', { name: /^收藏 / }).click()
    await docCard.getByRole('button', { name: /添加标签$/ }).click()
    await docCard.getByLabel('添加文献标签', { exact: true }).fill('Layout')
    await docCard.getByLabel('添加文献标签', { exact: true }).press('Enter')

    await page.keyboard.press('Escape')
    const noteBox = (await otherSpan.boundingBox())!
    await page.mouse.click(noteBox.x + noteBox.width / 2, noteBox.y + noteBox.height / 2)
    await page.getByRole('button', { name: '添加批注笔记', exact: true }).click()
    await page.getByLabel('批注笔记输入框', { exact: true }).fill('备份还原验证批注')
    await page.getByRole('button', { name: '保存批注', exact: true }).click()
    await expect(page.getByRole('button', { name: '批注与笔记', exact: true })).toContainText('批注 (1)')

    await app.evaluate(({ dialog }, targetPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath })
    }, backupZipPath)
    await page.getByRole('button', { name: '导出文献库备份', exact: true }).click()
    await expect(page.locator('.library-feedback--success')).toContainText('已导出备份', { timeout: 15000 })

    expect(existsSync(backupZipPath)).toBe(true)
    const zipEntries = readZipBuffer(readFileSync(backupZipPath))
    expect(zipEntries.has('library.bib')).toBe(true)
    expect(zipEntries.has('library.ris')).toBe(true)
    expect(zipEntries.has('paperflow-backup.json')).toBe(true)
    expect(Array.from(zipEntries.keys()).some(k => k.startsWith('pdfs/') && k.endsWith('.pdf'))).toBe(true)
    expect(Array.from(zipEntries.keys()).some(k => k.startsWith('notes/') && k.endsWith('.md'))).toBe(true)

    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${backupZipPath.replace(/'/g, "''")}' -DestinationPath '${nativeUnzipDir.replace(/'/g, "''")}' -Force`
        ],
        { stdio: 'pipe' }
      )
      expect(existsSync(join(nativeUnzipDir, 'library.bib'))).toBe(true)
      expect(existsSync(join(nativeUnzipDir, 'library.ris'))).toBe(true)
      expect(existsSync(join(nativeUnzipDir, 'paperflow-backup.json'))).toBe(true)
    }
  } finally {
    await runningA.app.close()
  }

  // 6. 在全新空白数据目录启动第二个 PaperFlow 实例并从 ZIP 恢复全套数据 + 验证二次恢复幂等
  const dataDirB = await createTestData()
  const runningB = await launchApp(dataDirB, { deviceScaleFactor: 1 })
  runningB.page.on('pageerror', error => failures.push(error.message))
  try {
    const { app: appB, page: pageB } = runningB
    await expect(pageB.locator('.empty-library')).toBeVisible()

    await appB.evaluate(({ dialog }, sourcePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourcePath] })
    }, backupZipPath)
    await pageB.getByRole('button', { name: '从备份恢复文献库', exact: true }).click()
    await expect(pageB.locator('.library-feedback--success')).toContainText('新增 1 篇', { timeout: 20000 })

    const restoredCard = pageB.locator('.document-entry').first()
    await expect(restoredCard).toBeVisible()
    await expect(restoredCard.getByRole('button', { name: /^取消收藏 / })).toHaveAttribute('aria-pressed', 'true')
    await expect(restoredCard.locator('.document-tag-pill')).toContainText('#Layout')
    await waitForPageReady(pageB, 1)
    await expect(pageB.getByRole('button', { name: '批注与笔记', exact: true })).toContainText('批注 (1)')

    // 二次重复恢复验证幂等性（新增 0 篇、已有 1 篇、批注不重复）
    await pageB.getByRole('button', { name: '从备份恢复文献库', exact: true }).click()
    await expect(pageB.locator('.library-feedback--success')).toContainText('已有 1 篇', { timeout: 20000 })
    await expect(pageB.getByRole('button', { name: '批注与笔记', exact: true })).toContainText('批注 (1)')
    expect(failures).toEqual([])
  } finally {
    await runningB.app.close()
  }
})
