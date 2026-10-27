import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { developmentUrl } from './app-protocol'
const resultSchema = z.object({ pageCount: z.number().int().positive().nullable(), error: z.string().max(200).nullable() }).strict()
/** 不在高权限主进程解析 PDF。独立沙盒窗口只获得待校验字节，结束即销毁。 */
export async function validatePdfInSandbox(bytes: Uint8Array): Promise<number> {
  const url = developmentUrl() ? 'http://127.0.0.1:5173/validation.html' : 'app://bundle/validation.html'
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: join(__dirname, '../preload/validation.js'),
    sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false
  } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-frame-navigate', event => event.preventDefault())
  let listener: (event: IpcMainEvent, result: unknown) => void = () => {}
  let timeout: ReturnType<typeof setTimeout> | undefined
  const result = new Promise<number>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('PDF 校验超时，文件可能过于复杂或已损坏。')), 20000)
    listener = (event, value) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== url) return
      const parsed = resultSchema.safeParse(value)
      if (!parsed.success) { reject(new Error('PDF 校验失败。')); return }
      if (parsed.data.pageCount && !parsed.data.error) resolve(parsed.data.pageCount)
      else reject(new Error(parsed.data.error ?? 'PDF 文件无有效页面。'))
    }
    ipcMain.on('pdf-validator:result', listener)
    window.webContents.once('render-process-gone', () => reject(new Error('PDF 校验进程异常退出，无法导入此文件。')))
  })
  // 立即挂接拒绝处理，避免窗口加载失败时产生未处理 rejection。
  void result.catch(() => {})
  try {
    await window.loadURL(url)
    window.webContents.send('pdf-validator:bytes', bytes)
    return await result
  } finally {
    if (timeout) clearTimeout(timeout)
    ipcMain.removeListener('pdf-validator:result', listener)
    if (!window.isDestroyed()) window.destroy()
  }
}
