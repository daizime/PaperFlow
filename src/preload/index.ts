import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type AiChatStreamEvent, type PaperFlowAPI, type TranslationProgressEvent } from '../shared/contracts'
const api: PaperFlowAPI = {
  importPdf: () => ipcRenderer.invoke(CHANNELS.importPdf),
  importPdfBytes: input => ipcRenderer.invoke(CHANNELS.importPdfBytes, input),
  listDocuments: () => ipcRenderer.invoke(CHANNELS.listDocuments),
  readPdfBytes: id => ipcRenderer.invoke(CHANNELS.readPdfBytes, id),
  updatePageCount: (id, count) => ipcRenderer.invoke(CHANNELS.updatePageCount, id, count),
  renameDocument: (id, displayTitle) => ipcRenderer.invoke(CHANNELS.renameDocument, id, displayTitle),
  updateDocumentMeta: input => ipcRenderer.invoke(CHANNELS.updateDocumentMeta, input),
  deleteDocument: id => ipcRenderer.invoke(CHANNELS.deleteDocument, id),
  resetLibrary: () => ipcRenderer.invoke(CHANNELS.resetLibrary),
  listFolders: () => ipcRenderer.invoke(CHANNELS.listFolders),
  createFolder: input => ipcRenderer.invoke(CHANNELS.createFolder, input),
  updateFolder: input => ipcRenderer.invoke(CHANNELS.updateFolder, input),
  deleteFolder: folderId => ipcRenderer.invoke(CHANNELS.deleteFolder, folderId),
  importFolder: input => ipcRenderer.invoke(CHANNELS.importFolder, ...(input ? [input] : [])),
  getReaderState: id => ipcRenderer.invoke(CHANNELS.getReaderState, id),
  saveReaderState: state => ipcRenderer.invoke(CHANNELS.saveReaderState, state),
  listReaderProgress: () => ipcRenderer.invoke(CHANNELS.listReaderProgress),
  searchLibrary: query => ipcRenderer.invoke(CHANNELS.searchLibrary, query),
  getTranslationSettings: () => ipcRenderer.invoke(CHANNELS.getTranslationSettings),
  saveTranslationSettings: input => ipcRenderer.invoke(CHANNELS.saveTranslationSettings, input),
  getDocumentTranslationScope: documentId => ipcRenderer.invoke(CHANNELS.getDocumentTranslationScope, documentId),
  detectLocalAiClients: () => ipcRenderer.invoke(CHANNELS.detectLocalAiClients),
  pickCliExecutable: () => ipcRenderer.invoke(CHANNELS.pickCliExecutable),
  testTranslationConnection: draft =>
    ipcRenderer.invoke(CHANNELS.testTranslationConnection, ...(draft ? [draft] : [])),
  getProviderBalance: draft =>
    ipcRenderer.invoke(CHANNELS.getProviderBalance, ...(draft ? [draft] : [])),
  getUsageSummary: () => ipcRenderer.invoke(CHANNELS.getUsageSummary),
  saveUsagePreferences: input => ipcRenderer.invoke(CHANNELS.saveUsagePreferences, input),
  resetUsageStats: scope =>
    ipcRenderer.invoke(CHANNELS.resetUsageStats, ...(scope ? [scope] : [])),
  getPageTranslations: (documentId, pageNumber) => ipcRenderer.invoke(CHANNELS.getPageTranslations, documentId, pageNumber),
  listDocumentTranslations: documentId => ipcRenderer.invoke(CHANNELS.listDocumentTranslations, documentId),
  translatePage: input => ipcRenderer.invoke(CHANNELS.translatePage, input),
  updateBlockTranslation: input => ipcRenderer.invoke(CHANNELS.updateBlockTranslation, input),
  exportTranslationDocument: input => ipcRenderer.invoke(CHANNELS.exportTranslationDocument, input),
  onTranslationProgress: listener => {
    const handler = (_event: unknown, payload: TranslationProgressEvent): void => {
      listener(payload)
    }
    ipcRenderer.on(CHANNELS.translationProgress, handler)
    return () => {
      ipcRenderer.removeListener(CHANNELS.translationProgress, handler)
    }
  },
  cancelTranslation: documentId => ipcRenderer.invoke(CHANNELS.cancelTranslation, documentId),
  clearDocumentTranslations: documentId => ipcRenderer.invoke(CHANNELS.clearDocumentTranslations, documentId),
  explainSelection: input => ipcRenderer.invoke(CHANNELS.explainSelection, input),
  listChatMessages: sessionKey => ipcRenderer.invoke(CHANNELS.listChatMessages, sessionKey),
  sendChatMessage: input => ipcRenderer.invoke(CHANNELS.sendChatMessage, input),
  runAiSkill: input => ipcRenderer.invoke(CHANNELS.runAiSkill, input),
  listCustomAiSkills: () => ipcRenderer.invoke(CHANNELS.listCustomAiSkills),
  saveCustomAiSkill: input => ipcRenderer.invoke(CHANNELS.saveCustomAiSkill, input),
  deleteCustomAiSkill: id => ipcRenderer.invoke(CHANNELS.deleteCustomAiSkill, id),
  onAiChatStream: listener => {
    const handler = (_event: unknown, payload: AiChatStreamEvent): void => {
      listener(payload)
    }
    ipcRenderer.on(CHANNELS.aiChatStream, handler)
    return () => {
      ipcRenderer.removeListener(CHANNELS.aiChatStream, handler)
    }
  },
  cancelAiChat: requestId => ipcRenderer.invoke(CHANNELS.cancelAiChat, ...(requestId ? [requestId] : [])),
  clearChatMessages: sessionKey => ipcRenderer.invoke(CHANNELS.clearChatMessages, sessionKey),
  exportSlideDeckPptx: deck => ipcRenderer.invoke(CHANNELS.exportSlideDeckPptx, deck),
  exportMarkdownContent: (suggestedName, markdown) =>
    ipcRenderer.invoke(CHANNELS.exportMarkdownContent, suggestedName, markdown),
  searchLiterature: input => ipcRenderer.invoke(CHANNELS.searchLiterature, input),
  importLiteraturePdf: input => ipcRenderer.invoke(CHANNELS.importLiteraturePdf, input),
  summarizeLiteratureAbstract: input => ipcRenderer.invoke(CHANNELS.summarizeLiteratureAbstract, input),
  enrichCitationMetadata: input => ipcRenderer.invoke(CHANNELS.enrichCitationMetadata, input),
  exportFolderBibtex: input => ipcRenderer.invoke(CHANNELS.exportFolderBibtex, input),
  openExternalUrl: url => ipcRenderer.invoke(CHANNELS.openExternalUrl, url),
  listAnnotations: documentId => ipcRenderer.invoke(CHANNELS.listAnnotations, documentId),
  createAnnotation: input => ipcRenderer.invoke(CHANNELS.createAnnotation, input),
  updateAnnotation: input => ipcRenderer.invoke(CHANNELS.updateAnnotation, input),
  deleteAnnotation: annotationId => ipcRenderer.invoke(CHANNELS.deleteAnnotation, annotationId),
  exportAnnotationsMarkdown: documentId => ipcRenderer.invoke(CHANNELS.exportAnnotationsMarkdown, documentId),
  exportBackup: () => ipcRenderer.invoke(CHANNELS.exportBackup),
  importBackup: () => ipcRenderer.invoke(CHANNELS.importBackup),
  exportFolderPdfs: input => ipcRenderer.invoke(CHANNELS.exportFolderPdfs, input),
  copyText: text => ipcRenderer.invoke(CHANNELS.copyText, text),
  copyImageDataUrl: dataUrl => ipcRenderer.invoke(CHANNELS.copyImageDataUrl, dataUrl),
  getResearchProfile: () => ipcRenderer.invoke(CHANNELS.getResearchProfile),
  saveResearchProfile: input => ipcRenderer.invoke(CHANNELS.saveResearchProfile, input),
  setWindowTheme: theme => ipcRenderer.invoke(CHANNELS.setWindowTheme, theme)
}
contextBridge.exposeInMainWorld('paperflow', Object.freeze(api))
