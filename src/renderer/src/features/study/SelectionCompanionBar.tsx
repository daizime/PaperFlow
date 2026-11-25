import { useEffect, useState } from 'react'
import type { AnnotationColor, ExplainMode } from '../../../../shared/contracts'
import type { ReferencePeekMatch, ReferenceTarget } from './reference-peek'
import './study.css'

export interface SelectionCompanionState {
  pageNumber: number
  quoteText: string
  contextText: string
  isFormulaLikely: boolean
}

export interface ExplainCardState {
  loading: boolean
  mode: ExplainMode
  quoteText: string
  pageNumber: number
  answer: string | null
  error: string | null
}

export interface ReferencePeekState {
  loading: boolean
  target: ReferenceTarget
  match: ReferencePeekMatch | null
}

export interface SelectionCompanionBarProps {
  selection: SelectionCompanionState | null
  explainState: ExplainCardState | null
  savingAnnotation: boolean
  referenceTargets?: readonly ReferenceTarget[]
  peekState?: ReferencePeekState | null
  peekPinned?: boolean
  returnPageNumber?: number | null
  onCreateHighlight(color: AnnotationColor, note?: string): Promise<void>
  onExplain(mode: ExplainMode): void
  onSaveExplainAsNote(): Promise<void>
  onCloseExplain(): void
  onClearSelection(): void
  onPeekReference?(target: ReferenceTarget): void
  onClosePeek?(): void
  onTogglePeekPin?(): void
  onJumpToPage?(pageNumber: number, fromPage?: number): void
  onReturnToPage?(): void
}

const COLOR_OPTIONS: Array<{ color: AnnotationColor; label: string; title: string }> = [
  { color: 'yellow', label: '黄色高亮', title: '黄色高亮' },
  { color: 'green', label: '绿色高亮', title: '绿色高亮' },
  { color: 'blue', label: '蓝色高亮', title: '蓝色高亮' },
  { color: 'pink', label: '粉色高亮', title: '粉色高亮' }
]

const MODE_TITLES: Record<ExplainMode, string> = {
  explain: 'AI 学术解读',
  formula: 'AI 公式解析',
  translate: 'AI 片段精译'
}

