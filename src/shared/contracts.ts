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
export interface ImportPdfBytesInput {
  originalFilename: string
  bytes: Uint8Array
}
export interface PaperFlowAPI {
  importPdf(): Promise<ImportResult | null>
  importPdfBytes(input: ImportPdfBytesInput): Promise<ImportResult>
  listDocuments(): Promise<DocumentRecord[]>
  readPdfBytes(documentId: string): Promise<Uint8Array>
  updatePageCount(documentId: string, pageCount: number): Promise<void>
  renameDocument(documentId: string, displayTitle: string): Promise<DocumentRecord>
  deleteDocument(documentId: string): Promise<void>
  getReaderState(documentId: string): Promise<ReaderState | null>
  saveReaderState(state: ReaderState): Promise<void>
}
export const MAX_PDF_BYTES = 100 * 1024 * 1024

/** 检查文本是否包含 ASCII 控制字符（0x00-0x1F 或 0x7F）。 */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** 格式化文件大小用于错误提示，接近 100 MiB 上限时保留精确字节差。 */
export function formatPdfByteSize(bytes: number): string {
  if (bytes > MAX_PDF_BYTES && bytes < MAX_PDF_BYTES + 1024 * 100) {
    return `100 MiB + ${bytes - MAX_PDF_BYTES} B`
  }
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

export const CHANNELS = {
  importPdf: 'document:import', importPdfBytes: 'document:import-bytes', listDocuments: 'document:list',
  readPdfBytes: 'document:read', updatePageCount: 'document:page-count',
  renameDocument: 'document:rename', deleteDocument: 'document:delete',
  getReaderState: 'reader:get', saveReaderState: 'reader:save'
} as const
