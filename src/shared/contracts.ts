export type ReadingStatus = 'unread' | 'reading' | 'done'

export interface DocumentRecord {
  id: string
  originalFilename: string
  displayTitle: string
  byteSize: number
  pageCount: number | null
  importedAt: string
  starred: boolean
  tags: string[]
  folderId: string | null
  readingStatus: ReadingStatus
}
export interface UpdateDocumentMetaInput {
  documentId: string
  starred?: boolean
  tags?: string[]
  folderId?: string | null
  readingStatus?: ReadingStatus
}
export interface LibraryFolder {
  id: string
  parentId: string | null
  name: string
  facultyId: string
  contextSummary: string
  glossary: GlossaryEntry[]
  inheritGlobalGlossary: boolean
  createdAt: string
  updatedAt: string
}
export interface CreateFolderInput {
  parentId?: string | null
  name: string
  facultyId?: string
  contextSummary?: string
  glossary?: GlossaryEntry[]
  inheritGlobalGlossary?: boolean
}
export interface UpdateFolderInput {
  id: string
  parentId?: string | null
  name?: string
  facultyId?: string
  contextSummary?: string
  glossary?: GlossaryEntry[]
  inheritGlobalGlossary?: boolean
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
export interface ImportPdfBatchFailure {
  filename: string
  reason: string
}
export interface ImportPdfBatchResult {
  canceled: boolean
  results: ImportResult[]
  failures: ImportPdfBatchFailure[]
}
export interface ReaderState { documentId: string; pageNumber: number; scale: number; updatedAt: string }
export interface ImportPdfBytesInput {
  originalFilename: string
  bytes: Uint8Array
}

export type TranslationProviderType = 'openai-compatible' | 'cli'
export type CliPreset = 'codex' | 'gemini' | 'custom'
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

export interface UpdateBlockTranslationInput {
  documentId: string
  pageNumber: number
  blockId: string
  sourceHash: string
  translatedText: string
}

export interface DocumentPageTranslations {
  pageNumber: number
  items: TranslatedBlockRecord[]
}

export type TranslationExportFormat = 'bilingual-md' | 'zh-md' | 'zh-pdf' | 'bilingual-pdf'

export interface ExportTranslationPageBlock {
  kind: TranslatableBlockKind
  sourceText: string
  translatedText: string | null
}

export interface ExportTranslationPage {
  pageNumber: number
  blocks: ExportTranslationPageBlock[]
}

export interface ExportTranslationDocumentInput {
  documentId: string
  title: string
  format: TranslationExportFormat
  pages: ExportTranslationPage[]
}

export interface ExportTranslationDocumentResult {
  canceled: boolean
  fileName?: string
  pageCount: number
  blockCount: number
}

export interface TranslatePageResult {
  documentId: string
  pageNumber: number
  items: TranslatedBlockRecord[]
  fromCacheCount: number
  translatedCount: number
  usage?: TokenUsageDelta
  latencyMs?: number
  billingKind?: ProviderBillingKind
  providerLabel?: string
  balance?: ProviderBalanceSnapshot | null
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

export interface TokenUsageDelta {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type ProviderBillingKind = 'deepseek-balance' | 'openai-generic' | 'ollama-local' | 'cli-local'

export interface ProviderBalanceSnapshot {
  supported: boolean
  billingKind: ProviderBillingKind
  provider: TranslationProviderType
  modelLabel: string
  available: boolean | null
  currency: string | null
  totalBalance: number | null
  grantedBalance: number | null
  toppedUpBalance: number | null
  fetchedAt: string
  note: string
  error?: string
}

export interface UsagePreferences {
  lowBalanceThreshold: number
  priceCurrency: 'CNY' | 'USD'
  inputPricePer1M: number | null
  outputPricePer1M: number | null
}

export interface UsageBucketStats {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  apiRequests: number
  translatedBlocks: number
  translatedPages: number
  cacheHitBlocks: number
}

export interface UsageStatsSummary {
  todayDate: string
  today: UsageBucketStats
  total: UsageBucketStats
  preferences: UsagePreferences
  updatedAt: string
}

export interface ExplainSelectionResult {
  mode: ExplainMode
  answer: string
  latencyMs: number
  usage?: TokenUsageDelta
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

export interface ResetLibraryResult {
  deletedDocuments: number
  deletedFolders: number
}

export interface ExportFolderPdfsInput {
  scope: 'all' | 'unassigned' | 'folder'
  folderId?: string
  includeAnnotations?: boolean
}

export interface ExportFolderPdfsResult {
  canceled: boolean
  targetDir?: string
  exportedCount: number
  folderCount: number
  exportedNotesCount: number
}

export interface ImportFolderInput {
  parentFolderId?: string | null
}

export interface ImportFolderResult {
  canceled: boolean
  sourceDir?: string
  importedCount: number
  duplicateCount: number
  skippedCount: number
  createdFolderCount: number
  assignedCount: number
  folderIds: string[]
  documentIds: string[]
}

export interface DocumentTranslationScope {
  documentId: string
  folderId: string | null
  folderName: string | null
  inheritGlobalGlossary: boolean
  effectiveGlossaryCount: number
  folderGlossaryCount: number
  globalGlossaryCount: number
  scopeFingerprint: string
  effectiveGlossary: GlossaryEntry[]
}

export type ResearchStage = 'undergrad-prep' | 'master-1' | 'master-senior' | 'phd' | 'other'
export type ResearchOnboardingMode = 'direct' | 'guided' | 'skipped'
export type ResearchParadigm = 'exp' | 'theory' | 'comp' | 'design'
export type ResearchReadingGoal = 'survey' | 'reproduce' | 'writing'

export interface ResearchProfile {
  completed: boolean
  mode: ResearchOnboardingMode
  stage: ResearchStage
  facultyId: string
  selectedTrackIds: string[]
  customTopic: string
  paradigm: ResearchParadigm
  readingGoal: ResearchReadingGoal
  recommendedTags: string[]
  updatedAt: string
}

export interface SaveResearchProfileInput {
  completed: boolean
  mode: ResearchOnboardingMode
  stage: ResearchStage
  facultyId: string
  selectedTrackIds: string[]
  customTopic: string
  paradigm: ResearchParadigm
  readingGoal: ResearchReadingGoal
  recommendedTags: string[]
  applyStarterGlossary?: boolean
}

export interface TranslationTestResult {
  ok: boolean
  latencyMs: number
  testedProvider: TranslationProviderType
  testedLabel: string
  testedTarget: string
  sampleOutput?: string
  error?: string
  resolvedCommand?: string
  usage?: TokenUsageDelta
}

export type LocalAiClientStatus = 'ready' | 'gui-only' | 'not-found'

export interface DetectedLocalAiClient {
  preset: Exclude<CliPreset, 'custom'>
  name: string
  status: LocalAiClientStatus
  command: string | null
  source: string | null
  version: string | null
  hint: string
}

export interface PickCliExecutableResult {
  canceled: boolean
  filePath: string | null
}

export type AiChatRole = 'user' | 'assistant'
export type AiChatScope = 'active' | 'all-open' | 'free'

export interface AiChatMessageRecord {
  id: string
  sessionKey: string
  role: AiChatRole
  content: string
  quoteText: string
  contextSummary: string
  createdAt: string
}

export interface AiChatContextDocument {
  documentId: string
  title: string
  paneLabel?: string
  pageNumber?: number
  excerpt?: string
}

export interface SendAiChatInput {
  requestId?: string
  sessionKey: string
  question: string
  scope: AiChatScope
  quoteText?: string
  contexts: AiChatContextDocument[]
}

export interface AiChatStreamEvent {
  requestId: string
  sessionKey: string
  delta: string
  fullText: string
}

export interface SendAiChatResult {
  userMessage: AiChatMessageRecord
  assistantMessage: AiChatMessageRecord
  latencyMs: number
  usage?: TokenUsageDelta
}

export type LiteratureSearchSort = 'relevance' | 'citations' | 'recent'

export interface SearchLiteratureInput {
  query: string
  tags?: string[]
  sort?: LiteratureSearchSort
  openAccessOnly?: boolean
  yearFrom?: number
  limit?: number
  useAiAssist?: boolean
}

export interface LiteratureSearchItem {
  id: string
  source: 'openalex' | 'arxiv'
  title: string
  authors: string[]
  year: number | null
  venue: string
  abstract: string
  citationCount: number | null
  doi: string | null
  landingUrl: string | null
  pdfUrl: string | null
  isOpenAccess: boolean
  topics: string[]
}

export interface SearchLiteratureResult {
  query: string
  effectiveQuery: string
  usedAiExpansion: boolean
  aiKeywords: string[]
  items: LiteratureSearchItem[]
  sourcesQueried: Array<'openalex' | 'arxiv'>
  warnings: string[]
}

export interface ImportLiteraturePdfInput {
  pdfUrl: string
  title: string
  tags?: string[]
  folderId?: string | null
}

export interface SummarizeLiteratureAbstractInput {
  title: string
  abstract: string
}

export interface SummarizeLiteratureAbstractResult {
  summary: string
}

export type AiResearchSkillId = 'summary-focus' | 'ppt-deck' | 'peer-review' | 'compare-matrix' | 'custom'

export interface CustomAiSkillRecord {
  id: string
  name: string
  description: string
  prompt: string
  createdAt: string
  updatedAt: string
}

export interface SaveCustomAiSkillInput {
  id?: string
  name: string
  description?: string
  prompt: string
}

export type AcademicSlideLayout = 'cover' | 'metrics' | 'two-column' | 'cards' | 'closing'

export interface AcademicSlideMetric {
  value: string
  label: string
  detail?: string
}

export interface AcademicSlideColumn {
  heading: string
  points: string[]
}

export interface AcademicSlideSpec {
  title: string
  subtitle?: string
  layout: AcademicSlideLayout
  bullets?: string[]
  metrics?: AcademicSlideMetric[]
  columns?: AcademicSlideColumn[]
  takeaway?: string
  speakerNotes?: string
}

export interface AcademicSlideDeck {
  deckTitle: string
  subtitle?: string
  authors?: string
  theme?: 'academic-navy'
  slides: AcademicSlideSpec[]
}

export interface RunAiSkillInput {
  requestId?: string
  sessionKey: string
  skill: AiResearchSkillId
  scope: AiChatScope
  customInstruction?: string
  customSkillName?: string
  customPrompt?: string
  contexts: AiChatContextDocument[]
}

export interface RunAiSkillResult {
  skill: AiResearchSkillId
  userMessage: AiChatMessageRecord
  assistantMessage: AiChatMessageRecord
  slideDeck?: AcademicSlideDeck
  latencyMs: number
  usage?: TokenUsageDelta
}

export interface ExportSlideDeckResult {
  canceled: boolean
  fileName?: string
  slideCount: number
}

export interface ExportMarkdownContentResult {
  canceled: boolean
  fileName?: string
}

export interface EnrichCitationInput {
  doi?: string
  title?: string
}

export interface EnrichCitationResult {
  matched: boolean
  source: 'openalex' | null
  confidence: 'doi' | 'title' | null
  citation: {
    title: string
    authors: string[]
    year: string
    venue: string
    doi: string
  } | null
  message: string
}

export interface CitationMetadataOverride {
  title?: string
  authors?: string[]
  year?: string
  venue?: string
  doi?: string
  citeKey?: string
}

export interface ExportFolderBibtexInput {
  scope: 'all' | 'unassigned' | 'folder'
  folderId?: string
  citationsByDocId?: Record<string, CitationMetadataOverride>
}

export interface ExportFolderBibtexResult {
  canceled: boolean
  fileName?: string
  count: number
}

export interface PaperFlowAPI {
  importPdf(): Promise<ImportPdfBatchResult>
  importPdfBytes(input: ImportPdfBytesInput): Promise<ImportResult>
  listDocuments(): Promise<DocumentRecord[]>
  readPdfBytes(documentId: string): Promise<Uint8Array>
  updatePageCount(documentId: string, pageCount: number): Promise<void>
  renameDocument(documentId: string, displayTitle: string): Promise<DocumentRecord>
  updateDocumentMeta(input: UpdateDocumentMetaInput): Promise<DocumentRecord>
  deleteDocument(documentId: string): Promise<void>
  resetLibrary(): Promise<ResetLibraryResult>
  listFolders(): Promise<LibraryFolder[]>
  createFolder(input: CreateFolderInput): Promise<LibraryFolder>
  updateFolder(input: UpdateFolderInput): Promise<LibraryFolder>
  deleteFolder(folderId: string): Promise<void>
  importFolder(input?: ImportFolderInput): Promise<ImportFolderResult>
  getReaderState(documentId: string): Promise<ReaderState | null>
  saveReaderState(state: ReaderState): Promise<void>
  listReaderProgress(): Promise<Record<string, number>>
  searchLibrary(query: string): Promise<LibrarySearchHit[]>
  getTranslationSettings(): Promise<TranslationSettings>
  saveTranslationSettings(input: SaveTranslationSettingsInput): Promise<TranslationSettings>
  getDocumentTranslationScope(documentId: string): Promise<DocumentTranslationScope>
  detectLocalAiClients(): Promise<DetectedLocalAiClient[]>
  pickCliExecutable(): Promise<PickCliExecutableResult>
  testTranslationConnection(draft?: SaveTranslationSettingsInput): Promise<TranslationTestResult>
  getProviderBalance(draft?: SaveTranslationSettingsInput): Promise<ProviderBalanceSnapshot>
  getUsageSummary(): Promise<UsageStatsSummary>
  saveUsagePreferences(input: UsagePreferences): Promise<UsageStatsSummary>
  resetUsageStats(scope?: 'today' | 'all'): Promise<UsageStatsSummary>
  getPageTranslations(documentId: string, pageNumber: number): Promise<TranslatedBlockRecord[]>
  listDocumentTranslations(documentId: string): Promise<DocumentPageTranslations[]>
  translatePage(input: TranslatePageInput): Promise<TranslatePageResult>
  updateBlockTranslation(input: UpdateBlockTranslationInput): Promise<TranslatedBlockRecord>
  exportTranslationDocument(input: ExportTranslationDocumentInput): Promise<ExportTranslationDocumentResult>
  onTranslationProgress(listener: (event: TranslationProgressEvent) => void): () => void
  cancelTranslation(documentId?: string): Promise<void>
  clearDocumentTranslations(documentId: string): Promise<void>
  explainSelection(input: ExplainSelectionInput): Promise<ExplainSelectionResult>
  listChatMessages(sessionKey: string): Promise<AiChatMessageRecord[]>
  sendChatMessage(input: SendAiChatInput): Promise<SendAiChatResult>
  runAiSkill(input: RunAiSkillInput): Promise<RunAiSkillResult>
  listCustomAiSkills(): Promise<CustomAiSkillRecord[]>
  saveCustomAiSkill(input: SaveCustomAiSkillInput): Promise<CustomAiSkillRecord[]>
  deleteCustomAiSkill(id: string): Promise<CustomAiSkillRecord[]>
  onAiChatStream(listener: (event: AiChatStreamEvent) => void): () => void
  cancelAiChat(requestId?: string): Promise<void>
  clearChatMessages(sessionKey: string): Promise<void>
  exportSlideDeckPptx(deck: AcademicSlideDeck): Promise<ExportSlideDeckResult>
  exportMarkdownContent(suggestedName: string, markdown: string): Promise<ExportMarkdownContentResult>
  searchLiterature(input: SearchLiteratureInput): Promise<SearchLiteratureResult>
  importLiteraturePdf(input: ImportLiteraturePdfInput): Promise<ImportResult>
  summarizeLiteratureAbstract(input: SummarizeLiteratureAbstractInput): Promise<SummarizeLiteratureAbstractResult>
  enrichCitationMetadata(input: EnrichCitationInput): Promise<EnrichCitationResult>
  exportFolderBibtex(input: ExportFolderBibtexInput): Promise<ExportFolderBibtexResult>
  openExternalUrl(url: string): Promise<void>
  listAnnotations(documentId: string): Promise<AnnotationRecord[]>
  createAnnotation(input: CreateAnnotationInput): Promise<AnnotationRecord>
  updateAnnotation(input: UpdateAnnotationInput): Promise<AnnotationRecord>
  deleteAnnotation(annotationId: string): Promise<void>
  exportAnnotationsMarkdown(documentId: string): Promise<ExportAnnotationsResult>
  exportBackup(): Promise<ExportBackupResult>
  importBackup(): Promise<ImportBackupResult>
  exportFolderPdfs(input: ExportFolderPdfsInput): Promise<ExportFolderPdfsResult>
  copyText(text: string): Promise<void>
  copyImageDataUrl(dataUrl: string): Promise<void>
  getResearchProfile(): Promise<ResearchProfile | null>
  saveResearchProfile(input: SaveResearchProfileInput): Promise<ResearchProfile>
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
  resetLibrary: 'library:reset',
  listFolders: 'folder:list', createFolder: 'folder:create', updateFolder: 'folder:update', deleteFolder: 'folder:delete',
  exportFolderPdfs: 'folder:export-pdfs',
  importFolder: 'folder:import-dir',
  getReaderState: 'reader:get', saveReaderState: 'reader:save', listReaderProgress: 'reader:list-progress',
  searchLibrary: 'library:search',
  getTranslationSettings: 'translation:get-settings',
  saveTranslationSettings: 'translation:save-settings',
  getDocumentTranslationScope: 'translation:get-scope',
  detectLocalAiClients: 'translation:detect-local-clients',
  pickCliExecutable: 'translation:pick-cli-executable',
  testTranslationConnection: 'translation:test',
  getProviderBalance: 'translation:get-balance',
  getUsageSummary: 'translation:get-usage',
  saveUsagePreferences: 'translation:save-usage-prefs',
  resetUsageStats: 'translation:reset-usage',
  getPageTranslations: 'translation:get-page',
  listDocumentTranslations: 'translation:list-document',
  translatePage: 'translation:translate-page',
  updateBlockTranslation: 'translation:update-block',
  exportTranslationDocument: 'translation:export-document',
  translationProgress: 'translation:progress',
  cancelTranslation: 'translation:cancel',
  clearDocumentTranslations: 'translation:clear-document',
  explainSelection: 'translation:explain',
  listChatMessages: 'ai-chat:list',
  sendChatMessage: 'ai-chat:send',
  runAiSkill: 'ai-chat:run-skill',
  listCustomAiSkills: 'ai-chat:list-custom-skills',
  saveCustomAiSkill: 'ai-chat:save-custom-skill',
  deleteCustomAiSkill: 'ai-chat:delete-custom-skill',
  aiChatStream: 'ai-chat:stream',
  cancelAiChat: 'ai-chat:cancel',
  clearChatMessages: 'ai-chat:clear',
  exportSlideDeckPptx: 'ai-chat:export-pptx',
  exportMarkdownContent: 'ai-chat:export-md',
  searchLiterature: 'literature:search',
  importLiteraturePdf: 'literature:import-pdf',
  summarizeLiteratureAbstract: 'literature:summarize-abstract',
  enrichCitationMetadata: 'citation:enrich',
  exportFolderBibtex: 'citation:export-bib',
  openExternalUrl: 'system:open-external',
  listAnnotations: 'annotation:list',
  createAnnotation: 'annotation:create',
  updateAnnotation: 'annotation:update',
  deleteAnnotation: 'annotation:delete',
  exportAnnotationsMarkdown: 'annotation:export-md',
  exportBackup: 'backup:export',
  importBackup: 'backup:import',
  copyText: 'clipboard:write-text',
  copyImageDataUrl: 'clipboard:write-image',
  getResearchProfile: 'profile:get',
  saveResearchProfile: 'profile:save'
} as const
