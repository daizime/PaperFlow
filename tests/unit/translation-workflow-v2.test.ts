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
        openai: { baseUrl: 'https://api.example.com/v1', model: 'mock-m1', apiKey: 'sk-test-1' },
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
})
