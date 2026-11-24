import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DebCliOptions {
  fromTar: string
  output: string
  icon: string
  help: boolean
}

export const LINUX_DEB_DEPENDS =
  'libgtk-3-0t64 | libgtk-3-0, libnotify4, libnss3, libxtst6, xdg-utils, libatspi2.0-0t64 | libatspi2.0-0, libuuid1, libsecret-1-0, libgbm1, libasound2t64 | libasound2'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

const REQUIRED_PAYLOAD_PATHS = [
  'paperflow',
  'paperflow.bin',
  'chrome-sandbox',
  'resources/app.asar',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node'
] as const

const EXPECTED_DEB_MEMBERS = [
  './opt/PaperFlow/paperflow',
  './opt/PaperFlow/paperflow.bin',
  './opt/PaperFlow/chrome-sandbox',
  './opt/PaperFlow/resources/app.asar',
  './usr/bin/paperflow',
  './usr/share/applications/paperflow.desktop',
  './usr/share/icons/hicolor/256x256/apps/paperflow.png',
  './usr/share/pixmaps/paperflow.png'
] as const

/** 解析 `.deb` 打包命令行参数；`--from-tar`/`--output`/`--icon` 可省略，默认使用当前版本发行归档路径。 */
export function parseDebCliArgs(argv: readonly string[], version: string): DebCliOptions {
  const options: DebCliOptions = {
    fromTar: `release/PaperFlow-${version}-linux-x64.tar.gz`,
    output: `release/PaperFlow-${version}-linux-x64.deb`,
    icon: 'build/icon.png',
    help: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    if (arg === '--from-tar' || arg === '--output' || arg === '--icon') {
      const value = argv[i + 1]
      if (!value || value.startsWith('-')) {
        throw new Error(`参数 ${arg} 缺少有效路径值`)
      }
      if (arg === '--from-tar') options.fromTar = value
      else if (arg === '--output') options.output = value
      else options.icon = value
      i += 1
      continue
    }
    throw new Error(`未知参数: ${arg}`)
  }

  return options
}

/** 生成 `/usr/bin/paperflow` 包装脚本（避免符号链接导致 `$DIR` 解析偏离 `/opt/PaperFlow`）。 */
export function buildWrapperScript(): string {
  return '#!/bin/sh\nexec /opt/PaperFlow/paperflow "$@"\n'
}

/** 生成安装后注册桌面菜单与 PDF 打开关联的 FreeDesktop 条目。 */
export function buildDesktopEntry(): string {
  return [
    '[Desktop Entry]',
    'Name=PaperFlow',
    'Comment=面向科研论文的本地 PDF 阅读器',
    'GenericName=PDF Reader',
    'Exec=/opt/PaperFlow/paperflow %U',
    'Terminal=false',
    'Type=Application',
    'Icon=paperflow',
    'StartupWMClass=PaperFlow',
    'Categories=Office;Education;Science;',
    'MimeType=application/pdf;',
    ''
  ].join('\n')
}

/** 生成 `DEBIAN/control` 清单，校验版本号与 `Installed-Size` 合法性。 */
export function buildControlFile(version: string, installedSizeKiB: number): string {
  const normalizedVersion = version.trim()
  if (!normalizedVersion || !/^[0-9A-Za-z.+~-]+$/.test(normalizedVersion)) {
    throw new Error(`非法 Debian 版本号: "${version}"`)
  }
  if (!Number.isInteger(installedSizeKiB) || installedSizeKiB <= 0) {
    throw new Error(`非法 Installed-Size (KiB): ${installedSizeKiB}`)
  }

  return [
    'Package: paperflow',
    `Version: ${normalizedVersion}`,
    'Section: science',
    'Priority: optional',
    'Architecture: amd64',
    `Installed-Size: ${installedSizeKiB}`,
    'Maintainer: PaperFlow contributors <noreply@paperflow.local>',
    `Depends: ${LINUX_DEB_DEPENDS}`,
    'Description: PaperFlow local academic PDF reader',
    ' Offline local desktop PDF reader for scientific papers.',
    ''
  ].join('\n')
}

