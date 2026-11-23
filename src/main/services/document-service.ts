import { constants, type Dirent } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  formatPdfByteSize, hasControlCharacters, MAX_PDF_BYTES as SHARED_MAX_PDF_BYTES, type ImportResult
} from '../../shared/contracts'
import { documentIdSchema, pageNumberSchema } from '../../shared/schemas'
import { LibraryDatabase } from './database'

export const MAX_PDF_BYTES = SHARED_MAX_PDF_BYTES
const ORPHAN_PDF_PATTERN = /^[a-f0-9-]{36}\.pdf$/
const ORPHAN_TMP_PATTERN = /^\.[a-f0-9-]{36}\.tmp$/

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && String(error.code) === code
}

function labelPrefix(filename?: string): string {
  return filename ? `「${filename}」` : ''
}

function validateDroppedFilename(rawFilename: string): string {
  const trimmed = rawFilename.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\') || hasControlCharacters(trimmed)) {
    throw new Error('文件名无效：仅支持单个本地 PDF 文件，不能包含路径分隔符或控制字符。')
  }
  const name = basename(trimmed)
  if (!name || name !== trimmed || name === '.' || name === '..') {
    throw new Error('文件名无效：仅支持单个本地 PDF 文件。')
  }
  if (extname(name).toLowerCase() !== '.pdf') {
    throw new Error(`「${name}」导入失败：请选择扩展名为 .pdf 的文件。`)
  }
  return name
}

export function validatePdfHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && /^%PDF-[12]\.[0-9]$/.test(Buffer.from(bytes.subarray(0, 8)).toString('latin1'))
}

export function validatePdfSize(byteSize: number): boolean {
  return Number.isSafeInteger(byteSize) && byteSize > 0 && byteSize <= MAX_PDF_BYTES
}

function friendlyFileError(error: unknown, filename?: string): Error {
  const prefix = labelPrefix(filename)
  if (error instanceof Error && 'code' in error) {
    const code = String(error.code)
    if (['EACCES', 'EPERM', 'EBUSY', 'ETXTBSY'].includes(code)) {
      return new Error(`${prefix}无法访问 PDF：文件可能被占用，或没有读取权限。请关闭占用程序后重试。`)
    }
    if (code === 'ENOENT') {
      return new Error(`${prefix}PDF 文件不存在或已被移动，请重新选择文件。`)
    }
    if (code === 'ENOSPC' || code === 'SQLITE_FULL') {
      return new Error(`${prefix}磁盘空间不足，无法保存文献。请释放空间后重试。`)
    }
    if (code === 'EIO') {
      return new Error(`${prefix}读取或保存 PDF 时发生磁盘错误，请检查磁盘后重试。`)
    }
    if (code === 'EEXIST' || code === 'ENOTDIR') {
      return new Error(`${prefix}文献库存储目录不可用，请检查本地文献库后重试。`)
    }
    if (code === 'EISDIR') {
      return new Error(`${prefix}所选项目不是普通 PDF 文件。`)
    }
  }
  return error instanceof Error ? error : new Error(`${prefix}PDF 导入失败，请重新选择文件。`)
}

