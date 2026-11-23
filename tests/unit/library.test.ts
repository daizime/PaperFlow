import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { LibraryDatabase, type StoredDocumentRecord } from '../../src/main/services/database'
import { DocumentService, MAX_PDF_BYTES, validatePdfHeader, validatePdfSize } from '../../src/main/services/document-service'
import { formatDocumentTitle } from '../../src/renderer/src/features/library/useLibrary'
import { documentIdArgsSchema, noArgsSchema, pageCountArgsSchema, readerStateSchema } from '../../src/shared/schemas'

let root: string
let filename: string
let database: LibraryDatabase
let service: DocumentService
const fixtures = resolve('tests/fixtures')

async function validatePdf(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false })
  return document.getPageCount()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paperflow-unit-'))
  filename = join(root, 'paperflow.sqlite')
  database = new LibraryDatabase(filename)
  service = new DocumentService(database, join(root, 'library'), validatePdf)
})
afterEach(async () => {
  database.close()
  await rm(root, { recursive: true, force: true })
})

describe('PDF 文件校验', () => {
  it('校验真实 PDF 文件头并拒绝伪装文本', async () => {
    expect(validatePdfHeader(await readFile(join(fixtures, 'valid.pdf')))).toBe(true)
    expect(validatePdfHeader(Buffer.from('%PDF-1.7'))).toBe(true)
    expect(validatePdfHeader(Buffer.from('%PDF-2.0'))).toBe(true)
    expect(validatePdfHeader(Buffer.from('not a pdf'))).toBe(false)
    expect(validatePdfHeader(Buffer.from('%PDF-'))).toBe(false)
    expect(validatePdfHeader(Buffer.from([37, 80, 68, 70, 45, 0xb1, 46, 55]))).toBe(false)
  })
  it('明确接受 100 MiB 边界并拒绝越界/非整数/空文件', () => {
    expect(validatePdfSize(MAX_PDF_BYTES)).toBe(true)
    expect(validatePdfSize(MAX_PDF_BYTES - 1)).toBe(true)
    for (const size of [0, -1, MAX_PDF_BYTES + 1, NaN, Infinity, 1.5]) expect(validatePdfSize(size)).toBe(false)
  })
  it('实际拒绝扩展名、空文件、无效文件头和超过 100 MiB 的文件', async () => {
    await expect(service.importFile(join(fixtures, 'README.md'))).rejects.toThrow('扩展名')
    await expect(service.importFile(join(fixtures, 'invalid-header.pdf'))).rejects.toThrow('文件头')
    const empty = join(root, 'empty.pdf')
    await writeFile(empty, '')
    await expect(service.importFile(empty)).rejects.toThrow('为空')
    await truncate(empty, MAX_PDF_BYTES + 1)
    await expect(service.importFile(empty)).rejects.toThrow('100 MiB')
    expect(database.listDocuments()).toHaveLength(0)
  })
  it('拒绝损坏 PDF，且不留下记录或临时文件', async () => {
    await expect(service.importFile(join(fixtures, 'corrupt.pdf'))).rejects.toThrow()
    expect(database.listDocuments()).toEqual([])
    expect(await readdir(root)).not.toContain('library')
  })
  it('拒绝目录并为不存在文件提供可理解错误', async () => {
    const folder = join(root, 'folder.pdf')
    await mkdir(folder)
    await expect(service.importFile(folder)).rejects.toThrow()
    await expect(service.importFile(join(root, 'missing.pdf'))).rejects.toThrow('不存在')
  })
})