/** 生成 `DEBIAN/postinst`：为内置 Chromium `chrome-sandbox` 设置 root SUID 并刷新桌面/图标缓存。 */
export function buildPostinstScript(): string {
  return [
    '#!/bin/sh',
    'set -e',
    'if [ -f /opt/PaperFlow/chrome-sandbox ]; then',
    '  chown root:root /opt/PaperFlow/chrome-sandbox',
    '  chmod 4755 /opt/PaperFlow/chrome-sandbox',
    'fi',
    'if command -v update-desktop-database >/dev/null 2>&1; then',
    '  update-desktop-database -q /usr/share/applications || true',
    'fi',
    'if command -v gtk-update-icon-cache >/dev/null 2>&1; then',
    '  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true',
    'fi',
    ''
  ].join('\n')
}

/** 生成 `DEBIAN/postrm`：卸载后刷新桌面菜单与图标缓存。 */
export function buildPostrmScript(): string {
  return [
    '#!/bin/sh',
    'set -e',
    'if command -v update-desktop-database >/dev/null 2>&1; then',
    '  update-desktop-database -q /usr/share/applications || true',
    'fi',
    'if command -v gtk-update-icon-cache >/dev/null 2>&1; then',
    '  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true',
    'fi',
    ''
  ].join('\n')
}

/** 校验 PNG 魔数、IHDR 头与固定 `256×256` 图标尺寸。 */
export function validatePng256(buf: Uint8Array): { width: number; height: number } {
  if (buf.byteLength < 24) {
    throw new Error(`PNG 图标长度过短: ${buf.byteLength} B`)
  }
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (buf[i] !== PNG_MAGIC[i]) {
      throw new Error('文件头不是有效的 PNG 图标')
    }
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (
    buf[12] !== 0x49 || // 'I'
    buf[13] !== 0x48 || // 'H'
    buf[14] !== 0x44 || // 'D'
    buf[15] !== 0x52 // 'R'
  ) {
    throw new Error('PNG 图标缺少 IHDR 数据块')
  }
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  if (width !== 256 || height !== 256) {
    throw new Error(`应用图标尺寸须为 256×256，当前为 ${width}×${height}`)
  }
  return { width, height }
}

function runCommand(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) {
    throw new Error(`执行 ${command} 失败: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim()
    const stdout = (result.stdout || '').trim()
    throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status ?? 'null'}: ${stderr || stdout}`)
  }
  return result.stdout || ''
}

async function computeDirectoryBytes(dirPath: string): Promise<number> {
  let total = 0
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += await computeDirectoryBytes(fullPath)
    } else if (entry.isFile()) {
      total += (await stat(fullPath)).size
    }
  }
  return total
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

function printHelp(version: string): void {
  console.log(
    [
      '用法: tsx scripts/dist-linux-deb.ts [选项]',
      '',
      '基于同源 Linux .tar.gz 构建产物封装 Ubuntu/Debian amd64 .deb 安装包（不自动发布）。',
      '',
      '选项:',
      `  --from-tar <path>  输入 tar.gz 路径（默认: release/PaperFlow-${version}-linux-x64.tar.gz）`,
      `  --output <path>    输出 .deb 路径（默认: release/PaperFlow-${version}-linux-x64.deb）`,
      '  --icon <path>      256×256 PNG 图标路径（默认: build/icon.png）',
      '  -h, --help         显示本帮助并退出'
    ].join('\n')
  )
}

