import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupService } from '../../src/main/services/backup-service'
import { LibraryDatabase } from '../../src/main/services/database'
import { DocumentService } from '../../src/main/services/document-service'
import {
  RESEARCH_PROFILE_SETTINGS_KEY,
  TRANSLATION_SETTINGS_KEY,
  readResearchProfile,
  saveResearchProfile
} from '../../src/main/services/research-profile'
import { buildAcademicPrompt, buildExplainPrompt } from '../../src/main/services/translation-service'
import { createZipBuffer, readZipBuffer } from '../../src/main/services/zip-archive'
import {
  RESEARCH_FACULTIES,
  RESEARCH_TRACK_OPTIONS,
  buildResearchContextSummary,
  collectRecommendedTags,
  collectStarterGlossary,
  formatResearchProfileBadge,
  recommendTracksForGuidance
} from '../../src/shared/research-onboarding'

async function validatePdf(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false })
  return document.getPageCount()
}

describe('全学科研究生科研向导共享目录与推荐引擎', () => {
  it('涵盖 8 大学科门类与 25 个细分方向，且默认标签不含前导 #', () => {
    expect(RESEARCH_FACULTIES).toHaveLength(8)
    expect(RESEARCH_TRACK_OPTIONS).toHaveLength(25)

    const facultyIds = new Set(RESEARCH_FACULTIES.map(f => f.id))
    const trackIds = new Set<string>()
    for (const track of RESEARCH_TRACK_OPTIONS) {
      expect(facultyIds.has(track.facultyId)).toBe(true)
      expect(trackIds.has(track.id)).toBe(false)
      trackIds.add(track.id)
      expect(track.venues.length).toBeGreaterThan(0)
      expect(track.searchTip.trim().length).toBeGreaterThan(8)
      expect(track.starterGlossary.length).toBeGreaterThanOrEqual(4)
      for (const tag of track.recommendedTags) {
        expect(tag.startsWith('#')).toBe(false)
      }
    }
  })

  it('针对生物、化学、物理、经管、人文等不同学科都能准确匹配推荐方向', () => {
    const chemRecs = recommendTracksForGuidance({
      facultyId: 'chem-mat',
      paradigm: 'exp',
      readingGoal: 'reproduce',
      customTopic: '电催化过电位'
    })
    expect(chemRecs).toHaveLength(3)
    expect(chemRecs[0].track.id).toBe('chem-energy')

    const bioRecs = recommendTracksForGuidance({
      facultyId: 'bio-med',
      paradigm: 'comp',
      readingGoal: 'survey',
      customTopic: 'scRNA-seq 单细胞'
    })
    expect(bioRecs[0].track.id).toBe('bio-genomics')

    const econRecs = recommendTracksForGuidance({
      facultyId: 'econ-mgmt',
      paradigm: 'theory',
      readingGoal: 'writing',
      customTopic: '双重差分 DID'
    })
    expect(econRecs[0].track.id).toBe('econ-causal')

    const physRecs = recommendTracksForGuidance({
      facultyId: 'math-phys',
      paradigm: 'theory',
      readingGoal: 'survey',
      customTopic: ''
    })
    expect(physRecs[0].track.facultyId).toBe('math-phys')
  })

  it('collectRecommendedTags、collectStarterGlossary 与上下文摘要/徽章格式化正确', () => {
    const tags = collectRecommendedTags(['chem-energy'], '#钙钛矿太阳能电池, 稳定性', 'reproduce')
    expect(tags[0]).toBe('钙钛矿太阳能电池')
    expect(tags.every(t => !t.startsWith('#'))).toBe(true)
    expect(tags).toContain('方法复现')

    const glossary = collectStarterGlossary(['chem-energy', 'bio-cell'])
    expect(glossary.some(g => g.source === 'overpotential')).toBe(true)
    expect(glossary.some(g => g.source === 'CRISPR-Cas9')).toBe(true)

    const skippedContext = buildResearchContextSummary({
      completed: true,
      mode: 'skipped',
      stage: 'master-1',
      facultyId: '',
      selectedTrackIds: [],
      customTopic: '',
      paradigm: 'exp',
      readingGoal: 'survey',
      recommendedTags: [],
      updatedAt: new Date().toISOString()
    })
    expect(skippedContext).toBe('')

    const activeProfile = {
      completed: true,
      mode: 'direct' as const,
      stage: 'phd' as const,
      facultyId: 'bio-med',
      selectedTrackIds: ['bio-neuro'],
      customTopic: '双光子钙成像',
      paradigm: 'exp' as const,
      readingGoal: 'reproduce' as const,
      recommendedTags: ['双光子钙成像', '神经科学', '方法复现'],
      updatedAt: new Date().toISOString()
    }
    const summary = buildResearchContextSummary(activeProfile)
    expect(summary).toContain('生命科学与医学')
    expect(summary).toContain('双光子钙成像')
    expect(summary).toContain('实验观测与表征')
    expect(formatResearchProfileBadge(activeProfile)).toBe('生医 · 双光子钙成像')
  })
})

