import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { appendFile, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import Sqlite from 'better-sqlite3'
import { PDFDocument } from 'pdf-lib'
import { LibraryDatabase } from '../../src/main/services/database'
import { DocumentService, MAX_PDF_BYTES } from '../../src/main/services/document-service'

// Faults affect only selected test paths. All other filesystem calls remain real.
const faults = vi.hoisted(() => ({
  beforeOpen: null as null | ((path: string, flags: string | number | undefined) => void),
  opened: null as null | ((path: string, flags: string | number | undefined, handle: FileHandle) => FileHandle),
  rename: null as null | ((oldPath: string, newPath: string) => void),
  unlink: null as null | ((path: string) => void)
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      faults.beforeOpen?.(String(args[0]), args[1])
      const handle = await actual.open(...args)
      return faults.opened?.(String(args[0]), args[1], handle) ?? handle
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      faults.rename?.(String(args[0]), String(args[1]))
      return actual.rename(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      faults.unlink?.(String(args[0]))
      return actual.unlink(...args)
    }
  }
})

const cacheRoot = resolve('.cache/library')
const fixture = resolve('tests/fixtures/valid.pdf')
let root: string
let source: string
let library: string
let databasePath: string
let database: LibraryDatabase
let service: DocumentService
const observed: Record<string, unknown> = {}

function fault(code: string, message = `verification injected ${code}`): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

function resetFaults(): void {
  faults.beforeOpen = null
  faults.opened = null
  faults.rename = null
  faults.unlink = null
  vi.restoreAllMocks()
}

function overrideHandle(handle: FileHandle, overrides: Partial<Pick<FileHandle, 'read' | 'writeFile' | 'sync'>>): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      const override = Reflect.get(overrides, property)
      if (override !== undefined) return override
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

async function validatePdf(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false })
  return document.getPageCount()
}

async function libraryFiles(): Promise<string[]> {
  try { return await readdir(library) } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

async function assertEmptyAndRetry(): Promise<void> {
  expect(database.listDocuments()).toEqual([])
  expect(await libraryFiles()).toEqual([])
  resetFaults()
  const result = await service.importFile(source)
  expect(result.status).toBe('imported')
  expect(await libraryFiles()).toEqual([`${result.document.id}.pdf`])
  expect(Buffer.from(await service.readPdfBytes(result.document.id))).toEqual(await readFile(source))
}

beforeEach(async () => {
  resetFaults()
  await mkdir(join(cacheRoot, 'cases'), { recursive: true })
  root = await mkdtemp(join(cacheRoot, 'cases', 'case-'))
  source = join(root, 'source.pdf')
  library = join(root, 'library')
  databasePath = join(root, 'paperflow.sqlite')
  await copyFile(fixture, source)
  database = new LibraryDatabase(databasePath)
  service = new DocumentService(database, library, validatePdf)
})

afterEach(async () => {
  resetFaults()
  database?.close()
  if (!root.startsWith(join(cacheRoot, 'cases') + sep)) throw new Error('Unsafe test cleanup path')
  await rm(root, { recursive: true, force: true })
  await writeFile(join(cacheRoot, 'fault-observations.json'), JSON.stringify(observed, null, 2) + '\n')
})

describe('真实 Windows 文件独占锁', () => {
  it.skipIf(process.platform !== 'win32')('拒绝 FileShare.None 占用，并在释放后复用同一服务重试', async () => {
    const ready = join(root, 'lock-ready.json')
    const release = join(root, 'lock-release')
    const windowsPowerShell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(windowsPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', resolve('scripts/verification/library-faults.ps1'), '-TargetPath', source,
      '-ReadyPath', ready, '-ReleasePath', release], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const exited = new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('exit', resolveExit)
      child.once('error', rejectExit)
    })
    let exitCode: number | null = null
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { await stat(ready); break } catch {
          if (child.exitCode !== null) throw new Error(`Lock helper exited early: ${output}`)
          if (attempt === 199) throw new Error(`Lock helper did not become ready: ${output}`)
          await delay(40)
        }
      }
      const lockRecord = JSON.parse((await readFile(ready, 'utf8')).replace(/^\uFEFF/, ''))
      let rawError: unknown
      try { const unexpectedHandle = await open(source, constants.O_RDONLY); await unexpectedHandle.close() } catch (error: unknown) { rawError = error }
      expect(rawError).toBeInstanceOf(Error)
      const errorCode = rawError instanceof Error && 'code' in rawError ? String(rawError.code) : ''
      observed.windowsExclusiveLock = { ...lockRecord, nodeOpenErrorCode: errorCode }
      await expect(service.importFile(source)).rejects.toThrow('文件可能被占用')
      expect(database.listDocuments()).toEqual([])
      expect(await libraryFiles()).toEqual([])
    } finally {
      await writeFile(release, 'release')
      const timer = setTimeout(() => { child.kill() }, 5000)
      try { exitCode = await exited } finally { clearTimeout(timer) }
    }
    expect(exitCode, output).toBe(0)
    await assertEmptyAndRetry()
  }, 20000)
})

