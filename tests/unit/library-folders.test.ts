import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupService } from '../../src/main/services/backup-service'
import { LibraryDatabase } from '../../src/main/services/database'
import { DocumentService } from '../../src/main/services/document-service'
import { resolveEffectiveTranslationScope } from '../../src/main/services/research-profile'
import { TranslationService, type SafeStorageAdapter } from '../../src/main/services/translation-service'
import { readZipBuffer } from '../../src/main/services/zip-archive'

async function validatePdf(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false })
  return document.getPageCount()
}

const fakeSafeStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(`ENC:${plain}`, 'utf8'),
  decryptString: buf => buf.toString('utf8').replace(/^ENC:/, '')
}

function seedDocument(db: LibraryDatabase, title: string, folderId: string | null = null): string {
  const id = randomUUID()
  return db.insertDocument({
    id,
    sha256: createHash('sha256').update(`${id}-${title}`).digest('hex'),
    originalFilename: `${title}.pdf`,
    displayTitle: title,
    storedFilename: `${id}.pdf`,
    byteSize: 2048,
    pageCount: 2,
    importedAt: new Date().toISOString(),
    folderId
  }).id
}

describe('Zotero 分类文件夹数据库迁移、层级 CRUD 与跨学科词库隔离', () => {
  let root: string
  let dbPath: string
  let db: LibraryDatabase

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'paperflow-folders-unit-'))
    dbPath = join(root, 'paperflow.sqlite')
  })

  afterEach(async () => {
    db?.close()
    await rm(root, { recursive: true, force: true })
  })

  it('从 user_version=4 老库无损升级到 5：创建 folders 表、保留原文献并支持层级上限与安全删除', () => {
    const legacy = new Database(dbPath)
    const docId = randomUUID()
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
        tags_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE reader_state (
        document_id TEXT PRIMARY KEY NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        scale REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE translation_cache (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
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
        page_number INTEGER NOT NULL,
        color TEXT NOT NULL,
        quote_text TEXT NOT NULL,
        note TEXT NOT NULL,
        rects_json TEXT NOT NULL,
        sentence_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 4;
    `)
    legacy
      .prepare(
        `INSERT INTO documents (id, sha256, original_filename, display_title, stored_filename, byte_size, page_count, imported_at)
         VALUES (?, ?, 'legacy-v4.pdf', 'Legacy V4', ?, 1024, 5, ?)`
      )
      .run(docId, 'c'.repeat(64), `${docId}.pdf`, '2026-11-20T00:00:00.000Z')
    legacy.close()

    db = new LibraryDatabase(dbPath)
    const inspect = new Database(dbPath, { readonly: true })
    try {
      expect(inspect.pragma('user_version', { simple: true })).toBe(7)
    } finally {
      inspect.close()
    }

    expect(db.getDocument(docId)?.folderId).toBeNull()

    // 创建 4 级目录；第 5 级应被拒绝；循环移动应被拒绝
    const l1 = db.createFolder({ name: 'L1' })
    const l2 = db.createFolder({ parentId: l1.id, name: 'L2' })
    const l3 = db.createFolder({ parentId: l2.id, name: 'L3' })
    const l4 = db.createFolder({ parentId: l3.id, name: 'L4' })
    expect(() => db.createFolder({ parentId: l4.id, name: 'L5' })).toThrow(/4 级/)
    expect(() => db.updateFolder({ id: l1.id, parentId: l3.id })).toThrow(/子分类/)

    // 将文献移入 L2，然后删除 L1：子分类级联移除，但文献安全保留并回归「未分类」(folderId=null)
    db.updateDocumentMeta({ documentId: docId, folderId: l2.id })
    expect(db.getDocument(docId)?.folderId).toBe(l2.id)

    db.deleteFolder(l1.id)
    expect(db.listFolders()).toEqual([])
    const preserved = db.getDocument(docId)
    expect(preserved).not.toBeNull()
    expect(preserved?.folderId).toBeNull()
  })

  it('TranslationService 与 resolveEffectiveTranslationScope：不同文件夹彻底隔离同名多义词，子分类覆盖父分类', async () => {
    db = new LibraryDatabase(dbPath)
    const capturedPrompts: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>
      }
      const userText = payload.messages?.[payload.messages.length - 1]?.content ?? ''
      capturedPrompts.push(userText)
      const tail = userText.slice(userText.lastIndexOf('\n') + 1)
      if (tail.startsWith('[')) {
        const blocks = JSON.parse(tail) as Array<{ id: string; text: string }>
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    translations: blocks.map(b => ({ id: b.id, text: `译文:${b.text}` }))
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '解读完成' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const svc = new TranslationService({ database: db, safeStorage: fakeSafeStorage, fetchImpl })
    svc.saveSettings({
      provider: 'openai-compatible',
      targetLanguage: 'zh-CN',
      glossary: [{ source: 'vector', target: '全局向量' }],
      openai: { baseUrl: 'http://127.0.0.1:42000/v1', model: 'mock', apiKey: 'sk-test' },
      cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 30 }
    })

    const chemFolder = db.createFolder({
      name: '电催化与新能源',
      facultyId: 'chem-mat',
      contextSummary: '化材催化电极与激光制备',
      glossary: [
        { source: 'ablation', target: '激光烧蚀' },
        { source: 'overpotential', target: '过电位' }
      ],
      inheritGlobalGlossary: false
    })
    const bioParent = db.createFolder({
      name: '神经科学与临床',
      facultyId: 'bio-med',
      contextSummary: '神经环路与手术消融',
      glossary: [
        { source: 'ablation', target: '病灶消融术' },
        { source: 'vector', target: '病毒载体' }
      ],
      inheritGlobalGlossary: false
    })
    const bioChild = db.createFolder({
      parentId: bioParent.id,
      name: 'AAV 基因治疗子课题',
      facultyId: 'bio-med',
      contextSummary: '腺相关病毒载体递送',
      glossary: [{ source: 'vector', target: 'AAV 病毒载体' }],
      inheritGlobalGlossary: false
    })

    const chemDocId = seedDocument(db, 'chem-ablation', chemFolder.id)
    const bioChildDocId = seedDocument(db, 'bio-vector', bioChild.id)
    const unassignedDocId = seedDocument(db, 'general-doc', null)

    // 1. 化学文件夹论文：命中「激光烧蚀」，隔离医学词与全局词
    await svc.translatePage({
      documentId: chemDocId,
      pageNumber: 1,
      blocks: [{ blockId: 'b1', kind: 'paragraph', sourceText: 'Laser ablation lowers overpotential.', sourceHash: '0123456789abcdef' }]
    })
    expect(capturedPrompts[0]).toContain('激光烧蚀')
    expect(capturedPrompts[0]).not.toContain('病灶消融术')
    expect(capturedPrompts[0]).not.toContain('全局向量')

    // 2. 生医子文件夹论文：子分类覆盖父分类的 vector => AAV 病毒载体，并继承父分类 ablation => 病灶消融术
    await svc.translatePage({
      documentId: bioChildDocId,
      pageNumber: 1,
      blocks: [{ blockId: 'b1', kind: 'paragraph', sourceText: 'Following ablation, deliver vector.', sourceHash: 'fedcba9876543210' }]
    })
    expect(capturedPrompts[1]).toContain('- vector => AAV 病毒载体')
    expect(capturedPrompts[1]).toContain('- ablation => 病灶消融术')
    expect(capturedPrompts[1]).not.toContain('激光烧蚀')
    expect(capturedPrompts[1]).not.toContain('全局向量')

    // 3. 选区解读同样遵循文件夹作用域
    await svc.explainSelection({
      documentId: bioChildDocId,
      pageNumber: 1,
      selectedText: 'vector',
      mode: 'explain'
    })
    expect(capturedPrompts[2]).toContain('- vector => AAV 病毒载体')

    // 4. 未分类文献回退全局词库
    const unassignedScope = resolveEffectiveTranslationScope(db, unassignedDocId, [
      { source: 'vector', target: '全局向量' }
    ])
    expect(unassignedScope.folder).toBeNull()
    expect(unassignedScope.glossary).toEqual([{ source: 'vector', target: '全局向量' }])
  })

  it('BackupService 导出并恢复嵌套分类文件夹、专属词库与文献归属，并兼容旧版备份', async () => {
    db = new LibraryDatabase(dbPath)
    const dbTarget = new LibraryDatabase(join(root, 'target.sqlite'))
    try {
      const docSvcA = new DocumentService(db, join(root, 'lib-a'), validatePdf)
      const docSvcB = new DocumentService(dbTarget, join(root, 'lib-b'), validatePdf)
      const backupA = new BackupService(db, docSvcA)
      const backupB = new BackupService(dbTarget, docSvcB)

      const pdfDoc = await PDFDocument.create()
      pdfDoc.addPage()
      const pdfBytes = new Uint8Array(await pdfDoc.save())
      const imported = await docSvcA.importBuffer('catalysis.pdf', pdfBytes)

      const parentFolder = db.createFolder({
        name: '化学与材料',
        facultyId: 'chem-mat',
        glossary: [{ source: 'ablation', target: '激光烧蚀' }]
      })
      const childFolder = db.createFolder({
        parentId: parentFolder.id,
        name: '电催化析氢',
        facultyId: 'chem-mat',
        glossary: [{ source: 'overpotential', target: '过电位' }],
        inheritGlobalGlossary: true
      })
      db.updateDocumentMeta({ documentId: imported.document.id, folderId: childFolder.id })

      const exported = await backupA.exportBackupArchive()
      const zipEntries = readZipBuffer(exported.zipBuffer)
      expect(zipEntries.has('pdfs/化学与材料/电催化析氢/catalysis.pdf')).toBe(true)
      expect(zipEntries.get('library.bib')?.toString('utf8')).toContain(
        'file      = {pdfs/化学与材料/电催化析氢/catalysis.pdf}'
      )

      await backupB.importBackupArchive(exported.zipBuffer)

      const restoredFolders = dbTarget.listFolders()
      expect(restoredFolders).toHaveLength(2)
      const restoredParent = restoredFolders.find(f => f.name === '化学与材料')!
      const restoredChild = restoredFolders.find(f => f.name === '电催化析氢')!
      expect(restoredParent.parentId).toBeNull()
      expect(restoredChild.parentId).toBe(restoredParent.id)
      expect(restoredChild.inheritGlobalGlossary).toBe(true)
      expect(restoredChild.glossary).toEqual([{ source: 'overpotential', target: '过电位' }])

      const restoredDocs = dbTarget.listDocuments()
      expect(restoredDocs).toHaveLength(1)
      expect(restoredDocs[0].folderId).toBe(restoredChild.id)
    } finally {
      dbTarget.close()
    }
  })

  it('exportFoldersToDirectory 按真实层级目录导出本地 PDF、清洗 Windows 非法字符且不覆盖已有同名文件', async () => {
    db = new LibraryDatabase(dbPath)
    const docSvc = new DocumentService(db, join(root, 'lib-disk-export'), validatePdf)
    const backup = new BackupService(db, docSvc)

    const pdfA = await PDFDocument.create()
    pdfA.addPage()
    const bytesA = new Uint8Array(await pdfA.save())
    const pdfB = await PDFDocument.create()
    pdfB.addPage()
    pdfB.addPage()
    const bytesB = new Uint8Array(await pdfB.save())

    const doc1 = await docSvc.importBuffer('paper.pdf', bytesA)
    await docSvc.importBuffer('unclassified.pdf', bytesB)

    const parent = db.createFolder({ name: 'A:B/C*D 催化专题' })
    const child = db.createFolder({ parentId: parent.id, name: 'CON' })
    db.updateDocumentMeta({ documentId: doc1.document.id, folderId: child.id })

    // 1. 全库按分类导出
    const outAllRoot = join(root, 'export-all')
    const resAll = await backup.exportFoldersToDirectory(outAllRoot, { scope: 'all' })
    expect(resAll.exportedCount).toBe(2)
    expect(resAll.folderCount).toBe(3)
    const diskPaper1 = await readFile(join(resAll.targetDir, 'A_B_C_D 催化专题', '_CON', 'paper.pdf'))
    expect(new Uint8Array(diskPaper1)).toEqual(bytesA)
    const diskUnassigned = await readFile(join(resAll.targetDir, '未分类', 'unclassified.pdf'))
    expect(new Uint8Array(diskUnassigned)).toEqual(bytesB)

    // 2. 导出单分类子树；预先写入同名 paper.pdf 验证不会覆盖目标目录已有文件
    const outSingleRoot = join(root, 'export-single')
    const resFirst = await backup.exportFoldersToDirectory(outSingleRoot, {
      scope: 'folder',
      folderId: parent.id
    })
    expect(resFirst.exportedCount).toBe(1)
    expect(resFirst.folderCount).toBe(2)
    const subDir = join(resFirst.targetDir, '_CON')
    await writeFile(join(subDir, 'existing-sentinel.txt'), 'keep')

    // 再次导出同一目录，应自动避让生成 paper-2.pdf 而不覆盖已有 paper.pdf
    const resSecond = await backup.exportFoldersToDirectory(outSingleRoot, {
      scope: 'folder',
      folderId: parent.id
    })
    expect(resSecond.exportedCount).toBe(1)
    const secondBytes = await readFile(join(subDir, 'paper-2.pdf'))
    expect(new Uint8Array(secondBytes)).toEqual(bytesA)

    // 3. 仅导出未分类
    const outUnassigned = join(root, 'export-unassigned')
    const resUnassigned = await backup.exportFoldersToDirectory(outUnassigned, { scope: 'unassigned' })
    expect(resUnassigned.exportedCount).toBe(1)
    expect(resUnassigned.exportedNotesCount).toBe(0)
    expect(new Uint8Array(await readFile(join(resUnassigned.targetDir, 'unclassified.pdf')))).toEqual(bytesB)

    // 4. 开启 includeAnnotations 时为有批注的文献导出同目录 -批注.md，且不覆盖预存同名 .md
    db.createAnnotation({
      documentId: doc1.document.id,
      pageNumber: 1,
      color: 'yellow',
      quoteText: 'Overpotential decreases significantly.',
      note: '关键过电位结论',
      rects: [{ x: 10, y: 20, width: 100, height: 12 }],
      sentenceIds: ['s1']
    })
    const outWithNotes = join(root, 'export-with-notes')
    const resNotes1 = await backup.exportFoldersToDirectory(outWithNotes, {
      scope: 'folder',
      folderId: parent.id,
      includeAnnotations: true
    })
    expect(resNotes1.exportedNotesCount).toBe(1)
    const noteContent = await readFile(join(resNotes1.targetDir, '_CON', 'paper-批注.md'), 'utf8')
    expect(noteContent).toContain('关键过电位结论')

    // 预写入保护文件，再导出同名文献时不覆盖已有文件
    await writeFile(join(resNotes1.targetDir, '_CON', 'paper-2-批注.md'), 'existing-note-sentinel', 'utf8')
    const resNotes2 = await backup.exportFoldersToDirectory(outWithNotes, {
      scope: 'folder',
      folderId: parent.id,
      includeAnnotations: true
    })
    expect(resNotes2.exportedNotesCount).toBe(1)
    expect(await readFile(join(resNotes1.targetDir, '_CON', 'paper-2-批注.md'), 'utf8')).toBe('existing-note-sentinel')
    expect(await readFile(join(resNotes1.targetDir, '_CON', 'paper-2-批注 (2).md'), 'utf8')).toContain('关键过电位结论')
  })

  it('importFolderFromDirectory 按层级建分类、扁平合并超深目录、跳过隐藏/损坏项并去重', async () => {
    db = new LibraryDatabase(dbPath)
    const docSvc = new DocumentService(db, join(root, 'lib-dir-import'), validatePdf)
    const backup = new BackupService(db, docSvc)

    const pdfA = await PDFDocument.create()
    pdfA.addPage()
    const bytesA = new Uint8Array(await pdfA.save())
    const pdfB = await PDFDocument.create()
    pdfB.addPage()
    pdfB.addPage()
    const bytesB = new Uint8Array(await pdfB.save())

    // 先导入一份 bytesA 到人工分类，验证去重不覆写已有明确归属
    const existingFolder = db.createFolder({ name: '已有专题' })
    const existingImport = await docSvc.importBuffer('existing-a.pdf', bytesA)
    db.updateDocumentMeta({ documentId: existingImport.document.id, folderId: existingFolder.id })

    // 构造 5 级目录 + 隐藏目录 + 损坏 PDF
    const srcRoot = join(root, 'MyPapers')
    await mkdir(join(srcRoot, 'L2', 'L3', 'L4', 'L5-too-deep'), { recursive: true })
    await mkdir(join(srcRoot, '.git'), { recursive: true })
    await writeFile(join(srcRoot, 'root-copy.pdf'), bytesA)
    await writeFile(join(srcRoot, 'L2', 'L3', 'L4', 'L5-too-deep', 'deep-paper.pdf'), bytesB)
    await writeFile(join(srcRoot, 'L2', 'broken.pdf'), Buffer.from('not-a-pdf'))
    await writeFile(join(srcRoot, '.git', 'hidden.pdf'), bytesB)

    const summary = await backup.importFolderFromDirectory(srcRoot)
    expect(summary.importedCount).toBe(1)
    expect(summary.duplicateCount).toBe(1)
    expect(summary.skippedCount).toBe(1)
    // MyPapers (1) -> L2 (2) -> L3 (3) -> L4 (4)；L5-too-deep 被扁平合并进 L4
    expect(summary.createdFolderCount).toBe(4)

    const folders = db.listFolders()
    expect(folders.some(f => f.name === 'L5-too-deep')).toBe(false)
    const l4 = folders.find(f => f.name === 'L4')!
    const deepDoc = db.listDocuments().find(d => d.originalFilename === 'deep-paper.pdf')!
    expect(deepDoc.folderId).toBe(l4.id)
    const keptExisting = db.getDocument(existingImport.document.id)!
    expect(keptExisting.folderId).toBe(existingFolder.id)
  })

  it('词库指纹变化会触发译文缓存失效并准确返回当前作用域摘要', async () => {
    db = new LibraryDatabase(dbPath)
    let modelCalls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      modelCalls += 1
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>
      }
      const userText = payload.messages?.[payload.messages.length - 1]?.content ?? ''
      const arrStart = userText.lastIndexOf('[')
      const blocks = JSON.parse(userText.slice(arrStart)) as Array<{ id: string; text: string }>
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: blocks.map(b => ({ id: b.id, text: `第 ${modelCalls} 版译文` }))
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    const svc = new TranslationService({ database: db, safeStorage: fakeSafeStorage, fetchImpl })
    svc.saveSettings({
      provider: 'openai-compatible',
      targetLanguage: 'zh-CN',
      glossary: [],
      openai: { baseUrl: 'http://127.0.0.1:42000/v1', model: 'mock', apiKey: 'sk-test' },
      cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 30 }
    })

    const folder = db.createFolder({
      name: '作用域指纹测试',
      glossary: [{ source: 'catalysis', target: '催化' }],
      inheritGlobalGlossary: false
    })
    const docId = seedDocument(db, 'scope-doc', folder.id)

    const scope1 = svc.getDocumentTranslationScope(docId)
    expect(scope1.folderName).toBe('作用域指纹测试')
    expect(scope1.effectiveGlossaryCount).toBe(1)

    await svc.translatePage({
      documentId: docId,
      pageNumber: 1,
      blocks: [{ blockId: 'b1', kind: 'paragraph', sourceText: 'Catalysis matters.', sourceHash: '0123456789abcdef' }]
    })
    expect(modelCalls).toBe(1)

    // 未改词库：直接命中缓存，不调用模型
    const hit = await svc.translatePage({
      documentId: docId,
      pageNumber: 1,
      blocks: [{ blockId: 'b1', kind: 'paragraph', sourceText: 'Catalysis matters.', sourceHash: '0123456789abcdef' }]
    })
    expect(hit.fromCacheCount).toBe(1)
    expect(modelCalls).toBe(1)

    // 修改文件夹术语后：作用域指纹变化，下次 translatePage 自动重译
    db.updateFolder({
      id: folder.id,
      glossary: [
        { source: 'catalysis', target: '催化' },
        { source: 'overpotential', target: '过电位' }
      ]
    })
    const scope2 = svc.getDocumentTranslationScope(docId)
    expect(scope2.scopeFingerprint).not.toBe(scope1.scopeFingerprint)
    expect(scope2.effectiveGlossaryCount).toBe(2)

    const refreshed = await svc.translatePage({
      documentId: docId,
      pageNumber: 1,
      blocks: [{ blockId: 'b1', kind: 'paragraph', sourceText: 'Catalysis matters.', sourceHash: '0123456789abcdef' }]
    })
    expect(refreshed.translatedCount).toBe(1)
    expect(modelCalls).toBe(2)
  })

  it('DocumentService.resetLibrary 清空文献、分类、批注与磁盘 PDF，保留 app_settings 翻译设置', async () => {
    db = new LibraryDatabase(dbPath)
    const libDir = join(root, 'lib-reset-unit')
    const docSvc = new DocumentService(db, libDir, validatePdf)

    const pdf = await PDFDocument.create()
    pdf.addPage()
    const bytes = new Uint8Array(await pdf.save())
    const imported = await docSvc.importBuffer('reset-me.pdf', bytes)
    const folder = db.createFolder({ name: '待重置分类' })
    db.updateDocumentMeta({ documentId: imported.document.id, folderId: folder.id })
    db.createAnnotation({
      documentId: imported.document.id,
      pageNumber: 1,
      color: 'yellow',
      quoteText: 'Sample quote',
      note: 'Sample note',
      rects: [{ x: 10, y: 10, width: 50, height: 10 }],
      sentenceIds: ['s1']
    })
    db.setSetting('translation.config.v1', JSON.stringify({ provider: 'openai-compatible' }))

    const result = await docSvc.resetLibrary()
    expect(result).toEqual({ deletedDocuments: 1, deletedFolders: 1 })
    expect(db.listDocuments()).toEqual([])
    expect(db.listFolders()).toEqual([])
    expect(() => db.listAnnotations(imported.document.id)).toThrow('文献不存在')
    expect((await readdir(libDir)).filter(f => f.endsWith('.pdf'))).toEqual([])
    expect(db.getSetting('translation.config.v1')).toContain('openai-compatible')
  })
})
