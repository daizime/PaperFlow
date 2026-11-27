import { randomUUID } from 'node:crypto'
import type { CustomAiSkillRecord, SaveCustomAiSkillInput } from '../../shared/contracts'
import { customAiSkillIdSchema, saveCustomAiSkillInputSchema } from '../../shared/schemas'
import type { LibraryDatabase } from './database'

export const CUSTOM_SKILLS_SETTINGS_KEY = 'ai.customSkills.v1'
const MAX_CUSTOM_SKILLS = 30

function readRawList(database: LibraryDatabase): CustomAiSkillRecord[] {
  const raw = database.getSetting(CUSTOM_SKILLS_SETTINGS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const valid: CustomAiSkillRecord[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Partial<CustomAiSkillRecord>
      if (
        typeof rec.id === 'string' &&
        typeof rec.name === 'string' &&
        rec.name.trim() &&
        typeof rec.prompt === 'string' &&
        rec.prompt.trim()
      ) {
        valid.push({
          id: rec.id,
          name: rec.name.trim().slice(0, 60),
          description: typeof rec.description === 'string' ? rec.description.trim().slice(0, 160) : '',
          prompt: rec.prompt.trim().slice(0, 4000),
          createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : new Date().toISOString(),
          updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString()
        })
      }
      if (valid.length >= MAX_CUSTOM_SKILLS) break
    }
    return valid
  } catch {
    return []
  }
}

export function listCustomAiSkills(database: LibraryDatabase): CustomAiSkillRecord[] {
  return readRawList(database)
}

export function saveCustomAiSkill(
  database: LibraryDatabase,
  input: SaveCustomAiSkillInput
): CustomAiSkillRecord[] {
  const validated = saveCustomAiSkillInputSchema.parse(input)
  const list = readRawList(database)
  const now = new Date().toISOString()

  if (validated.id) {
    const idx = list.findIndex(item => item.id === validated.id)
    if (idx < 0) {
      throw new Error('要编辑的自定义技能模板不存在或已被删除。')
    }
    const updated: CustomAiSkillRecord = {
      ...list[idx],
      name: validated.name,
      description: validated.description ?? '',
      prompt: validated.prompt,
      updatedAt: now
    }
    const next = [...list]
    next[idx] = updated
    database.setSetting(CUSTOM_SKILLS_SETTINGS_KEY, JSON.stringify(next))
    return next
  }

  if (list.length >= MAX_CUSTOM_SKILLS) {
    throw new Error(`自定义技能模板最多保存 ${MAX_CUSTOM_SKILLS} 个，请先删除不常用的模板。`)
  }
  const created: CustomAiSkillRecord = {
    id: randomUUID(),
    name: validated.name,
    description: validated.description ?? '',
    prompt: validated.prompt,
    createdAt: now,
    updatedAt: now
  }
  const next = [created, ...list]
  database.setSetting(CUSTOM_SKILLS_SETTINGS_KEY, JSON.stringify(next))
  return next
}

export function deleteCustomAiSkill(database: LibraryDatabase, id: string): CustomAiSkillRecord[] {
  const validatedId = customAiSkillIdSchema.parse(id)
  const list = readRawList(database)
  const next = list.filter(item => item.id !== validatedId)
  if (next.length === list.length) {
    throw new Error('自定义技能模板不存在或已被删除。')
  }
  database.setSetting(CUSTOM_SKILLS_SETTINGS_KEY, JSON.stringify(next))
  return next
}