describe('实际文件大小与读取期间变化', () => {
  it('完整导入精确 100 MiB 快照并核对大小和 SHA256（仅此项替代页数校验）', async () => {
    await truncate(source, MAX_PDF_BYTES)
    const validator = vi.fn(async (bytes: Uint8Array) => {
      expect(bytes.byteLength).toBe(MAX_PDF_BYTES)
      return 3
    })
    service = new DocumentService(database, library, validator)
    const result = await service.importFile(source)
    expect(result.document.byteSize).toBe(104857600)
    expect((await stat(join(library, `${result.document.id}.pdf`))).size).toBe(MAX_PDF_BYTES)
    const expectedHash = createHash('sha256').update(await readFile(source)).digest('hex')
    expect(database.getDocument(result.document.id)?.sha256).toBe(expectedHash)
    expect(createHash('sha256').update(await readFile(join(library, `${result.document.id}.pdf`))).digest('hex')).toBe(expectedHash)
    expect(validator).toHaveBeenCalledTimes(1)
    expect(await libraryFiles()).toEqual([`${result.document.id}.pdf`])
    observed.exactBoundary = { bytes: result.document.byteSize, sha256: expectedHash, pageValidator: 'test stub returning 3; PDF.js not exercised' }
  }, 30000)

  it('100 MiB 加 1 字节在页数校验之前拒绝，随后正常文件可重试', async () => {
    await truncate(source, MAX_PDF_BYTES + 1)
    const validator = vi.fn(validatePdf)
    service = new DocumentService(database, library, validator)
    await expect(service.importFile(source)).rejects.toThrow('不能超过 100 MiB')
    expect(validator).not.toHaveBeenCalled()
    await copyFile(fixture, source)
    await assertEmptyAndRetry()
  })

  it.each(['shrink', 'grow', 'same-size-rewrite'] as const)('真实文件变化 %s：拒绝、不留副本、句柄关闭后可重试', async mode => {
    let triggered = false
    let handle: FileHandle | undefined
    faults.opened = (path, flags, actualHandle) => {
      if (path !== source || flags !== constants.O_RDONLY) return actualHandle
      handle = actualHandle
      return overrideHandle(actualHandle, {
        read: (async (...args: Parameters<FileHandle['read']>) => {
          if (!triggered) {
            triggered = true
            if (mode === 'shrink') await truncate(source, 8)
            if (mode === 'grow') await appendFile(source, '\n% appended during snapshot\n')
            if (mode === 'same-size-rewrite') {
              const contents = await readFile(source)
              contents[contents.length - 1] = contents[contents.length - 1] === 10 ? 32 : 10
              const before = await stat(source)
              await writeFile(source, contents)
              await utimes(source, before.atime, new Date(before.mtimeMs + 2000))
            }
          }
          return actualHandle.read(...args)
        }) as FileHandle['read']
      })
    }
    await expect(service.importFile(source)).rejects.toThrow('读取过程中发生变化')
    expect(triggered).toBe(true)
    expect(handle?.fd).toBe(-1)
    await copyFile(fixture, source)
    await assertEmptyAndRetry()
  })

  it('快照完成后源文件改变，落盘内容与哈希仍来自同一原快照', async () => {
    const original = await readFile(source)
    service = new DocumentService(database, library, async bytes => {
      await writeFile(source, '%PDF-1.7\nchanged after snapshot')
      return validatePdf(bytes)
    })
    const result = await service.importFile(source)
    expect(Buffer.from(await service.readPdfBytes(result.document.id))).toEqual(original)
    expect(database.getDocument(result.document.id)?.sha256).toBe(createHash('sha256').update(original).digest('hex'))
  })
})

