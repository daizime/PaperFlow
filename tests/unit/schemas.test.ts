import { describe, expect, it } from 'vitest'
import {
  displayTitleSchema, documentIdArgsSchema, importPdfBytesArgsSchema, noArgsSchema,
  pageCountArgsSchema, readerStateSchema, renameDocumentArgsSchema
} from '../../src/shared/schemas'

describe('IPC 参数验证', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  it('ID 只接受 UUID，拒绝路径和 SQL 注入', () => {
    expect(documentIdArgsSchema.safeParse([id]).success).toBe(true)
    for (const value of ['../../private.pdf', "' OR 1=1 --", '', 1, null]) expect(documentIdArgsSchema.safeParse([value]).success).toBe(false)
  })

  it('所有参数数量、页数、缩放和时间验证', () => {
    expect(noArgsSchema.safeParse(['extra']).success).toBe(false)
    expect(pageCountArgsSchema.safeParse([id, 0]).success).toBe(false)
    expect(pageCountArgsSchema.safeParse([id, 2.5]).success).toBe(false)
    for (const scale of [NaN, Infinity, 0.49, 3.01]) expect(readerStateSchema.safeParse({ documentId: id, pageNumber: 1, scale, updatedAt: new Date().toISOString() }).success).toBe(false)
    expect(readerStateSchema.safeParse({ documentId: id, pageNumber: 1, scale: 1, updatedAt: 'yesterday' }).success).toBe(false)
  })

  it('重命名标题校验长度、首尾空白并拒绝 ASCII 控制字符', () => {
    expect(displayTitleSchema.parse('  Paper Title 2026  ')).toBe('Paper Title 2026')
    expect(displayTitleSchema.safeParse('a'.repeat(200)).success).toBe(true)
    expect(displayTitleSchema.safeParse(`  ${'a'.repeat(200)}  `).success).toBe(true)
    for (const invalid of ['', '   ', '\t\n', 'a'.repeat(201), 'bad\x00title', 'bad\ntitle', 'bad\rtitle', 'bad\x1ftitle', 'bad\x7ftitle']) {
      expect(displayTitleSchema.safeParse(invalid).success).toBe(false)
    }
    expect(renameDocumentArgsSchema.safeParse([id, '新标题']).success).toBe(true)
    expect(renameDocumentArgsSchema.safeParse([id, '   ']).success).toBe(false)
    expect(renameDocumentArgsSchema.safeParse(['not-a-uuid', '新标题']).success).toBe(false)
    expect(renameDocumentArgsSchema.safeParse([id, '新标题', 'extra']).success).toBe(false)
  })

  it('拖拽字节导入参数校验文件名、Uint8Array、严格键与 IPC 字节上限', () => {
    const sample = new Uint8Array([37, 80, 68, 70])
    const parsed = importPdfBytesArgsSchema.parse([{ originalFilename: '  paper.pdf  ', bytes: sample }])
    expect(parsed[0].originalFilename).toBe('paper.pdf')
    expect(parsed[0].bytes).toBeInstanceOf(Uint8Array)

    // 允许 0 字节与略超 100 MiB 进入服务层返回详细中文原因，同时限制超大缓冲区。
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'empty.pdf', bytes: new Uint8Array(0) }]).success).toBe(true)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'over.pdf', bytes: new Uint8Array(100 * 1024 * 1024 + 1) }]).success).toBe(true)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'dos.pdf', bytes: new Uint8Array(105 * 1024 * 1024 + 1) }]).success).toBe(false)

    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: '', bytes: sample }]).success).toBe(false)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: `${'a'.repeat(257)}.pdf`, bytes: sample }]).success).toBe(false)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'a.pdf', bytes: sample, path: '/etc/passwd' }]).success).toBe(false)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'a.pdf', bytes: [37, 80, 68, 70] }]).success).toBe(false)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'a.pdf', bytes: sample }, 'extra']).success).toBe(false)
  })
})
