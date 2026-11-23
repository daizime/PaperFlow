import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type PaperFlowAPI } from '../shared/contracts'
const api: PaperFlowAPI = {
  importPdf: () => ipcRenderer.invoke(CHANNELS.importPdf),
  importPdfBytes: input => ipcRenderer.invoke(CHANNELS.importPdfBytes, input),
  listDocuments: () => ipcRenderer.invoke(CHANNELS.listDocuments),
  readPdfBytes: id => ipcRenderer.invoke(CHANNELS.readPdfBytes, id),
  updatePageCount: (id, count) => ipcRenderer.invoke(CHANNELS.updatePageCount, id, count),
  renameDocument: (id, displayTitle) => ipcRenderer.invoke(CHANNELS.renameDocument, id, displayTitle),
  deleteDocument: id => ipcRenderer.invoke(CHANNELS.deleteDocument, id),
  getReaderState: id => ipcRenderer.invoke(CHANNELS.getReaderState, id),
  saveReaderState: state => ipcRenderer.invoke(CHANNELS.saveReaderState, state)
}
contextBridge.exposeInMainWorld('paperflow', Object.freeze(api))
