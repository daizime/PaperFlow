import { BrowserWindow, ClipboardItem, clipboard, dialog, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { ZodError } from 'zod'
import { CHANNELS, type ImportPdfBatchFailure, type ImportResult } from '../../shared/contracts'
import {
  cancelAiChatArgsSchema,
  cancelTranslationArgsSchema,
  clearChatMessagesArgsSchema,
  copyImageDataUrlArgsSchema,
  copyTextArgsSchema,
  createAnnotationArgsSchema,
  createFolderArgsSchema,
  deleteAnnotationArgsSchema,
  deleteCustomAiSkillArgsSchema,
  deleteFolderArgsSchema,
  documentIdArgsSchema,
  enrichCitationArgsSchema,
  explainSelectionArgsSchema,
  exportAnnotationsArgsSchema,
  exportFolderBibtexArgsSchema,
  exportFolderPdfsArgsSchema,
  exportMarkdownContentArgsSchema,
  exportSlideDeckPptxArgsSchema,
  exportTranslationDocumentArgsSchema,
  getDocumentTranslationScopeArgsSchema,
  getPageTranslationsArgsSchema,
  getProviderBalanceArgsSchema,
  importFolderArgsSchema,
  importLiteraturePdfArgsSchema,
  importPdfBytesArgsSchema,
  isSafeCliToken,
  listAnnotationsArgsSchema,
  listChatMessagesArgsSchema,
  listDocumentTranslationsArgsSchema,
  listReaderProgressArgsSchema,
  noArgsSchema,
  openExternalUrlArgsSchema,
  pageCountArgsSchema,
  readerStateArgsSchema,
  renameDocumentArgsSchema,
  resetUsageStatsArgsSchema,
  runAiSkillArgsSchema,
  saveCustomAiSkillArgsSchema,
  saveResearchProfileArgsSchema,
  saveTranslationSettingsArgsSchema,
  saveUsagePreferencesArgsSchema,
  searchLibraryArgsSchema,
  searchLiteratureArgsSchema,
  sendAiChatArgsSchema,
  setWindowThemeArgsSchema,
  summarizeLiteratureAbstractArgsSchema,
  testTranslationConnectionArgsSchema,
  translatePageArgsSchema,
  updateAnnotationArgsSchema,
  updateBlockTranslationArgsSchema,
  updateDocumentMetaArgsSchema,
  updateFolderArgsSchema
} from '../../shared/schemas'
import { formatAnnotationsMarkdown } from '../services/annotation-export'
import { APP_URL, developmentUrl } from '../services/app-protocol'
import type { BackupService } from '../services/backup-service'
import type { LibraryDatabase } from '../services/database'
import type { DocumentService } from '../services/document-service'
import { validateExternalBrowserUrl } from '../services/literature-http'
import type { LiteratureSearchService } from '../services/literature-search-service'
import { buildAcademicPptxBuffer } from '../services/pptx-builder'
import { readResearchProfile, saveResearchProfile } from '../services/research-profile'
import { deleteCustomAiSkill, listCustomAiSkills, saveCustomAiSkill } from '../services/custom-skills'
import {
  buildTranslationExportHtml,
  formatTranslationExportMarkdown,
  renderTranslationHtmlToPdfBuffer
} from '../services/translation-export'
import type { TranslationService } from '../services/translation-service'
import { ZIP_ARCHIVE_LIMITS } from '../services/zip-archive'
import { WINDOW_THEME_SETTING_KEY, applyWindowThemeChrome } from '../window'

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  database: LibraryDatabase,
  documents: DocumentService,
  translations?: TranslationService,
  backups?: BackupService,
  literatureSearch?: LiteratureSearchService
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
    const selection = await dialog.showOpenDialog(window, {
      title: '导入 PDF 文献（支持多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF 文献', extensions: ['pdf'] }]
    })
    if (selection.canceled || selection.filePaths.length === 0) {
      return { canceled: true, results: [], failures: [] }
    }
    const results: ImportResult[] = []
    const failures: ImportPdfBatchFailure[] = []
    for (const filePath of selection.filePaths) {
      try {
        results.push(await documents.importFile(filePath))
      } catch (error: unknown) {
        failures.push({
          filename: basename(filePath) || filePath,
          reason: error instanceof Error ? error.message : '导入失败，请重试。'
        })
      }
    }
    return { canceled: false, results, failures }
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
  handle(CHANNELS.resetLibrary, (_window, args) => {
    noArgsSchema.parse(args)
    translations?.cancel()
    return documents.resetLibrary()
  })
  handle(CHANNELS.listFolders, (_window, args) => {
    noArgsSchema.parse(args)
    return database.listFolders()
  })
  handle(CHANNELS.createFolder, (_window, args) => {
    const [input] = createFolderArgsSchema.parse(args)
    return database.createFolder(input)
  })
  handle(CHANNELS.updateFolder, (_window, args) => {
    const [input] = updateFolderArgsSchema.parse(args)
    return database.updateFolder(input)
  })
  handle(CHANNELS.deleteFolder, (_window, args) => {
    const [folderId] = deleteFolderArgsSchema.parse(args)
    database.deleteFolder(folderId)
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
    handle(CHANNELS.saveTranslationSettings, async (_window, args) => {
      const [input] = saveTranslationSettingsArgsSchema.parse(args)
      if (input.provider === 'cli' && !(await translations.authorizeCliSettings(input)).authorized) {
        throw new Error('已取消本机 AI 程序授权。')
      }
      return translations.saveSettings(input)
    })
    handle(CHANNELS.getDocumentTranslationScope, (_window, args) => {
      const [documentId] = getDocumentTranslationScopeArgsSchema.parse(args)
      return translations.getDocumentTranslationScope(documentId)
    })
    handle(CHANNELS.detectLocalAiClients, async (_window, args) => {
      noArgsSchema.parse(args)
      return translations.detectLocalAiClients()
    })
    handle(CHANNELS.pickCliExecutable, async (window, args) => {
      noArgsSchema.parse(args)
      const selection = await dialog.showOpenDialog(window, {
        title: '选择本机 AI 客户端可执行文件',
        properties: ['openFile'],
        ...(process.platform === 'win32'
          ? {
              filters: [
                { name: '可执行程序 / 命令脚本', extensions: ['exe', 'cmd', 'bat', 'com'] },
                { name: '所有文件', extensions: ['*'] }
              ]
            }
          : {})
      })
      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true, filePath: null }
      }
      const filePath = selection.filePaths[0]
      if (!filePath || filePath.length > 512 || !isSafeCliToken(filePath)) {
        throw new Error('所选路径包含不支持的特殊字符或过长（超过 512 个字符）。')
      }
      return { canceled: false, filePath }
    })
    handle(CHANNELS.testTranslationConnection, async (_window, args) => {
      const [draft] = testTranslationConnectionArgsSchema.parse(args)
      if (draft?.provider === 'cli' && !(await translations.authorizeCliSettings(draft)).authorized) {
        throw new Error('已取消本机 AI 程序授权。')
      }
      return translations.testConnection(draft)
    })
    handle(CHANNELS.getProviderBalance, async (_window, args) => {
      const [draft] = getProviderBalanceArgsSchema.parse(args)
      return translations.getProviderBalance(draft)
    })
    handle(CHANNELS.getUsageSummary, (_window, args) => {
      noArgsSchema.parse(args)
      return translations.getUsageSummary()
    })
    handle(CHANNELS.saveUsagePreferences, (_window, args) => {
      const [input] = saveUsagePreferencesArgsSchema.parse(args)
      return translations.saveUsagePreferences(input)
    })
    handle(CHANNELS.resetUsageStats, (_window, args) => {
      const [scope] = resetUsageStatsArgsSchema.parse(args)
      return translations.resetUsageStats(scope)
    })
    handle(CHANNELS.getPageTranslations, (_window, args) => {
      const [documentId, pageNumber] = getPageTranslationsArgsSchema.parse(args)
      return translations.getPageTranslations(documentId, pageNumber)
    })
    handle(CHANNELS.listDocumentTranslations, (_window, args) => {
      const [documentId] = listDocumentTranslationsArgsSchema.parse(args)
      return translations.listDocumentTranslations(documentId)
    })
    handle(CHANNELS.updateBlockTranslation, (_window, args) => {
      const [input] = updateBlockTranslationArgsSchema.parse(args)
      return translations.updateBlockTranslation(input)
    })
    handle(CHANNELS.exportTranslationDocument, async (window, args) => {
      const [input] = exportTranslationDocumentArgsSchema.parse(args)
      const doc = database.getDocument(input.documentId)
      if (!doc) throw new Error('文献不存在，请重新选择文献。')
      const blockCount = input.pages.reduce((sum, page) => sum + page.blocks.length, 0)
      const isPdf = input.format === 'zh-pdf' || input.format === 'bilingual-pdf'
      const safeStem =
        (input.title || doc.displayTitle || 'Foliopair-translation')
          .replace(/[\\/:*?"<>|]/g, '_')
          .replace(/\.(md|pdf)$/i, '')
          .slice(0, 80) || 'Foliopair-translation'
      const suffix =
        input.format === 'bilingual-md'
          ? '-中英对照'
          : input.format === 'zh-md'
            ? '-中文译文'
            : input.format === 'bilingual-pdf'
              ? '-中英对照排版'
              : '-中文译文排版'
      const ext = isPdf ? 'pdf' : 'md'
      const result = await dialog.showSaveDialog(window, {
        title: isPdf ? '导出译文排版 PDF' : '导出译文 Markdown',
        defaultPath: `${safeStem}${suffix}.${ext}`,
        filters: [
          isPdf
            ? { name: 'PDF 文档', extensions: ['pdf'] }
            : { name: 'Markdown 文档', extensions: ['md'] }
        ]
      })
      if (result.canceled || !result.filePath) {
        return { canceled: true, pageCount: input.pages.length, blockCount }
      }
      if (isPdf) {
        const html = buildTranslationExportHtml(
          input.title,
          input.format === 'bilingual-pdf' ? 'bilingual' : 'zh-only',
          input.pages
        )
        const pdfBuffer = await renderTranslationHtmlToPdfBuffer(html)
        await writeFile(result.filePath, pdfBuffer)
      } else {
        const md = formatTranslationExportMarkdown(
          input.title,
          input.format as 'bilingual-md' | 'zh-md',
          input.pages
        )
        await writeFile(result.filePath, md, 'utf8')
      }
      return {
        canceled: false,
        fileName: basename(result.filePath),
        pageCount: input.pages.length,
        blockCount
      }
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
    handle(CHANNELS.sendChatMessage, async (_window, args) => {
      const [input] = sendAiChatArgsSchema.parse(args)
      return translations.chat(input, (delta, fullText) => {
        if (!input.requestId) return
        const currentWindow = getWindow()
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.webContents.send(CHANNELS.aiChatStream, {
            requestId: input.requestId,
            sessionKey: input.sessionKey,
            delta,
            fullText
          })
        }
      })
    })
    handle(CHANNELS.runAiSkill, async (_window, args) => {
      const [input] = runAiSkillArgsSchema.parse(args)
      return translations.runAcademicSkill(input, (delta, fullText) => {
        if (!input.requestId) return
        const currentWindow = getWindow()
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.webContents.send(CHANNELS.aiChatStream, {
            requestId: input.requestId,
            sessionKey: input.sessionKey,
            delta,
            fullText
          })
        }
      })
    })
    handle(CHANNELS.cancelAiChat, (_window, args) => {
      const parsed = cancelAiChatArgsSchema.parse(args)
      translations.cancelAiTask(parsed[0])
    })
  }

  handle(CHANNELS.exportSlideDeckPptx, async (window, args) => {
    const [deck] = exportSlideDeckPptxArgsSchema.parse(args)
    const safeStem = deck.deckTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'Foliopair-slides'
    const result = await dialog.showSaveDialog(window, {
      title: '导出学术汇报 PPTX',
      defaultPath: `${safeStem}.pptx`,
      filters: [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }]
    })
    if (result.canceled || !result.filePath) {
      return { canceled: true, slideCount: deck.slides.length }
    }
    const pptxBuffer = buildAcademicPptxBuffer(deck)
    await writeFile(result.filePath, pptxBuffer)
    return { canceled: false, fileName: basename(result.filePath), slideCount: deck.slides.length }
  })

  handle(CHANNELS.exportMarkdownContent, async (window, args) => {
    const [suggestedName, markdown] = exportMarkdownContentArgsSchema.parse(args)
    const safeStem = suggestedName.replace(/[\\/:*?"<>|]/g, '_').replace(/\.md$/i, '').slice(0, 80) || 'Foliopair-summary'
    const result = await dialog.showSaveDialog(window, {
      title: '导出精读总结 Markdown',
      defaultPath: `${safeStem}.md`,
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }
    await writeFile(result.filePath, markdown, 'utf8')
    return { canceled: false, fileName: basename(result.filePath) }
  })

  if (literatureSearch) {
    handle(CHANNELS.searchLiterature, async (_window, args) => {
      const [input] = searchLiteratureArgsSchema.parse(args)
      return literatureSearch.search(input)
    })
    handle(CHANNELS.importLiteraturePdf, async (_window, args) => {
      const [input] = importLiteraturePdfArgsSchema.parse(args)
      return literatureSearch.importPaperPdf(input)
    })
    handle(CHANNELS.summarizeLiteratureAbstract, async (_window, args) => {
      const [input] = summarizeLiteratureAbstractArgsSchema.parse(args)
      return literatureSearch.summarizeAbstract(input)
    })
    handle(CHANNELS.enrichCitationMetadata, async (_window, args) => {
      const [input] = enrichCitationArgsSchema.parse(args)
      return literatureSearch.enrichCitation(input)
    })
  }

  handle(CHANNELS.openExternalUrl, async (_window, args) => {
    const [rawUrl] = openExternalUrlArgsSchema.parse(args)
    const validated = await validateExternalBrowserUrl(rawUrl)
    await shell.openExternal(validated.toString())
  })

  handle(CHANNELS.listChatMessages, (_window, args) => {
    const [sessionKey] = listChatMessagesArgsSchema.parse(args)
    return database.listChatMessages(sessionKey)
  })
  handle(CHANNELS.clearChatMessages, (_window, args) => {
    const [sessionKey] = clearChatMessagesArgsSchema.parse(args)
    database.clearChatMessages(sessionKey)
  })
  handle(CHANNELS.listCustomAiSkills, (_window, args) => {
    noArgsSchema.parse(args)
    return listCustomAiSkills(database)
  })
  handle(CHANNELS.saveCustomAiSkill, (_window, args) => {
    const [input] = saveCustomAiSkillArgsSchema.parse(args)
    return saveCustomAiSkill(database, input)
  })
  handle(CHANNELS.deleteCustomAiSkill, (_window, args) => {
    const [id] = deleteCustomAiSkillArgsSchema.parse(args)
    return deleteCustomAiSkill(database, id)
  })

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
    const safeStem = (document.displayTitle || 'Foliopair-notes').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
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
        defaultPath: `Foliopair-Backup-${dateTag}.zip`,
        filters: [{ name: 'Foliopair 备份压缩包', extensions: ['zip'] }]
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
        title: '选择 Foliopair 备份压缩包',
        properties: ['openFile'],
        filters: [{ name: 'Foliopair 备份压缩包', extensions: ['zip'] }]
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
      if (!info.isFile() || info.size === 0 || info.size > ZIP_ARCHIVE_LIMITS.maxArchiveBytes) {
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

    handle(CHANNELS.exportFolderPdfs, async (window, args) => {
      const [input] = exportFolderPdfsArgsSchema.parse(args)
      if (input.scope === 'folder' && !database.getFolder(input.folderId!)) {
        throw new Error('要导出的分类文件夹不存在。')
      }
      const selection = await dialog.showOpenDialog(window, {
        title: '选择导出分类 PDF 的目标目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (selection.canceled || !selection.filePaths[0]) {
        return {
          canceled: true,
          exportedCount: 0,
          folderCount: 0,
          exportedNotesCount: 0
        }
      }
      const exported = await backups.exportFoldersToDirectory(selection.filePaths[0], input)
      return {
        canceled: false,
        ...exported
      }
    })

    handle(CHANNELS.importFolder, async (window, args) => {
      const [input] = importFolderArgsSchema.parse(args)
      const parentFolderId = input?.parentFolderId ?? null
      if (parentFolderId && !database.getFolder(parentFolderId)) {
        throw new Error('目标父分类文件夹不存在。')
      }
      const selection = await dialog.showOpenDialog(window, {
        title: '选择要导入的本地文献文件夹',
        properties: ['openDirectory']
      })
      if (selection.canceled || !selection.filePaths[0]) {
        return {
          canceled: true,
          importedCount: 0,
          duplicateCount: 0,
          skippedCount: 0,
          createdFolderCount: 0,
          assignedCount: 0,
          folderIds: [],
          documentIds: []
        }
      }
      const imported = await backups.importFolderFromDirectory(selection.filePaths[0], parentFolderId)
      return {
        canceled: false,
        ...imported
      }
    })

    handle(CHANNELS.exportFolderBibtex, async (window, args) => {
      const [input] = exportFolderBibtexArgsSchema.parse(args)
      const built = backups.buildFolderBibtex(input)
      if (built.count === 0) {
        return { canceled: true, count: 0 }
      }
      const selection = await dialog.showSaveDialog(window, {
        title: '批量导出 BibTeX (.bib)',
        defaultPath: built.defaultFilename,
        filters: [{ name: 'BibTeX 参考文献文件', extensions: ['bib'] }]
      })
      if (selection.canceled || !selection.filePath) {
        return { canceled: true, count: built.count }
      }
      await writeFile(selection.filePath, built.bibtex, 'utf8')
      return {
        canceled: false,
        fileName: basename(selection.filePath),
        count: built.count
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

  handle(CHANNELS.getResearchProfile, (_window, args) => {
    noArgsSchema.parse(args)
    return readResearchProfile(database)
  })

  handle(CHANNELS.saveResearchProfile, (_window, args) => {
    const [input] = saveResearchProfileArgsSchema.parse(args)
    return saveResearchProfile(database, input)
  })

  handle(CHANNELS.setWindowTheme, (window, args) => {
    const [theme] = setWindowThemeArgsSchema.parse(args)
    database.setSetting(WINDOW_THEME_SETTING_KEY, theme)
    applyWindowThemeChrome(window, theme)
  })
}
