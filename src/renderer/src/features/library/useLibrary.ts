import { useCallback, useEffect, useRef, useState } from 'react'
import { formatPdfByteSize, hasControlCharacters, MAX_PDF_BYTES, type DocumentRecord, type ImportResult, type UpdateDocumentMetaInput } from '../../../../shared/contracts'

const LAST_DOCUMENT_KEY = 'paperflow:last-document'

export interface ImportFailureDetail {
  filename: string
  reason: string
}

export function formatDocumentTitle(document: Pick<DocumentRecord, 'originalFilename' | 'displayTitle'>): string {
  const defaultTitle = document.originalFilename.replace(/\.pdf$/i, '') || document.originalFilename
  return document.displayTitle !== defaultTitle ? document.displayTitle : document.originalFilename
}

function cleanIpcError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback
  const cleaned = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim()
  return cleaned || fallback
}

async function importSingleDroppedFile(file: File): Promise<{ result?: ImportResult; failure?: ImportFailureDetail }> {
  const rawName = (file.name ?? '').trim()
  const safeName = rawName || '未命名文件'
  if (!rawName || rawName.includes('/') || rawName.includes('\\') || hasControlCharacters(rawName)) {
    return { failure: { filename: safeName, reason: `「${safeName}」导入失败：文件名无效，仅支持单个本地 PDF 文件。` } }
  }
  if (!/\.pdf$/i.test(rawName) || rawName.length <= 4) {
    return { failure: { filename: safeName, reason: `「${safeName}」导入失败：仅支持扩展名为 .pdf 的文件（当前文件不是 PDF）。` } }
  }
  if (file.size === 0) {
    return { failure: { filename: safeName, reason: `「${safeName}」导入失败：PDF 文件为空（0 B）。` } }
  }
  if (file.size > MAX_PDF_BYTES) {
    return {
      failure: {
        filename: safeName,
        reason: `「${safeName}」超出限制：单个 PDF 不能超过 100 MiB（当前 ${formatPdfByteSize(file.size)}）。`
      }
    }
  }
  try {
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    if (bytes.byteLength === 0) {
      return { failure: { filename: safeName, reason: `「${safeName}」导入失败：PDF 文件为空（0 B）。` } }
    }
    if (bytes.byteLength > MAX_PDF_BYTES) {
      return {
        failure: {
          filename: safeName,
          reason: `「${safeName}」超出限制：单个 PDF 不能超过 100 MiB（当前 ${formatPdfByteSize(bytes.byteLength)}）。`
        }
      }
    }
    return { result: await window.paperflow.importPdfBytes({ originalFilename: safeName, bytes }) }
  } catch (err: unknown) {
    const reason = cleanIpcError(err, '导入失败，请重试。')
    return {
      failure: {
        filename: safeName,
        reason: reason.includes(safeName) ? reason : `「${safeName}」导入失败：${reason}`
      }
    }
  }
}

