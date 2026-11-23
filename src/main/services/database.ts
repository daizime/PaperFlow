import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { DocumentRecord, ReaderState } from '../../shared/contracts'
import { displayTitleSchema, documentIdSchema, pageNumberSchema, readerStateSchema } from '../../shared/schemas'

export interface StoredDocumentRecord extends DocumentRecord {
  sha256: string
  storedFilename: string
}

const storedDocumentSchema = z.object({
  id: documentIdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  originalFilename: z.string().min(1).max(4096),
  displayTitle: z.string().min(1).max(4096),
  storedFilename: z.string().regex(/^[a-f0-9-]{36}\.pdf$/),
  byteSize: z.number().int().positive().max(100 * 1024 * 1024),
  pageCount: pageNumberSchema.nullable(),
  importedAt: z.iso.datetime()
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
}

interface ReaderStateRow {
  document_id: string
  page_number: number
  scale: number
  updated_at: string
}

function toStoredDocument(row: DocumentRow): StoredDocumentRecord {
  return {
    id: row.id, sha256: row.sha256, originalFilename: row.original_filename,
    displayTitle: row.display_title, storedFilename: row.stored_filename,
    byteSize: row.byte_size, pageCount: row.page_count, importedAt: row.imported_at
  }
}

function toPublicDocument(record: StoredDocumentRecord): DocumentRecord {
  return {
    id: record.id, originalFilename: record.originalFilename, displayTitle: record.displayTitle,
    byteSize: record.byteSize, pageCount: record.pageCount, importedAt: record.importedAt
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
    if (version > 1) throw new Error('文献数据库版本较新，请使用更新版本的 PaperFlow。')
    if (version === 1) return
    this.database.transaction(() => {
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
        PRAGMA user_version = 1;
      `)
    })()
  }

  listDocuments(): DocumentRecord[] {
    const rows = this.database.prepare('SELECT * FROM documents ORDER BY imported_at DESC, id').all() as DocumentRow[]
    return rows.map(row => toPublicDocument(toStoredDocument(row)))
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

  insertDocument(input: StoredDocumentRecord): DocumentRecord {
    const record = storedDocumentSchema.parse(input)
    if (record.storedFilename !== `${record.id}.pdf`) throw new Error('文献存储文件名无效。')
    this.database.prepare(`
      INSERT INTO documents (id, sha256, original_filename, display_title, stored_filename, byte_size, page_count, imported_at)
      VALUES (@id, @sha256, @originalFilename, @displayTitle, @storedFilename, @byteSize, @pageCount, @importedAt)
    `).run(record)
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

  close(): void {
    if (this.database.open) this.database.close()
  }
}