describe('科研画像本地持久化、术语合并、提示词注入与备份恢复', () => {
  let root: string
  let dbPath: string
  let db: LibraryDatabase

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'paperflow-onboarding-unit-'))
    dbPath = join(root, 'paperflow.sqlite')
    db = new LibraryDatabase(dbPath)
  })

  afterEach(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })

  it('saveResearchProfile 升级/保持 user_version=6，并将初始术语隔离写入学科分类文件夹而不污染全局词库', () => {
    db.setSetting(
      TRANSLATION_SETTINGS_KEY,
      JSON.stringify({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        glossary: [{ source: 'custom term', target: '自定义全局术语' }],
        openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 120 }
      })
    )
    db.setSetting('translation.apiKey.v1', 'secret-ciphertext-should-stay-intact')

    const saved = saveResearchProfile(db, {
      completed: true,
      mode: 'direct',
      stage: 'master-1',
      facultyId: 'chem-mat',
      selectedTrackIds: ['chem-energy'],
      customTopic: '固态电池正极界面',
      paradigm: 'exp',
      readingGoal: 'survey',
      recommendedTags: ['#固态电池正极界面', '电催化'],
      applyStarterGlossary: true
    })

    expect(saved.recommendedTags).toEqual(['固态电池正极界面', '电催化'])
    expect(readResearchProfile(db)).toEqual(saved)

    const rawInspect = new Database(dbPath, { readonly: true })
    try {
      expect(rawInspect.pragma('user_version', { simple: true })).toBe(7)
    } finally {
      rawInspect.close()
    }

    // 全局词库与加密 API Key 均不被覆盖或污染
    expect(db.getSetting('translation.apiKey.v1')).toBe('secret-ciphertext-should-stay-intact')
    const globalConfig = JSON.parse(db.getSetting(TRANSLATION_SETTINGS_KEY) || '{}') as {
      glossary: Array<{ source: string; target: string }>
    }
    expect(globalConfig.glossary).toEqual([{ source: 'custom term', target: '自定义全局术语' }])

    // 应自动生成对应学科分类文件夹，并将术语隔离放入该文件夹中
    const folders = db.listFolders()
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toBe('固态电池正极界面')
    expect(folders[0].inheritGlobalGlossary).toBe(false)
    expect(folders[0].glossary.some(g => g.source === 'overpotential')).toBe(true)
    expect(folders[0].glossary.some(g => g.source === 'Tafel slope')).toBe(true)
  })

  it('skipped 模式保存后不写入术语表，且非法 JSON 读取返回 null', () => {
    saveResearchProfile(db, {
      completed: true,
      mode: 'skipped',
      stage: 'master-1',
      facultyId: '',
      selectedTrackIds: ['bio-cell'],
      customTopic: 'ignored',
      paradigm: 'exp',
      readingGoal: 'survey',
      recommendedTags: ['tag1'],
      applyStarterGlossary: true
    })

    const stored = readResearchProfile(db)
    expect(stored?.mode).toBe('skipped')
    expect(stored?.selectedTrackIds).toEqual([])
    expect(db.getSetting(TRANSLATION_SETTINGS_KEY)).toBeNull()

    db.setSetting(RESEARCH_PROFILE_SETTINGS_KEY, '{invalid-json')
    expect(readResearchProfile(db)).toBeNull()
  })

  it('buildAcademicPrompt 与 buildExplainPrompt 在有科研上下文时注入并附防跨学科冲突约束，无上下文时保持原格式', () => {
    const block = {
      blockId: 'p1-b1',
      kind: 'paragraph' as const,
      sourceText: 'We measure overpotential in 1 M KOH.',
      sourceHash: '0123456789abcdef'
    }
    const baseTranslate = buildAcademicPrompt('zh-CN', [block], [])
    const withCtxTranslate = buildAcademicPrompt(
      'zh-CN',
      [block],
      [{ source: 'overpotential', target: '过电位' }],
      '所属学科门类为「化学、材料与能源环境」。'
    )
    expect(baseTranslate).not.toContain('读者科研背景')
    expect(withCtxTranslate).toContain('若当前论文属于其他学科，请完全以论文本身学科规范为准')
    expect(withCtxTranslate).toContain('所属学科门类为「化学、材料与能源环境」。')
    expect(withCtxTranslate).toContain('切勿生搬硬套')
    expect(withCtxTranslate).toContain('- overpotential => 过电位')

    const explainInput = { selectedText: 'Tafel slope', mode: 'explain' as const, pageNumber: 1 }
    const baseExplain = buildExplainPrompt(explainInput, 'zh-CN', [])
    const withCtxExplain = buildExplainPrompt(
      explainInput,
      'zh-CN',
      [{ source: 'Tafel slope', target: '塔菲尔斜率' }],
      '所属学科门类为「物理学」。'
    )
    expect(baseExplain).not.toContain('读者科研背景')
    expect(withCtxExplain).toContain('若论文属于其他领域请以论文本身语境为准')
    expect(withCtxExplain).toContain('所属学科门类为「物理学」。')
    expect(withCtxExplain).toContain('切勿跨学科生搬硬套')
  })

  it('BackupService 导出并恢复 researchProfile，且兼容无 researchProfile 字段的旧备份', async () => {
    const dbTarget = new LibraryDatabase(join(root, 'target.sqlite'))
    try {
      const docA = new DocumentService(db, join(root, 'lib-a'), validatePdf)
      const docB = new DocumentService(dbTarget, join(root, 'lib-b'), validatePdf)
      const backupA = new BackupService(db, docA)
      const backupB = new BackupService(dbTarget, docB)

      const profile = saveResearchProfile(db, {
        completed: true,
        mode: 'guided',
        stage: 'phd',
        facultyId: 'math-phys',
        selectedTrackIds: ['phys-quantum'],
        customTopic: '拓扑超导态',
        paradigm: 'theory',
        readingGoal: 'survey',
        recommendedTags: ['拓扑超导态', '凝聚态物理', '领域综述'],
        applyStarterGlossary: true
      })

      const exported = await backupA.exportBackupArchive()
      await backupB.importBackupArchive(exported.zipBuffer)
      expect(readResearchProfile(dbTarget)).toEqual(profile)

      // 构造不含 researchProfile 的旧版备份并确认可正常恢复
      const entries = readZipBuffer(exported.zipBuffer)
      const rawManifest = JSON.parse(entries.get('paperflow-backup.json')!.toString('utf8')) as Record<string, unknown>
      delete rawManifest.researchProfile
      const legacyEntries = Array.from(entries.entries()).map(([name, data]) => ({
        name,
        data: name === 'paperflow-backup.json' ? Buffer.from(JSON.stringify(rawManifest), 'utf8') : data,
        compress: !name.endsWith('.pdf')
      }))
      const legacyZip = createZipBuffer(legacyEntries)
      const dbLegacy = new LibraryDatabase(join(root, 'legacy-target.sqlite'))
      try {
        const docLegacy = new DocumentService(dbLegacy, join(root, 'lib-legacy'), validatePdf)
        const backupLegacy = new BackupService(dbLegacy, docLegacy)
        await backupLegacy.importBackupArchive(legacyZip)
        expect(readResearchProfile(dbLegacy)).toBeNull()
      } finally {
        dbLegacy.close()
      }
    } finally {
      dbTarget.close()
    }
  })
})
