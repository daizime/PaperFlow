import { z } from 'zod'
import { buildCitationKey, formatBibtex, formatRis, type CitationMetadata } from '../../shared/citation'
import type { GlossaryEntry } from '../../shared/contracts'
import { annotationColorSchema, annotationRectSchema, glossaryEntrySchema, pageNumberSchema } from '../../shared/schemas'
import { formatAnnotationsMarkdown } from './annotation-export'
import type { LibraryDatabase } from './database'
import type { DocumentService } from './document-service'
import { createZipBuffer, readZipBuffer, type ZipInputEntry } from './zip-archive'

const TRANSLATION_SETTINGS_KEY = 'translation.config.v1'

const backupDocumentSchema = z.object({
  id: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  originalFilename: z.string().min(1),
  displayTitle: z.string().min(1),
  byteSize: z.number().int().positive(),
  pageCount: pageNumberSchema.nullable(),
  importedAt: z.string(),
  starred: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  pdfPath: z.string().min(1),
  readerState: z
    .object({
      pageNumber: z.number().int().min(1),
      scale: z.number().min(0.5).max(3)
    })
    .nullable()
    .optional()
})

const backupAnnotationSchema = z.object({
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  pageNumber: z.number().int().min(1),
  color: annotationColorSchema,
  quoteText: z.string().min(1),
  note: z.string().default(''),
  rects: z.array(annotationRectSchema).min(1),
  sentenceIds: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
})

const backupTranslationSchema = z.object({
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  pageNumber: z.number().int().min(1),
  blockId: z.string().min(1),
  sourceHash: z.string().min(1),
  targetLanguage: z.string().min(1),
  providerSignature: z.string().min(1),
  translatedText: z.string()
})

const backupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  app: z.string(),
  exportedAt: z.string(),
  documents: z.array(backupDocumentSchema),
  annotations: z.array(backupAnnotationSchema).default([]),
  translations: z.array(backupTranslationSchema).default([]),
  glossary: z.array(glossaryEntrySchema).default([])
})

export type BackupManifest = z.infer<typeof backupManifestSchema>

export interface ExportBackupArchiveOutput {
  zipBuffer: Buffer
  documentCount: number
  annotationCount: number
  translationCount: number
  glossaryCount: number
}

export interface ImportBackupArchiveOutput {
  importedDocuments: number
  existingDocuments: number
  restoredAnnotations: number
  restoredTranslations: number
  restoredGlossary: number
}

