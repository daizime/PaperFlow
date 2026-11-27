import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_GROUPS,
  findShortcutConflict,
  formatShortcutKeys,
  getShortcutDescription,
  keyboardEventToShortcutCombo,
  validateShortcutCombo,
  type ShortcutActionId,
  type ShortcutMap
} from './shortcuts'
import './study.css'

export interface ShortcutsModalProps {
  open: boolean
  shortcuts: ShortcutMap
  onUpdateShortcut(actionId: ShortcutActionId, combo: string): void
  onSwapShortcuts(actionA: ShortcutActionId, actionB: ShortcutActionId): void
  onResetShortcut(actionId: ShortcutActionId): void
  onResetAllShortcuts(): void
  onClose(): void
}

interface RecordingFeedback {
  kind: 'info' | 'error' | 'conflict'
  message: string
  targetActionId?: ShortcutActionId
  conflictActionId?: ShortcutActionId
  pendingCombo?: string
}

export function ShortcutsModal({
  open,
  shortcuts,
  onUpdateShortcut,
  onSwapShortcuts,
  onResetShortcut,
  onResetAllShortcuts,
  onClose
}: ShortcutsModalProps): React.JSX.Element | null {
  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null)
  const [feedback, setFeedback] = useState<RecordingFeedback | null>(null)

  const customizedCount = useMemo(
    () =>
      SHORTCUT_GROUPS.flatMap(g => g.items).filter(item => shortcuts[item.id] !== DEFAULT_SHORTCUTS[item.id]).length,
    [shortcuts]
  )

  useEffect(() => {
    if (!open) {
      setRecordingId(null)
      setFeedback(null)
    }
  }, [open])

  useEffect(() => {
    if (!open || !recordingId) return
    const handleCaptureKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      if (event.key === 'Escape') {
        setRecordingId(null)
        setFeedback(null)
        return
      }

      const combo = keyboardEventToShortcutCombo(event)
      if (!combo) return

      const validation = validateShortcutCombo(combo)
      if (!validation.ok) {
        setFeedback({ kind: 'error', message: validation.reason })
        return
      }

      if (shortcuts[recordingId] === combo) {
        setRecordingId(null)
        setFeedback(null)
        return
      }

      const conflictId = findShortcutConflict(shortcuts, recordingId, combo)
      if (conflictId) {
        const display = formatShortcutKeys(combo).join(' + ')
        const conflictDesc = getShortcutDescription(conflictId)
        setFeedback({
          kind: 'conflict',
          message: `快捷键 ${display} 已被「${conflictDesc}」占用，可直接互换或改按其他按键。`,
          targetActionId: recordingId,
          conflictActionId: conflictId,
          pendingCombo: combo
        })
        return
      }

      const actionDesc = getShortcutDescription(recordingId)
      const display = formatShortcutKeys(combo).join(' + ')
      onUpdateShortcut(recordingId, combo)
      setRecordingId(null)
      setFeedback({ kind: 'info', message: `已将「${actionDesc}」快捷键更新为 ${display}。` })
    }

    window.addEventListener('keydown', handleCaptureKeyDown, true)
    return () => window.removeEventListener('keydown', handleCaptureKeyDown, true)
  }, [open, recordingId, shortcuts, onUpdateShortcut])

  if (!open) return null

  return (
    <div
      className="translation-modal-backdrop"
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="translation-modal study-modal" role="dialog" aria-modal="true" aria-label="快捷键一览">
        <div className="translation-modal__header">
          <div>
            <h3>快捷键一览</h3>
            <div className="translation-modal__subtitle">
              点击右侧键帽即可录制新快捷键；按 Esc 取消当前录制
            </div>
          </div>
          <button type="button" className="translation-modal__close" aria-label="关闭快捷键面板" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="translation-modal__body study-shortcuts-body">
          {feedback ? (
            <div
              role={feedback.kind === 'error' || feedback.kind === 'conflict' ? 'alert' : 'status'}
              data-testid="shortcut-feedback"
              className={`study-shortcuts-feedback study-shortcuts-feedback--${feedback.kind}`}
            >
              <span>{feedback.message}</span>
              {feedback.kind === 'conflict' && feedback.targetActionId && feedback.conflictActionId ? (
                <button
                  type="button"
                  data-testid="shortcut-swap-btn"
                  className="study-shortcuts-swap-btn"
                  onClick={() => {
                    onSwapShortcuts(feedback.targetActionId!, feedback.conflictActionId!)
                    setRecordingId(null)
                    setFeedback({
                      kind: 'info',
                      message: `已互换「${getShortcutDescription(feedback.targetActionId!)}」与「${getShortcutDescription(feedback.conflictActionId!)}」的快捷键。`
                    })
                  }}
                >
                  互换快捷键
                </button>
              ) : null}
            </div>
          ) : null}
          {SHORTCUT_GROUPS.map(group => (
            <section key={group.title} className="study-shortcuts-group">
              <h4>{group.title}</h4>
              <ul className="study-shortcuts-list">
                {group.items.map(item => {
                  const combo = shortcuts[item.id]
                  const isCustomized = combo !== DEFAULT_SHORTCUTS[item.id]
                  const isRecording = recordingId === item.id
                  const displayTokens = formatShortcutKeys(combo)
                  return (
                    <li key={item.id} className={isRecording ? 'study-shortcuts-row is-recording' : 'study-shortcuts-row'}>
                      <span className="study-shortcuts-desc">
                        <span>{item.description}</span>
                        {isCustomized ? <span className="study-shortcuts-custom-tag">已自定义</span> : null}
                      </span>
                      <span className="study-shortcuts-actions">
                        <button
                          type="button"
                          data-testid={`shortcut-bind-${item.id}`}
                          aria-label={`修改快捷键：${item.description}`}
                          aria-pressed={isRecording}
                          className={isRecording ? 'study-shortcuts-keybtn is-recording' : 'study-shortcuts-keybtn'}
                          onClick={() => {
                            setFeedback(null)
                            setRecordingId(curr => (curr === item.id ? null : item.id))
                          }}
                        >
                          {isRecording ? (
                            <span className="study-shortcuts-recording-label">请按下快捷键…</span>
                          ) : (
                            <span className="study-shortcuts-keys">
                              {displayTokens.map((k, idx) => (
                                <kbd key={`${k}-${idx}`}>{k}</kbd>
                              ))}
                            </span>
                          )}
                        </button>
                        {isCustomized ? (
                          <button
                            type="button"
                            data-testid={`shortcut-reset-${item.id}`}
                            className="study-shortcuts-reset-btn"
                            aria-label={`恢复默认快捷键：${item.description}`}
                            title="恢复此项默认快捷键"
                            onClick={() => {
                              if (recordingId === item.id) setRecordingId(null)
                              onResetShortcut(item.id)
                              setFeedback({ kind: 'info', message: `已恢复「${item.description}」默认快捷键。` })
                            }}
                          >
                            ↺
                          </button>
                        ) : null}
                      </span>
                    </li>
                  )
                })}
                {group.title === '界面与精读操作' ? (
                  <li className="study-shortcuts-row">
                    <span className="study-shortcuts-desc">
                      <span>关闭当前浮窗或清除选中状态</span>
                      <span className="study-shortcuts-fixed-tag">固定</span>
                    </span>
                    <span className="study-shortcuts-keys">
                      <kbd>Esc</kbd>
                    </span>
                  </li>
                ) : null}
              </ul>
            </section>
          ))}
        </div>
        <div className="translation-modal__footer">
          <span className="translation-modal__hint">
            {customizedCount > 0 ? `当前已自定义 ${customizedCount} 项快捷键，输入框打字时自动禁用。` : '提示：点击右侧快捷键可自定义，在输入框打字时自动禁用。'}
          </span>
          <div className="translation-modal__footer-right">
            <button
              type="button"
              data-testid="shortcuts-reset-all-btn"
              disabled={customizedCount === 0}
              onClick={() => {
                setRecordingId(null)
                onResetAllShortcuts()
                setFeedback({ kind: 'info', message: '已全部恢复为默认快捷键。' })
              }}
            >
              恢复全部默认
            </button>
            <button type="button" className="translation-modal__primary" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
