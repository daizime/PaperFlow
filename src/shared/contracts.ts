export interface DocumentRecord {
  id: string
  originalFilename: string
  displayTitle: string
  byteSize: number
  pageCount: number | null
  importedAt: string
}
export interface ImportResult { status: 'imported' | 'existing'; document: DocumentRecord }
export interface ReaderState { documentId: string; pageNumber: number; scale: number; updatedAt: string }
export interface PaperFlowAPI {
  importPdf(): Promise<ImportResult | null>
  listDocuments(): Promise<DocumentRecord[]>
  readPdfBytes(documentId: string): Promise<Uint8Array>
  updatePageCount(documentId: string, pageCount: number): Promise<void>
  getReaderState(documentId: string): Promise<ReaderState | null>
  saveReaderState(state: ReaderState): Promise<void>
}
export const CHANNELS = {
  importPdf: 'document:import', listDocuments: 'document:list', readPdfBytes: 'document:read',
  updatePageCount: 'document:page-count', getReaderState: 'reader:get', saveReaderState: 'reader:save'
} as const
