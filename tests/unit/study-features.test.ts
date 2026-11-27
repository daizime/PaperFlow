import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatAnnotationsMarkdown } from '../../src/main/services/annotation-export'
import { LibraryDatabase } from '../../src/main/services/database'
import {
  buildAcademicPrompt,
  buildExplainPrompt,
  TranslationService,
  type SafeStorageAdapter
} from '../../src/main/services/translation-service'
import {
  createAnnotationInputSchema,
  explainSelectionInputSchema,
  glossaryEntrySchema,
  saveTranslationSettingsSchema,
  updateAnnotationInputSchema
} from '../../src/shared/schemas'

const tempDirs: string[] = []
const openDatabases: LibraryDatabase[] = []

function makeTempDir(prefix = 'paperflow-study-unit-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function openTrackedDb(path: string): LibraryDatabase {
  const db = new LibraryDatabase(path)
  openDatabases.push(db)
  return db
}

function makeFakeSafeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(`sealed:${text}`, 'utf8'),
    decryptString: buf => {
      const raw = buf.toString('utf8')
      return raw.startsWith('sealed:') ? raw.slice('sealed:'.length) : raw
    }
  }
}

function seedDoc(db: LibraryDatabase, docId = randomUUID(), title = 'Stage 2 & 3 Study Doc') {
  return db.insertDocument({
    id: docId,
    sha256: createHash('sha256').update(docId).digest('hex'),
    originalFilename: 'study-paper.pdf',
    displayTitle: title,
    storedFilename: `${docId}.pdf`,
    byteSize: 2048,
    pageCount: 4,
    importedAt: new Date().toISOString()
  })
}

