import { useEffect, useState } from 'react'
import type { DocumentRecord } from '../../../../shared/contracts'
import './library.css'

interface Props {
  documents: DocumentRecord[]
  selectedId?: string
  importing: boolean
  error: string | null
  loading: boolean
  loadError: string | null
  notice: string | null
  onImport(): void
  onSelect(id: string): void
  onRetry(): void
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`
}

export function LibraryPanel({ documents, selectedId, importing, error, loading, loadError, notice, onImport, onSelect, onRetry }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const searchTerm = query.trim().toLocaleLowerCase()
  const visibleDocuments = searchTerm
    ? documents.filter(document => document.originalFilename.toLocaleLowerCase().includes(searchTerm) || document.displayTitle.toLocaleLowerCase().includes(searchTerm))
    : documents

  // 工具栏同样能发起导入；清除旧过滤，确保成功或重复导入项可见。
  useEffect(() => {
    if (notice && !importing) setQuery('')
  }, [importing, notice])

  const count = documents.length === 0 && (loading || loadError) ? '—' : documents.length

  return <aside className="library-panel" aria-label="文献库">
    <div className="library-heading"><h2>我的文献</h2><span aria-label={count === '—' ? '文献数量待读取' : `共 ${count} 篇文献`}>{count}</span></div>
    <p className="muted">在本机保存与阅读 PDF</p>
    <button className="library-import-button" onClick={onImport} disabled={importing} aria-label="导入 PDF">
      <span aria-hidden="true">{importing ? '…' : '＋'}</span>{importing ? '正在导入…' : '导入 PDF'}
    </button>

    <div className="library-search">
      <label htmlFor="library-search-input">搜索文献</label>
      <div className="library-search-field">
        <input id="library-search-input" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件名" autoComplete="off" spellCheck={false} disabled={documents.length === 0} />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">清空</button>}
      </div>
    </div>

    {importing && <p className="library-feedback library-feedback--progress" role="status">正在选择、校验并导入 PDF…</p>}
    {notice && !importing && <p className="library-feedback library-feedback--success" role="status">{notice}</p>}
    {error && <div className="error-banner" role="alert">{error}</div>}
    {loadError && <div className="library-load-error error-banner" role="alert">
      <p>{loadError}</p>
      <button type="button" onClick={onRetry}>重新读取</button>
    </div>}
    {loading && <p className="library-feedback library-feedback--loading" role="status">正在读取文献库…</p>}

    <div className="library-results" aria-busy={loading}>
      {documents.length === 0 ? !loading && !loadError && <div className="empty-library">
        <span className="library-empty-symbol" aria-hidden="true">▤</span>
        <p>文献库为空</p><small>导入一篇 PDF 开始阅读</small>
      </div> : visibleDocuments.length === 0 ? <div className="library-no-results" role="status">
        <p>没有找到匹配的文献</p><small>试试其他文件名，或清空搜索。</small>
        <button type="button" onClick={() => setQuery('')}>查看全部文献</button>
      </div> : <>
        <p className="library-result-count">{searchTerm ? `找到 ${visibleDocuments.length} / ${documents.length} 篇` : `全部文献 · ${documents.length} 篇`}</p>
        <ul className="document-list">{visibleDocuments.map(document => <li key={document.id}>
          <button className={selectedId === document.id ? 'document-item selected' : 'document-item'} onClick={() => onSelect(document.id)} data-document-id={document.id} aria-pressed={selectedId === document.id}>
            <span className="pdf-badge">PDF</span><span className="document-description">
              <strong title={document.originalFilename}>{document.originalFilename}</strong>
              <small>{document.pageCount === null ? '页数待读取' : `${document.pageCount} 页`} · {formatSize(document.byteSize)}</small>
              <time dateTime={document.importedAt}>导入于 {new Date(document.importedAt).toLocaleDateString('zh-CN')}</time>
              {selectedId === document.id && <span className="library-selected-label">正在阅读</span>}
            </span>
          </button>
        </li>)}</ul>
      </>}
    </div>
  </aside>
}
