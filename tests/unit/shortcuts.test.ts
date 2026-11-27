import { describe, expect, test } from 'vitest'
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflict,
  formatShortcutKeys,
  keyboardEventToShortcutCombo,
  loadStoredShortcuts,
  matchesShortcutEvent,
  mergeShortcuts,
  resetShortcut,
  saveStoredShortcuts,
  validateShortcutCombo
} from '../../src/renderer/src/features/study/shortcuts'

describe('shortcuts: 自定义快捷键解析、冲突检测、匹配与持久化（合成素材）', () => {
  test('keyboardEventToShortcutCombo normalizes single keys, shifted symbols, zoom combos, and IME fallback', () => {
    expect(keyboardEventToShortcutCombo({ key: 'Control', ctrlKey: true })).toBeNull()
    expect(keyboardEventToShortcutCombo({ key: 'Shift', shiftKey: true })).toBeNull()

    expect(keyboardEventToShortcutCombo({ key: 'g' })).toBe('g')
    expect(keyboardEventToShortcutCombo({ key: 'G', shiftKey: true })).toBe('Shift+g')
    expect(keyboardEventToShortcutCombo({ key: '?', shiftKey: true, code: 'Slash' })).toBe('?')
    expect(keyboardEventToShortcutCombo({ key: '=', ctrlKey: true, code: 'Equal' })).toBe('Ctrl+=')
    expect(keyboardEventToShortcutCombo({ key: '+', ctrlKey: true, shiftKey: true, code: 'Equal' })).toBe('Ctrl+=')
    expect(keyboardEventToShortcutCombo({ key: 'NumpadAdd', ctrlKey: true, code: 'NumpadAdd' })).toBe('Ctrl+=')
    expect(keyboardEventToShortcutCombo({ key: '-', ctrlKey: true, code: 'Minus' })).toBe('Ctrl+-')
    expect(keyboardEventToShortcutCombo({ key: 'K', ctrlKey: true, shiftKey: true, code: 'KeyK' })).toBe('Ctrl+Shift+k')
    expect(keyboardEventToShortcutCombo({ key: 'Process', code: 'KeyM' })).toBe('m')
    expect(keyboardEventToShortcutCombo({ key: 'Process', altKey: true, code: 'KeyT' })).toBe('Alt+t')
  })

  test('validateShortcutCombo protects reserved system and editing shortcuts', () => {
    expect(validateShortcutCombo('Escape').ok).toBe(false)
    expect(validateShortcutCombo('Enter').ok).toBe(false)
    expect(validateShortcutCombo('Ctrl+c').ok).toBe(false)
    expect(validateShortcutCombo('Ctrl+v').ok).toBe(false)
    expect(validateShortcutCombo('Ctrl+Shift+z').ok).toBe(false)

    expect(validateShortcutCombo('g').ok).toBe(true)
    expect(validateShortcutCombo('Alt+t').ok).toBe(true)
    expect(validateShortcutCombo('Ctrl+Shift+k').ok).toBe(true)
  })

  test('matchesShortcutEvent matches modifiers accurately without false positives', () => {
    expect(matchesShortcutEvent({ key: 't' }, 't')).toBe(true)
    expect(matchesShortcutEvent({ key: 'T', shiftKey: true }, 't')).toBe(false)
    expect(matchesShortcutEvent({ key: 't', ctrlKey: true }, 't')).toBe(false)

    expect(matchesShortcutEvent({ key: 'T', shiftKey: true }, 'Shift+t')).toBe(true)
    expect(matchesShortcutEvent({ key: '?', shiftKey: true, code: 'Slash' }, '?')).toBe(true)
    expect(matchesShortcutEvent({ key: '/', shiftKey: false, code: 'Slash' }, '?')).toBe(false)

    expect(matchesShortcutEvent({ key: '=', ctrlKey: true, code: 'Equal' }, 'Ctrl+=')).toBe(true)
    expect(matchesShortcutEvent({ key: '+', ctrlKey: true, shiftKey: true, code: 'NumpadAdd' }, 'Ctrl+=')).toBe(true)
    expect(matchesShortcutEvent({ key: '-', ctrlKey: true, code: 'Minus' }, 'Ctrl+-')).toBe(true)
    expect(matchesShortcutEvent({ key: '0', ctrlKey: true, code: 'Numpad0' }, 'Ctrl+0')).toBe(true)
    expect(matchesShortcutEvent({ key: 'k', ctrlKey: true, shiftKey: true, code: 'KeyK' }, 'Ctrl+Shift+k')).toBe(true)
    expect(matchesShortcutEvent({ key: 'Process', code: 'KeyG' }, 'g')).toBe(true)
  })

  test('findShortcutConflict, formatShortcutKeys, and storage persistence handle overrides & swaps cleanly', () => {
    const merged = mergeShortcuts({ toggleTheme: 'g', findInDoc: 'Ctrl+Shift+f' })
    expect(merged.toggleTheme).toBe('g')
    expect(merged.findInDoc).toBe('Ctrl+Shift+f')
    expect(merged.cycleViewMode).toBe(DEFAULT_SHORTCUTS.cycleViewMode)

    expect(findShortcutConflict(merged, 'cycleViewMode', 'g')).toBe('toggleTheme')
    expect(findShortcutConflict(merged, 'toggleTheme', 'g')).toBeNull()
    expect(findShortcutConflict(merged, 'cycleViewMode', 'm')).toBeNull()

    expect(formatShortcutKeys('Ctrl+=')).toEqual(['Ctrl', '+'])
    expect(formatShortcutKeys('Ctrl+Shift+k')).toEqual(['Ctrl', 'Shift', 'K'])
    expect(formatShortcutKeys('ArrowLeft')).toEqual(['←'])

    const backing = new Map<string, string>()
    const mockStorage = {
      getItem: (key: string): string | null => backing.get(key) ?? null,
      setItem: (key: string, val: string): void => {
        backing.set(key, val)
      },
      removeItem: (key: string): void => {
        backing.delete(key)
      }
    }

    saveStoredShortcuts(mockStorage, {
      toggleTheme: 'g',
      cycleViewMode: DEFAULT_SHORTCUTS.cycleViewMode
    })
    expect(loadStoredShortcuts(mockStorage)).toEqual({ toggleTheme: 'g' })

    saveStoredShortcuts(mockStorage, {})
    expect(backing.size).toBe(0)

    mockStorage.setItem(
      'paperflow:custom-shortcuts',
      JSON.stringify({ toggleTheme: 'Ctrl+c', cycleViewMode: 'g', unknownAction: 'x' })
    )
    expect(loadStoredShortcuts(mockStorage)).toEqual({ cycleViewMode: 'g' })
  })

  test('恢复单项默认键时转移被占用的绑定，并修复旧配置中的重复键', () => {
    const restored = mergeShortcuts(resetShortcut({ toggleTheme: 'v', cycleViewMode: 't' }, 'toggleTheme'))
    expect(restored).toEqual(DEFAULT_SHORTCUTS)
    const transferred = mergeShortcuts(resetShortcut({ toggleTheme: 'g', cycleViewMode: 't' }, 'toggleTheme'))
    expect(transferred.toggleTheme).toBe('t')
    expect(transferred.cycleViewMode).toBe('g')
    expect(new Set(Object.values(transferred)).size).toBe(Object.keys(transferred).length)
    expect(mergeShortcuts({ cycleViewMode: 't' })).toEqual(DEFAULT_SHORTCUTS)
  })
})
