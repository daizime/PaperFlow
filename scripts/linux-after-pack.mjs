import { chmod, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LAUNCHER_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
  'has_ozone=0',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    --ozone-platform|--ozone-platform=*|--ozone-platform-hint|--ozone-platform-hint=*)',
  '      has_ozone=1',
  '      ;;',
  '  esac',
  'done',
  'if [ "$has_ozone" -eq 0 ] && [ -n "${DISPLAY:-}" ]; then',
  '  exec "$DIR/paperflow.bin" --ozone-platform=x11 "$@"',
  'fi',
  'exec "$DIR/paperflow.bin" "$@"',
  ''
].join('\n')

/** 在 Linux 打包后把二进制改名为 paperflow.bin，并生成在 X11 可用时默认加 --ozone-platform=x11 的 POSIX 启动脚本。 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return

  const launcherPath = join(context.appOutDir, 'paperflow')
  const binaryPath = join(context.appOutDir, 'paperflow.bin')

  await rename(launcherPath, binaryPath)
  await writeFile(launcherPath, LAUNCHER_SCRIPT, { encoding: 'utf8', mode: 0o755 })

  try {
    await chmod(binaryPath, 0o755)
    await chmod(launcherPath, 0o755)
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}
