import { z } from 'zod'
import { hasControlCharacters } from './contracts'

const MAX_IMPORT_IPC_BYTES = 105 * 1024 * 1024

export const documentIdSchema = z.uuid()
export const pageNumberSchema = z.number().int().min(1).max(1000000)
export const scaleSchema = z.number().finite().min(0.5).max(3)
export const displayTitleSchema = z.string().trim().min(1).max(200).refine(
  value => !hasControlCharacters(value),
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
