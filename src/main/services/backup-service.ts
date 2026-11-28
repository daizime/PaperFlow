import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { buildCitationKey, formatBibtex, formatRis, type CitationMetadata } from '../../shared/citation'
import {
  MAX_PDF_BYTES,
  hasControlCharacters,
  type ExportFolderBibtexInput,
  type ExportFolderPdfsInput,
  type GlossaryEntry,
  type ImportFolderResult,
  type LibraryFolder
} from '../../shared/contracts'
import {
  annotationColorSchema,
  annotationRectSchema,
  exportFolderBibtexInputSchema,
  glossaryEntrySchema,
  libraryFolderSchema,
  pageNumberSchema,
  readingStatusSchema,
  researchProfileSchema
} from '../../shared/schemas'
import { formatAnnotationsMarkdown } from './annotation-export'
import type { LibraryDatabase } from './database'
import type { DocumentService } from './document-service'
import {
  RESEARCH_PROFILE_SETTINGS_KEY,
  TRANSLATION_SETTINGS_KEY,
  mergeGlossaryIntoSettings,
  readResearchProfile
} from './research-profile'
import { assertZipInputLimits, createZipBuffer, readZipBuffer, type ReadZipOptions, type ZipInputEntry } from './zip-archive'

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
  folderId: z.string().nullable().optional(),
  readingStatus: readingStatusSchema.default('unread'),
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
  id: z.uuid().optional(),
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  pageNumber: z.number().int().min(1),
  color: annotationColorSchema,
  quoteText: z.string().min(1),
  note: z.string().default(''),
  rects: z.array(annotationRectSchema),
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
  folders: z.array(libraryFolderSchema).default([]),
  annotations: z.array(backupAnnotationSchema).default([]),
  translations: z.array(backupTranslationSchema).default([]),
  glossary: z.array(glossaryEntrySchema).default([]),
  researchProfile: researchProfileSchema.nullable().optional()
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

const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function sanitizePathSegment(raw: string, fallback = '分类', maxLen = 40): string {
  let clean = raw
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, maxLen)
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (!clean || clean === '.' || clean === '..') clean = fallback
  if (WINDOWS_RESERVED_NAME_RE.test(clean)) clean = `_${clean}`
  return clean
}

function buildFolderSegmentMap(
  folders: readonly LibraryFolder[],
  rootParentId: string | null = null
): Map<string, string[]> {
  const byParent = new Map<string | null, LibraryFolder[]>()
  for (const folder of folders) {
    const key = folder.parentId ?? null
    const list = byParent.get(key)
    if (list) list.push(folder)
    else byParent.set(key, [folder])
  }

  const result = new Map<string, string[]>()
  const visit = (parentId: string | null, prefix: string[], visited: Set<string>): void => {
    const usedSiblings = new Set<string>()
    for (const child of byParent.get(parentId) ?? []) {
      if (visited.has(child.id)) continue
      const baseSeg = sanitizePathSegment(child.name, '未命名分类')
      let seg = baseSeg
      let suffix = 2
      while (usedSiblings.has(seg.toLowerCase())) {
        seg = `${baseSeg}-${suffix++}`
      }
      usedSiblings.add(seg.toLowerCase())
      const nextSegments = [...prefix, seg]
      result.set(child.id, nextSegments)
      const nextVisited = new Set(visited)
      nextVisited.add(child.id)
      visit(child.id, nextSegments, nextVisited)
    }
  }
  visit(rootParentId, [], rootParentId ? new Set([rootParentId]) : new Set())
  return result
}

function assertWithinRoot(rootDir: string, candidatePath: string): string {
  const resolvedRoot = resolve(rootDir)
  const resolvedTarget = resolve(candidatePath)
  const normalizedRoot = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(normalizedRoot)) {
    throw new Error('导出路径超出所选目录范围，已阻止写入。')
  }
  return resolvedTarget
}

