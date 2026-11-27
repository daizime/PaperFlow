export const CUSTOM_SHORTCUTS_STORAGE_KEY = 'paperflow:custom-shortcuts'

export type ShortcutActionId =
  | 'prevPage'
  | 'nextPage'
  | 'firstPage'
  | 'lastPage'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'findInDoc'
  | 'toggleTheme'
  | 'cycleViewMode'
  | 'toggleLibrary'
  | 'toggleAiChat'
  | 'toggleOutline'
  | 'toggleAnnotations'
  | 'openCitation'
  | 'quickHighlight'
  | 'toggleShortcuts'

export type ShortcutMap = Record<ShortcutActionId, string>
export type ShortcutOverrides = Partial<Record<ShortcutActionId, string>>

export interface ShortcutDefinition {
  id: ShortcutActionId
  description: string
  defaultCombo: string
}

export interface ShortcutGroupDefinition {
  title: string
  items: readonly ShortcutDefinition[]
}

export interface KeyLikeEvent {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export const SHORTCUT_GROUPS: readonly ShortcutGroupDefinition[] = [
  {
    title: '阅读与导航',
    items: [
      { id: 'prevPage', description: '上一页', defaultCombo: 'ArrowLeft' },
      { id: 'nextPage', description: '下一页', defaultCombo: 'ArrowRight' },
      { id: 'firstPage', description: '跳到首页', defaultCombo: 'Home' },
      { id: 'lastPage', description: '跳到末页', defaultCombo: 'End' },
      { id: 'zoomIn', description: '放大页面', defaultCombo: 'Ctrl+=' },
      { id: 'zoomOut', description: '缩小页面', defaultCombo: 'Ctrl+-' },
      { id: 'zoomReset', description: '自适应页面宽度', defaultCombo: 'Ctrl+0' },
      { id: 'findInDoc', description: '文内全文搜索', defaultCombo: 'Ctrl+f' }
    ]
  },
  {
    title: '界面与精读操作',
    items: [
      { id: 'toggleTheme', description: '循环切换阅读主题（明亮 / 护眼 / 深色）', defaultCombo: 't' },
      { id: 'cycleViewMode', description: '切换视图模式（双栏 / 译文 / 原文）', defaultCombo: 'v' },
      { id: 'toggleLibrary', description: '展开 / 收起左侧文献库', defaultCombo: 'b' },
      { id: 'toggleAiChat', description: '打开 / 收起 AI 对话助手', defaultCombo: 'i' },
      { id: 'toggleOutline', description: '打开 / 关闭文档目录', defaultCombo: 'o' },
      { id: 'toggleAnnotations', description: '打开 / 关闭批注与笔记面板', defaultCombo: 'a' },
      { id: 'openCitation', description: '打开引用复制面板（BibTeX / IEEE / GB/T）', defaultCombo: 'c' },
      { id: 'quickHighlight', description: '快速对当前选中句添加黄色高亮', defaultCombo: 'h' },
      { id: 'toggleShortcuts', description: '显示 / 关闭快捷键一览', defaultCombo: '?' }
    ]
  }
]

const ALL_SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = SHORTCUT_GROUPS.flatMap(g => g.items)

export const DEFAULT_SHORTCUTS: ShortcutMap = ALL_SHORTCUT_DEFINITIONS.reduce((acc, item) => {
  acc[item.id] = item.defaultCombo
  return acc
}, {} as ShortcutMap)

const MODIFIER_ONLY_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'OS',
  'AltGraph',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead'
])

const CANONICAL_NAMED_KEYS: Record<string, string> = {
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Escape',
  Esc: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  ' ': 'Space',
  Spacebar: 'Space',
  Space: 'Space'
}