afterEach(() => {
  while (openDatabases.length > 0) {
    try {
      openDatabases.pop()!.close()
    } catch {
      // ignore already closed
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Stage 2 & 3 schemas', () => {
  it('validates glossary entries, explain selection inputs, and annotation payloads', () => {
    expect(glossaryEntrySchema.parse({ source: '  F-IVM  ', target: ' 增量因式分解维护 ' })).toEqual({
      source: 'F-IVM',
      target: '增量因式分解维护'
    })
    expect(() => glossaryEntrySchema.parse({ source: 'bad\u0007', target: 'ok' })).toThrow()
    expect(() =>
      saveTranslationSettingsSchema.parse({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        glossary: Array.from({ length: 201 }, (_, i) => ({ source: `s${i}`, target: `t${i}` })),
        openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
        cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 60 }
      })
    ).toThrow()

    expect(
      explainSelectionInputSchema.parse({
        documentId: randomUUID(),
        pageNumber: 2,
        selectedText: 'ΔV(a,b) = Σ ΔR(a,b)\n⊗ S(b,c)',
        contextText: 'Incremental update equation.',
        mode: 'formula'
      }).mode
    ).toBe('formula')
    expect(() =>
      explainSelectionInputSchema.parse({
        documentId: randomUUID(),
        pageNumber: 1,
        selectedText: 'bad\u0000text',
        mode: 'explain'
      })
    ).toThrow()

    const docId = randomUUID()
    const annInput = createAnnotationInputSchema.parse({
      documentId: docId,
      pageNumber: 1,
      color: 'blue',
      quoteText: 'Sample quote',
      note: 'Line 1\nLine 2',
      rects: [{ x: 10, y: 20, width: 100, height: 14 }],
      sentenceIds: ['p1-s1']
    })
    expect(annInput.color).toBe('blue')
    expect(
      createAnnotationInputSchema.parse({
        ...annInput,
        note: 'AI 对话页面总结笔记',
        rects: []
      }).rects
    ).toEqual([])
    expect(() =>
      createAnnotationInputSchema.parse({
        ...annInput,
        note: '',
        rects: []
      })
    ).toThrow()

    const annId = randomUUID()
    expect(updateAnnotationInputSchema.parse({ id: annId, color: 'pink', note: 'Updated' }).color).toBe('pink')
  })
})

describe('Database v3 migration, annotations CRUD, and Markdown export', () => {
  it('migrates v2 SQLite database to v3 cleanly and supports annotation CRUD + CASCADE delete', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'paperflow-v2.sqlite')
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
      PRAGMA user_version = 2;
    `)
    legacy
      .prepare(
        `INSERT INTO documents (id, sha256, original_filename, display_title, stored_filename, byte_size, page_count, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(docId, 'b'.repeat(64), 'legacy.pdf', 'Legacy V2 Paper', `${docId}.pdf`, 1024, 3, new Date().toISOString())
    legacy
      .prepare(
        `INSERT INTO translation_cache (document_id, page_number, block_id, source_hash, target_language, provider_signature, translated_text, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(docId, 1, 'b1', 'hash1', 'zh-CN', 'sig1', '历史译文保留', new Date().toISOString())
    legacy.close()

    const db = openTrackedDb(dbPath)
    expect(db.getPageTranslations(docId, 1, 'zh-CN')).toHaveLength(1)

    const a1 = db.createAnnotation({
      documentId: docId,
      pageNumber: 2,
      color: 'yellow',
      quoteText: 'Second page key theorem.',
      note: '需要注意边界条件',
      rects: [{ x: 40, y: 100, width: 180, height: 14 }],
      sentenceIds: ['p2-s1']
    })
    const a2 = db.createAnnotation({
      documentId: docId,
      pageNumber: 1,
      color: 'blue',
      quoteText: 'First page abstract sentence.',
      rects: [{ x: 40, y: 300, width: 200, height: 14 }]
    })

    const listed = db.listAnnotations(docId)
    expect(listed.map(x => x.id)).toEqual([a2.id, a1.id])

    const updated = db.updateAnnotation({ id: a2.id, color: 'green', note: '补充笔记' })
    expect(updated.color).toBe('green')
    expect(updated.note).toBe('补充笔记')

    const md = formatAnnotationsMarkdown(
      { displayTitle: 'Legacy V2 Paper', originalFilename: 'legacy.pdf' },
      db.listAnnotations(docId)
    )
    expect(md).toContain('# Legacy V2 Paper — 阅读批注')
    expect(md).toContain('## 第 1 页')
    expect(md).toContain('> First page abstract sentence.')
    expect(md).toContain('补充笔记')
    expect(md).toContain('## 第 2 页')
    expect(md).toContain('### [黄色高亮]')

    db.deleteAnnotation(a2.id)
    expect(db.listAnnotations(docId)).toHaveLength(1)

    db.deleteDocument(docId)
    const inspect = new Database(dbPath, { readonly: true })
    try {
      expect(inspect.pragma('user_version', { simple: true })).toBe(7)
      expect(inspect.prepare('SELECT COUNT(*) AS cnt FROM annotations').get()).toEqual({ cnt: 0 })
    } finally {
      inspect.close()
    }
  })
})

describe('TranslationService glossary, streaming progress, and explainSelection', () => {
  it('persists glossary, injects it into prompts, emits per-batch progress, and explains formulas/text', async () => {
    const dir = makeTempDir()
    const db = openTrackedDb(join(dir, 'paperflow.sqlite'))
    const doc = seedDoc(db)
    const prompts: string[] = []

    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>
      }
      const userText = body.messages?.[body.messages.length - 1]?.content ?? ''
      prompts.push(userText)

      if (userText.includes('目标公式/表达式')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '公式解读：E 代表能量，m 为静止质量，c 为光速常数。' } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      const tail = userText.slice(userText.lastIndexOf('\n') + 1)
      const batch = JSON.parse(tail) as Array<{ id: string; text: string }>
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: batch.map(item => ({ id: item.id, text: `译：${item.text}` }))
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const service = new TranslationService({
      database: db,
      safeStorage: makeFakeSafeStorage(),
      fetchImpl
    })

    const saved = service.saveSettings({
      provider: 'openai-compatible',
      targetLanguage: 'zh-CN',
      glossary: [{ source: 'factorized join', target: '因式分解连接' }],
      openai: {
        baseUrl: 'http://127.0.0.1:41999/v1',
        model: 'mock-study',
        apiKey: 'sk-unit-123456'
      },
      cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 30 }
    })
    expect(saved.glossary).toEqual([{ source: 'factorized join', target: '因式分解连接' }])

    // 保存设置时不传 glossary 字段应保留现有术语表
    const kept = service.saveSettings({
      provider: 'openai-compatible',
      targetLanguage: 'zh-CN',
      openai: { baseUrl: 'http://127.0.0.1:41999/v1', model: 'mock-study' },
      cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 30 }
    })
    expect(kept.glossary).toEqual([{ source: 'factorized join', target: '因式分解连接' }])

    // 验证 prompt 注入且最后一行保持 JSON 数组格式
    const academicPrompt = buildAcademicPrompt(
      'zh-CN',
      [{ blockId: 'b1', kind: 'paragraph', sourceText: 'Using factorized join.', sourceHash: '0123456789abcdef' }],
      saved.glossary
    )
    expect(academicPrompt).toContain('- factorized join => 因式分解连接')
    expect(JSON.parse(academicPrompt.slice(academicPrompt.lastIndexOf('\n') + 1))).toHaveLength(1)

    const explainPrompt = buildExplainPrompt(
      { pageNumber: 1, selectedText: 'E = mc^2', contextText: 'Factorized join model.', mode: 'formula' },
      'zh-CN',
      saved.glossary
    )
    expect(explainPrompt).toContain('- factorized join => 因式分解连接')
    expect(explainPrompt).toContain('目标公式/表达式')

    const unifiedExplainPrompt = buildExplainPrompt(
      { pageNumber: 1, selectedText: 'Compute δS in O(1) time.', contextText: 'Factorized join model.', mode: 'explain' },
      'zh-CN',
      saved.glossary
    )
    expect(unifiedExplainPrompt).toContain('自动判断正文或公式')
    expect(unifiedExplainPrompt).toContain('逐项拆解关键变量、上下标与运算符')
    expect(unifiedExplainPrompt).toContain('技术方法、因果逻辑或关键术语含义')

    // 超过单批上限（2400 字）以触发多批渐进回调
    const blocks = Array.from({ length: 12 }, (_, idx) => {
      const sourceText = `Paragraph ${idx + 1} `.repeat(30).trim()
      return {
        blockId: `p1-b${idx + 1}`,
        kind: 'paragraph' as const,
        sourceText,
        sourceHash: createHash('sha256').update(sourceText).digest('hex').slice(0, 24)
      }
    })
    const progressEvents: Array<{ completedCount: number; totalCount: number }> = []
    const res = await service.translatePage(
      { documentId: doc.id, pageNumber: 1, blocks },
      evt => progressEvents.push({ completedCount: evt.completedCount, totalCount: evt.totalCount })
    )
    expect(res.items).toHaveLength(12)
    expect(progressEvents.length).toBeGreaterThanOrEqual(2)
    expect(progressEvents[progressEvents.length - 1]).toEqual({ completedCount: 12, totalCount: 12 })

    // OpenAI formula explain
    const formulaAns = await service.explainSelection({
      documentId: doc.id,
      pageNumber: 1,
      selectedText: 'E = mc^2',
      contextText: 'Relativity formula.',
      mode: 'formula'
    })
    expect(formulaAns.mode).toBe('formula')
    expect(formulaAns.answer).toContain('光速常数')
    expect(prompts.some(p => p.includes('- factorized join => 因式分解连接'))).toBe(true)

    // CLI explain stub
    const cliScript = join(dir, 'cli-explain-stub.mjs')
    writeFileSync(
      cliScript,
      `const chunks = []; process.stdin.on('data', c => chunks.push(c)); process.stdin.on('end', () => {
        const prompt = Buffer.concat(chunks).toString('utf8');
        process.stdout.write(prompt.includes('factorized join => 因式分解连接') ? 'CLI精读解答：术语已注入' : 'CLI缺失术语');
      });`,
      'utf8'
    )
    service.saveSettings({
      provider: 'cli',
      targetLanguage: 'zh-CN',
      openai: { baseUrl: 'http://127.0.0.1:41999/v1', model: 'mock-study' },
      cli: {
        preset: 'custom',
        command: process.execPath,
        model: '',
        extraArgs: [cliScript],
        timeoutSec: 30
      }
    })
    const cliAns = await service.explainSelection({
      documentId: doc.id,
      pageNumber: 1,
      selectedText: 'A factorized join decomposes queries.',
      mode: 'explain'
    })
    expect(cliAns.mode).toBe('explain')
    expect(cliAns.answer).toBe('CLI精读解答：术语已注入')
  })
})