describe('文献库持久化与原子导入', () => {
  it('导入真实 PDF 并通过哈希读取同一副本，不暴露磁盘路径', async () => {
    const result = await service.importFile(join(fixtures, 'valid.pdf'))
    expect(result.status).toBe('imported')
    expect(result.document).toMatchObject({ originalFilename: 'valid.pdf', displayTitle: 'valid', pageCount: 3 })
    expect(result.document).not.toHaveProperty('storedFilename')
    expect(result.document).not.toHaveProperty('sha256')
    expect(Buffer.from(await service.readPdfBytes(result.document.id))).toEqual(await readFile(join(fixtures, 'valid.pdf')))
    expect(await readdir(join(root, 'library'))).toEqual([`${result.document.id}.pdf`])
  })
  it('SHA-256 去重，包括并发重复导入，只落盘一个副本', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => service.importFile(join(fixtures, 'valid.pdf'))))
    expect(results.map(result => result.status)).toEqual(['imported', 'existing', 'existing', 'existing'])
    expect(new Set(results.map(result => result.document.id)).size).toBe(1)
    expect(database.listDocuments()).toHaveLength(1)
    expect(await readdir(join(root, 'library'))).toHaveLength(1)
  })
  it('同名但不同内容文献可以共存', async () => {
    const first = await service.importFile(join(fixtures, 'same-name-a/paper.pdf'))
    const second = await service.importFile(join(fixtures, 'same-name-b/paper.pdf'))
    expect(first.document.originalFilename).toBe(second.document.originalFilename)
    expect(first.document.id).not.toBe(second.document.id)
    expect(database.listDocuments()).toHaveLength(2)
    expect(await readdir(join(root, 'library'))).toHaveLength(2)
  })
  it('重启数据库仍保存文献和文件，可正常再次读取', async () => {
    const result = await service.importFile(join(fixtures, 'valid.pdf'))
    database.close()
    database = new LibraryDatabase(filename)
    service = new DocumentService(database, join(root, 'library'), validatePdf)
    expect(database.listDocuments()).toEqual([result.document])
    expect((await service.readPdfBytes(result.document.id)).byteLength).toBe(result.document.byteSize)
  })
  it('数据库写入失败时清理已复制文件', async () => {
    const failing = new DocumentService(database, join(root, 'library'), async bytes => {
      const count = await validatePdf(bytes)
      database.close()
      return count
    })
    await expect(failing.importFile(join(fixtures, 'valid.pdf'))).rejects.toThrow()
    expect(await readdir(join(root, 'library'))).toEqual([])
  })
  it('文献库存储目录不可写入时报告错误，不写数据库或覆盖已有文件', async () => {
    const blocked = join(root, 'blocked-library')
    await writeFile(blocked, 'keep this file')
    const failing = new DocumentService(database, blocked, validatePdf)
    await expect(failing.importFile(join(fixtures, 'valid.pdf'))).rejects.toThrow('存储目录不可用')
    expect(database.listDocuments()).toEqual([])
    expect(await readFile(blocked, 'utf8')).toBe('keep this file')
  })
  it('副本被改动时拒绝读取，源 PDF 不会被修改', async () => {
    const original = await readFile(join(fixtures, 'valid.pdf'))
    const result = await service.importFile(join(fixtures, 'valid.pdf'))
    await writeFile(join(root, 'library', `${result.document.id}.pdf`), Buffer.from('%PDF-1.7\nchanged'))
    await expect(service.readPdfBytes(result.document.id)).rejects.toThrow('已损坏或被修改')
    expect(await readFile(join(fixtures, 'valid.pdf'))).toEqual(original)
  })
})

describe('数据库、进度和参数边界', () => {
  it('首次初始化与重复启动只创建两个业务表，版本为 1', async () => {
    database.close()
    database = new LibraryDatabase(filename)
    database.close()
    database = new LibraryDatabase(filename)
    expect(database.listDocuments()).toEqual([])
    const { default: Database } = await import('better-sqlite3')
    const inspection = new Database(filename, { readonly: true })
    try {
      expect(inspection.pragma('user_version', { simple: true })).toBe(1)
      expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
        .toEqual([{ name: 'documents' }, { name: 'reader_state' }])
    } finally { inspection.close() }
  })
  it('阅读页码、倍率可存取并在数据库关闭后恢复', async () => {
    const result = await service.importFile(join(fixtures, 'valid.pdf'))
    expect(database.getReaderState(result.document.id)).toBeNull()
    database.saveReaderState({ documentId: result.document.id, pageNumber: 2, scale: 1.5, updatedAt: new Date().toISOString() })
    database.close()
    database = new LibraryDatabase(filename)
    expect(database.getReaderState(result.document.id)).toMatchObject({ documentId: result.document.id, pageNumber: 2, scale: 1.5 })
    expect(readerStateSchema.safeParse(database.getReaderState(result.document.id)).success).toBe(true)
    database.updatePageCount(result.document.id, 1)
    expect(database.getReaderState(result.document.id)?.pageNumber).toBe(1)
  })
  it('拒绝无效 ID、未知 UUID、越界页码、倍率及额外 IPC 参数', async () => {
    await expect(service.readPdfBytes('../../outside.pdf')).rejects.toThrow()
    await expect(service.readPdfBytes(randomUUID())).rejects.toThrow('文献不存在')
    expect(() => database.getDocument("' OR 1 = 1 --")).toThrow()
    expect(documentIdArgsSchema.safeParse([randomUUID(), '/etc/passwd']).success).toBe(false)
    expect(noArgsSchema.safeParse(['unexpected']).success).toBe(false)
    expect(pageCountArgsSchema.safeParse([randomUUID(), 0]).success).toBe(false)
    const imported = await service.importFile(join(fixtures, 'valid.pdf'))
    const state = { documentId: imported.document.id, pageNumber: 2, scale: 1, updatedAt: new Date().toISOString() }
    for (const scale of [0.49, 3.01, Infinity, NaN]) expect(() => database.saveReaderState({ ...state, scale })).toThrow()
    expect(() => database.saveReaderState({ ...state, pageNumber: 4 })).toThrow('超出')
    expect(() => database.updatePageCount(imported.document.id, 0)).toThrow()
    expect(() => database.saveReaderState({ ...state, documentId: randomUUID() })).toThrow('文献不存在')
  })
  it('所有值使用参数绑定，标题中的 SQL 字符串保持普通文本', () => {
    const record: StoredDocumentRecord = {
      id: randomUUID(), sha256: createHash('sha256').update('unique').digest('hex'), originalFilename: "a'; DROP TABLE documents;--.pdf",
      displayTitle: "a'; DROP TABLE documents;--", storedFilename: '', byteSize: 8, pageCount: null, importedAt: new Date().toISOString()
    }
    record.storedFilename = `${record.id}.pdf`
    database.insertDocument(record)
    expect(database.listDocuments()[0].displayTitle).toBe(record.displayTitle)
    expect(database.listDocuments()).toHaveLength(1)
  })
})

