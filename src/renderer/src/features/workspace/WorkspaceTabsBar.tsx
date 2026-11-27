import type { DocumentRecord, TranslationExportFormat } from '../../../../shared/contracts'
import {
  DOC_DRAG_MIME,
  formatPaneBadgeShort,
  setActiveWorkspaceDrag,
  type SplitPane
} from '../reader/split-panes'
import { LockIcon, type BatchQueueProgress } from '../translation/TranslationPanel'

export type ReaderViewMode = 'source' | 'dual' | 'translation'

export interface WorkspaceTabsBarProps {
  openTabs: readonly DocumentRecord[]
  resolvedPanes: readonly { pane: SplitPane; document: DocumentRecord }[]
  translatingPagesByDocId: Readonly<Record<string, number>>
  hasSelectedDocument: boolean
  isCompareMode: boolean
  shownTitle: string
  outlineOpen: boolean
  searchOpen: boolean
  toolbarDisabled: boolean
  viewMode: ReaderViewMode
  fullSummary: string
  translatingPage: number | null
  batchQueue: BatchQueueProgress | null
  isCurrentFullyTranslated: boolean
  hasCurrentLayout: boolean
  currentProgressTotal: number
  isCurrentNoText: boolean
  currentPage: number
  pageCount: number
  batchOptionsOpen: boolean
  batchRangeDraft: string
  batchSkipReferences: boolean
  translationExportOpen: boolean
  exportingTranslation: boolean
  scrollSyncLocked: boolean
  libraryCollapsed: boolean
  libraryImporting: boolean
  onOpenDocument(docId: string): void
  onOpenInSplit(docId: string): void
  onCloseTab(docId: string): void
  onToggleOutline(): void
  onToggleSearch(): void
  onChangeViewMode(mode: ReaderViewMode): void
  onCancelTranslation(): void
  onTranslatePage(pageNumber: number, force: boolean): void
  onTranslateBatch(startPage: number, options?: { rangeText?: string; skipReferences?: boolean }): void
  onToggleBatchOptions(): void
  onChangeBatchRangeDraft(next: string): void
  onChangeBatchSkipReferences(checked: boolean): void
  onToggleTranslationExport(): void
  onExportTranslationDocument(format: TranslationExportFormat): void
  onToggleScrollSyncLocked(): void
  onImportPdf(): void
  onToggleCompareMode(): void
}

