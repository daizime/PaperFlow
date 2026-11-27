import type { UnconfiguredEnginePromptState } from '../translation/auto-translate'
import type { UsageToastState } from '../translation/usage-format'

export interface UsageToastLayerProps {
  toast: UsageToastState | null
  unconfiguredPrompt?: UnconfiguredEnginePromptState | null
  onDismiss(): void
  onOpenUsageDetails(): void
  onDismissUnconfiguredPrompt?(): void
  onOpenEngineSettings?(): void
}

export function UsageToastLayer({
  toast,
  unconfiguredPrompt = null,
  onDismiss,
  onOpenUsageDetails,
  onDismissUnconfiguredPrompt,
  onOpenEngineSettings
}: UsageToastLayerProps): React.JSX.Element | null {
  if (!toast && !unconfiguredPrompt) return null
  return (
    <>
      {unconfiguredPrompt ? (
        <div className="translation-unconfigured-layer" aria-live="polite">
          <div
            role="status"
            tabIndex={0}
            data-testid="translation-unconfigured-prompt"
            className="translation-usage-toast translation-usage-toast--warn translation-unconfigured-prompt"
            aria-label="尚未配置翻译与 AI 引擎，点击前往翻译与 AI 引擎设置"
            onClick={() => onOpenEngineSettings?.()}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onOpenEngineSettings?.()
              }
            }}
          >
            <button
              type="button"
              className="translation-usage-toast__close"
              aria-label="关闭未配置提示"
              onClick={event => {
                event.stopPropagation()
                onDismissUnconfiguredPrompt?.()
              }}
            >
              ×
            </button>
            <div className="translation-usage-toast__head">尚未配置翻译引擎</div>
            <div className="translation-usage-toast__body">
              {unconfiguredPrompt.documentTitle
                ? `检测到《${unconfiguredPrompt.documentTitle}》为非中文文献且尚未翻译，`
                : '检测到当前为非中文文献且尚未翻译，'}
              API 或本机 AI CLI 客户端还未配置。
            </div>
            <div className="translation-usage-toast__actions">
              <span className="translation-unconfigured-prompt__cta">点击此处前往「翻译与 AI 引擎设置」 →</span>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div className="translation-usage-toast-layer" aria-live="polite">
          <div
            role="status"
            data-testid="translation-usage-toast"
            data-tone={toast.tone}
            className={`translation-usage-toast translation-usage-toast--${toast.tone}`}
          >
            <button
              type="button"
              className="translation-usage-toast__close"
              aria-label="关闭翻译完成提示"
              onClick={onDismiss}
            >
              ×
            </button>
            <div className="translation-usage-toast__head">{toast.title}</div>
            <div className="translation-usage-toast__body">{toast.body}</div>
            <div className="translation-usage-toast__actions">
              <button
                type="button"
                className="translation-usage-toast__action"
                onClick={onOpenUsageDetails}
              >
                {toast.actionLabel}
              </button>
            </div>
            <span key={toast.id} className="translation-usage-toast__progress" aria-hidden="true" />
          </div>
        </div>
      ) : null}
    </>
  )
}
