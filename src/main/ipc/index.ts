import { BrowserWindow, ClipboardItem, clipboard, dialog, ipcMain, nativeImage, type IpcMainInvokeEvent } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { ZodError } from 'zod'
import { CHANNELS } from '../../shared/contracts'
import {
  cancelTranslationArgsSchema,
  copyImageDataUrlArgsSchema,
  copyTextArgsSchema,
  createAnnotationArgsSchema,
  deleteAnnotationArgsSchema,
  documentIdArgsSchema,
  explainSelectionArgsSchema,
  exportAnnotationsArgsSchema,
  getPageTranslationsArgsSchema,
  importPdfBytesArgsSchema,
  listAnnotationsArgsSchema,
  listReaderProgressArgsSchema,
  noArgsSchema,
  pageCountArgsSchema,
  readerStateArgsSchema,
  renameDocumentArgsSchema,
  saveTranslationSettingsArgsSchema,
  searchLibraryArgsSchema,
  translatePageArgsSchema,
  updateAnnotationArgsSchema,
  updateDocumentMetaArgsSchema
} from '../../shared/schemas'
import { formatAnnotationsMarkdown } from '../services/annotation-export'
import { APP_URL, developmentUrl } from '../services/app-protocol'
import type { BackupService } from '../services/backup-service'
import type { LibraryDatabase } from '../services/database'
import type { DocumentService } from '../services/document-service'
import type { TranslationService } from '../services/translation-service'

