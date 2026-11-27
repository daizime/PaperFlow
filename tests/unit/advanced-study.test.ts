import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { BackupService } from '../../src/main/services/backup-service'
import { LibraryDatabase } from '../../src/main/services/database'
import { DocumentService } from '../../src/main/services/document-service'
import { createZipBuffer, readZipBuffer, validateZipEntryName } from '../../src/main/services/zip-archive'
import { extractAutoOutlineFromPages, scoreOutlineHeadingMatch } from '../../src/renderer/src/features/reader/pdf-outline'
import { computeTightFigureCropBox } from '../../src/renderer/src/features/study/figure-crop'
import { findReferenceMatchInPages } from '../../src/renderer/src/features/study/reference-peek'
import {
  extractCitationMetadata,
  extractCitationMetadataFromText,
  formatBibtex,
  formatGbt7714,
  formatIeee,
  formatRis
} from '../../src/shared/citation'

async function validatePdf(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false })
  return document.getPageCount()
}

function makeWhiteRgba(width: number, height: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4)
  buf.fill(255)
  return buf
}

function fillRectRgba(
  buf: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number
): void {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const idx = (y * width + x) * 4
      buf[idx] = 20
      buf[idx + 1] = 20
      buf[idx + 2] = 20
      buf[idx + 3] = 255
    }
  }
}