const CODE_TO_BASE_KEY: Record<string, string> = {
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Escape',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Space: 'Space',
  Equal: '=',
  Minus: '-',
  NumpadAdd: '=',
  NumpadSubtract: '-',
  NumpadMultiply: '*',
  NumpadDivide: '/',
  NumpadDecimal: '.',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

const RESERVED_COMBO_REASONS: Record<string, string> = {
  Escape: 'Esc 固定用于关闭浮窗或取消操作，不可绑定为其他快捷键。',
  Enter: 'Enter 为系统确认键，不可单独设为全局快捷键。',
  Tab: 'Tab 用于焦点切换，不可单独设为快捷键。',
  Backspace: 'Backspace 为文本退格键，不可单独设为全局快捷键。',
  Delete: 'Delete 为文本删除键，不可单独设为全局快捷键。',
  Space: '空格键为页面滚动与文本输入键，请搭配 Ctrl 或 Alt 等修饰键。',
  'Ctrl+c': 'Ctrl + C 为系统复制快捷键，不可覆盖。',
  'Ctrl+v': 'Ctrl + V 为系统粘贴快捷键，不可覆盖。',
  'Ctrl+x': 'Ctrl + X 为系统剪切快捷键，不可覆盖。',
  'Ctrl+a': 'Ctrl + A 为系统全选快捷键，不可覆盖。',
  'Ctrl+z': 'Ctrl + Z 为系统撤销快捷键，不可覆盖。',
  'Ctrl+y': 'Ctrl + Y 为系统重做快捷键，不可覆盖。',
  'Ctrl+Shift+z': 'Ctrl + Shift + Z 为系统重做快捷键，不可覆盖。'
}

function baseKeyFromCode(code: string | undefined): string | null {
  if (!code) return null
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  return CODE_TO_BASE_KEY[code] ?? null
}

function normalizeBaseKey(event: KeyLikeEvent): string | null {
  if (MODIFIER_ONLY_KEYS.has(event.key)) return null
  const named = CANONICAL_NAMED_KEYS[event.key]
  if (named) return named
  if (/^F([1-9]|1[0-2])$/i.test(event.key)) return event.key.toUpperCase()
  if (/^[A-Za-z]$/.test(event.key)) return event.key.toLowerCase()
  if (event.key === 'Process' || event.key === 'Unidentified') {
    return baseKeyFromCode(event.code)
  }
  const mod = Boolean(event.ctrlKey || event.metaKey || event.altKey)
  if (mod) {
    const codeFallback = baseKeyFromCode(event.code)
    if (codeFallback && (/^[a-z0-9]$/.test(codeFallback) || event.key.length !== 1 || event.key.charCodeAt(0) < 32)) {
      return codeFallback
    }
  }
  if (event.key.length === 1) return event.key
  return baseKeyFromCode(event.code)
}

function isShiftedNonAlnumSymbol(key: string): boolean {
  return key.length === 1 && !/^[a-z0-9]$/i.test(key)
}

/**
 * 将键盘事件规范化为可持久化、可展示的快捷键组合字符串（Modifier Only 返回 null）。
 */
export function keyboardEventToShortcutCombo(event: KeyLikeEvent): string | null {
  const mod = Boolean(event.ctrlKey || event.metaKey)
  const alt = Boolean(event.altKey)
  const shift = Boolean(event.shiftKey)

  if (!mod && !alt && (event.key === '?' || (shift && event.code === 'Slash'))) {
    return '?'
  }
  if (
    mod &&
    !alt &&
    (event.key === '=' || event.key === '+' || event.code === 'Equal' || event.code === 'NumpadAdd')
  ) {
    return 'Ctrl+='
  }
  if (
    mod &&
    !alt &&
    (event.key === '-' || event.key === '_' || event.code === 'Minus' || event.code === 'NumpadSubtract')
  ) {
    return 'Ctrl+-'
  }

  const base = normalizeBaseKey(event)
  if (!base) return null

  const includeShift =
    shift &&
    (mod || alt || !isShiftedNonAlnumSymbol(base))

  const parts: string[] = []
  if (mod) parts.push('Ctrl')
  if (alt) parts.push('Alt')
  if (includeShift) parts.push('Shift')
  parts.push(base)
  return parts.join('+')
}

/**
 * 校验用户录入的快捷键是否允许绑定（避免覆盖剪贴板、Esc 或纯输入控制键）。
 */
export function validateShortcutCombo(combo: string): { ok: true } | { ok: false; reason: string } {
  const reason = RESERVED_COMBO_REASONS[combo]
  if (reason) return { ok: false, reason }
  return { ok: true }
}

interface ParsedCombo {
  ctrl: boolean
  alt: boolean
  shift: boolean
  hasExplicitShift: boolean
  key: string
}

function parseShortcutCombo(combo: string): ParsedCombo | null {
  const trimmed = combo.trim()
  if (!trimmed) return null
  if (trimmed === '?') {
    return { ctrl: false, alt: false, shift: false, hasExplicitShift: false, key: '?' }
  }
  const tokens = trimmed.split('+')
  let ctrl = false
  let alt = false
  let shift = false
  let key = ''
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (i < tokens.length - 1) {
      if (token === 'Ctrl') ctrl = true
      else if (token === 'Alt') alt = true
      else if (token === 'Shift') shift = true
      else return null
    } else {
      key = token
    }
  }
  if (!key) return null
  return { ctrl, alt, shift, hasExplicitShift: shift, key }
}

/**
 * 判断一次键盘事件是否命中指定的快捷键配置。
 */
export function matchesShortcutEvent(event: KeyLikeEvent, combo: string): boolean {
  const mod = Boolean(event.ctrlKey || event.metaKey)
  const alt = Boolean(event.altKey)
  const shift = Boolean(event.shiftKey)

  if (combo === '?') {
    return !mod && !alt && (event.key === '?' || (shift && event.code === 'Slash'))
  }
  if (combo === 'Ctrl+=') {
    return (
      mod &&
      !alt &&
      (event.key === '=' || event.key === '+' || event.code === 'Equal' || event.code === 'NumpadAdd')
    )
  }
  if (combo === 'Ctrl+-') {
    return (
      mod &&
      !alt &&
      (event.key === '-' || event.key === '_' || event.code === 'Minus' || event.code === 'NumpadSubtract')
    )
  }
  if (combo === 'Ctrl+0') {
    return mod && !alt && !shift && (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0')
  }

  const parsed = parseShortcutCombo(combo)
  if (!parsed) return false
  if (mod !== parsed.ctrl || alt !== parsed.alt) return false

  const base = normalizeBaseKey(event)
  if (!base || base !== parsed.key) return false

  const checkShift = parsed.hasExplicitShift || /^[a-z]$/.test(parsed.key) || parsed.ctrl || parsed.alt
  if (checkShift && shift !== parsed.shift) return false
  if (!checkShift && shift && CANONICAL_NAMED_KEYS[parsed.key]) return false

  return true
}

const DISPLAY_KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Escape: 'Esc',
  Space: 'Space'
}

