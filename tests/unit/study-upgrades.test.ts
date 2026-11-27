import { describe, expect, test } from 'vitest'
import type { DocumentRecord, LiteratureSearchItem } from '../../src/shared/contracts'
import { detectDirectPaperIdentifier } from '../../src/main/services/literature-search-service'
import { readOpenAiStreamOrJson } from '../../src/main/services/openai-stream'
import { findMatchingLocalDocument } from '../../src/renderer/src/features/library/literature-match'
import { parseMarkdownBlocks } from '../../src/renderer/src/features/study/markdown-parser'
import {
  assembleSkillExcerpt,
  parsePageRangeInput,
  selectBalancedSkillPages
} from '../../src/renderer/src/features/study/skill-context'

describe('OpenAI SSE stream parser', () => {
  test('accumulates multi-chunk text/event-stream deltas and ignores [DONE]', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"choices":[{"delta":{"content":"## FOCUS"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" 深度总结\\n"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"- 命中关键消融表"}}]}\n\ndata: [DONE]\n\n'
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    })
    const res = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
    })
    const deltas: string[] = []
    const full = await readOpenAiStreamOrJson(res, (delta, soFar) => {
      deltas.push(`${delta}|${soFar}`)
    })
    expect(full).toBe('## FOCUS 深度总结\n- 命中关键消融表')
    expect(deltas).toHaveLength(3)
  })

  test('falls back cleanly on standard application/json responses', async () => {
    const res = new Response(
      JSON.stringify({ choices: [{ message: { content: '普通非流式 JSON 回复' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
    let streamed = ''
    const out = await readOpenAiStreamOrJson(res, (_d, full) => {
      streamed = full
    })
    expect(out).toBe('普通非流式 JSON 回复')
    expect(streamed).toBe('普通非流式 JSON 回复')
  })
})

describe('Markdown structural parser', () => {
  test('parses headings, tables, lists, and fenced code blocks without raw HTML', () => {
    const blocks = parseMarkdownBlocks([
      '## 1. 核心结果对比',
      '',
      '| 模型 | 准确率 | 延迟 |',
      '| --- | --- | --- |',
      '| Baseline | 81.2% | 42ms |',
      '| PaperFlow | **94.5%** | 18ms |',
      '',
      '- 第一点 `code`',
      '- 第二点 *italic*',
      '',
      '```python',
      'print("hello")',
      '```'
    ].join('\n'))

    expect(blocks.map(b => b.type)).toEqual(['heading', 'table', 'ul', 'code'])
    expect(blocks[0]).toEqual({ type: 'heading', level: 2, text: '1. 核心结果对比' })
    expect(blocks[1]).toEqual({
      type: 'table',
      headers: ['模型', '准确率', '延迟'],
      rows: [
        ['Baseline', '81.2%', '42ms'],
        ['PaperFlow', '**94.5%**', '18ms']
      ]
    })
    expect(blocks[3]).toEqual({ type: 'code', lang: 'python', code: 'print("hello")' })
  })
})

describe('Balanced long-paper skill sampling', () => {
  test('covers beginning, middle (pages 6-10), current page, and end on a 16-page paper', () => {
    const pages = selectBalancedSkillPages({ pageCount: 16, currentPage: 2, mode: 'full-balanced' })
    expect(pages[0]).toBe(1)
    expect(pages[pages.length - 1]).toBe(16)
    expect(pages.some(p => p >= 6 && p <= 11)).toBe(true)
    expect(pages.length).toBeLessThanOrEqual(10)
  })

  test('parses custom page ranges cleanly and prioritizes key section pages in excerpts', () => {
    expect(parsePageRangeInput('1-3, 6-8, 25, 2', 12)).toEqual([1, 2, 3, 6, 7, 8, 12])
    const { excerpt, sampledPages } = assembleSkillExcerpt({
      pageTexts: [
        { pageNumber: 1, text: 'Abstract We propose deterministic alignment.' },
        { pageNumber: 7, text: '4. Experiments and Ablation Study Table 2 shows 95.1% accuracy.' }
      ],
      maxChars: 2000
    })
    expect(sampledPages).toEqual([1, 7])
    expect(excerpt).toContain('[P.1]')
    expect(excerpt).toContain('[P.7]')
  })
})

describe('Direct DOI / arXiv detection & local library dedup', () => {
  test('detects DOI links, bare DOIs, arXiv URLs, and bare arXiv IDs without misclassifying normal queries', () => {
    expect(detectDirectPaperIdentifier('https://doi.org/10.1145/3589334.3645123')).toEqual({
      kind: 'doi',
      value: '10.1145/3589334.3645123'
    })
    expect(detectDirectPaperIdentifier('10.1038/s41586-024-00001-1')).toEqual({
      kind: 'doi',
      value: '10.1038/s41586-024-00001-1'
    })
    expect(detectDirectPaperIdentifier('https://arxiv.org/pdf/2501.00099v2.pdf')).toEqual({
      kind: 'arxiv',
      value: '2501.00099v2'
    })
    expect(detectDirectPaperIdentifier('2403.12345')).toEqual({ kind: 'arxiv', value: '2403.12345' })
    expect(detectDirectPaperIdentifier('transformer long context attention')).toBeNull()
  })

  test('matches remote search item against local library by normalized title or arXiv ID', () => {
    const docs: DocumentRecord[] = [
      {
        id: 'd1',
        originalFilename: '2501.00099v1.pdf',
        displayTitle: 'Deterministic Two-Column Scholarly Layout Analysis',
        byteSize: 1024,
        pageCount: 2,
        importedAt: '2026-11-26T00:00:00.000Z',
        starred: false,
        tags: [],
        folderId: null,
        readingStatus: 'unread'
      }
    ]
    const hitByTitle: LiteratureSearchItem = {
      id: 'oa-1',
      source: 'openalex',
      title: 'Deterministic Two Column Scholarly Layout Analysis!',
      authors: ['Alice'],
      year: 2025,
      venue: 'VLDB',
      abstract: 'Demo',
      citationCount: 10,
      doi: null,
      landingUrl: null,
      pdfUrl: null,
      isOpenAccess: false,
      topics: []
    }
    const miss: LiteratureSearchItem = {
      ...hitByTitle,
      id: 'oa-2',
      title: 'Completely Unrelated Bio Paper'
    }
    expect(findMatchingLocalDocument(hitByTitle, docs)?.id).toBe('d1')
    expect(findMatchingLocalDocument(miss, docs)).toBeNull()
  })
})
