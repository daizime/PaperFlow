import { TranslationPanel } from './features/translation/TranslationPanel'
import { LibraryPanel } from './features/library/LibraryPanel'
import { useLibrary } from './features/library/useLibrary'
import { PdfViewer } from './features/reader/PdfViewer'
export default function App(): React.JSX.Element {
  const library = useLibrary()
  return <div className="app-shell">
    <header className="app-header"><div className="brand-mark">P</div><strong>PaperFlow</strong><span className="header-caption">让阅读回归专注</span><span className="local-badge">本地文献库</span></header>
    <main className="workspace">
      <LibraryPanel documents={library.documents} selectedId={library.selected?.id} importing={library.importing} error={library.error} onImport={() => void library.importPdf()} onSelect={library.select} />
      <section className="reader-panel">{library.selected ? <PdfViewer key={library.selected.id} document={library.selected} onImport={() => void library.importPdf()} onPageCount={library.refresh} /> : <div className="reader-placeholder"><div className="document-symbol">▤</div><h1>从一篇论文开始</h1><p>选择左侧文献，专注阅读每一个细节。</p><span className="muted">PDF 阅读器 · 本地存储 · 阅读进度</span></div>}</section>
      <TranslationPanel />
    </main>
  </div>
}
