import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryDatabase } from '../../src/main/services/database'
import {
  buildTranslationExportHtml,
  formatTranslationExportMarkdown
} from '../../src/main/services/translation-export'
import { TranslationService } from '../../src/main/services/translation-service'
import {
  findReferencesHeadingBlockIndex,
  parseBatchPageRange
} from '../../src/renderer/src/features/translation/batch-translation'
import {
  DARK_PAPER_DEFAULT_BG,
  mapColorToDarkPaperFilter
} from '../../src/renderer/src/features/translation/dark-paper-color'
import {
  buildDocumentSummaryFromLayout,
  buildPageTranslationContext
} from '../../src/renderer/src/features/translation/translation-context'
import type { PageLayoutResult } from '../../src/renderer/src/features/reader/layout-analysis'

const tempDirs: string[] = []

function makeDb(): LibraryDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'paperflow-tr-v2-'))
  tempDirs.push(dir)
  return new LibraryDatabase(join(dir, 'paperflow.sqlite'))
}

function insertSampleDoc(db: LibraryDatabase): string {
  const docId = randomUUID()
  db.insertDocument({
    id: docId,
    sha256: 'a'.repeat(64),
    originalFilename: 'sample-study.pdf',
    displayTitle: 'Sample Study on Electrocatalysis',
    storedFilename: `${docId}.pdf`,
    byteSize: 2048,
    pageCount: 5,
    importedAt: new Date().toISOString()
  })
  return docId
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('轨道一：批量翻译范围解析、参考文献识别、单段手动修改与导出格式化', () => {
  it('parseBatchPageRange 支持空字符串回退、区间、散页、乱序去重与越界裁剪', () => {
    expect(parseBatchPageRange('', 6, 3)).toEqual([3, 4, 5, 6])
    expect(parseBatchPageRange('1-3, 5', 8, 1)).toEqual([1, 2, 3, 5])
    expect(parseBatchPageRange('5-3, 2, 2, 99, 0', 6, 1)).toEqual([2, 3, 4, 5])
    expect(parseBatchPageRange('abc', 5, 1)).toEqual([])
    expect(parseBatchPageRange('', 0, 1)).toEqual([])
  })

  it('findReferencesHeadingBlockIndex 仅识别独立参考文献章节标题，不误伤正文', () => {
    expect(
      findReferencesHeadingBlockIndex([
        { kind: 'paragraph', text: 'As noted in several prior references, voltage efficiency rises.' },
        { kind: 'heading', text: '4. Conclusion' }
      ])
    ).toBe(-1)

    expect(
      findReferencesHeadingBlockIndex([
        { kind: 'paragraph', text: 'Final remarks and future directions.' },
        { kind: 'heading', text: 'References' },
        { kind: 'paragraph', text: '[1] A. Smith, 2024.' }
      ])
    ).toBe(1)

    expect(
      findReferencesHeadingBlockIndex([
        { kind: 'paragraph', text: '7. 参考文献' }
      ])
    ).toBe(0)

    expect(
      findReferencesHeadingBlockIndex([
        { kind: 'heading', text: 'VIII. Bibliography:' }
      ])
    ).toBe(0)
  })

  it('updateBlockTranslation 写入 SQLite 且不被常规缓存查询覆盖，支持 listDocumentTranslations 分页导出', async () => {
    const db = makeDb()
    try {
      const docId = insertSampleDoc(db)
      let apiCalls = 0
      const service = new TranslationService({
        database: db,
        fetchImpl: (async () => {
          apiCalls += 1
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"translations":[{"id":"b1","text":"自动机器译文"}]}' } }]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }) as unknown as typeof fetch
      })

      service.saveSettings({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        openai: { baseUrl: 'https://api.example.com/v1', model: 'mock-m1' },
        cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 60 }
      })

      const block = {
        blockId: 'b1',
        kind: 'paragraph' as const,
        sourceText: 'The catalyst achieved 210 mV overpotential.',
        sourceHash: '0123456789abcdef'
      }

      const first = await service.translatePage({ documentId: docId, pageNumber: 1, blocks: [block] })
      expect(first.translatedCount).toBe(1)
      expect(apiCalls).toBe(1)

      const edited = service.updateBlockTranslation({
        documentId: docId,
        pageNumber: 1,
        blockId: 'b1',
        sourceHash: block.sourceHash,
        translatedText: '该催化剂实现了 210 mV 的过电位（人工精修）。'
      })
      expect(edited.translatedText).toBe('该催化剂实现了 210 mV 的过电位（人工精修）。')
      expect(edited.providerSignature).toBe('manual-edit')

      // 常规连续译 (force=false) 命中缓存，保留用户手工校对
      const cachedHit = await service.translatePage({ documentId: docId, pageNumber: 1, blocks: [block], force: false })
      expect(cachedHit.fromCacheCount).toBe(1)
      expect(cachedHit.translatedCount).toBe(0)
      expect(cachedHit.items[0].translatedText).toBe('该催化剂实现了 210 mV 的过电位（人工精修）。')
      expect(apiCalls).toBe(1)

      // 主动重译 (force=true) 时会重新请求并更新
      const forced = await service.translatePage({ documentId: docId, pageNumber: 1, blocks: [block], force: true })
      expect(forced.translatedCount).toBe(1)
      expect(forced.items[0].translatedText).toBe('自动机器译文')
      expect(apiCalls).toBe(2)

      // 写入第 2 页以验证 listDocumentTranslations 分页有序返回
      service.updateBlockTranslation({
        documentId: docId,
        pageNumber: 2,
        blockId: 'p2-b1',
        sourceHash: 'fedcba9876543210',
        translatedText: '第二页手动修订译文。'
      })
      const docPages = service.listDocumentTranslations(docId)
      expect(docPages.map(p => p.pageNumber)).toEqual([1, 2])
      expect(docPages[1].items[0].translatedText).toBe('第二页手动修订译文。')
    } finally {
      db.close()
    }
  })

  it('formatTranslationExportMarkdown 与 buildTranslationExportHtml 正确排版并转义危险标签', () => {
    const pages = [
      {
        pageNumber: 1,
        blocks: [
          {
            kind: 'heading' as const,
            sourceText: '1. Introduction <script>alert(1)</script>',
            translatedText: '1. 引言 <img src=x onerror=alert(1)>'
          },
          {
            kind: 'paragraph' as const,
            sourceText: 'Raw paragraph.',
            translatedText: '对应中文段落。'
          }
        ]
      }
    ]

    const bilingualMd = formatTranslationExportMarkdown('Test Paper', 'bilingual-md', pages)
    expect(bilingualMd).toContain('# Test Paper（中英对照译文）')
    expect(bilingualMd).toContain('> 1. Introduction <script>alert(1)</script>')
    expect(bilingualMd).toContain('**1. 引言 <img src=x onerror=alert(1)>**')

    const zhMd = formatTranslationExportMarkdown('Test Paper', 'zh-md', pages)
    expect(zhMd).toContain('### 1. 引言 <img src=x onerror=alert(1)>')
    expect(zhMd).not.toContain('Raw paragraph.')

    const html = buildTranslationExportHtml('Title <xss>', 'bilingual', pages)
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('Title &lt;xss&gt;')
    expect(html).toContain("default-src 'none'")
  })

  it('mapColorToDarkPaperFilter 按 invert(0.88) hue-rotate(180deg) contrast(0.95) 映射浅色背景到深色纸面', () => {
    expect(mapColorToDarkPaperFilter('#ffffff')).toBe('rgb(35, 35, 35)')
    expect(mapColorToDarkPaperFilter('rgb(255, 255, 255)')).toBe('rgb(35, 35, 35)')
    expect(mapColorToDarkPaperFilter('rgb(240, 240, 240)')).toBe('rgb(46, 46, 46)')

    const blueTint = mapColorToDarkPaperFilter('rgb(238, 244, 255)').match(/\d+/g)!.map(Number)
    expect(blueTint).toHaveLength(3)
    expect(Math.max(...blueTint)).toBeLessThan(70)
    expect(blueTint[2]).toBeGreaterThanOrEqual(blueTint[1])
    expect(blueTint[1]).toBeGreaterThanOrEqual(blueTint[0])

    expect(mapColorToDarkPaperFilter('invalid-color')).toBe(DARK_PAPER_DEFAULT_BG)
  })

  it('buildDocumentSummaryFromLayout 与 buildPageTranslationContext 按阅读序提取标题摘要、章节与前序句段对照 (合成素材)', async () => {
    const { computeStableTranslationBlockKey } = await import(
      '../../src/renderer/src/features/reader/layout-analysis'
    )

    const mkLayoutBlock = (
      id: string,
      pageNumber: number,
      kind: 'heading' | 'paragraph' | 'caption',
      text: string,
      y: number
    ) => {
      const rect = { x: 54, y, width: 220, height: 14 }
      return {
        id,
        pageNumber,
        order: 1,
        kind,
        columnIndex: 1,
        fontSize: 10,
        isBold: kind !== 'paragraph',
        bounds: rect,
        displayBounds: rect,
        sentences: [
          {
            id: `${id}-s1`,
            pageNumber,
            order: 1,
            blockId: id,
            blockKind: kind,
            columnIndex: 1,
            text,
            rects: [rect],
            displayRects: [rect],
            bounds: rect,
            displayBounds: rect,
            fragments: [],
            crossColumn: false
          }
        ]
      }
    }

    const p1Title = mkLayoutBlock('p1-b1', 1, 'heading', 'Federated Graph Compression', 60)
    const p1AbsHead = mkLayoutBlock('p1-b2', 1, 'heading', 'Abstract', 90)
    const p1AbsBody = mkLayoutBlock(
      'p1-b3',
      1,
      'paragraph',
      'We propose a lossless sparse compression layer that lowers inter-worker traffic across distributed clusters.',
      110
    )
    const p1FigCap = mkLayoutBlock('p1-b4', 1, 'caption', 'Figure 1: System pipeline.', 200)

    const p2Head = mkLayoutBlock('p2-b1', 2, 'heading', '2.1 Sparse Encoding', 60)
    const p2Para1 = mkLayoutBlock('p2-b2', 2, 'paragraph', 'First paragraph builds block masks.', 90)
    const p2Para2 = mkLayoutBlock('p2-b3', 2, 'paragraph', 'It then schedules asynchronous flushes.', 120)

    const mkLayout = (pageNumber: number, blocks: ReturnType<typeof mkLayoutBlock>[]): PageLayoutResult => ({
      pageNumber,
      naturalWidth: 612,
      naturalHeight: 792,
      columnCount: 2,
      bodyFontSize: 10,
      hasText: true,
      blocks,
      sentences: blocks.flatMap(b => b.sentences),
      filteredItems: []
    })

    const layouts = new Map<number, PageLayoutResult>([
      [1, mkLayout(1, [p1Title, p1AbsHead, p1AbsBody, p1FigCap])],
      [2, mkLayout(2, [p2Head, p2Para1, p2Para2])]
    ])

    const p1AbsBodyKey = computeStableTranslationBlockKey(p1AbsBody)
    const p2Para1Key = computeStableTranslationBlockKey(p2Para1)
    const p2Para2Key = computeStableTranslationBlockKey(p2Para2)

    const translationsByPage = new Map([
      [
        1,
        new Map([
          [
            p1AbsBodyKey,
            {
              blockId: p1AbsBodyKey,
              sourceHash: '0123456789abcdef',
              translatedText: '我们提出了一种降低跨节点流量的无损稀疏压缩层。',
              providerSignature: 'sig',
              updatedAt: '2026-11-28T00:00:00Z'
            }
          ]
        ])
      ],
      [
        2,
        new Map([
          [
            p2Para1Key,
            {
              blockId: p2Para1Key,
              sourceHash: '0123456789abcdef',
              translatedText: '第一段构造了块级掩码。',
              providerSignature: 'sig',
              updatedAt: '2026-11-28T00:00:00Z'
            }
          ]
        ])
      ]
    ])

    const summary = buildDocumentSummaryFromLayout(layouts.get(1))
    expect(summary).toContain('标题：Federated Graph Compression')
    expect(summary).toContain('摘要：We propose a lossless sparse compression layer')

    const fullPage2Ctx = buildPageTranslationContext(layouts, 2, translationsByPage)
    expect(fullPage2Ctx?.documentSummary).toBe(summary)
    expect(fullPage2Ctx?.sectionHeading).toBe('Federated Graph Compression > Abstract')
    expect(fullPage2Ctx?.precedingBlocks).toEqual([
      {
        kind: 'paragraph',
        sourceText: 'We propose a lossless sparse compression layer that lowers inter-worker traffic across distributed clusters.',
        translatedText: '我们提出了一种降低跨节点流量的无损稀疏压缩层。'
      }
    ])

    const singleBlockCtx = buildPageTranslationContext(layouts, 2, translationsByPage, p2Para2Key)
    expect(singleBlockCtx?.sectionHeading).toBe('2.1 Sparse Encoding')
    expect(singleBlockCtx?.precedingBlocks).toEqual([
      { kind: 'heading', sourceText: '2.1 Sparse Encoding' },
      {
        kind: 'paragraph',
        sourceText: 'First paragraph builds block masks.',
        translatedText: '第一段构造了块级掩码。'
      }
    ])
  })
})
