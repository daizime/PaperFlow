import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  buildCitationKey,
  extractCitationMetadata,
  formatBibtex,
  formatGbt7714,
  formatIeee,
  formatRis,
  type CitationMetadata,
  type FirstPageCitationSource
} from '../../../../shared/citation'
import type { DocumentRecord } from '../../../../shared/contracts'
import './study.css'

export type CitationFormatTab = 'bibtex' | 'ieee' | 'gbt7714' | 'ris'

export interface CitationModalProps {
  open: boolean
  document: DocumentRecord | null
  extractCitationSource?: () => Promise<FirstPageCitationSource | null>
  onClose(): void
}

const CITATION_STORAGE_PREFIX = 'paperflow:citation:v2:'

const FORMAT_TABS: Array<{ id: CitationFormatTab; label: string }> = [
  { id: 'bibtex', label: 'BibTeX' },
  { id: 'ieee', label: 'IEEE' },
  { id: 'gbt7714', label: 'GB/T 7714' },
  { id: 'ris', label: 'RIS' }
]

function loadStoredCitation(documentId: string): CitationMetadata | null {
  try {
    const raw = localStorage.getItem(`${CITATION_STORAGE_PREFIX}${documentId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CitationMetadata>
    if (typeof parsed.title !== 'string') return null
    return {
      title: parsed.title,
      authors: Array.isArray(parsed.authors) ? parsed.authors.filter((a): a is string => typeof a === 'string') : [],
      year: typeof parsed.year === 'string' ? parsed.year : '',
      venue: typeof parsed.venue === 'string' ? parsed.venue : '',
      doi: typeof parsed.doi === 'string' ? parsed.doi : '',
      citeKey: typeof parsed.citeKey === 'string' && parsed.citeKey ? parsed.citeKey : 'paperRef'
    }
  } catch {
    return null
  }
}

export function CitationModal({
  open,
  document,
  extractCitationSource,
  onClose
}: CitationModalProps): React.JSX.Element | null {
  const [meta, setMeta] = useState<CitationMetadata>({
    title: '',
    authors: [],
    year: '',
    venue: '',
    doi: '',
    citeKey: 'paperRef'
  })
  const [authorsDraft, setAuthorsDraft] = useState('')
  const [activeTab, setActiveTab] = useState<CitationFormatTab>('bibtex')
  const [extracting, setExtracting] = useState(false)
  const [copiedNotice, setCopiedNotice] = useState(false)

  const runExtractFromFirstPage = useCallback(async () => {
    if (!document) return
    setExtracting(true)
    try {
      const source = (await extractCitationSource?.()) ?? { page1Text: '' }
      const extracted = extractCitationMetadata(source, document.displayTitle || document.originalFilename)
      setMeta(extracted)
      setAuthorsDraft(extracted.authors.join(', '))
      try {
        localStorage.setItem(`${CITATION_STORAGE_PREFIX}${document.id}`, JSON.stringify(extracted))
      } catch {
        // 忽略本地存储受限错误
      }
    } finally {
      setExtracting(false)
    }
  }, [document, extractCitationSource])

  useEffect(() => {
    if (!open || !document) return
    setCopiedNotice(false)
    const cached = loadStoredCitation(document.id)
    if (cached) {
      setMeta(cached)
      setAuthorsDraft(cached.authors.join(', '))
      return
    }
    void runExtractFromFirstPage()
  }, [open, document, runExtractFromFirstPage])

  const updateMeta = (patch: Partial<CitationMetadata>): void => {
    setMeta(prev => {
      const nextDraft = { ...prev, ...patch }
      const next: CitationMetadata = {
        ...nextDraft,
        citeKey: patch.citeKey !== undefined ? patch.citeKey : buildCitationKey(nextDraft)
      }
      if (document) {
        try {
          localStorage.setItem(`${CITATION_STORAGE_PREFIX}${document.id}`, JSON.stringify(next))
        } catch {
          // 忽略本地存储受限错误
        }
      }
      return next
    })
    setCopiedNotice(false)
  }

  const formattedText = useMemo(() => {
    if (activeTab === 'bibtex') return formatBibtex(meta, { tags: document?.tags })
    if (activeTab === 'ieee') return formatIeee(meta)
    if (activeTab === 'gbt7714') return formatGbt7714(meta)
    return formatRis(meta, { tags: document?.tags })
  }, [activeTab, meta, document?.tags])

  if (!open || !document) return null

  const handleCopy = async (): Promise<void> => {
    try {
      if (window.paperflow?.copyText) {
        await window.paperflow.copyText(formattedText)
      } else {
        await navigator.clipboard.writeText(formattedText)
      }
      setCopiedNotice(true)
    } catch {
      setCopiedNotice(false)
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
      <div className="translation-modal study-modal study-citation-modal" role="dialog" aria-modal="true" aria-label="一键复制引用">
        <div className="translation-modal__header">
          <h3>一键复制文献引用</h3>
          <button type="button" className="translation-modal__close" aria-label="关闭引用窗口" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="translation-modal__body">
          <div className="translation-modal__field">
            <div className="translation-modal__label-row">
              <label className="translation-modal__label" htmlFor="citation-title-input">标题</label>
              <button
                type="button"
                className="study-citation-reextract"
                disabled={extracting}
                onClick={() => void runExtractFromFirstPage()}
              >
                {extracting ? '提取中…' : '从第 1 页重新提取'}
              </button>
            </div>
            <input
              id="citation-title-input"
              type="text"
              value={meta.title}
              onChange={event => updateMeta({ title: event.target.value })}
            />
          </div>

          <div className="translation-modal__row">
            <div className="translation-modal__field">
              <label className="translation-modal__label" htmlFor="citation-authors-input">作者（逗号分隔）</label>
              <input
                id="citation-authors-input"
                type="text"
                placeholder="例如：Jane Doe, Wei Zhang"
                value={authorsDraft}
                onChange={event => {
                  const val = event.target.value
                  setAuthorsDraft(val)
                  const authors = val
                    .split(/[,;]+/)
                    .map(s => s.trim())
                    .filter(Boolean)
                  updateMeta({ authors })
                }}
              />
            </div>
            <div className="translation-modal__field translation-modal__field--small">
              <label className="translation-modal__label" htmlFor="citation-year-input">年份</label>
              <input
                id="citation-year-input"
                type="text"
                placeholder="2024"
                value={meta.year}
                onChange={event => updateMeta({ year: event.target.value })}
              />
            </div>
          </div>

          <div className="translation-modal__row">
            <div className="translation-modal__field">
              <label className="translation-modal__label" htmlFor="citation-venue-input">期刊 / 会议</label>
              <input
                id="citation-venue-input"
                type="text"
                placeholder="例如：SIGMOD / VLDB / IEEE TPAMI"
                value={meta.venue}
                onChange={event => updateMeta({ venue: event.target.value })}
              />
            </div>
            <div className="translation-modal__field">
              <label className="translation-modal__label" htmlFor="citation-doi-input">DOI</label>
              <input
                id="citation-doi-input"
                type="text"
                placeholder="10.1145/..."
                value={meta.doi}
                onChange={event => updateMeta({ doi: event.target.value })}
              />
            </div>
          </div>

          <div className="study-citation-tabs" role="tablist" aria-label="引用格式">
            {FORMAT_TABS.map(tab => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? 'is-active' : undefined}
                onClick={() => {
                  setActiveTab(tab.id)
                  setCopiedNotice(false)
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <pre className="study-citation-preview" aria-label="引用预览">{formattedText}</pre>
        </div>

        <div className="translation-modal__footer">
          <span className="translation-modal__hint">元数据修改会自动保存于本机。</span>
          <div className="translation-modal__footer-right">
            <button type="button" onClick={onClose}>关闭</button>
            <button
              type="button"
              className="translation-modal__primary"
              aria-label="复制当前引用格式"
              onClick={() => void handleCopy()}
            >
              {copiedNotice ? '已复制引用 ✓' : `复制 ${FORMAT_TABS.find(t => t.id === activeTab)?.label ?? ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