/**
 * 将规范化组合字符串转换为弹窗键帽数组，用于展示与无障碍文本。
 */
export function formatShortcutKeys(combo: string): string[] {
  if (combo === 'Ctrl+=') return ['Ctrl', '+']
  if (combo === 'Ctrl+-') return ['Ctrl', '-']
  const parsed = parseShortcutCombo(combo)
  if (!parsed) return [combo]
  const out: string[] = []
  if (parsed.ctrl) out.push('Ctrl')
  if (parsed.alt) out.push('Alt')
  if (parsed.shift) out.push('Shift')
  const displayKey = DISPLAY_KEY_LABELS[parsed.key] ?? (/^[a-z]$/.test(parsed.key) ? parsed.key.toUpperCase() : parsed.key)
  out.push(displayKey)
  return out
}

export function getShortcutDescription(actionId: ShortcutActionId): string {
  return ALL_SHORTCUT_DEFINITIONS.find(item => item.id === actionId)?.description ?? actionId
}

export function findShortcutConflict(
  shortcuts: Readonly<ShortcutMap>,
  targetActionId: ShortcutActionId,
  combo: string
): ShortcutActionId | null {
  for (const item of ALL_SHORTCUT_DEFINITIONS) {
    if (item.id === targetActionId) continue
    if (shortcuts[item.id] === combo) return item.id
  }
  return null
}

export function mergeShortcuts(overrides: ShortcutOverrides): ShortcutMap {
  const merged = { ...DEFAULT_SHORTCUTS }
  const assigned = new Set<string>()
  for (const item of ALL_SHORTCUT_DEFINITIONS) {
    const custom = overrides[item.id]
    if (typeof custom === 'string' && custom !== item.defaultCombo && !assigned.has(custom) && validateShortcutCombo(custom).ok) {
      merged[item.id] = custom
      assigned.add(custom)
    }
  }
  // 旧配置可能占用了仍在使用的默认键。恢复冲突项时也检查它释放出的键。
  let repaired: boolean
  do {
    repaired = false
    for (const item of ALL_SHORTCUT_DEFINITIONS) {
      if (merged[item.id] !== item.defaultCombo) continue
      const conflict = findShortcutConflict(merged, item.id, item.defaultCombo)
      if (conflict) {
        merged[conflict] = DEFAULT_SHORTCUTS[conflict]
        repaired = true
      }
    }
  } while (repaired)
  return merged
}

export function resetShortcut(overrides: ShortcutOverrides, actionId: ShortcutActionId): ShortcutOverrides {
  const current = mergeShortcuts(overrides)
  const next = { ...overrides }
  const occupant = findShortcutConflict(current, actionId, DEFAULT_SHORTCUTS[actionId])
  if (occupant) next[occupant] = current[actionId]
  delete next[actionId]
  return next
}

export function loadStoredShortcuts(
  storage: Pick<Storage, 'getItem'> | null,
  storageKey = CUSTOM_SHORTCUTS_STORAGE_KEY
): ShortcutOverrides {
  if (!storage) return {}
  try {
    const raw = storage.getItem(storageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const validIds = new Set<string>(ALL_SHORTCUT_DEFINITIONS.map(item => item.id))
    const seenCombos = new Set<string>()
    const overrides: ShortcutOverrides = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!validIds.has(key) || typeof value !== 'string') continue
      const actionId = key as ShortcutActionId
      if (!parseShortcutCombo(value) || !validateShortcutCombo(value).ok) continue
      if (value === DEFAULT_SHORTCUTS[actionId]) continue
      if (seenCombos.has(value)) continue
      seenCombos.add(value)
      overrides[actionId] = value
    }
    return overrides
  } catch {
    return {}
  }
}

export function saveStoredShortcuts(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
  overrides: ShortcutOverrides,
  storageKey = CUSTOM_SHORTCUTS_STORAGE_KEY
): void {
  if (!storage) return
  try {
    const cleaned: ShortcutOverrides = {}
    const merged = mergeShortcuts(overrides)
    for (const item of ALL_SHORTCUT_DEFINITIONS) {
      const val = merged[item.id]
      if (val !== DEFAULT_SHORTCUTS[item.id]) {
        cleaned[item.id] = val
      }
    }
    if (Object.keys(cleaned).length === 0) {
      storage.removeItem(storageKey)
    } else {
      storage.setItem(storageKey, JSON.stringify(cleaned))
    }
  } catch {
    // 忽略本地存储写入失败
  }
}
