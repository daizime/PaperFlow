import { test, expect } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { importFixture, launchApp } from './helpers'

const evidenceDirectory = resolve(process.env.PAPERFLOW_QA_EVIDENCE_DIR ?? '.cache/qa/verification')

async function isolatedData(label: string): Promise<string> {
  await mkdir(evidenceDirectory, { recursive: true })
  return mkdtemp(join(evidenceDirectory, label + '-'))
}

for (const deviceScaleFactor of [1, 1.25, 1.5, 2, 3]) {
  test('QA 进程 DPI 模拟倍率 ' + deviceScaleFactor, async () => {
    const { app, page } = await launchApp(await isolatedData('dpi'), { deviceScaleFactor })
    try {
      const actual = await page.evaluate(() => window.devicePixelRatio)
      expect(actual).toBeCloseTo(deviceScaleFactor, 2)
      await writeFile(join(evidenceDirectory, 'dpi-' + deviceScaleFactor + '.json'), JSON.stringify({
        requested: deviceScaleFactor, actual, mode: 'process simulation; not physical display verification'
      }, null, 2))
    } finally { await app.close() }
  })
}

test('QA 阅读、文字复制及正常关闭恢复（文件框返回值注入）', async () => {
  const data = await isolatedData('installed-reader')
  let running = await launchApp(data)
  try {
    const { app, page } = running
    // 此用例只验证后续读取与退出；不能作为原生文件框选择证据。
    await importFixture(app, page, 'valid.pdf')
    const firstPage = page.locator('.pdf-page[data-page-number="1"]')
    await expect(firstPage).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    const text = firstPage.locator('.textLayer span').filter({ hasText: 'Selectable text on page 1' }).first()
    await text.scrollIntoViewIfNeeded()
    const box = await text.boundingBox()
    expect(box).not.toBeNull()
    if (!box) throw new Error('Selectable fixture text has no visible bounds')
    await page.mouse.move(box.x + 1, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 20 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Selectable')
    await page.keyboard.press('Control+C')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Selectable')
    await page.getByRole('spinbutton', { name: '当前页码' }).fill('3')
    await page.getByRole('spinbutton', { name: '当前页码' }).press('Enter')
    await expect(page.locator('.pdf-page[data-page-number="3"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    const exit = new Promise<number | null>(resolveExit => app.process().once('exit', resolveExit))
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    expect(await exit).toBe(0)
    running = await launchApp(data)
    await expect(running.page.locator('.document-item')).toHaveCount(1)
    await expect(running.page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('3')
    await writeFile(join(evidenceDirectory, 'installed-reader.json'), JSON.stringify({
      executable: process.env.PAPERFLOW_EXECUTABLE ?? resolve('out/main/index.js'),
      dataDirectory: data, dialogMode: 'injected return value', rendered: true,
      mouseSelectionAndClipboard: true, normalWindowCloseExitCode: 0, restoredPage: 3
    }, null, 2))
  } finally { await running.app.close() }
})
