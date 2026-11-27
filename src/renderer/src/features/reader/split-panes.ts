export const DOC_DRAG_MIME = 'application/x-paperflow-doc-id'
export const PANE_DRAG_MIME = 'application/x-paperflow-pane-id'

export type SplitPaneViewMode = 'source' | 'dual' | 'translation'

export interface SplitPane {
  id: string
  documentId: string
  weight: number
  viewMode?: SplitPaneViewMode
}

export function getPaneViewMode(pane: Pick<SplitPane, 'viewMode'>): SplitPaneViewMode {
  return pane.viewMode === 'dual' || pane.viewMode === 'translation' ? pane.viewMode : 'source'
}

export function setSplitPaneViewMode(
  panes: readonly SplitPane[],
  paneId: string,
  viewMode: SplitPaneViewMode
): SplitPane[] {
  return panes.map(pane => (pane.id === paneId ? { ...pane, viewMode } : pane))
}

export type SplitDropZone = 'left' | 'center' | 'right'

export type ActiveWorkspaceDrag =
  | { kind: 'doc'; documentId: string }
  | { kind: 'pane'; paneId: string; documentId: string }

let activeWorkspaceDrag: ActiveWorkspaceDrag | null = null

export function setActiveWorkspaceDrag(drag: ActiveWorkspaceDrag | null): void {
  activeWorkspaceDrag = drag
}

export function getActiveWorkspaceDrag(): ActiveWorkspaceDrag | null {
  return activeWorkspaceDrag
}

let fallbackPaneSeq = 0

export function createSplitPaneId(): string {
  fallbackPaneSeq += 1
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pane-${crypto.randomUUID()}`
  }
  return `pane-${Date.now()}-${fallbackPaneSeq}`
}

export function computeDropZone(clientX: number, rect: { left: number; width: number }): SplitDropZone {
  if (rect.width <= 0) return 'center'
  const ratio = (clientX - rect.left) / rect.width
  if (ratio < 0.3) return 'left'
  if (ratio > 0.7) return 'right'
  return 'center'
}

export function normalizePaneWeights(panes: readonly SplitPane[]): SplitPane[] {
  return panes.map(pane => ({
    ...pane,
    weight: Number.isFinite(pane.weight) && pane.weight > 0 ? pane.weight : 1
  }))
}

export function dropDocumentIntoPanes(
  panes: readonly SplitPane[],
  documentId: string,
  targetPaneId: string,
  zone: SplitDropZone,
  makeId: () => string = createSplitPaneId
): SplitPane[] {
  if (panes.length === 0) {
    return [{ id: makeId(), documentId, weight: 1 }]
  }
  const targetIndex = panes.findIndex(p => p.id === targetPaneId)
  if (targetIndex < 0) {
    return [...panes, { id: makeId(), documentId, weight: 1 }]
  }
  if (zone === 'center') {
    return panes.map((pane, index) => (index === targetIndex ? { ...pane, documentId } : pane))
  }
  const inserted: SplitPane = { id: makeId(), documentId, weight: 1 }
  const insertAt = zone === 'left' ? targetIndex : targetIndex + 1
  const next = [...panes]
  next.splice(insertAt, 0, inserted)
  return next
}

export function dropPaneOntoPane(
  panes: readonly SplitPane[],
  sourcePaneId: string,
  targetPaneId: string,
  zone: SplitDropZone
): SplitPane[] {
  const fromIndex = panes.findIndex(p => p.id === sourcePaneId)
  const targetIndex = panes.findIndex(p => p.id === targetPaneId)
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) {
    return [...panes]
  }
  const next = [...panes]
  if (zone === 'center') {
    const temp = next[fromIndex]
    next[fromIndex] = next[targetIndex]
    next[targetIndex] = temp
    return next
  }
  const [moved] = next.splice(fromIndex, 1)
  const newTargetIndex = next.findIndex(p => p.id === targetPaneId)
  if (newTargetIndex < 0) return [...panes]
  const insertAt = zone === 'left' ? newTargetIndex : newTargetIndex + 1
  next.splice(insertAt, 0, moved)
  return next
}

export function movePaneByOffset(
  panes: readonly SplitPane[],
  paneId: string,
  delta: -1 | 1
): SplitPane[] {
  const idx = panes.findIndex(p => p.id === paneId)
  if (idx < 0) return [...panes]
  const target = idx + delta
  if (target < 0 || target >= panes.length) return [...panes]
  const next = [...panes]
  const temp = next[idx]
  next[idx] = next[target]
  next[target] = temp
  return next
}

export function closeSplitPane(panes: readonly SplitPane[], paneId: string): SplitPane[] {
  if (panes.length <= 1) return [...panes]
  const next = panes.filter(p => p.id !== paneId)
  return next.length > 0 ? next : [...panes]
}

export function formatPaneSlotLabel(index: number, total: number): string {
  if (total <= 1) return '主栏'
  if (total === 2) return index === 0 ? '左栏' : '右栏'
  if (total === 3) return index === 0 ? '左栏' : index === 1 ? '中栏' : '右栏'
  if (index === 0) return '左 1'
  if (index === total - 1) return `右 ${index + 1}`
  return `栏 ${index + 1}`
}

export function formatPaneBadgeShort(index: number, total: number): string {
  if (total <= 1) return '主'
  if (total === 2) return index === 0 ? '左' : '右'
  if (total === 3) return index === 0 ? '左' : index === 1 ? '中' : '右'
  return `${index + 1}`
}

export function describeDropAction(zone: SplitDropZone, isPaneDrag: boolean): string {
  if (zone === 'left') return '放到左侧新增一栏'
  if (zone === 'right') return '放到右侧新增一栏'
  return isPaneDrag ? '与当前栏互换位置' : '替换当前栏文献'
}