describe('ZIP 归档与一键备份恢复', () => {
  let root: string
  let dbA: LibraryDatabase
  let docSvcA: DocumentService
  let backupA: BackupService
  let dbB: LibraryDatabase
  let docSvcB: DocumentService
  let backupB: BackupService

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'paperflow-backup-unit-'))
    dbA = new LibraryDatabase(join(root, 'a.sqlite'))
    docSvcA = new DocumentService(dbA, join(root, 'lib-a'), validatePdf)
    backupA = new BackupService(dbA, docSvcA)

    dbB = new LibraryDatabase(join(root, 'b.sqlite'))
    docSvcB = new DocumentService(dbB, join(root, 'lib-b'), validatePdf)
    backupB = new BackupService(dbB, docSvcB)
  })

  afterEach(async () => {
    dbA.close()
    dbB.close()
    await rm(root, { recursive: true, force: true })
  })

  it('ZIP 支持 UTF-8 中文路径读写并拒绝 Zip-Slip 越权路径', () => {
    const zip = createZipBuffer([
      { name: 'notes/论文笔记-测试.md', data: Buffer.from('# 测试内容\n内容正文', 'utf8'), compress: true },
      { name: 'pdfs/raw.bin', data: Buffer.from([1, 2, 3, 4]), compress: false }
    ])
    const entries = readZipBuffer(zip)
    expect(entries.get('notes/论文笔记-测试.md')?.toString('utf8')).toBe('# 测试内容\n内容正文')
    expect(Array.from(entries.get('pdfs/raw.bin') ?? [])).toEqual([1, 2, 3, 4])

    expect(() => validateZipEntryName('../evil.txt')).toThrow(/越权/)
    expect(() => validateZipEntryName('/etc/passwd')).toThrow(/不安全/)
    expect(() => validateZipEntryName('C:\\Windows\\system.ini')).toThrow(/不安全/)
    expect(() => validateZipEntryName('a/../b.pdf')).toThrow(/越权/)
  })

  it('一键导出多篇文献包含 Zotero/EndNote/Obsidian 兼容文件（唯一 citeKey 且不泄露加密密钥），跨空库无损恢复并幂等重导', async () => {
    const pdf1 = await readFile(resolve('tests/fixtures/valid.pdf'))
    const pdf2 = await readFile(resolve('tests/fixtures/verification/layout-analysis/two-column-academic-fixture.pdf'))
    const imp1 = await docSvcA.importBuffer('attention-paper.pdf', pdf1)
    const imp2 = await docSvcA.importBuffer('layout-paper.pdf', pdf2)
    const docId1 = imp1.document.id
    const docId2 = imp2.document.id

    dbA.renameDocument(docId1, 'Attention Survey 2025')
    dbA.renameDocument(docId2, 'Attention Survey 2025') // 故意重名测试文件名与 citeKey 去重
    dbA.updateDocumentMeta({ documentId: docId1, starred: true, tags: ['Transformer', '综述'] })
    dbA.updateDocumentMeta({ documentId: docId2, starred: false, tags: ['Layout'] })
    dbA.saveReaderState({ documentId: docId1, pageNumber: 1, scale: 1.4, updatedAt: new Date().toISOString() })
    dbA.saveReaderState({ documentId: docId2, pageNumber: 2, scale: 1.2, updatedAt: new Date().toISOString() })

    dbA.createAnnotation({
      documentId: docId1,
      pageNumber: 1,
      color: 'yellow',
      quoteText: 'Self-attention connects all positions.',
      note: '核心结论记录',
      rects: [{ x: 10, y: 20, width: 100, height: 14 }],
      sentenceIds: ['p1-s1']
    })
    dbA.upsertPageTranslations(docId1, 1, 'zh-CN', 'openai:https://api.deepseek.com/v1|deepseek-chat|zh-CN', [
      { blockId: 'p1-b1', sourceHash: 'abc123', translatedText: '自注意力机制连接所有位置。' }
    ])
    dbA.setSetting(
      'translation.config.v1',
      JSON.stringify({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        glossary: [{ source: 'Self-Attention', target: '自注意力' }],
        openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 120 }
      })
    )
    const secretSentinel = 'sk-super-secret-never-export-9988'
    dbA.setSetting('translation.openaiApiKey.v1', JSON.stringify({ encrypted: false, value: secretSentinel }))

    const exported = await backupA.exportBackupArchive()
    expect(exported.documentCount).toBe(2)
    expect(exported.annotationCount).toBe(1)
    expect(exported.translationCount).toBe(1)
    expect(exported.glossaryCount).toBe(1)
    expect(exported.zipBuffer.toString('utf8')).not.toContain(secretSentinel)

    const zipMap = readZipBuffer(exported.zipBuffer)
    expect(zipMap.has('pdfs/Attention Survey 2025.pdf')).toBe(true)
    expect(zipMap.has('pdfs/Attention Survey 2025-2.pdf')).toBe(true)
    const bib = zipMap.get('library.bib')?.toString('utf8') ?? ''
    const ris = zipMap.get('library.ris')?.toString('utf8') ?? ''
    expect(bib).toContain('keywords  = {Transformer, 综述}')
    expect(bib).toContain('file      = {pdfs/Attention Survey 2025.pdf}')
    expect(bib).toContain('_2,')
    expect((ris.match(/^TY  - /gm) ?? []).length).toBe(2)
    expect((ris.match(/^ER  - /gm) ?? []).length).toBe(2)
    expect(zipMap.get('notes/Attention Survey 2025.md')?.toString('utf8')).toContain('核心结论记录')

    const restored1 = await backupB.importBackupArchive(exported.zipBuffer)
    expect(restored1).toEqual({
      importedDocuments: 2,
      existingDocuments: 0,
      restoredAnnotations: 1,
      restoredTranslations: 1,
      restoredGlossary: 1
    })

    const docsB = dbB.listDocuments()
    expect(docsB).toHaveLength(2)
    const starredDoc = docsB.find(d => d.starred)!
    expect(starredDoc.displayTitle).toBe('Attention Survey 2025')
    expect(starredDoc.tags).toEqual(['Transformer', '综述'])
    expect(dbB.listAnnotations(starredDoc.id)).toHaveLength(1)
    expect(dbB.getPageTranslations(starredDoc.id, 1, 'zh-CN')[0]?.translatedText).toBe('自注意力机制连接所有位置。')
    expect(dbB.getReaderState(starredDoc.id)?.scale).toBeCloseTo(1.4, 2)
    expect(dbB.getSetting('translation.openaiApiKey.v1')).toBeNull()

    // 幂等重导不复制重复记录
    const restored2 = await backupB.importBackupArchive(exported.zipBuffer)
    expect(restored2.importedDocuments).toBe(0)
    expect(restored2.existingDocuments).toBe(2)
    expect(restored2.restoredAnnotations).toBe(0)
    expect(restored2.restoredGlossary).toBe(0)
    expect(dbB.listAnnotations(starredDoc.id)).toHaveLength(1)
  })
})

