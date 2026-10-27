import { useEffect, useState } from 'react'
import './toolbar.css'

export interface ReaderToolbarProps {
  pageNumber: number
  pageCount: number
  scale: number
  disabled: boolean
  onNavigate: (page: number) => void
  onScale: (scale: number) => void
  onFitWidth: () => void
  onImport: () => void
}

const MIN_SCALE = 0.5
const MAX_SCALE = 3

export function ReaderToolbar({
  pageNumber, pageCount, scale, disabled, onNavigate, onScale, onFitWidth, onImport
}: ReaderToolbarProps): React.JSX.Element {
  const [draftPage, setDraftPage] = useState(String(pageNumber))
  const unavailable = disabled || pageCount < 1

  useEffect(() => { setDraftPage(String(pageNumber)) }, [pageNumber])

  function commitPage(): void {
    const value = draftPage.trim()
    const page = Number(value)
    if (!unavailable && /^\d+$/.test(value) && Number.isSafeInteger(page) && page >= 1 && page <= pageCount) {
      setDraftPage(String(page))
      if (page !== pageNumber) onNavigate(page)
    } else {
      setDraftPage(String(pageNumber))
    }
  }

  function changeScale(delta: number): void {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((scale + delta) * 100) / 100))
    onScale(next)
  }

  return <div className="reader-toolbar" role="toolbar" aria-label="PDF 阅读工具栏">
    <div className="reader-toolbar__group">
      <button type="button" className="reader-toolbar__icon" aria-label="上一页" title="上一页"
        disabled={unavailable || pageNumber <= 1} onClick={() => onNavigate(pageNumber - 1)}>‹</button>
      <label className="reader-toolbar__page">
        <input type="number" inputMode="numeric" min={1} max={Math.max(1, pageCount)} step={1}
          aria-label="当前页码" disabled={unavailable} value={draftPage}
          onChange={event => setDraftPage(event.target.value)} onBlur={commitPage}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
            if (event.key === 'Escape') { event.preventDefault(); setDraftPage(String(pageNumber)) }
          }} />
        <span aria-label="总页数">/ {pageCount}</span>
      </label>
      <button type="button" className="reader-toolbar__icon" aria-label="下一页" title="下一页"
        disabled={unavailable || pageNumber >= pageCount} onClick={() => onNavigate(pageNumber + 1)}>›</button>
    </div>
    <span className="reader-toolbar__divider" aria-hidden="true" />
    <div className="reader-toolbar__group">
      <button type="button" className="reader-toolbar__icon" aria-label="缩小" title="缩小"
        disabled={unavailable || scale <= MIN_SCALE} onClick={() => changeScale(-0.1)}>−</button>
      <output className="reader-toolbar__zoom" aria-label="当前缩放比例" data-testid="zoom-level">{Math.round(scale * 100)}%</output>
      <button type="button" className="reader-toolbar__icon" aria-label="放大" title="放大"
        disabled={unavailable || scale >= MAX_SCALE} onClick={() => changeScale(0.1)}>＋</button>
      <button type="button" disabled={unavailable} onClick={onFitWidth}>适合宽度</button>
    </div>
    <button type="button" className="reader-toolbar__import" aria-label="打开新 PDF" onClick={onImport}>打开新 PDF</button>
  </div>
}
