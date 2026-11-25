import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { hasControlCharacters } from '../../shared/contracts'

export interface ZipInputEntry {
  name: string
  data: Uint8Array
  compress?: boolean
}

export interface ReadZipOptions {
  maxEntries?: number
  maxTotalBytes?: number
}

const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024 // 1 GiB

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

export function computeCrc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function validateZipEntryName(rawName: string): string {
  const trimmed = rawName.trim()
  if (!trimmed || hasControlCharacters(trimmed)) {
    throw new Error(`压缩包条目名称无效：「${rawName}」`)
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error(`压缩包条目路径不安全：「${rawName}」`)
  }
  const normalized = trimmed.replace(/\/+$/, '')
  if (!normalized) {
    throw new Error(`压缩包条目路径无效：「${rawName}」`)
  }
  const segments = normalized.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error(`压缩包包含越权路径条目：「${rawName}」`)
    }
  }
  return normalized
}

function toDosTimeDate(date = new Date()): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()))
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const seconds = Math.floor(date.getSeconds() / 2)
  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f)
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f)
  return { dosTime, dosDate }
}

/** 构造标准 PKZIP 归档（支持 UTF-8 文件名、STORE 与 DEFLATE）。 */
export function createZipBuffer(entries: readonly ZipInputEntry[]): Buffer {
  const { dosTime, dosDate } = toDosTimeDate()
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const cleanName = validateZipEntryName(entry.name)
    const nameBuf = Buffer.from(cleanName, 'utf8')
    const rawData = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength)
    const crc = computeCrc32(rawData)
    const useDeflate = entry.compress !== false && rawData.length > 64
    const payload = useDeflate ? deflateRawSync(rawData, { level: 6 }) : rawData
    const method = useDeflate && payload.length < rawData.length ? 8 : 0
    const body = method === 8 ? payload : rawData

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed: 2.0
    localHeader.writeUInt16LE(0x0800, 6) // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(body.length, 18)
    localHeader.writeUInt32LE(rawData.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)

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
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    centralChunks.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + body.length
  }

  const centralDir = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, centralDir, eocd])
}

/** 安全读取标准 PKZIP 归档，防止 Zip-Slip 与超限解压膨胀。 */
export function readZipBuffer(input: Uint8Array, options?: ReadZipOptions): Map<string, Buffer> {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (buf.length < 22) {
    throw new Error('备份文件损坏或不是有效的 ZIP 压缩包。')
  }

  let eocdOffset = -1
  const minSearch = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= minSearch; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20)
      if (i + 22 + commentLen === buf.length) {
        eocdOffset = i
        break
      }
    }
  }
  if (eocdOffset === -1) {
    throw new Error('无法读取备份压缩包目录索引：文件可能已损坏。')
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10)
  const centralSize = buf.readUInt32LE(eocdOffset + 12)
  const centralOffset = buf.readUInt32LE(eocdOffset + 16)
  if (entryCount > maxEntries) {
    throw new Error(`备份压缩包条目数过多（超过 ${maxEntries} 项）。`)
  }
  if (centralOffset + centralSize > eocdOffset) {
    throw new Error('备份压缩包目录结构越界。')
  }

  const files = new Map<string, Buffer>()
  let totalUncompressed = 0
  let ptr = centralOffset

  for (let i = 0; i < entryCount; i += 1) {
    if (ptr + 46 > eocdOffset || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('备份压缩包中央目录项损坏。')
    }
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

    if (ptr + nameLen + extraLen + commentLen > centralOffset + centralSize) {
      throw new Error('备份压缩包条目头越界。')
    }
    const rawName = buf.subarray(ptr, ptr + nameLen).toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1')
    ptr += nameLen + extraLen + commentLen

    // 目录占位项可跳过，其余必须通过安全路径校验
    if (rawName.endsWith('/')) continue
    const safeName = validateZipEntryName(rawName)

    if ((flags & 0x0001) !== 0) {
      throw new Error('暂不支持导入加密的 ZIP 压缩包。')
    }

    totalUncompressed += uncompressedSize
    if (totalUncompressed > maxTotalBytes) {
      throw new Error('备份压缩包解压后体积超出安全限制（1 GiB）。')
    }

    if (localHeaderOffset + 30 > centralOffset || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`压缩包条目「${safeName}」本地头损坏。`)
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26)
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen
    const dataEnd = dataStart + compressedSize
    if (dataEnd > centralOffset) {
      throw new Error(`压缩包条目「${safeName}」数据区越界。`)
    }

    const compressed = buf.subarray(dataStart, dataEnd)
    let out: Buffer
    if (method === 0) {
      out = Buffer.from(compressed)
    } else if (method === 8) {
      out = inflateRawSync(compressed, { maxOutputLength: Math.max(1024 * 1024, uncompressedSize + 4096) })
    } else {
      throw new Error(`压缩包条目「${safeName}」使用了不支持的压缩方式 (${method})。`)
    }

    if (out.length !== uncompressedSize || computeCrc32(out) !== expectedCrc) {
      throw new Error(`压缩包条目「${safeName}」校验失败（CRC 或长度不匹配）。`)
    }
    files.set(safeName, out)
  }

  return files
}
