import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { registerAppScheme, installAppProtocol } from './services/app-protocol'
import { createWindow, installSessionSecurity } from './window'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { BackupService } from './services/backup-service'
import { LibraryDatabase } from './services/database'
import { DocumentService } from './services/document-service'
import { validatePdfInSandbox } from './services/pdf-validation'
import { TranslationService } from './services/translation-service'
import { registerIpc } from './ipc'

registerAppScheme()
app.setName('PaperFlow')
app.setAppUserModelId('org.paperflow.desktop')
// 明确的本机启动参数，便于便携数据目录和隔离自动化测试；不经 renderer 暴露。
const dataDirectory = app.commandLine.getSwitchValue('user-data-dir')
if (dataDirectory) {
  if (!isAbsolute(dataDirectory)) throw new Error('用户数据目录必须为绝对路径。')
  mkdirSync(dataDirectory, { recursive: true })
  app.setPath('userData', dataDirectory)
}
let database: LibraryDatabase | undefined
let translationService: TranslationService | undefined
let mainWindow: BrowserWindow | null = null
let quitting = false
app.on('before-quit', () => {
  quitting = true
  translationService?.cancelAll()
})
app.on('will-quit', () => {
  translationService?.cancelAll()
  database?.close()
})
app.whenReady().then(async () => {
  installAppProtocol()
  installSessionSecurity()
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  database = new LibraryDatabase(join(userData, 'paperflow.sqlite'))
  const documents = new DocumentService(database, join(userData, 'library'), validatePdfInSandbox)
  translationService = new TranslationService({ database, safeStorage })
  const backupService = new BackupService(database, documents)
  await documents.cleanupOrphanFiles()
  registerIpc(() => mainWindow, database, documents, translationService, backupService)
  const remember = (window: BrowserWindow): void => { mainWindow = window; window.on('closed', () => { mainWindow = null }) }
  await createWindow(remember)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(remember)
  })
}).catch((error: unknown) => {
  if (quitting) return
  dialog.showErrorBox('PaperFlow 启动失败', error instanceof Error ? error.message : String(error))
  app.quit()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
