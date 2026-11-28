import { type RefObject } from 'react'
import type { DocumentRecord, DocumentTranslationScope, ReadingTheme } from '../../../../shared/contracts'
import { BrandPageIcon } from '../../components/UiIcons'
import type { HeaderEnginePillModel } from '../translation/usage-format'

export type { ReadingTheme }

const THEME_OPTIONS: Array<{ id: ReadingTheme; label: string }> = [
  { id: 'light', label: '明亮' },
  { id: 'sepia', label: '护眼' },
  { id: 'dark', label: '深色' }
]

function ReadingThemeIcon({ theme }: { theme: ReadingTheme }): React.JSX.Element {
  if (theme === 'dark') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13.5 9.8A5.7 5.7 0 0 1 6.2 2.5a5.8 5.8 0 1 0 7.3 7.3Z" />
      </svg>
    )
  }
  if (theme === 'sepia') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 3.5h4.2c.7 0 1.3.6 1.3 1.3v8.4c0-.6-.6-1.1-1.3-1.1H2.5V3.5Z" />
        <path d="M13.5 3.5H9.3c-.7 0-1.3.6-1.3 1.3v8.4c0-.6.6-1.1 1.3-1.1h4.2V3.5Z" />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.7v1.5M8 12.8v1.5M2.9 2.9l1.1 1.1M12 12l1.1 1.1M1.7 8h1.5M12.8 8h1.5M2.9 13.1 4 12M12 4l1.1-1.1" />
    </svg>
  )
}

export interface WorkspaceHeaderProps {
  libraryCollapsed: boolean
  onToggleLibrary(): void
  researchBadgeLabel: string | null
  onOpenOnboarding(): void
  hasDocument: boolean
  isCompareMode: boolean
  activePaneLabel: string | null
  activeDocument: DocumentRecord | null
  documentScope: DocumentTranslationScope | null
  onOpenScopeGlossary(folderId: string | null): void
  annotationsOpen: boolean
  annotationCount: number
  onToggleAnnotations(): void
  citationOpen: boolean
  onOpenCitation(): void
  headerEnginePill: HeaderEnginePillModel
  onOpenEngineSettings(): void
  themeMenuRef: RefObject<HTMLDivElement | null>
  theme: ReadingTheme
  themeMenuOpen: boolean
  onToggleThemeMenu(): void
  onSelectTheme(next: ReadingTheme): void
  aiChatOpen: boolean
  onToggleAiChat(): void
  shortcutsOpen: boolean
  onToggleShortcuts(): void
}

