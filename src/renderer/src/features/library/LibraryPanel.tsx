import { useEffect, useMemo, useRef, useState } from 'react'
import {
  hasControlCharacters,
  type DocumentRecord,
  type LibrarySearchHit,
  type UpdateDocumentMetaInput
} from '../../../../shared/contracts'
import { formatDocumentTitle, type ImportFailureDetail } from './useLibrary'
import './library.css'

interface Props {
  documents: DocumentRecord[]
  readerProgress?: Record<string, number>
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
  onUpdateMeta?(input: UpdateDocumentMetaInput): Promise<boolean>
  onJumpToSearchHit?(documentId: string, pageNumber: number | null): void
  onDelete(id: string): Promise<boolean>
  backingUp?: boolean
  onExportBackup?(): void
  onImportBackup?(): void
  onDismissError(): void
  onReportError(message: string): void
  onRetry(): void
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`
}

const SOURCE_LABELS: Record<LibrarySearchHit['source'], string> = {
  document: '文献',
  annotation: '批注',
  translation: '译文'
}

export function LibraryPanel({
  documents,
  readerProgress = {},
  selectedId,
  importing,
  error,
  errorDetails,
  loading,
  loadError,
  notice,
  onImport,
  onSelect,
  onRename,
  onUpdateMeta,
  onJumpToSearchHit,
  onDelete,
  backingUp = false,
  onExportBackup,
  onImportBackup,
  onDismissError,
  onReportError,
  onRetry
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [starOnly, setStarOnly] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [crossHits, setCrossHits] = useState<LibrarySearchHit[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [taggingId, setTaggingId] = useState<string | null>(null)
  const [draftTag, setDraftTag] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const allTags = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const doc of documents) {
      for (const tag of doc.tags ?? []) {
        const key = tag.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          list.push(tag)
        }
      }
    }
    return list
  }, [documents])

  const effectiveTagFilter =
    selectedTag && allTags.some(t => t.toLowerCase() === selectedTag.toLowerCase()) ? selectedTag : null

  const searchTerm = query.trim().toLocaleLowerCase()
  const visibleDocuments = documents.filter(document => {
    if (starOnly && !document.starred) return false
    if (effectiveTagFilter && !(document.tags ?? []).some(t => t.toLowerCase() === effectiveTagFilter.toLowerCase())) {
      return false
    }
    if (!searchTerm) return true
    const inTitle =
      document.originalFilename.toLocaleLowerCase().includes(searchTerm) ||
      document.displayTitle.toLocaleLowerCase().includes(searchTerm)
    const inTags = (document.tags ?? []).some(t => t.toLocaleLowerCase().includes(searchTerm))
    return inTitle || inTags
  })

  // 工具栏同样能发起导入；清除旧过滤，确保成功或重复导入项可见。
  useEffect(() => {
    if (notice && !importing) {
      setQuery('')
      setStarOnly(false)
      setSelectedTag(null)
    }
  }, [importing, notice])

  // 全库检索（批注、笔记与已缓存译文）
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2 || documents.length === 0) {
      setCrossHits([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.paperflow
        .searchLibrary(trimmed)
        .then(hits => {
          if (!cancelled) {
            setCrossHits(hits.filter(hit => hit.source === 'annotation' || hit.source === 'translation'))
          }
        })
        .catch(() => {
          if (!cancelled) setCrossHits([])
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, documents.length])

  const activeEditingId = documents.some(document => document.id === editingId) ? editingId : null
  const activeConfirmDeleteId = documents.some(document => document.id === confirmDeleteId) ? confirmDeleteId : null
  const activeTaggingId = documents.some(document => document.id === taggingId) ? taggingId : null

  useEffect(() => {
    if (!activeEditingId) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [activeEditingId])

  const count = documents.length === 0 && (loading || loadError) ? '—' : documents.length

  function startRename(document: DocumentRecord): void {
    setConfirmDeleteId(null)
    setTaggingId(null)
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
      setBusyId(current => (current === id ? null : current))
    }
  }

  async function handleAddTag(document: DocumentRecord): Promise<void> {
    if (!onUpdateMeta || busyId === document.id) return
    const clean = draftTag.trim()
    if (!clean) {
      setTaggingId(null)
      return
    }
    if (clean.length > 32 || hasControlCharacters(clean)) {
      onReportError('标签长度需为 1-32 个字符，且不能包含控制字符。')
      return
    }
    setBusyId(document.id)
    try {
      const nextTags = [...(document.tags ?? []), clean]
      const ok = await onUpdateMeta({ documentId: document.id, tags: nextTags })
      if (ok) {
        setDraftTag('')
        setTaggingId(null)
      }
    } finally {
      setBusyId(current => (current === document.id ? null : current))
    }
  }

  async function handleRemoveTag(document: DocumentRecord, tag: string): Promise<void> {
    if (!onUpdateMeta || busyId === document.id) return
    setBusyId(document.id)
    try {
      const nextTags = (document.tags ?? []).filter(item => item.toLowerCase() !== tag.toLowerCase())
      await onUpdateMeta({ documentId: document.id, tags: nextTags })
    } finally {
      setBusyId(current => (current === document.id ? null : current))
    }
  }

  function startDeleteConfirm(id: string): void {
    setEditingId(null)
    setTaggingId(null)
    setDraftTitle('')
    setConfirmDeleteId(id)
  }

  async function submitDelete(id: string): Promise<void> {
    if (busyId === id) return
    setBusyId(id)
    try {
      const ok = await onDelete(id)
      if (ok) setConfirmDeleteId(current => (current === id ? null : current))
    } finally {
      setBusyId(current => (current === id ? null : current))
    }
  }

  return (
    <aside className="library-panel" aria-label="文献库">
      <div className="library-heading">
        <h2>我的文献</h2>
        <span aria-label={count === '—' ? '文献数量待读取' : `共 ${count} 篇文献`}>{count}</span>
      </div>
      <p className="muted">在本机保存与阅读 PDF，支持拖拽导入</p>
      <button className="library-import-button" onClick={onImport} disabled={importing} aria-label="导入 PDF">
        <span aria-hidden="true">{importing ? '…' : '＋'}</span>
        {importing ? '正在导入…' : '导入 PDF'}
      </button>

      <div className="library-search">
        <label htmlFor="library-search-input">搜索文献</label>
        <div className="library-search-field">
          <input
            id="library-search-input"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索标题、标签、批注或译文"
            autoComplete="off"
            spellCheck={false}
            disabled={documents.length === 0}
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">
              清空
            </button>
          )}
        </div>
      </div>

      {documents.length > 0 && (
        <div className="library-filters" role="group" aria-label="文献筛选">
          <button
            type="button"
            className={!starOnly && !effectiveTagFilter ? 'is-active' : undefined}
            onClick={() => {
              setStarOnly(false)
              setSelectedTag(null)
            }}
          >
            全部
          </button>
          <button
            type="button"
            className={starOnly ? 'is-active' : undefined}
            aria-pressed={starOnly}
            onClick={() => setStarOnly(prev => !prev)}
          >
            ★ 收藏
          </button>
          {allTags.map(tag => (
            <button
              key={tag}
              type="button"
              className={effectiveTagFilter?.toLowerCase() === tag.toLowerCase() ? 'is-active' : undefined}
              onClick={() =>
                setSelectedTag(curr => (curr?.toLowerCase() === tag.toLowerCase() ? null : tag))
              }
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      {importing && <p className="library-feedback library-feedback--progress" role="status">正在选择、校验并导入 PDF…</p>}
      {notice && !importing && <p className="library-feedback library-feedback--success" role="status">{notice}</p>}
      {(error || errorDetails.length > 0) && (
        <div className="error-banner library-error-banner" role="alert">
          <div className="library-error-header">
            <p className="library-error-summary">{errorDetails.length > 0 ? `有 ${errorDetails.length} 个文件未能导入：` : error}</p>
            <button type="button" className="library-error-dismiss" onClick={onDismissError}>
              关闭提示
            </button>
          </div>
          {errorDetails.length > 0 && (
            <ul className="library-error-details">
              {errorDetails.map((item, index) => (
                <li key={`${item.filename}-${index}`}>
                  <strong>{item.filename}</strong>
                  <span>{item.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {loadError && (
        <div className="library-load-error error-banner" role="alert">
          <p>{loadError}</p>
          <button type="button" onClick={onRetry}>
            重新读取
          </button>
        </div>
      )}
      {loading && <p className="library-feedback library-feedback--loading" role="status">正在读取文献库…</p>}

      <div className="library-results" aria-busy={loading}>
        {crossHits.length > 0 && (
          <div className="library-cross-hits" role="region" aria-label="批注与译文匹配结果">
            <p className="library-result-count">批注与译文命中 · {crossHits.length} 条</p>
            <ul className="library-cross-hit-list">
              {crossHits.map((hit, idx) => (
                <li key={`${hit.documentId}-${hit.source}-${hit.pageNumber ?? 0}-${idx}`}>
                  <button
                    type="button"
                    className="library-cross-hit-btn"
                    onClick={() => onJumpToSearchHit?.(hit.documentId, hit.pageNumber)}
                  >
                    <span className="library-cross-hit-meta">
                      <span className={`library-hit-badge library-hit-badge--${hit.source}`}>
                        {SOURCE_LABELS[hit.source]}
                      </span>
                      <span className="library-cross-hit-title">{hit.displayTitle}</span>
                      {hit.pageNumber !== null ? <span className="library-cross-hit-page">P.{hit.pageNumber}</span> : null}
                    </span>
                    <span className="library-cross-hit-snippet">{hit.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {documents.length === 0 ? (
          !loading &&
          !loadError && (
            <div className="empty-library">
              <span className="library-empty-symbol" aria-hidden="true">
                ▤
              </span>
              <p>文献库为空</p>
              <small>导入或拖拽 PDF 到此窗口</small>
            </div>
          )
        ) : visibleDocuments.length === 0 && crossHits.length === 0 ? (
          <div className="library-no-results" role="status">
            <p>没有找到匹配的文献</p>
            <small>试试其他关键词，或清空筛选条件。</small>
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setStarOnly(false)
                setSelectedTag(null)
              }}
            >
              查看全部文献
            </button>
          </div>
        ) : visibleDocuments.length > 0 ? (
          <>
            <p className="library-result-count">
              {searchTerm || starOnly || effectiveTagFilter
                ? `找到 ${visibleDocuments.length} / ${documents.length} 篇`
                : `全部文献 · ${documents.length} 篇`}
            </p>
            <ul className="document-list">
              {visibleDocuments.map(document => {
                const isEditing = activeEditingId === document.id
                const isTagging = activeTaggingId === document.id
                const isConfirmingDelete = activeConfirmDeleteId === document.id
                const isBusy = busyId === document.id
                const currentPage = readerProgress[document.id]
                const progressRatio =
                  currentPage && document.pageCount
                    ? Math.min(100, Math.max(4, Math.round((currentPage / document.pageCount) * 100)))
                    : null

                return (
                  <li key={document.id} className="document-entry">
                    <button
                      type="button"
                      className={selectedId === document.id ? 'document-item selected' : 'document-item'}
                      onClick={() => onSelect(document.id)}
                      data-document-id={document.id}
                      aria-pressed={selectedId === document.id}
                    >
                      <span className="pdf-badge">PDF</span>
                      <span className="document-description">
                        <strong title={document.originalFilename}>{formatDocumentTitle(document)}</strong>
                        <small>
                          {document.pageCount === null ? '页数待读取' : `${document.pageCount} 页`} · {formatSize(document.byteSize)}
                          {currentPage && document.pageCount ? ` · 已读 P.${currentPage}/${document.pageCount}` : ''}
                        </small>
                        {progressRatio !== null && (
                          <span className="document-progress-track" aria-hidden="true">
                            <span className="document-progress-fill" style={{ width: `${progressRatio}%` }} />
                          </span>
                        )}
                        <time dateTime={document.importedAt}>导入于 {new Date(document.importedAt).toLocaleDateString('zh-CN')}</time>
                        {selectedId === document.id && <span className="library-selected-label">正在阅读</span>}
                      </span>
                    </button>

                    {(document.tags?.length ?? 0) > 0 && (
                      <div className="document-tags">
                        {document.tags.map(tag => (
                          <span key={tag} className="document-tag-pill">
                            #{tag}
                            {onUpdateMeta ? (
                              <button
                                type="button"
                                aria-label={`移除标签 ${tag}`}
                                disabled={isBusy}
                                onClick={() => void handleRemoveTag(document, tag)}
                              >
                                ×
                              </button>
                            ) : null}
                          </span>
                        ))}
                      </div>
                    )}

                    {isEditing ? (
                      <form
                        className="document-actions document-rename-form"
                        onSubmit={event => {
                          event.preventDefault()
                          void submitRename(document.id)
                        }}
                      >
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
                          <button type="submit" className="document-action-primary" disabled={isBusy}>
                            保存
                          </button>
                          <button type="button" disabled={isBusy} onClick={cancelRename}>
                            取消
                          </button>
                        </div>
                      </form>
                    ) : isTagging ? (
                      <form
                        className="document-actions document-rename-form"
                        onSubmit={event => {
                          event.preventDefault()
                          void handleAddTag(document)
                        }}
                      >
                        <input
                          type="text"
                          aria-label="添加文献标签"
                          placeholder="输入标签，如 VLDB / 综述"
                          value={draftTag}
                          maxLength={32}
                          disabled={isBusy}
                          autoFocus
                          onChange={event => setDraftTag(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              setTaggingId(null)
                              setDraftTag('')
                            }
                          }}
                        />
                        <div className="document-action-buttons">
                          <button type="submit" className="document-action-primary" disabled={isBusy}>
                            添加
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => {
                              setTaggingId(null)
                              setDraftTag('')
                            }}
                          >
                            取消
                          </button>
                        </div>
                      </form>
                    ) : isConfirmingDelete ? (
                      <div className="document-actions document-confirm-delete">
                        <span>确认从文献库删除？</span>
                        <div className="document-action-buttons">
                          <button
                            type="button"
                            className="document-action-danger"
                            aria-label="确认删除"
                            disabled={isBusy}
                            onClick={() => void submitDelete(document.id)}
                          >
                            确认删除
                          </button>
                          <button type="button" disabled={isBusy} onClick={() => setConfirmDeleteId(null)}>
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {document.starred ? (
                          <span className="document-star-badge" aria-hidden="true" title="已收藏">
                            ★
                          </span>
                        ) : null}
                        <div className="document-hover-actions" role="group" aria-label="文献操作">
                          {onUpdateMeta ? (
                            <>
                              <button
                                type="button"
                                className={
                                  document.starred
                                    ? 'document-hover-icon-btn document-hover-icon-btn--star is-starred'
                                    : 'document-hover-icon-btn document-hover-icon-btn--star'
                                }
                                aria-label={
                                  document.starred
                                    ? `取消收藏 ${document.originalFilename}`
                                    : `收藏 ${document.originalFilename}`
                                }
                                aria-pressed={Boolean(document.starred)}
                                title={document.starred ? '取消收藏' : '收藏'}
                                disabled={importing || isBusy}
                                onClick={event => {
                                  event.stopPropagation()
                                  void onUpdateMeta({ documentId: document.id, starred: !document.starred })
                                }}
                              >
                                <svg width="13" height="13" viewBox="0 0 16 16" fill={document.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                                  <path d="M8 1.7l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2.1.7-4.3-3.1-3 4.3-.6z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="document-hover-icon-btn"
                                aria-label={`为 ${document.originalFilename} 添加标签`}
                                title="添加标签"
                                disabled={importing || isBusy}
                                onClick={event => {
                                  event.stopPropagation()
                                  setEditingId(null)
                                  setConfirmDeleteId(null)
                                  setDraftTag('')
                                  setTaggingId(document.id)
                                }}
                              >
                                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                                  <path d="M2.5 8.5V3.5a1 1 0 0 1 1-1h5l5 5-5.5 5.5-5.5-4.5z" />
                                  <circle cx="5.5" cy="5.5" r="1" />
                                </svg>
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            className="document-hover-icon-btn"
                            aria-label={`重命名 ${document.originalFilename}`}
                            title="重命名"
                            disabled={importing || isBusy}
                            onClick={event => {
                              event.stopPropagation()
                              startRename(document)
                            }}
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                              <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="document-hover-icon-btn document-hover-icon-btn--danger"
                            aria-label={`删除 ${document.originalFilename}`}
                            title="删除"
                            disabled={importing || isBusy}
                            onClick={event => {
                              event.stopPropagation()
                              startDeleteConfirm(document.id)
                            }}
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                              <path d="M3 4.5h10M6 4.5V3h4v1.5M5.5 7v5M10.5 7v5M4.5 4.5l.5 8.5h6l.5-8.5" />
                            </svg>
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        ) : null}
      </div>
      {onExportBackup || onImportBackup ? (
        <div className="library-backup-bar" role="group" aria-label="文献库备份与恢复">
          {onExportBackup ? (
            <button
              type="button"
              aria-label="导出文献库备份"
              title="一键打包 PDF、批注笔记、译文缓存与术语表，并附 Zotero / EndNote / Obsidian 兼容文件"
              disabled={backingUp || importing}
              onClick={onExportBackup}
            >
              {backingUp ? '处理中…' : '一键备份'}
            </button>
          ) : null}
          {onImportBackup ? (
            <button
              type="button"
              aria-label="从备份恢复文献库"
              title="从 PaperFlow .zip 备份恢复文献、标签、批注、译文缓存与术语表"
              disabled={backingUp || importing}
              onClick={onImportBackup}
            >
              恢复备份
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
}