export function useLibrary(): {
  documents: DocumentRecord[]
  readerProgress: Record<string, number>
  selected: DocumentRecord | null
  importing: boolean
  error: string | null
  errorDetails: ImportFailureDetail[]
  loading: boolean
  loadError: string | null
  notice: string | null
  select(id: string): void
  importPdf(): Promise<void>
  importDroppedFiles(files: FileList | File[]): Promise<void>
  renameDocument(documentId: string, displayTitle: string): Promise<boolean>
  updateDocumentMeta(input: UpdateDocumentMetaInput): Promise<boolean>
  updateLocalProgress(documentId: string, pageNumber: number): void
  deleteDocument(documentId: string): Promise<boolean>
  dismissErrors(): void
  reportError(message: string): void
  reportNotice(message: string): void
  refresh(): Promise<void>
} {
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [readerProgress, setReaderProgress] = useState<Record<string, number>>({})
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(LAST_DOCUMENT_KEY))
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<ImportFailureDetail[]>([])
  const [importing, setImporting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const importingRef = useRef(false)
  const loadedRef = useRef(false)
  const loadErrorRef = useRef<string | null>(null)
  const refreshRequestRef = useRef(0)
  const documentsRef = useRef<DocumentRecord[]>([])
  const selectedIdRef = useRef<string | null>(selectedId)

  useEffect(() => { documentsRef.current = documents }, [documents])
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  const select = useCallback((id: string) => {
    selectedIdRef.current = id
    setSelectedId(id)
    setNotice(null)
    localStorage.setItem(LAST_DOCUMENT_KEY, id)
  }, [])

  const dismissErrors = useCallback(() => {
    setError(null)
    setErrorDetails([])
  }, [])

  const reportError = useCallback((message: string) => {
    setErrorDetails([])
    setNotice(null)
    setError(message)
  }, [])

  const reportNotice = useCallback((message: string) => {
    setError(null)
    setErrorDetails([])
    setNotice(message)
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
      const [nextDocuments, nextProgress] = await Promise.all([
        window.paperflow.listDocuments(),
        window.paperflow.listReaderProgress().catch(() => ({} as Record<string, number>))
      ])
      if (request !== refreshRequestRef.current) return
      const validIds = new Set(nextDocuments.map(item => item.id))
      documentsRef.current = nextDocuments
      setDocuments(nextDocuments)
      setReaderProgress(prev => {
        const merged: Record<string, number> = {}
        for (const [id, page] of Object.entries(nextProgress)) {
          if (validIds.has(id)) merged[id] = page
        }
        for (const [id, page] of Object.entries(prev)) {
          if (validIds.has(id)) merged[id] = page
        }
        return merged
      })
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
    // ref 在同一事件循环内生效，全部导入入口共享同一把锁。
    if (importingRef.current) return
    importingRef.current = true
    setImporting(true)
    setError(null)
    setErrorDetails([])
    setNotice(null)
    try {
      const result = await window.paperflow.importPdf()
      if (result) {
        // 已成功入库的返回记录先可见，列表刷新失败也不会丢失刚导入项。
        setDocuments(current => {
          const next = [result.document, ...current.filter(item => item.id !== result.document.id)]
          documentsRef.current = next
          return next
        })
        select(result.document.id)
        setNotice(result.status === 'existing' ? '这份 PDF 已在文献库中' : '已导入 PDF')
        await refresh()
      }
    } catch (err: unknown) {
      setError(cleanIpcError(err, '导入失败，请重试。'))
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }, [refresh, select])

  const importDroppedFiles = useCallback(async (files: FileList | File[]) => {
    const fileList = Array.from(files)
    if (importingRef.current || fileList.length === 0) return
    importingRef.current = true
    setImporting(true)
    setError(null)
    setErrorDetails([])
    setNotice(null)

    let importedCount = 0
    let existingCount = 0
    let lastImportedDocument: DocumentRecord | null = null
    const failures: ImportFailureDetail[] = []

    try {
      for (const file of fileList) {
        const outcome = await importSingleDroppedFile(file)
        if (outcome.failure) {
          failures.push(outcome.failure)
          continue
        }
        const result = outcome.result
        if (!result) continue
        if (result.status === 'imported') importedCount += 1
        else existingCount += 1
        lastImportedDocument = result.document
        setDocuments(current => {
          const next = [result.document, ...current.filter(item => item.id !== result.document.id)]
          documentsRef.current = next
          return next
        })
      }

      if (lastImportedDocument) {
        select(lastImportedDocument.id)
        await refresh()
      }

      if (fileList.length === 1) {
        if (importedCount === 1) setNotice('已导入 PDF')
        else if (existingCount === 1) setNotice('这份 PDF 已在文献库中')
      } else if (importedCount + existingCount > 0) {
        const parts: string[] = []
        if (importedCount > 0) parts.push(`成功导入 ${importedCount} 篇`)
        if (existingCount > 0) parts.push(`已存在 ${existingCount} 篇`)
        if (failures.length > 0) parts.push(`失败 ${failures.length} 篇`)
        setNotice(`批量导入完成：${parts.join('，')}`)
      }

      if (failures.length > 0) {
        setErrorDetails(failures)
        setError(failures.length === 1 ? failures[0].reason : `有 ${failures.length} 个文件未能导入：`)
      }
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }, [refresh, select])

  const renameDocument = useCallback(async (documentId: string, displayTitle: string): Promise<boolean> => {
    setError(null)
    setErrorDetails([])
    try {
      const updated = await window.paperflow.renameDocument(documentId, displayTitle)
      setDocuments(current => {
        const next = current.map(item => item.id === documentId ? updated : item)
        documentsRef.current = next
        return next
      })
      await refresh()
      return true
    } catch (err: unknown) {
      setError(cleanIpcError(err, '重命名文献失败，请重试。'))
      return false
    }
  }, [refresh])

  const updateDocumentMeta = useCallback(async (input: UpdateDocumentMetaInput): Promise<boolean> => {
    setError(null)
    setErrorDetails([])
    try {
      const updated = await window.paperflow.updateDocumentMeta(input)
      setDocuments(current => {
        const next = current.map(item => (item.id === input.documentId ? updated : item))
        documentsRef.current = next
        return next
      })
      return true
    } catch (err: unknown) {
      setError(cleanIpcError(err, '更新文献标签或收藏失败，请重试。'))
      return false
    }
  }, [])

  const updateLocalProgress = useCallback((documentId: string, pageNumber: number) => {
    if (!documentId || pageNumber < 1) return
    setReaderProgress(prev => (prev[documentId] === pageNumber ? prev : { ...prev, [documentId]: pageNumber }))
  }, [])

  const deleteDocument = useCallback(async (documentId: string): Promise<boolean> => {
    setError(null)
    setErrorDetails([])
    try {
      await window.paperflow.deleteDocument(documentId)
      const currentDocs = documentsRef.current
      const index = currentDocs.findIndex(item => item.id === documentId)
      const remaining = currentDocs.filter(item => item.id !== documentId)
      const effectiveSelected = currentDocs.find(item => item.id === selectedIdRef.current) ?? currentDocs[0] ?? null
      documentsRef.current = remaining
      setDocuments(remaining)
      if (selectedIdRef.current === documentId || effectiveSelected?.id === documentId) {
        const next = index >= 0 ? (remaining[index] ?? remaining[index - 1] ?? remaining[0] ?? null) : (remaining[0] ?? null)
        if (next) {
          selectedIdRef.current = next.id
          setSelectedId(next.id)
          localStorage.setItem(LAST_DOCUMENT_KEY, next.id)
        } else {
          selectedIdRef.current = null
          setSelectedId(null)
          localStorage.removeItem(LAST_DOCUMENT_KEY)
        }
      }
      await refresh()
      return true
    } catch (err: unknown) {
      setError(cleanIpcError(err, '删除文献失败，请重试。'))
      return false
    }
  }, [refresh])

  return {
    documents,
    readerProgress,
    selected: documents.find(item => item.id === selectedId) ?? documents[0] ?? null,
    importing,
    error,
    errorDetails,
    loading,
    loadError,
    notice,
    select,
    importPdf,
    importDroppedFiles,
    renameDocument,
    updateDocumentMeta,
    updateLocalProgress,
    deleteDocument,
    dismissErrors,
    reportError,
    reportNotice,
    refresh
  }
}