const MAX_BACKUP_ZIP_BYTES = 512 * 1024 * 1024

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  database: LibraryDatabase,
  documents: DocumentService,
  translations?: TranslationService,
  backups?: BackupService
): void {
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
  handle(CHANNELS.importPdfBytes, (_window, args) => {
    const [{ originalFilename, bytes }] = importPdfBytesArgsSchema.parse(args)
    return documents.importBuffer(originalFilename, bytes)
  })
  handle(CHANNELS.listDocuments, (_window, args) => { noArgsSchema.parse(args); return database.listDocuments() })
  handle(CHANNELS.readPdfBytes, (_window, args) => { const [id] = documentIdArgsSchema.parse(args); return documents.readPdfBytes(id) })
  handle(CHANNELS.updatePageCount, (_window, args) => { const [id, count] = pageCountArgsSchema.parse(args); database.updatePageCount(id, count) })
  handle(CHANNELS.renameDocument, (_window, args) => {
    const [id, displayTitle] = renameDocumentArgsSchema.parse(args)
    return database.renameDocument(id, displayTitle)
  })
  handle(CHANNELS.updateDocumentMeta, (_window, args) => {
    const [input] = updateDocumentMetaArgsSchema.parse(args)
    return database.updateDocumentMeta(input)
  })
  handle(CHANNELS.deleteDocument, (_window, args) => {
    const [id] = documentIdArgsSchema.parse(args)
    translations?.cancel(id)
    return documents.deleteDocument(id)
  })
  handle(CHANNELS.getReaderState, (_window, args) => { const [id] = documentIdArgsSchema.parse(args); return database.getReaderState(id) })
  handle(CHANNELS.saveReaderState, (_window, args) => { const [state] = readerStateArgsSchema.parse(args); database.saveReaderState({ ...state, updatedAt: new Date().toISOString() }) })
  handle(CHANNELS.listReaderProgress, (_window, args) => {
    listReaderProgressArgsSchema.parse(args)
    return database.listReaderProgress()
  })
  handle(CHANNELS.searchLibrary, (_window, args) => {
    const [query] = searchLibraryArgsSchema.parse(args)
    return database.searchLibrary(query)
  })

  if (translations) {
    handle(CHANNELS.getTranslationSettings, (_window, args) => {
      noArgsSchema.parse(args)
      return translations.getSettings()
    })
    handle(CHANNELS.saveTranslationSettings, (_window, args) => {
      const [input] = saveTranslationSettingsArgsSchema.parse(args)
      return translations.saveSettings(input)
    })
    handle(CHANNELS.testTranslationConnection, async (_window, args) => {
      noArgsSchema.parse(args)
      return translations.testConnection()
    })
    handle(CHANNELS.getPageTranslations, (_window, args) => {
      const [documentId, pageNumber] = getPageTranslationsArgsSchema.parse(args)
      return translations.getPageTranslations(documentId, pageNumber)
    })
    handle(CHANNELS.translatePage, async (_window, args) => {
      const [input] = translatePageArgsSchema.parse(args)
      return translations.translatePage(input, progress => {
        const currentWindow = getWindow()
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.webContents.send(CHANNELS.translationProgress, progress)
        }
      })
    })
    handle(CHANNELS.cancelTranslation, (_window, args) => {
      const parsed = cancelTranslationArgsSchema.parse(args)
      translations.cancel(parsed[0])
    })
    handle(CHANNELS.clearDocumentTranslations, (_window, args) => {
      const [documentId] = documentIdArgsSchema.parse(args)
      translations.clearDocumentTranslations(documentId)
    })
    handle(CHANNELS.explainSelection, async (_window, args) => {
      const [input] = explainSelectionArgsSchema.parse(args)
      return translations.explainSelection(input)
    })
  }

  handle(CHANNELS.listAnnotations, (_window, args) => {
    const [documentId] = listAnnotationsArgsSchema.parse(args)
    return database.listAnnotations(documentId)
  })
  handle(CHANNELS.createAnnotation, (_window, args) => {
    const [input] = createAnnotationArgsSchema.parse(args)
    return database.createAnnotation(input)
  })
  handle(CHANNELS.updateAnnotation, (_window, args) => {
    const [input] = updateAnnotationArgsSchema.parse(args)
    return database.updateAnnotation(input)
  })
  handle(CHANNELS.deleteAnnotation, (_window, args) => {
    const [annotationId] = deleteAnnotationArgsSchema.parse(args)
    database.deleteAnnotation(annotationId)
  })
  handle(CHANNELS.exportAnnotationsMarkdown, async (window, args) => {
    const [documentId] = exportAnnotationsArgsSchema.parse(args)
    const document = database.getDocument(documentId)
    if (!document) throw new Error('文献不存在，请重新选择文献。')
    const annotations = database.listAnnotations(document.id)
    const markdown = formatAnnotationsMarkdown(document, annotations)
    const safeStem = (document.displayTitle || 'paperflow-notes').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
    const result = await dialog.showSaveDialog(window, {
      title: '导出批注为 Markdown',
      defaultPath: `${safeStem}-批注.md`,
      filters: [{ name: 'Markdown 文件', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) {
      return { canceled: true, markdown, count: annotations.length }
    }
    await writeFile(result.filePath, markdown, 'utf8')
    return { canceled: false, markdown, count: annotations.length, fileName: basename(result.filePath) }
  })

  if (backups) {
    handle(CHANNELS.exportBackup, async (window, args) => {
      noArgsSchema.parse(args)
      const dateTag = new Date().toISOString().slice(0, 10)
      const selection = await dialog.showSaveDialog(window, {
        title: '导出文献库一键备份包',
        defaultPath: `PaperFlow-Backup-${dateTag}.zip`,
        filters: [{ name: 'PaperFlow 备份压缩包', extensions: ['zip'] }]
      })
      if (selection.canceled || !selection.filePath) {
        return {
          canceled: true,
          documentCount: 0,
          annotationCount: 0,
          translationCount: 0,
          glossaryCount: 0
        }
      }
      const exported = await backups.exportBackupArchive()
      await writeFile(selection.filePath, exported.zipBuffer)
      return {
        canceled: false,
        fileName: basename(selection.filePath),
        documentCount: exported.documentCount,
        annotationCount: exported.annotationCount,
        translationCount: exported.translationCount,
        glossaryCount: exported.glossaryCount
      }
    })

    handle(CHANNELS.importBackup, async (window, args) => {
      noArgsSchema.parse(args)
      const selection = await dialog.showOpenDialog(window, {
        title: '选择 PaperFlow 备份压缩包',
        properties: ['openFile'],
        filters: [{ name: 'PaperFlow 备份压缩包', extensions: ['zip'] }]
      })
      if (selection.canceled || !selection.filePaths[0]) {
        return {
          canceled: true,
          importedDocuments: 0,
          existingDocuments: 0,
          restoredAnnotations: 0,
          restoredTranslations: 0,
          restoredGlossary: 0
        }
      }
      const zipPath = selection.filePaths[0]
      const info = await stat(zipPath)
      if (!info.isFile() || info.size === 0 || info.size > MAX_BACKUP_ZIP_BYTES) {
        throw new Error('备份文件无效或体积超过 512 MiB 上限。')
      }
      const bytes = await readFile(zipPath)
      const imported = await backups.importBackupArchive(bytes)
      return {
        canceled: false,
        fileName: basename(zipPath),
        ...imported
      }
    })
  }

  handle(CHANNELS.copyText, async (_window, args) => {
    const [text] = copyTextArgsSchema.parse(args)
    await clipboard.writeText(text)
  })

  handle(CHANNELS.copyImageDataUrl, async (_window, args) => {
    const [dataUrl] = copyImageDataUrlArgsSchema.parse(args)
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) {
      throw new Error('图片数据无效，无法复制到剪贴板。')
    }
    const pngBytes = new Uint8Array(image.toPNG())
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([pngBytes], { type: 'image/png' }) })])
  })
}
