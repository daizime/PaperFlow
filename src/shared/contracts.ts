export interface DocumentRecord {
  id: string
  originalFilename: string
  displayTitle: string
  byteSize: number
  pageCount: number | null
  importedAt: string
  starred: boolean
  tags: string[]
}
export interface UpdateDocumentMetaInput {
  documentId: string
  starred?: boolean
  tags?: string[]
}
export type LibrarySearchHitSource = 'document' | 'annotation' | 'translation'
export interface LibrarySearchHit {
  documentId: string
  displayTitle: string
  originalFilename: string
  source: LibrarySearchHitSource
  pageNumber: number | null
  snippet: string
}
export interface ImportResult { status: 'imported' | 'existing'; document: DocumentRecord }
export interface ReaderState { documentId: string; pageNumber: number; scale: number; updatedAt: string }
export interface ImportPdfBytesInput {
  originalFilename: string
  bytes: Uint8Array
}

export type TranslationProviderType = 'openai-compatible' | 'cli'
export type CliPreset = 'codex' | 'claude' | 'gemini' | 'custom'
export type TranslatableBlockKind = 'heading' | 'paragraph' | 'caption' | 'list-item'

export interface GlossaryEntry {
  source: string
  target: string
}

export interface TranslationSettings {
  provider: TranslationProviderType
  targetLanguage: string
  glossary: GlossaryEntry[]
  openai: {
    baseUrl: string
    model: string
    hasApiKey: boolean
    apiKeyPreview: string | null
  }
  cli: {
    preset: CliPreset
    command: string
    model: string
    extraArgs: string[]
    timeoutSec: number
  }
}

export interface SaveTranslationSettingsInput {
  provider: TranslationProviderType
  targetLanguage: string
  glossary?: GlossaryEntry[]
  openai: {
    baseUrl: string
    model: string
    /** 传 undefined 保留现有密钥；传空字符串清除；传非空字符串覆盖加密存储。 */
    apiKey?: string
  }
  cli: {
    preset: CliPreset
    command: string
    model: string
    extraArgs: string[]
    timeoutSec: number
  }
}

export interface TranslationBlockInput {
  blockId: string
  kind: TranslatableBlockKind
  sourceText: string
  sourceHash: string
}

export interface TranslatePageInput {
  documentId: string
  pageNumber: number
  blocks: TranslationBlockInput[]
  force?: boolean
}

export interface TranslatedBlockRecord {
  blockId: string
  sourceHash: string
  translatedText: string
  providerSignature: string
  updatedAt: string
}

export interface TranslatePageResult {
  documentId: string
  pageNumber: number
  items: TranslatedBlockRecord[]
  fromCacheCount: number
  translatedCount: number
}

export interface TranslationProgressEvent {
  documentId: string
  pageNumber: number
  items: TranslatedBlockRecord[]
  completedCount: number
  totalCount: number
}

export type ExplainMode = 'explain' | 'formula' | 'translate'

export interface ExplainSelectionInput {
  documentId: string
  pageNumber: number
  selectedText: string
  contextText?: string
  mode: ExplainMode
}

export interface ExplainSelectionResult {
  mode: ExplainMode
  answer: string
  latencyMs: number
}

export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'pink'

export interface AnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AnnotationRecord {
  id: string
  documentId: string
  pageNumber: number
  color: AnnotationColor
  quoteText: string
  note: string
  rects: AnnotationRect[]
  sentenceIds: string[]
  createdAt: string
  updatedAt: string
}

export interface CreateAnnotationInput {
  documentId: string
  pageNumber: number
  color: AnnotationColor
  quoteText: string
  note?: string
  rects: AnnotationRect[]
  sentenceIds?: string[]
}

export interface UpdateAnnotationInput {
  id: string
  color?: AnnotationColor
  note?: string
}

export interface ExportAnnotationsResult {
  canceled: boolean
  markdown: string
  count: number
  fileName?: string
}

