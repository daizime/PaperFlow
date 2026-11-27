import { describe, expect, it } from 'vitest'
import { extractCleanPaperTitle, isLikelyMessyAcademicFilename } from '../../src/shared/citation'
import {
  clearChatMessagesArgsSchema,
  createFolderArgsSchema, deleteFolderArgsSchema, displayTitleSchema, documentIdArgsSchema,
  exportFolderPdfsArgsSchema, getDocumentTranslationScopeArgsSchema, importFolderArgsSchema,
  importPdfBytesArgsSchema, listChatMessagesArgsSchema, noArgsSchema, pageCountArgsSchema,
  readerStateSchema, renameDocumentArgsSchema, saveResearchProfileArgsSchema,
  sendAiChatArgsSchema, updateDocumentMetaArgsSchema, updateFolderArgsSchema
} from '../../src/shared/schemas'

describe('IPC 参数验证', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  it('ID 只接受 UUID，拒绝路径和 SQL 注入', () => {
    expect(documentIdArgsSchema.safeParse([id]).success).toBe(true)
    for (const value of ['../../private.pdf', "' OR 1=1 --", '', 1, null]) expect(documentIdArgsSchema.safeParse([value]).success).toBe(false)
  })

  it('所有参数数量、页数、缩放和时间验证', () => {
    expect(noArgsSchema.safeParse(['extra']).success).toBe(false)
    expect(pageCountArgsSchema.safeParse([id, 0]).success).toBe(false)
    expect(pageCountArgsSchema.safeParse([id, 2.5]).success).toBe(false)
    for (const scale of [NaN, Infinity, 0.49, 3.01]) expect(readerStateSchema.safeParse({ documentId: id, pageNumber: 1, scale, updatedAt: new Date().toISOString() }).success).toBe(false)
    expect(readerStateSchema.safeParse({ documentId: id, pageNumber: 1, scale: 1, updatedAt: 'yesterday' }).success).toBe(false)
  })

  it('重命名标题校验长度、首尾空白并拒绝 ASCII 控制字符', () => {
    expect(displayTitleSchema.parse('  Paper Title 2026  ')).toBe('Paper Title 2026')
    expect(displayTitleSchema.safeParse('a'.repeat(200)).success).toBe(true)
    expect(displayTitleSchema.safeParse(`  ${'a'.repeat(200)}  `).success).toBe(true)
    for (const invalid of ['', '   ', '\t\n', 'a'.repeat(201), 'bad\x00title', 'bad\ntitle', 'bad\rtitle', 'bad\x1ftitle', 'bad\x7ftitle']) {
      expect(displayTitleSchema.safeParse(invalid).success).toBe(false)
    }
    expect(renameDocumentArgsSchema.safeParse([id, '新标题']).success).toBe(true)
    expect(renameDocumentArgsSchema.safeParse([id, '   ']).success).toBe(false)
    expect(renameDocumentArgsSchema.safeParse(['not-a-uuid', '新标题']).success).toBe(false)
    expect(renameDocumentArgsSchema.safeParse([id, '新标题', 'extra']).success).toBe(false)
  })

  it('拖拽字节导入参数校验文件名、Uint8Array、严格键与 IPC 字节上限', () => {
    const sample = new Uint8Array([37, 80, 68, 70])
    const parsed = importPdfBytesArgsSchema.parse([{ originalFilename: '  paper.pdf  ', bytes: sample }])
    expect(parsed[0].originalFilename).toBe('paper.pdf')
    expect(parsed[0].bytes).toBeInstanceOf(Uint8Array)

    // 允许 0 字节与略超 100 MiB 进入服务层返回详细中文原因，同时限制超大缓冲区。
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'empty.pdf', bytes: new Uint8Array(0) }]).success).toBe(true)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'over.pdf', bytes: new Uint8Array(100 * 1024 * 1024 + 1) }]).success).toBe(true)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'dos.pdf', bytes: new Uint8Array(105 * 1024 * 1024 + 1) }]).success).toBe(false)

    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: '', bytes: sample }]).success).toBe(false)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: `${'a'.repeat(257)}.pdf`, bytes: sample }]).success).toBe(false)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'a.pdf', bytes: sample, path: '/etc/passwd' }]).success).toBe(false)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'a.pdf', bytes: [37, 80, 68, 70] }]).success).toBe(false)
    expect(importPdfBytesArgsSchema.safeParse([{ originalFilename: 'a.pdf', bytes: sample }, 'extra']).success).toBe(false)
  })

  it('研究向导配置参数校验模式、门类、范式、课题长度与控制字符', () => {
    expect(
      saveResearchProfileArgsSchema.safeParse([
        {
          completed: true,
          mode: 'direct',
          stage: 'master-1',
          facultyId: 'chem-mat',
          selectedTrackIds: ['chem-energy'],
          customTopic: '钙钛矿太阳能电池',
          paradigm: 'exp',
          readingGoal: 'survey',
          recommendedTags: ['电催化', '钙钛矿'],
          applyStarterGlossary: true
        }
      ]).success
    ).toBe(true)

    expect(
      saveResearchProfileArgsSchema.safeParse([
        {
          completed: true,
          mode: 'skipped',
          stage: 'phd',
          facultyId: '',
          selectedTrackIds: [],
          customTopic: '',
          paradigm: 'theory',
          readingGoal: 'writing',
          recommendedTags: [],
          applyStarterGlossary: false
        }
      ]).success
    ).toBe(true)

    // 控制字符 / 超长自定义课题 / 非法字段应拒绝
    expect(
      saveResearchProfileArgsSchema.safeParse([
        {
          completed: true,
          mode: 'direct',
          stage: 'master-1',
          facultyId: 'bio-med',
          selectedTrackIds: ['bio-cell'],
          customTopic: 'bad\x00topic',
          paradigm: 'exp',
          readingGoal: 'survey',
          recommendedTags: ['分子细胞']
        }
      ]).success
    ).toBe(false)

    expect(
      saveResearchProfileArgsSchema.safeParse([
        {
          completed: true,
          mode: 'direct',
          stage: 'master-1',
          facultyId: 'bio-med',
          selectedTrackIds: ['bio-cell'],
          customTopic: 'a'.repeat(161),
          paradigm: 'exp',
          readingGoal: 'survey',
          recommendedTags: []
        }
      ]).success
    ).toBe(false)

    expect(
      saveResearchProfileArgsSchema.safeParse([
        {
          completed: true,
          mode: 'direct',
          stage: 'master-1',
          facultyId: 'bio-med',
          selectedTrackIds: [],
          customTopic: '',
          paradigm: 'exp',
          readingGoal: 'survey',
          recommendedTags: [],
          unexpectedField: true
        }
      ]).success
    ).toBe(false)
  })

  it('分类文件夹与文献 folderId 参数校验名称、深度字段与 UUID', () => {
    expect(
      createFolderArgsSchema.safeParse([
        {
          parentId: null,
          name: '电催化与新能源',
          facultyId: 'chem-mat',
          contextSummary: '过电位与原位表征研究',
          glossary: [{ source: 'ablation', target: '激光烧蚀' }],
          inheritGlobalGlossary: false
        }
      ]).success
    ).toBe(true)
    expect(createFolderArgsSchema.safeParse([{ name: '   ' }]).success).toBe(false)
    expect(createFolderArgsSchema.safeParse([{ name: 'a'.repeat(65) }]).success).toBe(false)
    expect(updateFolderArgsSchema.safeParse([{ id, name: '新名字', inheritGlobalGlossary: true }]).success).toBe(true)
    expect(updateFolderArgsSchema.safeParse([{ id: 'bad-id', name: '新名字' }]).success).toBe(false)
    expect(deleteFolderArgsSchema.safeParse([id]).success).toBe(true)
    expect(exportFolderPdfsArgsSchema.safeParse([{ scope: 'all', includeAnnotations: true }]).success).toBe(true)
    expect(exportFolderPdfsArgsSchema.safeParse([{ scope: 'unassigned' }]).success).toBe(true)
    expect(exportFolderPdfsArgsSchema.safeParse([{ scope: 'folder', folderId: id }]).success).toBe(true)
    expect(exportFolderPdfsArgsSchema.safeParse([{ scope: 'folder' }]).success).toBe(false)
    expect(exportFolderPdfsArgsSchema.safeParse([{ scope: 'all', folderId: id }]).success).toBe(false)
    expect(importFolderArgsSchema.safeParse([]).success).toBe(true)
    expect(importFolderArgsSchema.safeParse([{ parentFolderId: null }]).success).toBe(true)
    expect(importFolderArgsSchema.safeParse([{ parentFolderId: id }]).success).toBe(true)
    expect(importFolderArgsSchema.safeParse([{ parentFolderId: 'bad' }]).success).toBe(false)
    expect(getDocumentTranslationScopeArgsSchema.safeParse([id]).success).toBe(true)
    expect(getDocumentTranslationScopeArgsSchema.safeParse(['bad']).success).toBe(false)
    expect(updateDocumentMetaArgsSchema.safeParse([{ documentId: id, folderId: id }]).success).toBe(true)
    expect(updateDocumentMetaArgsSchema.safeParse([{ documentId: id, folderId: null }]).success).toBe(true)
    expect(updateDocumentMetaArgsSchema.safeParse([{ documentId: id, folderId: 'not-uuid' }]).success).toBe(false)

    expect(listChatMessagesArgsSchema.safeParse([`doc:${id}`]).success).toBe(true)
    expect(listChatMessagesArgsSchema.safeParse(['bad key with spaces']).success).toBe(false)
    expect(clearChatMessagesArgsSchema.safeParse(['workspace:general']).success).toBe(true)
    expect(
      sendAiChatArgsSchema.safeParse([
        {
          sessionKey: `doc:${id}`,
          question: '请对比左栏与右栏文献的核心方法差异。',
          scope: 'all-open',
          quoteText: 'Overpotential reached 210 mV.',
          contexts: [
            { documentId: id, title: 'Paper A', paneLabel: '左栏', pageNumber: 1, excerpt: 'Sample excerpt' }
          ]
        }
      ]).success
    ).toBe(true)
    expect(
      sendAiChatArgsSchema.safeParse([
        {
          sessionKey: `doc:${id}`,
          question: '   ',
          scope: 'active',
          contexts: []
        }
      ]).success
    ).toBe(false)
  })

  it('乱码/编号学术文件名识别与干净标题提取', () => {
    expect(isLikelyMessyAcademicFilename('2405.12345.pdf')).toBe(true)
    expect(isLikelyMessyAcademicFilename('1-s2.0-S0092867423001234-main.pdf')).toBe(true)
    expect(isLikelyMessyAcademicFilename('s41586-023-06747-5.pdf')).toBe(true)
    expect(isLikelyMessyAcademicFilename('main.pdf')).toBe(true)
    expect(isLikelyMessyAcademicFilename('paper.pdf')).toBe(false)
    expect(isLikelyMessyAcademicFilename('Attention Is All You Need.pdf')).toBe(false)

    expect(
      extractCleanPaperTitle(
        {
          page1Text: 'Electrochemical Water Splitting\nJohn Doe',
          pdfInfo: { title: 'Efficient Electrocatalytic Oxygen Evolution' }
        },
        '2405.12345'
      )
    ).toBe('Efficient Electrocatalytic Oxygen Evolution')

    expect(
      extractCleanPaperTitle(
        {
          page1Text: 'Abstract only',
          pdfInfo: { title: '2405.12345' }
        },
        '2405.12345'
      )
    ).toBeNull()
  })
})
