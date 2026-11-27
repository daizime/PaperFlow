import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAcademicSkillPrompt } from '../../src/main/services/academic-skills'
import { formatAnnotationsMarkdown } from '../../src/main/services/annotation-export'
import { BackupService } from '../../src/main/services/backup-service'
import { deleteCustomAiSkill, listCustomAiSkills, saveCustomAiSkill } from '../../src/main/services/custom-skills'
import { LibraryDatabase } from '../../src/main/services/database'
import { DocumentService } from '../../src/main/services/document-service'
import { splitTextWithPageReferences } from '../../src/renderer/src/features/study/page-references'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'paperflow-ai-study-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('轨道二：页码点击解析、自定义技能模板与 AI 页笔记持久化', () => {
  it('splitTextWithPageReferences 准确提取中文/英文页码引用并排除小数/URL/非法页码', () => {
    expect(splitTextWithPageReferences('核心指标见 P.3 与 p. 12，实验细节参考 Page 5 或 第 4 页。')).toEqual([
      { kind: 'text', value: '核心指标见 ' },
      { kind: 'page-ref', label: 'P.3', pageNumber: 3 },
      { kind: 'text', value: ' 与 ' },
      { kind: 'page-ref', label: 'p. 12', pageNumber: 12 },
      { kind: 'text', value: '，实验细节参考 ' },
      { kind: 'page-ref', label: 'Page 5', pageNumber: 5 },
      { kind: 'text', value: ' 或 ' },
      { kind: 'page-ref', label: '第 4 页', pageNumber: 4 },
      { kind: 'text', value: '。' }
    ])

    // 小数点版本、标识符前缀、第 0 页不应被误匹配
    const untouched = '参数 v1.p.3 或 p.3.2 以及 第 0 页 不应触发。'
    expect(splitTextWithPageReferences(untouched)).toEqual([{ kind: 'text', value: untouched }])
  })

  it('custom-skills 支持新建/更新/删除且不受 resetLibrary 影响，buildAcademicSkillPrompt 生成 custom 提示词', () => {
    const dir = makeTempDir()
    const db = new LibraryDatabase(join(dir, 'paperflow.sqlite'))
    try {
      expect(listCustomAiSkills(db)).toEqual([])

      const afterCreate = saveCustomAiSkill(db, {
        name: '复现清单提取',
        description: '提取超参数与训练步数',
        prompt: '列出本文所有数据集、超参数与硬件配置，注明出处页码。'
      })
      expect(afterCreate).toHaveLength(1)
      const created = afterCreate[0]
      expect(created.name).toBe('复现清单提取')

      const afterEdit = saveCustomAiSkill(db, {
        id: created.id,
        name: '复现检查表',
        description: '更新说明',
        prompt: '列出数据集、学习率、批大小。'
      })
      expect(afterEdit).toHaveLength(1)
      expect(afterEdit[0].name).toBe('复现检查表')

      const promptSpec = buildAcademicSkillPrompt({
        skill: 'custom',
        targetLanguage: 'Simplified Chinese',
        customSkillName: afterEdit[0].name,
        customPrompt: afterEdit[0].prompt,
        customInstruction: '重点关注表 2',
        contexts: [{ documentId: randomUUID(), title: 'Demo Paper', pageNumber: 2, excerpt: 'LR=1e-4' }]
      })
      expect(promptSpec.displayTitle).toBe('复现检查表')
      expect(promptSpec.userLabel).toContain('【自定义技能 · 复现检查表】')
      expect(promptSpec.userPrompt).toContain('列出数据集、学习率、批大小。')
      expect(promptSpec.userPrompt).toContain('重点关注表 2')
      expect(promptSpec.userPrompt).toContain('LR=1e-4')

      // 重置文献库不应删除 app_settings 中的自定义技能模板
      db.resetLibrary()
      expect(listCustomAiSkills(db)).toHaveLength(1)

      const afterDelete = deleteCustomAiSkill(db, created.id)
      expect(afterDelete).toEqual([])
    } finally {
      db.close()
    }
  })

  it('AI 页面级批注（rects 为空）可正常创建、导出 Markdown 且可通过备份无损恢复', async () => {
    const dirA = makeTempDir()
    const dbA = new LibraryDatabase(join(dirA, 'a.sqlite'))
    const docsA = new DocumentService(dbA, join(dirA, 'libA'), async () => 4)
    const dirB = makeTempDir()
    const dbB = new LibraryDatabase(join(dirB, 'b.sqlite'))
    const docsB = new DocumentService(dbB, join(dirB, 'libB'), async () => 4)

    try {
      const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n%%EOF')
      const { document } = await docsA.importBuffer('ai-note-paper.pdf', pdfBytes)

      const noteAnn = dbA.createAnnotation({
        documentId: document.id,
        pageNumber: 3,
        color: 'blue',
        quoteText: '[AI 笔记] 核心方法对比',
        note: '系统在第 3 页采用分层索引，吞吐提升 2.4 倍（P.3）。',
        rects: []
      })
      expect(noteAnn.rects).toEqual([])
      expect(noteAnn.pageNumber).toBe(3)

      const md = formatAnnotationsMarkdown(document, [noteAnn])
      expect(md).toContain('## 第 3 页')
      expect(md).toContain('[AI 笔记] 核心方法对比')
      expect(md).toContain('系统在第 3 页采用分层索引')

      const backupA = new BackupService(dbA, docsA)
      const archive = await backupA.exportBackupArchive()
      expect(archive.annotationCount).toBe(1)

      const backupB = new BackupService(dbB, docsB)
      const restored = await backupB.importBackupArchive(archive.zipBuffer)
      expect(restored.restoredAnnotations).toBe(1)

      const docsInB = dbB.listDocuments()
      const annsInB = dbB.listAnnotations(docsInB[0].id)
      expect(annsInB).toHaveLength(1)
      expect(annsInB[0].rects).toEqual([])
      expect(annsInB[0].note).toContain('吞吐提升 2.4 倍')
    } finally {
      dbA.close()
      dbB.close()
    }
  })
})
