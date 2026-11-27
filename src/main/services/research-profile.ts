import { createHash } from 'node:crypto'
import type { GlossaryEntry, LibraryFolder, ResearchProfile, SaveResearchProfileInput } from '../../shared/contracts'
import {
  buildResearchContextSummary,
  collectStarterGlossary,
  getFacultyById,
  getTrackById
} from '../../shared/research-onboarding'
import { glossaryEntrySchema, researchProfileSchema, saveResearchProfileInputSchema } from '../../shared/schemas'
import type { LibraryDatabase } from './database'

export const RESEARCH_PROFILE_SETTINGS_KEY = 'research.profile.v1'
export const TRANSLATION_SETTINGS_KEY = 'translation.config.v1'

export interface EffectiveTranslationScope {
  folder: LibraryFolder | null
  glossary: GlossaryEntry[]
  researchContext: string
  folderGlossaryCount: number
  globalGlossaryCount: number
  scopeFingerprint: string
}

function computeScopeFingerprint(
  folderId: string | null,
  inheritGlobalGlossary: boolean,
  glossary: readonly GlossaryEntry[]
): string {
  const canonicalEntries = glossary
    .map(entry => `${entry.source.trim().toLowerCase()}=>${entry.target.trim()}`)
    .sort()
    .join('\n')
  return createHash('sha256')
    .update(`${folderId ?? 'global'}|${inheritGlobalGlossary ? '1' : '0'}|${canonicalEntries}`)
    .digest('hex')
    .slice(0, 12)
}

/** 从本地 SQLite app_settings 读取并校验研究生科研方向画像；缺失或损坏时返回 null。 */
export function readResearchProfile(database: LibraryDatabase): ResearchProfile | null {
  const raw = database.getSetting(RESEARCH_PROFILE_SETTINGS_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    const checked = researchProfileSchema.safeParse(parsed)
    return checked.success ? checked.data : null
  } catch {
    return null
  }
}

/** 将术语条目按原文大小写不敏感增量合并到翻译设置中，不覆盖已有词条，也不触碰加密 API 密钥。 */
export function mergeGlossaryIntoSettings(database: LibraryDatabase, incoming: readonly GlossaryEntry[]): number {
  if (incoming.length === 0) return 0
  let existingObj: Record<string, unknown> = {
    provider: 'openai-compatible',
    targetLanguage: 'zh-CN',
    glossary: [],
    openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 120 }
  }
  const raw = database.getSetting(TRANSLATION_SETTINGS_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingObj = { ...existingObj, ...(parsed as Record<string, unknown>) }
      }
    } catch {
      // 保留默认结构并合并术语表，不破坏已有密钥项
    }
  }

  const currentGlossary = Array.isArray(existingObj.glossary)
    ? existingObj.glossary
        .map(item => glossaryEntrySchema.safeParse(item))
        .filter((r): r is { success: true; data: GlossaryEntry } => r.success)
        .map(r => r.data)
    : []

  const seen = new Set(currentGlossary.map(entry => entry.source.trim().toLowerCase()))
  const merged = [...currentGlossary]
  let added = 0
  for (const item of incoming) {
    const checked = glossaryEntrySchema.safeParse(item)
    if (!checked.success) continue
    const key = checked.data.source.trim().toLowerCase()
    if (!key || seen.has(key) || merged.length >= 200) continue
    seen.add(key)
    merged.push(checked.data)
    added += 1
  }

  if (added > 0) {
    existingObj.glossary = merged
    database.setSetting(TRANSLATION_SETTINGS_KEY, JSON.stringify(existingObj))
  }
  return added
}

function mergeGlossaryEntries(
  base: readonly GlossaryEntry[],
  incoming: readonly GlossaryEntry[]
): GlossaryEntry[] {
  const seen = new Set<string>()
  const merged: GlossaryEntry[] = []
  const push = (entry: GlossaryEntry): void => {
    if (merged.length >= 200) return
    const key = entry.source.trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    merged.push({ source: entry.source.trim(), target: entry.target.trim() })
  }
  for (const item of base) push(item)
  for (const item of incoming) push(item)
  return merged
}

function dedupeTrackIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const clean = raw.trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const clean = raw.replace(/^#+/, '').trim()
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

/**
 * 解析某篇文献翻译与 AI 解释实际生效的术语表及学科背景：
 * - 若文献归属某分类文件夹：沿「当前子文件夹 → 上级文件夹」合并专属术语表（子级覆盖同原文父级条目），仅当开启 inheritGlobalGlossary 时才附加全局术语；
 * - 若文献未归类（folderId 为 null）：退回全局术语表与向导科研画像。
 */
export function resolveEffectiveTranslationScope(
  database: LibraryDatabase,
  documentId: string,
  globalGlossary: readonly GlossaryEntry[]
): EffectiveTranslationScope {
  const normalizedGlobal: GlossaryEntry[] = []
  const seenGlobal = new Set<string>()
  for (const item of globalGlossary) {
    const src = item.source.trim()
    const tgt = item.target.trim()
    const key = src.toLowerCase()
    if (!key || !tgt || seenGlobal.has(key)) continue
    seenGlobal.add(key)
    normalizedGlobal.push({ source: src, target: tgt })
  }

  const doc = database.getDocument(documentId)
  if (!doc || !doc.folderId) {
    return {
      folder: null,
      glossary: normalizedGlobal,
      researchContext: buildResearchContextSummary(readResearchProfile(database)),
      folderGlossaryCount: 0,
      globalGlossaryCount: normalizedGlobal.length,
      scopeFingerprint: computeScopeFingerprint(null, true, normalizedGlobal)
    }
  }

  const allFolders = new Map(database.listFolders().map(f => [f.id, f]))
  const chainLeafFirst: LibraryFolder[] = []
  const visited = new Set<string>()
  let cursor: string | null = doc.folderId
  while (cursor) {
    if (visited.has(cursor)) break
    visited.add(cursor)
    const folder = allFolders.get(cursor)
    if (!folder) break
    chainLeafFirst.push(folder)
    cursor = folder.parentId
  }

  if (chainLeafFirst.length === 0) {
    return {
      folder: null,
      glossary: normalizedGlobal,
      researchContext: buildResearchContextSummary(readResearchProfile(database)),
      folderGlossaryCount: 0,
      globalGlossaryCount: normalizedGlobal.length,
      scopeFingerprint: computeScopeFingerprint(null, true, normalizedGlobal)
    }
  }

  const leaf = chainLeafFirst[0]
  const seenSources = new Set<string>()
  const scopedGlossary: GlossaryEntry[] = []

  const appendUnique = (entries: readonly GlossaryEntry[]): void => {
    for (const item of entries) {
      if (scopedGlossary.length >= 200) return
      const key = item.source.trim().toLowerCase()
      if (!key || seenSources.has(key)) continue
      seenSources.add(key)
      scopedGlossary.push({ source: item.source.trim(), target: item.target.trim() })
    }
  }

  // 子分类优先于父分类；同一词条按当前最具体分类的译法生效
  for (const folder of chainLeafFirst) {
    appendUnique(folder.glossary)
  }
  const folderGlossaryCount = scopedGlossary.length
  if (leaf.inheritGlobalGlossary) {
    appendUnique(normalizedGlobal)
  }

  const rootFirst = [...chainLeafFirst].reverse()
  const pathText = rootFirst.map(f => f.name).join(' / ')
  const facultyId = chainLeafFirst.find(f => f.facultyId)?.facultyId ?? ''
  const faculty = facultyId ? getFacultyById(facultyId) : undefined
  const summaries = rootFirst
    .map(f => f.contextSummary.trim())
    .filter((summary, idx, arr) => summary.length > 0 && arr.indexOf(summary) === idx)

  const contextParts: string[] = [`所属文献分类「${pathText}」`]
  if (faculty) contextParts.push(`学科门类为「${faculty.name}」`)
  if (summaries.length > 0) contextParts.push(summaries.join('；'))

  return {
    folder: leaf,
    glossary: scopedGlossary,
    researchContext: `${contextParts.join('，')}。`,
    folderGlossaryCount,
    globalGlossaryCount: normalizedGlobal.length,
    scopeFingerprint: computeScopeFingerprint(leaf.id, leaf.inheritGlobalGlossary, scopedGlossary)
  }
}

/** 校验、规范化并持久化研究生科研方向画像；开启初始术语时创建/更新对应学科分类文件夹，不再污染全局词库。 */
export function saveResearchProfile(
  database: LibraryDatabase,
  rawInput: SaveResearchProfileInput
): ResearchProfile {
  const validated = saveResearchProfileInputSchema.parse(rawInput)
  const profile: ResearchProfile = {
    completed: validated.completed,
    mode: validated.mode,
    stage: validated.stage,
    facultyId: validated.facultyId,
    selectedTrackIds: validated.mode === 'skipped' ? [] : dedupeTrackIds(validated.selectedTrackIds),
    customTopic: validated.mode === 'skipped' ? '' : validated.customTopic.trim(),
    paradigm: validated.paradigm,
    readingGoal: validated.readingGoal,
    recommendedTags: validated.mode === 'skipped' ? [] : dedupeTags(validated.recommendedTags),
    updatedAt: new Date().toISOString()
  }

  database.setSetting(RESEARCH_PROFILE_SETTINGS_KEY, JSON.stringify(profile))

  if (
    validated.applyStarterGlossary &&
    profile.mode !== 'skipped' &&
    (profile.selectedTrackIds.length > 0 || profile.customTopic.length > 0)
  ) {
    const starterGlossary = collectStarterGlossary(profile.selectedTrackIds)
    const firstTrack = profile.selectedTrackIds.map(id => getTrackById(id)).find(Boolean)
    const folderName =
      profile.customTopic.slice(0, 64).trim() || firstTrack?.name || '我的研究方向'
    const contextSummary = buildResearchContextSummary(profile).slice(0, 300)

    const existingRoot = database
      .listFolders()
      .find(f => f.parentId === null && f.name.toLowerCase() === folderName.toLowerCase())

    if (existingRoot) {
      const merged = mergeGlossaryEntries(existingRoot.glossary, starterGlossary)
      database.updateFolder({
        id: existingRoot.id,
        facultyId: existingRoot.facultyId || profile.facultyId,
        contextSummary: existingRoot.contextSummary || contextSummary,
        glossary: merged
      })
    } else {
      database.createFolder({
        parentId: null,
        name: folderName,
        facultyId: profile.facultyId,
        contextSummary,
        glossary: starterGlossary,
        inheritGlobalGlossary: false
      })
    }
  }

  return profile
}
