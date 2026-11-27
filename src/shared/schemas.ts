import { z } from 'zod'
import { hasControlCharacters } from './contracts'

const MAX_IMPORT_IPC_BYTES = 105 * 1024 * 1024
const SHELL_META_RE = /[&|<>^%!\r\n`$;]/

const isSafeText = (value: string): boolean => !hasControlCharacters(value)
const isSafeMultilineText = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code === 0x7f || (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      return false
    }
  }
  return true
}
export const isSafeCliToken = (value: string): boolean => !hasControlCharacters(value) && !SHELL_META_RE.test(value)
const isValidHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export const documentIdSchema = z.uuid()
export const pageNumberSchema = z.number().int().min(1).max(1000000)
export const scaleSchema = z.number().finite().min(0.5).max(3)
export const displayTitleSchema = z.string().trim().min(1).max(200).refine(
  isSafeText,
  '文献标题不能包含控制字符。'
)
export const readerStateSchema = z.object({
  documentId: documentIdSchema, pageNumber: pageNumberSchema, scale: scaleSchema, updatedAt: z.iso.datetime()
}).strict()
export const pageCountArgsSchema = z.tuple([documentIdSchema, pageNumberSchema])
export const noArgsSchema = z.tuple([])
export const documentIdArgsSchema = z.tuple([documentIdSchema])
export const renameDocumentArgsSchema = z.tuple([documentIdSchema, displayTitleSchema])
export const importPdfBytesArgsSchema = z.tuple([
  z.object({
    originalFilename: z.string().trim().min(1).max(260),
    bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength <= MAX_IMPORT_IPC_BYTES)
  }).strict()
])
export const readerStateArgsSchema = z.tuple([readerStateSchema])

export const glossaryEntrySchema = z.object({
  source: z.string().trim().min(1).max(120).refine(isSafeText, '术语原文不能包含控制字符。'),
  target: z.string().trim().min(1).max(120).refine(isSafeText, '术语译文不能包含控制字符。')
}).strict()

export const saveTranslationSettingsSchema = z.object({
  provider: z.enum(['openai-compatible', 'cli']),
  targetLanguage: z.string().trim().min(2).max(32).refine(isSafeText, '目标语言无效。'),
  glossary: z.array(glossaryEntrySchema).max(200).optional(),
  openai: z.object({
    baseUrl: z.string().trim().min(8).max(512).refine(isValidHttpUrl, 'API Base URL 须为 http(s) 地址。'),
    model: z.string().trim().min(1).max(160).refine(isSafeText, '模型名称不能包含控制字符。'),
    apiKey: z.string().max(512).refine(isSafeText, 'API Key 不能包含控制字符。').optional()
  }).strict(),
  cli: z.object({
    preset: z.enum(['codex', 'gemini', 'custom']),
    command: z.string().trim().min(1).max(512).refine(isSafeCliToken, 'CLI 命令不能包含控制字符或危险 Shell 符号。'),
    model: z.string().trim().max(160).refine(isSafeCliToken, 'CLI 模型参数不能包含控制字符或危险 Shell 符号。'),
    extraArgs: z.array(
      z.string().trim().min(1).max(200).refine(isSafeCliToken, '附加参数不能包含控制字符或危险 Shell 符号。')
    ).max(24),
    timeoutSec: z.number().int().min(10).max(300)
  }).strict()
}).strict()

export const translationBlockInputSchema = z.object({
  blockId: z.string().trim().min(1).max(64).refine(isSafeText, '块 ID 无效。'),
  kind: z.enum(['heading', 'paragraph', 'caption', 'list-item']),
  sourceText: z.string().trim().min(1).max(12000),
  sourceHash: z.string().regex(/^[a-f0-9]{16,64}$/)
}).strict()

export const translatePageInputSchema = z.object({
  documentId: documentIdSchema,
  pageNumber: pageNumberSchema,
  blocks: z.array(translationBlockInputSchema).min(1).max(160),
  force: z.boolean().optional()
}).strict()

export const saveTranslationSettingsArgsSchema = z.tuple([saveTranslationSettingsSchema])
export const testTranslationConnectionArgsSchema = z.union([
  z.tuple([]),
  z.tuple([saveTranslationSettingsSchema])
])
export const usagePreferencesSchema = z
  .object({
    lowBalanceThreshold: z.number().finite().min(0).max(100000),
    priceCurrency: z.enum(['CNY', 'USD']),
    inputPricePer1M: z.number().finite().min(0).max(10000).nullable(),
    outputPricePer1M: z.number().finite().min(0).max(10000).nullable()
  })
  .strict()
export const getProviderBalanceArgsSchema = z.union([
  z.tuple([]),
  z.tuple([saveTranslationSettingsSchema])
])
export const saveUsagePreferencesArgsSchema = z.tuple([usagePreferencesSchema])
export const resetUsageStatsArgsSchema = z.union([
  z.tuple([]),
  z.tuple([z.enum(['today', 'all'])])
])
export const getPageTranslationsArgsSchema = z.tuple([documentIdSchema, pageNumberSchema])
export const translatePageArgsSchema = z.tuple([translatePageInputSchema])
export const updateBlockTranslationInputSchema = z
  .object({
    documentId: documentIdSchema,
    pageNumber: pageNumberSchema,
    blockId: z.string().trim().min(1).max(64).refine(isSafeText, '块 ID 无效。'),
    sourceHash: z.string().regex(/^[a-f0-9]{16,64}$/),
    translatedText: z
      .string()
      .trim()
      .min(1, '译文内容不能为空。')
      .max(24000, '译文内容超出长度限制。')
      .refine(isSafeMultilineText, '译文包含非法控制字符。')
  })
  .strict()
export const updateBlockTranslationArgsSchema = z.tuple([updateBlockTranslationInputSchema])
export const listDocumentTranslationsArgsSchema = z.tuple([documentIdSchema])
export const translationExportFormatSchema = z.enum(['bilingual-md', 'zh-md', 'zh-pdf', 'bilingual-pdf'])
export const exportTranslationPageBlockSchema = z
  .object({
    kind: z.enum(['heading', 'paragraph', 'caption', 'list-item']),
    sourceText: z.string().max(16000).refine(isSafeMultilineText, '原文包含非法控制字符。'),
    translatedText: z.string().max(24000).refine(isSafeMultilineText, '译文包含非法控制字符。').nullable()
  })
  .strict()
export const exportTranslationPageSchema = z
  .object({
    pageNumber: pageNumberSchema,
    blocks: z.array(exportTranslationPageBlockSchema).max(200)
  })
  .strict()
export const exportTranslationDocumentInputSchema = z
  .object({
    documentId: documentIdSchema,
    title: z.string().trim().min(1, '标题不能为空。').max(240).refine(isSafeText, '标题包含非法控制字符。'),
    format: translationExportFormatSchema,
    pages: z.array(exportTranslationPageSchema).max(1000)
  })
  .strict()
export const exportTranslationDocumentArgsSchema = z.tuple([exportTranslationDocumentInputSchema])
export const cancelTranslationArgsSchema = z.union([
  z.tuple([]),
  z.tuple([documentIdSchema.optional()])
])

export const explainSelectionInputSchema = z.object({
  documentId: documentIdSchema,
  pageNumber: pageNumberSchema,
  selectedText: z.string().trim().min(1).max(4000).refine(isSafeMultilineText, '选中文本包含非法控制字符。'),
  contextText: z.string().trim().max(6000).refine(isSafeMultilineText, '上下文包含非法控制字符。').optional(),
  mode: z.enum(['explain', 'formula', 'translate'])
}).strict()
export const explainSelectionArgsSchema = z.tuple([explainSelectionInputSchema])

export const annotationIdSchema = z.uuid()
export const annotationColorSchema = z.enum(['yellow', 'green', 'blue', 'pink'])
export const annotationRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive()
}).strict()

export const createAnnotationInputSchema = z
  .object({
    documentId: documentIdSchema,
    pageNumber: pageNumberSchema,
    color: annotationColorSchema,
    quoteText: z.string().trim().min(1).max(4000).refine(isSafeMultilineText, '摘录文本包含非法控制字符。'),
    note: z.string().trim().max(8000).refine(isSafeMultilineText, '笔记内容包含非法控制字符。').optional(),
    rects: z.array(annotationRectSchema).max(200),
    sentenceIds: z.array(z.string().trim().min(1).max(120)).max(200).optional()
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.rects.length === 0 && !(val.note && val.note.trim().length > 0)) {
      ctx.addIssue({
        code: 'custom',
        message: '页面级笔记必须包含笔记正文或正文选区。',
        path: ['rects']
      })
    }
  })

export const updateAnnotationInputSchema = z.object({
  id: annotationIdSchema,
  color: annotationColorSchema.optional(),
  note: z.string().trim().max(8000).refine(isSafeMultilineText, '笔记内容包含非法控制字符。').optional()
}).strict()

export const listAnnotationsArgsSchema = z.tuple([documentIdSchema])
export const createAnnotationArgsSchema = z.tuple([createAnnotationInputSchema])
export const updateAnnotationArgsSchema = z.tuple([updateAnnotationInputSchema])
export const deleteAnnotationArgsSchema = z.tuple([annotationIdSchema])
export const exportAnnotationsArgsSchema = z.tuple([documentIdSchema])

export const documentTagSchema = z
  .string()
  .trim()
  .min(1, '标签不能为空。')
  .max(32, '标签长度不能超过 32 个字符。')
  .refine(v => !hasControlCharacters(v), '标签不能包含控制字符。')

export const folderIdSchema = z.uuid()
export const folderNameSchema = z
  .string()
  .trim()
  .min(1, '分类名称不能为空。')
  .max(64, '分类名称长度不能超过 64 个字符。')
  .refine(isSafeText, '分类名称不能包含控制字符。')

export const folderContextSummarySchema = z
  .string()
  .trim()
  .max(300, '学科语境说明不能超过 300 个字符。')
  .refine(isSafeMultilineText, '学科语境说明包含非法控制字符。')

export const libraryFolderSchema = z
  .object({
    id: folderIdSchema,
    parentId: folderIdSchema.nullable(),
    name: folderNameSchema,
    facultyId: z.string().trim().max(64).refine(isSafeText, '学科门类标识不能包含控制字符。'),
    contextSummary: folderContextSummarySchema,
    glossary: z.array(glossaryEntrySchema).max(200),
    inheritGlobalGlossary: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime()
  })
  .strict()

export const createFolderInputSchema = z
  .object({
    parentId: folderIdSchema.nullable().optional(),
    name: folderNameSchema,
    facultyId: z.string().trim().max(64).refine(isSafeText, '学科门类标识不能包含控制字符。').optional(),
    contextSummary: folderContextSummarySchema.optional(),
    glossary: z.array(glossaryEntrySchema).max(200).optional(),
    inheritGlobalGlossary: z.boolean().optional()
  })
  .strict()

export const updateFolderInputSchema = z
  .object({
    id: folderIdSchema,
    parentId: folderIdSchema.nullable().optional(),
    name: folderNameSchema.optional(),
    facultyId: z.string().trim().max(64).refine(isSafeText, '学科门类标识不能包含控制字符。').optional(),
    contextSummary: folderContextSummarySchema.optional(),
    glossary: z.array(glossaryEntrySchema).max(200).optional(),
    inheritGlobalGlossary: z.boolean().optional()
  })
  .strict()

export const createFolderArgsSchema = z.tuple([createFolderInputSchema])
export const updateFolderArgsSchema = z.tuple([updateFolderInputSchema])
export const deleteFolderArgsSchema = z.tuple([folderIdSchema])

export const exportFolderPdfsInputSchema = z
  .object({
    scope: z.enum(['all', 'unassigned', 'folder']),
    folderId: folderIdSchema.optional(),
    includeAnnotations: z.boolean().optional()
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.scope === 'folder' && !data.folderId) {
      ctx.addIssue({ code: 'custom', message: '指定导出分类时必须提供分类文件夹 ID。', path: ['folderId'] })
    }
    if (data.scope !== 'folder' && data.folderId !== undefined) {
      ctx.addIssue({ code: 'custom', message: '非单分类导出不应指定 folderId。', path: ['folderId'] })
    }
  })

export const exportFolderPdfsArgsSchema = z.tuple([exportFolderPdfsInputSchema])

export const importFolderInputSchema = z
  .object({
    parentFolderId: folderIdSchema.nullable().optional()
  })
  .strict()

export const importFolderArgsSchema = z.union([z.tuple([]), z.tuple([importFolderInputSchema])])
export const getDocumentTranslationScopeArgsSchema = z.tuple([documentIdSchema])

export const readingStatusSchema = z.enum(['unread', 'reading', 'done'])

export const updateDocumentMetaInputSchema = z
  .object({
    documentId: documentIdSchema,
    starred: z.boolean().optional(),
    tags: z.array(documentTagSchema).max(20).optional(),
    folderId: folderIdSchema.nullable().optional(),
    readingStatus: readingStatusSchema.optional()
  })
  .strict()
export const updateDocumentMetaArgsSchema = z.tuple([updateDocumentMetaInputSchema])
export const listReaderProgressArgsSchema = z.tuple([])
export const librarySearchQuerySchema = z
  .string()
  .trim()
  .min(1, '搜索关键词不能为空。')
  .max(200, '搜索关键词不能超过 200 个字符。')
  .refine(v => !hasControlCharacters(v), '搜索关键词不能包含控制字符。')
export const searchLibraryArgsSchema = z.tuple([librarySearchQuerySchema])
export const copyTextArgsSchema = z.tuple([z.string().min(1).max(200_000)])
export const copyImageDataUrlArgsSchema = z.tuple([
  z.string().startsWith('data:image/png;base64,').max(12 * 1024 * 1024)
])

export const researchStageSchema = z.enum(['undergrad-prep', 'master-1', 'master-senior', 'phd', 'other'])
export const researchOnboardingModeSchema = z.enum(['direct', 'guided', 'skipped'])
export const researchParadigmSchema = z.enum(['exp', 'theory', 'comp', 'design'])
export const researchReadingGoalSchema = z.enum(['survey', 'reproduce', 'writing'])

const researchFacultyIdSchema = z
  .string()
  .trim()
  .max(64)
  .refine(isSafeText, '学科门类标识不能包含控制字符。')

const researchTrackIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isSafeText, '方向标识不能包含控制字符。')

const researchCustomTopicSchema = z
  .string()
  .trim()
  .max(160, '自定义研究课题长度不能超过 160 个字符。')
  .refine(isSafeText, '研究课题不能包含控制字符。')

export const researchProfileSchema = z
  .object({
    completed: z.boolean(),
    mode: researchOnboardingModeSchema,
    stage: researchStageSchema,
    facultyId: researchFacultyIdSchema,
    selectedTrackIds: z.array(researchTrackIdSchema).max(6),
    customTopic: researchCustomTopicSchema,
    paradigm: researchParadigmSchema,
    readingGoal: researchReadingGoalSchema,
    recommendedTags: z.array(documentTagSchema).max(16),
    updatedAt: z.iso.datetime()
  })
  .strict()

export const saveResearchProfileInputSchema = z
  .object({
    completed: z.boolean(),
    mode: researchOnboardingModeSchema,
    stage: researchStageSchema,
    facultyId: researchFacultyIdSchema,
    selectedTrackIds: z.array(researchTrackIdSchema).max(6),
    customTopic: researchCustomTopicSchema,
    paradigm: researchParadigmSchema,
    readingGoal: researchReadingGoalSchema,
    recommendedTags: z.array(documentTagSchema).max(16),
    applyStarterGlossary: z.boolean().optional()
  })
  .strict()

export const saveResearchProfileArgsSchema = z.tuple([saveResearchProfileInputSchema])

export const chatSessionKeySchema = z
  .string()
  .trim()
  .min(1, '会话标识不能为空。')
  .max(96, '会话标识过长。')
  .refine(v => isSafeText(v) && /^[a-zA-Z0-9:_-]+$/.test(v), '会话标识格式无效。')

export const aiChatContextDocumentSchema = z
  .object({
    documentId: documentIdSchema,
    title: z.string().trim().min(1).max(260).refine(isSafeText, '文献标题不能包含控制字符。'),
    paneLabel: z.string().trim().max(24).refine(isSafeText, '分栏标识不能包含控制字符。').optional(),
    pageNumber: pageNumberSchema.optional(),
    excerpt: z.string().trim().max(16000).refine(isSafeMultilineText, '页面摘录包含非法控制字符。').optional()
  })
  .strict()

export const sendAiChatInputSchema = z
  .object({
    requestId: z.string().trim().min(1).max(64).refine(isSafeText, '请求 ID 无效。').optional(),
    sessionKey: chatSessionKeySchema,
    question: z
      .string()
      .trim()
      .min(1, '请输入要询问的问题。')
      .max(6000, '问题长度不能超过 6000 个字符。')
      .refine(isSafeMultilineText, '问题内容包含非法控制字符。'),
    scope: z.enum(['active', 'all-open', 'free']),
    quoteText: z
      .string()
      .trim()
      .max(4000, '引用片段不能超过 4000 个字符。')
      .refine(isSafeMultilineText, '引用片段包含非法控制字符。')
      .optional(),
    contexts: z.array(aiChatContextDocumentSchema).max(6)
  })
  .strict()

export const listChatMessagesArgsSchema = z.tuple([chatSessionKeySchema])
export const sendAiChatArgsSchema = z.tuple([sendAiChatInputSchema])
export const cancelAiChatArgsSchema = z.union([
  z.tuple([]),
  z.tuple([z.string().trim().min(1).max(64).refine(isSafeText, '请求 ID 无效。').optional()])
])
export const clearChatMessagesArgsSchema = z.tuple([chatSessionKeySchema])

export const literatureSearchSortSchema = z.enum(['relevance', 'citations', 'recent'])

export const searchLiteratureInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .max(240, '搜索词长度不能超过 240 个字符。')
      .refine(isSafeText, '搜索词包含非法控制字符。'),
    tags: z.array(documentTagSchema).max(8).optional(),
    sort: literatureSearchSortSchema.optional(),
    openAccessOnly: z.boolean().optional(),
    yearFrom: z.number().int().min(1900).max(2100).optional(),
    limit: z.number().int().min(1).max(25).optional(),
    useAiAssist: z.boolean().optional()
  })
  .strict()
  .refine(
    val => val.query.trim().length > 0 || Boolean(val.tags && val.tags.some(tag => tag.trim().length > 0)),
    '请输入搜索关键词或选择至少一个标签。'
  )

export const searchLiteratureArgsSchema = z.tuple([searchLiteratureInputSchema])

export const importLiteraturePdfInputSchema = z
  .object({
    pdfUrl: z
      .string()
      .trim()
      .min(1, 'PDF 链接不能为空。')
      .max(1500, 'PDF 链接过长。')
      .refine(isSafeText, 'PDF 链接包含非法控制字符。'),
    title: z
      .string()
      .trim()
      .min(1, '文献标题不能为空。')
      .max(240, '文献标题长度不能超过 240 个字符。')
      .refine(isSafeText, '文献标题包含非法控制字符。'),
    tags: z.array(documentTagSchema).max(16).optional(),
    folderId: folderIdSchema.nullable().optional()
  })
  .strict()

export const importLiteraturePdfArgsSchema = z.tuple([importLiteraturePdfInputSchema])

export const summarizeLiteratureAbstractInputSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, '文献标题不能为空。')
      .max(300, '文献标题长度不能超过 300 个字符。')
      .refine(isSafeText, '文献标题包含非法控制字符。'),
    abstract: z
      .string()
      .trim()
      .min(1, '文献摘要不能为空。')
      .max(8000, '文献摘要过长。')
      .refine(isSafeMultilineText, '文献摘要包含非法控制字符。')
  })
  .strict()

export const summarizeLiteratureAbstractArgsSchema = z.tuple([summarizeLiteratureAbstractInputSchema])

export const openExternalUrlArgsSchema = z.tuple([
  z
    .string()
    .trim()
    .min(1, '链接不能为空。')
    .max(1500, '链接过长。')
    .refine(isSafeText, '链接包含非法控制字符。')
])

export const aiResearchSkillIdSchema = z.enum(['summary-focus', 'ppt-deck', 'peer-review', 'compare-matrix', 'custom'])

export const customAiSkillIdSchema = z.uuid()

export const saveCustomAiSkillInputSchema = z
  .object({
    id: customAiSkillIdSchema.optional(),
    name: z
      .string()
      .trim()
      .min(1, '技能名称不能为空。')
      .max(60, '技能名称不能超过 60 个字符。')
      .refine(isSafeText, '技能名称不能包含控制字符。'),
    description: z
      .string()
      .trim()
      .max(160, '技能说明不能超过 160 个字符。')
      .refine(isSafeText, '技能说明不能包含控制字符。')
      .optional(),
    prompt: z
      .string()
      .trim()
      .min(1, 'Prompt 模板不能为空。')
      .max(4000, 'Prompt 模板不能超过 4000 个字符。')
      .refine(isSafeMultilineText, 'Prompt 模板包含非法控制字符。')
  })
  .strict()

export const saveCustomAiSkillArgsSchema = z.tuple([saveCustomAiSkillInputSchema])
export const deleteCustomAiSkillArgsSchema = z.tuple([customAiSkillIdSchema])

export const runAiSkillInputSchema = z
  .object({
    requestId: z.string().trim().min(1).max(64).refine(isSafeText, '请求 ID 无效。').optional(),
    sessionKey: chatSessionKeySchema,
    skill: aiResearchSkillIdSchema,
    scope: z.enum(['active', 'all-open', 'free']),
    customInstruction: z
      .string()
      .trim()
      .max(1000, '附加要求不能超过 1000 个字符。')
      .refine(isSafeMultilineText, '附加要求包含非法控制字符。')
      .optional(),
    customSkillName: z
      .string()
      .trim()
      .max(60, '自定义技能名称不能超过 60 个字符。')
      .refine(isSafeText, '自定义技能名称不能包含控制字符。')
      .optional(),
    customPrompt: z
      .string()
      .trim()
      .max(4000, '自定义 Prompt 不能超过 4000 个字符。')
      .refine(isSafeMultilineText, '自定义 Prompt 包含非法控制字符。')
      .optional(),
    contexts: z.array(aiChatContextDocumentSchema).max(6)
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.skill === 'custom' && !(val.customPrompt && val.customPrompt.trim().length > 0)) {
      ctx.addIssue({
        code: 'custom',
        message: '执行自定义技能时必须提供 Prompt 模板。',
        path: ['customPrompt']
      })
    }
  })

export const runAiSkillArgsSchema = z.tuple([runAiSkillInputSchema])

const slideMetricSchema = z
  .object({
    value: z.string().trim().min(1).max(64).refine(isSafeText, '指标数值不能包含控制字符。'),
    label: z.string().trim().min(1).max(120).refine(isSafeText, '指标名称不能包含控制字符。'),
    detail: z.string().trim().max(240).refine(isSafeText, '指标说明不能包含控制字符。').optional()
  })
  .strict()

const slideColumnSchema = z
  .object({
    heading: z.string().trim().min(1).max(120).refine(isSafeText, '分栏标题不能包含控制字符。'),
    points: z.array(z.string().trim().min(1).max(360).refine(isSafeMultilineText, '要点包含控制字符。')).max(8)
  })
  .strict()

const slideSpecSchema = z
  .object({
    title: z.string().trim().min(1).max(180).refine(isSafeText, '幻灯片标题不能包含控制字符。'),
    subtitle: z.string().trim().max(260).refine(isSafeText, '副标题不能包含控制字符。').optional(),
    layout: z.enum(['cover', 'metrics', 'two-column', 'cards', 'closing']),
    bullets: z.array(z.string().trim().min(1).max(360).refine(isSafeMultilineText, '列表项包含控制字符。')).max(8).optional(),
    metrics: z.array(slideMetricSchema).max(6).optional(),
    columns: z.array(slideColumnSchema).max(4).optional(),
    takeaway: z.string().trim().max(320).refine(isSafeMultilineText, '结论摘要包含控制字符。').optional(),
    speakerNotes: z.string().trim().max(2000).refine(isSafeMultilineText, '演讲备注包含控制字符。').optional()
  })
  .strict()

export const academicSlideDeckSchema = z
  .object({
    deckTitle: z.string().trim().min(1).max(200).refine(isSafeText, '演示文稿标题不能包含控制字符。'),
    subtitle: z.string().trim().max(280).refine(isSafeText, '副标题不能包含控制字符。').optional(),
    authors: z.string().trim().max(200).refine(isSafeText, '作者信息不能包含控制字符。').optional(),
    theme: z.literal('academic-navy').optional(),
    slides: z.array(slideSpecSchema).min(1).max(24)
  })
  .strict()

export const exportSlideDeckPptxArgsSchema = z.tuple([academicSlideDeckSchema])

export const exportMarkdownContentArgsSchema = z.tuple([
  z.string().trim().min(1, '建议文件名不能为空。').max(120).refine(isSafeText, '文件名不能包含控制字符。'),
  z.string().trim().min(1, '导出内容不能为空。').max(200_000, '导出内容超出长度限制。')
])

export const enrichCitationInputSchema = z
  .object({
    doi: z.string().trim().max(240).refine(isSafeText, 'DOI 包含非法控制字符。').optional(),
    title: z.string().trim().max(400).refine(isSafeText, '标题包含非法控制字符。').optional()
  })
  .strict()
  .refine(
    val => Boolean((val.doi && val.doi.trim()) || (val.title && val.title.trim())),
    '请至少提供文献 DOI 或标题后再进行联网校对。'
  )

export const enrichCitationArgsSchema = z.tuple([enrichCitationInputSchema])

export const citationMetadataOverrideSchema = z
  .object({
    title: z.string().trim().max(400).refine(isSafeText, '标题包含控制字符。').optional(),
    authors: z.array(z.string().trim().max(160).refine(isSafeText, '作者包含控制字符。')).max(50).optional(),
    year: z.string().trim().max(16).refine(isSafeText, '年份包含控制字符。').optional(),
    venue: z.string().trim().max(300).refine(isSafeText, '期刊/会议包含控制字符。').optional(),
    doi: z.string().trim().max(240).refine(isSafeText, 'DOI 包含控制字符。').optional(),
    citeKey: z.string().trim().max(120).refine(isSafeText, 'CiteKey 包含控制字符。').optional()
  })
  .strict()

export const exportFolderBibtexInputSchema = z
  .object({
    scope: z.enum(['all', 'unassigned', 'folder']),
    folderId: folderIdSchema.optional(),
    citationsByDocId: z.record(documentIdSchema, citationMetadataOverrideSchema).optional()
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.scope === 'folder' && !data.folderId) {
      ctx.addIssue({ code: 'custom', message: '导出指定分类 .bib 时必须提供分类文件夹 ID。', path: ['folderId'] })
    }
    if (data.scope !== 'folder' && data.folderId !== undefined) {
      ctx.addIssue({ code: 'custom', message: '非单分类导出 .bib 不应指定 folderId。', path: ['folderId'] })
    }
  })

export const exportFolderBibtexArgsSchema = z.tuple([exportFolderBibtexInputSchema])
