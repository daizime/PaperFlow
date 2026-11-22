import { _electron as electron } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function verify(): Promise<void> {
  // 原生兼容性检查也使用隔离数据，避免加载真实文献库或更新其阅读状态。
  const dataDirectory = await mkdtemp(join(tmpdir(), 'paperflow-native-'))
  const app = await electron.launch({ args: [resolve('out/main/index.js'), '--user-data-dir=' + dataDirectory], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
  try {
    const page = await app.firstWindow()
    await page.getByText('PaperFlow', { exact: true }).waitFor()
    console.log(await app.evaluate(() => {
      const { createRequire } = process.getBuiltinModule('node:module')
      const require = createRequire(process.cwd() + '/package.json')
      const Database = require('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(':memory:')
      const version = db.prepare('SELECT sqlite_version() AS version').get() as { version: string }
      db.close()
      return { electron: process.versions.electron, napi: process.versions.napi, sqlite: version.version }
    }))
  } finally { await app.close() }
}
void verify().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
