import type { ReactNode } from 'react'
import { parseMarkdownBlocks, type MarkdownBlock } from './markdown-parser'
import { splitTextWithPageReferences } from './page-references'

export { parseMarkdownBlocks, type MarkdownBlock }

function renderPlainWithPageLinks(
  text: string,
  onJumpToPage?: (pageNumber: number) => void,
  keyPrefix = 'seg'
): ReactNode {
  if (!onJumpToPage || !text) return text
  const parts = splitTextWithPageReferences(text)
  if (parts.length === 0 || (parts.length === 1 && parts[0].kind === 'text')) {
    return text
  }
  return parts.map((part, idx) => {
    if (part.kind === 'text') return part.value
    return (
      <button
        key={`${keyPrefix}-p-${idx}`}
        type="button"
        className="ai-md-page-link"
        data-testid={`ai-page-jump-${part.pageNumber}`}
        data-page-jump={part.pageNumber}
        title={`点击跳转到第 ${part.pageNumber} 页`}
        onClick={() => onJumpToPage(part.pageNumber)}
      >
        {part.label}
      </button>
    )
  })
}

function renderInlineMarkdown(text: string, onJumpToPage?: (pageNumber: number) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  const tokenRe = /(`[^`]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(renderPlainWithPageLinks(text.slice(lastIndex, match.index), onJumpToPage, `t-${key++}`))
    }
    const token = match[0]
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={`tok-${key++}`} className="ai-md-inline-code">
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={`tok-${key++}`}>{renderPlainWithPageLinks(token.slice(2, -2), onJumpToPage, `b-${key}`)}</strong>)
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={`tok-${key++}`}>{renderPlainWithPageLinks(token.slice(1, -1), onJumpToPage, `i-${key}`)}</em>)
    }
    lastIndex = tokenRe.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(renderPlainWithPageLinks(text.slice(lastIndex), onJumpToPage, `t-${key++}`))
  }
  return nodes
}

export function MarkdownMessage({
  content,
  onJumpToPage
}: {
  content: string
  onJumpToPage?: (pageNumber: number) => void
}): React.JSX.Element {
  const blocks = parseMarkdownBlocks(content)
  return (
    <div className="ai-md">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          if (block.level === 1) return <h2 key={index} className="ai-md-h ai-md-h1">{renderInlineMarkdown(block.text, onJumpToPage)}</h2>
          if (block.level === 2) return <h3 key={index} className="ai-md-h ai-md-h2">{renderInlineMarkdown(block.text, onJumpToPage)}</h3>
          return <h4 key={index} className="ai-md-h ai-md-h3">{renderInlineMarkdown(block.text, onJumpToPage)}</h4>
        }
        if (block.type === 'code') {
          return (
            <pre key={index} className="ai-md-pre">
              {block.lang ? <span className="ai-md-pre__lang">{block.lang}</span> : null}
              <code>{block.code}</code>
            </pre>
          )
        }
        if (block.type === 'table') {
          return (
            <div key={index} className="ai-md-table-wrap">
              <table className="ai-md-table">
                <thead>
                  <tr>
                    {block.headers.map((head, hIdx) => (
                      <th key={hIdx}>{renderInlineMarkdown(head, onJumpToPage)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) => (
                        <td key={cIdx}>{renderInlineMarkdown(cell, onJumpToPage)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        if (block.type === 'blockquote') {
          return (
            <blockquote key={index} className="ai-md-quote">
              {block.lines.map((line, lIdx) => (
                <div key={lIdx}>{renderInlineMarkdown(line, onJumpToPage)}</div>
              ))}
            </blockquote>
          )
        }
        if (block.type === 'ul') {
          return (
            <ul key={index} className="ai-md-list">
              {block.items.map((item, iIdx) => (
                <li key={iIdx}>{renderInlineMarkdown(item, onJumpToPage)}</li>
              ))}
            </ul>
          )
        }
        if (block.type === 'ol') {
          return (
            <ol key={index} className="ai-md-list">
              {block.items.map((item, iIdx) => (
                <li key={iIdx}>{renderInlineMarkdown(item, onJumpToPage)}</li>
              ))}
            </ol>
          )
        }
        if (block.type === 'hr') {
          return <hr key={index} className="ai-md-hr" />
        }
        return (
          <p key={index} className="ai-md-p">
            {renderInlineMarkdown(block.text, onJumpToPage)}
          </p>
        )
      })}
    </div>
  )
}
