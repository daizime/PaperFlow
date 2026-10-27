import { describe, expect, it } from 'vitest'
import { ReaderStateWriter } from '../../src/renderer/src/features/reader/reader-state-writer'
import type { ReaderState } from '../../src/shared/contracts'
const state = (pageNumber: number): ReaderState => ({ documentId: '11111111-1111-4111-8111-111111111111', pageNumber, scale: 1, updatedAt: new Date().toISOString() })
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
describe('阅读状态异步写入队列', () => {
  it('A 已保存，B 待写时回到 A，关闭刷新仍最终写入 A', async () => {
    const gate = deferred()
    const entered = deferred()
    const saved: number[] = []
    const writer = new ReaderStateWriter(async snapshot => {
      if (snapshot.pageNumber === 2) { entered.resolve(); await gate.promise }
      saved.push(snapshot.pageNumber)
    })
    await writer.save(state(1))
    const middle = writer.save(state(2))
    await entered.promise
    const final = writer.save(state(1))
    gate.resolve()
    await Promise.all([middle, final])
    expect(saved).toEqual([1, 2, 1])
  })
  it('相同的待写快照合并，且不会被调用方后续修改', async () => {
    const gate = deferred()
    const saved: number[] = []
    const writer = new ReaderStateWriter(async snapshot => { await gate.promise; saved.push(snapshot.pageNumber) })
    const original = state(1)
    const first = writer.save(original)
    const duplicate = writer.save({ ...original, updatedAt: new Date().toISOString() })
    original.pageNumber = 3
    gate.resolve()
    await Promise.all([first, duplicate])
    expect(saved).toEqual([1])
  })
  it('保存失败后允许重试相同状态', async () => {
    let attempts = 0
    const writer = new ReaderStateWriter(async () => { if (++attempts === 1) throw new Error('disk unavailable') })
    await expect(writer.save(state(1))).rejects.toThrow('disk unavailable')
    await writer.save(state(1))
    expect(attempts).toBe(2)
  })
})
