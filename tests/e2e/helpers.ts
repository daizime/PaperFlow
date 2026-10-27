import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
export async function createTestData(): Promise<string> { return mkdtemp(join(tmpdir(), 'paperflow-e2e-')) }
export async function launchApp(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    ...(process.env.PAPERFLOW_EXECUTABLE ? { executablePath: process.env.PAPERFLOW_EXECUTABLE } : {}),
    args: [...(process.env.PAPERFLOW_EXECUTABLE ? [] : [resolve('out/main/index.js')]), '--user-data-dir=' + dataDir],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' }
  })
  const page = await app.firstWindow()
  await expect(page.getByText('PaperFlow', { exact: true })).toBeVisible()
  return { app, page }
}
/** Playwright 无法操作系统原生文件框，替换其返回值；后续导入/校验/复制/DB/界面全部真实运行。 */
export async function importFixture(app: ElectronApplication, page: Page, relativePath: string): Promise<void> {
  const path = resolve('tests/fixtures', relativePath)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, path)
  await page.getByRole('button', { name: '导入 PDF', exact: true }).click()
  await expect(page.getByRole('button', { name: '导入 PDF', exact: true })).toBeEnabled({ timeout: 30000 })
}
