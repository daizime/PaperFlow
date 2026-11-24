import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { createTestData, launchApp } from './helpers'

test('安全边界：未知资源/外网请求/非主窗口 IPC 被拒绝', async () => {
  const { app, page } = await launchApp(await createTestData())
  try {
    expect(await page.evaluate(async () => (await fetch('app://bundle/package.json')).status)).toBe(403)
    expect(await page.evaluate(async () => {
      try { await fetch('https://example.com/'); return 'unexpected' } catch { return 'denied' }
    })).toBe('denied')
    const appPath = await app.evaluate(({ app }) => app.getAppPath())
    const result = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const other = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      try {
        await other.loadURL('app://bundle/index.html')
        return await other.webContents.executeJavaScript("window.paperflow.listDocuments().then(() => 'unexpected', () => 'denied')")
      } finally { other.destroy() }
    }, resolve(appPath, 'out/preload/index.js'))
    expect(result).toBe('denied')
  } finally { await app.close() }
})
