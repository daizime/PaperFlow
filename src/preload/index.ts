import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type PaperFlowAPI, type TranslationProgressEvent } from '../shared/contracts'
const api: PaperFlowAPI = {
  importPdf: () => ipcRenderer.invoke(CHANNELS.importPdf),
  importPdfBytes: input => ipcRenderer.invoke(CHANNELS.importPdfBytes, input),
  listDocuments: () => ipcRenderer.invoke(CHANNELS.listDocuments),
  readPdfBytes: id => ipcRenderer.invoke(CHANNELS.readPdfBytes, id),
  updatePageCount: (id, count) => ipcRenderer.invoke(CHANNELS.updatePageCount, id, count),
  renameDocument: (id, displayTitle) => ipcRenderer.invoke(CHANNELS.renameDocument, id, displayTitle),
  updateDocumentMeta: input => ipcRenderer.invoke(CHANNELS.updateDocumentMeta, input),
  deleteDocument: id => ipcRenderer.invoke(CHANNELS.deleteDocument, id),
  getReaderState: id => ipcRenderer.invoke(CHANNELS.getReaderState, id),
  saveReaderState: state => ipcRenderer.invoke(CHANNELS.saveReaderState, state),
  listReaderProgress: () => ipcRenderer.invoke(CHANNELS.listReaderProgress),
  searchLibrary: query => ipcRenderer.invoke(CHANNELS.searchLibrary, query),
  getTranslationSettings: () => ipcRenderer.invoke(CHANNELS.getTranslationSettings),
  saveTranslationSettings: input => ipcRenderer.invoke(CHANNELS.saveTranslationSettings, input),
  testTranslationConnection: () => ipcRenderer.invoke(CHANNELS.testTranslationConnection),
  getPageTranslations: (documentId, pageNumber) => ipcRenderer.invoke(CHANNELS.getPageTranslations, documentId, pageNumber),
  translatePage: input => ipcRenderer.invoke(CHANNELS.translatePage, input),
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
  listAnnotations: documentId => ipcRenderer.invoke(CHANNELS.listAnnotations, documentId),
  createAnnotation: input => ipcRenderer.invoke(CHANNELS.createAnnotation, input),
  updateAnnotation: input => ipcRenderer.invoke(CHANNELS.updateAnnotation, input),
  deleteAnnotation: annotationId => ipcRenderer.invoke(CHANNELS.deleteAnnotation, annotationId),
  exportAnnotationsMarkdown: documentId => ipcRenderer.invoke(CHANNELS.exportAnnotationsMarkdown, documentId),
  exportBackup: () => ipcRenderer.invoke(CHANNELS.exportBackup),
  importBackup: () => ipcRenderer.invoke(CHANNELS.importBackup),
  copyText: text => ipcRenderer.invoke(CHANNELS.copyText, text),
  copyImageDataUrl: dataUrl => ipcRenderer.invoke(CHANNELS.copyImageDataUrl, dataUrl)
}
contextBridge.exposeInMainWorld('paperflow', Object.freeze(api))
