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
const isSafeCliToken = (value: string): boolean => !hasControlCharacters(value) && !SHELL_META_RE.test(value)
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
    preset: z.enum(['codex', 'claude', 'gemini', 'custom']),
    command: z.string().trim().min(1).max(260).refine(isSafeCliToken, 'CLI 命令不能包含控制字符或危险 Shell 符号。'),
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
export const getPageTranslationsArgsSchema = z.tuple([documentIdSchema, pageNumberSchema])
export const translatePageArgsSchema = z.tuple([translatePageInputSchema])
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

export const createAnnotationInputSchema = z.object({
  documentId: documentIdSchema,
  pageNumber: pageNumberSchema,
  color: annotationColorSchema,
  quoteText: z.string().trim().min(1).max(4000).refine(isSafeMultilineText, '摘录文本包含非法控制字符。'),
  note: z.string().trim().max(8000).refine(isSafeMultilineText, '笔记内容包含非法控制字符。').optional(),
  rects: z.array(annotationRectSchema).min(1).max(200),
  sentenceIds: z.array(z.string().trim().min(1).max(120)).max(200).optional()
}).strict()

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

export const updateDocumentMetaInputSchema = z
  .object({
    documentId: documentIdSchema,
    starred: z.boolean().optional(),
    tags: z.array(documentTagSchema).max(20).optional()
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
