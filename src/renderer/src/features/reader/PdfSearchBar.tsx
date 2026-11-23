import type { RefObject } from 'react'

export interface PdfSearchBarProps {
  query: string
  caseSensitive: boolean
  activeIndex: number
  totalMatches: number
  searching: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (value: string) => void
  onToggleCaseSensitive: () => void
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}

export function PdfSearchBar({
  query,
  caseSensitive,
  activeIndex,
  totalMatches,
  searching,
  inputRef,
  onQueryChange,
  onToggleCaseSensitive,
  onPrev,
  onNext,
  onClose
}: PdfSearchBarProps): React.JSX.Element {
  let statusText = ''
  if (query.length > 0) {
    if (totalMatches > 0) statusText = `第 ${activeIndex + 1} / ${totalMatches} 处`
    else if (searching) statusText = '正在搜索…'
    else statusText = '无匹配结果'
  }

  return (
    <div
      className="reader-search-bar"
      role="search"
      aria-label="文档内搜索"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <input
        ref={inputRef}
        type="search"
        className="reader-search-bar__input"
        aria-label="搜索文档内容"
        placeholder="搜索文档内容…"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) onPrev()
            else onNext()
          }
        }}
      />
      <button
        type="button"
        className={caseSensitive ? 'reader-search-bar__btn is-active' : 'reader-search-bar__btn'}
        aria-pressed={caseSensitive}
        onClick={onToggleCaseSensitive}
      >
        区分大小写
      </button>
      <span className="reader-search-bar__status" role="status" aria-live="polite">{statusText}</span>
      <button
        type="button"
        className="reader-search-bar__btn"
        aria-label="上一处"
        title="上一处 (Shift+Enter)"
        disabled={totalMatches === 0}
        onClick={onPrev}
      >
        上一处
      </button>
      <button
        type="button"
        className="reader-search-bar__btn"
        aria-label="下一处"
        title="下一处 (Enter)"
        disabled={totalMatches === 0}
        onClick={onNext}
      >
        下一处
      </button>
      <button
        type="button"
        className="reader-search-bar__btn reader-search-bar__close"
        aria-label="关闭搜索"
        title="关闭搜索 (Escape)"
        onClick={onClose}
      >
        关闭搜索
      </button>
    </div>
  )
}
