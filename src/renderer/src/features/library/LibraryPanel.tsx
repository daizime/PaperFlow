import { useEffect, useRef, useState } from 'react'
import { hasControlCharacters, type DocumentRecord } from '../../../../shared/contracts'
import { formatDocumentTitle, type ImportFailureDetail } from './useLibrary'
import './library.css'

interface Props {
  documents: DocumentRecord[]
  selectedId?: string
  importing: boolean
  error: string | null
  errorDetails: ImportFailureDetail[]
  loading: boolean
  loadError: string | null
  notice: string | null
  onImport(): void
  onSelect(id: string): void
  onRename(id: string, displayTitle: string): Promise<boolean>
  onDelete(id: string): Promise<boolean>
  onDismissError(): void
  onReportError(message: string): void
  onRetry(): void
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`
}

export function LibraryPanel({
  documents, selectedId, importing, error, errorDetails, loading, loadError, notice,
  onImport, onSelect, onRename, onDelete, onDismissError, onReportError, onRetry
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const searchTerm = query.trim().toLocaleLowerCase()
  const visibleDocuments = searchTerm
    ? documents.filter(document => document.originalFilename.toLocaleLowerCase().includes(searchTerm) || document.displayTitle.toLocaleLowerCase().includes(searchTerm))
    : documents

  // 工具栏同样能发起导入；清除旧过滤，确保成功或重复导入项可见。
  useEffect(() => {
    if (notice && !importing) setQuery('')
  }, [importing, notice])

  const activeEditingId = documents.some(document => document.id === editingId) ? editingId : null
  const activeConfirmDeleteId = documents.some(document => document.id === confirmDeleteId) ? confirmDeleteId : null

  useEffect(() => {
    if (!activeEditingId) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [activeEditingId])

  const count = documents.length === 0 && (loading || loadError) ? '—' : documents.length

  function startRename(document: DocumentRecord): void {
    setConfirmDeleteId(null)
    setEditingId(document.id)
    setDraftTitle(document.displayTitle)
  }

  function cancelRename(): void {
    setEditingId(null)
    setDraftTitle('')
  }

  async function submitRename(id: string): Promise<void> {
    if (busyId === id) return
    const trimmed = draftTitle.trim()
    if (!trimmed) {
      onReportError('文献标题不能为空。')
      return
    }
    if (trimmed.length > 200) {
      onReportError('文献标题长度不能超过 200 个字符。')
      return
    }
    if (hasControlCharacters(trimmed)) {
      onReportError('文献标题不能包含控制字符。')
      return
    }
    setBusyId(id)
    try {
      const ok = await onRename(id, trimmed)
      if (ok) {
        setEditingId(null)
        setDraftTitle('')
      }
    } finally {
      setBusyId(current => current === id ? null : current)
    }
  }

  function startDeleteConfirm(id: string): void {
    setEditingId(null)
    setDraftTitle('')
    setConfirmDeleteId(id)
  }

  async function submitDelete(id: string): Promise<void> {
    if (busyId === id) return
    setBusyId(id)
    try {
      const ok = await onDelete(id)
      if (ok) setConfirmDeleteId(current => current === id ? null : current)
    } finally {
      setBusyId(current => current === id ? null : current)
    }
  }

  return <aside className="library-panel" aria-label="文献库">
    <div className="library-heading"><h2>我的文献</h2><span aria-label={count === '—' ? '文献数量待读取' : `共 ${count} 篇文献`}>{count}</span></div>
    <p className="muted">在本机保存与阅读 PDF，支持拖拽导入</p>
    <button className="library-import-button" onClick={onImport} disabled={importing} aria-label="导入 PDF">
      <span aria-hidden="true">{importing ? '…' : '＋'}</span>{importing ? '正在导入…' : '导入 PDF'}
    </button>

    <div className="library-search">
      <label htmlFor="library-search-input">搜索文献</label>
      <div className="library-search-field">
        <input id="library-search-input" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题或文件名" autoComplete="off" spellCheck={false} disabled={documents.length === 0} />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">清空</button>}
      </div>
    </div>

    {importing && <p className="library-feedback library-feedback--progress" role="status">正在选择、校验并导入 PDF…</p>}
    {notice && !importing && <p className="library-feedback library-feedback--success" role="status">{notice}</p>}
    {(error || errorDetails.length > 0) && <div className="error-banner library-error-banner" role="alert">
      <div className="library-error-header">
        <p className="library-error-summary">{errorDetails.length > 0 ? `有 ${errorDetails.length} 个文件未能导入：` : error}</p>
        <button type="button" className="library-error-dismiss" onClick={onDismissError}>关闭提示</button>
      </div>
      {errorDetails.length > 0 && <ul className="library-error-details">
        {errorDetails.map((item, index) => <li key={`${item.filename}-${index}`}>
          <strong>{item.filename}</strong>
          <span>{item.reason}</span>
        </li>)}
      </ul>}
    </div>}
    {loadError && <div className="library-load-error error-banner" role="alert">
      <p>{loadError}</p>
      <button type="button" onClick={onRetry}>重新读取</button>
    </div>}
    {loading && <p className="library-feedback library-feedback--loading" role="status">正在读取文献库…</p>}

    <div className="library-results" aria-busy={loading}>
      {documents.length === 0 ? !loading && !loadError && <div className="empty-library">
        <span className="library-empty-symbol" aria-hidden="true">▤</span>
        <p>文献库为空</p><small>导入或拖拽 PDF 到此窗口</small>
      </div> : visibleDocuments.length === 0 ? <div className="library-no-results" role="status">
        <p>没有找到匹配的文献</p><small>试试其他关键词，或清空搜索。</small>
        <button type="button" onClick={() => setQuery('')}>查看全部文献</button>
      </div> : <>
        <p className="library-result-count">{searchTerm ? `找到 ${visibleDocuments.length} / ${documents.length} 篇` : `全部文献 · ${documents.length} 篇`}</p>
        <ul className="document-list">{visibleDocuments.map(document => {
          const isEditing = activeEditingId === document.id
          const isConfirmingDelete = activeConfirmDeleteId === document.id
          const isBusy = busyId === document.id
          return <li key={document.id} className="document-entry">
            <button type="button" className={selectedId === document.id ? 'document-item selected' : 'document-item'} onClick={() => onSelect(document.id)} data-document-id={document.id} aria-pressed={selectedId === document.id}>
              <span className="pdf-badge">PDF</span><span className="document-description">
                <strong title={document.originalFilename}>{formatDocumentTitle(document)}</strong>
                <small>{document.pageCount === null ? '页数待读取' : `${document.pageCount} 页`} · {formatSize(document.byteSize)}</small>
                <time dateTime={document.importedAt}>导入于 {new Date(document.importedAt).toLocaleDateString('zh-CN')}</time>
                {selectedId === document.id && <span className="library-selected-label">正在阅读</span>}
              </span>
            </button>
            {isEditing ? <form className="document-actions document-rename-form" onSubmit={event => { event.preventDefault(); void submitRename(document.id) }}>
              <input
                ref={renameInputRef}
                type="text"
                aria-label="编辑文献标题"
                value={draftTitle}
                maxLength={200}
                disabled={isBusy}
                onChange={event => setDraftTitle(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelRename()
                  }
                }}
              />
              <div className="document-action-buttons">
                <button type="submit" className="document-action-primary" disabled={isBusy}>保存</button>
                <button type="button" disabled={isBusy} onClick={cancelRename}>取消</button>
              </div>
            </form> : isConfirmingDelete ? <div className="document-actions document-confirm-delete">
              <span>确认从文献库删除？</span>
              <div className="document-action-buttons">
                <button type="button" className="document-action-danger" aria-label="确认删除" disabled={isBusy} onClick={() => void submitDelete(document.id)}>确认删除</button>
                <button type="button" disabled={isBusy} onClick={() => setConfirmDeleteId(null)}>取消</button>
              </div>
            </div> : <div className="document-actions">
              <button type="button" className="document-action-link" aria-label={`重命名 ${document.originalFilename}`} disabled={importing || isBusy} onClick={() => startRename(document)}>重命名</button>
              <button type="button" className="document-action-link document-action-link--danger" aria-label={`删除 ${document.originalFilename}`} disabled={importing || isBusy} onClick={() => startDeleteConfirm(document.id)}>删除</button>
            </div>}
          </li>
        })}</ul>
      </>}
    </div>
  </aside>
}
