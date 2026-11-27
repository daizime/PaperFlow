import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  hasControlCharacters,
  type CreateFolderInput,
  type DocumentRecord,
  type ExportFolderPdfsInput,
  type LibraryFolder,
  type LibrarySearchHit,
  type ReadingStatus,
  type UpdateDocumentMetaInput,
  type UpdateFolderInput
} from '../../../../shared/contracts'
import { RESEARCH_TRACK_OPTIONS, getTrackById } from '../../../../shared/research-onboarding'
import { FolderSettingsModal } from './FolderSettingsModal'
import { DOC_DRAG_MIME, setActiveWorkspaceDrag } from '../reader/split-panes'
import { FolderMoveIcon, FolderTreeIcon, SettingsIcon, SplitIcon } from '../../components/UiIcons'
import { formatDocumentTitle, type ImportFailureDetail } from './useLibrary'
import './library.css'

interface Props {
  documents: DocumentRecord[]
  folders?: LibraryFolder[]
  activeFolderId?: string | null
  readerProgress?: Record<string, number>
  recommendedTags?: string[]
  selectedId?: string
  secondarySelectedId?: string
  openPaneLabels?: Record<string, string>
  translatingPagesByDocId?: Readonly<Record<string, number>>
  viewedDocuments?: Array<{ document: DocumentRecord; paneLabel?: string }>
  importing: boolean
  error: string | null
  errorDetails: ImportFailureDetail[]
  loading: boolean
  loadError: string | null
  notice: string | null
  onImport(): void
  onImportFolder?(parentFolderId?: string | null): void
  onSelect(id: string): void
  onOpenInSplit?(id: string): void
  onSelectFolder?(folderId: string | null): void
  onOpenFolderSettings?(folderId: string): void
  onCreateFolder?(input: CreateFolderInput): Promise<LibraryFolder | null>
  onUpdateFolder?(input: UpdateFolderInput): Promise<LibraryFolder | null>
  onDeleteFolder?(folderId: string): Promise<boolean>
  onRename(id: string, displayTitle: string): Promise<boolean>
  onAutoDetectTitle?(document: DocumentRecord): Promise<void>
  onUpdateMeta?(input: UpdateDocumentMetaInput): Promise<boolean>
  onBatchMoveToFolder?(documentIds: string[], folderId: string | null): Promise<void>
  onBatchAddTag?(documentIds: string[], tag: string): Promise<void>
  onJumpToSearchHit?(documentId: string, pageNumber: number | null): void
  onDelete(id: string): Promise<boolean>
  onResetLibrary?(): Promise<boolean>
  onOpenLiteratureSearch?(preset?: { query?: string; tags?: string[] }): void
  backingUp?: boolean
  onExportBackup?(): void
  onImportBackup?(): void
  onExportFolderPdfs?(input: ExportFolderPdfsInput): void
  onExportFolderBibtex?(input: { scope: 'all' | 'unassigned' | 'folder'; folderId?: string }): void
  exportIncludeNotes?: boolean
  onToggleExportIncludeNotes?(checked: boolean): void
  onDismissError(): void
  onDismissNotice?(): void
  onReportError(message: string): void
  onRetry(): void
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`
}

const SOURCE_LABELS: Record<LibrarySearchHit['source'], string> = {
  document: '文献',
  annotation: '批注',
  translation: '译文'
}

const READING_STATUS_META: Record<ReadingStatus, { label: string; next: ReadingStatus }> = {
  unread: { label: '待读', next: 'reading' },
  reading: { label: '在读', next: 'done' },
  done: { label: '已读', next: 'unread' }
}

interface FolderNode {
  folder: LibraryFolder
  depth: number
  children: FolderNode[]
}

function buildFolderTree(folders: readonly LibraryFolder[]): {
  roots: FolderNode[]
  folderById: Map<string, LibraryFolder>
  descendantsById: Map<string, Set<string>>
  flatOrder: Array<{ folder: LibraryFolder; depth: number }>
} {
  const folderById = new Map(folders.map(f => [f.id, f]))
  const childrenMap = new Map<string | null, LibraryFolder[]>()
  for (const f of folders) {
    const parentKey = f.parentId && folderById.has(f.parentId) ? f.parentId : null
    const list = childrenMap.get(parentKey)
    if (list) list.push(f)
    else childrenMap.set(parentKey, [f])
  }

  const descendantsById = new Map<string, Set<string>>()
  const flatOrder: Array<{ folder: LibraryFolder; depth: number }> = []

  const buildNode = (folder: LibraryFolder, depth: number, visited: Set<string>): FolderNode => {
    flatOrder.push({ folder, depth })
    const rawChildren = childrenMap.get(folder.id) ?? []
    const childNodes: FolderNode[] = []
    const descSet = new Set<string>([folder.id])
    for (const child of rawChildren) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      const childNode = buildNode(child, depth + 1, visited)
      childNodes.push(childNode)
      for (const id of descendantsById.get(child.id) ?? []) {
        descSet.add(id)
      }
    }
    descendantsById.set(folder.id, descSet)
    return { folder, depth, children: childNodes }
  }

  const roots = (childrenMap.get(null) ?? []).map(root => buildNode(root, 0, new Set([root.id])))
  return { roots, folderById, descendantsById, flatOrder }
}

export function LibraryPanel({
  documents,
  folders = [],
  activeFolderId = null,
  readerProgress = {},
  recommendedTags = [],
  selectedId,
  secondarySelectedId,
  openPaneLabels,
  translatingPagesByDocId,
  viewedDocuments,
  importing,
  error,
  errorDetails,
  loading,
  loadError,
  notice,
  onImport,
  onImportFolder,
  onSelect,
  onOpenInSplit,
  onSelectFolder,
  onOpenFolderSettings,
  onCreateFolder,
  onUpdateFolder,
  onDeleteFolder,
  onRename,
  onAutoDetectTitle,
  onUpdateMeta,
  onBatchMoveToFolder,
  onBatchAddTag,
  onJumpToSearchHit,
  onDelete,
  onResetLibrary,
  onOpenLiteratureSearch,
  backingUp = false,
  onExportBackup,
  onImportBackup,
  onExportFolderPdfs,
  onExportFolderBibtex,
  exportIncludeNotes: controlledExportNotes,
  onToggleExportIncludeNotes,
  onDismissError,
  onDismissNotice,
  onReportError,
  onRetry
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [starOnly, setStarOnly] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | ReadingStatus>('all')
  const [sortBy, setSortBy] = useState<'imported-desc' | 'title-asc' | 'progress-desc'>('imported-desc')
  const [filterOpen, setFilterOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [currentCollapsed, setCurrentCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('paperflow:current-viewing-collapsed') === 'true'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('paperflow:current-viewing-collapsed', currentCollapsed ? 'true' : 'false')
    } catch {
      // 忽略存储配额限制
    }
  }, [currentCollapsed])
  const [currentHeightPx, setCurrentHeightPx] = useState<number | null>(null)
  const [toastHovered, setToastHovered] = useState(false)
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(() => new Set())
  const [batchFolderTarget, setBatchFolderTarget] = useState<string>('__unassigned__')
  const [batchTagDraft, setBatchTagDraft] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  const [localExportNotes, setLocalExportNotes] = useState(true)
  const exportIncludeNotes = controlledExportNotes ?? localExportNotes
  const setExportIncludeNotes = (checked: boolean): void => {
    setLocalExportNotes(checked)
    onToggleExportIncludeNotes?.(checked)
  }
  const [crossHits, setCrossHits] = useState<LibrarySearchHit[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [taggingId, setTaggingId] = useState<string | null>(null)
  const [draftTag, setDraftTag] = useState('')
  const [movingId, setMovingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [actionSource, setActionSource] = useState<'tree' | 'current'>('current')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [creatingParentId, setCreatingParentId] = useState<string | null | undefined>(undefined)
  const [draftFolderName, setDraftFolderName] = useState('')
  const [draftFolderTrackId, setDraftFolderTrackId] = useState('')
  const [creatingFolderBusy, setCreatingFolderBusy] = useState(false)
  const [settingsFolderId, setSettingsFolderId] = useState<string | null>(null)
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const currentResizeRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const { roots: folderRoots, folderById, descendantsById, flatOrder } = useMemo(
    () => buildFolderTree(folders),
    [folders]
  )

  const effectiveFolderFilter =
    activeFolderId === 'unassigned'
      ? 'unassigned'
      : activeFolderId && folderById.has(activeFolderId)
        ? activeFolderId
        : null

  const activeUserFolder =
    effectiveFolderFilter && effectiveFolderFilter !== 'unassigned'
      ? folderById.get(effectiveFolderFilter) ?? null
      : null

  const folderSubtreeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const [id, set] of descendantsById.entries()) {
      let total = 0
      for (const doc of documents) {
        if (doc.folderId && set.has(doc.folderId)) total += 1
      }
      counts.set(id, total)
    }
    return counts
  }, [descendantsById, documents])

  const unassignedCount = useMemo(
    () => documents.filter(doc => !doc.folderId || !folderById.has(doc.folderId)).length,
    [documents, folderById]
  )

  const allTags = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const doc of documents) {
      for (const tag of doc.tags ?? []) {
        const key = tag.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          list.push(tag)
        }
      }
    }
    return list
  }, [documents])

  const effectiveTagFilter =
    selectedTag && allTags.some(t => t.toLowerCase() === selectedTag.toLowerCase()) ? selectedTag : null

  const searchTerm = query.trim().toLocaleLowerCase()
  const matchesFilterAndSearch = useMemo(() => {
    return (document: DocumentRecord): boolean => {
      if (starOnly && !document.starred) return false
      if (statusFilter !== 'all' && (document.readingStatus ?? 'unread') !== statusFilter) return false
      if (effectiveTagFilter && !(document.tags ?? []).some(t => t.toLowerCase() === effectiveTagFilter.toLowerCase())) {
        return false
      }
      if (!searchTerm) return true
      const inTitle =
        document.originalFilename.toLocaleLowerCase().includes(searchTerm) ||
        document.displayTitle.toLocaleLowerCase().includes(searchTerm)
      const inTags = (document.tags ?? []).some(t => t.toLocaleLowerCase().includes(searchTerm))
      return inTitle || inTags
    }
  }, [starOnly, statusFilter, effectiveTagFilter, searchTerm])

  const treeMatchingDocuments = useMemo(() => {
    const filtered = documents.filter(matchesFilterAndSearch)
    if (sortBy === 'title-asc') {
      filtered.sort((a, b) => formatDocumentTitle(a).localeCompare(formatDocumentTitle(b), 'zh-Hans-CN'))
    } else if (sortBy === 'progress-desc') {
      filtered.sort((a, b) => {
        const ra = a.pageCount ? (readerProgress[a.id] ?? 0) / a.pageCount : -1
        const rb = b.pageCount ? (readerProgress[b.id] ?? 0) / b.pageCount : -1
        if (rb !== ra) return rb - ra
        return b.importedAt.localeCompare(a.importedAt)
      })
    } else {
      filtered.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    }
    return filtered
  }, [documents, matchesFilterAndSearch, sortBy, readerProgress])

  const docsByFolderMap = useMemo(() => {
    const byFolder = new Map<string, DocumentRecord[]>()
    const unassignedList: DocumentRecord[] = []
    for (const doc of treeMatchingDocuments) {
      if (doc.folderId && folderById.has(doc.folderId)) {
        const list = byFolder.get(doc.folderId)
        if (list) list.push(doc)
        else byFolder.set(doc.folderId, [doc])
      } else {
        unassignedList.push(doc)
      }
    }
    return { byFolder, unassignedList }
  }, [treeMatchingDocuments, folderById])

  const visibleDocuments = useMemo(() => {
    return treeMatchingDocuments.filter(document => {
      if (effectiveFolderFilter === 'unassigned') {
        if (document.folderId && folderById.has(document.folderId)) return false
      } else if (effectiveFolderFilter) {
        const allowedSet = descendantsById.get(effectiveFolderFilter)
        if (!document.folderId || !allowedSet?.has(document.folderId)) return false
      }
      return true
    })
  }, [treeMatchingDocuments, effectiveFolderFilter, folderById, descendantsById])

  const sortedVisibleDocuments = visibleDocuments

  const currentViewedEntries = useMemo((): Array<{ document: DocumentRecord; paneLabel?: string }> => {
    if (viewedDocuments) {
      return viewedDocuments.filter(item => Boolean(item.document))
    }
    const primary = documents.find(doc => doc.id === selectedId) ?? null
    return primary ? [{ document: primary }] : []
  }, [viewedDocuments, documents, selectedId])

  const validSelectedBatchIds = useMemo(() => {
    const docIdSet = new Set(documents.map(d => d.id))
    return Array.from(selectedBatchIds).filter(id => docIdSet.has(id))
  }, [documents, selectedBatchIds])

  // 工具栏同样能发起导入；清除旧搜索和标签/收藏过滤，确保新导入项在当前分类下立即可见。
  useEffect(() => {
    if (notice && !importing) {
      setQuery('')
      setStarOnly(false)
      setSelectedTag(null)
      setStatusFilter('all')
    }
  }, [importing, notice])

  // 全库检索（批注、笔记与已缓存译文）
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2 || documents.length === 0) {
      setCrossHits([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.paperflow
        .searchLibrary(trimmed)
        .then(hits => {
          if (!cancelled) {
            setCrossHits(hits.filter(hit => hit.source === 'annotation' || hit.source === 'translation'))
          }
        })
        .catch(() => {
          if (!cancelled) setCrossHits([])
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, documents.length])

  const activeEditingId = documents.some(document => document.id === editingId) ? editingId : null
  const activeConfirmDeleteId = documents.some(document => document.id === confirmDeleteId) ? confirmDeleteId : null
  const activeTaggingId = documents.some(document => document.id === taggingId) ? taggingId : null
  const activeMovingId = documents.some(document => document.id === movingId) ? movingId : null
  const settingsFolder = settingsFolderId ? folderById.get(settingsFolderId) ?? null : null

  useEffect(() => {
    if (!activeEditingId) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [activeEditingId])

  const visibleNotice = !importing && notice && dismissedNotice !== notice ? notice : null
  const activeFilterCount =
    (starOnly ? 1 : 0) +
    (statusFilter !== 'all' ? 1 : 0) +
    (effectiveTagFilter ? 1 : 0) +
    (sortBy !== 'imported-desc' ? 1 : 0)

  const handleDismissToast = useCallback((): void => {
    setToastHovered(false)
    setDismissedNotice(notice)
    onDismissNotice?.()
  }, [notice, onDismissNotice])

  useEffect(() => {
    setDismissedNotice(null)
    setToastHovered(false)
  }, [notice])

  useEffect(() => {
    if (!visibleNotice || toastHovered) return
    const timer = window.setTimeout(() => {
      handleDismissToast()
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [visibleNotice, toastHovered, handleDismissToast])

  useEffect(() => {
    if (!filterOpen && !moreMenuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (panelRef.current?.querySelector('.library-popover-anchor')?.contains(target)) {
        return
      }
      setFilterOpen(false)
      setMoreMenuOpen(false)
      setConfirmingReset(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setFilterOpen(false)
        setMoreMenuOpen(false)
        setConfirmingReset(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [filterOpen, moreMenuOpen])

  const handleCurrentResizerPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const section = panelRef.current?.querySelector<HTMLElement>('.library-current-list')
    const startHeight = section?.getBoundingClientRect().height ?? 140
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.classList.add('is-dragging')
    currentResizeRef.current = { startY: event.clientY, startHeight }
  }

  const handleCurrentResizerPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = currentResizeRef.current
    if (!drag) return
    const nextHeight = Math.max(72, Math.min(280, Math.round(drag.startHeight + (drag.startY - event.clientY))))
    setCurrentCollapsed(false)
    setCurrentHeightPx(nextHeight)
  }

  const handleCurrentResizerPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!currentResizeRef.current) return
    currentResizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.currentTarget.classList.remove('is-dragging')
  }

  function startRename(document: DocumentRecord): void {
    setConfirmDeleteId(null)
    setTaggingId(null)
    setMovingId(null)
    setEditingId(document.id)
    setDraftTitle(document.displayTitle)
  }

  function cancelRename(): void {
    setEditingId(null)
    setDraftTitle('')
  }

  async function submitRename(id: string): Promise<void> {
    if (busyId === id) return
    const trimmed = draftTitle.trim()
    if (!trimmed) {
      onReportError('文献标题不能为空。')
      return
    }
    if (trimmed.length > 200) {
      onReportError('文献标题长度不能超过 200 个字符。')
      return
    }
    if (hasControlCharacters(trimmed)) {
      onReportError('文献标题不能包含控制字符。')
      return
    }
    setBusyId(id)
    try {
      const ok = await onRename(id, trimmed)
      if (ok) {
        setEditingId(null)
        setDraftTitle('')
      }
    } finally {
      setBusyId(current => (current === id ? null : current))
    }
  }

  async function handleAddTag(document: DocumentRecord): Promise<void> {
    if (!onUpdateMeta || busyId === document.id) return
    const clean = draftTag.trim()
    if (!clean) {
      setTaggingId(null)
      return
    }
    if (clean.length > 32 || hasControlCharacters(clean)) {
      onReportError('标签长度需为 1-32 个字符，且不能包含控制字符。')
      return
    }
    setBusyId(document.id)
    try {
      const nextTags = [...(document.tags ?? []), clean]
      const ok = await onUpdateMeta({ documentId: document.id, tags: nextTags })
      if (ok) {
        setDraftTag('')
        setTaggingId(null)
      }
    } finally {
      setBusyId(current => (current === document.id ? null : current))
    }
  }

  async function handleRemoveTag(document: DocumentRecord, tag: string): Promise<void> {
    if (!onUpdateMeta || busyId === document.id) return
    setBusyId(document.id)
    try {
      const nextTags = (document.tags ?? []).filter(item => item.toLowerCase() !== tag.toLowerCase())
      await onUpdateMeta({ documentId: document.id, tags: nextTags })
    } finally {
      setBusyId(current => (current === document.id ? null : current))
    }
  }

  async function handleMoveToFolder(documentId: string, folderId: string | null): Promise<void> {
    if (!onUpdateMeta || busyId === documentId) return
    setBusyId(documentId)
    try {
      const ok = await onUpdateMeta({ documentId, folderId })
      if (ok) {
        setMovingId(null)
      }
    } finally {
      setBusyId(current => (current === documentId ? null : current))
    }
  }

  function startDeleteConfirm(id: string): void {
    setEditingId(null)
    setTaggingId(null)
    setMovingId(null)
    setDraftTitle('')
    setConfirmDeleteId(id)
  }

  async function submitDelete(id: string): Promise<void> {
    if (busyId === id) return
    setBusyId(id)
    try {
      const ok = await onDelete(id)
      if (ok) setConfirmDeleteId(current => (current === id ? null : current))
    } finally {
      setBusyId(current => (current === id ? null : current))
    }
  }

  async function submitCreateFolder(): Promise<void> {
    if (!onCreateFolder || creatingFolderBusy) return
    const name = draftFolderName.trim()
    if (!name) {
      onReportError('分类名称不能为空。')
      return
    }
    setCreatingFolderBusy(true)
    try {
      const track = draftFolderTrackId ? getTrackById(draftFolderTrackId) : undefined
      const created = await onCreateFolder({
        parentId: creatingParentId ?? null,
        name,
        facultyId: track?.facultyId ?? '',
        contextSummary: track ? `${track.name}（${track.summary}）`.slice(0, 300) : '',
        glossary: track ? [...track.starterGlossary] : [],
        inheritGlobalGlossary: false
      })
      if (created) {
        if (creatingParentId) {
          setCollapsedFolders(prev => {
            const next = new Set(prev)
            next.delete(creatingParentId)
            return next
          })
        }
        setCreatingParentId(undefined)
        setDraftFolderName('')
        setDraftFolderTrackId('')
        onSelectFolder?.(created.id)
      }
    } finally {
      setCreatingFolderBusy(false)
    }
  }

  function toggleFolderCollapse(folderId: string): void {
    setCollapsedFolders(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  function handleFolderDragOver(event: DragEvent<HTMLElement>, key: string): void {
    if (!event.dataTransfer.types.includes(DOC_DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetKey(key)
  }

  function handleFolderDrop(event: DragEvent<HTMLElement>, targetFolderId: string | null): void {
    if (!event.dataTransfer.types.includes(DOC_DRAG_MIME)) return
    event.preventDefault()
    event.stopPropagation()
    setDropTargetKey(null)
    const documentId = event.dataTransfer.getData(DOC_DRAG_MIME)
    if (documentId) {
      void handleMoveToFolder(documentId, targetFolderId)
    }
  }

  function renderMoveFolderPanel(document: DocumentRecord, compact = false): React.JSX.Element {
    const isBusy = busyId === document.id
    return (
      <div
        className={`document-actions document-move-folder-panel${compact ? ' is-tree-inline' : ''}`}
        role="group"
        aria-label="选择目标分类文件夹"
      >
        <div className="document-move-folder-panel__title">归类到文件夹：</div>
        <div className="document-move-folder-panel__options">
          <button
            type="button"
            className={!document.folderId ? 'is-current' : undefined}
            data-testid={`move-to-unassigned-${document.id}`}
            disabled={isBusy}
            onClick={() => void handleMoveToFolder(document.id, null)}
          >
            未分类
          </button>
          {flatOrder.map(({ folder, depth }) => (
            <button
              key={folder.id}
              type="button"
              className={document.folderId === folder.id ? 'is-current' : undefined}
              data-testid={`move-to-folder-${folder.id}`}
              disabled={isBusy}
              onClick={() => void handleMoveToFolder(document.id, folder.id)}
            >
              {depth > 0 ? `${'·'.repeat(depth)} ` : ''}
              {folder.name}
            </button>
          ))}
          <button type="button" disabled={isBusy} onClick={() => setMovingId(null)}>
            关闭
          </button>
        </div>
      </div>
    )
  }

  function renderTreeDocRow(doc: DocumentRecord, depth: number): React.JSX.Element {
    const isPrimary = selectedId === doc.id
    const explicitBadge = openPaneLabels?.[doc.id]
    const isSecondary = secondarySelectedId === doc.id || Boolean(explicitBadge)
    const isBusy = busyId === doc.id
    const isMoving = activeMovingId === doc.id && actionSource === 'tree'
    const isConfirmingDelete = activeConfirmDeleteId === doc.id && actionSource === 'tree'
    const isBatchChecked = selectedBatchIds.has(doc.id)
    const paneBadge =
      explicitBadge ??
      (isPrimary && secondarySelectedId === doc.id
        ? '双开'
        : isPrimary && secondarySelectedId
          ? '左'
          : secondarySelectedId === doc.id
            ? '右'
            : isPrimary
              ? '当前'
              : null)

    return (
      <div key={doc.id} className="library-tree-doc-wrap">
        <div
          className={`library-tree-doc${isPrimary ? ' is-active' : ''}${isSecondary && !isPrimary ? ' is-secondary' : ''}${
            batchMode && isBatchChecked ? ' is-batch-selected' : ''
          }`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          data-testid={`tree-doc-${doc.id}`}
          data-tree-document-id={doc.id}
          draggable={Boolean(onUpdateMeta) && !batchMode}
          onDragStart={event => {
            event.dataTransfer.setData(DOC_DRAG_MIME, doc.id)
            event.dataTransfer.effectAllowed = 'move'
            setActiveWorkspaceDrag({ kind: 'doc', documentId: doc.id })
          }}
          onDragEnd={() => setActiveWorkspaceDrag(null)}
        >
          {batchMode ? (
            <input
              type="checkbox"
              className="document-batch-checkbox"
              data-testid={`doc-batch-check-${doc.id}`}
              aria-label={`选择 ${doc.originalFilename}`}
              checked={isBatchChecked}
              onChange={() => {
                setSelectedBatchIds(prev => {
                  const next = new Set(prev)
                  if (next.has(doc.id)) next.delete(doc.id)
                  else next.add(doc.id)
                  return next
                })
              }}
            />
          ) : null}
          <button
            type="button"
            className="library-tree-doc-btn"
            aria-pressed={isPrimary || isSecondary}
            onClick={() => {
              if (batchMode) {
                setSelectedBatchIds(prev => {
                  const next = new Set(prev)
                  if (next.has(doc.id)) next.delete(doc.id)
                  else next.add(doc.id)
                  return next
                })
                return
              }
              onSelect(doc.id)
            }}
          >
            <span className="library-tree-doc-badge" aria-hidden="true">
              PDF
            </span>
            <span className="library-tree-doc-title" title={doc.originalFilename}>
              {formatDocumentTitle(doc)}
            </span>
            {doc.starred ? (
              <span className="library-tree-doc-star" title="已收藏" aria-hidden="true">
                ★
              </span>
            ) : null}
            {paneBadge ? <span className="library-tree-doc-pane">{paneBadge}</span> : null}
            {translatingPagesByDocId?.[doc.id] ? (
              <span
                className="library-translating-pill"
                data-testid={`library-doc-translating-${doc.id}`}
                title={`正在后台翻译第 ${translatingPagesByDocId[doc.id]} 页`}
              >
                译中
              </span>
            ) : null}
          </button>
          {onUpdateMeta ? (
            (() => {
              const currentStatus: ReadingStatus = doc.readingStatus ?? 'unread'
              const info = READING_STATUS_META[currentStatus]
              return (
                <button
                  type="button"
                  className={`library-status-pill is-${currentStatus}`}
                  data-testid={`doc-status-btn-${doc.id}`}
                  data-reading-status={currentStatus}
                  title={`阅读状态：${info.label}（点击切换为「${READING_STATUS_META[info.next].label}」）`}
                  aria-label={`切换 ${doc.originalFilename} 阅读状态，当前 ${info.label}`}
                  disabled={importing || isBusy}
                  onClick={event => {
                    event.stopPropagation()
                    void onUpdateMeta({ documentId: doc.id, readingStatus: info.next })
                  }}
                >
                  {info.label}
                </button>
              )
            })()
          ) : null}
          <div className="library-tree-doc-actions" role="group" aria-label="树中文献操作">
            {onOpenInSplit ? (
              <button
                type="button"
                className="library-folder-icon-btn"
                data-testid={`tree-doc-split-${doc.id}`}
                title="在右侧并排双开对比"
                aria-label={`并排双开 ${doc.originalFilename}`}
                disabled={importing || isBusy}
                onClick={event => {
                  event.stopPropagation()
                  onOpenInSplit(doc.id)
                }}
              >
                <SplitIcon size={13} />
              </button>
            ) : null}
            {onAutoDetectTitle ? (
              <button
                type="button"
                className="library-folder-icon-btn"
                data-testid={`tree-doc-auto-title-${doc.id}`}
                title="识别论文标题"
                aria-label={`识别 ${doc.originalFilename} 标题`}
                disabled={importing || isBusy}
                onClick={event => {
                  event.stopPropagation()
                  setBusyId(doc.id)
                  void onAutoDetectTitle(doc).finally(() => {
                    setBusyId(current => (current === doc.id ? null : current))
                  })
                }}
              >
                T
              </button>
            ) : null}
            {onUpdateMeta ? (
              <button
                type="button"
                className="library-folder-icon-btn"
                data-testid={`tree-doc-move-${doc.id}`}
                title="移动到分类文件夹"
                aria-label={`移动 ${doc.originalFilename} 到分类`}
                disabled={importing || isBusy}
                onClick={event => {
                  event.stopPropagation()
                  setEditingId(null)
                  setTaggingId(null)
                  setConfirmDeleteId(null)
                  const toggleOff = movingId === doc.id && actionSource === 'tree'
                  setActionSource('tree')
                  setMovingId(toggleOff ? null : doc.id)
                }}
              >
                <FolderMoveIcon size={13} />
              </button>
            ) : null}
            <button
              type="button"
              className="library-folder-icon-btn library-folder-icon-btn--danger"
              data-testid={`tree-doc-delete-${doc.id}`}
              title="删除文献"
              aria-label={`从库删除 ${doc.originalFilename}`}
              disabled={importing || isBusy}
              onClick={event => {
                event.stopPropagation()
                setEditingId(null)
                setTaggingId(null)
                setMovingId(null)
                setActionSource('tree')
                setConfirmDeleteId(doc.id)
              }}
            >
              ×
            </button>
          </div>
        </div>
        {isMoving ? renderMoveFolderPanel(doc, true) : null}
        {isConfirmingDelete ? (
          <div className="document-actions document-confirm-delete is-tree-inline">
            <span>确认从文献库删除？</span>
            <div className="document-action-buttons">
              <button
                type="button"
                className="document-action-danger"
                aria-label="确认删除"
                disabled={isBusy}
                onClick={() => void submitDelete(doc.id)}
              >
                确认删除
              </button>
              <button type="button" disabled={isBusy} onClick={() => setConfirmDeleteId(null)}>
                取消
              </button>
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  function renderFolderNode(node: FolderNode): React.JSX.Element {
    const { folder, depth, children } = node
    const directDocs = docsByFolderMap.byFolder.get(folder.id) ?? []
    const hasChildren = children.length > 0 || directDocs.length > 0
    const isCollapsed = collapsedFolders.has(folder.id)
    const isSelected = effectiveFolderFilter === folder.id
    const subtreeCount = folderSubtreeCounts.get(folder.id) ?? 0
    const isDropTarget = dropTargetKey === folder.id

    return (
      <div key={folder.id} className="library-folder-branch">
        <div
          className={`library-folder-row${isSelected ? ' is-active' : ''}${isDropTarget ? ' is-drop-target' : ''}`}
          data-testid={`folder-row-${folder.id}`}
          style={{ paddingLeft: `${6 + depth * 12}px` }}
          onDragOver={event => handleFolderDragOver(event, folder.id)}
          onDragLeave={() => {
            if (dropTargetKey === folder.id) setDropTargetKey(null)
          }}
          onDrop={event => handleFolderDrop(event, folder.id)}
        >
          {hasChildren ? (
            <button
              type="button"
              className="library-folder-caret"
              aria-label={isCollapsed ? `展开 ${folder.name}` : `收起 ${folder.name}`}
              aria-expanded={!isCollapsed}
              onClick={() => toggleFolderCollapse(folder.id)}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="library-folder-caret-spacer" aria-hidden="true">
              •
            </span>
          )}
          <button
            type="button"
            className="library-folder-btn"
            data-testid={`folder-select-${folder.id}`}
            aria-pressed={isSelected}
            onClick={() => {
              setCollapsedFolders(prev => {
                if (!prev.has(folder.id)) return prev
                const next = new Set(prev)
                next.delete(folder.id)
                return next
              })
              onSelectFolder?.(folder.id)
            }}
          >
            <span className="library-folder-name" title={folder.name}>
              {folder.name}
            </span>
            {folder.glossary.length > 0 ? (
              <span className="library-folder-glossary-badge" title={`专属术语 ${folder.glossary.length} 条`}>
                {folder.glossary.length}词
              </span>
            ) : null}
            <span className="library-folder-count">{subtreeCount}</span>
          </button>
          <div className="library-folder-actions">
            {onCreateFolder && depth < 3 ? (
              <button
                type="button"
                className="library-folder-icon-btn"
                data-testid={`folder-add-child-${folder.id}`}
                title="新建子分类"
                aria-label={`在 ${folder.name} 下新建子分类`}
                onClick={event => {
                  event.stopPropagation()
                  setTreeCollapsed(false)
                  setCreatingParentId(folder.id)
                  setDraftFolderName('')
                }}
              >
                +
              </button>
            ) : null}
            {onUpdateFolder ? (
              <button
                type="button"
                className="library-folder-icon-btn"
                data-testid={`folder-settings-${folder.id}`}
                title="编辑分类与专属术语表"
                aria-label={`设置 ${folder.name} 术语表与分类`}
                onClick={event => {
                  event.stopPropagation()
                  if (onOpenFolderSettings) onOpenFolderSettings(folder.id)
                  else setSettingsFolderId(folder.id)
                }}
              >
                <SettingsIcon size={13} />
              </button>
            ) : null}
          </div>
        </div>
        {hasChildren && !isCollapsed ? (
          <div className="library-folder-children">
            {children.map(child => renderFolderNode(child))}
            {directDocs.map(doc => renderTreeDocRow(doc, depth + 1))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <aside ref={panelRef} className="library-panel" aria-label="文献库">
      <div className="library-popover-anchor">
        <div className="library-heading">
          <div className="library-heading__title">
            <h2>我的文献</h2>
          </div>
          <div className="library-heading__actions">
            {onOpenLiteratureSearch ? (
              <button
                type="button"
                className="library-ai-search-btn"
                data-testid="open-literature-search-btn"
                title="AI 主动联网检索开放获取文献与按标签发现"
                onClick={() =>
                  onOpenLiteratureSearch({
                    ...(query.trim() ? { query: query.trim() } : {}),
                    ...(effectiveTagFilter ? { tags: [effectiveTagFilter] } : {})
                  })
                }
              >
                AI 搜文献
              </button>
            ) : null}
            <button
              type="button"
              className="library-import-compact-btn"
              onClick={onImport}
              disabled={importing}
              aria-label="导入 PDF"
              title={activeUserFolder ? `导入 PDF 到「${activeUserFolder.name}」` : '导入 PDF 到本机文献库'}
            >
              {importing ? '导入中…' : '+ 导入'}
            </button>
            {onExportFolderPdfs || onExportFolderBibtex || onExportBackup || onImportBackup || onResetLibrary ? (
              <button
                type="button"
                className={moreMenuOpen ? 'library-more-btn is-active' : 'library-more-btn'}
                data-testid="library-more-menu-btn"
                aria-label="更多文献库操作"
                aria-expanded={moreMenuOpen}
                title="目录导出、引用导出、一键备份与重置文献库"
                onClick={() => {
                  setFilterOpen(false)
                  setMoreMenuOpen(open => !open)
                  setConfirmingReset(false)
                }}
              >
                ⋯
              </button>
            ) : null}
          </div>
        </div>

        <div className="library-search">
          <div className="library-search-row">
            <div className="library-search-field">
              <input
                id="library-search-input"
                type="search"
                aria-label="搜索文献"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索标题、标签、批注或译文"
                autoComplete="off"
                spellCheck={false}
                disabled={documents.length === 0}
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">
                  清空
                </button>
              )}
            </div>
            {documents.length > 0 ? (
              <button
                type="button"
                className={
                  filterOpen || activeFilterCount > 0 || batchMode
                    ? 'library-filter-trigger is-active'
                    : 'library-filter-trigger'
                }
                data-testid="library-filter-toggle"
                aria-label="筛选与排序"
                aria-expanded={filterOpen}
                onClick={() => {
                  setMoreMenuOpen(false)
                  setFilterOpen(open => !open)
                }}
              >
                筛选{activeFilterCount > 0 ? `(${activeFilterCount})` : ''}
              </button>
            ) : null}
          </div>
        </div>

        {/* 浮层 1：筛选、标签、排序与批量整理开关（0px 固定占位） */}
        {filterOpen && documents.length > 0 ? (
          <div className="library-popover" data-testid="library-filter-popover" role="dialog" aria-label="文献筛选与排序">
            <div className="library-filters" role="group" aria-label="文献筛选">
              <button
                type="button"
                className={!starOnly && statusFilter === 'all' && !effectiveTagFilter ? 'is-active' : undefined}
                onClick={() => {
                  setStarOnly(false)
                  setStatusFilter('all')
                  setSelectedTag(null)
                  onSelectFolder?.(null)
                }}
              >
                全部
              </button>
              <button
                type="button"
                className={starOnly ? 'is-active' : undefined}
                aria-pressed={starOnly}
                onClick={() => setStarOnly(prev => !prev)}
              >
                ★ 收藏
              </button>
              {allTags.map(tag => (
                <button
                  key={tag}
                  type="button"
                  className={effectiveTagFilter?.toLowerCase() === tag.toLowerCase() ? 'is-active' : undefined}
                  onClick={() =>
                    setSelectedTag(curr => (curr?.toLowerCase() === tag.toLowerCase() ? null : tag))
                  }
                >
                  #{tag}
                </button>
              ))}
            </div>
            <div className="library-filters library-filters--status" role="group" aria-label="按阅读状态筛选">
              {(['all', 'unread', 'reading', 'done'] as const).map(status => {
                const label = status === 'all' ? '全部状态' : READING_STATUS_META[status].label
                return (
                  <button
                    key={status}
                    type="button"
                    data-testid={`library-status-filter-${status}`}
                    className={statusFilter === status ? 'is-active' : undefined}
                    aria-pressed={statusFilter === status}
                    onClick={() => setStatusFilter(status)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            {onOpenLiteratureSearch && allTags.length > 0 ? (
              <div className="library-tag-search-row">
                <button
                  type="button"
                  className="library-tag-search-btn"
                  data-testid="search-related-by-tag-btn"
                  onClick={() => {
                    const targetTags = effectiveTagFilter ? [effectiveTagFilter] : allTags.slice(0, 3)
                    setFilterOpen(false)
                    onOpenLiteratureSearch({ tags: targetTags })
                  }}
                >
                  {effectiveTagFilter
                    ? `按标签 #${effectiveTagFilter} 搜相关文献`
                    : '按已有标签 AI 搜相关文献'}
                </button>
              </div>
            ) : null}
            <div className="library-sort-batch-row">
              <select
                className="library-sort-select"
                data-testid="library-sort-select"
                aria-label="文献排序方式"
                value={sortBy}
                onChange={event =>
                  setSortBy(event.target.value as 'imported-desc' | 'title-asc' | 'progress-desc')
                }
              >
                <option value="imported-desc">最近导入</option>
                <option value="title-asc">标题 A-Z</option>
                <option value="progress-desc">阅读进度</option>
              </select>
              {onUpdateMeta ? (
                <button
                  type="button"
                  className={batchMode ? 'library-batch-toggle is-active' : 'library-batch-toggle'}
                  data-testid="library-batch-toggle"
                  aria-pressed={batchMode}
                  onClick={() => {
                    setBatchMode(prev => {
                      const next = !prev
                      if (!next) setSelectedBatchIds(new Set())
                      else setFilterOpen(false)
                      return next
                    })
                  }}
                >
                  {batchMode ? '完成整理' : '批量整理'}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 浮层 2：导出目录、附带批注、备份、恢复与重置库（0px 固定占位） */}
        {moreMenuOpen ? (
          <div className="library-popover library-popover--menu" data-testid="library-more-popover" role="dialog" aria-label="文献库更多操作">
            {onExportFolderPdfs || onExportFolderBibtex ? (
              <div className="library-popover__section">
                {onExportFolderBibtex ? (
                  <button
                    type="button"
                    className="library-popover__item"
                    data-testid="library-export-all-bib-btn"
                    disabled={backingUp || importing || documents.length === 0}
                    onClick={() => {
                      setMoreMenuOpen(false)
                      onExportFolderBibtex({ scope: 'all' })
                    }}
                  >
                    导出全部引用 (.bib)
                  </button>
                ) : null}
                {onExportFolderPdfs ? (
                  <>
                    <button
                      type="button"
                      className="library-popover__item"
                      data-testid="folder-export-all-btn"
                      disabled={backingUp || importing || (documents.length === 0 && folders.length === 0)}
                      onClick={() => {
                        setMoreMenuOpen(false)
                        onExportFolderPdfs({ scope: 'all', includeAnnotations: exportIncludeNotes })
                      }}
                    >
                      导出全部分类目录
                    </button>
                    <label className="library-folder-export-opt">
                      <input
                        type="checkbox"
                        data-testid="folder-export-include-notes"
                        checked={exportIncludeNotes}
                        onChange={event => setExportIncludeNotes(event.target.checked)}
                      />
                      <span>导出目录时附带批注 (.md)</span>
                    </label>
                  </>
                ) : null}
              </div>
            ) : null}
            {onExportBackup || onImportBackup ? (
              <div className="library-popover__section">
                {onExportBackup ? (
                  <button
                    type="button"
                    className="library-popover__item"
                    aria-label="导出文献库备份"
                    disabled={backingUp || importing}
                    onClick={() => {
                      setMoreMenuOpen(false)
                      onExportBackup()
                    }}
                  >
                    {backingUp ? '处理中…' : '一键备份 (.zip)'}
                  </button>
                ) : null}
                {onImportBackup ? (
                  <button
                    type="button"
                    className="library-popover__item"
                    aria-label="从备份恢复文献库"
                    disabled={backingUp || importing}
                    onClick={() => {
                      setMoreMenuOpen(false)
                      onImportBackup()
                    }}
                  >
                    从备份恢复文献库
                  </button>
                ) : null}
              </div>
            ) : null}
            {onResetLibrary ? (
              <div className="library-popover__section">
                {!confirmingReset ? (
                  <button
                    type="button"
                    className="library-popover__item library-popover__item--danger"
                    data-testid="library-reset-btn"
                    aria-label="重置文献库"
                    disabled={backingUp || importing || resetBusy || (documents.length === 0 && folders.length === 0)}
                    onClick={() => setConfirmingReset(true)}
                  >
                    重置文献库…
                  </button>
                ) : (
                  <div className="library-reset-confirm-bar" data-testid="library-reset-confirm-bar" role="alert">
                    <span>将清空全部 PDF、分类与批注（保留翻译设置），确认继续？</span>
                    <div className="library-reset-confirm-bar__actions">
                      <button
                        type="button"
                        className="document-action-danger"
                        data-testid="library-reset-confirm"
                        disabled={resetBusy}
                        onClick={() => {
                          setResetBusy(true)
                          void onResetLibrary().finally(() => {
                            setResetBusy(false)
                            setConfirmingReset(false)
                            setMoreMenuOpen(false)
                          })
                        }}
                      >
                        {resetBusy ? '清空中…' : '确认清空'}
                      </button>
                      <button type="button" disabled={resetBusy} onClick={() => setConfirmingReset(false)}>
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Zotero 风格分类文件夹树（占据左侧主视野，每个分类下直接展开所属 PDF） */}
      <div className="library-folder-tree" role="region" aria-label="分类文件夹">
        <div className="library-folder-tree__header">
          <div className="library-folder-tree__title-row">
            <button
              type="button"
              className="library-folder-tree__toggle"
              aria-expanded={!treeCollapsed}
              onClick={() => setTreeCollapsed(c => !c)}
            >
              <span>{treeCollapsed ? '▸' : '▾'}</span>
              <span>分类文件夹</span>
            </button>
            <div className="library-folder-tree__header-actions">
              {onImportFolder ? (
                <button
                  type="button"
                  className="library-folder-tree__new-btn"
                  data-testid="folder-import-dir-btn"
                  title="从本地文件夹导入 PDF 树并按子目录自动建立分类（最多 4 级）"
                  disabled={backingUp || importing}
                  onClick={() => onImportFolder(activeUserFolder?.id ?? null)}
                >
                  导入目录
                </button>
              ) : null}
              {onCreateFolder ? (
                <button
                  type="button"
                  className="library-folder-tree__new-btn"
                  data-testid="folder-create-root-btn"
                  title="新建一级分类文件夹"
                  onClick={() => {
                    setTreeCollapsed(false)
                    setCreatingParentId(prev => (prev === null ? undefined : null))
                    setDraftFolderName('')
                    setDraftFolderTrackId('')
                  }}
                >
                  + 新建
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {batchMode && onUpdateMeta && !treeCollapsed ? (
          <div className="library-batch-bar" data-testid="library-batch-bar">
            <div className="library-batch-bar__top">
              <span>批量整理 · 已选 {validSelectedBatchIds.length} 篇</span>
              <div className="library-batch-bar__top-actions">
                <button
                  type="button"
                  data-testid="library-batch-select-all"
                  onClick={() => {
                    const visibleIds = sortedVisibleDocuments.map(d => d.id)
                    const allSelected =
                      visibleIds.length > 0 && visibleIds.every(id => selectedBatchIds.has(id))
                    setSelectedBatchIds(allSelected ? new Set() : new Set(visibleIds))
                  }}
                >
                  {sortedVisibleDocuments.length > 0 &&
                  sortedVisibleDocuments.every(d => selectedBatchIds.has(d.id))
                    ? '取消全选'
                    : '全选当前'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBatchMode(false)
                    setSelectedBatchIds(new Set())
                  }}
                >
                  退出
                </button>
              </div>
            </div>
            <div className="library-batch-bar__row">
              <select
                data-testid="library-batch-folder-select"
                aria-label="批量目标分类文件夹"
                value={batchFolderTarget}
                disabled={batchBusy}
                onChange={e => setBatchFolderTarget(e.target.value)}
              >
                <option value="__unassigned__">未分类</option>
                {flatOrder.map(({ folder, depth }) => (
                  <option key={folder.id} value={folder.id}>
                    {depth > 0 ? `${'·'.repeat(depth)} ` : ''}
                    {folder.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="library-batch-move-btn"
                disabled={batchBusy || validSelectedBatchIds.length === 0}
                onClick={() => {
                  if (validSelectedBatchIds.length === 0) return
                  const targetFolder = batchFolderTarget === '__unassigned__' ? null : batchFolderTarget
                  setBatchBusy(true)
                  const run = onBatchMoveToFolder
                    ? onBatchMoveToFolder(validSelectedBatchIds, targetFolder)
                    : Promise.all(
                        validSelectedBatchIds.map(documentId =>
                          onUpdateMeta({ documentId, folderId: targetFolder })
                        )
                      ).then(() => undefined)
                  void run.finally(() => {
                    setBatchBusy(false)
                    setSelectedBatchIds(new Set())
                  })
                }}
              >
                移动
              </button>
            </div>
            <div className="library-batch-bar__row">
              <input
                type="text"
                data-testid="library-batch-tag-input"
                aria-label="批量标签名称"
                placeholder="批量标签（如 重点）"
                maxLength={32}
                value={batchTagDraft}
                disabled={batchBusy}
                onChange={e => setBatchTagDraft(e.target.value)}
              />
              <button
                type="button"
                data-testid="library-batch-tag-btn"
                disabled={batchBusy || validSelectedBatchIds.length === 0 || !batchTagDraft.trim()}
                onClick={() => {
                  const cleanTag = batchTagDraft.trim()
                  if (!cleanTag || validSelectedBatchIds.length === 0) return
                  if (hasControlCharacters(cleanTag)) {
                    onReportError('标签不能包含控制字符。')
                    return
                  }
                  setBatchBusy(true)
                  const run = onBatchAddTag
                    ? onBatchAddTag(validSelectedBatchIds, cleanTag)
                    : Promise.all(
                        validSelectedBatchIds.map(id => {
                          const doc = documents.find(d => d.id === id)
                          if (!doc) return Promise.resolve(true)
                          const tags = doc.tags ?? []
                          if (tags.some(t => t.toLowerCase() === cleanTag.toLowerCase())) {
                            return Promise.resolve(true)
                          }
                          return onUpdateMeta({ documentId: id, tags: [...tags, cleanTag] })
                        })
                      ).then(() => undefined)
                  void run.finally(() => {
                    setBatchBusy(false)
                    setBatchTagDraft('')
                  })
                }}
              >
                打标签
              </button>
            </div>
          </div>
        ) : null}

        {creatingParentId !== undefined && (
          <form
            className="library-folder-create-form"
            onSubmit={event => {
              event.preventDefault()
              void submitCreateFolder()
            }}
          >
            <div className="library-folder-create-form__hint">
              {creatingParentId
                ? `新建子分类于「${folderById.get(creatingParentId)?.name ?? ''}」`
                : '新建顶级分类文件夹'}
            </div>
            <input
              type="text"
              data-testid="folder-create-name"
              placeholder="输入分类名称（如：电催化）"
              maxLength={64}
              value={draftFolderName}
              disabled={creatingFolderBusy}
              autoFocus
              onChange={event => setDraftFolderName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setCreatingParentId(undefined)
                }
              }}
            />
            <select
              data-testid="folder-create-template"
              value={draftFolderTrackId}
              disabled={creatingFolderBusy}
              onChange={event => setDraftFolderTrackId(event.target.value)}
            >
              <option value="">空白分类（稍后手动加词）</option>
              {RESEARCH_TRACK_OPTIONS.map(track => (
                <option key={track.id} value={track.id}>
                  预填术语：{track.name}
                </option>
              ))}
            </select>
            <div className="library-folder-create-form__actions">
              <button
                type="submit"
                className="document-action-primary"
                data-testid="folder-create-submit"
                disabled={creatingFolderBusy}
              >
                {creatingFolderBusy ? '创建中…' : '创建'}
              </button>
              <button
                type="button"
                disabled={creatingFolderBusy}
                onClick={() => setCreatingParentId(undefined)}
              >
                取消
              </button>
            </div>
          </form>
        )}

        {!treeCollapsed && (
          <div className="library-folder-tree__list">
            <div className={`library-folder-row${effectiveFolderFilter === null ? ' is-active' : ''}`}>
              <span className="library-folder-caret-spacer" aria-hidden="true">
                <FolderTreeIcon size={13} />
              </span>
              <button
                type="button"
                className="library-folder-btn"
                data-testid="folder-filter-all"
                aria-pressed={effectiveFolderFilter === null}
                onClick={() => onSelectFolder?.(null)}
              >
                <span className="library-folder-name">全部文献</span>
                <span className="library-folder-count">{documents.length}</span>
              </button>
            </div>

            {folderRoots.map(node => renderFolderNode(node))}

            <div className="library-folder-branch">
              <div
                className={`library-folder-row${effectiveFolderFilter === 'unassigned' ? ' is-active' : ''}${
                  dropTargetKey === 'unassigned' ? ' is-drop-target' : ''
                }`}
                data-testid="folder-filter-unassigned-row"
                onDragOver={event => handleFolderDragOver(event, 'unassigned')}
                onDragLeave={() => {
                  if (dropTargetKey === 'unassigned') setDropTargetKey(null)
                }}
                onDrop={event => handleFolderDrop(event, null)}
              >
                {docsByFolderMap.unassignedList.length > 0 ? (
                  <button
                    type="button"
                    className="library-folder-caret"
                    aria-label={unassignedCollapsed ? '展开未分类' : '收起未分类'}
                    aria-expanded={!unassignedCollapsed}
                    onClick={() => setUnassignedCollapsed(c => !c)}
                  >
                    {unassignedCollapsed ? '▸' : '▾'}
                  </button>
                ) : (
                  <span className="library-folder-caret-spacer" aria-hidden="true">
                    ◦
                  </span>
                )}
                <button
                  type="button"
                  className="library-folder-btn"
                  data-testid="folder-filter-unassigned"
                  aria-pressed={effectiveFolderFilter === 'unassigned'}
                  onClick={() => {
                    setUnassignedCollapsed(false)
                    onSelectFolder?.('unassigned')
                  }}
                >
                  <span className="library-folder-name">未分类</span>
                  <span className="library-folder-count">{unassignedCount}</span>
                </button>
              </div>
              {docsByFolderMap.unassignedList.length > 0 && !unassignedCollapsed ? (
                <div className="library-folder-children">
                  {docsByFolderMap.unassignedList.map(doc => renderTreeDocRow(doc, 1))}
                </div>
              ) : null}
            </div>
          </div>
        )}

        {activeUserFolder ? (
          <div className="library-active-folder-bar" data-testid="active-folder-bar">
            <span className="library-active-folder-bar__text" title={activeUserFolder.contextSummary}>
              词库 · {activeUserFolder.glossary.length} 条
              {activeUserFolder.inheritGlobalGlossary ? ' (+全局)' : ' (隔离)'}
            </span>
            <div className="library-active-folder-bar__actions">
              {onExportFolderBibtex ? (
                <button
                  type="button"
                  data-testid="active-folder-export-bib-btn"
                  title="将该分类（含子分类）所有文献的引用导出为 .bib"
                  disabled={backingUp || importing}
                  onClick={() =>
                    onExportFolderBibtex({
                      scope: 'folder',
                      folderId: activeUserFolder.id
                    })
                  }
                >
                  导出 .bib
                </button>
              ) : null}
              {onExportFolderPdfs ? (
                <button
                  type="button"
                  data-testid="active-folder-export-pdfs"
                  title="将该分类（含子分类）的 PDF 按真实层级目录导出到本地"
                  disabled={backingUp || importing}
                  onClick={() =>
                    onExportFolderPdfs({
                      scope: 'folder',
                      folderId: activeUserFolder.id,
                      includeAnnotations: exportIncludeNotes
                    })
                  }
                >
                  导出
                </button>
              ) : null}
              {onUpdateFolder ? (
                <button
                  type="button"
                  data-testid="active-folder-edit-glossary"
                  onClick={() => {
                    if (onOpenFolderSettings) onOpenFolderSettings(activeUserFolder.id)
                    else setSettingsFolderId(activeUserFolder.id)
                  }}
                >
                  编辑词库
                </button>
              ) : null}
            </div>
          </div>
        ) : effectiveFolderFilter === 'unassigned' && unassignedCount > 0 && (onExportFolderPdfs || onExportFolderBibtex) ? (
          <div className="library-active-folder-bar" data-testid="unassigned-folder-bar">
            <span className="library-active-folder-bar__text">未分类 · 共 {unassignedCount} 篇</span>
            <div className="library-active-folder-bar__actions">
              {onExportFolderBibtex ? (
                <button
                  type="button"
                  data-testid="unassigned-export-bib-btn"
                  disabled={backingUp || importing}
                  onClick={() => onExportFolderBibtex({ scope: 'unassigned' })}
                >
                  导出 .bib
                </button>
              ) : null}
              {onExportFolderPdfs ? (
                <button
                  type="button"
                  data-testid="unassigned-folder-export-pdfs"
                  disabled={backingUp || importing}
                  onClick={() =>
                    onExportFolderPdfs({ scope: 'unassigned', includeAnnotations: exportIncludeNotes })
                  }
                >
                  导出
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {loadError && (
        <div className="library-load-error error-banner" role="alert">
          <p>{loadError}</p>
          <button type="button" onClick={onRetry}>
            重新读取
          </button>
        </div>
      )}
      {loading && <p className="library-feedback library-feedback--loading" role="status">正在读取文献库…</p>}

      {crossHits.length > 0 && (
        <div className="library-cross-hits" role="region" aria-label="批注与译文匹配结果">
          <p className="library-result-count">批注与译文命中 · {crossHits.length} 条</p>
          <ul className="library-cross-hit-list">
            {crossHits.map((hit, idx) => (
              <li key={`${hit.documentId}-${hit.source}-${hit.pageNumber ?? 0}-${idx}`}>
                <button
                  type="button"
                  className="library-cross-hit-btn"
                  onClick={() => onJumpToSearchHit?.(hit.documentId, hit.pageNumber)}
                >
                  <span className="library-cross-hit-meta">
                    <span className={`library-hit-badge library-hit-badge--${hit.source}`}>
                      {SOURCE_LABELS[hit.source]}
                    </span>
                    <span className="library-cross-hit-title">{hit.displayTitle}</span>
                    {hit.pageNumber !== null ? <span className="library-cross-hit-page">P.{hit.pageNumber}</span> : null}
                  </span>
                  <span className="library-cross-hit-snippet">{hit.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 分类文件夹下方的可拖拽、可折叠「当前查看」模块（仅展示正在阅读的一篇或两篇文献） */}
      <div
        className={`library-results library-current-section${documents.length === 0 ? ' is-empty' : ''}${
          currentCollapsed && documents.length > 0 ? ' is-collapsed' : ''
        }`}
        data-testid="current-viewing-section"
        aria-busy={loading}
      >
        {documents.length > 0 ? (
          <div
            className="library-current-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整当前查看区域高度"
            title="上下拖拽调整当前查看区域高度，双击恢复默认"
            onPointerDown={handleCurrentResizerPointerDown}
            onPointerMove={handleCurrentResizerPointerMove}
            onPointerUp={handleCurrentResizerPointerUp}
            onPointerCancel={handleCurrentResizerPointerUp}
            onDoubleClick={() => setCurrentHeightPx(null)}
          />
        ) : null}
        {documents.length === 0 ? (
          !loading &&
          !loadError && (
            <div className="empty-library">
              <span className="library-empty-symbol" aria-hidden="true">
                <FolderTreeIcon size={18} />
              </span>
              <p>文献库为空</p>
              <small>导入或拖拽 PDF 到此窗口</small>
              {recommendedTags.length > 0 && (
                <div className="library-recommended-tags" data-testid="library-recommended-tags">
                  <span className="library-recommended-tags__title">向导预设标签</span>
                  <div className="library-recommended-tags__list">
                    {recommendedTags.map(tag => (
                      <span key={tag} className="document-tag-pill">
                        #{tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        ) : currentViewedEntries.length === 0 ? (
          <div className="library-current-empty" role="status">
            <span>暂未打开文献，请在上方分类点击一篇开始阅读</span>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="library-current-header-btn"
              data-testid="current-viewing-toggle"
              aria-expanded={!currentCollapsed}
              onClick={() => setCurrentCollapsed(c => !c)}
            >
              <span>{currentCollapsed ? '▸' : '▾'} 当前查看</span>
              <span>{currentViewedEntries.length} 篇</span>
            </button>
            {!currentCollapsed ? (
              <ul
                className="document-list library-current-list"
                style={currentHeightPx !== null ? { maxHeight: `${currentHeightPx}px` } : undefined}
              >
                {currentViewedEntries.map(({ document, paneLabel }) => {
                const isEditing = activeEditingId === document.id
                const isTagging = activeTaggingId === document.id
                const isMoving = activeMovingId === document.id && actionSource === 'current'
                const isConfirmingDelete = activeConfirmDeleteId === document.id && actionSource === 'current'
                const isBusy = busyId === document.id
                const docFolder = document.folderId ? folderById.get(document.folderId) ?? null : null
                const currentPage = readerProgress[document.id]
                const progressRatio =
                  currentPage && document.pageCount
                    ? Math.min(100, Math.max(4, Math.round((currentPage / document.pageCount) * 100)))
                    : null

                return (
                  <li
                    key={`${document.id}-${paneLabel ?? 'single'}`}
                    className="document-entry"
                    draggable={Boolean(onUpdateMeta)}
                    onDragStart={event => {
                      event.dataTransfer.setData(DOC_DRAG_MIME, document.id)
                      event.dataTransfer.effectAllowed = 'move'
                      setActiveWorkspaceDrag({ kind: 'doc', documentId: document.id })
                    }}
                    onDragEnd={() => setActiveWorkspaceDrag(null)}
                  >
                    <button
                      type="button"
                      className="document-item selected"
                      onClick={() => onSelect(document.id)}
                      data-document-id={document.id}
                      aria-pressed={selectedId === document.id}
                    >
                      <span className="pdf-badge">PDF</span>
                      <span className="document-description">
                        <strong title={document.originalFilename}>{formatDocumentTitle(document)}</strong>
                        <small>
                          {document.pageCount === null ? '页数待读取' : `${document.pageCount} 页`} · {formatSize(document.byteSize)}
                          {currentPage && document.pageCount ? ` · 已读 P.${currentPage}/${document.pageCount}` : ''}
                        </small>
                        {progressRatio !== null && (
                          <span className="document-progress-track" aria-hidden="true">
                            <span className="document-progress-fill" style={{ width: `${progressRatio}%` }} />
                          </span>
                        )}
                        <time dateTime={document.importedAt}>导入于 {new Date(document.importedAt).toLocaleDateString('zh-CN')}</time>
                        <span className="library-selected-label">
                          {paneLabel ? `当前查看 · ${paneLabel}` : '正在阅读'}
                          {translatingPagesByDocId?.[document.id]
                            ? ` · 第 ${translatingPagesByDocId[document.id]} 页翻译中…`
                            : ''}
                        </span>
                      </span>
                    </button>

                    {(docFolder || (document.tags?.length ?? 0) > 0) && (
                      <div className="document-tags">
                        {docFolder ? (
                          <span className="document-folder-pill" title={`所在分类：${docFolder.name}`}>
                            {docFolder.name}
                          </span>
                        ) : null}
                        {document.tags.map(tag => (
                          <span key={tag} className="document-tag-pill">
                            #{tag}
                            {onUpdateMeta ? (
                              <button
                                type="button"
                                aria-label={`移除标签 ${tag}`}
                                disabled={isBusy}
                                onClick={() => void handleRemoveTag(document, tag)}
                              >
                                ×
                              </button>
                            ) : null}
                          </span>
                        ))}
                      </div>
                    )}

                    {isEditing ? (
                      <form
                        className="document-actions document-rename-form"
                        onSubmit={event => {
                          event.preventDefault()
                          void submitRename(document.id)
                        }}
                      >
                        <input
                          ref={renameInputRef}
                          type="text"
                          aria-label="编辑文献标题"
                          value={draftTitle}
                          maxLength={200}
                          disabled={isBusy}
                          onChange={event => setDraftTitle(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelRename()
                            }
                          }}
                        />
                        <div className="document-action-buttons">
                          <button type="submit" className="document-action-primary" disabled={isBusy}>
                            保存
                          </button>
                          <button type="button" disabled={isBusy} onClick={cancelRename}>
                            取消
                          </button>
                        </div>
                      </form>
                    ) : isTagging ? (
                      <form
                        className="document-actions document-rename-form"
                        onSubmit={event => {
                          event.preventDefault()
                          void handleAddTag(document)
                        }}
                      >
                        <input
                          type="text"
                          aria-label="添加文献标签"
                          placeholder="输入标签，如 VLDB / 综述"
                          value={draftTag}
                          maxLength={32}
                          disabled={isBusy}
                          autoFocus
                          onChange={event => setDraftTag(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              setTaggingId(null)
                              setDraftTag('')
                            }
                          }}
                        />
                        <div className="document-action-buttons">
                          <button type="submit" className="document-action-primary" disabled={isBusy}>
                            添加
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => {
                              setTaggingId(null)
                              setDraftTag('')
                            }}
                          >
                            取消
                          </button>
                        </div>
                        {(() => {
                          const existingLower = new Set((document.tags ?? []).map(t => t.toLowerCase()))
                          const suggestions = recommendedTags.filter(tag => !existingLower.has(tag.toLowerCase()))
                          if (suggestions.length === 0 || !onUpdateMeta) return null
                          return (
                            <div className="document-tag-suggestions" aria-label="向导推荐标签">
                              {suggestions.map(tag => (
                                <button
                                  key={tag}
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => {
                                    void onUpdateMeta({
                                      documentId: document.id,
                                      tags: [...(document.tags ?? []), tag]
                                    })
                                  }}
                                >
                                  +#{tag}
                                </button>
                              ))}
                            </div>
                          )
                        })()}
                      </form>
                    ) : isMoving ? (
                      renderMoveFolderPanel(document, false)
                    ) : isConfirmingDelete ? (
                      <div className="document-actions document-confirm-delete">
                        <span>确认从文献库删除？</span>
                        <div className="document-action-buttons">
                          <button
                            type="button"
                            className="document-action-danger"
                            aria-label="确认删除"
                            disabled={isBusy}
                            onClick={() => void submitDelete(document.id)}
                          >
                            确认删除
                          </button>
                          <button type="button" disabled={isBusy} onClick={() => setConfirmDeleteId(null)}>
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {document.starred ? (
                          <span className="document-star-badge" aria-hidden="true" title="已收藏">
                            ★
                          </span>
                        ) : null}
                        <div className="document-hover-actions" role="group" aria-label="文献操作">
                          {onUpdateMeta ? (
                            <>
                              <button
                                type="button"
                                className={
                                  document.starred
                                    ? 'document-hover-icon-btn document-hover-icon-btn--star is-starred'
                                    : 'document-hover-icon-btn document-hover-icon-btn--star'
                                }
                                aria-label={
                                  document.starred
                                    ? `取消收藏 ${document.originalFilename}`
                                    : `收藏 ${document.originalFilename}`
                                }
                                aria-pressed={Boolean(document.starred)}
                                title={document.starred ? '取消收藏' : '收藏'}
                                disabled={importing || isBusy}
                                onClick={event => {
                                  event.stopPropagation()
                                  void onUpdateMeta({ documentId: document.id, starred: !document.starred })
                                }}
                              >
                                <svg width="13" height="13" viewBox="0 0 16 16" fill={document.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                                  <path d="M8 1.7l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2.1.7-4.3-3.1-3 4.3-.6z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="document-hover-icon-btn"
                                data-testid={`doc-move-folder-${document.id}`}
                                aria-label={`归类 ${document.originalFilename}`}
                                title="移动到分类文件夹"
                                disabled={importing || isBusy}
                                onClick={event => {
                                  event.stopPropagation()
                                  setEditingId(null)
                                  setTaggingId(null)
                                  setConfirmDeleteId(null)
                                  setActionSource('current')
                                  setMovingId(curr => (curr === document.id ? null : document.id))
                                }}
                              >
                                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                                  <path d="M1.5 4a1 1 0 0 1 1-1h3.2l1.3 1.5h6.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="document-hover-icon-btn"
                                aria-label={`为 ${document.originalFilename} 添加标签`}
                                title="添加标签"
                                disabled={importing || isBusy}
                                onClick={event => {
                                  event.stopPropagation()
                                  setEditingId(null)
                                  setConfirmDeleteId(null)
                                  setMovingId(null)
                                  setDraftTag('')
                                  setTaggingId(document.id)
                                }}
                              >
                                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                                  <path d="M2.5 8.5V3.5a1 1 0 0 1 1-1h5l5 5-5.5 5.5-5.5-4.5z" />
                                  <circle cx="5.5" cy="5.5" r="1" />
                                </svg>
                              </button>
                            </>
                          ) : null}
                          {onAutoDetectTitle ? (
                            <button
                              type="button"
                              className="document-hover-icon-btn"
                              data-testid={`doc-auto-title-${document.id}`}
                              aria-label={`识别 ${document.originalFilename} 标题`}
                              title="从 PDF 首页识别论文真实标题"
                              disabled={importing || isBusy}
                              onClick={event => {
                                event.stopPropagation()
                                setBusyId(document.id)
                                void onAutoDetectTitle(document).finally(() => {
                                  setBusyId(current => (current === document.id ? null : current))
                                })
                              }}
                            >
                              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                                <path d="M3 4.5h10M8 4.5v8M5.5 12.5h5" />
                              </svg>
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="document-hover-icon-btn"
                            aria-label={`重命名 ${document.originalFilename}`}
                            title="重命名"
                            disabled={importing || isBusy}
                            onClick={event => {
                              event.stopPropagation()
                              startRename(document)
                            }}
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                              <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="document-hover-icon-btn document-hover-icon-btn--danger"
                            aria-label={`删除 ${document.originalFilename}`}
                            title="删除"
                            disabled={importing || isBusy}
                            onClick={event => {
                              event.stopPropagation()
                              setActionSource('current')
                              startDeleteConfirm(document.id)
                            }}
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                              <path d="M3 4.5h10M6 4.5V3h4v1.5M5.5 7v5M10.5 7v5M4.5 4.5l.5 8.5h6l.5-8.5" />
                            </svg>
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
            ) : null}
          </>
        )}
      </div>

      {/* 浮动通知 / 进度 / 错误提示气泡（0px 固定高度占位，不挤压分类文件夹列表） */}
      {importing || visibleNotice || error || errorDetails.length > 0 ? (
        <div className="library-toast-overlay">
          {importing ? (
            <p
              className="library-toast library-feedback library-feedback--progress"
              data-testid="library-floating-toast"
              role="status"
            >
              正在选择、校验并导入 PDF…
            </p>
          ) : null}
          {visibleNotice ? (
            <div
              className="library-toast library-feedback library-feedback--success"
              data-testid="library-floating-toast"
              role="status"
              onMouseEnter={() => setToastHovered(true)}
              onMouseLeave={() => setToastHovered(false)}
            >
              <span className="library-toast__text">{visibleNotice}</span>
              <button
                type="button"
                className="library-toast__close"
                data-testid="library-toast-close"
                aria-label="关闭提示"
                onClick={handleDismissToast}
              >
                ×
              </button>
            </div>
          ) : null}
          {error || errorDetails.length > 0 ? (
            <div className="library-toast error-banner library-error-banner" role="alert">
              <div className="library-error-header">
                <p className="library-error-summary">
                  {errorDetails.length > 0 ? `有 ${errorDetails.length} 个文件未能导入：` : error}
                </p>
                <button type="button" className="library-error-dismiss" onClick={onDismissError}>
                  关闭提示
                </button>
              </div>
              {errorDetails.length > 0 ? (
                <ul className="library-error-details">
                  {errorDetails.map((item, index) => (
                    <li key={`${item.filename}-${index}`}>
                      <strong>{item.filename}</strong>
                      <span>{item.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!onOpenFolderSettings && onUpdateFolder && onDeleteFolder ? (
        <FolderSettingsModal
          open={Boolean(settingsFolder)}
          folder={settingsFolder}
          allFolders={folders}
          onClose={() => setSettingsFolderId(null)}
          onSave={onUpdateFolder}
          onDelete={onDeleteFolder}
          onExportFolder={
            onExportFolderPdfs
              ? folderId => onExportFolderPdfs({ scope: 'folder', folderId, includeAnnotations: exportIncludeNotes })
              : undefined
          }
        />
      ) : null}
    </aside>
  )
}
