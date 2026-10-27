import { describe, expect, it } from 'vitest'
import { documentIdArgsSchema, noArgsSchema, pageCountArgsSchema, readerStateSchema } from '../../src/shared/schemas'
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
})
