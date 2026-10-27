import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ZodError } from 'zod'
import { CHANNELS } from '../../shared/contracts'
import { documentIdArgsSchema, noArgsSchema, pageCountArgsSchema, readerStateArgsSchema } from '../../shared/schemas'
import { APP_URL, developmentUrl } from '../services/app-protocol'
import type { LibraryDatabase } from '../services/database'
import type { DocumentService } from '../services/document-service'
export function registerIpc(getWindow: () => BrowserWindow | null, database: LibraryDatabase, documents: DocumentService): void {
  const guard = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = getWindow()
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== (developmentUrl() ?? APP_URL)) throw new Error('拒绝不受信任的请求来源。')
    return window
  }
  function handle(channel: string, run: (window: BrowserWindow, args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const window = guard(event)
      try { return run(window, args) }
      catch (error: unknown) {
        if (error instanceof ZodError) throw new Error('请求参数无效。')
        throw error
      }
    })
  }
  handle(CHANNELS.importPdf, async (window, args) => {
    noArgsSchema.parse(args)
    const selection = await dialog.showOpenDialog(window, { title: '导入 PDF 文献', properties: ['openFile'], filters: [{ name: 'PDF 文献', extensions: ['pdf'] }] })
    if (selection.canceled || !selection.filePaths[0]) return null
    return documents.importFile(selection.filePaths[0])
  })
  handle(CHANNELS.listDocuments, (_window, args) => { noArgsSchema.parse(args); return database.listDocuments() })
  handle(CHANNELS.readPdfBytes, (_window, args) => { const [id] = documentIdArgsSchema.parse(args); return documents.readPdfBytes(id) })
  handle(CHANNELS.updatePageCount, (_window, args) => { const [id, count] = pageCountArgsSchema.parse(args); database.updatePageCount(id, count) })
  handle(CHANNELS.getReaderState, (_window, args) => { const [id] = documentIdArgsSchema.parse(args); return database.getReaderState(id) })
  handle(CHANNELS.saveReaderState, (_window, args) => { const [state] = readerStateArgsSchema.parse(args); database.saveReaderState({ ...state, updatedAt: new Date().toISOString() }) })
}
