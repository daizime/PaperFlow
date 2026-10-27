import { cpSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
const require = createRequire(resolve('package.json'))
const source = dirname(require.resolve('pdfjs-dist/package.json'))
const target = resolve('src/renderer/public/pdfjs')
mkdirSync(target, { recursive: true })
for (const name of ['quickjs-eval.js', 'quickjs-eval.wasm']) {
  const stale = join(target, 'wasm', name)
  if (existsSync(stale)) unlinkSync(stale)
}
for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(join(source, directory), join(target, directory), {
  recursive: true, filter: path => !basename(path).startsWith('quickjs-eval')
})
console.log('PDF.js CMaps、字体与 WASM 已准备为本地资源')
