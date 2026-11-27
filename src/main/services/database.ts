import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type {
  AiChatMessageRecord,
  AiChatRole,
  AnnotationColor,
  AnnotationRecord,
  AnnotationRect,
  CreateAnnotationInput,
  CreateFolderInput,
  DocumentPageTranslations,
  DocumentRecord,
  GlossaryEntry,
  LibraryFolder,
  LibrarySearchHit,
  ReaderState,
  ReadingStatus,
  ResetLibraryResult,
  TranslatedBlockRecord,
  UpdateAnnotationInput,
  UpdateDocumentMetaInput,
  UpdateFolderInput
} from '../../shared/contracts'
import {
  annotationIdSchema,
  chatSessionKeySchema,
  createAnnotationInputSchema,
  createFolderInputSchema,
  displayTitleSchema,
  documentIdSchema,
  folderIdSchema,
  glossaryEntrySchema,
  librarySearchQuerySchema,
  pageNumberSchema,
  readerStateSchema,
  readingStatusSchema,
  updateAnnotationInputSchema,
  updateDocumentMetaInputSchema,
  updateFolderInputSchema
} from '../../shared/schemas'

export interface StoredDocumentRecord extends DocumentRecord {
  sha256: string
  storedFilename: string
}

export type InsertDocumentInput = Omit<StoredDocumentRecord, 'starred' | 'tags' | 'folderId' | 'readingStatus'> & {
  starred?: boolean
  tags?: string[]
  folderId?: string | null
  readingStatus?: ReadingStatus
}

export interface StoredTranslationCacheRow {
  documentId: string
  pageNumber: number
  blockId: string
  sourceHash: string
  targetLanguage: string
  providerSignature: string
  translatedText: string
  updatedAt: string
}

const storedDocumentSchema = z.object({
  id: documentIdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  originalFilename: z.string().min(1).max(4096),
  displayTitle: z.string().min(1).max(4096),
  storedFilename: z.string().regex(/^[a-f0-9-]{36}\.pdf$/),
  byteSize: z.number().int().positive().max(100 * 1024 * 1024),
  pageCount: pageNumberSchema.nullable(),
  importedAt: z.iso.datetime(),
  starred: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  folderId: folderIdSchema.nullable().default(null),
  readingStatus: readingStatusSchema.default('unread')
}).strict()

interface DocumentRow {
  id: string
  sha256: string
  original_filename: string
  display_title: string
  stored_filename: string
  byte_size: number
  page_count: number | null
  imported_at: string
  starred?: number
  tags_json?: string
  folder_id?: string | null
  reading_status?: string | null
}

interface FolderRow {
  id: string
  parent_id: string | null
  name: string
  faculty_id: string
  context_summary: string
  glossary_json: string
  inherit_global_glossary: number
  created_at: string
  updated_at: string
}

interface ReaderStateRow {
  document_id: string
  page_number: number
  scale: number
  updated_at: string
}

interface TranslationCacheRow {
  block_id: string
  source_hash: string
  translated_text: string
  provider_signature: string
  updated_at: string
}

interface AnnotationRow {
  id: string
  document_id: string
  page_number: number
  color: AnnotationColor
  quote_text: string
  note: string
  rects_json: string
  sentence_ids_json: string
  created_at: string
  updated_at: string
}

function toAnnotationRecord(row: AnnotationRow): AnnotationRecord {
  let rects: AnnotationRect[] = []
  let sentenceIds: string[] = []
  try {
    const parsedRects = JSON.parse(row.rects_json) as unknown
    if (Array.isArray(parsedRects)) {
      rects = parsedRects as AnnotationRect[]
    }
  } catch {
    rects = []
  }
  try {
    const parsedIds = JSON.parse(row.sentence_ids_json) as unknown
    if (Array.isArray(parsedIds)) {
      sentenceIds = parsedIds.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    sentenceIds = []
  }
  return {
    id: row.id,
    documentId: row.document_id,
    pageNumber: row.page_number,
    color: row.color,
    quoteText: row.quote_text,
    note: row.note,
    rects,
    sentenceIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function parseTagsJson(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  } catch {
    return []
  }
}

function parseFolderGlossaryJson(raw: string | undefined): GlossaryEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: GlossaryEntry[] = []
    for (const item of parsed) {
      const checked = glossaryEntrySchema.safeParse(item)
      if (checked.success) out.push(checked.data)
    }
    return out
  } catch {
    return []
  }
}

function dedupeFolderGlossary(entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  const seen = new Set<string>()
  const out: GlossaryEntry[] = []
  for (const item of entries) {
    const key = item.source.trim().toLowerCase()
    if (!key || seen.has(key) || out.length >= 200) continue
    seen.add(key)
    out.push({ source: item.source.trim(), target: item.target.trim() })
  }
  return out
}

