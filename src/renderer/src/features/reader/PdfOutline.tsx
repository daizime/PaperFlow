import type { PdfOutlineItem } from './pdf-outline'

export interface PdfOutlineProps {
  items: readonly PdfOutlineItem[]
  loading: boolean
  currentPage: number
  onNavigate: (pageNumber: number) => void
  onClose: () => void
}

interface OutlineListProps {
  items: readonly PdfOutlineItem[]
  currentPage: number
  nested: boolean
  onNavigate: (pageNumber: number) => void
}

function OutlineList({ items, currentPage, nested, onNavigate }: OutlineListProps): React.JSX.Element {
  return (
    <ul className={nested ? 'reader-outline__list reader-outline__list--nested' : 'reader-outline__list'}>
      {items.map(item => {
        const isActive = item.pageNumber !== null && item.pageNumber === currentPage
        return (
          <li key={item.id} className="reader-outline__node">
            {item.pageNumber !== null ? (
              <button
                type="button"
                className={isActive ? 'reader-outline__item is-active' : 'reader-outline__item'}
                aria-current={isActive ? 'location' : undefined}
                title={item.title}
                onClick={() => onNavigate(item.pageNumber!)}
              >
                <span className="reader-outline__title">{item.title}</span>
                <span className="reader-outline__page">{item.pageNumber}</span>
              </button>
            ) : (
              <div className="reader-outline__group" title={item.title}>{item.title}</div>
            )}
            {item.items.length > 0 && (
              <OutlineList items={item.items} currentPage={currentPage} nested={true} onNavigate={onNavigate} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function PdfOutline({ items, loading, currentPage, onNavigate, onClose }: PdfOutlineProps): React.JSX.Element {
  return (
    <aside className="reader-outline" aria-label="文档目录">
      <div className="reader-outline__header">
        <strong>目录</strong>
        <button type="button" className="reader-outline__close" aria-label="关闭目录" title="关闭目录" onClick={onClose}>×</button>
      </div>
      <div className="reader-outline__content">
        {loading ? (
          <p className="reader-outline__status" role="status">正在读取目录…</p>
        ) : items.length === 0 ? (
          <p className="reader-outline__empty" role="status">此 PDF 未包含目录书签</p>
        ) : (
          <OutlineList items={items} currentPage={currentPage} nested={false} onNavigate={onNavigate} />
        )}
      </div>
    </aside>
  )
}
