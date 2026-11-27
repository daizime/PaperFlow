import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupService, type BackupManifest } from '../../src/main/services/backup-service'
import { LibraryDatabase } from '../../src/main/services/database'
import { DocumentService } from '../../src/main/services/document-service'
import { assertZipInputLimits, createZipBuffer, readZipBuffer, ZIP_ARCHIVE_LIMITS } from '../../src/main/services/zip-archive'

describe('备份 ZIP 额度由 writer、reader 与预检共用', () => {
  it('空 ZIP 与 STORE / DEFLATE / 中文路径均可在同一限制下往返', () => {
    expect(readZipBuffer(createZipBuffer([]), { maxArchiveBytes: 22, maxEntries: 0, maxEntryBytes: 0, maxTotalBytes: 0 }).size).toBe(0)
    const entries = [
      { name: '原件/合成.pdf', data: Buffer.from('synthetic store'), compress: false },
      { name: 'notes/合成.md', data: Buffer.alloc(1000, 97) }
    ]
    const options = { maxArchiveBytes: 1024, maxEntries: 2, maxEntryBytes: 1000, maxTotalBytes: 1015 }
    const restored = readZipBuffer(createZipBuffer(entries, options), options)
    for (const entry of entries) expect(restored.get(entry.name)).toEqual(entry.data)
  })

  it('允许 5000 条目边界，5001 条目在接触任何载荷前失败', () => {
    const accepted = Array.from({ length: 5000 }, (_, index) => ({ name: 'synthetic-' + index, data: Buffer.alloc(0) }))
    expect(readZipBuffer(createZipBuffer(accepted)).size).toBe(5000)
    const rejected = Array.from({ length: 5001 }, (_, index) => ({
      name: 'synthetic-' + index,
      get data(): Uint8Array { throw new Error('不应读取超限计划的载荷') }
    }))
    expect(() => createZipBuffer(rejected)).toThrow('超过 5000 项')
  })

  it('使用元数据验证 512 MiB 边界，不分配大型载荷，选项不能放宽安全限制', () => {
    const headerBytes = 22 + 76 + 2 * Buffer.byteLength('a')
    const plan = [{ name: 'a', byteLength: ZIP_ARCHIVE_LIMITS.maxArchiveBytes - headerBytes, compress: false }]
    expect(() => assertZipInputLimits(plan)).not.toThrow()
    const oversized = [{ ...plan[0], byteLength: plan[0].byteLength + 1 }]
    expect(() => assertZipInputLimits(oversized)).toThrow('512 MiB')
    expect(() => assertZipInputLimits(oversized, { maxArchiveBytes: 2 * ZIP_ARCHIVE_LIMITS.maxArchiveBytes })).toThrow('512 MiB')
    expect(() => assertZipInputLimits([{ name: 'huge', byteLength: ZIP_ARCHIVE_LIMITS.maxEntryBytes + 1 }])).toThrow('单个条目')
  })

  it('实际 writer 和 reader 同时拒绝归档大小、单条与总解包超限', () => {
    const entries = [{ name: 'a', data: Buffer.alloc(80, 97) }, { name: 'b', data: Buffer.alloc(80, 98) }]
    const zip = createZipBuffer(entries)
    expect(() => createZipBuffer(entries, { maxArchiveBytes: zip.length - 1 })).toThrow('体积超出')
    expect(() => readZipBuffer(zip, { maxArchiveBytes: zip.length - 1 })).toThrow('体积超出')
    expect(() => createZipBuffer(entries, { maxEntryBytes: 79 })).toThrow('单个条目')
    expect(() => readZipBuffer(zip, { maxEntryBytes: 79 })).toThrow('单个条目')
    expect(() => createZipBuffer(entries, { maxTotalBytes: 159 })).toThrow('解压后体积')
    expect(() => readZipBuffer(zip, { maxTotalBytes: 159 })).toThrow('解压后体积')
  })

  it('压缩不能绕过总解包额度，也不会为超额输出保留大型缓冲区', () => {
    const compressible = [{ name: 'synthetic', data: Buffer.alloc(8192, 97) }]
    const zip = createZipBuffer(compressible)
    expect(zip.byteLength).toBeLessThan(512)
    expect(() => createZipBuffer(compressible, { maxTotalBytes: 1024 })).toThrow('解压后体积')
    expect(() => readZipBuffer(zip, { maxTotalBytes: 1024 })).toThrow('解压后体积')
    expect(() => createZipBuffer(compressible, { maxArchiveBytes: zip.length - 1 })).toThrow('体积超出')
    const incompressible = [{ name: 'bytes', data: Buffer.from(Array.from({ length: 256 }, (_, index) => index)) }]
    const stored = createZipBuffer(incompressible)
    expect(readZipBuffer(createZipBuffer(incompressible, { maxArchiveBytes: stored.length })).get('bytes')).toEqual(incompressible[0].data)
  })

  it('在解压任何文件前核对所有条目额度', () => {
    const zip = createZipBuffer([
      { name: 'first', data: Buffer.alloc(80, 97), compress: false },
      { name: 'second', data: Buffer.alloc(80, 98), compress: false }
    ])
    // 第一条 CRC 故意损坏；仍应先发现全目录的总额超限。
    zip[30 + Buffer.byteLength('first')] ^= 1
    expect(() => readZipBuffer(zip, { maxTotalBytes: 159 })).toThrow('解压后体积')
    expect(() => readZipBuffer(zip)).toThrow('CRC')
  })

  it('拒绝重复名称和非法选项，并保留正常标准 ZIP 的读取', () => {
    expect(() => createZipBuffer([{ name: 'a', data: Buffer.alloc(0) }, { name: 'a', data: Buffer.alloc(0) }])).toThrow('重复条目')
    expect(() => createZipBuffer([], { maxEntries: Infinity })).toThrow('非负整数')
    expect(() => readZipBuffer(createZipBuffer([]), { maxTotalBytes: -1 })).toThrow('非负整数')
    const zip = createZipBuffer([{ name: 'legacy.txt', data: Buffer.from('compatible PKZIP payload') }])
    expect(readZipBuffer(zip).get('legacy.txt')?.toString()).toBe('compatible PKZIP payload')
  })
})