describe('注入文件系统故障后的清理与队列恢复', () => {
  it.each([
    ['partial-write', 'ENOSPC', '磁盘空间不足'],
    ['fsync', 'EIO', '磁盘错误'],
    ['rename', 'EPERM', '文件可能被占用']
  ] as const)('%s 注入 %s，清理临时及正式副本并可重试', async (stage, code, message) => {
    const original = await readFile(source)
    let triggered = false
    faults.opened = (path, _flags, handle) => {
      if (!path.endsWith('.tmp')) return handle
      if (stage === 'partial-write') return overrideHandle(handle, {
        writeFile: async () => {
          await handle.writeFile(original.subarray(0, 16))
          triggered = true
          throw fault(code)
        }
      })
      if (stage === 'fsync') return overrideHandle(handle, { sync: async () => { triggered = true; throw fault(code) } })
      return handle
    }
    if (stage === 'rename') faults.rename = () => { triggered = true; throw fault(code) }
    await expect(service.importFile(source)).rejects.toThrow(message)
    expect(triggered).toBe(true)
    expect(await readFile(source)).toEqual(original)
    await assertEmptyAndRetry()
  })

  it('临时文件创建失败 EACCES 不落盘、不入库，解除后可重试', async () => {
    await mkdir(library)
    faults.beforeOpen = path => { if (path.endsWith('.tmp')) throw fault('EACCES') }
    await expect(service.importFile(source)).rejects.toThrow('没有读取权限')
    await assertEmptyAndRetry()
  })

  it('注入清理失败时报告无法清理并保留临时副本证据，随后人工移除', async () => {
    faults.opened = (path, _flags, handle) => path.endsWith('.tmp')
      ? overrideHandle(handle, { writeFile: async () => { await handle.writeFile('%PDF-1.7'); throw fault('ENOSPC') } })
      : handle
    faults.unlink = path => { if (path.endsWith('.tmp')) throw fault('EPERM') }
    await expect(service.importFile(source)).rejects.toThrow('无法清理文献库中的临时副本')
    expect(database.listDocuments()).toEqual([])
    const leftovers = await libraryFiles()
    expect(leftovers).toHaveLength(1)
    expect(leftovers[0]).toMatch(/^\.[a-f0-9-]+\.tmp$/)
    observed.cleanupFailure = { mechanism: 'injected ENOSPC + unlink EPERM', leftoverName: leftovers[0], leftoverBytes: (await stat(join(library, leftovers[0]))).size }
    resetFaults()
    await rm(join(library, leftovers[0]))
    await assertEmptyAndRetry()
  })
})

describe('真实 SQLite 拒绝、关闭再开与未支持的恢复边界', () => {
  it('真实 SQLite 触发器拒绝插入后清理已重命名副本，移除触发器后可重试', async () => {
    const inspection = new Sqlite(databasePath)
    try {
      inspection.exec("CREATE TRIGGER verification_reject BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'verification SQLite rejection'); END")
      await expect(service.importFile(source)).rejects.toThrow('verification SQLite rejection')
      expect(database.listDocuments()).toEqual([])
      expect(await libraryFiles()).toEqual([])
      inspection.exec('DROP TRIGGER verification_reject')
    } finally { inspection.close() }
    await assertEmptyAndRetry()
  })

  it('SQLite 插入注入 SQLITE_FULL 时应给出可理解的磁盘空间提示', async () => {
    vi.spyOn(database, 'insertDocument').mockImplementationOnce(() => { throw fault('SQLITE_FULL', 'database or disk is full') })
    let rejection: unknown
    try { await service.importFile(source) } catch (error: unknown) { rejection = error }
    observed.sqliteFull = { mechanism: 'injected insertDocument SQLITE_FULL; no actual disk fill', message: rejection instanceof Error ? rejection.message : String(rejection) }
    expect(rejection).toBeInstanceOf(Error)
    await assertEmptyAndRetry()
    // Keep this assertion red if the service exposes the raw SQLite message.
    expect((rejection as Error).message).toMatch(/磁盘空间不足|存储空间不足/)
  })

  it('正常关闭再开保留文献/阅读状态，读回哈希一致且 integrity_check 为 ok', async () => {
    const imported = await service.importFile(source)
    database.saveReaderState({ documentId: imported.document.id, pageNumber: 2, scale: 1.75, updatedAt: new Date().toISOString() })
    database.close()
    database = new LibraryDatabase(databasePath)
    service = new DocumentService(database, library, validatePdf)
    expect(database.listDocuments()).toEqual([imported.document])
    expect(database.getReaderState(imported.document.id)).toMatchObject({ pageNumber: 2, scale: 1.75 })
    const bytes = await service.readPdfBytes(imported.document.id)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(database.getDocument(imported.document.id)?.sha256)
    const inspection = new Sqlite(databasePath, { readonly: true })
    try {
      expect(inspection.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(inspection.pragma('user_version', { simple: true })).toBe(4)
      observed.normalReopen = { integrityCheck: 'ok', userVersion: 4, page: 2, scale: 1.75 }
    } finally { inspection.close() }
  })

  it('观察边界：启动不会自动清理注入的孤立副本与临时文件', async () => {
    await mkdir(library)
    const orphan = '11111111-1111-4111-8111-111111111111.pdf'
    const pending = '.22222222-2222-4222-8222-222222222222.tmp'
    await copyFile(source, join(library, orphan))
    await writeFile(join(library, pending), '%PDF-1.7')
    database.close()
    database = new LibraryDatabase(databasePath)
    service = new DocumentService(database, library, validatePdf)
    expect(database.listDocuments()).toEqual([])
    expect((await libraryFiles()).sort()).toEqual([orphan, pending].sort())
    observed.orphanRecovery = { mechanism: 'manually constructed orphan and tmp; no power cut', removedOnOpen: false, indexedOnOpen: false }
  })
})
