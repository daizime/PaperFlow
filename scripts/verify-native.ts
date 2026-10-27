import { _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'

async function verify(): Promise<void> {
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
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