async function main(): Promise<void> {
  const pkgRaw = await readFile(resolve('package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw) as { version: string }
  const options = parseDebCliArgs(process.argv.slice(2), pkg.version)

  if (options.help) {
    printHelp(pkg.version)
    return
  }

  if (process.platform !== 'linux') {
    throw new Error(
      `dist-linux-deb 仅支持在 Ubuntu/Debian Linux 环境运行（当前平台: ${process.platform}）。请先在本地运行 pnpm dist:linux 生成 tar.gz，再将其传至 Ubuntu/Debian 后执行: tsx scripts/dist-linux-deb.ts --from-tar release/PaperFlow-${pkg.version}-linux-x64.tar.gz`
    )
  }

  runCommand('dpkg-deb', ['--version'])
  runCommand('tar', ['--version'])

  const fromTarPath = resolve(options.fromTar)
  const outputPath = resolve(options.output)
  const iconPath = resolve(options.icon)

  if (!(await stat(fromTarPath)).isFile()) {
    throw new Error(`未找到输入归档: ${fromTarPath}`)
  }
  const iconBytes = await readFile(iconPath)
  validatePng256(iconBytes)

  const workRoot = await mkdtemp(join(tmpdir(), 'paperflow-deb-'))
  try {
    const pkgDir = join(workRoot, 'pkg')
    const appDir = join(pkgDir, 'opt', 'PaperFlow')
    const usrBinDir = join(pkgDir, 'usr', 'bin')
    const desktopDir = join(pkgDir, 'usr', 'share', 'applications')
    const hicolorDir = join(pkgDir, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps')
    const pixmapsDir = join(pkgDir, 'usr', 'share', 'pixmaps')
    const debianDir = join(pkgDir, 'DEBIAN')

    await Promise.all([
      mkdir(appDir, { recursive: true }),
      mkdir(usrBinDir, { recursive: true }),
      mkdir(desktopDir, { recursive: true }),
      mkdir(hicolorDir, { recursive: true }),
      mkdir(pixmapsDir, { recursive: true }),
      mkdir(debianDir, { recursive: true })
    ])

    runCommand('tar', ['-xzf', fromTarPath, '--strip-components=1', '-C', appDir])

    for (const rel of REQUIRED_PAYLOAD_PATHS) {
      const target = join(appDir, rel)
      if (!(await stat(target)).isFile()) {
        throw new Error(`Linux 载荷缺少必需文件: ${rel}`)
      }
    }

    const launcherBuf = await readFile(join(appDir, 'paperflow'))
    if (!launcherBuf.subarray(0, 10).toString('utf8').startsWith('#!/bin/sh\n') || launcherBuf.includes(0x0d)) {
      throw new Error('Linux 载荷内的 paperflow 启动脚本缺少 #!/bin/sh LF 头或包含 CR 换行')
    }

    const asarSha256 = await sha256File(join(appDir, 'resources', 'app.asar'))

    const wrapperPath = join(usrBinDir, 'paperflow')
    await writeFile(wrapperPath, buildWrapperScript(), { encoding: 'utf8', mode: 0o755 })
    await chmod(wrapperPath, 0o755)

    const hicolorIcon = join(hicolorDir, 'paperflow.png')
    const pixmapIcon = join(pixmapsDir, 'paperflow.png')
    await copyFile(iconPath, hicolorIcon)
    await copyFile(iconPath, pixmapIcon)
    await chmod(hicolorIcon, 0o644)
    await chmod(pixmapIcon, 0o644)

    const desktopPath = join(desktopDir, 'paperflow.desktop')
    await writeFile(desktopPath, buildDesktopEntry(), { encoding: 'utf8', mode: 0o644 })
    await chmod(desktopPath, 0o644)

    const installedSizeKiB = Math.max(1, Math.ceil((await computeDirectoryBytes(pkgDir)) / 1024))
    const controlPath = join(debianDir, 'control')
    const postinstPath = join(debianDir, 'postinst')
    const postrmPath = join(debianDir, 'postrm')

    await writeFile(controlPath, buildControlFile(pkg.version, installedSizeKiB), { encoding: 'utf8', mode: 0o644 })
    await chmod(controlPath, 0o644)
    await writeFile(postinstPath, buildPostinstScript(), { encoding: 'utf8', mode: 0o755 })
    await chmod(postinstPath, 0o755)
    await writeFile(postrmPath, buildPostrmScript(), { encoding: 'utf8', mode: 0o755 })
    await chmod(postrmPath, 0o755)

    const tmpDebPath = join(workRoot, 'paperflow.deb')
    runCommand('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', pkgDir, tmpDebPath])

    await mkdir(dirname(outputPath), { recursive: true })
    await rm(outputPath, { force: true })
    await rename(tmpDebPath, outputPath)

    runCommand('dpkg-deb', ['--info', outputPath])
    const contents = runCommand('dpkg-deb', ['--contents', outputPath])
    for (const member of EXPECTED_DEB_MEMBERS) {
      if (!contents.includes(member)) {
        throw new Error(`.deb 产物内容校验缺少目标路径: ${member}`)
      }
    }

    const finalBytes = (await stat(outputPath)).size
    const finalSha256 = await sha256File(outputPath)
    console.log(`[dist:linux:deb] 产物校验完成: ${options.output}`)
    console.log(`[dist:linux:deb] bytes=${finalBytes} sha256=${finalSha256} appAsarSha256=${asarSha256}`)
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

const isEntrypoint =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isEntrypoint) {
  void main().catch((error: unknown) => {
    console.error('[dist:linux:deb] 失败:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
