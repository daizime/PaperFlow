import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  DocumentRecord,
  LiteratureSearchItem,
  LiteratureSearchSort,
  SearchLiteratureResult
} from '../../../../shared/contracts'
import { findMatchingLocalDocument } from './literature-match'

export { findMatchingLocalDocument }

export interface LiteratureSearchModalProps {
  open: boolean
  initialQuery?: string
  initialTags?: string[]
  libraryTags: readonly string[]
  recommendedTags: readonly string[]
  localDocuments?: readonly DocumentRecord[]
  activeFolderId?: string | null
  onClose(): void
  onImported(document: DocumentRecord): Promise<void> | void
  onOpenDocument(documentId: string): void
}

function buildItemBibtex(item: LiteratureSearchItem): string {
  const firstAuthor = (item.authors[0] || 'Author').split(/\s+/).pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'Author'
  const key = `${firstAuthor}${item.year ?? 'Year'}`
  const authorsStr = item.authors.length > 0 ? item.authors.join(' and ') : 'Unknown Author'
  const fields = [
    `  title = {${item.title}}`,
    `  author = {${authorsStr}}`,
    ...(item.year ? [`  year = {${item.year}}`] : []),
    ...(item.venue ? [`  journal = {${item.venue}}`] : []),
    ...(item.doi ? [`  doi = {${item.doi}}`] : []),
    ...(item.landingUrl ? [`  url = {${item.landingUrl}}`] : [])
  ]
  return `@article{${key},\n${fields.join(',\n')}\n}`
}

