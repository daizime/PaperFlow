import { expect, test, type ElectronApplication } from '@playwright/test'
import type { OpenDialogReturnValue } from 'electron'
import { resolve } from 'node:path'
import { createTestData, importFixture, launchApp } from './helpers'

interface PendingPicker { calls: number; finish(files: string[] | null): void }
type TestMain = typeof globalThis & { paperflowPendingPicker?: PendingPicker }

/** Hold the native picker response to observe the real renderer's import state. */
async function holdPicker(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const testMain = globalThis as TestMain
    const picker: PendingPicker = { calls: 0, finish: () => {} }
    const response = new Promise<OpenDialogReturnValue>(resolve => {
      picker.finish = files => resolve({ canceled: files === null, filePaths: files ?? [] })
    })
    testMain.paperflowPendingPicker = picker
    dialog.showOpenDialog = async () => {
      picker.calls++
      return response
    }
  })
}

async function finishPicker(app: ElectronApplication, files: string[] | null): Promise<void> {
  await app.evaluate((_, paths) => { (globalThis as TestMain).paperflowPendingPicker?.finish(paths) }, files)
}

test('基础界面：首屏选择真实 PDF，全部导入入口共享忙状态', async () => {
  const info = test.info()
  const { app, page } = await launchApp(await createTestData())
  const central = page.getByRole('button', { name: '选择 PDF 文件', exact: true })
  const sidebar = page.getByRole('button', { name: '导入 PDF', exact: true })
  const search = page.getByRole('searchbox', { name: '搜索文献' })
  const toolbar = page.getByRole('button', { name: '打开新 PDF', exact: true })
  try {
    await expect(central).toBeEnabled()
    await expect(search).toBeDisabled()
    await expect(page.getByRole('heading', { name: '尚未翻译' })).toBeVisible()
    await expect(page.locator('.pdf-page canvas')).toHaveCount(0)
    await info.attach('paperflow-empty-workspace', { body: await page.screenshot(), contentType: 'image/png' })

    await holdPicker(app)
    await central.click()
    await expect(sidebar).toBeDisabled()
    await expect(central).toBeDisabled()
    await expect.poll(() => app.evaluate(() => (globalThis as TestMain).paperflowPendingPicker?.calls)).toBe(1)
    await finishPicker(app, [resolve('tests/fixtures/valid.pdf')])
    await expect(page.locator('.document-item')).toHaveCount(1)
    await expect(page.locator('.pdf-page[data-page-number="1"][data-rendered="true"] canvas')).toBeVisible()
    await expect(page.locator('.pdf-page[data-page-number="1"] .textLayer')).toContainText('PaperFlow Research Fixture')
    await expect(toolbar).toBeEnabled()
    await info.attach('paperflow-reading-workspace', { body: await page.screenshot(), contentType: 'image/png' })

    await search.fill('valid')
    await holdPicker(app)
    await toolbar.click()
    await expect(toolbar).toBeDisabled()
    await expect(sidebar).toBeDisabled()
    await finishPicker(app, null)
    await expect(toolbar).toBeEnabled()
    await expect(sidebar).toBeEnabled()
    await expect(page.locator('.document-item')).toHaveCount(1)
    await expect(search).toHaveValue('valid')
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await finishPicker(app, null).catch(() => {})
    await app.close()
  }
})

test('基础界面：显示导入与去重结果，搜索时保留正在阅读的文献', async () => {
  const { app, page } = await launchApp(await createTestData())
  try {
    await importFixture(app, page, 'valid.pdf')
    await expect(page.getByText('已导入 PDF', { exact: true })).toBeVisible()
    await importFixture(app, page, 'same-name-b/paper.pdf')
    await expect(page.locator('.document-item')).toHaveCount(2)
    await expect(page.locator('.reader-document-title')).toHaveText('paper.pdf')
    const search = page.getByRole('searchbox', { name: '搜索文献' })
    await search.fill('VALID')
    await expect(page.locator('.document-item')).toHaveCount(1)
    await expect(page.locator('.document-item')).toContainText('valid.pdf')
    await expect(page.locator('.reader-document-title')).toHaveText('paper.pdf')
    await search.fill('仅测试使用的无匹配词')
    await expect(page.getByText('没有找到匹配的文献', { exact: true })).toBeVisible()
    await search.fill('')
    await expect(page.locator('.document-item')).toHaveCount(2)
    await importFixture(app, page, 'valid.pdf')
    await expect(page.getByText('这份 PDF 已在文献库中', { exact: true })).toBeVisible()
    await expect(page.locator('.document-item')).toHaveCount(2)
    await expect(page.locator('.reader-document-title')).toHaveText('valid.pdf')
  } finally {
    await app.close()
  }
})
