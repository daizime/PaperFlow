import type { DocumentRecord } from '../../../../shared/contracts'
interface Props { documents: DocumentRecord[]; selectedId?: string; importing: boolean; error: string | null; onImport(): void; onSelect(id: string): void }
export function LibraryPanel({ documents, selectedId, importing, error, onImport, onSelect }: Props): React.JSX.Element {
  return <aside className="library-panel" aria-label="文献库">
    <div className="library-heading"><h2>我的文献</h2><span>{documents.length}</span></div>
    <p className="muted">将论文收进你的阅读空间</p>
    <button onClick={onImport} disabled={importing} aria-label="导入 PDF">{importing ? '正在校验并导入…' : '＋ 导入 PDF'}</button>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {documents.length === 0 ? <div className="empty-library">文献库为空<br/><small>导入一篇 PDF 开始阅读</small></div> :
      <ul className="document-list">{documents.map(document => <li key={document.id}>
        <button className={selectedId === document.id ? 'document-item selected' : 'document-item'} onClick={() => onSelect(document.id)} data-document-id={document.id}>
          <span className="pdf-badge">PDF</span><span className="document-description"><strong title={document.originalFilename}>{document.originalFilename}</strong>
          <small>{document.pageCount === null ? '页数待读取' : document.pageCount + ' 页'} · {(document.byteSize / 1024).toFixed(1)} KB</small>
          <time dateTime={document.importedAt}>{new Date(document.importedAt).toLocaleDateString('zh-CN')}</time></span>
        </button></li>)}</ul>}
  </aside>
}
