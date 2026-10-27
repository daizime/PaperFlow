import { z } from 'zod'
export const documentIdSchema = z.uuid()
export const pageNumberSchema = z.number().int().min(1).max(1000000)
export const scaleSchema = z.number().finite().min(0.5).max(3)
export const readerStateSchema = z.object({
  documentId: documentIdSchema, pageNumber: pageNumberSchema, scale: scaleSchema, updatedAt: z.iso.datetime()
}).strict()
export const pageCountArgsSchema = z.tuple([documentIdSchema, pageNumberSchema])
export const noArgsSchema = z.tuple([])
export const documentIdArgsSchema = z.tuple([documentIdSchema])
export const readerStateArgsSchema = z.tuple([readerStateSchema])
