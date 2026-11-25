import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export async function createTestData(): Promise<string> {
  const runRoot = process.env.PAPERFLOW_E2E_RUN_ROOT
  if (runRoot) {
    await mkdir(runRoot, { recursive: true })
    return mkdtemp(join(runRoot, 'case-'))
  }
  return mkdtemp(join(tmpdir(), 'paperflow-e2e-'))
}

export async function launchApp(dataDir: string, options: { deviceScaleFactor?: number } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const factor = options.deviceScaleFactor
  if (factor !== undefined && (!Number.isFinite(factor) || factor <= 0)) {
    throw new Error('deviceScaleFactor must be a finite positive number')
  }
  const app = await electron.launch({
    ...(process.env.PAPERFLOW_EXECUTABLE ? { executablePath: process.env.PAPERFLOW_EXECUTABLE } : {}),
    args: [
      ...(process.env.PAPERFLOW_EXECUTABLE ? [] : [resolve('out/main/index.js')]),
      '--user-data-dir=' + dataDir,
      ...(factor === undefined ? [] : ['--force-device-scale-factor=' + factor])
    ],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText('PaperFlow', { exact: true })).toBeVisible()
    if (factor !== undefined) {
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return
        win.setMinimumSize(1080, 680)
        win.setSize(1440, 900)
      })
      await expect.poll(() => page.evaluate(() => window.innerWidth >= 1040 && window.innerHeight >= 620)).toBe(true)
      await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(factor, 2)
    }
    return { app, page }
  } catch (error) {
    await app.close()
    throw error
  }
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
