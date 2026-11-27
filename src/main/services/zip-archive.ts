import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { hasControlCharacters } from '../../shared/contracts'

export interface ZipInputEntry {
  name: string
  data: Uint8Array
  compress?: boolean
}

export interface ZipEntrySize {
  name: string
  byteLength: number
  compress?: boolean
}

export interface ZipArchiveLimits {
  maxArchiveBytes: number
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
}

/** 与备份 IPC、writer、reader 共用；调用选项只能收紧这些安全上限。 */
export const ZIP_ARCHIVE_LIMITS: Readonly<ZipArchiveLimits> = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 5000,
  // 旧 reader 允许单条占满总额度，保留该合法旧包边界。
  maxEntryBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024
})

export interface ReadZipOptions {
  maxArchiveBytes?: number
  maxEntries?: number
  maxEntryBytes?: number
  maxTotalBytes?: number
}

function zipLimits(options?: ReadZipOptions): ZipArchiveLimits {
  const limits = { ...ZIP_ARCHIVE_LIMITS }
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    const requested = options?.[key]
    if (requested === undefined) continue
    if (!Number.isSafeInteger(requested) || requested < 0) throw new Error('ZIP 安全限制必须为非负整数。')
    limits[key] = Math.min(requested, limits[key])
  }
  return limits
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)) + ' MiB' : bytes + ' B'
}

function checkArchiveBytes(byteLength: number, maximum: number): void {
  if (byteLength > maximum) throw new Error('备份压缩包体积超出安全限制（最大 ' + formatLimit(maximum) + '）。请减少导出内容。')
}

function checkEntryBytes(byteLength: number, maximum: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximum) {
    throw new Error('备份压缩包单个条目体积超出安全限制（最大 ' + formatLimit(maximum) + '）。')
  }
}

function checkTotalBytes(byteLength: number, maximum: number): void {
  if (byteLength > maximum) throw new Error('备份压缩包解压后体积超出安全限制（最大 ' + formatLimit(maximum) + '）。')
}

/** 不读取载荷即可预检；STORE 载荷与 ZIP 头的下界已超限时立即失败。 */
export function assertZipInputLimits(entries: readonly ZipEntrySize[], options?: ReadZipOptions): void {
  const limits = zipLimits(options)
  if (entries.length > limits.maxEntries) throw new Error('备份压缩包条目数过多（超过 ' + limits.maxEntries + ' 项）。')
  const names = new Set<string>()
  let totalBytes = 0
  let minimumArchiveBytes = 22
  for (const entry of entries) {
    const name = validateZipEntryName(entry.name)
    const nameBytes = Buffer.byteLength(name, 'utf8')
    if (nameBytes > 65535) throw new Error('压缩包条目名称过长，无法保存为标准 ZIP。')
    if (names.has(name)) throw new Error('压缩包包含重复条目名称：「' + name + '」。')
    names.add(name)
    checkEntryBytes(entry.byteLength, limits.maxEntryBytes)
    totalBytes += entry.byteLength
    checkTotalBytes(totalBytes, limits.maxTotalBytes)
    minimumArchiveBytes += 76 + 2 * nameBytes
    if (entry.compress === false || entry.byteLength <= 64) minimumArchiveBytes += entry.byteLength
  }
  checkArchiveBytes(minimumArchiveBytes, limits.maxArchiveBytes)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function computeCrc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function validateZipEntryName(rawName: string): string {
  const trimmed = rawName.trim()
  if (!trimmed || hasControlCharacters(trimmed)) throw new Error('压缩包条目名称无效：「' + rawName + '」')
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error('压缩包条目路径不安全：「' + rawName + '」')
  }
  const normalized = trimmed.replace(/\/+$/, '')
  if (!normalized) throw new Error('压缩包条目路径无效：「' + rawName + '」')
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || segment === '..') throw new Error('压缩包包含越权路径条目：「' + rawName + '」')
  }
  return normalized
}

function toDosTimeDate(date = new Date()): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()))
  const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f)
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { dosTime, dosDate }
}

