import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AcademicSlideDeck, AcademicSlideSpec } from '../../../../shared/contracts'

export interface PptPreviewModalProps {
  open: boolean
  deck: AcademicSlideDeck | null
  onClose(): void
  onChangeDeck(deck: AcademicSlideDeck): void
  onExport(deck: AcademicSlideDeck): Promise<void> | void
}

const LAYOUT_LABELS: Record<AcademicSlideSpec['layout'], string> = {
  cover: '封面',
  metrics: '核心指标',
  'two-column': '双栏对比',
  cards: '要点卡片',
  closing: '总结 Q&A'
}

export function PptPreviewModal({
  open,
  deck,
  onClose,
  onChangeDeck,
  onExport
}: PptPreviewModalProps): React.JSX.Element | null {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    if (!open) return
    setSelectedIndex(0)
  }, [open, deck?.deckTitle])

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

  if (!open || !deck || deck.slides.length === 0) return null

  const safeIndex = Math.min(selectedIndex, deck.slides.length - 1)
  const activeSlide = deck.slides[safeIndex]
  const isDarkSlide = activeSlide.layout === 'cover' || activeSlide.layout === 'closing'

  const updateSlideAt = (index: number, patch: Partial<AcademicSlideSpec>): void => {
    const nextSlides = deck.slides.map((s, idx) => (idx === index ? { ...s, ...patch } : s))
    onChangeDeck({
      ...deck,
      slides: nextSlides,
      ...(index === 0 && patch.title ? { deckTitle: patch.title } : {})
    })
  }

  const moveSlide = (from: number, to: number): void => {
    if (to < 0 || to >= deck.slides.length) return
    const nextSlides = [...deck.slides]
    const [moved] = nextSlides.splice(from, 1)
    nextSlides.splice(to, 0, moved)
    onChangeDeck({ ...deck, slides: nextSlides })
    setSelectedIndex(to)
  }

  const deleteSlide = (index: number): void => {
    if (deck.slides.length <= 1) return
    const nextSlides = deck.slides.filter((_, idx) => idx !== index)
    onChangeDeck({ ...deck, slides: nextSlides })
    setSelectedIndex(Math.max(0, Math.min(index, nextSlides.length - 1)))
  }

  const handleExportClick = async (): Promise<void> => {
    if (exporting) return
    setExporting(true)
    try {
      await onExport(deck)
    } finally {
      setExporting(false)
    }
  }

  return createPortal(
    <div
      className="translation-modal-backdrop ppt-preview-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="ppt-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label="PPT 幻灯片预览与微调"
        data-testid="ppt-preview-modal"
      >
        <div className="ppt-preview-modal__header">
          <div>
            <h3>16:9 学术汇报幻灯片预览与微调</h3>
            <p className="ppt-preview-modal__subtitle">
              共 {deck.slides.length} 页 · 支持调整顺序、修改标题/要点/演讲备注，所见即所得导出可编辑 .pptx
            </p>
          </div>
          <button type="button" className="translation-modal__close" aria-label="关闭 PPT 预览" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="ppt-preview-modal__workspace">
          {/* 左侧幻灯片目录与排序 */}
          <aside className="ppt-preview-rail" aria-label="幻灯片列表">
            {deck.slides.map((slide, idx) => (
              <div
                key={`${idx}-${slide.layout}`}
                className={`ppt-preview-thumb${idx === safeIndex ? ' is-active' : ''}`}
              >
                <button
                  type="button"
                  className="ppt-preview-thumb__select"
                  data-testid={`ppt-thumb-${idx}`}
                  onClick={() => setSelectedIndex(idx)}
                >
                  <span className="ppt-preview-thumb__num">P.{idx + 1} · {LAYOUT_LABELS[slide.layout]}</span>
                  <span className="ppt-preview-thumb__title">{slide.title || '未命名幻灯片'}</span>
                </button>
                <div className="ppt-preview-thumb__ops">
                  <button
                    type="button"
                    aria-label={`上移第 ${idx + 1} 页`}
                    disabled={idx === 0}
                    onClick={() => moveSlide(idx, idx - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`下移第 ${idx + 1} 页`}
                    disabled={idx === deck.slides.length - 1}
                    onClick={() => moveSlide(idx, idx + 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`删除第 ${idx + 1} 页`}
                    disabled={deck.slides.length <= 1}
                    onClick={() => deleteSlide(idx)}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </aside>

          {/* 右侧 16:9 画布与实时编辑 */}
          <div className="ppt-preview-main">
            <div className={`ppt-preview-canvas${isDarkSlide ? ' is-dark-slide' : ' is-light-slide'}`}>
              <div className="ppt-preview-canvas__top-bar">
                <span>PaperFlow Academic Deck</span>
                <span>
                  {safeIndex + 1} / {deck.slides.length} · {LAYOUT_LABELS[activeSlide.layout]}
                </span>
              </div>
              <div className="ppt-preview-canvas__title">{activeSlide.title}</div>
              {activeSlide.subtitle ? (
                <div className="ppt-preview-canvas__subtitle">{activeSlide.subtitle}</div>
              ) : null}

              {activeSlide.metrics && activeSlide.metrics.length > 0 ? (
                <div className="ppt-preview-canvas__metrics">
                  {activeSlide.metrics.slice(0, 4).map((m, mIdx) => (
                    <div key={mIdx} className="ppt-preview-canvas__metric-card">
                      <strong>{m.value}</strong>
                      <span>{m.label}</span>
                      {m.detail ? <small>{m.detail}</small> : null}
                    </div>
                  ))}
                </div>
              ) : null}

              {activeSlide.columns && activeSlide.columns.length > 0 ? (
                <div className="ppt-preview-canvas__columns">
                  {activeSlide.columns.slice(0, 3).map((col, cIdx) => (
                    <div key={cIdx} className="ppt-preview-canvas__col-card">
                      <strong>{col.heading}</strong>
                      <ul>
                        {col.points.slice(0, 4).map((pt, pIdx) => (
                          <li key={pIdx}>{pt}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : null}

              {activeSlide.bullets && activeSlide.bullets.length > 0 ? (
                <ul className="ppt-preview-canvas__bullets">
                  {activeSlide.bullets.slice(0, 6).map((b, bIdx) => (
                    <li key={bIdx}>{b}</li>
                  ))}
                </ul>
              ) : null}

              {activeSlide.takeaway ? (
                <div className="ppt-preview-canvas__takeaway">核心结论：{activeSlide.takeaway}</div>
              ) : null}
            </div>

            <div className="ppt-preview-editor">
              <div className="ppt-preview-editor__row">
                <label className="ppt-preview-editor__field">
                  <span>幻灯片标题</span>
                  <input
                    type="text"
                    aria-label="编辑幻灯片标题"
                    data-testid="ppt-edit-title-input"
                    value={activeSlide.title}
                    onChange={e => updateSlideAt(safeIndex, { title: e.target.value })}
                  />
                </label>
                <label className="ppt-preview-editor__field">
                  <span>副标题 / 结论摘要</span>
                  <input
                    type="text"
                    aria-label="编辑副标题或结论"
                    value={activeSlide.layout === 'cover' ? (activeSlide.subtitle ?? '') : (activeSlide.takeaway ?? '')}
                    onChange={e =>
                      updateSlideAt(
                        safeIndex,
                        activeSlide.layout === 'cover'
                          ? { subtitle: e.target.value }
                          : { takeaway: e.target.value }
                      )
                    }
                  />
                </label>
              </div>
              <div className="ppt-preview-editor__row">
                <label className="ppt-preview-editor__field">
                  <span>页面要点（每行一条）</span>
                  <textarea
                    rows={3}
                    aria-label="编辑页面要点"
                    value={(activeSlide.bullets ?? []).join('\n')}
                    onChange={e =>
                      updateSlideAt(safeIndex, {
                        bullets: e.target.value
                          .split(/\r?\n/)
                          .map(line => line.trim())
                          .filter(Boolean)
                      })
                    }
                  />
                </label>
                <label className="ppt-preview-editor__field">
                  <span>演讲者备注（Speaker Notes）</span>
                  <textarea
                    rows={3}
                    aria-label="编辑演讲者备注"
                    value={activeSlide.speakerNotes ?? ''}
                    onChange={e => updateSlideAt(safeIndex, { speakerNotes: e.target.value })}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="ppt-preview-modal__footer">
          <span className="ppt-preview-modal__hint">提示：修改会实时保留在本条对话卡片中</span>
          <div className="ppt-preview-modal__footer-actions">
            <button type="button" onClick={onClose}>
              完成微调
            </button>
            <button
              type="button"
              className="translation-modal__primary"
              data-testid="ppt-preview-export-btn"
              disabled={exporting}
              onClick={() => void handleExportClick()}
            >
              {exporting ? '正在生成 .pptx…' : '导出 .pptx'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
