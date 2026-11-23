import { useEffect, useRef, useState, type DragEvent } from 'react'
import { TranslationPanel } from './features/translation/TranslationPanel'
import { LibraryPanel } from './features/library/LibraryPanel'
import { useLibrary } from './features/library/useLibrary'
import { PdfViewer } from './features/reader/PdfViewer'

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types ?? [])
  return types.includes('Files') || dataTransfer.files.length > 0
}

export default function App(): React.JSX.Element {
  const library = useLibrary()
  const [dropActive, setDropActive] = useState(false)
  const dragDepthRef = useRef(0)

  const importPdf = (): void => { void library.importPdf() }
  const retryLibrary = (): void => { void library.refresh() }

  useEffect(() => {
    const resetDrop = (): void => {
      dragDepthRef.current = 0
      setDropActive(false)
    }
    window.addEventListener('blur', resetDrop)
    window.addEventListener('dragend', resetDrop)
    return () => {
      window.removeEventListener('blur', resetDrop)
      window.removeEventListener('dragend', resetDrop)
    }
  }, [])

  const onShellDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (hasDraggedFiles(event.dataTransfer)) event.preventDefault()
  }

  const onShellDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (hasDraggedFiles(event.dataTransfer)) event.preventDefault()
  }

  const onWorkspaceDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDropActive(true)
  }

  const onWorkspaceDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const onWorkspaceDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDropActive(false)
  }

  const onWorkspaceDrop = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDropActive(false)
    const files = event.dataTransfer.files
    if (files.length > 0 && !library.importing) {
      void library.importDroppedFiles(files)
    }
  }

  return (
    <div className="app-shell" onDragOver={onShellDragOver} onDrop={onShellDrop}>
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">P</div>
        <strong>PaperFlow</strong>
        <span className="local-badge">本地 PDF 阅读器</span>
      </header>
      <main
        className={dropActive ? 'workspace workspace--drop-active' : 'workspace'}
        onDragEnter={onWorkspaceDragEnter}
        onDragOver={onWorkspaceDragOver}
        onDragLeave={onWorkspaceDragLeave}
        onDrop={onWorkspaceDrop}
      >
        <LibraryPanel
          documents={library.documents}
          selectedId={library.selected?.id}
          loading={library.loading}
          loadError={library.loadError}
          importing={library.importing}
          error={library.error}
          errorDetails={library.errorDetails}
          notice={library.notice}
          onImport={importPdf}
          onRetry={retryLibrary}
          onSelect={library.select}
          onRename={library.renameDocument}
          onDelete={library.deleteDocument}
          onDismissError={library.dismissErrors}
          onReportError={library.reportError}
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
              <p className="reader-placeholder__detail">支持拖拽 PDF 到此窗口；重新打开文献时会恢复上次的页码和缩放。</p>
            </div>
          )}
        </section>
        <TranslationPanel />
        {dropActive && (
          <div className="workspace-dropzone" role="status" aria-live="polite">
            <div className="workspace-dropzone__card">
              <strong>释放以导入 PDF 文献</strong>
              <span>仅在本地校验并存入您的文献库，不上传任何文件</span>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