export function WorkspaceHeader({
  libraryCollapsed,
  onToggleLibrary,
  researchBadgeLabel,
  onOpenOnboarding,
  hasDocument,
  isCompareMode,
  activePaneLabel,
  activeDocument,
  documentScope,
  onOpenScopeGlossary,
  annotationsOpen,
  annotationCount,
  onToggleAnnotations,
  citationOpen,
  onOpenCitation,
  headerEnginePill,
  onOpenEngineSettings,
  themeMenuRef,
  theme,
  themeMenuOpen,
  onToggleThemeMenu,
  onSelectTheme,
  aiChatOpen,
  onToggleAiChat,
  shortcutsOpen,
  onToggleShortcuts
}: WorkspaceHeaderProps): React.JSX.Element {
  return (
    <header className="app-header">
      <div className="app-header__left">
        <div className="app-header__brand">
          <div className="brand-mark" aria-hidden="true">
            <BrandPageIcon size={15} />
          </div>
          <strong>Foliopair</strong>
        </div>
        <div className="app-header__nav-group" role="group" aria-label="工作区导航">
          <button
            type="button"
            className={libraryCollapsed ? 'app-header__sidebar-toggle is-collapsed' : 'app-header__sidebar-toggle'}
            aria-label="切换文献库侧边栏"
            aria-expanded={!libraryCollapsed}
            onClick={onToggleLibrary}
          >
            {libraryCollapsed ? '展开文献库' : '收起文献库'}
          </button>
          <button
            type="button"
            className="app-header__onboarding-btn"
            data-testid="open-onboarding-btn"
            aria-label="设置或切换科研方向"
            title={researchBadgeLabel ? `当前科研方向：${researchBadgeLabel}（点击修改）` : '研究生科研向导：设置研究方向、预设标签与术语表'}
            onClick={onOpenOnboarding}
          >
            {researchBadgeLabel ?? '科研向导'}
          </button>
        </div>
      </div>

      <div className="app-header__center">
        {hasDocument ? (
          <div className="app-header__center-group" data-testid="header-reading-tools" role="group" aria-label="阅读工具">
            {isCompareMode && activePaneLabel ? (
              <span
                className="app-header__focus-pill"
                data-testid="header-active-pane-badge"
                title={`当前顶栏词库、批注与引用默认作用于「${activePaneLabel}」${activeDocument?.displayTitle || activeDocument?.originalFilename || ''}`}
              >
                {activePaneLabel}
              </span>
            ) : null}
            {documentScope ? (
              <button
                type="button"
                className="reader-glossary-scope-pill"
                data-testid="reader-glossary-scope-btn"
                title={
                  documentScope.folderId
                    ? `当前生效分类「${documentScope.folderName}」词库（共 ${documentScope.effectiveGlossaryCount} 条）；点击编辑分类词库`
                    : `当前未归入分类，使用全局词库（${documentScope.effectiveGlossaryCount} 条）；点击打开翻译词库设置`
                }
                onClick={() => onOpenScopeGlossary(documentScope.folderId)}
              >
                {documentScope.folderId
                  ? `词库：${documentScope.folderName} (${documentScope.effectiveGlossaryCount})`
                  : `词库：全局 (${documentScope.effectiveGlossaryCount})`}
              </button>
            ) : null}
            <button
              type="button"
              className={annotationsOpen ? 'is-active' : undefined}
              aria-label="批注与笔记"
              aria-expanded={annotationsOpen}
              onClick={onToggleAnnotations}
            >
              批注{annotationCount > 0 ? ` (${annotationCount})` : ''}
            </button>
            <button
              type="button"
              className={citationOpen ? 'is-active' : undefined}
              aria-label="复制文献引用"
              title="一键复制 BibTeX / IEEE / GB/T 7714 引用 (C)"
              onClick={onOpenCitation}
            >
              引用
            </button>
          </div>
        ) : null}
      </div>

      <div className="app-header__right">
        <div className="app-header__engine-wrap">
          <button
            type="button"
            className={`app-header__engine-btn${headerEnginePill.tone === 'warn' ? ' is-low-balance' : ''}`}
            data-testid="header-engine-btn"
            data-billing-tone={headerEnginePill.tone}
            aria-label="翻译设置"
            title={headerEnginePill.tooltip}
            onClick={onOpenEngineSettings}
          >
            <span className="app-header__engine-dot" aria-hidden="true" />
            <span className="app-header__engine-text">{headerEnginePill.compactText}</span>
          </button>
          {headerEnginePill.detailBadge || headerEnginePill.tooltip ? (
            <div className="app-header__engine-popover" data-testid="header-engine-popover" role="tooltip">
              {headerEnginePill.detailBadge ? (
                <strong className="app-header__engine-popover-badge">{headerEnginePill.detailBadge}</strong>
              ) : null}
              <span>{headerEnginePill.tooltip}</span>
            </div>
          ) : null}
        </div>
        <div ref={themeMenuRef} className="theme-menu-anchor">
          <button
            type="button"
            className={themeMenuOpen ? 'app-header__theme-btn is-active' : 'app-header__theme-btn'}
            data-testid="theme-menu-trigger"
            aria-label="切换阅读主题"
            aria-haspopup="true"
            aria-expanded={themeMenuOpen}
            title={`当前主题：${THEME_OPTIONS.find(o => o.id === theme)?.label ?? '明亮'}（点击切换明亮 / 护眼 / 深色）`}
            onClick={onToggleThemeMenu}
          >
            <ReadingThemeIcon theme={theme} />
            <span className="app-header__theme-caret" aria-hidden="true">▾</span>
          </button>
          {themeMenuOpen ? (
            <div className="theme-menu-popover" role="group" aria-label="阅读主题" data-testid="theme-menu-popover">
              {THEME_OPTIONS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  className={theme === option.id ? 'is-selected' : undefined}
                  aria-pressed={theme === option.id}
                  onClick={() => onSelectTheme(option.id)}
                >
                  <ReadingThemeIcon theme={option.id} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className={aiChatOpen ? 'app-header__sidebar-toggle is-collapsed' : 'app-header__sidebar-toggle'}
          data-testid="ai-chat-toggle"
          aria-label="打开或收起 AI 对话助手"
          title="AI 论文对话浮窗/抽屉 (快捷键 I)"
          aria-expanded={aiChatOpen}
          onClick={onToggleAiChat}
        >
          AI 对话
        </button>
        <button
          type="button"
          className="app-header__sidebar-toggle"
          aria-label="快捷键帮助"
          title="快捷键一览 (?)"
          aria-expanded={shortcutsOpen}
          onClick={onToggleShortcuts}
        >
          ?
        </button>
      </div>
    </header>
  )
}
