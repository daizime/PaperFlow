import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

interface ZipAuditResult {
  symlinks: string[]
  executables: Set<string>
}

interface TarEntrySummary {
  path: string
  relPath: string
  typeflag: string
  mode: number
  size: number
  isElf: boolean
}

const TAR_BLOCK_SIZE = 512
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const

function sha256Buffer(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath)
  return sha256Buffer(bytes)
}

function normalizeMirrorBase(mirror: string): string {
  return mirror.endsWith('/') ? mirror : `${mirror}/`
}

async function downloadWithSha256(url: string, targetPath: string, expectedSha256: string): Promise<void> {
  const tmpPath = `${targetPath}.${process.pid}.tmp`
  await mkdir(dirname(targetPath), { recursive: true })
  await rm(tmpPath, { force: true })

  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} (${response.statusText})`)
  }

  const hash = createHash('sha256')
  const reader = response.body.getReader()
  const handle = await open(tmpPath, 'w', 0o644)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        hash.update(value)
        await handle.write(value, 0, value.byteLength)
      }
    }
    await handle.sync()
  } catch (error: unknown) {
    await handle.close().catch(() => {})
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()

  const actualSha256 = hash.digest('hex')
  if (actualSha256 !== expectedSha256) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw new Error(`SHA-256 校验失败: expected=${expectedSha256}, actual=${actualSha256}`)
  }

  await rm(targetPath, { force: true }).catch(() => {})
  await rename(tmpPath, targetPath)
}

async function ensureLinuxElectronZip(version: string, expectedSha256: string): Promise<string> {
  const zipName = `electron-v${version}-linux-x64.zip`
  const cacheDir = resolve('.cache/electron-dist')
  const zipPath = join(cacheDir, zipName)

  try {
    const info = await stat(zipPath)
    if (info.isFile() && (await sha256File(zipPath)) === expectedSha256) {
      return zipPath
    }
  } catch {
    // 缓存不存在或失效时重新下载并校验。
  }

  const candidates: string[] = []
  const customMirror = process.env.ELECTRON_MIRROR?.trim()
  if (customMirror) {
    const base = normalizeMirrorBase(customMirror)
    candidates.push(`${base}${version}/${zipName}`, `${base}v${version}/${zipName}`)
  }
  candidates.push(
    `https://npmmirror.com/mirrors/electron/${version}/${zipName}`,
    `https://github.com/electron/electron/releases/download/v${version}/${zipName}`
  )

  const errors: string[] = []
  for (const url of candidates) {
    try {
      console.log(`[dist:linux] 下载 ${zipName} <- ${url}`)
      await downloadWithSha256(url, zipPath, expectedSha256)
      console.log(`[dist:linux] SHA-256 校验通过: ${expectedSha256}`)
      return zipPath
    } catch (error: unknown) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(`无法下载并校验 ${zipName}:\n${errors.join('\n')}`)
}

async function inspectZipUnixMetadata(zipPath: string, executableName: string): Promise<ZipAuditResult> {
  const buf = await readFile(zipPath)
  const minEocdOffset = Math.max(0, buf.length - 65557)
  let eocdOffset = -1
  for (let pos = buf.length - 22; pos >= minEocdOffset; pos--) {
    if (buf.readUInt32LE(pos) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(pos + 20)
      if (pos + 22 + commentLen === buf.length) {
        eocdOffset = pos
        break
      }
    }
  }
  if (eocdOffset < 0) {
    throw new Error(`ZIP EOCD 未找到: ${zipPath}`)
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10)
  const cdSize = buf.readUInt32LE(eocdOffset + 12)
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error(`不支持 ZIP64 Central Directory: ${zipPath}`)
  }

  const symlinks: string[] = []
  const executables = new Set<string>()
  let cursor = cdOffset

  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`ZIP Central Directory 损坏 (entry=${index})`)
    }
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const externalAttrs = buf.readUInt32LE(cursor + 38)
    const rawName = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8').replaceAll('\\', '/')
    cursor += 46 + nameLen + extraLen + commentLen

    const unixMode = (externalAttrs >>> 16) & 0o177777
    const fileType = unixMode & 0o170000
    if (fileType === 0o120000) {
      symlinks.push(rawName)
      continue
    }
    const isDir = rawName.endsWith('/') || fileType === 0o040000
    if (!isDir && (unixMode & 0o111) !== 0) {
      const normalized = rawName.replace(/^\.\//, '')
      executables.add(normalized === 'electron' ? executableName : normalized)
    }
  }

  if (cursor > cdOffset + cdSize) {
    throw new Error(`ZIP Central Directory 越界: ${cursor} > ${cdOffset + cdSize}`)
  }

  return { symlinks, executables }
}

