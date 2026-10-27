import type { ReaderState } from '../../../../shared/contracts'

/** 按最后排队状态去重，避免 A→B(待写)→A 时错误地丢弃最后的 A。 */
export class ReaderStateWriter {
  private tail = Promise.resolve()
  private lastQueued: string | null = null
  private revision = 0
  constructor(private readonly persist: (state: ReaderState) => Promise<void>) {}

  save(state: ReaderState): Promise<void> {
    const snapshot = { ...state }
    const signature = JSON.stringify([snapshot.documentId, snapshot.pageNumber, snapshot.scale])
    if (signature === this.lastQueued) return this.tail
    this.lastQueued = signature
    const revision = ++this.revision
    this.tail = this.tail.catch(() => {}).then(() => this.persist(snapshot)).catch((error: unknown) => {
      if (revision === this.revision) this.lastQueued = null
      throw error
    })
    return this.tail
  }
}
