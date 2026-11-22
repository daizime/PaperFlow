import { TranslationPanel } from './features/translation/TranslationPanel'
import { LibraryPanel } from './features/library/LibraryPanel'
import { useLibrary } from './features/library/useLibrary'
import { PdfViewer } from './features/reader/PdfViewer'

export default function App(): React.JSX.Element {
  const library = useLibrary()
  const importPdf = (): void => { void library.importPdf() }
  const retryLibrary = (): void => { void library.refresh() }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">P</div>
        <strong>PaperFlow</strong>
        <span className="local-badge">本地 PDF 阅读器</span>
      </header>
      <main className="workspace">
        <LibraryPanel
          documents={library.documents}
          selectedId={library.selected?.id}
          loading={library.loading}
          loadError={library.loadError}
          importing={library.importing}
          error={library.error}
          notice={library.notice}
          onImport={importPdf}
          onRetry={retryLibrary}
          onSelect={library.select}
        />
        <section className="reader-panel" aria-label="PDF 阅读器">
          {library.selected ? (
            <PdfViewer key={library.selected.id} document={library.selected}
              importing={library.importing} onImport={importPdf} onPageCount={library.refresh} />
          ) : library.loading ? (
            <div className="reader-placeholder" aria-busy="true"><h1>正在打开文献库</h1></div>
          ) : library.loadError ? (
            <div className="reader-placeholder">
              <h1>无法打开文献库</h1>
              <button type="button" className="reader-placeholder__import" onClick={retryLibrary}>重新读取文献库</button>
            </div>
          ) : (
            <div className="reader-placeholder">
              <h1>打开一篇 PDF</h1>
              <p>在本地阅读、翻页和缩放。拖选原文后按 <kbd>Ctrl</kbd> + <kbd>C</kbd> 复制。</p>
              <button type="button" className="reader-placeholder__import" aria-label="选择 PDF 文件"
                disabled={library.importing} onClick={importPdf}>
                {library.importing ? '正在导入…' : '选择 PDF 文件'}
              </button>
              <p className="reader-placeholder__detail">重新打开文献时会恢复上次的页码和缩放。</p>
            </div>
          )}
        </section>
        <TranslationPanel />
      </main>
    </div>
  )
}
