import { app, protocol } from 'electron'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
export const APP_URL = 'app://bundle/index.html'
export const DEV_ORIGIN = 'http://127.0.0.1:5173'
export function developmentUrl(): string | null {
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return null
  const url = new URL(process.env.ELECTRON_RENDERER_URL)
  if (url.origin !== DEV_ORIGIN || url.username || url.password) throw new Error('开发服务必须使用 http://127.0.0.1:5173')
  return url.href
}
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true
  } }])
}
export function contentSecurityPolicy(dev: boolean): string {
  return ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'" + (dev ? " 'nonce-paperflow-dev'" : ''), "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "font-src 'self' blob: data:", "worker-src 'self'",
    "connect-src 'self'" + (dev ? ' http://127.0.0.1:5173 ws://127.0.0.1:5173' : ''),
    "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ')
}
export function installAppProtocol(): void {
  const root = resolve(__dirname, '../renderer')
  // 只服务构建时已存在的资源，不将 URL 映射为任意磁盘路径。
  const assets = new Set<string>()
  function inventory(directory: string): void {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name)
      if (statSync(file).isDirectory()) inventory(file)
      else assets.add(relative(root, file).split(sep).join('/'))
    }
  }
  if (!developmentUrl()) inventory(root)
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' }
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url)
      const path = decodeURIComponent(url.pathname).slice(1)
      if (url.host !== 'bundle' || url.username || url.password || url.search || !['GET', 'HEAD'].includes(request.method) ||
          path.includes('\\') || path.includes('\0') || path.split('/').some(p => p === '.' || p === '..') || !assets.has(path)) {
        return new Response('Forbidden', { status: 403 })
      }
      return new Response(request.method === 'HEAD' ? null : readFileSync(join(root, path)), { headers: {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Content-Security-Policy': contentSecurityPolicy(false), 'X-Content-Type-Options': 'nosniff'
      } })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}
