import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentRecord } from '../../../../shared/contracts'

export function useLibrary(): {
  documents: DocumentRecord[]
  selected: DocumentRecord | null
  importing: boolean
  error: string | null
  loading: boolean
  loadError: string | null
  notice: string | null
  select(id: string): void
  importPdf(): Promise<void>
  refresh(): Promise<void>
} {
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem('paperflow:last-document'))
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const importingRef = useRef(false)
  const loadedRef = useRef(false)
  const loadErrorRef = useRef<string | null>(null)
  const refreshRequestRef = useRef(0)

  const select = useCallback((id: string) => {
    setSelectedId(id)
    setNotice(null)
    localStorage.setItem('paperflow:last-document', id)
  }, [])

  const refresh = useCallback(async () => {
    const request = ++refreshRequestRef.current
    // 同一 refresh 也用于后台更新页数；已有列表时保留阅读界面。
    if (!loadedRef.current || loadErrorRef.current !== null) {
      setLoading(true)
      setLoadError(null)
      loadErrorRef.current = null
    }
    try {
      const nextDocuments = await window.paperflow.listDocuments()
      if (request !== refreshRequestRef.current) return
      setDocuments(nextDocuments)
      loadedRef.current = true
      loadErrorRef.current = null
      setLoadError(null)
    } catch {
      if (request !== refreshRequestRef.current) return
      const message = '无法读取文献库，请重试。'
      loadErrorRef.current = message
      setLoadError(message)
    } finally {
      if (request === refreshRequestRef.current) setLoading(false)
    }
  }, [])

  const cancelPendingRefresh = useCallback(() => { refreshRequestRef.current++ }, [])

  useEffect(() => {
    void refresh()
    return cancelPendingRefresh
  }, [refresh, cancelPendingRefresh])

  const importPdf = useCallback(async () => {
    // ref 在同一事件循环内生效，两个导入入口共享同一把锁。
    if (importingRef.current) return
    importingRef.current = true
    setImporting(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.paperflow.importPdf()
      if (result) {
        // 已成功入库的返回记录先可见，列表刷新失败也不会丢失刚导入项。
        setDocuments(current => [result.document, ...current.filter(item => item.id !== result.document.id)])
        select(result.document.id)
        setNotice(result.status === 'existing' ? '这份 PDF 已在文献库中' : '已导入 PDF')
        await refresh()
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '导入失败，请重试。'
      setError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }, [refresh, select])

  return {
    documents,
    selected: documents.find(item => item.id === selectedId) ?? documents[0] ?? null,
    importing, error, loading, loadError, notice, select, importPdf, refresh
  }
}