export function LiteratureSearchModal({
  open,
  initialQuery = '',
  initialTags = [],
  libraryTags,
  recommendedTags,
  localDocuments = [],
  activeFolderId,
  onClose,
  onImported,
  onOpenDocument
}: LiteratureSearchModalProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [sort, setSort] = useState<LiteratureSearchSort>('relevance')
  const [openAccessOnly, setOpenAccessOnly] = useState(false)
  const [yearWindow, setYearWindow] = useState<'all' | '3y' | '5y'>('all')
  const [useAiAssist, setUseAiAssist] = useState(true)

  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SearchLiteratureResult | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importedDocsByItemId, setImportedDocsByItemId] = useState<Record<string, DocumentRecord>>({})
  const [zhSummariesByItemId, setZhSummariesByItemId] = useState<Record<string, string>>({})
  const [summarizingId, setSummarizingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const requestSeqRef = useRef(0)

  const combinedTags = useMemo(() => {
    const map = new Map<string, { tag: string; fromLibrary: boolean }>()
    for (const tag of libraryTags) {
      const clean = tag.trim()
      if (!clean) continue
      map.set(clean.toLowerCase(), { tag: clean, fromLibrary: true })
    }
    for (const tag of recommendedTags) {
      const clean = tag.trim()
      if (!clean) continue
      const key = clean.toLowerCase()
      if (!map.has(key)) map.set(key, { tag: clean, fromLibrary: false })
    }
    for (const tag of selectedTags) {
      const clean = tag.trim()
      if (!clean) continue
      const key = clean.toLowerCase()
      if (!map.has(key)) map.set(key, { tag: clean, fromLibrary: false })
    }
    return Array.from(map.values()).slice(0, 20)
  }, [libraryTags, recommendedTags, selectedTags])

  const executeSearch = useCallback(
    async (overrides?: {
      query?: string
      tags?: string[]
      sort?: LiteratureSearchSort
      openAccessOnly?: boolean
      yearWindow?: 'all' | '3y' | '5y'
      useAiAssist?: boolean
    }): Promise<void> => {
      const q = (overrides?.query ?? query).trim()
      const t = overrides?.tags ?? selectedTags
      if (!q && t.length === 0) {
        setError('请输入搜索关键词，或点选下方标签以发现相关文献。')
        return
      }
      const seq = ++requestSeqRef.current
      const activeWindow = overrides?.yearWindow ?? yearWindow
      const currentYear = new Date().getFullYear()
      const yearFrom =
        activeWindow === '3y' ? currentYear - 2 : activeWindow === '5y' ? currentYear - 4 : undefined

      setSearching(true)
      setError(null)
      try {
        const res = await window.paperflow.searchLiterature({
          query: q,
          tags: t,
          sort: overrides?.sort ?? sort,
          openAccessOnly: overrides?.openAccessOnly ?? openAccessOnly,
          yearFrom,
          limit: 15,
          useAiAssist: overrides?.useAiAssist ?? useAiAssist
        })
        if (requestSeqRef.current !== seq) return
        setResult(res)
      } catch (err: unknown) {
        if (requestSeqRef.current !== seq) return
        setError(err instanceof Error ? err.message : '搜索学术文献失败，请检查网络连接或配置。')
      } finally {
        if (requestSeqRef.current === seq) {
          setSearching(false)
        }
      }
    },
    [query, selectedTags, sort, openAccessOnly, yearWindow, useAiAssist]
  )

  useEffect(() => {
    if (!open) return
    const nextQuery = initialQuery.trim()
    const nextTags = Array.from(new Set(initialTags.map(t => t.trim()).filter(Boolean)))
    setQuery(nextQuery)
    setSelectedTags(nextTags)
    setError(null)
    setExpandedIds(new Set())
    setImportedDocsByItemId({})
    setZhSummariesByItemId({})
    setResult(null)
    window.setTimeout(() => searchInputRef.current?.focus(), 0)
    if (nextQuery || nextTags.length > 0) {
      void executeSearch({ query: nextQuery, tags: nextTags })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuery, JSON.stringify(initialTags)])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const toggleTag = (tag: string): void => {
    const key = tag.toLowerCase()
    setSelectedTags(prev =>
      prev.some(t => t.toLowerCase() === key) ? prev.filter(t => t.toLowerCase() !== key) : [...prev, tag]
    )
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void executeSearch()
  }

  const handleImportPdf = async (item: LiteratureSearchItem): Promise<void> => {
    if (!item.pdfUrl || importingId) return
    setImportingId(item.id)
    setError(null)
    try {
      const mergedTags = Array.from(
        new Set([...selectedTags, ...item.topics.slice(0, 2).map(t => t.slice(0, 28))])
      ).slice(0, 8)
      const targetFolderId =
        activeFolderId && activeFolderId !== 'unassigned' ? activeFolderId : undefined
      const res = await window.paperflow.importLiteraturePdf({
        pdfUrl: item.pdfUrl,
        title: item.title,
        tags: mergedTags,
        ...(targetFolderId ? { folderId: targetFolderId } : {})
      })
      setImportedDocsByItemId(prev => ({ ...prev, [item.id]: res.document }))
      await onImported(res.document)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '一键导入 PDF 失败，请改用浏览器打开后下载。')
    } finally {
      setImportingId(curr => (curr === item.id ? null : curr))
    }
  }

  const handleSummarizeAbstract = async (item: LiteratureSearchItem): Promise<void> => {
    if (!item.abstract || summarizingId) return
    setSummarizingId(item.id)
    setError(null)
    try {
      const res = await window.paperflow.summarizeLiteratureAbstract({
        title: item.title,
        abstract: item.abstract
      })
      setZhSummariesByItemId(prev => ({ ...prev, [item.id]: res.summary }))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '生成中文速览失败，请检查模型配置。')
    } finally {
      setSummarizingId(curr => (curr === item.id ? null : curr))
    }
  }

  return (
    <div
      className="translation-modal-backdrop"
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="translation-modal literature-modal"
        role="dialog"
        aria-modal="true"
        aria-label="AI 学术文献搜索与发现"
        data-testid="literature-search-modal"
      >
        <div className="translation-modal__header">
          <div>
            <h3>AI 搜文献 · 开放学术检索与标签关联</h3>
            <p className="literature-modal__subtitle">
              由主进程受控接入 OpenAlex + arXiv（支持 AI 智能扩词与标签检索，可一键导入开放获取 PDF）
            </p>
          </div>
          <button type="button" className="translation-modal__close" aria-label="关闭文献搜索弹窗" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="translation-modal__body literature-modal__body">
          <form className="literature-search-form" onSubmit={handleSubmit}>
            <input
              ref={searchInputRef}
              type="search"
              data-testid="literature-search-input"
              aria-label="输入研究问题、关键词或论文题目"
              placeholder="输入中/英文主题，或直接粘贴 DOI / arXiv 链接与编号（如 2501.00099）"
              value={query}
              disabled={searching}
              onChange={event => setQuery(event.target.value)}
            />
            <button
              type="submit"
              className="translation-modal__primary"
              data-testid="literature-search-submit"
              disabled={searching || (!query.trim() && selectedTags.length === 0)}
            >
              {searching ? '检索中…' : '搜索'}
            </button>
          </form>

          {combinedTags.length > 0 ? (
            <div className="literature-tags-bar" data-testid="literature-tags-bar">
              <span className="literature-tags-bar__label">按标签搜相关：</span>
              <div className="literature-tags-bar__chips">
                {combinedTags.map(({ tag, fromLibrary }) => {
                  const active = selectedTags.some(t => t.toLowerCase() === tag.toLowerCase())
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={active ? 'literature-tag-chip is-active' : 'literature-tag-chip'}
                      title={fromLibrary ? '文献库已有标签（点击选中/取消）' : '学科推荐标签'}
                      onClick={() => toggleTag(tag)}
                    >
                      #{tag}
                    </button>
                  )
                })}
                {selectedTags.length > 0 ? (
                  <button
                    type="button"
                    className="literature-tag-chip literature-tag-chip--action"
                    data-testid="literature-search-by-selected-tags"
                    disabled={searching}
                    onClick={() => void executeSearch({ tags: selectedTags })}
                  >
                    按已选 {selectedTags.length} 个标签检索
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="literature-controls-row">
            <label className="literature-inline-opt">
              <input
                type="checkbox"
                checked={useAiAssist}
                onChange={event => setUseAiAssist(event.target.checked)}
              />
              <span>AI 智能扩词（自动转英文学术检索式）</span>
            </label>
            <label className="literature-inline-opt">
              <input
                type="checkbox"
                data-testid="literature-oa-only"
                checked={openAccessOnly}
                onChange={event => setOpenAccessOnly(event.target.checked)}
              />
              <span>仅看开放获取 PDF</span>
            </label>
            <select
              aria-label="检索排序"
              value={sort}
              onChange={event => setSort(event.target.value as LiteratureSearchSort)}
            >
              <option value="relevance">按相关性</option>
              <option value="citations">按被引用数</option>
              <option value="recent">按发表年份</option>
            </select>
            <select
              aria-label="发表年份范围"
              value={yearWindow}
              onChange={event => setYearWindow(event.target.value as 'all' | '3y' | '5y')}
            >
              <option value="all">全部年份</option>
              <option value="3y">近 3 年</option>
              <option value="5y">近 5 年</option>
            </select>
          </div>

          {result ? (
            <div className="literature-meta-strip" data-testid="literature-search-meta">
              <span>
                共找到 <strong>{result.items.length}</strong> 篇结果 · 检索词：
                <code>{result.effectiveQuery}</code>
              </span>
              {result.usedAiExpansion && result.aiKeywords.length > 0 ? (
                <span className="literature-ai-badge" data-testid="literature-ai-keywords-badge">
                  AI 扩词：{result.aiKeywords.join(' / ')}
                </span>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div role="alert" className="translation-modal__status translation-modal__status--err">
              {error}
            </div>
          ) : null}

          {result && result.warnings.length > 0 ? (
            <div className="literature-warning-note">{result.warnings.join('；')}</div>
          ) : null}

          <div className="literature-results-list" data-testid="literature-results-list">
            {searching ? (
              <div className="literature-empty-state">正在同步检索 OpenAlex 与 arXiv 学术库…</div>
            ) : !result ? (
              <div className="literature-empty-state">
                输入中/英文关键词或点击标签后点击「搜索」，即可发现开放获取论文并一键导入到本地文献库。
              </div>
            ) : result.items.length === 0 ? (
              <div className="literature-empty-state">未命中符合条件的文献，可放宽年份或关闭“仅看开放获取”后重试。</div>
            ) : (
              result.items.map(item => {
                const matchedLocalDoc = findMatchingLocalDocument(item, localDocuments)
                const importedDoc = importedDocsByItemId[item.id] ?? matchedLocalDoc
                const expanded = expandedIds.has(item.id)
                const isImporting = importingId === item.id
                const zhSummary = zhSummariesByItemId[item.id]
                const isSummarizing = summarizingId === item.id
                return (
                  <article key={item.id} className="literature-result-card" data-testid="literature-result-card">
                    <div className="literature-result-card__top">
                      <span className={`literature-source-badge literature-source-badge--${item.source}`}>
                        {item.source === 'arxiv' ? 'arXiv' : 'OpenAlex'}
                      </span>
                      {matchedLocalDoc && !importedDocsByItemId[item.id] ? (
                        <span className="literature-in-library-pill" data-testid="literature-in-library-badge">
                          已在库中
                        </span>
                      ) : null}
                      {item.year ? <span className="literature-meta-pill">{item.year}</span> : null}
                      {item.venue ? (
                        <span className="literature-meta-pill literature-meta-pill--venue" title={item.venue}>
                          {item.venue}
                        </span>
                      ) : null}
                      {item.citationCount !== null ? (
                        <span className="literature-meta-pill">被引用 {item.citationCount}</span>
                      ) : null}
                      {item.pdfUrl ? (
                        <span className="literature-oa-pill">OA PDF</span>
                      ) : null}
                    </div>
                    <h4 className="literature-result-card__title">{item.title}</h4>
                    {item.authors.length > 0 ? (
                      <div className="literature-result-card__authors">{item.authors.join(', ')}</div>
                    ) : null}
                    {zhSummary ? (
                      <div className="literature-zh-summary" data-testid="literature-zh-summary">
                        <strong>中文速览：</strong>
                        {zhSummary}
                      </div>
                    ) : null}
                    {item.abstract ? (
                      <div className="literature-result-card__abstract-wrap">
                        <p
                          className={
                            expanded
                              ? 'literature-result-card__abstract is-expanded'
                              : 'literature-result-card__abstract'
                          }
                        >
                          {item.abstract}
                        </p>
                        {item.abstract.length > 180 ? (
                          <button
                            type="button"
                            className="literature-link-btn"
                            onClick={() =>
                              setExpandedIds(prev => {
                                const next = new Set(prev)
                                if (next.has(item.id)) next.delete(item.id)
                                else next.add(item.id)
                                return next
                              })
                            }
                          >
                            {expanded ? '收起摘要' : '展开摘要'}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="literature-result-card__actions">
                      {importedDoc ? (
                        <button
                          type="button"
                          className="translation-modal__primary"
                          data-testid="literature-open-imported-btn"
                          onClick={() => {
                            onOpenDocument(importedDoc.id)
                            onClose()
                          }}
                        >
                          {importedDocsByItemId[item.id] ? '已导入 · 打开阅读' : '已在库中 · 打开阅读'}
                        </button>
                      ) : item.pdfUrl ? (
                        <button
                          type="button"
                          className="translation-modal__primary"
                          data-testid="literature-import-pdf-btn"
                          disabled={Boolean(importingId)}
                          onClick={() => void handleImportPdf(item)}
                        >
                          {isImporting ? '正在下载校验…' : '一键导入文献库'}
                        </button>
                      ) : null}
                      {item.abstract && !zhSummary ? (
                        <button
                          type="button"
                          data-testid="literature-summarize-btn"
                          disabled={Boolean(summarizingId)}
                          onClick={() => void handleSummarizeAbstract(item)}
                        >
                          {isSummarizing ? '速览生成中…' : '中文速览'}
                        </button>
                      ) : null}
                      {(item.landingUrl || item.pdfUrl) ? (
                        <button
                          type="button"
                          onClick={() => {
                            const url = item.landingUrl || item.pdfUrl
                            if (!url) return
                            setError(null)
                            void window.paperflow.openExternalUrl(url).catch((err: unknown) => {
                              setError(err instanceof Error ? err.message : '无法打开该学术链接。')
                            })
                          }}
                        >
                          浏览器打开
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          void window.paperflow.copyText(buildItemBibtex(item))
                          setCopiedId(item.id)
                          window.setTimeout(() => setCopiedId(c => (c === item.id ? null : c)), 1600)
                        }}
                      >
                        {copiedId === item.id ? '已复制 BibTeX' : '复制 BibTeX'}
                      </button>
                    </div>
                  </article>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
