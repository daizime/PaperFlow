import { BrowserWindow, screen, session } from 'electron'
import { join } from 'node:path'
import { APP_URL, DEV_ORIGIN, contentSecurityPolicy, developmentUrl } from './services/app-protocol'
export function installSessionSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  const dev = developmentUrl() !== null
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false
    try {
      const url = new URL(details.url)
      allowed = url.protocol === 'app:' && url.host === 'bundle' ||
        dev && (url.origin === DEV_ORIGIN || url.origin === 'ws://127.0.0.1:5173') ||
        ['devtools:', 'blob:', 'data:'].includes(url.protocol)
    } catch {
      allowed = false
    }
    callback({ cancel: !allowed })
  })
  if (dev) session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [contentSecurityPolicy(true)] } })
  })
}
export async function createWindow(onCreated?: (window: BrowserWindow) => void): Promise<BrowserWindow> {
  let width = 1440
  let height = 900
  let minWidth = 1080
  let minHeight = 680
  if (process.platform === 'linux') {
    const workArea = screen.getPrimaryDisplay().workAreaSize
    minWidth = Math.min(1080, Math.max(640, Math.floor(workArea.width * 0.7)))
    minHeight = Math.min(680, Math.max(440, Math.floor(workArea.height * 0.7)))
    width = Math.min(1440, Math.max(minWidth, Math.floor(workArea.width * 0.92)))
    height = Math.min(900, Math.max(minHeight, Math.floor(workArea.height * 0.92)))
  }
  const window = new BrowserWindow({
    title: 'PaperFlow', width, height, minWidth, minHeight, resizable: true, maximizable: true,
    show: false, autoHideMenuBar: true, backgroundColor: '#f5f6f8',
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true,
      webviewTag: false, allowRunningInsecureContent: false
    }
  })
  onCreated?.(window)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-frame-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  let closeAllowed = false
  let flushing = false
  window.on('close', event => {
    if (closeAllowed) return
    event.preventDefault()
    if (flushing) return
    flushing = true
    // 只执行固定的本地事件，等待当前阅读进度落库后再关闭窗口。
    const flush = window.webContents.executeJavaScript(`(() => {
      const detail = { promises: [] };
      window.dispatchEvent(new CustomEvent('paperflow:before-close', { detail }));
      return Promise.all(detail.promises);
    })()`)
    void Promise.race([flush, new Promise<void>(resolve => setTimeout(resolve, 2000))]).catch(() => {}).finally(() => {
      closeAllowed = true
      if (!window.isDestroyed()) window.close()
    })
  })
  let shown = false
  let fallbackShowTimer: ReturnType<typeof setTimeout> | undefined
  const showOnce = (): void => {
    if (fallbackShowTimer) {
      clearTimeout(fallbackShowTimer)
      fallbackShowTimer = undefined
    }
    if (shown || window.isDestroyed()) return
    shown = true
    window.show()
  }
  window.once('ready-to-show', showOnce)
  window.once('closed', () => {
    if (fallbackShowTimer) {
      clearTimeout(fallbackShowTimer)
      fallbackShowTimer = undefined
    }
  })
  await window.loadURL(developmentUrl() ?? APP_URL)
  if (process.platform === 'linux' && !shown && !window.isDestroyed()) {
    fallbackShowTimer = setTimeout(showOnce, 400)
  }
  return window
}