function sanitizeArchiveBasename(rawTitle: string, usedNames: Set<string>, ext: string): string {
  const cleanStem =
    rawTitle
      .replace(/\.pdf$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 72) || 'paper'
  let candidate = `${cleanStem}${ext}`
  let counter = 2
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${cleanStem}-${counter}${ext}`
    counter += 1
  }
  usedNames.add(candidate.toLowerCase())
  return candidate
}

function readGlossaryFromSettings(database: LibraryDatabase): GlossaryEntry[] {
  const raw = database.getSetting(TRANSLATION_SETTINGS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { glossary?: unknown }
    if (!Array.isArray(parsed?.glossary)) return []
    const out: GlossaryEntry[] = []
    for (const item of parsed.glossary) {
      const checked = glossaryEntrySchema.safeParse(item)
      if (checked.success) out.push(checked.data)
    }
    return out
  } catch {
    return []
  }
}

function mergeGlossaryIntoSettings(database: LibraryDatabase, incoming: readonly GlossaryEntry[]): number {
  if (incoming.length === 0) return 0
  let existingObj: Record<string, unknown> = {
    provider: 'openai-compatible',
    targetLanguage: 'zh-CN',
    glossary: [],
    openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 120 }
  }
  const raw = database.getSetting(TRANSLATION_SETTINGS_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingObj = { ...existingObj, ...(parsed as Record<string, unknown>) }
      }
    } catch {
      // 保留默认结构并合并术语表，不破坏已有密钥项
    }
  }

  const currentGlossary = Array.isArray(existingObj.glossary)
    ? existingObj.glossary
        .map(item => glossaryEntrySchema.safeParse(item))
        .filter((r): r is { success: true; data: GlossaryEntry } => r.success)
        .map(r => r.data)
    : []

  const seen = new Set(currentGlossary.map(entry => entry.source.trim().toLowerCase()))
  const merged = [...currentGlossary]
  let added = 0
  for (const item of incoming) {
    const key = item.source.trim().toLowerCase()
    if (!key || seen.has(key) || merged.length >= 200) continue
    seen.add(key)
    merged.push(item)
    added += 1
  }

  if (added > 0) {
    existingObj.glossary = merged
    database.setSetting(TRANSLATION_SETTINGS_KEY, JSON.stringify(existingObj))
  }
  return added
}

/** 打包与恢复 PaperFlow 文献库，兼容 Zotero / EndNote / Mendeley / Obsidian 导入格式；显式排除加密 API 密钥。 */
export class BackupService {
  constructor(
    private readonly database: LibraryDatabase,
    private readonly documents: DocumentService
  ) {}

  async exportBackupArchive(): Promise<ExportBackupArchiveOutput> {
    const storedDocs = this.database.listStoredDocuments()
    const readerStates = new Map(this.database.listAllReaderStates().map(state => [state.documentId, state]))
    const allAnnotations = this.database.listAllAnnotations()
    const allTranslations = this.database.listAllTranslationCache()
    const glossary = readGlossaryFromSettings(this.database)

    const annotationsByDoc = new Map<string, typeof allAnnotations>()
    for (const ann of allAnnotations) {
      const list = annotationsByDoc.get(ann.documentId)
      if (list) list.push(ann)
      else annotationsByDoc.set(ann.documentId, [ann])
    }

    const docById = new Map(storedDocs.map(doc => [doc.id, doc]))
    const usedPdfNames = new Set<string>()
    const usedNoteNames = new Set<string>()
    const usedCiteKeys = new Set<string>()
    const entries: ZipInputEntry[] = []

    const bibEntries: string[] = []
    const risEntries: string[] = []
    const manifestDocs: BackupManifest['documents'] = []

    for (const doc of storedDocs) {
      const pdfBytes = await this.documents.readPdfBytes(doc.id)
      const pdfFile = sanitizeArchiveBasename(doc.displayTitle || doc.originalFilename, usedPdfNames, '.pdf')
      const pdfPath = `pdfs/${pdfFile}`
      entries.push({ name: pdfPath, data: pdfBytes, compress: false })

      const readerState = readerStates.get(doc.id)
      manifestDocs.push({
        id: doc.id,
        sha256: doc.sha256,
        originalFilename: doc.originalFilename,
        displayTitle: doc.displayTitle,
        byteSize: doc.byteSize,
        pageCount: doc.pageCount,
        importedAt: doc.importedAt,
        starred: doc.starred,
        tags: doc.tags,
        pdfPath,
        readerState: readerState ? { pageNumber: readerState.pageNumber, scale: readerState.scale } : null
      })

      const yearMatch = doc.displayTitle.match(/\b((?:19|20)\d{2})\b/)
      const baseCiteKey = buildCitationKey({
        title: doc.displayTitle,
        authors: [],
        year: yearMatch ? yearMatch[1] : String(new Date(doc.importedAt).getFullYear())
      })
      let uniqueCiteKey = baseCiteKey
      let keySuffix = 2
      while (usedCiteKeys.has(uniqueCiteKey.toLowerCase())) {
        uniqueCiteKey = `${baseCiteKey}_${keySuffix++}`
      }
      usedCiteKeys.add(uniqueCiteKey.toLowerCase())

      const citeMeta: CitationMetadata = {
        title: doc.displayTitle || doc.originalFilename.replace(/\.pdf$/i, ''),
        authors: [],
        year: yearMatch ? yearMatch[1] : String(new Date(doc.importedAt).getFullYear()),
        venue: '',
        doi: '',
        citeKey: uniqueCiteKey
      }
      bibEntries.push(formatBibtex(citeMeta, { filePath: pdfPath, tags: doc.tags, citeKey: uniqueCiteKey }))
      risEntries.push(formatRis(citeMeta, { filePath: pdfPath, tags: doc.tags }))

      const docAnnotations = annotationsByDoc.get(doc.id) ?? []
      if (docAnnotations.length > 0) {
        const noteFile = sanitizeArchiveBasename(doc.displayTitle || doc.originalFilename, usedNoteNames, '.md')
        const md = formatAnnotationsMarkdown(doc, docAnnotations)
        entries.push({ name: `notes/${noteFile}`, data: Buffer.from(md, 'utf8'), compress: true })
      }
    }

    const manifestAnnotations: BackupManifest['annotations'] = []
    for (const ann of allAnnotations) {
      const owner = docById.get(ann.documentId)
      if (!owner) continue
      manifestAnnotations.push({
        documentSha256: owner.sha256,
        pageNumber: ann.pageNumber,
        color: ann.color,
        quoteText: ann.quoteText,
        note: ann.note,
        rects: ann.rects,
        sentenceIds: ann.sentenceIds,
        createdAt: ann.createdAt,
        updatedAt: ann.updatedAt
      })
    }

    const manifestTranslations: BackupManifest['translations'] = []
    for (const tr of allTranslations) {
      const owner = docById.get(tr.documentId)
      if (!owner) continue
      manifestTranslations.push({
        documentSha256: owner.sha256,
        pageNumber: tr.pageNumber,
        blockId: tr.blockId,
        sourceHash: tr.sourceHash,
        targetLanguage: tr.targetLanguage,
        providerSignature: tr.providerSignature,
        translatedText: tr.translatedText
      })
    }

    const manifest: BackupManifest = {
      schemaVersion: 1,
      app: 'PaperFlow',
      exportedAt: new Date().toISOString(),
      documents: manifestDocs,
      annotations: manifestAnnotations,
      translations: manifestTranslations,
      glossary
    }

    entries.push({
      name: 'library.bib',
      data: Buffer.from(`${bibEntries.join('\n\n')}${bibEntries.length > 0 ? '\n' : ''}`, 'utf8'),
      compress: true
    })
    entries.push({
      name: 'library.ris',
      data: Buffer.from(`${risEntries.join('\n\n')}${risEntries.length > 0 ? '\n' : ''}`, 'utf8'),
      compress: true
    })
    entries.push({
      name: 'paperflow-backup.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      compress: true
    })
    entries.push({
      name: 'README-BACKUP.txt',
      data: Buffer.from(
        [
          'PaperFlow 便携备份包说明',
          '========================',
          '',
          `导出时间：${manifest.exportedAt}`,
          `文献数量：${manifestDocs.length} 篇`,
          `批注笔记：${manifestAnnotations.length} 条`,
          `译文缓存：${manifestTranslations.length} 块`,
          `专业术语：${glossary.length} 条`,
          '',
          '如何在其他工具中使用：',
          '- PaperFlow：在文献库左下角点击「恢复备份」并选择本 .zip 文件即可一键无损还原。',
          '- Zotero / JabRef / Mendeley：解压后直接导入 library.bib 或 library.ris（已自动关联 pdfs/ 目录与标签）。',
          '- EndNote：解压后通过 File -> Import -> File 导入 library.ris（Reference Manager / RIS 格式）。',
          '- Obsidian / Notion：直接将 notes/ 文件夹中的 Markdown 笔记与高亮拖入仓库。',
          '',
          '安全提示：为防止凭据泄露，便携备份包不包含已加密的翻译 API 密钥，迁移新设备后请在设置中重新填写。',
          ''
        ].join('\n'),
        'utf8'
      ),
      compress: true
    })

    return {
      zipBuffer: createZipBuffer(entries),
      documentCount: manifestDocs.length,
      annotationCount: manifestAnnotations.length,
      translationCount: manifestTranslations.length,
      glossaryCount: glossary.length
    }
  }

  async importBackupArchive(zipBytes: Uint8Array): Promise<ImportBackupArchiveOutput> {
    const entries = readZipBuffer(zipBytes)
    const manifestRaw = entries.get('paperflow-backup.json')
    if (!manifestRaw) {
      throw new Error('所选压缩包不是有效的 PaperFlow 备份包（缺少 paperflow-backup.json）。')
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(manifestRaw.toString('utf8')) as unknown
    } catch {
      throw new Error('备份清单 paperflow-backup.json 解析失败。')
    }
    const manifest = backupManifestSchema.parse(parsedJson)

    let importedDocuments = 0
    let existingDocuments = 0
    const shaToDocumentId = new Map<string, string>()

    for (const doc of manifest.documents) {
      const pdfEntry = entries.get(doc.pdfPath)
      if (!pdfEntry) {
        throw new Error(`备份包缺少 PDF 文件：${doc.pdfPath}`)
      }
      const res = await this.documents.importBuffer(doc.originalFilename, pdfEntry)
      if (res.status === 'imported') importedDocuments += 1
      else existingDocuments += 1

      const targetDocId = res.document.id
      shaToDocumentId.set(doc.sha256, targetDocId)

      if (doc.displayTitle && doc.displayTitle !== res.document.displayTitle) {
        try {
          this.database.renameDocument(targetDocId, doc.displayTitle)
        } catch {
          // 忽略异常超长或非法标题，保留导入默认标题
        }
      }

      const mergedTags = Array.from(new Set([...(res.document.tags ?? []), ...(doc.tags ?? [])]))
      const starred = Boolean(res.document.starred || doc.starred)
      if (starred !== res.document.starred || mergedTags.length !== res.document.tags.length) {
        this.database.updateDocumentMeta({ documentId: targetDocId, starred, tags: mergedTags })
      }

      if (doc.readerState && res.status === 'imported') {
        const stored = this.database.getDocument(targetDocId)
        const maxPage = stored?.pageCount ?? doc.readerState.pageNumber
        this.database.saveReaderState({
          documentId: targetDocId,
          pageNumber: Math.max(1, Math.min(maxPage, doc.readerState.pageNumber)),
          scale: Math.min(3, Math.max(0.5, doc.readerState.scale)),
          updatedAt: new Date().toISOString()
        })
      }
    }

    let restoredAnnotations = 0
    for (const ann of manifest.annotations) {
      const targetDocId = shaToDocumentId.get(ann.documentSha256)
      if (!targetDocId) continue
      try {
        const inserted = this.database.importAnnotationIfMissing({
          documentId: targetDocId,
          pageNumber: ann.pageNumber,
          color: ann.color,
          quoteText: ann.quoteText,
          note: ann.note,
          rects: ann.rects,
          sentenceIds: ann.sentenceIds,
          createdAt: ann.createdAt,
          updatedAt: ann.updatedAt
        })
        if (inserted) restoredAnnotations += 1
      } catch {
        // 单条异常批注不中断整库恢复
      }
    }

    let restoredTranslations = 0
    const groupedTranslations = new Map<
      string,
      {
        documentId: string
        pageNumber: number
        targetLanguage: string
        providerSignature: string
        items: Array<{ blockId: string; sourceHash: string; translatedText: string }>
      }
    >()
    for (const tr of manifest.translations) {
      const targetDocId = shaToDocumentId.get(tr.documentSha256)
      if (!targetDocId) continue
      const groupKey = `${targetDocId}\0${tr.pageNumber}\0${tr.targetLanguage}\0${tr.providerSignature}`
      let group = groupedTranslations.get(groupKey)
      if (!group) {
        group = {
          documentId: targetDocId,
          pageNumber: tr.pageNumber,
          targetLanguage: tr.targetLanguage,
          providerSignature: tr.providerSignature,
          items: []
        }
        groupedTranslations.set(groupKey, group)
      }
      group.items.push({
        blockId: tr.blockId,
        sourceHash: tr.sourceHash,
        translatedText: tr.translatedText
      })
    }
    for (const group of groupedTranslations.values()) {
      this.database.upsertPageTranslations(
        group.documentId,
        group.pageNumber,
        group.targetLanguage,
        group.providerSignature,
        group.items
      )
      restoredTranslations += group.items.length
    }

    const restoredGlossary = mergeGlossaryIntoSettings(this.database, manifest.glossary)

    return {
      importedDocuments,
      existingDocuments,
      restoredAnnotations,
      restoredTranslations,
      restoredGlossary
    }
  }
}
