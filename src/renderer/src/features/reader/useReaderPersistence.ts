import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReaderState } from '../../../../shared/contracts'
import { ReaderStateWriter } from './reader-state-writer'
export interface CloseFlushDetail { promises: Promise<void>[] }
export type ReaderStateInput = Omit<ReaderState, 'updatedAt'>

export function useReaderPersistence(state: ReaderState | ReaderStateInput | null): string | null {
  const latest = useRef(state)
  const [writer] = useState(() => new ReaderStateWriter(snapshot => window.paperflow.saveReaderState(snapshot)))
  const [error, setError] = useState<string | null>(null)
  useLayoutEffect(() => { latest.current = state }, [state])
  const flush = useCallback((): Promise<void> => {
    const snapshot = latest.current
    if (!snapshot) return Promise.resolve()
    return writer.save({
      documentId: snapshot.documentId,
      pageNumber: snapshot.pageNumber,
      scale: snapshot.scale,
      updatedAt: new Date().toISOString()
    }).then(() => { setError(null) }, () => { setError('阅读进度保存失败，请检查本地文献库。') })
  }, [writer])
  const documentId = state?.documentId
  const pageNumber = state?.pageNumber
  const scale = state?.scale
  useEffect(() => {
    if (documentId === undefined || pageNumber === undefined || scale === undefined) return
    const timer = setTimeout(() => { void flush() }, 450)
    return () => clearTimeout(timer)
  }, [documentId, pageNumber, scale, flush])
  useEffect(() => {
    const onClose = (event: Event): void => {
      const detail = (event as CustomEvent<CloseFlushDetail>).detail
      if (detail?.promises) detail.promises.push(flush())
    }
    window.addEventListener('paperflow:before-close', onClose)
    return () => {
      window.removeEventListener('paperflow:before-close', onClose)
      void flush()
    }
  }, [flush])
  return error
}