export function WorkspaceTabsBar({
  openTabs,
  resolvedPanes,
  translatingPagesByDocId,
  hasSelectedDocument,
  isCompareMode,
  shownTitle,
  outlineOpen,
  searchOpen,
  toolbarDisabled,
  viewMode,
  fullSummary,
  translatingPage,
  batchQueue,
  isCurrentFullyTranslated,
  hasCurrentLayout,
  currentProgressTotal,
  isCurrentNoText,
  currentPage,
  pageCount,
  batchOptionsOpen,
  batchRangeDraft,
  batchSkipReferences,
  translationExportOpen,
  exportingTranslation,
  scrollSyncLocked,
  libraryCollapsed,
  libraryImporting,
  onOpenDocument,
  onOpenInSplit,
  onCloseTab,
  onToggleOutline,
  onToggleSearch,
  onChangeViewMode,
  onCancelTranslation,
  onTranslatePage,
  onTranslateBatch,
  onToggleBatchOptions,
  onChangeBatchRangeDraft,
  onChangeBatchSkipReferences,
  onToggleTranslationExport,
  onExportTranslationDocument,
  onToggleScrollSyncLocked,
  onImportPdf,
  onToggleCompareMode
}: WorkspaceTabsBarProps): React.JSX.Element {
  return (
    <div className="workspace-tabs" data-testid="pdf-tab-strip" role="tablist" aria-label="已打开的文献标签页">
      <div className="workspace-tabs__list">
        {openTabs.map(tab => {
          const matchingIndices = resolvedPanes
            .map((item, idx) => (item.document.id === tab.id ? idx : -1))
            .filter(idx => idx >= 0)
          const isPrimaryTab = matchingIndices.includes(0)
          const isAnyPaneTab = matchingIndices.length > 0
          const tabTitle = tab.displayTitle || tab.originalFilename
          const badgeText =
            resolvedPanes.length >= 2 && matchingIndices.length > 0
              ? matchingIndices.map(idx => formatPaneBadgeShort(idx, resolvedPanes.length)).join('/')
              : null

          return (
            <div
              key={tab.id}
              draggable
              onDragStart={event => {
                event.dataTransfer.setData(DOC_DRAG_MIME, tab.id)
                event.dataTransfer.effectAllowed = 'move'
                setActiveWorkspaceDrag({ kind: 'doc', documentId: tab.id })
              }}
              onDragEnd={() => setActiveWorkspaceDrag(null)}
              className={`workspace-tab${isPrimaryTab ? ' is-primary' : ''}${
                isAnyPaneTab && !isPrimaryTab ? ' is-secondary' : ''
              }`}
              data-testid={`pdf-tab-${tab.id}`}
            >
              <button
                type="button"
                role="tab"
                className="workspace-tab__select"
                aria-selected={isAnyPaneTab}
                title={`${tab.originalFilename}（可拖拽到阅读区左/中/右分栏）`}
                onClick={() => onOpenDocument(tab.id)}
              >
                {badgeText ? <span className="workspace-tab__badge">{badgeText}</span> : null}
                <span className="workspace-tab__title">{tabTitle}</span>
                {translatingPagesByDocId[tab.id] ? (
                  <span
                    className="workspace-tab__translating"
                    data-testid={`pdf-tab-translating-${tab.id}`}
                    title={`正在后台翻译第 ${translatingPagesByDocId[tab.id]} 页`}
                  >
                    译中
                  </span>
                ) : null}
              </button>
              {hasSelectedDocument ? (
                <button
                  type="button"
                  className="workspace-tab__icon"
                  data-testid={`pdf-tab-split-${tab.id}`}
                  aria-label={`右侧并排对比 ${tab.originalFilename}`}
                  title="在右侧并排对比"
                  onClick={() => onOpenInSplit(tab.id)}
                >
                  ◫
                </button>
              ) : null}
              {openTabs.length > 1 || isCompareMode ? (
                <button
                  type="button"
                  className="workspace-tab__icon"
                  data-testid={`pdf-tab-close-${tab.id}`}
                  aria-label={`关闭标签页 ${tab.originalFilename}`}
                  title="关闭标签"
                  onClick={() => onCloseTab(tab.id)}
                >
                  ×
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="workspace-tabs__actions" role="toolbar" aria-label="PDF 阅读工具栏" title={shownTitle || undefined}>
        {hasSelectedDocument && !isCompareMode ? (
          <>
            <button
              type="button"
              className={outlineOpen ? 'is-active' : undefined}
              aria-label="文档目录"
              aria-expanded={outlineOpen}
              disabled={toolbarDisabled}
              onClick={onToggleOutline}
            >
              目录
            </button>
            <button
              type="button"
              className={searchOpen ? 'is-active' : undefined}
              aria-label="文内搜索"
              aria-expanded={searchOpen}
              disabled={toolbarDisabled}
              onClick={onToggleSearch}
            >
              搜索
            </button>
            <span className="reader-toolbar__divider" aria-hidden="true" />
            <div className="view-mode-switcher" role="group" aria-label="视图模式" title={viewMode !== 'source' ? fullSummary : undefined}>
              {(
                [
                  { id: 'source', label: '原文' },
                  { id: 'dual', label: '双栏' },
                  { id: 'translation', label: '译文' }
                ] as const
              ).map(mode => (
                <button
                  key={mode.id}
                  type="button"
                  className={viewMode === mode.id ? 'is-selected' : undefined}
                  aria-pressed={viewMode === mode.id}
                  title={mode.id === 'dual' ? '进入双栏。引擎就绪且暂无译文时，自动预译前两页。' : undefined}
                  onClick={() => onChangeViewMode(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {viewMode !== 'source' ? (
              <>
                {translatingPage !== null || batchQueue ? (
                  <button
                    type="button"
                    className="translation-header__btn translation-header__btn--danger"
                    aria-label="取消翻译"
                    title={fullSummary}
                    onClick={onCancelTranslation}
                  >
                    取消翻译
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={
                        isCurrentFullyTranslated
                          ? 'translation-header__btn'
                          : 'translation-header__btn translation-header__btn--primary'
                      }
                      aria-label={isCurrentFullyTranslated ? '重译本页' : '翻译本页'}
                      title={fullSummary}
                      disabled={!hasCurrentLayout || currentProgressTotal === 0 || isCurrentNoText}
                      onClick={() => onTranslatePage(currentPage, isCurrentFullyTranslated)}
                    >
                      {isCurrentFullyTranslated ? '重译本页' : '翻译本页'}
                    </button>
                    {pageCount > 1 ? (
                      <div className="translation-toolbar-anchor">
                        <div className="translation-batch-group">
                          <button
                            type="button"
                            className="translation-header__btn"
                            aria-label="连续翻译后续页"
                            title="从当前页起后台逐页翻译（支持切走看其他论文，可在右侧菜单设范围与跳过参考文献）"
                            onClick={() => onTranslateBatch(currentPage, { skipReferences: batchSkipReferences })}
                          >
                            连续译
                          </button>
                          <button
                            type="button"
                            className={`translation-header__btn translation-batch-caret${batchOptionsOpen ? ' is-active' : ''}`}
                            data-testid="batch-translate-options-btn"
                            aria-label="连续翻译范围与选项"
                            aria-expanded={batchOptionsOpen}
                            title="设置连续翻译页码范围与跳过参考文献"
                            onClick={onToggleBatchOptions}
                          >
                            ▾
                          </button>
                        </div>
                        {batchOptionsOpen ? (
                          <div className="translation-toolbar-popover" data-testid="batch-translate-popover">
                            <div className="translation-toolbar-popover__title">连续翻译选项（后台不中断）</div>
                            <label className="translation-toolbar-popover__field">
                              <span>页码范围（总 {pageCount} 页）</span>
                              <input
                                type="text"
                                data-testid="batch-range-input"
                                aria-label="连续翻译页码范围"
                                placeholder={`${currentPage}-${pageCount} 或 1-3, 5`}
                                value={batchRangeDraft}
                                onChange={e => onChangeBatchRangeDraft(e.target.value)}
                              />
                            </label>
                            <label className="translation-toolbar-popover__check">
                              <input
                                type="checkbox"
                                data-testid="batch-skip-references-checkbox"
                                checked={batchSkipReferences}
                                onChange={e => onChangeBatchSkipReferences(e.target.checked)}
                              />
                              <span>自动跳过参考文献页 (References)</span>
                            </label>
                            <button
                              type="button"
                              className="translation-header__btn translation-header__btn--primary"
                              data-testid="batch-translate-start-btn"
                              onClick={() =>
                                onTranslateBatch(currentPage, {
                                  rangeText: batchRangeDraft,
                                  skipReferences: batchSkipReferences
                                })
                              }
                            >
                              按此范围开始
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                )}
                <div className="translation-toolbar-anchor">
                  <button
                    type="button"
                    className={`translation-header__btn${translationExportOpen ? ' is-active' : ''}`}
                    data-testid="translation-export-btn"
                    aria-label="导出译文"
                    aria-expanded={translationExportOpen}
                    disabled={exportingTranslation}
                    title="导出已翻译页面为双语或纯中文 Markdown / 排版 PDF"
                    onClick={onToggleTranslationExport}
                  >
                    {exportingTranslation ? '导出中…' : '导出译文 ▾'}
                  </button>
                  {translationExportOpen ? (
                    <div className="translation-toolbar-popover" data-testid="translation-export-popover">
                      <div className="translation-toolbar-popover__title">导出已翻译内容</div>
                      <div className="translation-toolbar-popover__list">
                        <button
                          type="button"
                          data-testid="translation-export-bilingual-md"
                          onClick={() => onExportTranslationDocument('bilingual-md')}
                        >
                          中英对照 Markdown (.md)
                        </button>
                        <button
                          type="button"
                          data-testid="translation-export-zh-md"
                          onClick={() => onExportTranslationDocument('zh-md')}
                        >
                          纯中文译文 Markdown (.md)
                        </button>
                        <button
                          type="button"
                          data-testid="translation-export-zh-pdf"
                          onClick={() => onExportTranslationDocument('zh-pdf')}
                        >
                          纯中文排版 PDF (.pdf)
                        </button>
                        <button
                          type="button"
                          data-testid="translation-export-bilingual-pdf"
                          onClick={() => onExportTranslationDocument('bilingual-pdf')}
                        >
                          中英对照排版 PDF (.pdf)
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                {viewMode === 'dual' ? (
                  <button
                    type="button"
                    className={scrollSyncLocked ? 'translation-sync-toggle is-locked' : 'translation-sync-toggle'}
                    aria-label="滚动同步锁定"
                    aria-pressed={scrollSyncLocked}
                    title={
                      scrollSyncLocked
                        ? '已锁定：原文与译文同步上下/左右滑动；点击解锁可各自独立滑动'
                        : '已解锁：两侧可各自上下/左右独立滑动；点击重新锁定并对齐原文'
                    }
                    onClick={onToggleScrollSyncLocked}
                  >
                    <span className="translation-sync-toggle__icon" aria-hidden="true">
                      <LockIcon locked={scrollSyncLocked} />
                    </span>
                    <span>{scrollSyncLocked ? '同步锁定' : '自由滑动'}</span>
                  </button>
                ) : null}
              </>
            ) : null}
            {libraryCollapsed ? (
              <>
                <span className="reader-toolbar__divider" aria-hidden="true" />
                <button
                  type="button"
                  className="reader-toolbar__import"
                  aria-label="打开新 PDF"
                  title="打开新 PDF"
                  disabled={libraryImporting}
                  aria-busy={libraryImporting}
                  onClick={onImportPdf}
                >
                  + PDF
                </button>
              </>
            ) : null}
          </>
        ) : null}
        {hasSelectedDocument ? (
          <button
            type="button"
            className={isCompareMode ? 'workspace-compare-toggle is-active' : 'workspace-compare-toggle'}
            data-testid="compare-mode-toggle"
            aria-pressed={isCompareMode}
            title={isCompareMode ? '退出多篇并排，只保留当前焦点文献' : '并排打开另一篇 PDF 同屏对照（也可直接拖拽文献到阅读区左右边缘）'}
            onClick={onToggleCompareMode}
          >
            {isCompareMode ? `退出多开 (${resolvedPanes.length})` : '并排多开'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