describe('多出版商引用提取、无噪点自动大纲与紧致图表裁剪', () => {
  it('精准提取 Springer（栏目标签 + 中圆点作者 + 卷期年份）与 ACM（双行含逗号标题 + 多栏作者 + Reference Format）元数据', () => {
    const springerText = [
      'The VLDB Journal (2024) 33:903–929',
      'https://doi.org/10.1007/s00778-023-00817-w',
      'S P E C I A L I S S U E P A P E R',
      'F-IVM: analytics over relational databases under updates',
      'Ahmet Kara 1 · Milos Nikolic 2 · Dan Olteanu 1 · Haozhe Zhang 1',
      'Received: 16 February 2023 / Published online: 14 November 2023',
      '© The Author(s) 2023',
      'Abstract'
    ].join('\n')
    const springerItems = [
      { str: 'The VLDB Journal (2024) 33:903–929', fontSize: 8.5, x: 51, y: 751, hasEOL: true },
      { str: 'https://doi.org/10.1007/s00778-023-00817-w', fontSize: 8.5, x: 51, y: 740, hasEOL: true },
      { str: 'S P E C I A L I S S U E P A P E R', fontSize: 9.5, x: 56, y: 718, hasEOL: true },
      { str: 'F-IVM: analytics over relational databases under updates', fontSize: 15.9, x: 51, y: 672, hasEOL: true },
      { str: 'Ahmet Kara', fontSize: 10, x: 51, y: 642, width: 52 },
      { str: '1', fontSize: 7.6, x: 103, y: 646, width: 4 },
      { str: '·', fontSize: 10, x: 110, y: 642, width: 4 },
      { str: 'Milos Nikolic', fontSize: 10, x: 115, y: 642, width: 56 },
      { str: '2', fontSize: 7.6, x: 171, y: 646, width: 4 },
      { str: '·', fontSize: 10, x: 178, y: 642, width: 4 },
      { str: 'Dan Olteanu', fontSize: 10, x: 183, y: 642, width: 55 },
      { str: '·', fontSize: 10, x: 254, y: 642, width: 4 },
      { str: 'Haozhe Zhang', fontSize: 10, x: 260, y: 642, width: 62, hasEOL: true },
      { str: '© The Author(s) 2023', fontSize: 8.5, x: 51, y: 604, hasEOL: true },
      { str: 'Abstract', fontSize: 10, x: 51, y: 574, hasEOL: true }
    ]

    const fivm = extractCitationMetadata({ page1Text: springerText, items: springerItems }, 'fallback')
    expect(fivm.title).toBe('F-IVM: analytics over relational databases under updates')
    expect(fivm.authors).toEqual(['Ahmet Kara', 'Milos Nikolic', 'Dan Olteanu', 'Haozhe Zhang'])
    expect(fivm.year).toBe('2024')
    expect(fivm.venue).toBe('The VLDB Journal (2024) 33:903–929')
    expect(fivm.doi).toBe('10.1007/s00778-023-00817-w')
    expect(formatBibtex(fivm)).toContain('@article{')
    expect(formatBibtex(fivm)).toContain('journal   = {The VLDB Journal (2024) 33:903–929}')
    expect(formatIeee(fivm)).not.toContain(',",')
    expect(formatGbt7714(fivm)).toContain('[J]')

    const acmText = [
      'ScaleStore: A Fast and Cost-Efficient Storage Engine',
      'using DRAM, NVMe, and RDMA',
      'Tobias Ziegler',
      'Technische Universität Darmstadt',
      'Carsten Binnig',
      'Technische Universität Darmstadt',
      'Viktor Leis',
      'Friedrich-Alexander-Universität Erlangen-Nürnberg',
      'ABSTRACT',
      'ACM Reference Format:',
      'Tobias Ziegler, Carsten Binnig, and Viktor Leis. 2022. ScaleStore. In Proceedings of the 2022 International Conference on Management of Data (SIGMOD \'22), June 12-17, 2022. https://doi.org/10.1145/3514221.3526187'
    ].join('\n')
    const acmItems = [
      { str: 'ScaleStore: A Fast and Cost-Efficient Storage Engine', fontSize: 17.2, x: 103, y: 696, hasEOL: true },
      { str: 'using DRAM, NVMe, and RDMA', fontSize: 17.2, x: 180, y: 676, hasEOL: true },
      { str: 'Tobias Ziegler', fontSize: 12, x: 108, y: 650, hasEOL: true },
      { str: 'Technische Universität Darmstadt', fontSize: 10, x: 96, y: 638, hasEOL: true },
      { str: 'Carsten Binnig', fontSize: 12, x: 270, y: 650, hasEOL: true },
      { str: 'Technische Universität Darmstadt', fontSize: 10, x: 260, y: 638, hasEOL: true },
      { str: 'Viktor Leis', fontSize: 12, x: 443, y: 650, hasEOL: true },
      { str: 'ABSTRACT', fontSize: 10.9, x: 54, y: 606, hasEOL: true }
    ]

    const scaleStore = extractCitationMetadata({ page1Text: acmText, items: acmItems }, 'fallback')
    expect(scaleStore.title).toBe('ScaleStore: A Fast and Cost-Efficient Storage Engine using DRAM, NVMe, and RDMA')
    expect(scaleStore.authors).toEqual(['Tobias Ziegler', 'Carsten Binnig', 'Viktor Leis'])
    expect(scaleStore.year).toBe('2022')
    expect(scaleStore.venue).toContain('Proceedings of the 2022 International Conference on Management of Data')
    expect(scaleStore.venue).not.toContain('ACM Reference Format')
    expect(formatBibtex(scaleStore)).toContain('@inproceedings{')
    expect(formatRis(scaleStore)).toContain('TY  - CONF')

    const plainFallback = extractCitationMetadataFromText(
      'SIGMOD 2025 Proceedings\nDeterministic Layout Engines\nAlice Smith, Bob Chen\nAbstract\n10.1145/12345.67890',
      'fallback'
    )
    expect(plainFallback.title).toBe('Deterministic Layout Engines')
    expect(plainFallback.authors).toEqual(['Alice Smith', 'Bob Chen'])
  })

  it('自动大纲在 References 后不再列出参考文献，同时过滤页眉重复行、代码行、图内标注与表格数字', () => {
    const outline = extractAutoOutlineFromPages([
      {
        pageNumber: 1,
        lines: [
          { text: 'Abstract', fontSize: 11 },
          { text: '1. Introduction', fontSize: 12 },
          { text: 'This is a normal body paragraph explaining the problem in detail.', fontSize: 10 },
          { text: 'Figure 1: System architecture overview.', fontSize: 9.5 },
          { text: '2. Methods', fontSize: 12 }
        ]
      },
      {
        pageNumber: 2,
        lines: [
          { text: 'A. Kara et al.', fontSize: 9 },
          { text: '2.1 Band Segmentation', fontSize: 11 },
          { text: '1 Ownership request', fontSize: 7.5 },
          { text: '0 bool lookup(KeyType key) {', fontSize: 9 },
          { text: '128 GiB 512 GiB 2 TiB 8 TiB', fontSize: 9 },
          { text: '2 c 2', fontSize: 10 },
          { text: '2.2 ScaleStore vs. GAM', fontSize: 11 }
        ]
      },
      {
        pageNumber: 3,
        lines: [
          { text: 'A. Kara et al.', fontSize: 9 },
          { text: 'References', fontSize: 12 },
          { text: '1. Abadi, D.J., Ahmad, Y., Balazinska, M.: The design of the Borealis engine.', fontSize: 9 },
          { text: '2. Chen, L., Kumar, A.: Towards linear algebra over normalized data.', fontSize: 9 },
          { text: 'Appendix A Supplementary Proofs', fontSize: 12 }
        ]
      }
    ])

    expect(outline.map(i => i.title)).toEqual([
      'Abstract',
      '1. Introduction',
      '2. Methods',
      'References',
      'Appendix A Supplementary Proofs'
    ])
    expect(outline[2].items.map(sub => sub.title)).toEqual(['2.1 Band Segmentation', '2.2 ScaleStore vs. GAM'])
  })

  it('自动大纲支持中文一/（一）章节识别且过滤句末长句，并正确计算标题匹配分', () => {
    const cnOutline = extractAutoOutlineFromPages([
      {
        pageNumber: 1,
        lines: [
          { text: '一、总体安排与报到须知', fontSize: 13 },
          { text: '（一）网上迎新系统注册流程', fontSize: 11.5 },
          { text: '（二）请各位新生务必在截止日期前完成登记。', fontSize: 10 },
          { text: '二、心理健康测评与校园卡办理', fontSize: 13 }
        ]
      }
    ])

    expect(cnOutline.map(item => item.title)).toEqual(['一、总体安排与报到须知', '二、心理健康测评与校园卡办理'])
    expect(cnOutline[0].items.map(item => item.title)).toEqual(['（一）网上迎新系统注册流程'])

    expect(scoreOutlineHeadingMatch('2.1 Band Segmentation', 'heading', '2.1 Band Segmentation')).toBe(120)
    expect(scoreOutlineHeadingMatch('Band Segmentation', 'paragraph', '2.1 Band Segmentation')).toBe(92)
    expect(scoreOutlineHeadingMatch('Unrelated paragraph text.', 'paragraph', '2.1 Band Segmentation')).toBe(0)
  })

  it('紧致图表裁剪算法消除图上方大片白边且不误裁上方正文段落', () => {
    const width = 400
    const height = 800
    const pixels = makeWhiteRgba(width, height)
    // y=120..160: 上方无关正文段落
    fillRectRgba(pixels, width, 40, 120, 320, 40)
    // y=160..340: 180px 大片空白
    // y=340..440: 真正的图（宽 220px，高 100px，居中）
    fillRectRgba(pixels, width, 90, 340, 220, 100)
    // y=455..472: 图注 Figure 3
    fillRectRgba(pixels, width, 70, 455, 260, 17)

    const crop = computeTightFigureCropBox(pixels, width, height, 'figure', {
      x: 70,
      y: 455,
      width: 260,
      height: 17
    })
    expect(crop).not.toBeNull()
    // 上界应停在图顶 (340 - 12 = 328) 附近，绝不会向上吞入 y=120 的正文或大片留白
    expect(crop!.sy).toBeGreaterThanOrEqual(315)
    expect(crop!.sy).toBeLessThanOrEqual(345)
    expect(crop!.sy + crop!.sh).toBeGreaterThanOrEqual(470)
    expect(crop!.sh).toBeLessThan(180)

    // 紧密排版场景：正文段落距离图顶仅 6px 时，依赖正文障碍块边界仍可准确截断正文
    const tightPixels = makeWhiteRgba(width, height)
    fillRectRgba(tightPixels, width, 40, 260, 320, 74) // 正文段落底在 y=334
    fillRectRgba(tightPixels, width, 90, 340, 220, 100) // 图顶在 y=340，仅隔 6px
    fillRectRgba(tightPixels, width, 70, 452, 260, 17)
    const tightCrop = computeTightFigureCropBox(
      tightPixels,
      width,
      height,
      'figure',
      { x: 70, y: 452, width: 260, height: 17 },
      [{ x: 40, y: 260, width: 320, height: 74 }]
    )
    expect(tightCrop).not.toBeNull()
    expect(tightCrop!.sy).toBeGreaterThanOrEqual(324)
    expect(tightCrop!.sh).toBeLessThan(175)
  })

  it('图表速览命中 caption 块时携带 captionBounds 坐标用于原图裁剪', () => {
    const match = findReferenceMatchInPages(
      { kind: 'figure', label: 'Fig. 1', key: '1' },
      new Map([
        [
          1,
          {
            text: 'Figure 1: Synthetic diagram.',
            blocks: [
              {
                kind: 'caption',
                text: 'Figure 1: Synthetic diagram.',
                bounds: { x: 326, y: 610, width: 220, height: 14 }
              }
            ]
          }
        ]
      ]),
      1
    )
    expect(match?.captionBounds).toEqual({ x: 326, y: 610, width: 220, height: 14 })
  })
})