function readCString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8')
}

function parseTarNumber(field: Buffer): number {
  if (field.length > 0 && (field[0] & 0x80) !== 0) {
    let value = 0
    for (let index = 1; index < field.length; index++) {
      value = value * 256 + field[index]
    }
    return value
  }
  const text = readCString(field, 0, field.length).trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`非法 TAR 八进制字段: "${text}"`)
  }
  return Number.parseInt(text, 8)
}

function computeTarChecksum(header: Buffer): number {
  let sum = 0
  for (let index = 0; index < TAR_BLOCK_SIZE; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  return sum
}

function isZeroBlock(block: Buffer): boolean {
  for (let index = 0; index < block.length; index++) {
    if (block[index] !== 0) return false
  }
  return true
}

function parsePaxRecords(payload: Buffer): Record<string, string> {
  const attrs: Record<string, string> = {}
  let cursor = 0
  while (cursor < payload.length) {
    const space = payload.indexOf(0x20, cursor)
    if (space === -1) break
    const recordLength = Number.parseInt(payload.subarray(cursor, space).toString('ascii'), 10)
    if (!Number.isFinite(recordLength) || recordLength <= 0 || cursor + recordLength > payload.length) {
      break
    }
    const line = payload.subarray(space + 1, cursor + recordLength - 1).toString('utf8')
    const eq = line.indexOf('=')
    if (eq > 0) {
      attrs[line.slice(0, eq)] = line.slice(eq + 1)
    }
    cursor += recordLength
  }
  return attrs
}

function writeTarModeAndChecksum(header: Buffer, mode: number): void {
  const modeStr = `${(mode & 0o7777).toString(8).padStart(7, '0')}\0`
  header.write(modeStr, 100, 8, 'ascii')
  const checksum = computeTarChecksum(header)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
}

function isElfPayload(payload: Buffer): boolean {
  return (
    payload.length >= 4 &&
    payload[0] === ELF_MAGIC[0] &&
    payload[1] === ELF_MAGIC[1] &&
    payload[2] === ELF_MAGIC[2] &&
    payload[3] === ELF_MAGIC[3]
  )
}

function stripTopLevelDir(normalizedPath: string): string {
  const slash = normalizedPath.indexOf('/')
  return slash === -1 ? '' : normalizedPath.slice(slash + 1)
}

function shouldBeExecutable(relPath: string, executables: ReadonlySet<string>, isElf: boolean): boolean {
  if (isElf || executables.has(relPath)) return true
  if (/^(paperflow|paperflow\.bin|chrome-sandbox|chrome_crashpad_handler)$/.test(relPath)) return true
  if (/\.so(\.\d+)*$/.test(relPath)) return true
  if (/\.node$/.test(relPath)) return true
  return false
}

async function normalizeTarGzModes(tarGzPath: string, executables: ReadonlySet<string>): Promise<void> {
  const compressed = await readFile(tarGzPath)
  const tarBuf = Buffer.from(gunzipSync(compressed))
  let offset = 0
  let pendingPax: Record<string, string> | null = null

  while (offset + TAR_BLOCK_SIZE <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + TAR_BLOCK_SIZE)
    if (isZeroBlock(header)) break

    const storedChecksum = parseTarNumber(header.subarray(148, 156))
    const actualChecksum = computeTarChecksum(header)
    if (storedChecksum !== actualChecksum) {
      throw new Error(`TAR 头部校验和无效 (offset=${offset}): stored=${storedChecksum}, actual=${actualChecksum}`)
    }

    const typeflag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    const rawSize = parseTarNumber(header.subarray(124, 136))

    if (typeflag === 'x') {
      const payload = tarBuf.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE + rawSize)
      pendingPax = { ...(pendingPax ?? {}), ...parsePaxRecords(payload) }
      offset += TAR_BLOCK_SIZE + Math.ceil(rawSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
      continue
    }

    if (typeflag === 'g') {
      offset += TAR_BLOCK_SIZE + Math.ceil(rawSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
      continue
    }

    const pax = pendingPax
    pendingPax = null
    const size = pax?.size && /^\d+$/.test(pax.size) ? Number(pax.size) : rawSize
    const prefix = readCString(header, 345, 155)
    const baseName = readCString(header, 0, 100)
    const rawPath = pax?.path ?? (prefix ? `${prefix}/${baseName}` : baseName)
    const normalized = rawPath.replace(/^\.\//, '')
    const relPath = stripTopLevelDir(normalized)
    const payload = tarBuf.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE + size)

    if (typeflag === '5') {
      writeTarModeAndChecksum(header, 0o755)
    } else if (typeflag === '0') {
      const mode = shouldBeExecutable(relPath, executables, isElfPayload(payload)) ? 0o755 : 0o644
      writeTarModeAndChecksum(header, mode)
    }

    offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
  }

  const rebuilt = gzipSync(tarBuf, { level: 9 })
  const tmpPath = `${tarGzPath}.${process.pid}.tmp`
  await rm(tmpPath, { force: true })
  const handle = await open(tmpPath, 'w', 0o644)
  try {
    await handle.writeFile(rebuilt)
    await handle.sync()
  } catch (error: unknown) {
    await handle.close().catch(() => {})
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  await rm(tarGzPath, { force: true })
  await rename(tmpPath, tarGzPath)
}

async function verifyTarGzArchive(tarGzPath: string): Promise<{ topDir: string; entries: TarEntrySummary[] }> {
  const compressed = await readFile(tarGzPath)
  const tarBuf = Buffer.from(gunzipSync(compressed))
  const entries: TarEntrySummary[] = []
  let offset = 0
  let pendingPax: Record<string, string> | null = null
  let topDir = ''
  let launcherVerified = false

  while (offset + TAR_BLOCK_SIZE <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + TAR_BLOCK_SIZE)
    if (isZeroBlock(header)) break

    const storedChecksum = parseTarNumber(header.subarray(148, 156))
    const actualChecksum = computeTarChecksum(header)
    if (storedChecksum !== actualChecksum) {
      throw new Error(`最终 TAR 头部校验失败 (offset=${offset})`)
    }

    const typeflag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    const rawSize = parseTarNumber(header.subarray(124, 136))

    if (typeflag === 'x') {
      const payload = tarBuf.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE + rawSize)
      pendingPax = { ...(pendingPax ?? {}), ...parsePaxRecords(payload) }
      offset += TAR_BLOCK_SIZE + Math.ceil(rawSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
      continue
    }

    if (typeflag === 'g') {
      offset += TAR_BLOCK_SIZE + Math.ceil(rawSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
      continue
    }

    const pax = pendingPax
    pendingPax = null
    const size = pax?.size && /^\d+$/.test(pax.size) ? Number(pax.size) : rawSize
    const prefix = readCString(header, 345, 155)
    const baseName = readCString(header, 0, 100)
    const rawPath = pax?.path ?? (prefix ? `${prefix}/${baseName}` : baseName)
    const normalized = rawPath.replace(/^\.\//, '')
    const firstSegment = normalized.split('/')[0] ?? ''
    if (!topDir && firstSegment) topDir = firstSegment
    const relPath = stripTopLevelDir(normalized)
    const mode = parseTarNumber(header.subarray(100, 108)) & 0o7777
    const payload = tarBuf.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE + size)

    if (typeflag === '0' && relPath === 'paperflow') {
      if (!payload.subarray(0, 10).toString('utf8').startsWith('#!/bin/sh\n') || payload.includes(0x0d)) {
        throw new Error('Linux 启动脚本 paperflow 格式无效：缺少 #!/bin/sh LF 头或包含 CR 换行符')
      }
      launcherVerified = true
    }

    entries.push({
      path: normalized,
      relPath,
      typeflag,
      mode,
      size,
      isElf: isElfPayload(payload)
    })

    offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
  }

  const byRelPath = new Map<string, TarEntrySummary>()
  for (const entry of entries) {
    if (entry.relPath) byRelPath.set(entry.relPath, entry)
  }

  const requiredChecks: Array<{ relPath: string; mode: number; expectElf: boolean }> = [
    { relPath: 'paperflow', mode: 0o755, expectElf: false },
    { relPath: 'paperflow.bin', mode: 0o755, expectElf: true },
    { relPath: 'chrome-sandbox', mode: 0o755, expectElf: true },
    { relPath: 'chrome_crashpad_handler', mode: 0o755, expectElf: true },
    { relPath: 'resources/app.asar', mode: 0o644, expectElf: false },
    {
      relPath: 'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node',
      mode: 0o755,
      expectElf: true
    }
  ]

  for (const check of requiredChecks) {
    const found = byRelPath.get(check.relPath)
    if (!found) {
      throw new Error(`Linux 包缺少必需文件: ${check.relPath}`)
    }
    if (found.mode !== check.mode) {
      throw new Error(
        `Linux 包权限异常 (${check.relPath}): expected=0${check.mode.toString(8)}, actual=0${found.mode.toString(8)}`
      )
    }
    if (check.expectElf && !found.isElf) {
      throw new Error(`Linux 包 ELF 魔数校验失败: ${check.relPath}`)
    }
  }
  if (!launcherVerified) {
    throw new Error('Linux 包未校验到有效 POSIX 启动脚本 paperflow')
  }

  return { topDir, entries }
}

async function main(): Promise<void> {
  const pkgRaw = await readFile(resolve('package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw) as { version: string }
  const electronPkg = JSON.parse(await readFile(resolve('node_modules/electron/package.json'), 'utf8')) as {
    version: string
  }
  const checksums = JSON.parse(await readFile(resolve('node_modules/electron/checksums.json'), 'utf8')) as Record<
    string,
    string
  >

  const zipKey = `electron-v${electronPkg.version}-linux-x64.zip`
  const expectedSha256 = checksums[zipKey]
  if (!expectedSha256) {
    throw new Error(`node_modules/electron/checksums.json 缺少 ${zipKey}`)
  }

  const zipPath = await ensureLinuxElectronZip(electronPkg.version, expectedSha256)
  const zipAudit = await inspectZipUnixMetadata(zipPath, 'paperflow.bin')
  if (zipAudit.symlinks.length > 0 && process.platform === 'win32') {
    throw new Error(
      `Electron Linux ZIP 包含符号链接，Windows NTFS 解压可能失真:\n${zipAudit.symlinks.join('\n')}`
    )
  }

  const require = createRequire(import.meta.url)
  const builderCli = join(dirname(require.resolve('electron-builder/package.json')), 'cli.js')
  const builderArgs = [builderCli, '--linux', 'tar.gz', '--x64', '--publish', 'never']
  if (process.platform !== 'linux') {
    builderArgs.push(`-c.electronDist=${zipPath}`)
  }

  console.log(`[dist:linux] 运行 electron-builder: ${builderArgs.slice(1).join(' ')}`)
  const result = spawnSync(process.execPath, builderArgs, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`electron-builder 失败，退出码: ${result.status ?? 'null'}`)
  }

  const artifactRel = `release/PaperFlow-${pkg.version}-linux-x64.tar.gz`
  const artifactPath = resolve(artifactRel)
  const artifactInfo = await stat(artifactPath)
  if (!artifactInfo.isFile()) {
    throw new Error(`未找到预期产物: ${artifactRel}`)
  }

  if (process.platform === 'win32') {
    console.log(`[dist:linux] 修正 Windows 跨平台打包的 POSIX 权限位...`)
    await normalizeTarGzModes(artifactPath, zipAudit.executables)
  }

  const verified = await verifyTarGzArchive(artifactPath)
  const finalBytes = (await stat(artifactPath)).size
  const finalSha256 = await sha256File(artifactPath)

  console.log(`[dist:linux] 产物校验完成: ${artifactRel}`)
  console.log(`[dist:linux] bytes=${finalBytes} sha256=${finalSha256}`)
  console.log(`[dist:linux] topDir=${verified.topDir} entries=${verified.entries.length}`)
}

void main().catch((error: unknown) => {
  console.error('[dist:linux] 失败:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
