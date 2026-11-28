import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LINUX_DEB_DEPENDS,
  buildControlFile,
  buildDesktopEntry,
  buildPostinstScript,
  buildPostrmScript,
  buildWrapperScript,
  parseDebCliArgs,
  validatePng256
} from '../../scripts/dist-linux-deb'

describe('scripts/dist-linux-deb 辅助逻辑', () => {
  it('parseDebCliArgs 返回默认路径并支持自定义参数与 --help', () => {
    expect(parseDebCliArgs([], '0.1.0')).toEqual({
      fromTar: 'release/Foliopair-0.1.0-linux-x64.tar.gz',
      output: 'release/Foliopair-0.1.0-linux-x64.deb',
      icon: 'build/icon.png',
      help: false
    })

    expect(
      parseDebCliArgs(
        ['--from-tar', '/tmp/a.tar.gz', '--output', '/tmp/out.deb', '--icon', 'custom.png', '--help'],
        '0.1.0'
      )
    ).toEqual({
      fromTar: '/tmp/a.tar.gz',
      output: '/tmp/out.deb',
      icon: 'custom.png',
      help: true
    })

    expect(() => parseDebCliArgs(['--unknown'], '0.1.0')).toThrow(/未知参数/)
    expect(() => parseDebCliArgs(['--output'], '0.1.0')).toThrow(/缺少有效路径值/)
  })

  it('生成的包装脚本、桌面条目、控制文件与维护脚本均为 LF 且无 CRLF', () => {
    const files = [
      buildWrapperScript(),
      buildDesktopEntry(),
      buildControlFile('0.1.0', 349032),
      buildPostinstScript(),
      buildPostrmScript()
    ]

    for (const content of files) {
      expect(content).not.toContain('\r')
      expect(content.endsWith('\n')).toBe(true)
    }

    expect(buildWrapperScript()).toBe('#!/bin/sh\nexec /opt/PaperFlow/paperflow "$@"\n')
    expect(buildDesktopEntry()).toContain('Name=Foliopair\n')
    expect(buildDesktopEntry()).toContain('Exec=/opt/PaperFlow/paperflow %U\n')
    expect(buildDesktopEntry()).toContain('MimeType=application/pdf;\n')

    const control = buildControlFile('0.1.0', 349032)
    expect(control).toContain('Package: paperflow\n')
    expect(control).toContain('Version: 0.1.0\n')
    expect(control).toContain('Architecture: amd64\n')
    expect(control).toContain('Installed-Size: 349032\n')
    expect(control).toContain(`Depends: ${LINUX_DEB_DEPENDS}\n`)

    expect(buildPostinstScript()).toContain('chown root:root /opt/PaperFlow/chrome-sandbox')
    expect(buildPostinstScript()).toContain('chmod 4755 /opt/PaperFlow/chrome-sandbox')
    expect(buildPostrmScript()).toContain('update-desktop-database -q /usr/share/applications')
  })

  it('buildControlFile 拒绝非法版本号与 Installed-Size', () => {
    expect(() => buildControlFile('', 100)).toThrow()
    expect(() => buildControlFile('0.1.0\nbad', 100)).toThrow()
    expect(() => buildControlFile('0.1.0', 0)).toThrow()
    expect(() => buildControlFile('0.1.0', -10)).toThrow()
  })

  it('validatePng256 通过真实 build/icon.png 校验并拒绝非法 PNG', async () => {
    const iconBytes = await readFile(resolve('build/icon.png'))
    expect(validatePng256(iconBytes)).toEqual({ width: 256, height: 256 })

    expect(() => validatePng256(new Uint8Array(10))).toThrow()
    const badMagic = new Uint8Array(24)
    expect(() => validatePng256(badMagic)).toThrow(/PNG/)
  })
})
