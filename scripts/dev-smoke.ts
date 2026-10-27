import { chromium, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

async function smoke(): Promise<void> {
  const source = resolve('src/renderer/src/features/translation/TranslationPanel.tsx')
  const original = await readFile(source, 'utf8')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await expect(page.getByText('尚未翻译', { exact: true })).toBeVisible()
    const token = await page.evaluate(() => { (window as unknown as Record<string, unknown>).__hmrProof = crypto.randomUUID(); return (window as unknown as Record<string, unknown>).__hmrProof })
    await writeFile(source, original.replace('尚未翻译', 'HMR 已更新'))
    await expect(page.getByText('HMR 已更新', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__hmrProof)).toBe(token)
    expect(errors).toEqual([])
    console.log('PASS: pnpm dev 真实窗口、React HMR 保留页面上下文、无 pageerror')
  } finally {
    await writeFile(source, original)
    await browser.close()
  }
}
void smoke().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