function pickUniqueDiskPdfPath(
  rootDir: string,
  dirPath: string,
  rawTitle: string,
  usedNames: Set<string>
): string {
  const stemRaw = rawTitle.replace(/\.pdf$/i, '')
  const safeStem = sanitizePathSegment(stemRaw, 'paper', 72)
  let candidate = `${safeStem}.pdf`
  let counter = 2
  while (
    usedNames.has(candidate.toLowerCase()) ||
    existsSync(assertWithinRoot(rootDir, join(dirPath, candidate)))
  ) {
    candidate = `${safeStem}-${counter++}.pdf`
  }
  usedNames.add(candidate.toLowerCase())
  return assertWithinRoot(rootDir, join(dirPath, candidate))
}

function getScopedUsedNames(map: Map<string, Set<string>>, dirKey: string): Set<string> {
  let set = map.get(dirKey)
  if (!set) {
    set = new Set<string>()
    map.set(dirKey, set)
  }
  return set
}

function sanitizeArchiveBasename(rawTitle: string, usedNames: Set<string>, ext: string): string {
  const stem = rawTitle.replace(/\.pdf$/i, '')
  const cleanStem = sanitizePathSegment(stem, 'paper', 72)
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

function restoreFoldersFromBackup(
  database: LibraryDatabase,
  incomingFolders: readonly LibraryFolder[]
): Map<string, string> {
  const idMap = new Map<string, string>()
  if (incomingFolders.length === 0) return idMap
  if (new Set(incomingFolders.map(folder => folder.id)).size !== incomingFolders.length) {
    throw new Error('备份清单包含重复的分类文件夹 ID。')
  }
  // 旧包已有 UUID，映射仅保存在目标库中；旧包重导也能识别本轮曾创建的分类。
  const mappingKey = 'backup.folder-id-map.v1'
  let persistedMap: Record<string, string> = {}
  try {
    const checked = z.record(z.uuid(), z.uuid()).safeParse(JSON.parse(database.getSetting(mappingKey) ?? '{}'))
    if (checked.success) persistedMap = checked.data
  } catch { /* 旧库没有映射或设置损坏时，使用下方语义匹配。 */ }
  const pending = [...incomingFolders]
  const existingFolders = database.listFolders()
  const claimedTargets = new Set<string>()
  const glossarySignature = (folder: LibraryFolder): string => JSON.stringify(folder.glossary
    .map(entry => [entry.source.trim().toLowerCase(), entry.target.trim()])
    .sort((left, right) => left[0].localeCompare(right[0])))
  const sameContext = (left: LibraryFolder, right: LibraryFolder): boolean =>
    left.facultyId === right.facultyId && left.contextSummary === right.contextSummary &&
    left.inheritGlobalGlossary === right.inheritGlobalGlossary && glossarySignature(left) === glossarySignature(right)

  const applyFolder = (src: LibraryFolder, parentId: string | null): void => {
    const mappedId = persistedMap[src.id]
    // 一个目标分类在本轮只可对应一个源分类，不能按名称合并两个合法同名兄弟。
    const available = existingFolders.filter(folder => !claimedTargets.has(folder.id))
    const matched = available.find(folder => folder.id === mappedId) ??
      available.find(folder => folder.id === src.id) ??
      available.find(folder => (folder.parentId ?? null) === parentId &&
        folder.name.trim().toLowerCase() === src.name.trim().toLowerCase() && sameContext(folder, src))
    if (matched) {
      idMap.set(src.id, matched.id)
      claimedTargets.add(matched.id)
      persistedMap[src.id] = matched.id
      return
    }
    const created = database.createFolder({
      parentId,
      name: src.name,
      facultyId: src.facultyId,
      contextSummary: src.contextSummary,
      glossary: src.glossary,
      inheritGlobalGlossary: src.inheritGlobalGlossary
    })
    existingFolders.push(created)
    idMap.set(src.id, created.id)
    claimedTargets.add(created.id)
    persistedMap[src.id] = created.id
  }

  let progressed = true
  while (pending.length > 0 && progressed) {
    progressed = false
    for (let i = 0; i < pending.length; i += 1) {
      const candidate = pending[i]
      if (candidate.parentId === null || idMap.has(candidate.parentId)) {
        const targetParent = candidate.parentId ? (idMap.get(candidate.parentId) ?? null) : null
        applyFolder(candidate, targetParent)
        pending.splice(i, 1)
        i -= 1
        progressed = true
      }
    }
  }
  // 孤立父引用兜底：挂到根级确保文件夹不丢失
  for (const orphan of pending) {
    applyFolder(orphan, null)
  }
  database.setSetting(mappingKey, JSON.stringify(persistedMap))
  return idMap
}

/** 打包与恢复 Foliopair 文献库，兼容 Zotero / EndNote / Mendeley / Obsidian 导入格式；显式排除加密 API 密钥。 */
export class BackupService {
  constructor(
    private readonly database: LibraryDatabase,
    private readonly documents: DocumentService,
    private readonly zipOptions?: ReadZipOptions
  ) {}

  async exportBackupArchive(): Promise<ExportBackupArchiveOutput> {
    const storedDocs = this.database.listStoredDocuments()
    const folders = this.database.listFolders()
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
    const folderSegmentsById = buildFolderSegmentMap(folders)
    const usedPdfNamesByDir = new Map<string, Set<string>>()
    const usedNoteNamesByDir = new Map<string, Set<string>>()
    const usedCiteKeys = new Set<string>()
    const entries: ZipInputEntry[] = []
    const pdfEntries: Array<{ name: string; documentId: string; byteLength: number; compress: false }> = []

    const bibEntries: string[] = []
    const risEntries: string[] = []
    const manifestDocs: BackupManifest['documents'] = []

    for (const doc of storedDocs) {
      const folderSegments = doc.folderId ? folderSegmentsById.get(doc.folderId) : undefined
      const dirKey = folderSegments && folderSegments.length > 0 ? folderSegments.join('/') : ''
      const pdfFile = sanitizeArchiveBasename(
        doc.displayTitle || doc.originalFilename,
        getScopedUsedNames(usedPdfNamesByDir, dirKey),
        '.pdf'
      )
      const pdfPath = dirKey ? `pdfs/${dirKey}/${pdfFile}` : `pdfs/${pdfFile}`
      pdfEntries.push({ name: pdfPath, documentId: doc.id, byteLength: doc.byteSize, compress: false })

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
        folderId: doc.folderId,
        readingStatus: doc.readingStatus,
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
        const noteFile = sanitizeArchiveBasename(
          doc.displayTitle || doc.originalFilename,
          getScopedUsedNames(usedNoteNamesByDir, dirKey),
          '.md'
        )
        const notePath = dirKey ? `notes/${dirKey}/${noteFile}` : `notes/${noteFile}`
        const md = formatAnnotationsMarkdown(doc, docAnnotations)
        entries.push({ name: notePath, data: Buffer.from(md, 'utf8'), compress: true })
      }
    }

    const manifestAnnotations: BackupManifest['annotations'] = []
    for (const ann of allAnnotations) {
      const owner = docById.get(ann.documentId)
      if (!owner) continue
      manifestAnnotations.push({
        id: ann.id,
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

    const researchProfile = readResearchProfile(this.database)

    const manifest: BackupManifest = {
      schemaVersion: 1,
      app: 'Foliopair',
      exportedAt: new Date().toISOString(),
      documents: manifestDocs,
      folders,
      annotations: manifestAnnotations,
      translations: manifestTranslations,
      glossary,
      researchProfile
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
          'Foliopair 便携备份包说明',
          '========================',
          '',
          `导出时间：${manifest.exportedAt}`,
          `文献数量：${manifestDocs.length} 篇`,
          `批注笔记：${manifestAnnotations.length} 条`,
          `译文缓存：${manifestTranslations.length} 块`,
          `专业术语：${glossary.length} 条`,
          '',
          '如何在其他工具中使用：',
          '- Foliopair：在文献库左下角点击「恢复备份」并选择本 .zip 文件即可一键无损还原（含分类文件夹与专属术语表）。',
          '- Zotero / JabRef / Mendeley：解压后直接导入 library.bib 或 library.ris（已按分类文件夹建子目录并关联 pdfs/ 与标签）。',
          '- EndNote：解压后通过 File -> Import -> File 导入 library.ris（Reference Manager / RIS 格式）。',
          '- Obsidian / Notion：直接将 notes/ 文件夹中的分类目录与 Markdown 笔记拖入仓库。',
          '',
          '安全提示：为防止凭据泄露，便携备份包不包含已加密的翻译 API 密钥，迁移新设备后请在设置中重新填写。',
          ''
        ].join('\n'),
        'utf8'
      ),
      compress: true
    })

    // 先按数据库中的 PDF 大小和已生成的元数据预检，超限库无需读入全部 PDF。
    assertZipInputLimits([
      ...pdfEntries,
      ...entries.map(entry => ({ name: entry.name, byteLength: entry.data.byteLength, compress: entry.compress }))
    ], this.zipOptions)
    for (const entry of pdfEntries) {
      entries.push({ name: entry.name, data: await this.documents.readPdfBytes(entry.documentId), compress: false })
    }
    return {
      zipBuffer: createZipBuffer(entries, this.zipOptions),
      documentCount: manifestDocs.length,
      annotationCount: manifestAnnotations.length,
      translationCount: manifestTranslations.length,
      glossaryCount: glossary.length
    }
  }

  async importBackupArchive(zipBytes: Uint8Array): Promise<ImportBackupArchiveOutput> {
    const entries = readZipBuffer(zipBytes, this.zipOptions)
    const manifestRaw = entries.get('paperflow-backup.json')
    if (!manifestRaw) {
      throw new Error('所选压缩包不是有效的 Foliopair 备份包（缺少 paperflow-backup.json）。')
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(manifestRaw.toString('utf8')) as unknown
    } catch {
      throw new Error('备份清单 paperflow-backup.json 解析失败。')
    }
    const manifest = backupManifestSchema.parse(parsedJson)

    const folderIdMap = restoreFoldersFromBackup(this.database, manifest.folders)

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
      const mappedFolderId = doc.folderId ? (folderIdMap.get(doc.folderId) ?? null) : null
      const nextFolderId = res.document.folderId === null && mappedFolderId !== null ? mappedFolderId : undefined
      const nextReadingStatus =
        res.document.readingStatus === 'unread' && doc.readingStatus !== 'unread' ? doc.readingStatus : undefined
      if (
        starred !== res.document.starred ||
        mergedTags.length !== res.document.tags.length ||
        nextFolderId !== undefined ||
        nextReadingStatus !== undefined
      ) {
        this.database.updateDocumentMeta({
          documentId: targetDocId,
          starred,
          tags: mergedTags,
          ...(nextFolderId !== undefined ? { folderId: nextFolderId } : {}),
          ...(nextReadingStatus !== undefined ? { readingStatus: nextReadingStatus } : {})
        })
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
          id: ann.id,
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

    if (manifest.researchProfile && manifest.researchProfile.mode !== 'skipped') {
      const currentProfile = readResearchProfile(this.database)
      if (!currentProfile || currentProfile.mode === 'skipped') {
        this.database.setSetting(RESEARCH_PROFILE_SETTINGS_KEY, JSON.stringify(manifest.researchProfile))
      }
    }

    return {
      importedDocuments,
      existingDocuments,
      restoredAnnotations,
      restoredTranslations,
      restoredGlossary
    }
  }

  private pickUniqueDiskNotePath(exportRoot: string, pdfTargetFile: string): string {
    const baseNotePath = pdfTargetFile.replace(/\.pdf$/i, '-批注.md')
    let candidate = assertWithinRoot(exportRoot, baseNotePath)
    let index = 2
    while (existsSync(candidate)) {
      candidate = assertWithinRoot(exportRoot, pdfTargetFile.replace(/\.pdf$/i, `-批注 (${index}).md`))
      index += 1
    }
    return candidate
  }

  private async exportDocumentWithOptionalNotes(
    doc: ReturnType<LibraryDatabase['listStoredDocuments']>[number],
    targetDir: string,
    exportRoot: string,
    usedNamesByDir: Map<string, Set<string>>,
    includeAnnotations: boolean
  ): Promise<{ exportedNotes: number }> {
    const bytes = await this.documents.readPdfBytes(doc.id)
    const targetFile = pickUniqueDiskPdfPath(
      exportRoot,
      targetDir,
      doc.displayTitle || doc.originalFilename,
      getScopedUsedNames(usedNamesByDir, targetDir)
    )
    await writeFile(targetFile, bytes)

    if (!includeAnnotations) {
      return { exportedNotes: 0 }
    }
    const annotations = this.database.listAnnotations(doc.id)
    if (annotations.length === 0) {
      return { exportedNotes: 0 }
    }
    const markdown = formatAnnotationsMarkdown(doc, annotations)
    const noteFile = this.pickUniqueDiskNotePath(exportRoot, targetFile)
    await writeFile(noteFile, markdown, 'utf8')
    return { exportedNotes: 1 }
  }

  /** 按分类文件夹层级将本地 PDF 原件导出到用户选择的真实资源管理器目录中（可选附带 Markdown 批注，不移动或改动内部 UUID 库）。 */
  async exportFoldersToDirectory(
    targetParentDir: string,
    input: ExportFolderPdfsInput
  ): Promise<{ targetDir: string; exportedCount: number; folderCount: number; exportedNotesCount: number }> {
    const resolvedParent = resolve(targetParentDir)
    const includeAnnotations = Boolean(input.includeAnnotations)
    const folders = this.database.listFolders()
    const folderSet = new Set(folders.map(f => f.id))
    const storedDocs = this.database.listStoredDocuments()
    const usedNamesByDir = new Map<string, Set<string>>()

    if (input.scope === 'folder') {
      const rootFolder = folders.find(f => f.id === input.folderId)
      if (!rootFolder) {
        throw new Error('要导出的分类文件夹不存在。')
      }
      const rootName = sanitizePathSegment(rootFolder.name, '分类文献')
      const exportRoot = assertWithinRoot(resolvedParent, join(resolvedParent, rootName))
      await mkdir(exportRoot, { recursive: true })

      const descendantSegments = buildFolderSegmentMap(folders, rootFolder.id)
      const dirByFolderId = new Map<string, string>([[rootFolder.id, exportRoot]])
      for (const [folderId, segments] of descendantSegments.entries()) {
        const subDir = assertWithinRoot(exportRoot, join(exportRoot, ...segments))
        await mkdir(subDir, { recursive: true })
        dirByFolderId.set(folderId, subDir)
      }

      let exportedCount = 0
      let exportedNotesCount = 0
      for (const doc of storedDocs) {
        if (!doc.folderId) continue
        const targetSubDir = dirByFolderId.get(doc.folderId)
        if (!targetSubDir) continue
        const { exportedNotes } = await this.exportDocumentWithOptionalNotes(
          doc,
          targetSubDir,
          exportRoot,
          usedNamesByDir,
          includeAnnotations
        )
        exportedCount += 1
        exportedNotesCount += exportedNotes
      }

      return {
        targetDir: exportRoot,
        exportedCount,
        folderCount: dirByFolderId.size,
        exportedNotesCount
      }
    }

    if (input.scope === 'unassigned') {
      const exportRoot = assertWithinRoot(resolvedParent, join(resolvedParent, '未分类'))
      await mkdir(exportRoot, { recursive: true })
      let exportedCount = 0
      let exportedNotesCount = 0
      for (const doc of storedDocs) {
        if (doc.folderId && folderSet.has(doc.folderId)) continue
        const { exportedNotes } = await this.exportDocumentWithOptionalNotes(
          doc,
          exportRoot,
          exportRoot,
          usedNamesByDir,
          includeAnnotations
        )
        exportedCount += 1
        exportedNotesCount += exportedNotes
      }
      return {
        targetDir: exportRoot,
        exportedCount,
        folderCount: 1,
        exportedNotesCount
      }
    }

    const dateTag = new Date().toISOString().slice(0, 10)
    const exportRoot = assertWithinRoot(resolvedParent, join(resolvedParent, `Foliopair-分类文献-${dateTag}`))
    await mkdir(exportRoot, { recursive: true })

    const segmentMap = buildFolderSegmentMap(folders)
    const dirByFolderId = new Map<string, string>()
    for (const [folderId, segments] of segmentMap.entries()) {
      const folderDir = assertWithinRoot(exportRoot, join(exportRoot, ...segments))
      await mkdir(folderDir, { recursive: true })
      dirByFolderId.set(folderId, folderDir)
    }

    let folderCount = dirByFolderId.size
    let unassignedDir: string | null = null
    let exportedCount = 0
    let exportedNotesCount = 0
    for (const doc of storedDocs) {
      let targetDir = doc.folderId ? dirByFolderId.get(doc.folderId) : undefined
      if (!targetDir) {
        if (!unassignedDir) {
          unassignedDir = assertWithinRoot(exportRoot, join(exportRoot, '未分类'))
          await mkdir(unassignedDir, { recursive: true })
          folderCount += 1
        }
        targetDir = unassignedDir
      }
      const { exportedNotes } = await this.exportDocumentWithOptionalNotes(
        doc,
        targetDir,
        exportRoot,
        usedNamesByDir,
        includeAnnotations
      )
      exportedCount += 1
      exportedNotesCount += exportedNotes
    }

    return {
      targetDir: exportRoot,
      exportedCount,
      folderCount,
      exportedNotesCount
    }
  }

  /** 将本地硬盘文件夹树导入为 Zotero 分类（最多 4 级，超深目录扁平合并到第 4 级），跳过隐藏项、符号链接与损坏 PDF，并按 SHA-256 去重。 */
  async importFolderFromDirectory(
    sourceDir: string,
    parentFolderId: string | null = null
  ): Promise<Omit<ImportFolderResult, 'canceled'>> {
    const resolvedRoot = resolve(sourceDir)
    const rootStat = await lstat(resolvedRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('所选路径不是有效本地目录，已拒绝符号链接。')
    }
    if (parentFolderId && !this.database.getFolder(parentFolderId)) {
      throw new Error('目标父分类文件夹不存在。')
    }

    const folderList = this.database.listFolders()
    const createdFolderIds: string[] = []
    const documentIdSet = new Set<string>()
    let importedCount = 0
    let duplicateCount = 0
    let skippedCount = 0
    let createdFolderCount = 0
    let assignedCount = 0

    const getDepth = (folderId: string | null): number => {
      if (!folderId) return 0
      const byId = new Map(folderList.map(f => [f.id, f]))
      const seen = new Set<string>()
      let depth = 0
      let cursor: string | null = folderId
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor)
        const current = byId.get(cursor)
        if (!current) break
        depth += 1
        cursor = current.parentId
      }
      return depth
    }

    const sanitizeFolderTitle = (rawName: string): string => {
      const cleaned = Array.from(rawName.trim())
        .filter(ch => !hasControlCharacters(ch))
        .join('')
        .slice(0, 64)
        .trim()
      return cleaned || '导入分类'
    }

    const ensureFolder = (targetParentId: string | null, rawName: string): string => {
      if (targetParentId && getDepth(targetParentId) >= 4) {
        return targetParentId
      }
      const cleanName = sanitizeFolderTitle(rawName)
      const existing = folderList.find(
        folder => folder.parentId === targetParentId && folder.name.toLowerCase() === cleanName.toLowerCase()
      )
      if (existing) {
        return existing.id
      }
      const created = this.database.createFolder({
        parentId: targetParentId,
        name: cleanName,
        inheritGlobalGlossary: true
      })
      folderList.push(created)
      createdFolderIds.push(created.id)
      createdFolderCount += 1
      return created.id
    }

    const rootFolderId = ensureFolder(parentFolderId, basename(resolvedRoot) || '导入文件夹')

    const walk = async (dirPath: string, currentFolderId: string): Promise<void> => {
      const entries = await readdir(dirPath, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue
        }
        const entryPath = assertWithinRoot(resolvedRoot, join(dirPath, entry.name))
        let entryStat
        try {
          entryStat = await lstat(entryPath)
        } catch {
          skippedCount += 1
          continue
        }
        if (entryStat.isSymbolicLink() || entry.isSymbolicLink()) {
          if (/\.pdf$/i.test(entry.name) || entry.isDirectory()) {
            skippedCount += 1
          }
          continue
        }
        if (entryStat.isDirectory()) {
          const nextFolderId = ensureFolder(currentFolderId, entry.name)
          await walk(entryPath, nextFolderId)
          continue
        }
        if (!entryStat.isFile() || !/\.pdf$/i.test(entry.name)) {
          continue
        }
        if (entryStat.size === 0 || entryStat.size > MAX_PDF_BYTES) {
          skippedCount += 1
          continue
        }
        try {
          const res = await this.documents.importFile(entryPath)
          documentIdSet.add(res.document.id)
          if (res.status === 'imported') {
            importedCount += 1
          } else {
            duplicateCount += 1
          }
          if (res.status === 'imported' || res.document.folderId === null) {
            this.database.updateDocumentMeta({
              documentId: res.document.id,
              folderId: currentFolderId
            })
            assignedCount += 1
          }
        } catch {
          skippedCount += 1
        }
      }
    }

    await walk(resolvedRoot, rootFolderId)

    return {
      sourceDir: resolvedRoot,
      importedCount,
      duplicateCount,
      skippedCount,
      createdFolderCount,
      assignedCount,
      folderIds: createdFolderIds,
      documentIds: Array.from(documentIdSet)
    }
  }

  /** 按全部 / 未分类 / 指定分类（含子分类）汇总生成去重后的标准 BibTeX (.bib) 字符串。 */
  buildFolderBibtex(input: ExportFolderBibtexInput): {
    bibtex: string
    count: number
    defaultFilename: string
  } {
    const validated = exportFolderBibtexInputSchema.parse(input)
    const folders = this.database.listFolders()
    const folderSet = new Set(folders.map(f => f.id))
    const allDocs = this.database.listStoredDocuments()

    let targetDocs = allDocs
    let defaultStem = `Foliopair-全部文献-${new Date().toISOString().slice(0, 10)}`
    if (validated.scope === 'unassigned') {
      targetDocs = allDocs.filter(doc => !doc.folderId || !folderSet.has(doc.folderId))
      defaultStem = '未分类文献引用'
    } else if (validated.scope === 'folder') {
      const rootFolder = folders.find(f => f.id === validated.folderId)
      if (!rootFolder) {
        throw new Error('要导出引用的分类文件夹不存在。')
      }
      const descendantMap = buildFolderSegmentMap(folders, rootFolder.id)
      const allowedFolderIds = new Set<string>([rootFolder.id, ...descendantMap.keys()])
      targetDocs = allDocs.filter(doc => Boolean(doc.folderId && allowedFolderIds.has(doc.folderId)))
      defaultStem = `${sanitizePathSegment(rootFolder.name, '分类文献', 60)}-引用`
    }

    const usedCiteKeys = new Set<string>()
    const entries: string[] = []
    for (const doc of targetDocs) {
      const override = validated.citationsByDocId?.[doc.id]
      const fallbackTitle = (doc.displayTitle || doc.originalFilename.replace(/\.pdf$/i, '')).trim()
      const yearMatch = fallbackTitle.match(/\b((?:19|20)\d{2})\b/)
      const fallbackYear = yearMatch ? yearMatch[1] : String(new Date(doc.importedAt).getFullYear())
      const title = override?.title?.trim() || fallbackTitle
      const authors = override?.authors?.filter(a => a.trim().length > 0) ?? []
      const year = override?.year?.trim() || fallbackYear
      const venue = override?.venue?.trim() || ''
      const doi = override?.doi?.trim() || ''
      const baseKey =
        override?.citeKey?.trim() ||
        buildCitationKey({
          title,
          authors,
          year
        })

      let uniqueKey = baseKey || 'paperRef'
      let suffix = 2
      while (usedCiteKeys.has(uniqueKey.toLowerCase())) {
        uniqueKey = `${baseKey || 'paperRef'}_${suffix++}`
      }
      usedCiteKeys.add(uniqueKey.toLowerCase())

      const meta: CitationMetadata = {
        title,
        authors,
        year,
        venue,
        doi,
        citeKey: uniqueKey
      }
      entries.push(formatBibtex(meta, { tags: doc.tags, citeKey: uniqueKey }))
    }

    return {
      bibtex: `${entries.join('\n\n')}${entries.length > 0 ? '\n' : ''}`,
      count: entries.length,
      defaultFilename: `${defaultStem}.bib`
    }
  }
}
