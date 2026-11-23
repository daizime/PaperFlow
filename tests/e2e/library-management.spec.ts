import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createTestData, importFixture, launchApp } from './helpers'

test('启动自动清理孤立 UUID 副本与临时文件，保留已入库文献与无关文件', async () => {
  const data = await createTestData()
  let running = await launchApp(data)
  let importedId = ''
  try {
    await importFixture(running.app, running.page, 'valid.pdf')
    await expect(running.page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    const records = await running.page.evaluate(() => window.paperflow.listDocuments())
    expect(records).toHaveLength(1)
    importedId = records[0].id
  } finally {
    await running.app.close()
  }

  const libraryDir = join(data, 'library')
  const orphanPdf = '33333333-3333-4333-8333-333333333333.pdf'
  const orphanTmp = '.44444444-4444-4444-8444-444444444444.tmp'
  const unrelatedUserFile = 'user-keep-note.txt'
  await copyFile(resolve('tests/fixtures/valid.pdf'), join(libraryDir, orphanPdf))
  await writeFile(join(libraryDir, orphanTmp), '%PDF-1.7\nstale-temp')
  await writeFile(join(libraryDir, unrelatedUserFile), 'keep me')

  running = await launchApp(data)
  try {
    await expect(running.page.locator('.document-item')).toHaveCount(1)
    await expect(running.page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    expect((await readdir(libraryDir)).sort()).toEqual([`${importedId}.pdf`, unrelatedUserFile].sort())
  } finally {
    await running.app.close()
  }
})

test('内联重命名持久保存并同时支持自定义标题与原文件名搜索', async () => {
  const data = await createTestData()
  let running = await launchApp(data)
  try {
    await importFixture(running.app, running.page, 'valid.pdf')
    await expect(running.page.locator('.document-description strong')).toHaveText(['valid.pdf'])

    // 先取消一次，确认不会误改标题。
    await running.page.getByRole('button', { name: '重命名 valid.pdf', exact: true }).click()
    const input = running.page.getByRole('textbox', { name: '编辑文献标题' })
    await expect(input).toBeVisible()
    await input.fill('临时取消标题')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(running.page.locator('.document-description strong')).toHaveText(['valid.pdf'])

    // 正式提交重命名。
    await running.page.getByRole('button', { name: '重命名 valid.pdf', exact: true }).click()
    await input.fill('  本地文献研究笔记  ')
    await input.press('Enter')

    await expect(running.page.locator('.document-description strong')).toHaveText(['本地文献研究笔记'])
    await expect(running.page.locator('.reader-document-title')).toHaveText('本地文献研究笔记')

    const search = running.page.getByRole('searchbox', { name: '搜索文献' })
    await search.fill('研究笔记')
    await expect(running.page.locator('.document-item')).toHaveCount(1)
    await search.fill('valid.pdf')
    await expect(running.page.locator('.document-item')).toHaveCount(1)
    await search.fill('不存在的关键词')
    await expect(running.page.locator('.document-item')).toHaveCount(0)
    await running.page.getByRole('button', { name: '查看全部文献', exact: true }).click()
    await expect(running.page.locator('.document-item')).toHaveCount(1)
  } finally {
    await running.app.close()
  }

  running = await launchApp(data)
  try {
    await expect(running.page.locator('.document-description strong')).toHaveText(['本地文献研究笔记'])
    await expect(running.page.locator('.reader-document-title')).toHaveText('本地文献研究笔记')
  } finally {
    await running.app.close()
  }
})

test('内联删除同步清理界面条目、磁盘文件、级联阅读进度与本地选区记忆', async () => {
  const data = await createTestData()
  let running = await launchApp(data)
  let validId = ''
  let paperId = ''
  try {
    await importFixture(running.app, running.page, 'valid.pdf')
    await expect(running.page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    await importFixture(running.app, running.page, 'same-name-b/paper.pdf')
    await expect(running.page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })

    const records = await running.page.evaluate(() => window.paperflow.listDocuments())
    const paperDoc = records.find(doc => doc.originalFilename === 'paper.pdf')
    const validDoc = records.find(doc => doc.originalFilename === 'valid.pdf')
    expect(paperDoc).toBeDefined()
    expect(validDoc).toBeDefined()
    paperId = paperDoc!.id
    validId = validDoc!.id

    const pageInput = running.page.getByRole('spinbutton', { name: '当前页码' })
    await pageInput.fill('2')
    await pageInput.press('Enter')
    await expect(running.page.locator('.pdf-page[data-page-number="2"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    await expect.poll(() => running.page.evaluate(id => window.paperflow.getReaderState(id), paperId)).toMatchObject({ pageNumber: 2 })

    await running.page.getByRole('button', { name: '删除 paper.pdf', exact: true }).click()
    await expect(running.page.getByRole('button', { name: '确认删除', exact: true })).toBeVisible()
    await running.page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(running.page.locator('.document-item')).toHaveCount(2)

    await running.page.getByRole('button', { name: '删除 paper.pdf', exact: true }).click()
    await running.page.getByRole('button', { name: '确认删除', exact: true }).click()

    await expect(running.page.locator('.document-item')).toHaveCount(1)
    await expect(running.page.locator('.document-description strong')).toHaveText(['valid.pdf'])
    await expect(running.page.locator('.reader-document-title')).toHaveText('valid.pdf')
    expect(await readdir(join(data, 'library'))).toEqual([`${validId}.pdf`])
  } finally {
    await running.app.close()
  }

  const inspection = new Database(join(data, 'paperflow.sqlite'), { readonly: true })
  try {
    const docCount = inspection.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }
    const deletedState = inspection.prepare('SELECT COUNT(*) AS count FROM reader_state WHERE document_id = ?').get(paperId) as { count: number }
    expect(docCount.count).toBe(1)
    expect(deletedState.count).toBe(0)
  } finally {
    inspection.close()
  }

  running = await launchApp(data)
  try {
    await expect(running.page.locator('.document-item')).toHaveCount(1)
    await running.page.getByRole('button', { name: '删除 valid.pdf', exact: true }).click()
    await running.page.getByRole('button', { name: '确认删除', exact: true }).click()

    await expect(running.page.locator('.document-item')).toHaveCount(0)
    await expect(running.page.getByText('文献库为空', { exact: true })).toBeVisible()
    await expect(running.page.getByRole('heading', { name: '打开一篇 PDF' })).toBeVisible()
    expect(await running.page.evaluate(() => localStorage.getItem('paperflow:last-document'))).toBeNull()
    expect(await readdir(join(data, 'library'))).toEqual([])
  } finally {
    await running.app.close()
  }
})

test('拖拽批量导入展示覆盖层、不跳转页面、入库有效 PDF 并列出详细失败原因', async () => {
  const data = await createTestData()
  const { app, page } = await launchApp(data)
  try {
    const validBytes = Array.from(await readFile(resolve('tests/fixtures/valid.pdf')))
    const corruptBytes = Array.from(await readFile(resolve('tests/fixtures/corrupt.pdf')))

    await page.evaluate(() => {
      const workspace = document.querySelector('.workspace')
      if (!workspace) throw new Error('Missing .workspace')
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array([37, 80, 68, 70])], 'preview.pdf', { type: 'application/pdf' }))
      workspace.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
      workspace.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    await expect(page.getByText('释放以导入 PDF 文献', { exact: true })).toBeVisible()

    await page.evaluate(({ valid, corrupt }) => {
      const workspace = document.querySelector('.workspace')
      if (!workspace) throw new Error('Missing .workspace')
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(valid)], 'valid.pdf', { type: 'application/pdf' }))
      dt.items.add(new File([new TextEncoder().encode('plain text')], 'notes.txt', { type: 'text/plain' }))
      dt.items.add(new File([new Uint8Array(corrupt)], 'corrupt.pdf', { type: 'application/pdf' }))
      workspace.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, { valid: validBytes, corrupt: corruptBytes })

    await expect(page.getByText('释放以导入 PDF 文献', { exact: true })).toHaveCount(0)
    expect(page.url()).toBe('app://bundle/index.html')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(
      window => window.getTitle() === 'PaperFlow' && window.webContents.getURL() === 'app://bundle/index.html'
    ))).toBe(true)

    await expect(page.locator('.document-item')).toHaveCount(1)
    await expect(page.locator('.document-description strong')).toHaveText(['valid.pdf'])
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })

    const notice = page.getByRole('status').filter({ hasText: '批量导入完成' })
    await expect(notice).toContainText('成功导入 1 篇')
    await expect(notice).toContainText('失败 2 篇')
    expect(page.url()).toBe('app://bundle/index.html')
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.webContents.getURL()))).toEqual(['app://bundle/index.html'])

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('notes.txt')
    await expect(alert).toContainText('扩展名')
    await expect(alert).toContainText('corrupt.pdf')
    await expect(alert).toContainText('损坏')

    await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