/** 构造标准 PKZIP 归档；预检后才计算 CRC、压缩和分配最终缓冲区。 */
export function createZipBuffer(entries: readonly ZipInputEntry[], options?: ReadZipOptions): Buffer {
  const limits = zipLimits(options)
  if (entries.length > limits.maxEntries) throw new Error('备份压缩包条目数过多（超过 ' + limits.maxEntries + ' 项）。')
  assertZipInputLimits(entries.map(entry => ({ name: entry.name, byteLength: entry.data.byteLength, compress: entry.compress })), options)
  const { dosTime, dosDate } = toDosTimeDate()
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0
  let archiveBytes = 22

  for (const entry of entries) {
    const nameBuf = Buffer.from(validateZipEntryName(entry.name), 'utf8')
    const rawData = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength)
    const crc = computeCrc32(rawData)
    let payload = rawData
    if (entry.compress !== false && rawData.length > 64) {
      const available = limits.maxArchiveBytes - archiveBytes - 76 - 2 * nameBuf.length
      checkArchiveBytes(archiveBytes + 76 + 2 * nameBuf.length, limits.maxArchiveBytes)
      try {
        payload = deflateRawSync(rawData, { level: 6, maxOutputLength: Math.max(1, Math.min(rawData.length, available)) })
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE')) throw error
        // 压缩不划算时使用 STORE；若 STORE 也超限则不保留超大压缩缓冲区。
        checkArchiveBytes(archiveBytes + 76 + 2 * nameBuf.length + rawData.length, limits.maxArchiveBytes)
      }
    }
    const method = payload.length < rawData.length ? 8 : 0
    const body = method === 8 ? payload : rawData
    archiveBytes += 76 + 2 * nameBuf.length + body.length
    checkArchiveBytes(archiveBytes, limits.maxArchiveBytes)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(body.length, 18)
    localHeader.writeUInt32LE(rawData.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localChunks.push(localHeader, nameBuf, body)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(body.length, 20)
    centralHeader.writeUInt32LE(rawData.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    centralChunks.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + body.length
  }

  const centralDir = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localChunks, centralDir, eocd], archiveBytes)
}

interface ZipReadEntry {
  name: string
  method: number
  expectedCrc: number
  uncompressedSize: number
  dataStart: number
  dataEnd: number
}

/** 先校验全目录及所有额度，再解压任何载荷，避免超限包造成部分巨量分配。 */
export function readZipBuffer(input: Uint8Array, options?: ReadZipOptions): Map<string, Buffer> {
  const limits = zipLimits(options)
  checkArchiveBytes(input.byteLength, limits.maxArchiveBytes)
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (buf.length < 22) throw new Error('备份文件损坏或不是有效的 ZIP 压缩包。')
  let eocdOffset = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) throw new Error('无法读取备份压缩包目录索引：文件可能已损坏。')
  const entryCount = buf.readUInt16LE(eocdOffset + 10)
  const centralSize = buf.readUInt32LE(eocdOffset + 12)
  const centralOffset = buf.readUInt32LE(eocdOffset + 16)
  if (entryCount > limits.maxEntries) throw new Error('备份压缩包条目数过多（超过 ' + limits.maxEntries + ' 项）。')
  if (centralOffset + centralSize > eocdOffset) throw new Error('备份压缩包目录结构越界。')

  const entries: ZipReadEntry[] = []
  let totalUncompressed = 0
  let ptr = centralOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (ptr + 46 > centralOffset + centralSize || buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('备份压缩包中央目录项损坏。')
    const flags = buf.readUInt16LE(ptr + 8)
    const method = buf.readUInt16LE(ptr + 10)
    const expectedCrc = buf.readUInt32LE(ptr + 16)
    const compressedSize = buf.readUInt32LE(ptr + 20)
    const uncompressedSize = buf.readUInt32LE(ptr + 24)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localHeaderOffset = buf.readUInt32LE(ptr + 42)
    ptr += 46
    if (ptr + nameLen + extraLen + commentLen > centralOffset + centralSize) throw new Error('备份压缩包条目头越界。')
    const rawName = buf.subarray(ptr, ptr + nameLen).toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1')
    ptr += nameLen + extraLen + commentLen
    const safeName = validateZipEntryName(rawName)
    if ((flags & 0x0001) !== 0) throw new Error('暂不支持导入加密的 ZIP 压缩包。')
    // 目录项没有可恢复的文件载荷；仍校验目录名称和条目总数。
    if (rawName.endsWith('/')) continue
    checkEntryBytes(uncompressedSize, limits.maxEntryBytes)
    totalUncompressed += uncompressedSize
    checkTotalBytes(totalUncompressed, limits.maxTotalBytes)
    if (localHeaderOffset + 30 > centralOffset || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error('压缩包条目「' + safeName + '」本地头损坏。')
    const dataStart = localHeaderOffset + 30 + buf.readUInt16LE(localHeaderOffset + 26) + buf.readUInt16LE(localHeaderOffset + 28)
    const dataEnd = dataStart + compressedSize
    if (dataEnd > centralOffset) throw new Error('压缩包条目「' + safeName + '」数据区越界。')
    if (method !== 0 && method !== 8) throw new Error('压缩包条目「' + safeName + '」使用了不支持的压缩方式 (' + method + ')。')
    entries.push({ name: safeName, method, expectedCrc, uncompressedSize, dataStart, dataEnd })
  }

  const files = new Map<string, Buffer>()
  for (const entry of entries) {
    const compressed = buf.subarray(entry.dataStart, entry.dataEnd)
    const out = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) })
    if (out.length !== entry.uncompressedSize || computeCrc32(out) !== entry.expectedCrc) throw new Error('压缩包条目「' + entry.name + '」校验失败（CRC 或长度不匹配）。')
    files.set(entry.name, out)
  }
  return files
}
