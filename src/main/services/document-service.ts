import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, join, relative, resolve } from 'node:path'
import type { ImportResult } from '../../shared/contracts'
import { documentIdSchema, pageNumberSchema } from '../../shared/schemas'
import { LibraryDatabase } from './database'

export const MAX_PDF_BYTES = 100 * 1024 * 1024

export function validatePdfHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && /^%PDF-[12]\.[0-9]$/.test(Buffer.from(bytes.subarray(0, 8)).toString('latin1'))
}

export function validatePdfSize(byteSize: number): boolean {
  return Number.isSafeInteger(byteSize) && byteSize > 0 && byteSize <= MAX_PDF_BYTES
}

function friendlyFileError(error: unknown): Error {
  if (error instanceof Error && 'code' in error) {
    const code = String(error.code)
    if (['EACCES', 'EPERM', 'EBUSY', 'ETXTBSY'].includes(code)) return new Error('无法访问 PDF：文件可能被占用，或没有读取权限。请关闭占用程序后重试。')
    if (code === 'ENOENT') return new Error('PDF 文件不存在或已被移动，请重新选择文件。')
    if (code === 'ENOSPC' || code === 'SQLITE_FULL') return new Error('磁盘空间不足，无法保存文献。请释放空间后重试。')
    if (code === 'EIO') return new Error('读取或保存 PDF 时发生磁盘错误，请检查磁盘后重试。')
    if (code === 'EEXIST' || code === 'ENOTDIR') return new Error('文献库存储目录不可用，请检查本地文献库后重试。')
    if (code === 'EISDIR') return new Error('所选项目不是普通 PDF 文件。')
  }
  return error instanceof Error ? error : new Error('PDF 导入失败，请重新选择文件。')
}

/** 文件读取、哈希与落盘使用同一有界快照，避免源文件变化导致去重内容不一致。 */
export class DocumentService {
  private importQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly database: LibraryDatabase,
    private readonly libraryDir: string,
    private readonly validatePdf: (bytes: Uint8Array) => Promise<number>
  ) {}

  importFile(sourcePath: string): Promise<ImportResult> {
    const operation = this.importQueue.then(() => this.importSnapshot(sourcePath))
    this.importQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async readSnapshot(sourcePath: string): Promise<Buffer> {
    if (extname(sourcePath).toLowerCase() !== '.pdf') throw new Error('请选择扩展名为 .pdf 的文件。')
    const handle = await open(sourcePath, constants.O_RDONLY)
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw new Error('所选项目不是普通 PDF 文件。')
      if (!validatePdfSize(before.size)) throw new Error(before.size === 0 ? 'PDF 文件为空。' : '单个 PDF 不能超过 100 MiB。')
      const bytes = Buffer.alloc(before.size)
      let position = 0
      while (position < bytes.length) {
        const result = await handle.read(bytes, position, bytes.length - position, position)
        if (result.bytesRead === 0) throw new Error('PDF 在读取过程中发生变化，请稍后重试。')
        position += result.bytesRead
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, position)
      const after = await handle.stat()
      if (extra.bytesRead !== 0 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('PDF 在读取过程中发生变化，请稍后重试。')
      if (!validatePdfHeader(bytes)) throw new Error('文件内容不是有效 PDF：缺少合法 PDF 文件头。')
      return bytes
    } finally { await handle.close() }
  }

  private async importSnapshot(sourcePath: string): Promise<ImportResult> {
    let temporaryPath: string | null = null
    let storedPath: string | null = null
    let committed = false
    try {
      const bytes = await this.readSnapshot(sourcePath)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const existing = this.database.getByHash(sha256)
      if (existing) {
        // 仍检查文献库中的已有副本，避免返回一个无法打开的去重记录。
        await this.readPdfBytes(existing.id)
        return { status: 'existing', document: {
          id: existing.id, originalFilename: existing.originalFilename, displayTitle: existing.displayTitle,
          byteSize: existing.byteSize, pageCount: existing.pageCount, importedAt: existing.importedAt
        } }
      }
      const pageCount = pageNumberSchema.parse(await this.validatePdf(new Uint8Array(bytes)))
      const id = randomUUID()
      const storedFilename = `${id}.pdf`
      await mkdir(this.libraryDir, { recursive: true })
      temporaryPath = join(this.libraryDir, `.${id}.tmp`)
      storedPath = join(this.libraryDir, storedFilename)
      const temporaryFile = await open(temporaryPath, 'wx', 0o600)
      try {
        await temporaryFile.writeFile(bytes)
        await temporaryFile.sync()
      } finally { await temporaryFile.close() }
      await rename(temporaryPath, storedPath)
      temporaryPath = null
      const originalFilename = basename(sourcePath)
      const document = this.database.insertDocument({
        id, sha256, originalFilename, displayTitle: originalFilename.replace(/\.pdf$/i, '') || originalFilename,
        storedFilename, byteSize: bytes.length, pageCount, importedAt: new Date().toISOString()
      })
      committed = true
      return { status: 'imported', document }
    } catch (error: unknown) {
      const cleanupPaths = [temporaryPath, !committed ? storedPath : null].filter((path): path is string => path !== null)
      const cleanupResults = await Promise.allSettled(cleanupPaths.map(path => unlink(path)))
      const failed = cleanupResults.some(result => result.status === 'rejected' &&
        !(result.reason instanceof Error && 'code' in result.reason && result.reason.code === 'ENOENT'))
      if (failed) throw new Error('导入未完成，且无法清理文献库中的临时副本。请检查磁盘权限后重试。')
      throw friendlyFileError(error)
    }
  }

  private async checkedStoredPath(id: string, storedFilename: string): Promise<string> {
    if (storedFilename !== `${id}.pdf`) throw new Error('文献存储记录无效，请检查文献库。')
    const path = resolve(this.libraryDir, storedFilename)
    const information = await lstat(path)
    if (!information.isFile() || information.isSymbolicLink()) throw new Error('文献库副本不是普通 PDF 文件。')
    const root = await realpath(this.libraryDir)
    const resolved = await realpath(path)
    const local = relative(root, resolved)
    if (local.startsWith('..') || resolve(root, local) !== resolved) throw new Error('文献库路径无效。')
    return path
  }

  async readPdfBytes(documentId: string): Promise<Uint8Array> {
    try {
      const id = documentIdSchema.parse(documentId)
      const document = this.database.getDocument(id)
      if (!document) throw new Error('文献不存在，请重新选择文献。')
      const path = await this.checkedStoredPath(id, document.storedFilename)
      const bytes = await this.readSnapshot(path)
      if (!validatePdfSize(bytes.length) || !validatePdfHeader(bytes) || createHash('sha256').update(bytes).digest('hex') !== document.sha256) {
        throw new Error('文献库中的 PDF 副本已损坏或被修改，请检查本地文献库。')
      }
      return new Uint8Array(bytes)
    } catch (error: unknown) { throw friendlyFileError(error) }
  }
}