/** 文件读取、哈希与落盘使用同一有界快照，避免源文件变化导致去重内容不一致。 */
export class DocumentService {
  private importQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly database: LibraryDatabase,
    private readonly libraryDir: string,
    private readonly validatePdf: (bytes: Uint8Array) => Promise<number>
  ) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.importQueue.then(task)
    this.importQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  importFile(sourcePath: string): Promise<ImportResult> {
    return this.enqueue(() => this.importSnapshot(sourcePath))
  }

  importBuffer(originalFilename: string, bytes: Uint8Array): Promise<ImportResult> {
    return this.enqueue(() => this.importBytesSnapshot(originalFilename, bytes))
  }

  deleteDocument(documentId: string): Promise<void> {
    return this.enqueue(() => this.deleteStoredDocument(documentId))
  }

  cleanupOrphanFiles(): Promise<void> {
    return this.enqueue(() => this.runOrphanCleanup())
  }

  private async readSnapshot(sourcePath: string, displayName?: string): Promise<Buffer> {
    const prefix = labelPrefix(displayName)
    if (extname(sourcePath).toLowerCase() !== '.pdf') {
      throw new Error(`${prefix}请选择扩展名为 .pdf 的文件。`)
    }
    const handle = await open(sourcePath, constants.O_RDONLY)
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw new Error(`${prefix}所选项目不是普通 PDF 文件。`)
      if (!validatePdfSize(before.size)) {
        throw new Error(
          before.size === 0
            ? `${prefix}PDF 文件为空（0 B）。`
            : `${prefix}超出限制：单个 PDF 不能超过 100 MiB（当前 ${formatPdfByteSize(before.size)}）。`
        )
      }
      const bytes = Buffer.alloc(before.size)
      let position = 0
      while (position < bytes.length) {
        const result = await handle.read(bytes, position, bytes.length - position, position)
        if (result.bytesRead === 0) throw new Error(`${prefix}PDF 在读取过程中发生变化，请稍后重试。`)
        position += result.bytesRead
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, position)
      const after = await handle.stat()
      if (extra.bytesRead !== 0 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`${prefix}PDF 在读取过程中发生变化，请稍后重试。`)
      }
      if (!validatePdfHeader(bytes)) {
        throw new Error(`${prefix}文件内容不是有效 PDF：缺少合法 PDF 文件头。`)
      }
      return bytes
    } finally { await handle.close() }
  }

  private async importSnapshot(sourcePath: string): Promise<ImportResult> {
    const originalFilename = basename(sourcePath) || undefined
    let bytes: Buffer
    try {
      bytes = await this.readSnapshot(sourcePath, originalFilename)
    } catch (error: unknown) {
      throw friendlyFileError(error, originalFilename)
    }
    return this.commitPdfBytes(basename(sourcePath), bytes)
  }

  private async importBytesSnapshot(originalFilename: string, bytes: Uint8Array): Promise<ImportResult> {
    const safeName = validateDroppedFilename(originalFilename)
    if (!(bytes instanceof Uint8Array)) throw new Error(`「${safeName}」导入失败：无效的文件内容。`)
    if (!validatePdfSize(bytes.byteLength)) {
      throw new Error(
        bytes.byteLength === 0
          ? `「${safeName}」导入失败：PDF 文件为空（0 B）。`
          : `「${safeName}」超出限制：单个 PDF 不能超过 100 MiB（当前 ${formatPdfByteSize(bytes.byteLength)}）。`
      )
    }
    const snapshot = Buffer.from(bytes)
    if (!validatePdfHeader(snapshot)) {
      throw new Error(`「${safeName}」导入失败：文件内容不是有效 PDF，缺少合法 PDF 文件头。`)
    }
    return this.commitPdfBytes(safeName, snapshot)
  }

  private async commitPdfBytes(originalFilename: string, bytes: Buffer): Promise<ImportResult> {
    let temporaryPath: string | null = null
    let storedPath: string | null = null
    let committed = false
    try {
      if (!validatePdfSize(bytes.length)) {
        throw new Error(
          bytes.length === 0
            ? `「${originalFilename}」导入失败：PDF 文件为空（0 B）。`
            : `「${originalFilename}」超出限制：单个 PDF 不能超过 100 MiB（当前 ${formatPdfByteSize(bytes.length)}）。`
        )
      }
      if (!validatePdfHeader(bytes)) {
        throw new Error(`「${originalFilename}」导入失败：文件内容不是有效 PDF，缺少合法 PDF 文件头。`)
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const existing = this.database.getByHash(sha256)
      if (existing) {
        // 仍检查文献库中的已有副本，避免返回一个无法打开的去重记录。
        await this.readPdfBytes(existing.id)
        return {
          status: 'existing',
          document: {
            id: existing.id,
            originalFilename: existing.originalFilename,
            displayTitle: existing.displayTitle,
            byteSize: existing.byteSize,
            pageCount: existing.pageCount,
            importedAt: existing.importedAt
          }
        }
      }
      let pageCount: number
      try {
        pageCount = pageNumberSchema.parse(await this.validatePdf(new Uint8Array(bytes)))
      } catch (error: unknown) {
        const raw = error instanceof Error ? error.message : ''
        const detail = /[\u4e00-\u9fff]/.test(raw) ? raw : '无法解析 PDF，文件可能已损坏或格式不受支持。'
        throw new Error(detail.startsWith('「') ? detail : `「${originalFilename}」导入失败：${detail}`)
      }
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
      const document = this.database.insertDocument({
        id,
        sha256,
        originalFilename,
        displayTitle: originalFilename.replace(/\.pdf$/i, '') || originalFilename,
        storedFilename,
        byteSize: bytes.length,
        pageCount,
        importedAt: new Date().toISOString()
      })
      committed = true
      return { status: 'imported', document }
    } catch (error: unknown) {
      const cleanupPaths = [temporaryPath, !committed ? storedPath : null].filter((path): path is string => path !== null)
      const cleanupResults = await Promise.allSettled(cleanupPaths.map(path => unlink(path)))
      const failed = cleanupResults.some(result => result.status === 'rejected' && !isErrno(result.reason, 'ENOENT'))
      if (failed) throw new Error('导入未完成，且无法清理文献库中的临时副本。请检查磁盘权限后重试。')
      throw friendlyFileError(error, originalFilename)
    }
  }

  private async assertInsideLibraryDir(targetPath: string): Promise<void> {
    const root = await realpath(this.libraryDir)
    const resolved = await realpath(targetPath)
    const local = relative(root, resolved)
    if (!local || local.startsWith('..') || isAbsolute(local) || resolve(root, local) !== resolved) {
      throw new Error('文献库路径无效。')
    }
  }

  private async checkedStoredPath(id: string, storedFilename: string): Promise<string> {
    if (storedFilename !== `${id}.pdf`) throw new Error('文献存储记录无效，请检查文献库。')
    const path = resolve(this.libraryDir, storedFilename)
    const information = await lstat(path)
    if (!information.isFile() || information.isSymbolicLink()) throw new Error('文献库副本不是普通 PDF 文件。')
    await this.assertInsideLibraryDir(path)
    return path
  }

  private async resolveSafeStoredTarget(id: string, storedFilename: string): Promise<string | null> {
    if (storedFilename !== `${id}.pdf`) throw new Error('文献存储记录无效，请检查文献库。')
    const targetPath = resolve(this.libraryDir, storedFilename)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(targetPath)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return null
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('文献库副本不是普通 PDF 文件。')
    await this.assertInsideLibraryDir(targetPath)
    return targetPath
  }

  private async deleteStoredDocument(documentId: string): Promise<void> {
    const id = documentIdSchema.parse(documentId)
    const document = this.database.getDocument(id)
    if (!document) throw new Error('文献不存在，请重新选择文献。')
    try {
      const targetPath = await this.resolveSafeStoredTarget(id, document.storedFilename)
      this.database.deleteDocument(id)
      if (targetPath) {
        try {
          await unlink(targetPath)
        } catch (error: unknown) {
          if (!isErrno(error, 'ENOENT')) throw error
        }
      }
    } catch (error: unknown) {
      throw friendlyFileError(error, document.originalFilename)
    }
  }

  private async runOrphanCleanup(): Promise<void> {
    let dirInfo: Awaited<ReturnType<typeof lstat>>
    try {
      dirInfo = await lstat(this.libraryDir)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return
      throw error
    }
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) return

    const root = await realpath(this.libraryDir)
    let entries: Dirent[]
    try {
      entries = await readdir(this.libraryDir, { withFileTypes: true })
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return
      throw error
    }

    const storedFilenames = this.database.listStoredFilenames()
    for (const entry of entries) {
      const isTmp = ORPHAN_TMP_PATTERN.test(entry.name)
      const isOrphanPdf = ORPHAN_PDF_PATTERN.test(entry.name) && !storedFilenames.has(entry.name)
      if (!isTmp && !isOrphanPdf) continue
      if (entry.isDirectory() || entry.isSymbolicLink()) continue

      const candidatePath = resolve(this.libraryDir, entry.name)
      try {
        const info = await lstat(candidatePath)
        if (!info.isFile() || info.isSymbolicLink()) continue
        const resolved = await realpath(candidatePath)
        const local = relative(root, resolved)
        if (!local || local.startsWith('..') || isAbsolute(local) || resolve(root, local) !== resolved) continue
        await unlink(candidatePath)
      } catch (error: unknown) {
        if (isErrno(error, 'ENOENT')) continue
      }
    }
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
