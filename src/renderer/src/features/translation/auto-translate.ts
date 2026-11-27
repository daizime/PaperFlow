import type { DetectedLocalAiClient, TranslationSettings } from '../../../../shared/contracts'
import type { SplitPaneViewMode } from '../reader/split-panes'
import { inferBillingKindFromSettings } from './usage-format'

export type PdfLanguageKind = 'chinese' | 'non-chinese' | 'insufficient'
export type PersistedReaderViewMode = SplitPaneViewMode

export interface UnconfiguredEnginePromptState {
  documentId: string
  documentTitle: string
}

const URL_RE = /https?:\/\/\S+/gi
const EMAIL_RE = /\S+@\S+\.\S+/g
const HAN_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const KANA_CHAR_RE = /[\u3040-\u30ff]/g
const HANGUL_CHAR_RE = /[\uac00-\ud7af]/g
const LATIN_CHAR_RE = /[A-Za-z\u00c0-\u024f]/g
const CYRILLIC_CHAR_RE = /[\u0400-\u04ff]/g

/**
 * 基于 PDF 提取文本的字符脚本占比判定文献是否为中文（区分中/日/韩文与英文含少量汉字签名）。
 */
export function classifyPdfLanguageFromText(sampleText: string): PdfLanguageKind {
  const cleaned = sampleText.replace(URL_RE, ' ').replace(EMAIL_RE, ' ')
  const cjkCount = (cleaned.match(HAN_CHAR_RE) ?? []).length
  const kanaCount = (cleaned.match(KANA_CHAR_RE) ?? []).length
  const hangulCount = (cleaned.match(HANGUL_CHAR_RE) ?? []).length
  const latinCount = (cleaned.match(LATIN_CHAR_RE) ?? []).length
  const cyrillicCount = (cleaned.match(CYRILLIC_CHAR_RE) ?? []).length

  const totalScript = cjkCount + kanaCount + hangulCount + latinCount + cyrillicCount

  // 短封面/纯中文标题（无拉丁/日/韩假名音节干扰）
  if (cjkCount >= 6 && latinCount === 0 && kanaCount === 0 && hangulCount === 0 && cyrillicCount === 0) {
    return 'chinese'
  }
  if (totalScript < 12) {
    return 'insufficient'
  }

  // 日文/韩文即使混用大量汉字，假名/谚文占东亚文字比重显著时也不按中文处理
  if (kanaCount >= 8 && kanaCount / Math.max(1, cjkCount + kanaCount) >= 0.12) {
    return 'non-chinese'
  }
  if (hangulCount >= 8 && hangulCount / Math.max(1, cjkCount + hangulCount) >= 0.12) {
    return 'non-chinese'
  }

  // 英文长句字母数量约等于中文信息量的 2.5 倍，按加权有效字符比识别混排中文文献
  const chineseShare =
    (cjkCount * 2.5) /
    Math.max(1, cjkCount * 2.5 + latinCount + cyrillicCount + kanaCount * 1.5 + hangulCount * 1.5)

  if ((cjkCount >= 16 && chineseShare >= 0.22) || (cjkCount >= 6 && chineseShare >= 0.55)) {
    return 'chinese'
  }
  return 'non-chinese'
}

/**
 * 判断当前生效的翻译 API 或本机 AI CLI 客户端是否已完成可用配置。
 */
export function isTranslationEngineConfigured(
  settings: TranslationSettings | null,
  detectedCliClients?: readonly DetectedLocalAiClient[] | null
): boolean {
  if (!settings) return false
  if (settings.provider === 'openai-compatible') {
    if (!settings.openai.baseUrl.trim() || !settings.openai.model.trim()) {
      return false
    }
    return settings.openai.hasApiKey || inferBillingKindFromSettings(settings) === 'ollama-local'
  }

  const cmd = settings.cli.command.trim()
  if (!cmd || settings.cli.authorized !== true) return false

  if (
    (settings.cli.preset === 'codex' || settings.cli.preset === 'gemini') &&
    cmd.toLowerCase() === settings.cli.preset &&
    detectedCliClients
  ) {
    const match = detectedCliClients.find(client => client.preset === settings.cli.preset)
    if (match && match.status !== 'ready') {
      return false
    }
  }
  return true
}

/**
 * 从持久化存储安全读取各文献最近一次关闭/离开时的阅读视图模式映射。
 */
export function loadStoredDocViewModes(
  storage: Pick<Storage, 'getItem'> | null,
  storageKey: string
): Record<string, PersistedReaderViewMode> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(storageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, PersistedReaderViewMode> = {}
    for (const [docId, mode] of Object.entries(parsed)) {
      if (!docId) continue
      if (mode === 'source' || mode === 'dual' || mode === 'translation') {
        result[docId] = mode
      }
    }
    return result
  } catch {
    return {}
  }
}

/**
 * 获取指定文献的当前视图模式：曾切换过双栏/译文则返回持久状态，否则默认展示原文。
 */
export function resolveDocumentViewMode(
  docViewModes: Readonly<Record<string, PersistedReaderViewMode>>,
  documentId: string | null
): PersistedReaderViewMode {
  if (!documentId) return 'source'
  return docViewModes[documentId] ?? 'source'
}
