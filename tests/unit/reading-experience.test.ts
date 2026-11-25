import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryDatabase } from '../../src/main/services/database'
import {
  extractReferenceTargets,
  findReferenceMatchInPages,
  type ReferencePageSource
} from '../../src/renderer/src/features/study/reference-peek'

const tempDirs: string[] = []
const openDbs: LibraryDatabase[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'paperflow-reading-unit-'))
  tempDirs.push(dir)
  return dir
}

function openTrackedDb(path: string): LibraryDatabase {
  const db = new LibraryDatabase(path)
  openDbs.push(db)
  return db
}

afterEach(() => {
  while (openDbs.length > 0) {
    try {
      openDbs.pop()!.close()
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Database v4 migration, document metadata, reader progress & cross-library search', () => {
  it('migrates v3 SQLite DB to v4 safely and supports starring, tags, progress, and cross-table search', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'paperflow-v3.sqlite')
    const docId = randomUUID()

    const legacy = new Database(dbPath)
    legacy.pragma('foreign_keys = ON')
    legacy.exec(`
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
      CREATE TABLE translation_cache (
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
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE annotations (
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
      PRAGMA user_version = 3;
    `)
    legacy
      .prepare(
        `INSERT INTO documents (id, sha256, original_filename, display_title, stored_filename, byte_size, page_count, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(docId, createHash('sha256').update('v3').digest('hex'), 'f-ivm.pdf', 'F-IVM Journal', `${docId}.pdf`, 4096, 27, new Date().toISOString())
    legacy.close()

    const db = openTrackedDb(dbPath)
    const docs = db.listDocuments()
    expect(docs).toHaveLength(1)
    expect(docs[0].starred).toBe(false)
    expect(docs[0].tags).toEqual([])

    const updated = db.updateDocumentMeta({
      documentId: docId,
      starred: true,
      tags: ['VLDB', 'vldb', '增量计算']
    })
    expect(updated.starred).toBe(true)
    expect(updated.tags).toEqual(['VLDB', '增量计算'])

    db.saveReaderState({
      documentId: docId,
      pageNumber: 9,
      scale: 1.5,
      updatedAt: new Date().toISOString()
    })
    expect(db.listReaderProgress()).toEqual({ [docId]: 9 })

    db.createAnnotation({
      documentId: docId,
      pageNumber: 5,
      color: 'yellow',
      quoteText: 'Factorized ring homomorphism',
      note: '关键收敛条件笔记_9527',
      rects: [{ x: 10, y: 20, width: 100, height: 12 }]
    })
    db.upsertPageTranslations(docId, 7, 'zh-CN', 'sig', [
      { blockId: 'b1', sourceHash: '0123456789abcdef', translatedText: '面向因式分解连接的增量视图维护_8848。' }
    ])

    const annHits = db.searchLibrary('9527')
    expect(annHits).toHaveLength(1)
    expect(annHits[0]).toMatchObject({ documentId: docId, source: 'annotation', pageNumber: 5 })

    const transHits = db.searchLibrary('8848')
    expect(transHits).toHaveLength(1)
    expect(transHits[0]).toMatchObject({ documentId: docId, source: 'translation', pageNumber: 7 })

    const tagHits = db.searchLibrary('增量计算')
    expect(tagHits.some(h => h.source === 'document' && h.documentId === docId)).toBe(true)

    // LIKE 通配符转义不应误匹配普通文本
    expect(db.searchLibrary('%_not_exist')).toEqual([])

    const inspect = new Database(dbPath, { readonly: true })
    try {
      expect(inspect.pragma('user_version', { simple: true })).toBe(4)
    } finally {
      inspect.close()
    }
  })
})

describe('Reference & Figure Peek parser and page matcher', () => {
  it('extracts Fig/Table/citation targets cleanly without duplicates', () => {
    const targets = extractReferenceTargets(
      'As shown in Fig. 1 and Table 2, modern readers (Smith et al., 2025) extend [3, 12] and Figure 1.'
    )
    expect(targets.map(t => `${t.kind}:${t.label}`)).toEqual([
      'figure:Fig. 1',
      'table:Table 2',
      'citation:[3]',
      'citation:[12]',
      'citation:Smith (2025)'
    ])
  })

  it('locates captions and bibliography entries across pages', () => {
    const pages = new Map<number, ReferencePageSource>([
      [
        1,
        {
          text: '1. Introduction\nAs shown in Fig. 1 and (Smith et al., 2025).\nFigure 1: Architecture of local PDF layout.',
          blocks: [
            { kind: 'paragraph', text: 'As shown in Fig. 1 and (Smith et al., 2025).' },
            { kind: 'caption', text: 'Figure 1: Architecture of local PDF layout.' }
          ]
        }
      ],
      [
        4,
        {
          text: 'References\n[12] Doe, J. Fast Layout Trees. VLDB 2024.\nSmith, A., Lee, B. (2025). Deterministic Academic Readers. SIGMOD.',
          blocks: []
        }
      ]
    ])

    const figHit = findReferenceMatchInPages(
      { kind: 'figure', label: 'Fig. 1', key: '1' },
      pages,
      1
    )
    expect(figHit).toMatchObject({
      pageNumber: 1,
      excerpt: 'Figure 1: Architecture of local PDF layout.'
    })

    const citeNumHit = findReferenceMatchInPages(
      { kind: 'citation', label: '[12]', key: '12' },
      pages,
      1
    )
    expect(citeNumHit).toMatchObject({
      pageNumber: 4
    })
    expect(citeNumHit?.excerpt).toContain('Doe, J. Fast Layout Trees')

    const citeAuthorHit = findReferenceMatchInPages(
      { kind: 'citation', label: 'Smith (2025)', key: 'Smith-2025', author: 'Smith', year: '2025' },
      pages,
      1
    )
    expect(citeAuthorHit).toMatchObject({
      pageNumber: 4
    })
    expect(citeAuthorHit?.excerpt).toContain('Deterministic Academic Readers')
  })
})
