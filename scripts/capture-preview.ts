import { expect } from '@playwright/test'
import { resolve } from 'node:path'
import { createTestData, importFixture, launchApp } from '../tests/e2e/helpers'

async function capture(): Promise<void> {
  const { app, page } = await launchApp(await createTestData())
  try {
    await importFixture(app, page, 'valid.pdf')
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true')
    for (let index = 0; index < 4; index++) await page.getByRole('button', { name: '缩小', exact: true }).click()
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true')
    await page.screenshot({ path: resolve('docs/paperflow-reader.png') })
    console.log('已保存真实 PDF 阅读画面：docs/paperflow-reader.png')
  } finally { await app.close() }
}
void capture().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