export function SelectionCompanionBar({
  selection,
  explainState,
  savingAnnotation,
  referenceTargets = [],
  peekState,
  peekPinned = false,
  returnPageNumber,
  onCreateHighlight,
  onExplain,
  onSaveExplainAsNote,
  onCloseExplain,
  onClearSelection,
  onPeekReference,
  onClosePeek,
  onTogglePeekPin,
  onJumpToPage,
  onReturnToPage
}: SelectionCompanionBarProps): React.JSX.Element | null {
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteColor, setNoteColor] = useState<AnnotationColor>('yellow')
  const [noteDraft, setNoteDraft] = useState('')
  const [copiedNotice, setCopiedNotice] = useState(false)
  const [copiedPeekImage, setCopiedPeekImage] = useState(false)
  const [copiedPeekText, setCopiedPeekText] = useState(false)
  const [captionExpanded, setCaptionExpanded] = useState(false)
  const [savedExplainNotice, setSavedExplainNotice] = useState(false)

  useEffect(() => {
    setNoteOpen(false)
    setNoteDraft('')
  }, [selection?.quoteText, selection?.pageNumber])

  useEffect(() => {
    setSavedExplainNotice(false)
    setCopiedNotice(false)
  }, [explainState?.answer, explainState?.loading])

  useEffect(() => {
    setCopiedPeekImage(false)
    setCopiedPeekText(false)
    setCaptionExpanded(false)
  }, [peekState?.target.key, peekState?.match?.imageDataUrl, peekState?.match?.excerpt])

  if (!selection && !explainState && !peekState && returnPageNumber == null) return null

  const handleNoteSubmit = async (): Promise<void> => {
    if (!selection) return
    await onCreateHighlight(noteColor, noteDraft)
    setNoteDraft('')
    setNoteOpen(false)
  }

  return (
    <div className="study-companion-dock" role="region" aria-label="划句批注与 AI 伴读工具栏">
      {peekState ? (
        <div
          className={
            peekState.match?.imageDataUrl ? 'study-peek-card study-peek-card--visual' : 'study-peek-card'
          }
          role="dialog"
          aria-label="引用与图表速览"
        >
          <div className="study-peek-card__header">
            <strong>{peekState.match ? peekState.match.title : `速览 ${peekState.target.label}`}</strong>
            <div className="study-peek-card__header-actions">
              {!peekState.loading && peekState.match?.imageDataUrl ? (
                <button
                  type="button"
                  className="study-peek-tool-btn"
                  aria-label="复制速览图片"
                  onClick={() => {
                    const img = peekState.match?.imageDataUrl
                    if (!img) return
                    void window.paperflow
                      ?.copyImageDataUrl(img)
                      .then(() => setCopiedPeekImage(true))
                      .catch(() => {})
                  }}
                >
                  {copiedPeekImage ? '已复制图片 ✓' : peekState.target.kind === 'table' ? '复制表图' : '复制图片'}
                </button>
              ) : null}
              {!peekState.loading && peekState.match ? (
                <button
                  type="button"
                  className="study-peek-tool-btn"
                  aria-label="复制速览文本"
                  onClick={() => {
                    const text = peekState.match?.excerpt
                    if (!text) return
                    const copyPromise = window.paperflow?.copyText
                      ? window.paperflow.copyText(text)
                      : navigator.clipboard?.writeText(text)
                    void copyPromise?.then(() => setCopiedPeekText(true)).catch(() => {})
                  }}
                >
                  {copiedPeekText
                    ? '已复制 ✓'
                    : peekState.target.kind === 'citation'
                      ? '复制引用'
                      : '复制题注'}
                </button>
              ) : null}
              {!peekState.loading && peekState.match && onJumpToPage ? (
                <button
                  type="button"
                  className="study-peek-tool-btn study-companion-btn--primary"
                  onClick={() => onJumpToPage(peekState.match!.pageNumber, selection?.pageNumber)}
                >
                  跳到第 {peekState.match.pageNumber} 页
                </button>
              ) : null}
              {onTogglePeekPin ? (
                <button
                  type="button"
                  className={peekPinned ? 'study-peek-pin is-active' : 'study-peek-pin'}
                  aria-label={peekPinned ? '取消固定速览卡片' : '固定速览卡片'}
                  aria-pressed={peekPinned}
                  title={peekPinned ? '已固定：点击正文或滚动不会自动关闭' : '点击固定卡片；未固定时点击正文或继续滚动会自动收起'}
                  onClick={onTogglePeekPin}
                >
                  {peekPinned ? '已固定' : '固定'}
                </button>
              ) : null}
              {onClosePeek ? (
                <button
                  type="button"
                  className="study-explain-card__close"
                  aria-label="关闭速览卡片"
                  onClick={onClosePeek}
                >
                  ×
                </button>
              ) : null}
            </div>
          </div>
          <div className="study-peek-card__body">
            {peekState.loading ? (
              <p className="study-explain-card__loading">正在全篇定位 {peekState.target.label}…</p>
            ) : peekState.match ? (
              peekState.match.imageDataUrl ? (
                <>
                  <div className="study-peek-card__preview">
                    <img
                      className="study-peek-card__image"
                      src={peekState.match.imageDataUrl}
                      alt={peekState.match.title}
                    />
                  </div>
                  <p
                    className={
                      captionExpanded
                        ? 'study-peek-card__caption-strip is-expanded'
                        : 'study-peek-card__caption-strip'
                    }
                    title={peekState.match.excerpt}
                    onClick={() => setCaptionExpanded(v => !v)}
                  >
                    {peekState.match.excerpt}
                  </p>
                </>
              ) : (
                <p className="study-peek-card__excerpt">{peekState.match.excerpt}</p>
              )
            ) : (
              <p className="study-explain-card__loading">未在当前文献文字层找到 {peekState.target.label} 的题注或参考文献条目。</p>
            )}
          </div>
        </div>
      ) : null}

      {explainState ? (
        <div className="study-explain-card" role="dialog" aria-label={MODE_TITLES[explainState.mode]}>
          <div className="study-explain-card__header">
            <strong>{MODE_TITLES[explainState.mode]}</strong>
            <span className="study-explain-card__page">第 {explainState.pageNumber} 页</span>
            <button
              type="button"
              className="study-explain-card__close"
              aria-label="关闭解读卡片"
              onClick={onCloseExplain}
            >
              ×
            </button>
          </div>
          <div className="study-explain-card__quote" title={explainState.quoteText}>
            {explainState.quoteText}
          </div>
          <div className="study-explain-card__body">
            {explainState.loading ? (
              <p className="study-explain-card__loading">正在调用已配置的 AI 引擎解析…</p>
            ) : explainState.error ? (
              <div role="alert" className="error-banner">{explainState.error}</div>
            ) : (
              <p className="study-explain-card__answer">{explainState.answer}</p>
            )}
          </div>
          {!explainState.loading && explainState.answer ? (
            <div className="study-explain-card__actions">
              <button
                type="button"
                onClick={() => {
                  if (!explainState.answer) return
                  const copyPromise = window.paperflow?.copyText
                    ? window.paperflow.copyText(explainState.answer)
                    : navigator.clipboard?.writeText(explainState.answer)
                  void copyPromise?.then(() => setCopiedNotice(true)).catch(() => {})
                }}
              >
                {copiedNotice ? '已复制' : '复制解析'}
              </button>
              <button
                type="button"
                className="study-companion-btn--primary"
                disabled={savingAnnotation}
                onClick={() => {
                  void onSaveExplainAsNote().then(() => setSavedExplainNotice(true))
                }}
              >
                {savedExplainNotice ? '已存为批注' : '存为笔记'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {selection ? (
        <div className="study-companion-bar">
          <div className="study-companion-bar__row">
            <div className="study-companion-colors" role="group" aria-label="高亮颜色">
              {COLOR_OPTIONS.map(opt => (
                <button
                  key={opt.color}
                  type="button"
                  className={`study-color-dot study-color-dot--${opt.color}`}
                  aria-label={opt.label}
                  title={opt.title}
                  disabled={savingAnnotation}
                  onClick={() => {
                    void onCreateHighlight(opt.color)
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              className={noteOpen ? 'study-companion-btn is-active' : 'study-companion-btn'}
              aria-label="添加批注笔记"
              disabled={savingAnnotation}
              onClick={() => setNoteOpen(open => !open)}
            >
              记笔记
            </button>
            <button
              type="button"
              className={selection.isFormulaLikely ? 'study-companion-btn' : 'study-companion-btn study-companion-btn--accent'}
              aria-label="AI 解释选中内容"
              disabled={Boolean(explainState?.loading)}
              onClick={() => onExplain('explain')}
            >
              AI 解释
            </button>
            <button
              type="button"
              className={selection.isFormulaLikely ? 'study-companion-btn study-companion-btn--accent' : 'study-companion-btn'}
              aria-label="解释公式"
              disabled={Boolean(explainState?.loading)}
              onClick={() => onExplain('formula')}
            >
              解释公式
            </button>
            {onPeekReference && referenceTargets.length > 0
              ? referenceTargets.map(target => (
                  <button
                    key={`${target.kind}-${target.key}`}
                    type="button"
                    className="study-companion-btn study-companion-btn--peek"
                    aria-label={`速览 ${target.label}`}
                    onClick={() => onPeekReference(target)}
                  >
                    速览 {target.label}
                  </button>
                ))
              : null}
            <button
              type="button"
              className="study-companion-close"
              aria-label="取消当前选中"
              onClick={onClearSelection}
            >
              ×
            </button>
          </div>
          {noteOpen ? (
            <div className="study-note-composer">
              <div className="study-note-composer__colors">
                {COLOR_OPTIONS.map(opt => (
                  <button
                    key={opt.color}
                    type="button"
                    className={
                      noteColor === opt.color
                        ? `study-color-dot study-color-dot--${opt.color} is-selected`
                        : `study-color-dot study-color-dot--${opt.color}`
                    }
                    aria-label={`选择${opt.label}`}
                    onClick={() => setNoteColor(opt.color)}
                  />
                ))}
              </div>
              <textarea
                rows={2}
                aria-label="批注笔记输入框"
                value={noteDraft}
                onChange={e => setNoteDraft(e.target.value)}
                placeholder="输入批注笔记，支持保存后导出为 Markdown…"
              />
              <button
                type="button"
                className="study-companion-btn--primary"
                disabled={savingAnnotation}
                onClick={() => void handleNoteSubmit()}
              >
                保存批注
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {returnPageNumber != null && onReturnToPage ? (
        <div className="study-return-pill">
          <button type="button" className="study-companion-btn study-companion-btn--accent" onClick={onReturnToPage}>
            返回第 {returnPageNumber} 页
          </button>
        </div>
      ) : null}
    </div>
  )
}