export interface ExportBackupResult {
  canceled: boolean
  fileName?: string
  documentCount: number
  annotationCount: number
  translationCount: number
  glossaryCount: number
}

export interface ImportBackupResult {
  canceled: boolean
  fileName?: string
  importedDocuments: number
  existingDocuments: number
  restoredAnnotations: number
  restoredTranslations: number
  restoredGlossary: number
}

export interface TranslationTestResult {
  ok: boolean
  latencyMs: number
  sampleOutput?: string
  error?: string
  resolvedCommand?: string
}

export interface PaperFlowAPI {
  importPdf(): Promise<ImportResult | null>
  importPdfBytes(input: ImportPdfBytesInput): Promise<ImportResult>
  listDocuments(): Promise<DocumentRecord[]>
  readPdfBytes(documentId: string): Promise<Uint8Array>
  updatePageCount(documentId: string, pageCount: number): Promise<void>
  renameDocument(documentId: string, displayTitle: string): Promise<DocumentRecord>
  updateDocumentMeta(input: UpdateDocumentMetaInput): Promise<DocumentRecord>
  deleteDocument(documentId: string): Promise<void>
  getReaderState(documentId: string): Promise<ReaderState | null>
  saveReaderState(state: ReaderState): Promise<void>
  listReaderProgress(): Promise<Record<string, number>>
  searchLibrary(query: string): Promise<LibrarySearchHit[]>
  getTranslationSettings(): Promise<TranslationSettings>
  saveTranslationSettings(input: SaveTranslationSettingsInput): Promise<TranslationSettings>
  testTranslationConnection(): Promise<TranslationTestResult>
  getPageTranslations(documentId: string, pageNumber: number): Promise<TranslatedBlockRecord[]>
  translatePage(input: TranslatePageInput): Promise<TranslatePageResult>
  onTranslationProgress(listener: (event: TranslationProgressEvent) => void): () => void
  cancelTranslation(documentId?: string): Promise<void>
  clearDocumentTranslations(documentId: string): Promise<void>
  explainSelection(input: ExplainSelectionInput): Promise<ExplainSelectionResult>
  listAnnotations(documentId: string): Promise<AnnotationRecord[]>
  createAnnotation(input: CreateAnnotationInput): Promise<AnnotationRecord>
  updateAnnotation(input: UpdateAnnotationInput): Promise<AnnotationRecord>
  deleteAnnotation(annotationId: string): Promise<void>
  exportAnnotationsMarkdown(documentId: string): Promise<ExportAnnotationsResult>
  exportBackup(): Promise<ExportBackupResult>
  importBackup(): Promise<ImportBackupResult>
  copyText(text: string): Promise<void>
  copyImageDataUrl(dataUrl: string): Promise<void>
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
  renameDocument: 'document:rename', updateDocumentMeta: 'document:update-meta', deleteDocument: 'document:delete',
  getReaderState: 'reader:get', saveReaderState: 'reader:save', listReaderProgress: 'reader:list-progress',
  searchLibrary: 'library:search',
  getTranslationSettings: 'translation:get-settings',
  saveTranslationSettings: 'translation:save-settings',
  testTranslationConnection: 'translation:test',
  getPageTranslations: 'translation:get-page',
  translatePage: 'translation:translate-page',
  translationProgress: 'translation:progress',
  cancelTranslation: 'translation:cancel',
  clearDocumentTranslations: 'translation:clear-document',
  explainSelection: 'translation:explain',
  listAnnotations: 'annotation:list',
  createAnnotation: 'annotation:create',
  updateAnnotation: 'annotation:update',
  deleteAnnotation: 'annotation:delete',
  exportAnnotationsMarkdown: 'annotation:export-md',
  exportBackup: 'backup:export',
  importBackup: 'backup:import',
  copyText: 'clipboard:write-text',
  copyImageDataUrl: 'clipboard:write-image'
} as const
