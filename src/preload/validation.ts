import { contextBridge, ipcRenderer } from 'electron'
// 仅隐藏的校验窗口加载；主窗口不暴露此接口。
contextBridge.exposeInMainWorld('pdfValidation', {
  onBytes: (callback: (bytes: Uint8Array) => void) => {
    ipcRenderer.once('pdf-validator:bytes', (_event, bytes: Uint8Array) => callback(bytes))
  },
  report: (result: { pageCount: number | null; error: string | null }) => ipcRenderer.send('pdf-validator:result', result)
})
