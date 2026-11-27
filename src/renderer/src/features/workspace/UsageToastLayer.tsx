import type { UsageToastState } from '../translation/usage-format'

export interface UsageToastLayerProps {
  toast: UsageToastState | null
  onDismiss(): void
  onOpenUsageDetails(): void
}

export function UsageToastLayer({
  toast,
  onDismiss,
  onOpenUsageDetails
}: UsageToastLayerProps): React.JSX.Element | null {
  if (!toast) return null
  return (
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
  )
}
