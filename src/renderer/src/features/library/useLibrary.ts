import { useCallback, useEffect, useState } from 'react'
import type { DocumentRecord } from '../../../../shared/contracts'
export function useLibrary(): {
  documents: DocumentRecord[]; selected: DocumentRecord | null; importing: boolean; error: string | null
  select(id: string): void; importPdf(): Promise<void>; refresh(): Promise<void>
} {
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem('paperflow:last-document'))
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const select = useCallback((id: string) => { setSelectedId(id); localStorage.setItem('paperflow:last-document', id) }, [])
  const refresh = useCallback(async () => {
    try { setDocuments(await window.paperflow.listDocuments()) }
    catch { setError('无法读取文献库，请重启软件后重试。') }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const importPdf = useCallback(async () => {
    setImporting(true); setError(null)
    try {
      const result = await window.paperflow.importPdf()
      if (result) { await refresh(); select(result.document.id) }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '导入失败，请重试。'
      setError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally { setImporting(false) }
  }, [refresh, select])
  return { documents, selected: documents.find(item => item.id === selectedId) ?? documents[0] ?? null, importing, error, select, importPdf, refresh }
}