describe('合成文献的备份往返、旧包兼容和恢复幂等', () => {
  let root: string
  let source: LibraryDatabase
  let target: LibraryDatabase
  let sourceDocuments: DocumentService
  let targetDocuments: DocumentService
  let sourceBackup: BackupService
  let targetBackup: BackupService

  async function validatePdf(bytes: Uint8Array): Promise<number> {
    return (await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false })).getPageCount()
  }

  async function addDocument(name: string): Promise<string> {
    const pdf = await PDFDocument.create()
    pdf.setTitle('PaperFlow 原创合成测试 ' + name)
    pdf.addPage([612, 792])
    return (await sourceDocuments.importBuffer(name + '.pdf', await pdf.save())).document.id
  }

  async function legacyArchive(zip: Uint8Array): Promise<Buffer> {
    const entries = readZipBuffer(zip)
    const manifest = JSON.parse(entries.get('paperflow-backup.json')!.toString('utf8')) as BackupManifest
    // 旧版 schemaVersion=1 批注不含 UUID，其余载荷保持真实生成的 PDF。
    for (const annotation of manifest.annotations) delete annotation.id
    entries.set('paperflow-backup.json', Buffer.from(JSON.stringify(manifest), 'utf8'))
    return createZipBuffer([...entries].map(([name, data]) => ({ name, data })))
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'paperflow-backup-regression-'))
    source = new LibraryDatabase(join(root, 'source.sqlite'))
    target = new LibraryDatabase(join(root, 'target.sqlite'))
    sourceDocuments = new DocumentService(source, join(root, 'source-library'), validatePdf)
    targetDocuments = new DocumentService(target, join(root, 'target-library'), validatePdf)
    sourceBackup = new BackupService(source, sourceDocuments)
    targetBackup = new BackupService(target, targetDocuments)
  })
  afterEach(async () => {
    source.close()
    target.close()
    await rm(root, { recursive: true, force: true })
  })

  it('超过 512 MiB 的正常 PDF 库计划在读取原件前被拒绝', async () => {
    for (let index = 0; index < 6; index++) {
      const id = randomUUID()
      source.insertDocument({
        id, sha256: createHash('sha256').update('synthetic-' + index).digest('hex'), originalFilename: index + '.pdf',
        displayTitle: '合成边界记录 ' + index, storedFilename: id + '.pdf', byteSize: 90 * 1024 * 1024,
        pageCount: 1, importedAt: new Date().toISOString()
      })
    }
    const read = vi.spyOn(sourceDocuments, 'readPdfBytes')
    await expect(sourceBackup.exportBackupArchive()).rejects.toThrow('512 MiB')
    expect(read).not.toHaveBeenCalled()
  })

  it('BackupService 元数据条目也计入限制，并在读取 PDF 前失败', async () => {
    await addDocument('small')
    const read = vi.spyOn(sourceDocuments, 'readPdfBytes')
    await expect(new BackupService(source, sourceDocuments, { maxEntries: 4 }).exportBackupArchive()).rejects.toThrow('条目数')
    expect(read).not.toHaveBeenCalled()
    const archive = await new BackupService(source, sourceDocuments, { maxEntries: 5 }).exportBackupArchive()
    expect(readZipBuffer(archive.zipBuffer, { maxEntries: 5 }).size).toBe(5)
    expect((await new BackupService(target, targetDocuments, { maxEntries: 5 }).importBackupArchive(archive.zipBuffer)).importedDocuments).toBe(1)
  })

  it('新包保留同页相同摘录的每个定位、句子和 UUID，重复恢复不增加记录', async () => {
    const id = await addDocument('annotations')
    for (const [index, y] of [20, 120, 120].entries()) {
      source.createAnnotation({ documentId: id, pageNumber: 1, color: 'yellow', quoteText: 'original synthetic repeated text', note: '',
        rects: [{ x: 10, y, width: 100, height: 12 }], sentenceIds: ['synthetic-sentence-' + index] })
    }
    const archive = await sourceBackup.exportBackupArchive()
    expect((await targetBackup.importBackupArchive(archive.zipBuffer)).restoredAnnotations).toBe(3)
    const originals = source.listAllAnnotations()
    expect(target.listAllAnnotations().map(annotation => ({ id: annotation.id, rects: annotation.rects, sentences: annotation.sentenceIds })))
      .toEqual(originals.map(annotation => ({ id: annotation.id, rects: annotation.rects, sentences: annotation.sentenceIds })))
    const existingId = target.listAllAnnotations()[0].id
    target.updateAnnotation({ id: existingId, note: '保留目标库本地修改' })
    expect((await targetBackup.importBackupArchive(archive.zipBuffer)).restoredAnnotations).toBe(0)
    expect(target.listAllAnnotations()).toHaveLength(3)
    expect(target.listAllAnnotations().find(annotation => annotation.id === existingId)?.note).toBe('保留目标库本地修改')
  })

  it('旧包无批注 UUID 时，同页同词的不同定位仍分别还原并可幂等恢复', async () => {
    const id = await addDocument('legacy-annotations')
    for (const y of [20, 120]) source.createAnnotation({ documentId: id, pageNumber: 1, color: 'yellow',
      quoteText: 'synthetic repeated term', note: '', rects: [{ x: 10, y, width: 100, height: 12 }], sentenceIds: ['legacy-' + y] })
    const archive = await legacyArchive((await sourceBackup.exportBackupArchive()).zipBuffer)
    expect((await targetBackup.importBackupArchive(archive)).restoredAnnotations).toBe(2)
    expect(target.listAllAnnotations().map(annotation => annotation.rects[0].y)).toEqual([20, 120])
    expect((await targetBackup.importBackupArchive(archive)).restoredAnnotations).toBe(0)
    expect(target.listAllAnnotations()).toHaveLength(2)
  })

  it('旧包恢复到已有库时只跳过完整定位相同的批注', async () => {
    const id = await addDocument('legacy-existing')
    const base = { documentId: id, pageNumber: 1, color: 'yellow' as const, quoteText: 'synthetic term', note: '' }
    for (const y of [20, 120]) source.createAnnotation({ ...base, rects: [{ x: 10, y, width: 100, height: 12 }], sentenceIds: ['legacy-' + y] })
    const sourceAnnotation = source.listAllAnnotations()[0]
    const imported = await targetDocuments.importBuffer('existing.pdf', await sourceDocuments.readPdfBytes(id))
    target.importAnnotationIfMissing({ ...sourceAnnotation, id: undefined, documentId: imported.document.id })
    const archive = await legacyArchive((await sourceBackup.exportBackupArchive()).zipBuffer)
    expect((await targetBackup.importBackupArchive(archive)).restoredAnnotations).toBe(1)
    expect(target.listAllAnnotations()).toHaveLength(2)
  })

  it('同名同级分类及同名子分类保留独立语境、词库和文献归属', async () => {
    const firstId = await addDocument('first')
    const secondId = await addDocument('second')
    const local = target.createFolder({ name: '同名研究', contextSummary: '目标库独立语境' })
    const first = source.createFolder({ name: '同名研究', contextSummary: '第一语境', glossary: [{ source: 'term', target: '第一含义' }], inheritGlobalGlossary: true })
    const second = source.createFolder({ name: '同名研究', contextSummary: '第二语境', glossary: [{ source: 'term', target: '第二含义' }] })
    const firstChild = source.createFolder({ name: '子分类', parentId: first.id, contextSummary: '第一子语境' })
    const secondChild = source.createFolder({ name: '子分类', parentId: second.id, contextSummary: '第二子语境' })
    source.updateDocumentMeta({ documentId: firstId, folderId: firstChild.id })
    source.updateDocumentMeta({ documentId: secondId, folderId: secondChild.id })
    const archive = (await sourceBackup.exportBackupArchive()).zipBuffer
    await targetBackup.importBackupArchive(archive)
    const restored = target.listFolders()
    expect(restored).toHaveLength(5)
    expect(target.getFolder(local.id)?.contextSummary).toBe('目标库独立语境')
    for (const [name, context, parentContext] of [['first.pdf', '第一子语境', '第一语境'], ['second.pdf', '第二子语境', '第二语境']]) {
      const doc = target.listDocuments().find(document => document.originalFilename === name)!
      const child = target.getFolder(doc.folderId!)!
      expect(child.contextSummary).toBe(context)
      expect(target.getFolder(child.parentId!)?.contextSummary).toBe(parentContext)
    }
    const restoredFirst = restored.find(folder => folder.contextSummary === '第一语境')!
    expect(restoredFirst.glossary).toEqual(first.glossary)
    expect(restoredFirst.inheritGlobalGlossary).toBe(true)
    target.updateFolder({ id: restoredFirst.id, name: '目标库改名', contextSummary: '保留本地语境编辑' })
    target.close()
    target = new LibraryDatabase(join(root, 'target.sqlite'))
    targetDocuments = new DocumentService(target, join(root, 'target-library'), validatePdf)
    targetBackup = new BackupService(target, targetDocuments)
    await targetBackup.importBackupArchive(archive)
    expect(target.listFolders()).toHaveLength(5)
    expect(target.getFolder(restoredFirst.id)?.contextSummary).toBe('保留本地语境编辑')
  })

  it('旧包中完全同名同语境的兄弟也一对一恢复，已有等价分类可安全复用', async () => {
    source.createFolder({ name: '同名兄弟', contextSummary: '相同语境' })
    source.createFolder({ name: '同名兄弟', contextSummary: '相同语境' })
    const local = target.createFolder({ name: '同名兄弟', contextSummary: '相同语境' })
    const archive = await legacyArchive((await sourceBackup.exportBackupArchive()).zipBuffer)
    await targetBackup.importBackupArchive(archive)
    expect(target.listFolders()).toHaveLength(2)
    expect(target.getFolder(local.id)).not.toBeNull()
    await targetBackup.importBackupArchive(archive)
    expect(target.listFolders()).toHaveLength(2)
  })
})
