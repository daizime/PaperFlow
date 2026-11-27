import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { registerAppScheme, installAppProtocol } from './services/app-protocol'
import { createWindow, installSessionSecurity } from './window'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { BackupService } from './services/backup-service'
import { LibraryDatabase } from './services/database'
import { DocumentService } from './services/document-service'
import { LiteratureSearchService } from './services/literature-search-service'
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
  translationService = new TranslationService({
    database,
    safeStorage,
    authorizeCli: async request => {
      const window = mainWindow
      if (!window || window.isDestroyed()) return false
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '授权本机 AI 程序',
        message: '确认允许 PaperFlow 以你的系统账号运行此程序',
        detail: [
          `程序：${request.resolvedExecutable}`,
          `参数：${request.args.map(argument => JSON.stringify(argument)).join(' ') || '无'}`,
          `最长运行时间：${request.timeoutSec} 秒`,
          '',
          '授权后，这个程序及以上参数可用于连接测试、翻译和其他 AI 功能。'
        ].join('\n'),
        buttons: ['取消', '授权此程序和参数'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return response === 1 && !window.isDestroyed()
    }
  })
  const backupService = new BackupService(database, documents)
  const testLitBase = process.env.PAPERFLOW_TEST_LITERATURE_BASE?.trim()
  const literatureSearch = new LiteratureSearchService({
    database,
    documents,
    translations: translationService,
    ...(testLitBase
      ? {
          openAlexBaseUrl: `${testLitBase.replace(/\/+$/, '')}/openalex`,
          arxivBaseUrl: `${testLitBase.replace(/\/+$/, '')}/arxiv`,
          allowInsecureTestBase: testLitBase
        }
      : {})
  })
  await documents.cleanupOrphanFiles()
  registerIpc(() => mainWindow, database, documents, translationService, backupService, literatureSearch)
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
