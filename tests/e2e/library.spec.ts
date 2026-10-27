import { test, expect } from '@playwright/test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createTestData, importFixture, launchApp } from './helpers'
test('T02 导入、去重、同名共存、IPC、损坏拒绝、数据库重启', async () => {
  const data = await createTestData()
  let running = await launchApp(data)
  try {
    const { app, page } = running
    await importFixture(app, page, 'same-name-a/paper.pdf')
    await expect(page.locator('.document-item')).toHaveCount(1)
    await expect(page.locator('.document-description small')).toContainText('3 页')
    await importFixture(app, page, 'valid.pdf')
    await expect(page.locator('.document-item')).toHaveCount(1)
    await importFixture(app, page, 'same-name-b/paper.pdf')
    await expect(page.locator('.document-item')).toHaveCount(2)
    await expect(page.locator('.document-description strong')).toHaveText(['paper.pdf', 'paper.pdf'])
    const records = await page.evaluate(() => window.paperflow.listDocuments())
    expect(await page.evaluate(async id => (await window.paperflow.readPdfBytes(id)).byteLength, records[0].id)).toBeGreaterThan(100)
    expect((await readdir(join(data, 'library'))).filter(file => file.endsWith('.pdf'))).toHaveLength(2)
    const invalid = await page.evaluate(async () => {
      try { await window.paperflow.readPdfBytes('../../Windows/win.ini'); return 'unexpected' }
      catch (error: unknown) { return error instanceof Error ? error.message : String(error) }
    })
    expect(invalid).not.toBe('unexpected')
    const missing = await page.evaluate(async () => {
      try { await window.paperflow.readPdfBytes('11111111-1111-4111-8111-111111111111'); return 'unexpected' }
      catch { return 'denied' }
    })
    expect(missing).toBe('denied')
    await page.evaluate(id => window.paperflow.saveReaderState({ documentId: id, pageNumber: 2, scale: 1.5, updatedAt: new Date().toISOString() }), records[1].id)
    await importFixture(app, page, 'corrupt.pdf')
    await expect(page.getByRole('alert')).toContainText('损坏')
    await expect(page.locator('.document-item')).toHaveCount(2)
    await expect(page.getByText('PaperFlow', { exact: true })).toBeVisible()
    await app.close()
    running = await launchApp(data)
    await expect(running.page.locator('.document-item')).toHaveCount(2)
    expect(await running.page.evaluate(id => window.paperflow.getReaderState(id), records[1].id)).toMatchObject({ pageNumber: 2, scale: 1.5 })
  } finally { await running.app.close() }
})
