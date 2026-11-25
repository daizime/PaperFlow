import { useState } from 'react'
import type { AnnotationColor, AnnotationRecord } from '../../../../shared/contracts'
import './study.css'

export interface AnnotationsDrawerProps {
  open: boolean
  documentId: string | null
  annotations: readonly AnnotationRecord[]
  onClose(): void
  onSelectAnnotation(annotation: AnnotationRecord): void
  onUpdateAnnotation(id: string, patch: { color?: AnnotationColor; note?: string }): Promise<void>
  onDeleteAnnotation(id: string): Promise<void>
  onExportMarkdown(): Promise<{ canceled: boolean; markdown: string; count: number; fileName?: string } | null>
}

const COLOR_FILTERS: Array<{ value: AnnotationColor | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'yellow', label: '黄' },
  { value: 'green', label: '绿' },
  { value: 'blue', label: '蓝' },
  { value: 'pink', label: '粉' }
]

const COLOR_SWATCHES: AnnotationColor[] = ['yellow', 'green', 'blue', 'pink']

export function AnnotationsDrawer({
  open,
  documentId,
  annotations,
  onClose,
  onSelectAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onExportMarkdown
}: AnnotationsDrawerProps): React.JSX.Element | null {
  const [filterColor, setFilterColor] = useState<AnnotationColor | 'all'>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [exportStatus, setExportStatus] = useState<string | null>(null)

  if (!open) return null

  const filtered =
    filterColor === 'all' ? annotations : annotations.filter(item => item.color === filterColor)

  const handleSaveNote = async (id: string): Promise<void> => {
    await onUpdateAnnotation(id, { note: noteDraft })
    setEditingId(null)
    setNoteDraft('')
  }

  const handleExport = async (): Promise<void> => {
    setExportStatus(null)
    const res = await onExportMarkdown()
    if (!res) return
    if (res.canceled) {
      setExportStatus('已取消导出')
      return
    }
    setExportStatus(res.fileName ? `已导出至 ${res.fileName}` : '导出完成')
  }

  return (
    <aside className="study-drawer" role="dialog" aria-label="批注与笔记面板">
      <div className="study-drawer__header">
        <div>
          <h3>批注与笔记</h3>
          <span className="study-drawer__count">共 {annotations.length} 条</span>
        </div>
        <button type="button" className="study-drawer__close" aria-label="关闭批注面板" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="study-drawer__filters" role="group" aria-label="按颜色筛选批注">
        {COLOR_FILTERS.map(f => (
          <button
            key={f.value}
            type="button"
            className={filterColor === f.value ? 'is-active' : undefined}
            onClick={() => setFilterColor(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="study-drawer__list">
        {!documentId ? (
          <p className="study-drawer__empty">请先打开一篇 PDF 文献。</p>
        ) : filtered.length === 0 ? (
          <p className="study-drawer__empty">
            {annotations.length === 0
              ? '点击或框选任意句子/公式后，可在下方工具栏添加多色高亮或 AI 笔记。'
              : '当前颜色筛选下暂无批注。'}
          </p>
        ) : (
          filtered.map(ann => {
            const isEditing = editingId === ann.id
            return (
              <article key={ann.id} className="study-annotation-card">
                <div className="study-annotation-card__top">
                  <span className={`study-annotation-tag study-annotation-tag--${ann.color}`}>
                    第 {ann.pageNumber} 页
                  </span>
                  <div className="study-annotation-swatches">
                    {COLOR_SWATCHES.map(c => (
                      <button
                        key={c}
                        type="button"
                        className={ann.color === c ? `study-color-dot study-color-dot--${c} is-selected` : `study-color-dot study-color-dot--${c}`}
                        aria-label={`改为${c}`}
                        onClick={() => void onUpdateAnnotation(ann.id, { color: c })}
                      />
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  className="study-annotation-card__quote"
                  title="点击跳转到原文对应句子并高亮"
                  onClick={() => onSelectAnnotation(ann)}
                >
                  {ann.quoteText}
                </button>
                {isEditing ? (
                  <div className="study-annotation-card__editor">
                    <textarea
                      rows={3}
                      aria-label="编辑批注笔记"
                      value={noteDraft}
                      onChange={e => setNoteDraft(e.target.value)}
                    />
                    <div className="study-annotation-card__actions">
                      <button type="button" onClick={() => setEditingId(null)}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="study-companion-btn--primary"
                        onClick={() => void handleSaveNote(ann.id)}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {ann.note ? <p className="study-annotation-card__note">{ann.note}</p> : null}
                    <div className="study-annotation-card__actions">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(ann.id)
                          setNoteDraft(ann.note)
                        }}
                      >
                        {ann.note ? '编辑笔记' : '写笔记'}
                      </button>
                      <button
                        type="button"
                        className="study-btn-danger"
                        onClick={() => void onDeleteAnnotation(ann.id)}
                      >
                        删除
                      </button>
                    </div>
                  </>
                )}
              </article>
            )
          })
        )}
      </div>

      {exportStatus ? (
        <div role="status" className="study-drawer__status">
          {exportStatus}
        </div>
      ) : null}

      <div className="study-drawer__footer">
        <button
          type="button"
          className="study-companion-btn--primary"
          disabled={!documentId || annotations.length === 0}
          onClick={() => void handleExport()}
        >
          导出 Markdown
        </button>
      </div>
    </aside>
  )
}
