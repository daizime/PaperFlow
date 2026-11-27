import { describe, expect, test } from 'vitest'
import {
  closeSplitPane,
  computeDropZone,
  dropDocumentIntoPanes,
  dropPaneOntoPane,
  formatPaneBadgeShort,
  formatPaneSlotLabel,
  getPaneViewMode,
  movePaneByOffset,
  setSplitPaneViewMode,
  type SplitPane
} from '../../src/renderer/src/features/reader/split-panes'

describe('自由拖拽分屏布局与任意多开归并器', () => {
  test('computeDropZone 根据拖放水平位置划分左/中/右热区', () => {
    expect(computeDropZone(110, { left: 100, width: 300 })).toBe('left')
    expect(computeDropZone(250, { left: 100, width: 300 })).toBe('center')
    expect(computeDropZone(385, { left: 100, width: 300 })).toBe('right')
  })

  test('支持用户自由拖入左/中/右持续叠加 2 开、3 开与 4+ 开且互不覆盖已有分栏', () => {
    let seq = 0
    const nextId = (): string => `pane-${++seq}`
    let panes: SplitPane[] = [{ id: 'pane-0', documentId: 'doc-a', weight: 1 }]

    // 拖 doc-b 到主栏右侧 -> 双开 [doc-a, doc-b]
    panes = dropDocumentIntoPanes(panes, 'doc-b', 'pane-0', 'right', nextId)
    expect(panes.map(p => p.documentId)).toEqual(['doc-a', 'doc-b'])

    // 拖 doc-c 到右栏左侧 -> 插入中间变成三开 [doc-a, doc-c, doc-b]
    panes = dropDocumentIntoPanes(panes, 'doc-c', panes[1].id, 'left', nextId)
    expect(panes.map(p => p.documentId)).toEqual(['doc-a', 'doc-c', 'doc-b'])

    // 拖 doc-d 到最左栏左侧 -> 用户可继续自由四开 [doc-d, doc-a, doc-c, doc-b]
    panes = dropDocumentIntoPanes(panes, 'doc-d', panes[0].id, 'left', nextId)
    expect(panes.map(p => p.documentId)).toEqual(['doc-d', 'doc-a', 'doc-c', 'doc-b'])

    // 拖 doc-e 到第 2 栏中间 -> 仅替换该栏文献
    panes = dropDocumentIntoPanes(panes, 'doc-e', panes[1].id, 'center', nextId)
    expect(panes.map(p => p.documentId)).toEqual(['doc-d', 'doc-e', 'doc-c', 'doc-b'])
  })

  test('分栏之间支持拖拽互换、插队重排、左右按键移动及安全关闭', () => {
    const initial: SplitPane[] = [
      { id: 'p1', documentId: 'doc-1', weight: 1 },
      { id: 'p2', documentId: 'doc-2', weight: 1 },
      { id: 'p3', documentId: 'doc-3', weight: 1 }
    ]

    // 拖 p1 放到 p3 的中心 -> 互换位置 [doc-3, doc-2, doc-1]
    const swapped = dropPaneOntoPane(initial, 'p1', 'p3', 'center')
    expect(swapped.map(p => p.id)).toEqual(['p3', 'p2', 'p1'])

    // 拖 p1 放到 p3 左侧 -> 插到 p3 左边 [p1, p3, p2]
    const inserted = dropPaneOntoPane(swapped, 'p1', 'p3', 'left')
    expect(inserted.map(p => p.id)).toEqual(['p1', 'p3', 'p2'])

    // 左右按钮移动
    const nudged = movePaneByOffset(inserted, 'p1', 1)
    expect(nudged.map(p => p.id)).toEqual(['p3', 'p1', 'p2'])

    // 关闭其中一栏，至少保留最后一栏
    const afterClose = closeSplitPane(nudged, 'p1')
    expect(afterClose.map(p => p.id)).toEqual(['p3', 'p2'])
    expect(closeSplitPane([afterClose[0]], 'p3')).toHaveLength(1)
  })

  test('槽位文案正确区分双开/三开/多开', () => {
    expect(formatPaneSlotLabel(0, 2)).toBe('左栏')
    expect(formatPaneSlotLabel(1, 2)).toBe('右栏')
    expect(formatPaneSlotLabel(1, 3)).toBe('中栏')
    expect(formatPaneBadgeShort(2, 3)).toBe('中'.length === 1 ? '右' : '')
    expect(formatPaneSlotLabel(2, 4)).toBe('栏 3')
    expect(formatPaneBadgeShort(3, 4)).toBe('4')
  })

  test('每个分栏独立保存原文/双栏/译文模式并在拖拽重排与中心替换时保留', () => {
    const panes: SplitPane[] = [
      { id: 'p1', documentId: 'doc-1', weight: 1, viewMode: 'dual' },
      { id: 'p2', documentId: 'doc-2', weight: 1 }
    ]
    expect(getPaneViewMode(panes[0])).toBe('dual')
    expect(getPaneViewMode(panes[1])).toBe('source')

    const updated = setSplitPaneViewMode(panes, 'p2', 'translation')
    expect(getPaneViewMode(updated[1])).toBe('translation')
    expect(getPaneViewMode(updated[0])).toBe('dual')

    const swapped = dropPaneOntoPane(updated, 'p1', 'p2', 'center')
    expect(swapped.map(p => `${p.id}:${getPaneViewMode(p)}`)).toEqual(['p2:translation', 'p1:dual'])

    const replaced = dropDocumentIntoPanes(swapped, 'doc-3', 'p2', 'center')
    expect(replaced[0].documentId).toBe('doc-3')
    expect(getPaneViewMode(replaced[0])).toBe('translation')

    const inserted = dropDocumentIntoPanes(replaced, 'doc-4', 'p1', 'right', () => 'p3')
    expect(inserted.map(p => `${p.id}:${getPaneViewMode(p)}`)).toEqual([
      'p2:translation',
      'p1:dual',
      'p3:source'
    ])
  })
})