describe('缓冲区导入、重命名、删除与孤立文件清理', () => {
  it('importBuffer 原子落盘并与 importFile 共享 SHA-256 去重', async () => {
    const validBytes = new Uint8Array(await readFile(join(fixtures, 'valid.pdf')))
    const first = await service.importBuffer('dropped-valid.pdf', validBytes)
    expect(first.status).toBe('imported')
    expect(first.document).toMatchObject({ originalFilename: 'dropped-valid.pdf', displayTitle: 'dropped-valid', pageCount: 3 })
    expect(await readdir(join(root, 'library'))).toEqual([`${first.document.id}.pdf`])

    const duplicate = await service.importFile(join(fixtures, 'valid.pdf'))
    expect(duplicate.status).toBe('existing')
    expect(duplicate.document.id).toBe(first.document.id)
    expect(database.listDocuments()).toHaveLength(1)
  })

  it('importBuffer 拒绝路径分隔符、控制字符与各类无效文件并给出具体文件名和大小错误', async () => {
    const validBytes = new Uint8Array(await readFile(join(fixtures, 'valid.pdf')))
    await expect(service.importBuffer('sub/evil.pdf', validBytes)).rejects.toThrow('路径分隔符')
    await expect(service.importBuffer('..\\evil.pdf', validBytes)).rejects.toThrow('路径分隔符')
    await expect(service.importBuffer('bad\nname.pdf', validBytes)).rejects.toThrow('路径分隔符')
    await expect(service.importBuffer('.pdf', validBytes)).rejects.toThrow('扩展名')
    await expect(service.importBuffer('notes.txt', validBytes)).rejects.toThrow(/notes\.txt.*扩展名/)
    await expect(service.importBuffer('empty.pdf', new Uint8Array(0))).rejects.toThrow(/empty\.pdf.*为空/)
    await expect(service.importBuffer('huge.pdf', new Uint8Array(MAX_PDF_BYTES + 1))).rejects.toThrow(/huge\.pdf.*100 MiB/)

    const badHeader = new Uint8Array(await readFile(join(fixtures, 'invalid-header.pdf')))
    await expect(service.importBuffer('fake-header.pdf', badHeader)).rejects.toThrow(/fake-header\.pdf.*文件头/)

    const corruptBytes = new Uint8Array(await readFile(join(fixtures, 'corrupt.pdf')))
    await expect(service.importBuffer('broken-doc.pdf', corruptBytes)).rejects.toThrow(/broken-doc\.pdf.*损坏/)

    expect(database.listDocuments()).toEqual([])
    expect(await readdir(root)).not.toContain('library')
  })

  it('renameDocument 更新标题、防注入并在重启后持久保留', async () => {
    const imported = await service.importFile(join(fixtures, 'valid.pdf'))
    const renamed = database.renameDocument(imported.document.id, "  My Paper'; DROP TABLE documents;--  ")
    expect(renamed.displayTitle).toBe("My Paper'; DROP TABLE documents;--")
    expect(renamed.originalFilename).toBe('valid.pdf')

    database.close()
    database = new LibraryDatabase(filename)
    expect(database.listDocuments()).toEqual([renamed])
    expect(() => database.renameDocument(randomUUID(), '不存在')).toThrow('文献不存在')
    expect(() => database.renameDocument(imported.document.id, '   ')).toThrow()
    expect(() => database.renameDocument(imported.document.id, 'bad\x00title')).toThrow()
  })

  it('deleteDocument 删除数据库记录、级联清理阅读进度并移除本地 PDF 副本', async () => {
    const imported = await service.importFile(join(fixtures, 'valid.pdf'))
    const second = await service.importFile(join(fixtures, 'same-name-b/paper.pdf'))
    database.saveReaderState({ documentId: imported.document.id, pageNumber: 2, scale: 1.5, updatedAt: new Date().toISOString() })
    database.saveReaderState({ documentId: second.document.id, pageNumber: 1, scale: 1.0, updatedAt: new Date().toISOString() })

    await service.deleteDocument(imported.document.id)
    expect(database.listDocuments().map(item => item.id)).toEqual([second.document.id])
    expect(await readdir(join(root, 'library'))).toEqual([`${second.document.id}.pdf`])

    const { default: Database } = await import('better-sqlite3')
    const inspection = new Database(filename, { readonly: true })
    try {
      const states = inspection.prepare('SELECT document_id FROM reader_state').all() as Array<{ document_id: string }>
      expect(states).toEqual([{ document_id: second.document.id }])
    } finally { inspection.close() }

    // 磁盘文件已丢失时仍允许删除残余记录（忽略 ENOENT）。
    await rm(join(root, 'library', `${second.document.id}.pdf`))
    await service.deleteDocument(second.document.id)
    expect(database.listDocuments()).toEqual([])
    await expect(service.deleteDocument(randomUUID())).rejects.toThrow('文献不存在')
  })

  it('cleanupOrphanFiles 安全处理缺失目录，仅清理未登记的 UUID 副本与临时文件，保留无关文件、子目录与符号链接', async () => {
    await expect(service.cleanupOrphanFiles()).resolves.toBeUndefined()
    expect(await readdir(root)).not.toContain('library')

    const imported = await service.importFile(join(fixtures, 'valid.pdf'))
    const libraryDir = join(root, 'library')
    const orphanPdf = '11111111-1111-4111-8111-111111111111.pdf'
    const orphanTmp = '.22222222-2222-4222-8222-222222222222.tmp'
    const unrelatedPdf = 'user-custom-notes.pdf'
    const unrelatedTxt = 'readme.txt'
    const uuidFolder = '33333333-3333-4333-8333-333333333333.pdf'
    const outsideTarget = join(root, 'outside-secret.pdf')

    await copyFile(join(fixtures, 'valid.pdf'), join(libraryDir, orphanPdf))
    await writeFile(join(libraryDir, orphanTmp), '%PDF-1.7')
    await writeFile(join(libraryDir, unrelatedPdf), 'keep pdf')
    await writeFile(join(libraryDir, unrelatedTxt), 'keep text')
    await mkdir(join(libraryDir, uuidFolder))
    await writeFile(outsideTarget, 'outside data')

    const symlinkName = '44444444-4444-4444-8444-444444444444.pdf'
    let createdSymlink = false
    try {
      await symlink(outsideTarget, join(libraryDir, symlinkName), 'file')
      createdSymlink = true
    } catch {
      // 未开启符号链接权限的 Windows 环境允许跳过文件符号链接构造。
    }

    await service.cleanupOrphanFiles()

    const expectedKept = [
      `${imported.document.id}.pdf`,
      unrelatedPdf,
      unrelatedTxt,
      uuidFolder,
      ...(createdSymlink ? [symlinkName] : [])
    ].sort()
    expect((await readdir(libraryDir)).sort()).toEqual(expectedKept)
    expect(await readFile(outsideTarget, 'utf8')).toBe('outside data')
    expect(database.listStoredFilenames()).toEqual(new Set([`${imported.document.id}.pdf`]))
  })

  it('deleteDocument 拒绝删除指向文献库外部的符号链接，且标题展示规则兼容默认文件名与自定义标题', async () => {
    const imported = await service.importFile(join(fixtures, 'valid.pdf'))
    expect(formatDocumentTitle(imported.document)).toBe('valid.pdf')
    const renamed = database.renameDocument(imported.document.id, '自定义论文标题')
    expect(formatDocumentTitle(renamed)).toBe('自定义论文标题')

    const storedPath = join(root, 'library', `${imported.document.id}.pdf`)
    const outsideTarget = join(root, 'do-not-delete.pdf')
    await writeFile(outsideTarget, 'protected outside content')
    await rm(storedPath)

    let createdSymlink = false
    try {
      await symlink(outsideTarget, storedPath, 'file')
      createdSymlink = true
    } catch {
      // 未开启符号链接权限的 Windows 环境允许改用目录覆盖边界验证。
      await mkdir(storedPath)
    }

    await expect(service.deleteDocument(imported.document.id)).rejects.toThrow('不是普通 PDF 文件')
    expect(database.listDocuments()).toHaveLength(1)
    expect(await readFile(outsideTarget, 'utf8')).toBe('protected outside content')
    if (createdSymlink) await rm(storedPath)
    else await rm(storedPath, { recursive: true })
  })
})