function toLibraryFolder(row: FolderRow): LibraryFolder {
  return {
    id: row.id,
    parentId: row.parent_id ?? null,
    name: row.name,
    facultyId: row.faculty_id ?? '',
    contextSummary: row.context_summary ?? '',
    glossary: parseFolderGlossaryJson(row.glossary_json),
    inheritGlobalGlossary: Boolean(row.inherit_global_glossary),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, ch => `\\${ch}`)
}

function buildSearchSnippet(text: string, query: string, maxLen = 110): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLen) return clean
  const idx = clean.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return `${clean.slice(0, maxLen - 1).trimEnd()}…`
  const half = Math.floor((maxLen - query.length) / 2)
  const start = Math.max(0, idx - half)
  const end = Math.min(clean.length, start + maxLen)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < clean.length ? '…' : ''
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`
}

function toStoredDocument(row: DocumentRow): StoredDocumentRecord {
  const readingStatus: ReadingStatus =
    row.reading_status === 'reading' || row.reading_status === 'done' ? row.reading_status : 'unread'
  return {
    id: row.id,
    sha256: row.sha256,
    originalFilename: row.original_filename,
    displayTitle: row.display_title,
    storedFilename: row.stored_filename,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    importedAt: row.imported_at,
    starred: Boolean(row.starred),
    tags: parseTagsJson(row.tags_json),
    folderId: row.folder_id ?? null,
    readingStatus
  }
}

function toPublicDocument(record: StoredDocumentRecord): DocumentRecord {
  return {
    id: record.id,
    originalFilename: record.originalFilename,
    displayTitle: record.displayTitle,
    byteSize: record.byteSize,
    pageCount: record.pageCount,
    importedAt: record.importedAt,
    starred: record.starred,
    tags: record.tags,
    folderId: record.folderId,
    readingStatus: record.readingStatus
  }
}

/** 数据库位置由主进程以 userData 路径注入；本服务不依赖安装目录。 */
export class LibraryDatabase {
  private readonly database: Database.Database

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.database = new Database(filename)
    try {
      this.database.pragma('foreign_keys = ON')
      this.database.pragma('journal_mode = WAL')
      this.database.pragma('busy_timeout = 5000')
      this.migrate()
    } catch (error: unknown) {
      this.database.close()
      throw error
    }
  }

  private migrate(): void {
    const version = this.database.pragma('user_version', { simple: true }) as number
    if (version > 7) throw new Error('文献数据库版本较新，请使用更新版本的 PaperFlow。')
    if (version === 7) return
    this.database.transaction(() => {
      if (version < 1) {
        this.database.exec(`
          CREATE TABLE documents (
            id TEXT PRIMARY KEY NOT NULL,
            sha256 TEXT NOT NULL UNIQUE,
            original_filename TEXT NOT NULL,
            display_title TEXT NOT NULL,
            stored_filename TEXT NOT NULL UNIQUE,
            byte_size INTEGER NOT NULL CHECK(byte_size > 0 AND byte_size <= 104857600),
            page_count INTEGER CHECK(page_count IS NULL OR page_count >= 1),
            imported_at TEXT NOT NULL
          );
          CREATE TABLE reader_state (
            document_id TEXT PRIMARY KEY NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            page_number INTEGER NOT NULL CHECK(page_number >= 1),
            scale REAL NOT NULL CHECK(scale >= 0.5 AND scale <= 3),
            updated_at TEXT NOT NULL
          );
        `)
      }
      if (version < 2) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS translation_cache (
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            page_number INTEGER NOT NULL CHECK(page_number >= 1),
            block_id TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            target_language TEXT NOT NULL,
            provider_signature TEXT NOT NULL,
            translated_text TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (document_id, page_number, block_id, target_language)
          );
          CREATE INDEX IF NOT EXISTS idx_translation_cache_lookup
            ON translation_cache (document_id, page_number, target_language);
          CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `)
      }
      if (version < 3) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS annotations (
            id TEXT PRIMARY KEY NOT NULL,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            page_number INTEGER NOT NULL CHECK(page_number >= 1),
            color TEXT NOT NULL,
            quote_text TEXT NOT NULL,
            note TEXT NOT NULL,
            rects_json TEXT NOT NULL,
            sentence_ids_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_annotations_doc_page
            ON annotations (document_id, page_number, created_at);
        `)
      }
      if (version < 4) {
        const columns = this.database.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
        const columnNames = new Set(columns.map(col => col.name))
        if (!columnNames.has('starred')) {
          this.database.exec('ALTER TABLE documents ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;')
        }
        if (!columnNames.has('tags_json')) {
          this.database.exec("ALTER TABLE documents ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';")
        }
      }
      if (version < 5) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY NOT NULL,
            parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            faculty_id TEXT NOT NULL DEFAULT '',
            context_summary TEXT NOT NULL DEFAULT '',
            glossary_json TEXT NOT NULL DEFAULT '[]',
            inherit_global_glossary INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_folders_parent
            ON folders (parent_id, name);
        `)
        const columns = this.database.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
        const columnNames = new Set(columns.map(col => col.name))
        if (!columnNames.has('folder_id')) {
          this.database.exec('ALTER TABLE documents ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;')
        }
        this.database.exec(`
          CREATE INDEX IF NOT EXISTS idx_documents_folder
            ON documents (folder_id);
          PRAGMA user_version = 5;
        `)
      }
      if (version < 6) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY NOT NULL,
            session_key TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            quote_text TEXT NOT NULL DEFAULT '',
            context_summary TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_chat_messages_session
            ON chat_messages (session_key, created_at);
          PRAGMA user_version = 6;
        `)
      }
      if (version < 7) {
        const columns = this.database.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
        const columnNames = new Set(columns.map(col => col.name))
        if (!columnNames.has('reading_status')) {
          this.database.exec("ALTER TABLE documents ADD COLUMN reading_status TEXT NOT NULL DEFAULT 'unread';")
        }
        this.database.exec('PRAGMA user_version = 7;')
      }
    })()
  }

  listDocuments(): DocumentRecord[] {
    const rows = this.database.prepare('SELECT * FROM documents ORDER BY imported_at DESC, id').all() as DocumentRow[]
    return rows.map(row => toPublicDocument(toStoredDocument(row)))
  }

  listStoredDocuments(): StoredDocumentRecord[] {
    const rows = this.database.prepare('SELECT * FROM documents ORDER BY imported_at DESC, id').all() as DocumentRow[]
    return rows.map(toStoredDocument)
  }

  listStoredFilenames(): Set<string> {
    const rows = this.database.prepare('SELECT stored_filename FROM documents').all() as Array<{ stored_filename: string }>
    return new Set(rows.map(row => row.stored_filename))
  }

  getDocument(id: string): StoredDocumentRecord | null {
    const documentId = documentIdSchema.parse(id)
    const row = this.database.prepare('SELECT * FROM documents WHERE id = ?').get(documentId) as DocumentRow | undefined
    return row ? toStoredDocument(row) : null
  }

  getByHash(hash: string): StoredDocumentRecord | null {
    const sha256 = z.string().regex(/^[a-f0-9]{64}$/).parse(hash)
    const row = this.database.prepare('SELECT * FROM documents WHERE sha256 = ?').get(sha256) as DocumentRow | undefined
    return row ? toStoredDocument(row) : null
  }

  insertDocument(input: InsertDocumentInput): DocumentRecord {
    const record = storedDocumentSchema.parse(input)
    if (record.storedFilename !== `${record.id}.pdf`) throw new Error('文献存储文件名无效。')
    if (record.folderId !== null && !this.getFolder(record.folderId)) {
      throw new Error('目标分类文件夹不存在。')
    }
    this.database.prepare(`
      INSERT INTO documents (id, sha256, original_filename, display_title, stored_filename, byte_size, page_count, imported_at, starred, tags_json, folder_id, reading_status)
      VALUES (@id, @sha256, @originalFilename, @displayTitle, @storedFilename, @byteSize, @pageCount, @importedAt, @starred, @tagsJson, @folderId, @readingStatus)
    `).run({
      id: record.id,
      sha256: record.sha256,
      originalFilename: record.originalFilename,
      displayTitle: record.displayTitle,
      storedFilename: record.storedFilename,
      byteSize: record.byteSize,
      pageCount: record.pageCount,
      importedAt: record.importedAt,
      starred: record.starred ? 1 : 0,
      tagsJson: JSON.stringify(record.tags),
      folderId: record.folderId,
      readingStatus: record.readingStatus
    })
    return toPublicDocument(record)
  }

  private requireDocument(id: string): StoredDocumentRecord {
    const document = this.getDocument(id)
    if (!document) throw new Error('文献不存在，请重新选择文献。')
    return document
  }

  updatePageCount(id: string, pageCount: number): void {
    const document = this.requireDocument(id)
    const count = pageNumberSchema.parse(pageCount)
    this.database.transaction(() => {
      this.database.prepare('UPDATE documents SET page_count = ? WHERE id = ?').run(count, document.id)
      this.database.prepare('UPDATE reader_state SET page_number = ? WHERE document_id = ? AND page_number > ?')
        .run(count, document.id, count)
    })()
  }

  renameDocument(id: string, displayTitle: string): DocumentRecord {
    const document = this.requireDocument(id)
    const title = displayTitleSchema.parse(displayTitle)
    const result = this.database.prepare('UPDATE documents SET display_title = ? WHERE id = ?').run(title, document.id)
    if (result.changes !== 1) throw new Error('文献不存在，请重新选择文献。')
    return toPublicDocument(this.requireDocument(document.id))
  }

  deleteDocument(id: string): StoredDocumentRecord {
    const document = this.requireDocument(id)
    const result = this.database.prepare('DELETE FROM documents WHERE id = ?').run(document.id)
    if (result.changes !== 1) throw new Error('文献不存在，请重新选择文献。')
    return document
  }

  getReaderState(id: string): ReaderState | null {
    const document = this.requireDocument(id)
    const row = this.database.prepare('SELECT * FROM reader_state WHERE document_id = ?').get(document.id) as ReaderStateRow | undefined
    return row ? { documentId: row.document_id, pageNumber: row.page_number, scale: row.scale, updatedAt: row.updated_at } : null
  }

  saveReaderState(input: ReaderState): void {
    const state = readerStateSchema.parse(input)
    const document = this.requireDocument(state.documentId)
    if (document.pageCount !== null && state.pageNumber > document.pageCount) throw new Error('阅读页码超出文献页数。')
    this.database.prepare(`
      INSERT INTO reader_state (document_id, page_number, scale, updated_at)
      VALUES (@documentId, @pageNumber, @scale, @updatedAt)
      ON CONFLICT(document_id) DO UPDATE SET page_number = excluded.page_number, scale = excluded.scale, updated_at = excluded.updated_at
    `).run({ ...state, updatedAt: new Date().toISOString() })
  }

  getSetting(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? row.value : null
  }

  setSetting(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString())
  }

  deleteSetting(key: string): void {
    this.database.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
  }

  getPageTranslations(documentId: string, pageNumber: number, targetLanguage: string): TranslatedBlockRecord[] {
    const document = this.requireDocument(documentId)
    const page = pageNumberSchema.parse(pageNumber)
    const rows = this.database.prepare(`
      SELECT block_id, source_hash, translated_text, provider_signature, updated_at
      FROM translation_cache
      WHERE document_id = ? AND page_number = ? AND target_language = ?
      ORDER BY block_id
    `).all(document.id, page, targetLanguage) as TranslationCacheRow[]
    return rows.map(row => ({
      blockId: row.block_id,
      sourceHash: row.source_hash,
      translatedText: row.translated_text,
      providerSignature: row.provider_signature,
      updatedAt: row.updated_at
    }))
  }

  listDocumentTranslations(documentId: string, targetLanguage: string): DocumentPageTranslations[] {
    const document = this.requireDocument(documentId)
    const rows = this.database.prepare(`
      SELECT page_number, block_id, source_hash, translated_text, provider_signature, updated_at
      FROM translation_cache
      WHERE document_id = ? AND target_language = ?
      ORDER BY page_number ASC, block_id ASC
    `).all(document.id, targetLanguage) as Array<TranslationCacheRow & { page_number: number }>

    const pages: DocumentPageTranslations[] = []
    let current: DocumentPageTranslations | null = null
    for (const row of rows) {
      if (!current || current.pageNumber !== row.page_number) {
        current = { pageNumber: row.page_number, items: [] }
        pages.push(current)
      }
      current.items.push({
        blockId: row.block_id,
        sourceHash: row.source_hash,
        translatedText: row.translated_text,
        providerSignature: row.provider_signature,
        updatedAt: row.updated_at
      })
    }
    return pages
  }

  upsertPageTranslations(
    documentId: string,
    pageNumber: number,
    targetLanguage: string,
    providerSignature: string,
    items: ReadonlyArray<{ blockId: string; sourceHash: string; translatedText: string }>
  ): void {
    if (items.length === 0) return
    const document = this.requireDocument(documentId)
    const page = pageNumberSchema.parse(pageNumber)
    const now = new Date().toISOString()
    const stmt = this.database.prepare(`
      INSERT INTO translation_cache (
        document_id, page_number, block_id, source_hash, target_language, provider_signature, translated_text, updated_at
      )
      VALUES (@documentId, @pageNumber, @blockId, @sourceHash, @targetLanguage, @providerSignature, @translatedText, @updatedAt)
      ON CONFLICT(document_id, page_number, block_id, target_language) DO UPDATE SET
        source_hash = excluded.source_hash,
        provider_signature = excluded.provider_signature,
        translated_text = excluded.translated_text,
        updated_at = excluded.updated_at
    `)
    this.database.transaction(() => {
      for (const item of items) {
        stmt.run({
          documentId: document.id,
          pageNumber: page,
          blockId: item.blockId,
          sourceHash: item.sourceHash,
          targetLanguage,
          providerSignature,
          translatedText: item.translatedText,
          updatedAt: now
        })
      }
    })()
  }

  clearDocumentTranslations(documentId: string): void {
    const document = this.requireDocument(documentId)
    this.database.prepare('DELETE FROM translation_cache WHERE document_id = ?').run(document.id)
  }

  listAnnotations(documentId: string): AnnotationRecord[] {
    const document = this.requireDocument(documentId)
    const rows = this.database.prepare(`
      SELECT id, document_id, page_number, color, quote_text, note, rects_json, sentence_ids_json, created_at, updated_at
      FROM annotations
      WHERE document_id = ?
      ORDER BY page_number ASC, created_at ASC
    `).all(document.id) as AnnotationRow[]
    return rows.map(toAnnotationRecord)
  }

  createAnnotation(input: CreateAnnotationInput): AnnotationRecord {
    const validated = createAnnotationInputSchema.parse(input)
    const document = this.requireDocument(validated.documentId)
    const now = new Date().toISOString()
    const id = randomUUID()
    const note = (validated.note ?? '').trim()
    const sentenceIds = validated.sentenceIds ?? []
    this.database.prepare(`
      INSERT INTO annotations (
        id, document_id, page_number, color, quote_text, note, rects_json, sentence_ids_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      document.id,
      validated.pageNumber,
      validated.color,
      validated.quoteText,
      note,
      JSON.stringify(validated.rects),
      JSON.stringify(sentenceIds),
      now,
      now
    )
    const row = this.database.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnotationRow | undefined
    if (!row) throw new Error('批注保存失败。')
    return toAnnotationRecord(row)
  }

  updateAnnotation(input: UpdateAnnotationInput): AnnotationRecord {
    const validated = updateAnnotationInputSchema.parse(input)
    const existing = this.database.prepare('SELECT * FROM annotations WHERE id = ?').get(validated.id) as AnnotationRow | undefined
    if (!existing) throw new Error('批注不存在或已被删除。')
    const nextColor = validated.color ?? existing.color
    const nextNote = validated.note !== undefined ? validated.note.trim() : existing.note
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE annotations SET color = ?, note = ?, updated_at = ? WHERE id = ?
    `).run(nextColor, nextNote, now, existing.id)
    const row = this.database.prepare('SELECT * FROM annotations WHERE id = ?').get(existing.id) as AnnotationRow
    return toAnnotationRecord(row)
  }

  deleteAnnotation(annotationId: string): void {
    const id = annotationIdSchema.parse(annotationId)
    const result = this.database.prepare('DELETE FROM annotations WHERE id = ?').run(id)
    if (result.changes !== 1) throw new Error('批注不存在或已被删除。')
  }

  updateDocumentMeta(input: UpdateDocumentMetaInput): DocumentRecord {
    const validated = updateDocumentMetaInputSchema.parse(input)
    const existing = this.requireDocument(validated.documentId)
    const nextStarred = validated.starred ?? existing.starred
    let nextTags = existing.tags
    if (validated.tags !== undefined) {
      const deduped: string[] = []
      const seen = new Set<string>()
      for (const rawTag of validated.tags) {
        const clean = rawTag.trim()
        const key = clean.toLowerCase()
        if (!clean || seen.has(key)) continue
        seen.add(key)
        deduped.push(clean)
      }
      nextTags = deduped
    }
    let nextFolderId = existing.folderId
    if (validated.folderId !== undefined) {
      if (validated.folderId !== null && !this.getFolder(validated.folderId)) {
        throw new Error('目标分类文件夹不存在。')
      }
      nextFolderId = validated.folderId
    }
    const nextReadingStatus = validated.readingStatus ?? existing.readingStatus
    this.database
      .prepare('UPDATE documents SET starred = ?, tags_json = ?, folder_id = ?, reading_status = ? WHERE id = ?')
      .run(nextStarred ? 1 : 0, JSON.stringify(nextTags), nextFolderId, nextReadingStatus, existing.id)
    return toPublicDocument(this.requireDocument(existing.id))
  }

  private getFolderDepthMap(): Map<string, FolderRow> {
    const rows = this.database
      .prepare('SELECT * FROM folders ORDER BY created_at ASC, name ASC')
      .all() as FolderRow[]
    return new Map(rows.map(row => [row.id, row]))
  }

  private measureAncestorDepth(folderId: string | null, folderMap: Map<string, FolderRow>): number {
    let depth = 0
    let cursor: string | null = folderId
    const visited = new Set<string>()
    while (cursor) {
      if (visited.has(cursor)) {
        throw new Error('检测到分类文件夹循环层级。')
      }
      visited.add(cursor)
      const row = folderMap.get(cursor)
      if (!row) break
      depth += 1
      cursor = row.parent_id ?? null
    }
    return depth
  }

  private collectDescendantIds(rootId: string, folderMap: Map<string, FolderRow>): string[] {
    const childrenByParent = new Map<string, string[]>()
    for (const row of folderMap.values()) {
      if (!row.parent_id) continue
      const list = childrenByParent.get(row.parent_id)
      if (list) list.push(row.id)
      else childrenByParent.set(row.parent_id, [row.id])
    }
    const collected: string[] = [rootId]
    const queue: string[] = [rootId]
    const seen = new Set<string>([rootId])
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const childId of childrenByParent.get(current) ?? []) {
        if (seen.has(childId)) continue
        seen.add(childId)
        collected.push(childId)
        queue.push(childId)
      }
    }
    return collected
  }

  private measureSubtreeHeight(rootId: string, folderMap: Map<string, FolderRow>): number {
    const childrenByParent = new Map<string, string[]>()
    for (const row of folderMap.values()) {
      if (!row.parent_id) continue
      const list = childrenByParent.get(row.parent_id)
      if (list) list.push(row.id)
      else childrenByParent.set(row.parent_id, [row.id])
    }
    const visit = (id: string, depth: number, visited: Set<string>): number => {
      let maxDepth = depth
      for (const childId of childrenByParent.get(id) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        maxDepth = Math.max(maxDepth, visit(childId, depth + 1, visited))
      }
      return maxDepth
    }
    return visit(rootId, 1, new Set([rootId]))
  }

  listFolders(): LibraryFolder[] {
    const rows = this.database
      .prepare('SELECT * FROM folders ORDER BY created_at ASC, name ASC')
      .all() as FolderRow[]
    return rows.map(toLibraryFolder)
  }

  getFolder(id: string): LibraryFolder | null {
    const folderId = folderIdSchema.parse(id)
    const row = this.database.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow | undefined
    return row ? toLibraryFolder(row) : null
  }

  createFolder(input: CreateFolderInput): LibraryFolder {
    const validated = createFolderInputSchema.parse(input)
    const parentId = validated.parentId ?? null
    const folderMap = this.getFolderDepthMap()
    if (parentId !== null) {
      if (!folderMap.has(parentId)) {
        throw new Error('上级分类文件夹不存在。')
      }
      const parentDepth = this.measureAncestorDepth(parentId, folderMap)
      if (parentDepth + 1 > 4) {
        throw new Error('分类文件夹层级最多支持 4 级。')
      }
    }

    const now = new Date().toISOString()
    const id = randomUUID()
    const glossary = dedupeFolderGlossary(validated.glossary ?? [])
    this.database
      .prepare(`
        INSERT INTO folders (
          id, parent_id, name, faculty_id, context_summary, glossary_json, inherit_global_glossary, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        parentId,
        validated.name,
        validated.facultyId ?? '',
        validated.contextSummary ?? '',
        JSON.stringify(glossary),
        validated.inheritGlobalGlossary ? 1 : 0,
        now,
        now
      )
    const created = this.getFolder(id)
    if (!created) throw new Error('分类文件夹创建失败。')
    return created
  }

  updateFolder(input: UpdateFolderInput): LibraryFolder {
    const validated = updateFolderInputSchema.parse(input)
    const existing = this.getFolder(validated.id)
    if (!existing) throw new Error('分类文件夹不存在或已被删除。')

    const folderMap = this.getFolderDepthMap()
    let nextParentId = existing.parentId
    if (validated.parentId !== undefined && validated.parentId !== existing.parentId) {
      if (validated.parentId === existing.id) {
        throw new Error('分类文件夹不能设为自身的子分类。')
      }
      if (validated.parentId !== null) {
        if (!folderMap.has(validated.parentId)) {
          throw new Error('上级分类文件夹不存在。')
        }
        const descendants = new Set(this.collectDescendantIds(existing.id, folderMap))
        if (descendants.has(validated.parentId)) {
          throw new Error('不能将分类文件夹移动到其子分类下。')
        }
        const parentDepth = this.measureAncestorDepth(validated.parentId, folderMap)
        const subtreeHeight = this.measureSubtreeHeight(existing.id, folderMap)
        if (parentDepth + subtreeHeight > 4) {
          throw new Error('分类文件夹层级最多支持 4 级。')
        }
      }
      nextParentId = validated.parentId
    }

    const nextName = validated.name ?? existing.name
    const nextFacultyId = validated.facultyId ?? existing.facultyId
    const nextContext = validated.contextSummary ?? existing.contextSummary
    const nextGlossary =
      validated.glossary !== undefined ? dedupeFolderGlossary(validated.glossary) : existing.glossary
    const nextInherit =
      validated.inheritGlobalGlossary !== undefined
        ? validated.inheritGlobalGlossary
        : existing.inheritGlobalGlossary
    const now = new Date().toISOString()

    this.database
      .prepare(`
        UPDATE folders
        SET parent_id = ?, name = ?, faculty_id = ?, context_summary = ?, glossary_json = ?, inherit_global_glossary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        nextParentId,
        nextName,
        nextFacultyId,
        nextContext,
        JSON.stringify(nextGlossary),
        nextInherit ? 1 : 0,
        now,
        existing.id
      )
    const updated = this.getFolder(existing.id)
    if (!updated) throw new Error('分类文件夹更新失败。')
    return updated
  }

  deleteFolder(id: string): void {
    const folderId = folderIdSchema.parse(id)
    const existing = this.getFolder(folderId)
    if (!existing) throw new Error('分类文件夹不存在或已被删除。')

    const folderMap = this.getFolderDepthMap()
    const subtreeIds = this.collectDescendantIds(folderId, folderMap)

    this.database.transaction(() => {
      if (subtreeIds.length > 0) {
        const placeholders = subtreeIds.map(() => '?').join(', ')
        this.database
          .prepare(`UPDATE documents SET folder_id = NULL WHERE folder_id IN (${placeholders})`)
          .run(...subtreeIds)
      }
      this.database.prepare('DELETE FROM folders WHERE id = ?').run(folderId)
    })()
  }

  listReaderProgress(): Record<string, number> {
    const rows = this.database.prepare('SELECT document_id, page_number FROM reader_state').all() as Array<{
      document_id: string
      page_number: number
    }>
    const progress: Record<string, number> = {}
    for (const row of rows) {
      progress[row.document_id] = row.page_number
    }
    return progress
  }

  listAllReaderStates(): ReaderState[] {
    const rows = this.database.prepare('SELECT * FROM reader_state ORDER BY document_id').all() as ReaderStateRow[]
    return rows.map(row => ({
      documentId: row.document_id,
      pageNumber: row.page_number,
      scale: row.scale,
      updatedAt: row.updated_at
    }))
  }

  listAllAnnotations(): AnnotationRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM annotations ORDER BY document_id, page_number ASC, created_at ASC')
      .all() as AnnotationRow[]
    return rows.map(toAnnotationRecord)
  }

  listAllTranslationCache(): StoredTranslationCacheRow[] {
    const rows = this.database
      .prepare('SELECT * FROM translation_cache ORDER BY document_id, page_number ASC, block_id')
      .all() as Array<TranslationCacheRow & { document_id: string; page_number: number; target_language: string }>
    return rows.map(row => ({
      documentId: row.document_id,
      pageNumber: row.page_number,
      blockId: row.block_id,
      sourceHash: row.source_hash,
      targetLanguage: row.target_language,
      providerSignature: row.provider_signature,
      translatedText: row.translated_text,
      updatedAt: row.updated_at
    }))
  }

  importAnnotationIfMissing(input: {
    documentId: string
    pageNumber: number
    color: AnnotationColor
    quoteText: string
    note: string
    rects: AnnotationRect[]
    sentenceIds: string[]
    createdAt?: string
    updatedAt?: string
  }): boolean {
    const validated = createAnnotationInputSchema.parse({
      documentId: input.documentId,
      pageNumber: input.pageNumber,
      color: input.color,
      quoteText: input.quoteText,
      note: input.note,
      rects: input.rects,
      sentenceIds: input.sentenceIds
    })
    const document = this.requireDocument(validated.documentId)
    const note = (validated.note ?? '').trim()
    const existing = this.database
      .prepare(`
        SELECT id FROM annotations
        WHERE document_id = ? AND page_number = ? AND color = ? AND quote_text = ? AND note = ?
        LIMIT 1
      `)
      .get(document.id, validated.pageNumber, validated.color, validated.quoteText, note) as { id: string } | undefined
    if (existing) return false

    const now = new Date().toISOString()
    this.database
      .prepare(`
        INSERT INTO annotations (
          id, document_id, page_number, color, quote_text, note, rects_json, sentence_ids_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        document.id,
        validated.pageNumber,
        validated.color,
        validated.quoteText,
        note,
        JSON.stringify(validated.rects),
        JSON.stringify(validated.sentenceIds ?? []),
        input.createdAt || now,
        input.updatedAt || now
      )
    return true
  }

  searchLibrary(rawQuery: string): LibrarySearchHit[] {
    const query = librarySearchQuerySchema.parse(rawQuery)
    const pattern = `%${escapeLikePattern(query)}%`
    const hits: LibrarySearchHit[] = []

    const docRows = this.database
      .prepare(`
        SELECT id, display_title, original_filename, tags_json
        FROM documents
        WHERE display_title LIKE ? ESCAPE '\\'
           OR original_filename LIKE ? ESCAPE '\\'
           OR tags_json LIKE ? ESCAPE '\\'
        ORDER BY imported_at DESC
        LIMIT 15
      `)
      .all(pattern, pattern, pattern) as Array<{
      id: string
      display_title: string
      original_filename: string
      tags_json: string
    }>

    for (const row of docRows) {
      const tags = parseTagsJson(row.tags_json)
      const matchedTag = tags.find(t => t.toLowerCase().includes(query.toLowerCase()))
      const snippet = matchedTag ? `标签：#${matchedTag} · ${row.display_title}` : row.display_title
      hits.push({
        documentId: row.id,
        displayTitle: row.display_title,
        originalFilename: row.original_filename,
        source: 'document',
        pageNumber: null,
        snippet: buildSearchSnippet(snippet, query)
      })
    }

    const annRows = this.database
      .prepare(`
        SELECT a.document_id, d.display_title, d.original_filename, a.page_number, a.quote_text, a.note
        FROM annotations a
        JOIN documents d ON d.id = a.document_id
        WHERE a.quote_text LIKE ? ESCAPE '\\' OR a.note LIKE ? ESCAPE '\\'
        ORDER BY a.updated_at DESC
        LIMIT 15
      `)
      .all(pattern, pattern) as Array<{
      document_id: string
      display_title: string
      original_filename: string
      page_number: number
      quote_text: string
      note: string
    }>

    for (const row of annRows) {
      const matchedInNote = row.note.toLowerCase().includes(query.toLowerCase())
      const text = matchedInNote && row.note.trim() ? row.note : row.quote_text
      hits.push({
        documentId: row.document_id,
        displayTitle: row.display_title,
        originalFilename: row.original_filename,
        source: 'annotation',
        pageNumber: row.page_number,
        snippet: buildSearchSnippet(text, query)
      })
    }

    const transRows = this.database
      .prepare(`
        SELECT t.document_id, d.display_title, d.original_filename, t.page_number, t.translated_text
        FROM translation_cache t
        JOIN documents d ON d.id = t.document_id
        WHERE t.translated_text LIKE ? ESCAPE '\\'
        ORDER BY t.updated_at DESC
        LIMIT 15
      `)
      .all(pattern) as Array<{
      document_id: string
      display_title: string
      original_filename: string
      page_number: number
      translated_text: string
    }>

    for (const row of transRows) {
      hits.push({
        documentId: row.document_id,
        displayTitle: row.display_title,
        originalFilename: row.original_filename,
        source: 'translation',
        pageNumber: row.page_number,
        snippet: buildSearchSnippet(row.translated_text, query)
      })
    }

    return hits.slice(0, 40)
  }

  listChatMessages(sessionKey: string): AiChatMessageRecord[] {
    const validatedKey = chatSessionKeySchema.parse(sessionKey)
    const rows = this.database
      .prepare(`
        SELECT id, session_key, role, content, quote_text, context_summary, created_at
        FROM chat_messages
        WHERE session_key = ?
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(validatedKey) as Array<{
      id: string
      session_key: string
      role: AiChatRole
      content: string
      quote_text: string
      context_summary: string
      created_at: string
    }>
    return rows.map(row => ({
      id: row.id,
      sessionKey: row.session_key,
      role: row.role,
      content: row.content,
      quoteText: row.quote_text,
      contextSummary: row.context_summary,
      createdAt: row.created_at
    }))
  }

  appendChatMessage(input: {
    sessionKey: string
    role: AiChatRole
    content: string
    quoteText?: string
    contextSummary?: string
    createdAt?: string
  }): AiChatMessageRecord {
    const sessionKey = chatSessionKeySchema.parse(input.sessionKey)
    const record: AiChatMessageRecord = {
      id: randomUUID(),
      sessionKey,
      role: input.role,
      content: input.content,
      quoteText: input.quoteText ?? '',
      contextSummary: input.contextSummary ?? '',
      createdAt: input.createdAt ?? new Date().toISOString()
    }
    this.database
      .prepare(`
        INSERT INTO chat_messages (id, session_key, role, content, quote_text, context_summary, created_at)
        VALUES (@id, @sessionKey, @role, @content, @quoteText, @contextSummary, @createdAt)
      `)
      .run(record)
    return record
  }

  clearChatMessages(sessionKey: string): void {
    const validatedKey = chatSessionKeySchema.parse(sessionKey)
    this.database.prepare('DELETE FROM chat_messages WHERE session_key = ?').run(validatedKey)
  }

  /** 清空文献、分类文件夹、批注、译文缓存、AI 对话与阅读状态，保留 app_settings 中的翻译服务与科研配置。 */
  resetLibrary(): ResetLibraryResult {
    const tx = this.database.transaction((): ResetLibraryResult => {
      const docCountRow = this.database.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }
      const folderCountRow = this.database.prepare('SELECT COUNT(*) AS count FROM folders').get() as { count: number }
      this.database.prepare('DELETE FROM annotations').run()
      this.database.prepare('DELETE FROM translation_cache').run()
      this.database.prepare('DELETE FROM reader_state').run()
      this.database.prepare('DELETE FROM chat_messages').run()
      this.database.prepare('DELETE FROM documents').run()
      this.database.prepare('DELETE FROM folders').run()
      return {
        deletedDocuments: docCountRow.count,
        deletedFolders: folderCountRow.count
      }
    })
    return tx()
  }

  close(): void {
    if (this.database.open) this.database.close()
  }
}
