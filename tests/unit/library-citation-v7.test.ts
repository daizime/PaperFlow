import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupService } from '../../src/main/services/backup-service'
import { LibraryDatabase } from '../../src/main/services/database'
import { DocumentService } from '../../src/main/services/document-service'
import { LiteratureSearchService } from '../../src/main/services/literature-search-service'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'paperflow-v7-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('轨道三：DB v6->v7 阅读状态迁移、OpenAlex 引用精准校对与分类批量导出 .bib', () => {
  it('从 user_version=6 老库无损升级至 7：默认 unread、支持状态流转与备份还原', async () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'legacy-v6.sqlite')
    const docId = randomUUID()
    const sha256 = 'd'.repeat(64)

    const legacy = new Database(dbPath)
    legacy.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        original_filename TEXT NOT NULL,
        display_title TEXT NOT NULL,
        stored_filename TEXT NOT NULL UNIQUE,
        byte_size INTEGER NOT NULL,
        page_count INTEGER,
        imported_at TEXT NOT NULL,
        starred INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]',
        folder_id TEXT
      );
      CREATE TABLE folders (
        id TEXT PRIMARY KEY NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        faculty_id TEXT NOT NULL DEFAULT '',
        context_summary TEXT NOT NULL DEFAULT '',
        glossary_json TEXT NOT NULL DEFAULT '[]',
        inherit_global_glossary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE reader_state (
        document_id TEXT PRIMARY KEY NOT NULL,
        page_number INTEGER NOT NULL,
        scale REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE translation_cache (
        document_id TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        block_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        target_language TEXT NOT NULL,
        provider_signature TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (document_id, page_number, block_id, target_language)
      );
      CREATE TABLE annotations (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        color TEXT NOT NULL,
        quote_text TEXT NOT NULL,
        note TEXT NOT NULL,
        rects_json TEXT NOT NULL,
        sentence_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        quote_text TEXT NOT NULL DEFAULT '',
        context_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      INSERT INTO documents (id, sha256, original_filename, display_title, stored_filename, byte_size, page_count, imported_at)
      VALUES ('${docId}', '${sha256}', 'legacy.pdf', 'Legacy Study 2025', '${docId}.pdf', 1024, 3, '2026-10-01T00:00:00.000Z');
      PRAGMA user_version = 6;
    `)
    legacy.close()

    const db = new LibraryDatabase(dbPath)
    const dirB = makeTempDir()
    const dbB = new LibraryDatabase(join(dirB, 'b.sqlite'))
    try {
      const inspect = new Database(dbPath, { readonly: true })
      try {
        expect(inspect.pragma('user_version', { simple: true })).toBe(7)
      } finally {
        inspect.close()
      }

      expect(db.getDocument(docId)?.readingStatus).toBe('unread')
      const updated = db.updateDocumentMeta({ documentId: docId, readingStatus: 'done' })
      expect(updated.readingStatus).toBe('done')

      // 备份还原也应保留 done 状态
      const docs = new DocumentService(db, join(dir, 'lib'), async () => 3)
      const { document: importedDoc } = await docs.importBuffer(
        'in-progress.pdf',
        Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF')
      )
      db.updateDocumentMeta({ documentId: importedDoc.id, readingStatus: 'reading' })

      const backupA = new BackupService(db, docs)
      // 为 legacy doc 提供真实 PDF 字节避免 exportBackupArchive 读盘缺文件
      db.deleteDocument(docId)
      const archive = await backupA.exportBackupArchive()

      const docsB = new DocumentService(dbB, join(dirB, 'libB'), async () => 3)
      const backupB = new BackupService(dbB, docsB)
      await backupB.importBackupArchive(archive.zipBuffer)

      const restoredDocs = dbB.listDocuments()
      expect(restoredDocs).toHaveLength(1)
      expect(restoredDocs[0].readingStatus).toBe('reading')
    } finally {
      db.close()
      dbB.close()
    }
  })

  it('LiteratureSearchService.enrichCitation 支持 DOI 精确校对、标题匹配及无关标题防误配', async () => {
    const dir = makeTempDir()
    const db = new LibraryDatabase(join(dir, 'lit.sqlite'))
    const docs = new DocumentService(db, join(dir, 'lib'), async () => 1)
    try {
      const lit = new LiteratureSearchService({
        database: db,
        documents: docs,
        openAlexBaseUrl: 'https://mock-openalex.example.invalid',
        fetchImpl: (async (url: string) => {
          if (url.includes('/works/https://doi.org/10.1145/3514221')) {
            return new Response(
              JSON.stringify({
                id: 'https://openalex.org/W1',
                title: 'ScaleStore: A Fast and Cost-Efficient Storage Engine',
                publication_year: 2022,
                doi: 'https://doi.org/10.1145/3514221',
                primary_location: { source: { display_name: 'Proceedings of the ACM on Management of Data' } },
                authorships: [
                  { author: { display_name: 'Tobias Ziegler' } },
                  { author: { display_name: 'Carsten Binnig' } }
                ]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          }
          if (url.includes('search=')) {
            return new Response(
              JSON.stringify({
                results: [
                  {
                    id: 'https://openalex.org/W2',
                    title: 'Attention Is All You Need',
                    publication_year: 2017,
                    doi: 'https://doi.org/10.5555/3295222.3295349',
                    primary_location: { source: { display_name: 'NeurIPS' } },
                    authorships: [{ author: { display_name: 'Ashish Vaswani' } }]
                  }
                ]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          }
          return new Response('{}', { status: 404 })
        }) as unknown as typeof fetch
      })

      const doiHit = await lit.enrichCitation({ doi: 'https://doi.org/10.1145/3514221' })
      expect(doiHit.matched).toBe(true)
      expect(doiHit.confidence).toBe('doi')
      expect(doiHit.citation).toEqual({
        title: 'ScaleStore: A Fast and Cost-Efficient Storage Engine',
        authors: ['Tobias Ziegler', 'Carsten Binnig'],
        year: '2022',
        venue: 'Proceedings of the ACM on Management of Data',
        doi: '10.1145/3514221'
      })

      const titleHit = await lit.enrichCitation({ title: 'Attention Is All You Need' })
      expect(titleHit.matched).toBe(true)
      expect(titleHit.confidence).toBe('title')
      expect(titleHit.citation?.authors).toEqual(['Ashish Vaswani'])

      // 无关标题即使 OpenAlex 返回候选也不得误匹配
      const mismatch = await lit.enrichCitation({ title: 'Completely Unrelated Electrochemistry Catalysts Survey' })
      expect(mismatch.matched).toBe(false)
      expect(mismatch.citation).toBeNull()
    } finally {
      db.close()
    }
  })

  it('BackupService.buildFolderBibtex 按子分类导出 .bib 并合入本地校对元数据与 citeKey 去重', async () => {
    const dir = makeTempDir()
    const db = new LibraryDatabase(join(dir, 'bib.sqlite'))
    const docs = new DocumentService(db, join(dir, 'lib'), async () => 2)
    try {
      const parentFolder = db.createFolder({ name: '系统架构' })
      const childFolder = db.createFolder({ parentId: parentFolder.id, name: '存储引擎' })
      const otherFolder = db.createFolder({ name: '其他领域' })

      const pdf1 = await docs.importBuffer('p1.pdf', Buffer.from('%PDF-1.4\n%p1\n'))
      const pdf2 = await docs.importBuffer('p2.pdf', Buffer.from('%PDF-1.4\n%p2\n'))
      const pdf3 = await docs.importBuffer('p3.pdf', Buffer.from('%PDF-1.4\n%p3\n'))

      db.renameDocument(pdf1.document.id, 'Fast Engine 2025')
      db.renameDocument(pdf2.document.id, 'Fast Engine 2025')
      db.updateDocumentMeta({ documentId: pdf1.document.id, folderId: parentFolder.id })
      db.updateDocumentMeta({ documentId: pdf2.document.id, folderId: childFolder.id })
      db.updateDocumentMeta({ documentId: pdf3.document.id, folderId: otherFolder.id })

      const backup = new BackupService(db, docs)
      const folderBib = backup.buildFolderBibtex({
        scope: 'folder',
        folderId: parentFolder.id,
        citationsByDocId: {
          [pdf1.document.id]: {
            title: 'Fast Engine 2025',
            authors: ['Alice Smith'],
            year: '2025',
            venue: 'SIGMOD',
            doi: '10.1145/1001',
            citeKey: 'smith2025fast'
          },
          [pdf2.document.id]: {
            title: 'Fast Engine 2025',
            authors: ['Alice Smith'],
            year: '2025',
            citeKey: 'smith2025fast'
          }
        }
      })

      expect(folderBib.count).toBe(2)
      expect(folderBib.defaultFilename).toBe('系统架构-引用.bib')
      expect(folderBib.bibtex).toMatch(/@inproceedings\{smith2025fast(?:_2)?,/)
      expect(folderBib.bibtex).toMatch(/@article\{smith2025fast(?:_2)?,/)
      expect(folderBib.bibtex).toContain('smith2025fast,')
      expect(folderBib.bibtex).toContain('smith2025fast_2,')
      expect(folderBib.bibtex).toContain('booktitle = {SIGMOD}')
      expect(folderBib.bibtex).toMatch(/doi\s*=\s*\{10\.1145\/1001\}/)

      const allBib = backup.buildFolderBibtex({ scope: 'all' })
      expect(allBib.count).toBe(3)
    } finally {
      db.close()
    }
  })
})
