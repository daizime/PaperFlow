import { BrowserWindow, session } from 'electron'
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
  const window = new BrowserWindow({
    title: 'PaperFlow', width: 1440, height: 900, minWidth: 1080, minHeight: 680,
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
  window.once('ready-to-show', () => window.show())
  await window.loadURL(developmentUrl() ?? APP_URL)
  return window
}
