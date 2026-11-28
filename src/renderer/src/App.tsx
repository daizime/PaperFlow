import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { isLikelyMessyAcademicFilename, type FirstPageCitationSource } from '../../shared/citation'
import type {
  AiChatContextDocument,
  AiChatScope,
  AnnotationColor,
  AnnotationRecord,
  DetectedLocalAiClient,
  DocumentRecord,
  DocumentTranslationScope,
  ExplainMode,
  ExportFolderPdfsInput,
  ExportTranslationPage,
  ExportTranslationPageBlock,
  ProviderBalanceSnapshot,
  ResearchProfile,
  TranslatePageResult,
  TranslatedBlockRecord,
  TranslationExportFormat,
  TranslationSettings,
  UsageStatsSummary
} from '../../shared/contracts'
import { formatResearchProfileBadge } from '../../shared/research-onboarding'
import { FolderSettingsModal } from './features/library/FolderSettingsModal'
import { extractTitleFromPdfBytes } from './features/reader/pdf-title-extract'
import { ResearchOnboardingModal } from './features/onboarding/ResearchOnboardingModal'
import { AiChatWidget, type AiChatDockMode } from './features/study/AiChatWidget'
import {
  assembleSkillExcerpt,
  selectBalancedSkillPages,
  type SkillSamplingOptions
} from './features/study/skill-context'
import {
  PaneExpandIcon,
  PaneOutlineIcon,
  PaneSearchIcon,
  SplitPdfPane,
  type PaneSelectionSnapshot,
  type PaneStudyHandle
} from './features/reader/SplitPdfPane'
import {
  closeSplitPane,
  computeDropZone,
  createSplitPaneId,
  describeDropAction,
  DOC_DRAG_MIME,
  dropDocumentIntoPanes,
  dropPaneOntoPane,
  formatPaneBadgeShort,
  formatPaneSlotLabel,
  getActiveWorkspaceDrag,
  getPaneViewMode,
  normalizePaneWeights,
  PANE_DRAG_MIME,
  setActiveWorkspaceDrag,
  setSplitPaneViewMode,
  type SplitDropZone,
  type SplitPane,
  type SplitPaneViewMode
} from './features/reader/split-panes'
import {
  countTranslatedBlocks,
  LockIcon,
  TranslationPanel,
  type BatchQueueProgress,
  type TargetSentenceSelection
} from './features/translation/TranslationPanel'
import { TranslationSettingsModal } from './features/translation/TranslationSettingsModal'
import {
  buildLowBalanceErrorToast,
  buildTranslationCompletionToast,
  formatHeaderEnginePill,
  type UsageToastState
} from './features/translation/usage-format'
import {
  findReferencesHeadingBlockIndex,
  parseBatchPageRange
} from './features/translation/batch-translation'
import {
  SelectionCompanionBar,
  type ExplainCardState,
  type ReferencePeekState,
  type SelectionCompanionState
} from './features/study/SelectionCompanionBar'
import { AnnotationsDrawer } from './features/study/AnnotationsDrawer'
import { CitationModal } from './features/study/CitationModal'
import { ShortcutsModal } from './features/study/ShortcutsModal'
import {
  CUSTOM_SHORTCUTS_STORAGE_KEY,
  findShortcutConflict,
  loadStoredShortcuts,
  matchesShortcutEvent,
  mergeShortcuts,
  resetShortcut,
  saveStoredShortcuts,
  type ShortcutActionId,
  type ShortcutOverrides
} from './features/study/shortcuts'
import {
  extractReferenceTargets,
  findReferenceMatchInPages,
  type ReferencePeekMatch,
  type ReferencePageSource,
  type ReferenceTarget
} from './features/study/reference-peek'
import './assets/themes.css'
import {
  hitTestPageSentence,
  matchSelectionRegionsToSentences
} from './features/translation/sentence-alignment'
import { buildPageTranslationContext } from './features/translation/translation-context'
import {
  buildPageTranslationInputs,
  buildSingleBlockTranslationInput,
  isSamePageLayout,
  isUsableTranslation,
  mergePageTranslationRecords,
  reduceLeftSourceInteract,
  reduceRightSentenceSelect,
  scrollOppositePaneToActiveLink,
  type ActiveSentenceLink
} from './features/translation/pane-translation-helpers'
import { WorkspaceHeader, type ReadingTheme } from './features/workspace/WorkspaceHeader'
import { WorkspaceTabsBar, type ReaderViewMode } from './features/workspace/WorkspaceTabsBar'
import { UsageToastLayer } from './features/workspace/UsageToastLayer'
import {
  classifyPdfLanguageFromText,
  isTranslationEngineConfigured,
  loadStoredDocViewModes,
  resolveDocumentViewMode,
  type UnconfiguredEnginePromptState
} from './features/translation/auto-translate'
import { useDualScrollSync } from './features/translation/useDualScrollSync'
import { matchesFormulaPlaceholders } from '../../shared/formula-placeholders'
import { LibraryPanel } from './features/library/LibraryPanel'
import { LiteratureSearchModal } from './features/library/LiteratureSearchModal'
import { useLibrary } from './features/library/useLibrary'
import { ReaderToolbar } from './features/reader/ReaderToolbar'
import {
  analyzePageLayout,
  computeStableTranslationBlockKey,
  refineDocumentHeadersFooters,
  type PageLayoutResult
} from './features/reader/layout-analysis'
import { loadPdf, type PDFDocumentProxy } from './features/reader/pdf-engine'
import { type PageGeometry, type PageRect } from './features/reader/pdf-geometry'
import { extractPageGraphicHints, type PdfOperatorListLike } from './features/reader/pdf-graphics'
import { scoreOutlineHeadingMatch, type PdfOutlineItem } from './features/reader/pdf-outline'
import {
  PdfViewer,
  type LeftSourceInteractEvent,
  type PageBackdropSnapshot,
  type ReaderMirrorState,
  type ReaderToolbarActions
} from './features/reader/PdfViewer'

const THEME_STORAGE_KEY = 'paperflow:theme'
const OPEN_TABS_STORAGE_KEY = 'paperflow:open-tabs'
const SPLIT_PANES_STORAGE_KEY = 'paperflow:split-panes'
const SECONDARY_DOC_STORAGE_KEY = 'paperflow:secondary-document'
const PREFETCH_NEXT_PAGE_STORAGE_KEY = 'paperflow:prefetch-next-page'
const DOC_VIEW_MODES_STORAGE_KEY = 'paperflow:doc-view-modes'
const PRIMARY_PANE_ID = 'pane-primary'
const LIBRARY_WIDTH_STORAGE_KEY = 'paperflow:library-width'
const DEFAULT_LIBRARY_WIDTH_PX = 252
const MIN_LIBRARY_WIDTH_PX = 200
const MAX_LIBRARY_WIDTH_PX = 420
const EMPTY_ANNOTATIONS_BY_PAGE: ReadonlyMap<number, readonly AnnotationRecord[]> = new Map()

function clampLibraryWidth(value: number): number {
  return Math.max(MIN_LIBRARY_WIDTH_PX, Math.min(MAX_LIBRARY_WIDTH_PX, Math.round(value)))
}

function parseDraggedSplitSource(
  dataTransfer: DataTransfer | null
): { kind: 'pane'; paneId: string; documentId: string } | { kind: 'doc'; documentId: string } | null {
  if (dataTransfer) {
    const paneId = dataTransfer.getData(PANE_DRAG_MIME)
    const docId = dataTransfer.getData(DOC_DRAG_MIME)
    if (paneId) {
      return { kind: 'pane', paneId, documentId: docId }
    }
    if (docId) {
      return { kind: 'doc', documentId: docId }
    }
  }
  const active = getActiveWorkspaceDrag()
  if (active) return active
  if (dataTransfer) {
    const types = Array.from(dataTransfer.types ?? [])
    if (types.includes(PANE_DRAG_MIME)) return { kind: 'pane', paneId: '', documentId: '' }
    if (types.includes(DOC_DRAG_MIME)) return { kind: 'doc', documentId: '' }
  }
  return null
}

const INITIAL_MIRROR_STATE: ReaderMirrorState = {
  pageCount: 0,
  currentPage: 1,
  scale: 1,
  cropMargins: false,
  estimatedSize: { width: 612, height: 792 },
  pageSizes: {},
  pageInsets: {},
  pageTextStatus: {},
  headerOffsetPx: 0,
  outlineOpen: false,
  searchOpen: false,
  toolbarDisabled: true
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true
  }
  return target instanceof HTMLElement && target.isContentEditable
}

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types ?? [])
  return types.includes('Files') || dataTransfer.files.length > 0
}

/** 提取版面块的原始可读纯文本（不含翻译阶段专用的 ⟪M1⟫ 公式占位符），用于题注速览、复制、目录匹配与 AI 上下文。 */
function getBlockPlainText(block: PageLayoutResult['blocks'][number]): string {
  return block.sentences
    .map(sentence => sentence.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export default function App(): React.JSX.Element {
  const library = useLibrary()
  const [dropActive, setDropActive] = useState(false)
  const [libraryCollapsed, setLibraryCollapsed] = useState(false)
  const [libraryWidthPx, setLibraryWidthPx] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem(LIBRARY_WIDTH_STORAGE_KEY))
      return Number.isFinite(raw) && raw > 0 ? clampLibraryWidth(raw) : DEFAULT_LIBRARY_WIDTH_PX
    } catch {
      return DEFAULT_LIBRARY_WIDTH_PX
    }
  })
  const [expandedPaneId, setExpandedPaneId] = useState<string | null>(null)
  const [stageOverflow, setStageOverflow] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  const libraryResizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const splitStageRef = useRef<HTMLDivElement | null>(null)
  const [docViewModes, setDocViewModes] = useState<Record<string, ReaderViewMode>>(() =>
    loadStoredDocViewModes(typeof localStorage !== 'undefined' ? localStorage : null, DOC_VIEW_MODES_STORAGE_KEY)
  )
  const [unconfiguredPrompt, setUnconfiguredPrompt] = useState<UnconfiguredEnginePromptState | null>(null)
  const [autoTranslateRetryTick, setAutoTranslateRetryTick] = useState(0)
  const [scrollSyncLocked, setScrollSyncLocked] = useState(true)
  const [pdfScrollEl, setPdfScrollEl] = useState<HTMLDivElement | null>(null)
  const [translationScrollEl, setTranslationScrollEl] = useState<HTMLDivElement | null>(null)
  const [translationVisiblePages, setTranslationVisiblePages] = useState<{ documentId: string; pages: readonly number[] } | null>(null)
  const [mirrorState, setMirrorState] = useState<ReaderMirrorState>(INITIAL_MIRROR_STATE)
  const [rawLayouts, setRawLayouts] = useState<Map<number, PageLayoutResult>>(() => new Map())
  const [backdrops, setBackdrops] = useState<Map<number, PageBackdropSnapshot>>(() => new Map())
  const [translationsByPage, setTranslationsByPage] = useState<Map<number, Map<string, TranslatedBlockRecord>>>(() => new Map())
  const [translatingPagesByDocId, setTranslatingPagesByDocId] = useState<Record<string, number>>({})
  const [batchQueuesByDocId, setBatchQueuesByDocId] = useState<Record<string, BatchQueueProgress>>({})
  const [batchOptionsOpen, setBatchOptionsOpen] = useState(false)
  const [batchRangeDraft, setBatchRangeDraft] = useState('')
  const [batchSkipReferences, setBatchSkipReferences] = useState(true)
  const [translationExportOpen, setTranslationExportOpen] = useState(false)
  const [exportingTranslation, setExportingTranslation] = useState(false)
  const [prefetchNextPage, setPrefetchNextPage] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PREFETCH_NEXT_PAGE_STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [retranslatingBlockKeys, setRetranslatingBlockKeys] = useState<Set<string>>(() => new Set())
  const [translationError, setTranslationError] = useState<string | null>(null)
  const [translationSettings, setTranslationSettings] = useState<TranslationSettings | null>(null)
  const [providerBalance, setProviderBalance] = useState<ProviderBalanceSnapshot | null>(null)
  const [usageSummary, setUsageSummary] = useState<UsageStatsSummary | null>(null)
  const [usageToast, setUsageToast] = useState<UsageToastState | null>(null)
  const [documentScope, setDocumentScope] = useState<DocumentTranslationScope | null>(null)
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [exportIncludeNotes, setExportIncludeNotes] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsFocusSection, setSettingsFocusSection] = useState<'default' | 'usage'>('default')
  const [literatureSearchModal, setLiteratureSearchModal] = useState<{
    open: boolean
    initialQuery?: string
    initialTags?: string[]
  }>({ open: false })
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [shortcutOverrides, setShortcutOverrides] = useState<ShortcutOverrides>(() =>
    loadStoredShortcuts(typeof localStorage !== 'undefined' ? localStorage : null, CUSTOM_SHORTCUTS_STORAGE_KEY)
  )
  const shortcuts = useMemo(() => mergeShortcuts(shortcutOverrides), [shortcutOverrides])
  const handleUpdateShortcut = useCallback((actionId: ShortcutActionId, combo: string): void => {
    setShortcutOverrides(prev => {
      if (findShortcutConflict(mergeShortcuts(prev), actionId, combo)) return prev
      const next: ShortcutOverrides = { ...prev, [actionId]: combo }
      saveStoredShortcuts(typeof localStorage !== 'undefined' ? localStorage : null, next, CUSTOM_SHORTCUTS_STORAGE_KEY)
      return next
    })
  }, [])
  const handleSwapShortcuts = useCallback(
    (actionA: ShortcutActionId, actionB: ShortcutActionId): void => {
      setShortcutOverrides(prev => {
        const currentMap = mergeShortcuts(prev)
        const next: ShortcutOverrides = {
          ...prev,
          [actionA]: currentMap[actionB],
          [actionB]: currentMap[actionA]
        }
        saveStoredShortcuts(typeof localStorage !== 'undefined' ? localStorage : null, next, CUSTOM_SHORTCUTS_STORAGE_KEY)
        return next
      })
    },
    []
  )
  const handleResetShortcut = useCallback((actionId: ShortcutActionId): void => {
    setShortcutOverrides(prev => {
      if (!(actionId in prev)) return prev
      const next = resetShortcut(prev, actionId)
      saveStoredShortcuts(typeof localStorage !== 'undefined' ? localStorage : null, next, CUSTOM_SHORTCUTS_STORAGE_KEY)
      return next
    })
  }, [])
  const handleResetAllShortcuts = useCallback((): void => {
    setShortcutOverrides({})
    saveStoredShortcuts(typeof localStorage !== 'undefined' ? localStorage : null, {}, CUSTOM_SHORTCUTS_STORAGE_KEY)
  }, [])
  const [citationOpen, setCitationOpen] = useState(false)
  const [researchProfile, setResearchProfile] = useState<ResearchProfile | null>(null)
  const [onboardingReady, setOnboardingReady] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  const [backingUp, setBackingUp] = useState(false)
  const [activeLink, setActiveLink] = useState<ActiveSentenceLink | null>(null)
  const activeLinkRef = useRef<ActiveSentenceLink | null>(null)
  activeLinkRef.current = activeLink
  const [editingAnnotation, setEditingAnnotation] = useState<{
    paneId: string
    documentId: string
    annotationId: string
  } | null>(null)
  const expectEditingSyncPaneRef = useRef<string | null>(null)
  const [dualSplitRatio, setDualSplitRatio] = useState<number | null>(null)
  const [openTabIds, setOpenTabIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(OPEN_TABS_STORAGE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  })
  const [splitPanes, setSplitPanes] = useState<SplitPane[]>(() => {
    try {
      const raw = localStorage.getItem(SPLIT_PANES_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) {
          return parsed
            .filter(
              (item): item is SplitPane =>
                Boolean(item) &&
                typeof (item as SplitPane).id === 'string' &&
                typeof (item as SplitPane).documentId === 'string' &&
                typeof (item as SplitPane).weight === 'number'
            )
            .map(item => ({
              id: item.id,
              documentId: item.documentId,
              weight: item.weight,
              ...(item.viewMode === 'source' || item.viewMode === 'dual' || item.viewMode === 'translation'
                ? { viewMode: item.viewMode }
                : {})
            }))
        }
      }
      localStorage.removeItem(SECONDARY_DOC_STORAGE_KEY)
      return []
    } catch {
      return []
    }
  })
  const [translationRevision, setTranslationRevision] = useState(0)
  const [activePaneId, setActivePaneId] = useState<string>(() => splitPanes[0]?.id ?? PRIMARY_PANE_ID)
  const [dragHover, setDragHover] = useState<{
    targetPaneId: string | 'translation'
    zone: SplitDropZone
    sourceKind: 'doc' | 'pane'
  } | null>(null)
  const [aiChatOpen, setAiChatOpen] = useState(false)
  const [aiChatDockMode, setAiChatDockMode] = useState<AiChatDockMode>('floating')
  const [aiChatDrawerExpanded, setAiChatDrawerExpanded] = useState(true)
  const [aiChatPendingQuote, setAiChatPendingQuote] = useState<string | null>(null)
  const [annotationsByDocId, setAnnotationsByDocId] = useState<Map<string, AnnotationRecord[]>>(() => new Map())
  const [secondarySelection, setSecondarySelection] = useState<PaneSelectionSnapshot | null>(null)
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [savingAnnotation, setSavingAnnotation] = useState(false)
  const [explainState, setExplainState] = useState<ExplainCardState | null>(null)
  const [peekState, setPeekState] = useState<ReferencePeekState | null>(null)
  const [peekPinned, setPeekPinned] = useState(false)
  const [returnTarget, setReturnTarget] = useState<{ paneId: string; pageNumber: number } | null>(null)
  const [theme, setTheme] = useState<ReadingTheme>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return saved === 'sepia' || saved === 'dark' ? saved : 'light'
  })
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const themeMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!themeMenuOpen) return
    const handlePointerDown = (event: MouseEvent): void => {
      if (themeMenuRef.current && event.target instanceof Node && !themeMenuRef.current.contains(event.target)) {
        setThemeMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setThemeMenuOpen(false)
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [themeMenuOpen])

  const dragDepthRef = useRef(0)
  const cancelNavigationRef = useRef<(() => void) | null>(null)
  const navigateToPageRef = useRef<((pageNumber: number) => void) | null>(null)
  const analyzePageRef = useRef<((pageNumber: number) => Promise<PageLayoutResult | null>) | null>(null)
  const extractPageTextRef = useRef<((pageNumber: number) => Promise<string | null>) | null>(null)
  const extractCitationSourceRef = useRef<(() => Promise<FirstPageCitationSource | null>) | null>(null)
  const renderRegionPreviewRef = useRef<
    | ((
        pageNumber: number,
        kind: 'figure' | 'table',
        captionBounds?: PageRect,
        obstacleBounds?: readonly PageRect[]
      ) => Promise<string | null>)
    | null
  >(null)
  const outlineRequestIdRef = useRef(0)
  const toolbarActionsRef = useRef<ReaderToolbarActions | null>(null)
  const paneToolbarRefs = useRef<Map<string, MutableRefObject<ReaderToolbarActions | null>>>(new Map())
  const paneExtractTextRefs = useRef<Map<string, MutableRefObject<((pageNumber: number) => Promise<string | null>) | null>>>(new Map())
  const paneStudyHandlesRef = useRef<Map<string, PaneStudyHandle>>(new Map())
  const loadedAnnotationDocsRef = useRef<Set<string>>(new Set())
  const peekPaneIdRef = useRef<string | null>(null)
  const paneResizeDragRef = useRef<{
    leftPaneId: string
    rightPaneId: string
    startX: number
    totalWidth: number
    startLeftWidth: number
    startTotalWeight: number
  } | null>(null)
  const batchAbortMapRef = useRef<Map<string, { aborted: boolean }>>(new Map())
  const prefetchedPagesRef = useRef<Set<string>>(new Set())
  const explainRequestIdRef = useRef(0)
  const peekRequestIdRef = useRef(0)
  const pendingJumpRef = useRef<{ documentId: string; pageNumber: number } | null>(null)
  const explainAnchorRef = useRef<{
    paneId: string
    documentId: string
    pageNumber: number
    rects: PageRect[]
    sentenceIds: string[]
  } | null>(null)
  const readerPanelRef = useRef<HTMLElement | null>(null)
  const workspaceRef = useRef<HTMLElement | null>(null)
  const backdropMapRef = useRef<Map<number, PageBackdropSnapshot>>(new Map())
  const queriedCachePagesRef = useRef<Set<number>>(new Set())
  const autoTitleAttemptedRef = useRef<Set<string>>(new Set())
  const autoTranslateRequestedDocumentRef = useRef<string | null>(null)
  const autoTranslateEvaluatedRef = useRef<Set<string>>(new Set())
  const autoTranslateInFlightRef = useRef<Set<string>>(new Set())
  const settingsFromUnconfiguredPromptRef = useRef<string | null>(null)
  const layoutsRef = useRef<Map<number, PageLayoutResult>>(new Map())
  const translationsByPageRef = useRef<Map<number, Map<string, TranslatedBlockRecord>>>(new Map())
  translationsByPageRef.current = translationsByPage
  const translatingPagesByDocIdRef = useRef(translatingPagesByDocId)
  translatingPagesByDocIdRef.current = translatingPagesByDocId
  const batchQueuesByDocIdRef = useRef(batchQueuesByDocId)
  batchQueuesByDocIdRef.current = batchQueuesByDocId

  const selectedDocumentId = library.selected?.id ?? null
  const selectedDocumentIdRef = useRef<string | null>(selectedDocumentId)
  selectedDocumentIdRef.current = selectedDocumentId
  const viewMode: ReaderViewMode = resolveDocumentViewMode(docViewModes, selectedDocumentId)
  const viewModeRef = useRef<ReaderViewMode>(viewMode)
  viewModeRef.current = viewMode

  const persistDocViewMode = useCallback((docId: string, mode: ReaderViewMode): void => {
    setDocViewModes(prev => {
      if (prev[docId] === mode) return prev
      const next: Record<string, ReaderViewMode> = { ...prev, [docId]: mode }
      try {
        localStorage.setItem(DOC_VIEW_MODES_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // 忽略存储配额限制
      }
      return next
    })
  }, [])

  const setViewMode = useCallback(
    (updater: ReaderViewMode | ((curr: ReaderViewMode) => ReaderViewMode), requestPretranslation = false): void => {
      const targetDocId = selectedDocumentIdRef.current
      if (!targetDocId) return
      const nextMode = typeof updater === 'function' ? updater(viewModeRef.current) : updater
      if (nextMode === 'dual' && requestPretranslation) {
        autoTranslateRequestedDocumentRef.current = targetDocId
        setAutoTranslateRetryTick(tick => tick + 1)
      } else if (nextMode !== 'dual') {
        autoTranslateRequestedDocumentRef.current = null
        setUnconfiguredPrompt(null)
      }
      persistDocViewMode(targetDocId, nextMode)
    },
    [persistDocViewMode]
  )

  const translatingPage = selectedDocumentId ? (translatingPagesByDocId[selectedDocumentId] ?? null) : null
  const batchQueue = selectedDocumentId ? (batchQueuesByDocId[selectedDocumentId] ?? null) : null

  const handlePrefetchNextPageChange = useCallback((enabled: boolean): void => {
    setPrefetchNextPage(enabled)
    try {
      localStorage.setItem(PREFETCH_NEXT_PAGE_STORAGE_KEY, enabled ? 'true' : 'false')
    } catch {
      // 忽略存储配额限制
    }
  }, [])

  useEffect(() => {
    if (!batchOptionsOpen && !translationExportOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.translation-toolbar-anchor')) return
      setBatchOptionsOpen(false)
      setTranslationExportOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setBatchOptionsOpen(false)
        setTranslationExportOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [batchOptionsOpen, translationExportOpen])

  const setDocTranslatingPage = useCallback((docId: string, pageNumber: number | null): void => {
    setTranslatingPagesByDocId(prev => {
      if (pageNumber === null) {
        if (!(docId in prev)) return prev
        const next = { ...prev }
        delete next[docId]
        return next
      }
      if (prev[docId] === pageNumber) return prev
      return { ...prev, [docId]: pageNumber }
    })
  }, [])

  const docById = useMemo(() => new Map(library.documents.map(doc => [doc.id, doc])), [library.documents])
  const docByIdRef = useRef(docById)
  docByIdRef.current = docById
  const translationSettingsRef = useRef(translationSettings)
  translationSettingsRef.current = translationSettings
  const providerBalanceRef = useRef(providerBalance)
  providerBalanceRef.current = providerBalance
  const usageSummaryRef = useRef(usageSummary)
  usageSummaryRef.current = usageSummary

  const refreshUsageAndBalance = useCallback(async (opts?: { refreshBalance?: boolean }): Promise<UsageStatsSummary | null> => {
    const [summary, balance] = await Promise.all([
      window.paperflow.getUsageSummary().catch(() => null),
      opts?.refreshBalance !== false ? window.paperflow.getProviderBalance().catch(() => null) : Promise.resolve(null)
    ])
    if (summary) setUsageSummary(summary)
    if (balance) setProviderBalance(balance)
    return summary
  }, [])

  const handleTranslationCompleted = useCallback(
    async (
      docId: string,
      result: TranslatePageResult,
      options?: { suppressToast?: boolean; pageCountOverride?: number }
    ): Promise<void> => {
      setUnconfiguredPrompt(null)
      if (result.balance) {
        setProviderBalance(result.balance)
      }
      const latestSummary = await window.paperflow.getUsageSummary().catch(() => null)
      if (latestSummary) {
        setUsageSummary(latestSummary)
      }
      if (!options?.suppressToast && result.translatedCount > 0) {
        const doc = docByIdRef.current.get(docId)
        setUsageToast(
          buildTranslationCompletionToast({
            result,
            documentTitle: doc?.displayTitle || doc?.originalFilename,
            isBackground: docId !== selectedDocumentIdRef.current,
            settings: translationSettingsRef.current,
            balance: result.balance ?? providerBalanceRef.current,
            usageSummary: latestSummary ?? usageSummaryRef.current,
            pageCountOverride: options?.pageCountOverride
          })
        )
      }
    },
    []
  )

  const handleTranslationErrorToast = useCallback((message: string): void => {
    if (/HTTP 402|余额不足/.test(message)) {
      setUsageToast(buildLowBalanceErrorToast(message))
      void window.paperflow.getProviderBalance().then(setProviderBalance).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!usageToast) return
    const timer = window.setTimeout(() => {
      setUsageToast(null)
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [usageToast])

  useEffect(() => {
    if (library.loading || library.loadError) return
    const validIds = new Set(library.documents.map(doc => doc.id))
    setTranslatingPagesByDocId(prev => {
      const staleIds = Object.keys(prev).filter(id => !validIds.has(id))
      if (staleIds.length === 0) return prev
      for (const id of staleIds) {
        void window.paperflow.cancelTranslation(id).catch(() => {})
      }
      const next: Record<string, number> = {}
      for (const [id, page] of Object.entries(prev)) {
        if (validIds.has(id)) next[id] = page
      }
      return next
    })
    setOpenTabIds(prev => {
      const filtered = prev.filter(id => validIds.has(id))
      const next =
        selectedDocumentId && validIds.has(selectedDocumentId) && !filtered.includes(selectedDocumentId)
          ? [...filtered, selectedDocumentId]
          : filtered
      if (next.length === prev.length && next.every((v, i) => v === prev[i])) return prev
      return next
    })
    setSplitPanes(prev => {
      const filtered = prev.filter(p => validIds.has(p.documentId))
      if (filtered.length >= 2) {
        if (filtered.length === prev.length && filtered.every((p, i) => p === prev[i])) return prev
        return filtered
      }
      if (selectedDocumentId && validIds.has(selectedDocumentId)) {
        if (filtered.length === 1 && filtered[0].documentId === selectedDocumentId) return filtered
        return [{ id: filtered[0]?.id ?? PRIMARY_PANE_ID, documentId: selectedDocumentId, weight: 1 }]
      }
      return filtered.length === prev.length ? prev : filtered
    })
  }, [library.documents, library.loading, library.loadError, selectedDocumentId])

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_TABS_STORAGE_KEY, JSON.stringify(openTabIds))
    } catch {
      // 忽略存储配额限制
    }
  }, [openTabIds])

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_PANES_STORAGE_KEY, JSON.stringify(splitPanes))
    } catch {
      // 忽略存储配额限制
    }
  }, [splitPanes])

  const openTabs = useMemo(() => {
    return openTabIds.map(id => docById.get(id)).filter((d): d is DocumentRecord => Boolean(d))
  }, [openTabIds, docById])

  const resolvedPanes = useMemo(() => {
    const valid = splitPanes
      .map(pane => {
        const doc = docById.get(pane.documentId)
        return doc ? { pane, document: doc } : null
      })
      .filter((item): item is { pane: SplitPane; document: DocumentRecord } => Boolean(item))
    if (valid.length === 0 && library.selected) {
      return [{ pane: { id: PRIMARY_PANE_ID, documentId: library.selected.id, weight: 1 }, document: library.selected }]
    }
    return valid
  }, [splitPanes, docById, library.selected])

  const primaryPane = resolvedPanes[0] ?? null
  const primaryPaneId = primaryPane?.pane.id ?? PRIMARY_PANE_ID
  const isCompareMode = resolvedPanes.length >= 2
  const isCompareModeRef = useRef(isCompareMode)
  isCompareModeRef.current = isCompareMode
  const effectiveActivePaneId = resolvedPanes.some(item => item.pane.id === activePaneId)
    ? activePaneId
    : primaryPaneId
  const activePaneItem =
    resolvedPanes.find(item => item.pane.id === effectiveActivePaneId) ?? resolvedPanes[0] ?? null
  const activeDocument = activePaneItem?.document ?? library.selected ?? null
  const activeDocumentId = activeDocument?.id ?? null
  const activeDocumentIdRef = useRef<string | null>(activeDocumentId)
  activeDocumentIdRef.current = activeDocumentId
  const primaryPaneViewMode: SplitPaneViewMode = primaryPane ? getPaneViewMode(primaryPane.pane) : 'source'
  const effectivePrimaryViewMode: ReaderViewMode = isCompareMode ? primaryPaneViewMode : viewMode

  const clearOtherSecondarySelections = useCallback((exceptPaneId?: string): void => {
    for (const [id, handle] of paneStudyHandlesRef.current.entries()) {
      if (id !== exceptPaneId) {
        handle.clearSelection()
      }
    }
  }, [])

  const handleChangePaneViewMode = useCallback((paneId: string, nextMode: SplitPaneViewMode): void => {
    setSplitPanes(prev => setSplitPaneViewMode(prev, paneId, nextMode))
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_WIDTH_STORAGE_KEY, String(libraryWidthPx))
    } catch {
      // 忽略存储配额限制
    }
  }, [libraryWidthPx])

  const handleLibraryResizerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.classList.add('is-dragging')
      libraryResizeDragRef.current = { startX: event.clientX, startWidth: libraryWidthPx }
    },
    [libraryWidthPx]
  )

  const handleLibraryResizerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = libraryResizeDragRef.current
    if (!drag) return
    setLibraryWidthPx(clampLibraryWidth(drag.startWidth + (event.clientX - drag.startX)))
  }, [])

  const handleLibraryResizerPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!libraryResizeDragRef.current) return
    libraryResizeDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.currentTarget.classList.remove('is-dragging')
  }, [])

  const effectiveExpandedPaneId =
    isCompareMode && expandedPaneId && resolvedPanes.some(r => r.pane.id === expandedPaneId) ? expandedPaneId : null

  useEffect(() => {
    if (!isCompareMode) {
      setStageOverflow(prev => (prev.left || prev.right ? { left: false, right: false } : prev))
      return
    }
    const el = splitStageRef.current
    if (!el) return
    const update = (): void => {
      const left = el.scrollLeft > 2
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
      setStageOverflow(prev => (prev.left === left && prev.right === right ? prev : { left, right }))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    observer?.observe(el)
    for (const child of Array.from(el.children)) observer?.observe(child)
    return () => {
      el.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [isCompareMode, resolvedPanes.length, effectiveExpandedPaneId, splitPanes])

  const syncPrimarySelected = useCallback(
    (nextPanes: readonly SplitPane[]): void => {
      const firstDocId = nextPanes[0]?.documentId
      if (firstDocId && firstDocId !== selectedDocumentIdRef.current) {
        library.select(firstDocId)
      }
    },
    [library]
  )

  const getPaneToolbarRef = useCallback((paneId: string): MutableRefObject<ReaderToolbarActions | null> => {
    let ref = paneToolbarRefs.current.get(paneId)
    if (!ref) {
      ref = { current: null }
      paneToolbarRefs.current.set(paneId, ref)
    }
    return ref
  }, [])

  const getPaneExtractTextRef = useCallback(
    (paneId: string): MutableRefObject<((pageNumber: number) => Promise<string | null>) | null> => {
      let ref = paneExtractTextRefs.current.get(paneId)
      if (!ref) {
        ref = { current: null }
        paneExtractTextRefs.current.set(paneId, ref)
      }
      return ref
    },
    []
  )

  const handleRegisterStudyHandle = useCallback((paneId: string, handle: PaneStudyHandle | null): void => {
    if (handle) paneStudyHandlesRef.current.set(paneId, handle)
    else paneStudyHandlesRef.current.delete(paneId)
  }, [])

  const handleSecondarySelectionChange = useCallback(
    (paneId: string, selection: PaneSelectionSnapshot | null): void => {
      if (selection) {
        if (expectEditingSyncPaneRef.current === paneId) {
          expectEditingSyncPaneRef.current = null
        } else {
          setEditingAnnotation(null)
        }
        setActiveLink(null)
        clearOtherSecondarySelections(paneId)
        setActivePaneId(paneId)
        setSecondarySelection(selection)
        return
      }
      setEditingAnnotation(prev => (prev?.paneId === paneId ? null : prev))
      setSecondarySelection(prev => (prev?.paneId === paneId ? null : prev))
    },
    [clearOtherSecondarySelections]
  )

  const handleOpenDocument = useCallback(
    (docId: string): void => {
      setOpenTabIds(prev => (prev.includes(docId) ? prev : [...prev, docId]))
      if (resolvedPanes.length >= 2) {
        const existingPane = resolvedPanes.find(item => item.document.id === docId)
        if (existingPane) {
          setActivePaneId(existingPane.pane.id)
          return
        }
        setSplitPanes(prev => {
          const base = prev.length > 0 ? prev : resolvedPanes.map(item => item.pane)
          return base.map(p => (p.id === effectiveActivePaneId ? { ...p, documentId: docId } : p))
        })
        if (effectiveActivePaneId === primaryPaneId) {
          library.select(docId)
        }
        return
      }
      setSplitPanes([{ id: primaryPaneId, documentId: docId, weight: 1 }])
      setActivePaneId(primaryPaneId)
      library.select(docId)
    },
    [resolvedPanes, effectiveActivePaneId, primaryPaneId, library]
  )

  const handleOpenInSplit = useCallback(
    (docId: string): void => {
      setOpenTabIds(prev => {
        const next = [...prev]
        if (library.selected && !next.includes(library.selected.id)) next.push(library.selected.id)
        if (!next.includes(docId)) next.push(docId)
        return next
      })
      if (!library.selected) {
        setSplitPanes([{ id: PRIMARY_PANE_ID, documentId: docId, weight: 1 }])
        setActivePaneId(PRIMARY_PANE_ID)
        library.select(docId)
        return
      }
      const existing = resolvedPanes.find(item => item.document.id === docId)
      if (existing && resolvedPanes.length >= 2) {
        setActivePaneId(existing.pane.id)
        return
      }
      const newId = createSplitPaneId()
      setSplitPanes(prev => {
        const base =
          prev.length > 0
            ? prev
            : [{ id: PRIMARY_PANE_ID, documentId: library.selected!.id, weight: 1 }]
        return [...normalizePaneWeights(base), { id: newId, documentId: docId, weight: 1 }]
      })
      setActivePaneId(newId)
    },
    [library, resolvedPanes]
  )

  const handleToggleCompareMode = useCallback((): void => {
    if (!library.selected) return
    if (resolvedPanes.length >= 2) {
      const keep =
        resolvedPanes.find(item => item.pane.id === effectiveActivePaneId) ?? resolvedPanes[0]
      if (keep.pane.viewMode === 'source' || keep.pane.viewMode === 'dual' || keep.pane.viewMode === 'translation') {
        persistDocViewMode(keep.document.id, keep.pane.viewMode)
      }
      setSplitPanes([{ id: PRIMARY_PANE_ID, documentId: keep.document.id, weight: 1 }])
      setActivePaneId(PRIMARY_PANE_ID)
      library.select(keep.document.id)
      return
    }
    const primaryId = library.selected.id
    const candidate =
      openTabs.find(t => t.id !== primaryId)?.id ??
      library.documents.find(d => d.id !== primaryId)?.id ??
      primaryId
    setOpenTabIds(prev => {
      const next = prev.includes(primaryId) ? [...prev] : [...prev, primaryId]
      if (!next.includes(candidate)) next.push(candidate)
      return next
    })
    const newId = createSplitPaneId()
    setSplitPanes([
      { id: PRIMARY_PANE_ID, documentId: primaryId, weight: 1, viewMode: viewModeRef.current },
      { id: newId, documentId: candidate, weight: 1 }
    ])
    setActivePaneId(newId)
  }, [library, resolvedPanes, effectiveActivePaneId, openTabs, persistDocViewMode])

  const handleCloseTab = useCallback(
    (docId: string): void => {
      const remaining = openTabIds.filter(id => id !== docId)
      setOpenTabIds(remaining)
      const remainingPanes = resolvedPanes.map(r => r.pane).filter(p => p.documentId !== docId)
      if (remainingPanes.length > 0) {
        setSplitPanes(remainingPanes)
        if (!remainingPanes.some(p => p.id === activePaneId)) {
          setActivePaneId(remainingPanes[0].id)
        }
        if (remainingPanes[0].documentId !== library.selected?.id) {
          library.select(remainingPanes[0].documentId)
        }
      } else if (remaining.length > 0) {
        const nextDocId = remaining[remaining.length - 1]
        setSplitPanes([{ id: PRIMARY_PANE_ID, documentId: nextDocId, weight: 1 }])
        setActivePaneId(PRIMARY_PANE_ID)
        library.select(nextDocId)
      } else {
        setSplitPanes([])
      }
    },
    [openTabIds, resolvedPanes, activePaneId, library]
  )

  const handlePaneResizerPointerDown = useCallback(
    (rightPaneId: string, event: ReactPointerEvent<HTMLDivElement>): void => {
      const rightEl = event.currentTarget.closest<HTMLElement>('.reader-panel')
      const leftEl = rightEl?.previousElementSibling as HTMLElement | null
      const leftPaneId = leftEl?.dataset.paneId
      if (!leftEl || !rightEl || !leftPaneId) return
      const leftWidth = leftEl.getBoundingClientRect().width
      const rightWidth = rightEl.getBoundingClientRect().width
      const totalWidth = leftWidth + rightWidth
      if (totalWidth <= 0) return
      const leftWeight = resolvedPanes.find(r => r.pane.id === leftPaneId)?.pane.weight ?? 1
      const rightWeight = resolvedPanes.find(r => r.pane.id === rightPaneId)?.pane.weight ?? 1
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.classList.add('is-dragging')
      paneResizeDragRef.current = {
        leftPaneId,
        rightPaneId,
        startX: event.clientX,
        totalWidth,
        startLeftWidth: leftWidth,
        startTotalWeight: leftWeight + rightWeight
      }
    },
    [resolvedPanes]
  )

  const handlePaneResizerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = paneResizeDragRef.current
    if (!drag || drag.totalWidth <= 0) return
    const delta = event.clientX - drag.startX
    const ratio = Math.max(0.2, Math.min(0.8, (drag.startLeftWidth + delta) / drag.totalWidth))
    const leftWeight = Number((drag.startTotalWeight * ratio).toFixed(4))
    const rightWeight = Number((drag.startTotalWeight - leftWeight).toFixed(4))
    setSplitPanes(prev =>
      prev.map(p =>
        p.id === drag.leftPaneId
          ? { ...p, weight: leftWeight }
          : p.id === drag.rightPaneId
            ? { ...p, weight: rightWeight }
            : p
      )
    )
  }, [])

  const handlePaneResizerPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!paneResizeDragRef.current) return
    paneResizeDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.currentTarget.classList.remove('is-dragging')
  }, [])

  const handleResetPaneWeights = useCallback((): void => {
    setSplitPanes(prev => prev.map(p => ({ ...p, weight: 1 })))
  }, [])

  const handlePaneDragOver = useCallback((targetPaneId: string, event: DragEvent<HTMLElement>): void => {
    if (hasDraggedFiles(event.dataTransfer)) return
    const source = parseDraggedSplitSource(event.dataTransfer)
    if (!source) return
    if (source.kind === 'pane' && source.paneId === targetPaneId) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const zone = computeDropZone(event.clientX, event.currentTarget.getBoundingClientRect())
    setDragHover(prev =>
      prev && prev.targetPaneId === targetPaneId && prev.zone === zone && prev.sourceKind === source.kind
        ? prev
        : { targetPaneId, zone, sourceKind: source.kind }
    )
  }, [])

  const handlePaneDragLeave = useCallback((targetPaneId: string, event: DragEvent<HTMLElement>): void => {
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) return
    setDragHover(prev => (prev?.targetPaneId === targetPaneId ? null : prev))
  }, [])

  const handlePaneDrop = useCallback(
    (targetPaneId: string, event: DragEvent<HTMLElement>): void => {
      if (hasDraggedFiles(event.dataTransfer)) return
      const source = parseDraggedSplitSource(event.dataTransfer)
      setDragHover(null)
      setActiveWorkspaceDrag(null)
      if (!source) return
      event.preventDefault()
      event.stopPropagation()

      const zone = computeDropZone(event.clientX, event.currentTarget.getBoundingClientRect())
      const basePanes =
        splitPanes.length > 0
          ? splitPanes
          : resolvedPanes.map(item => item.pane)

      if (source.kind === 'pane' && source.paneId) {
        const nextPanes = dropPaneOntoPane(basePanes, source.paneId, targetPaneId, zone)
        setSplitPanes(nextPanes)
        setActivePaneId(source.paneId)
        syncPrimarySelected(nextPanes)
        return
      }

      if (source.kind === 'doc' && source.documentId) {
        setOpenTabIds(prev => (prev.includes(source.documentId) ? prev : [...prev, source.documentId]))
        const newId = createSplitPaneId()
        const nextPanes = dropDocumentIntoPanes(basePanes, source.documentId, targetPaneId, zone, () => newId)
        setSplitPanes(nextPanes)
        setActivePaneId(zone === 'center' ? targetPaneId : newId)
        syncPrimarySelected(nextPanes)
      }
    },
    [splitPanes, resolvedPanes, syncPrimarySelected]
  )

  const handleTranslationDragOver = useCallback((event: DragEvent<HTMLElement>): void => {
    if (hasDraggedFiles(event.dataTransfer)) return
    const source = parseDraggedSplitSource(event.dataTransfer)
    if (!source || source.kind !== 'doc') return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDragHover(prev =>
      prev && prev.targetPaneId === 'translation'
        ? prev
        : { targetPaneId: 'translation', zone: 'right', sourceKind: 'doc' }
    )
  }, [])

  const handleTranslationDragLeave = useCallback((event: DragEvent<HTMLElement>): void => {
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) return
    setDragHover(prev => (prev?.targetPaneId === 'translation' ? null : prev))
  }, [])

  const handleTranslationDrop = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (hasDraggedFiles(event.dataTransfer)) return
      const source = parseDraggedSplitSource(event.dataTransfer)
      setDragHover(null)
      setActiveWorkspaceDrag(null)
      if (!source || source.kind !== 'doc' || !source.documentId) return
      event.preventDefault()
      event.stopPropagation()
      setOpenTabIds(prev => {
        const next = [...prev]
        if (library.selected && !next.includes(library.selected.id)) next.push(library.selected.id)
        if (!next.includes(source.documentId)) next.push(source.documentId)
        return next
      })
      const newId = createSplitPaneId()
      const base =
        splitPanes.length > 0
          ? splitPanes
          : library.selected
            ? [{ id: PRIMARY_PANE_ID, documentId: library.selected.id, weight: 1 }]
            : []
      setSplitPanes([...normalizePaneWeights(base), { id: newId, documentId: source.documentId, weight: 1 }])
      setActivePaneId(newId)
    },
    [library.selected, splitPanes]
  )

  useEffect(() => {
    let cancelled = false
    void window.paperflow
      .getTranslationSettings()
      .then(settings => {
        if (!cancelled) setTranslationSettings(settings)
      })
      .catch(() => {})
    void window.paperflow
      .getUsageSummary()
      .then(summary => {
        if (!cancelled) setUsageSummary(summary)
      })
      .catch(() => {})
    void window.paperflow
      .getProviderBalance()
      .then(balance => {
        if (!cancelled) setProviderBalance(balance)
      })
      .catch(() => {})
    void window.paperflow
      .getResearchProfile()
      .then(profile => {
        if (cancelled) return
        setResearchProfile(profile)
        if (!profile || !profile.completed) {
          setOnboardingOpen(true)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setOnboardingReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const clearAllBackdrops = useCallback((): void => {
    for (const snap of backdropMapRef.current.values()) {
      snap.bitmap.close()
    }
    backdropMapRef.current.clear()
    setBackdrops(new Map())
  }, [])

  useEffect(() => {
    if (autoTranslateRequestedDocumentRef.current !== selectedDocumentId) autoTranslateRequestedDocumentRef.current = null
    queriedCachePagesRef.current.clear()
    explainRequestIdRef.current += 1
    peekRequestIdRef.current += 1
    setRawLayouts(new Map())
    clearAllBackdrops()
    setTranslationsByPage(new Map())
    setBatchOptionsOpen(false)
    setTranslationExportOpen(false)
    setRetranslatingBlockKeys(new Set())
    setTranslationError(null)
    setUnconfiguredPrompt(null)
    setActiveLink(null)
    setEditingAnnotation(null)
    setExplainState(null)
    setPeekState(null)
    setPeekPinned(false)
    setReturnTarget(null)
    setCitationOpen(false)
    outlineRequestIdRef.current += 1
    setMirrorState(INITIAL_MIRROR_STATE)
    return () => {
      // 切换 PDF 时保留正在后台执行的连续翻译队列，仅清理当前页渲染底图
      clearAllBackdrops()
    }
  }, [selectedDocumentId, clearAllBackdrops])

  const openAnnotationDocIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of resolvedPanes) {
      ids.add(item.document.id)
    }
    if (selectedDocumentId) {
      ids.add(selectedDocumentId)
    }
    return Array.from(ids)
  }, [resolvedPanes, selectedDocumentId])
  const openAnnotationDocIdsKey = openAnnotationDocIds.join('|')

  useEffect(() => {
    if (library.documents.length === 0) {
      loadedAnnotationDocsRef.current.clear()
      setAnnotationsByDocId(new Map())
      setAnnotationsOpen(false)
      return
    }
    const validIds = new Set(library.documents.map(d => d.id))
    for (const cachedId of Array.from(loadedAnnotationDocsRef.current)) {
      if (!validIds.has(cachedId)) {
        loadedAnnotationDocsRef.current.delete(cachedId)
      }
    }
    for (const docId of openAnnotationDocIds) {
      if (loadedAnnotationDocsRef.current.has(docId)) continue
      loadedAnnotationDocsRef.current.add(docId)
      void window.paperflow
        .listAnnotations(docId)
        .then(items => {
          setAnnotationsByDocId(prev => {
            const next = new Map(prev)
            next.set(docId, items)
            return next
          })
        })
        .catch(() => {
          loadedAnnotationDocsRef.current.delete(docId)
        })
    }
  }, [openAnnotationDocIds, openAnnotationDocIdsKey, library.documents])

  useEffect(() => {
    setSecondarySelection(prev => {
      if (!prev) return prev
      const match = resolvedPanes.find(r => r.pane.id === prev.paneId)
      if (!match || match.document.id !== prev.documentId) {
        return null
      }
      return prev
    })
  }, [resolvedPanes])

  const activeDocFolderId = activeDocument?.folderId ?? null

  const refreshDocumentScope = useCallback(async (docId: string | null): Promise<void> => {
    if (!docId) {
      setDocumentScope(null)
      return
    }
    try {
      const scope = await window.paperflow.getDocumentTranslationScope(docId)
      if (activeDocumentIdRef.current === docId) {
        setDocumentScope(scope)
      }
    } catch {
      if (activeDocumentIdRef.current === docId) {
        setDocumentScope(null)
      }
    }
  }, [])

  useEffect(() => {
    void refreshDocumentScope(activeDocumentId)
  }, [activeDocumentId, activeDocFolderId, library.folders, refreshDocumentScope])

  const selectedDocForAutoTitle = library.selected
  useEffect(() => {
    if (!selectedDocForAutoTitle) return
    const docId = selectedDocForAutoTitle.id
    if (autoTitleAttemptedRef.current.has(docId)) return
    const defaultStem =
      selectedDocForAutoTitle.originalFilename.replace(/\.pdf$/i, '') ||
      selectedDocForAutoTitle.originalFilename
    if (
      selectedDocForAutoTitle.displayTitle !== defaultStem ||
      !isLikelyMessyAcademicFilename(defaultStem)
    ) {
      return
    }
    autoTitleAttemptedRef.current.add(docId)
    let cancelled = false
    void (async () => {
      try {
        const bytes = await window.paperflow.readPdfBytes(docId)
        if (cancelled || selectedDocumentIdRef.current !== docId) return
        const detected = await extractTitleFromPdfBytes(bytes, selectedDocForAutoTitle.displayTitle)
        if (cancelled || selectedDocumentIdRef.current !== docId || !detected) return
        await library.renameDocument(docId, detected)
      } catch {
        // 无法识别标题时保留原文件名
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDocForAutoTitle?.id])

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_STORAGE_KEY, theme)
    void window.paperflow?.setWindowTheme?.(theme).catch(() => {})
  }, [theme])

  const updateLocalProgress = library.updateLocalProgress
  useEffect(() => {
    if (selectedDocumentId && mirrorState.pageCount > 0 && mirrorState.currentPage >= 1) {
      updateLocalProgress(selectedDocumentId, mirrorState.currentPage)
    }
  }, [selectedDocumentId, mirrorState.pageCount, mirrorState.currentPage, updateLocalProgress])

  useEffect(() => {
    const pending = pendingJumpRef.current
    if (!pending || pending.documentId !== selectedDocumentId || mirrorState.pageCount <= 0 || mirrorState.toolbarDisabled) {
      return
    }
    pendingJumpRef.current = null
    navigateToPageRef.current?.(pending.pageNumber)
  }, [selectedDocumentId, mirrorState.pageCount, mirrorState.toolbarDisabled])

  useEffect(() => {
    return window.paperflow.onTranslationProgress(event => {
      if (selectedDocumentIdRef.current !== event.documentId || event.items.length === 0) return
      setTranslationsByPage(prev => mergePageTranslationRecords(prev, event.pageNumber, event.items))
    })
  }, [])

  const layouts = useMemo(() => refineDocumentHeadersFooters(rawLayouts), [rawLayouts])
  layoutsRef.current = layouts

  const handlePageLayout = useCallback((pageNumber: number, result: PageLayoutResult | null): void => {
    if (!result) return
    setRawLayouts(prev => {
      if (isSamePageLayout(prev.get(pageNumber), result)) {
        return prev
      }
      const next = new Map(prev)
      next.set(pageNumber, result)
      return next
    })
  }, [])

  const handlePageBackdrop = useCallback((pageNumber: number, snapshot: PageBackdropSnapshot | null): void => {
    const existing = backdropMapRef.current.get(pageNumber)
    if (existing && existing.bitmap !== snapshot?.bitmap) {
      existing.bitmap.close()
    }
    if (snapshot) {
      backdropMapRef.current.set(pageNumber, snapshot)
    } else {
      backdropMapRef.current.delete(pageNumber)
    }
    setBackdrops(new Map(backdropMapRef.current))
  }, [])

  const loadPageCache = useCallback(async (documentId: string, pageNumber: number): Promise<void> => {
    try {
      const records = await window.paperflow.getPageTranslations(documentId, pageNumber)
      if (selectedDocumentIdRef.current !== documentId || records.length === 0) return
      setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, records))
    } catch {
      // 忽略页面切换瞬间的缓存读取错误
    }
  }, [])

  const handleTranslationVisiblePages = useCallback((pages: readonly number[]): void => {
    if (!selectedDocumentId || selectedDocumentIdRef.current !== selectedDocumentId) return
    setTranslationVisiblePages(previous =>
      previous?.documentId === selectedDocumentId && previous.pages.length === pages.length &&
      previous.pages.every((page, index) => page === pages[index])
        ? previous : { documentId: selectedDocumentId, pages }
    )
  }, [selectedDocumentId])

  const visibleTranslationPages = translationVisiblePages?.documentId === selectedDocumentId
    ? translationVisiblePages.pages : undefined

  useEffect(() => {
    if (!selectedDocumentId || !visibleTranslationPages || effectivePrimaryViewMode === 'source') return
    for (const pageNumber of visibleTranslationPages) {
      if (queriedCachePagesRef.current.has(pageNumber)) continue
      queriedCachePagesRef.current.add(pageNumber)
      void loadPageCache(selectedDocumentId, pageNumber)
    }
  }, [selectedDocumentId, visibleTranslationPages, effectivePrimaryViewMode, loadPageCache])

  // 翻页时清理前一页遗留的翻译错误横幅，并预读邻近页 SQLite 缓存
  useEffect(() => {
    setTranslationError(null)
  }, [mirrorState.currentPage])

  useEffect(() => {
    if (!selectedDocumentId || mirrorState.pageCount <= 0) return
    const minPage = Math.max(1, mirrorState.currentPage - 1)
    const maxPage = Math.min(mirrorState.pageCount, mirrorState.currentPage + 1)
    for (let p = minPage; p <= maxPage; p += 1) {
      if (!queriedCachePagesRef.current.has(p)) {
        queriedCachePagesRef.current.add(p)
        void loadPageCache(selectedDocumentId, p)
      }
    }
  }, [selectedDocumentId, mirrorState.currentPage, mirrorState.pageCount, loadPageCache])

  const handleTranslatePage = useCallback(
    async (pageNumber: number, force = false): Promise<void> => {
      const targetDocumentId = selectedDocumentId
      if (!targetDocumentId) return
      const blocks = buildPageTranslationInputs(layouts.get(pageNumber))
      if (blocks.length === 0) return

      setTranslationError(null)
      setDocTranslatingPage(targetDocumentId, pageNumber)
      try {
        const context = buildPageTranslationContext(
          layouts,
          pageNumber,
          translationsByPageRef.current
        )
        const result = await window.paperflow.translatePage({
          documentId: targetDocumentId,
          pageNumber,
          blocks,
          force,
          ...(context ? { context } : {})
        })
        void handleTranslationCompleted(targetDocumentId, result)
        if (selectedDocumentIdRef.current !== targetDocumentId) return
        setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, result.items))
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/已取消/.test(message)) {
          handleTranslationErrorToast(message)
        }
        if (selectedDocumentIdRef.current === targetDocumentId) {
          void loadPageCache(targetDocumentId, pageNumber)
          if (!/已取消/.test(message)) {
            setTranslationError(message)
          }
        }
      } finally {
        setTranslatingPagesByDocId(prev => {
          if (prev[targetDocumentId] !== pageNumber) return prev
          const next = { ...prev }
          delete next[targetDocumentId]
          return next
        })
      }
    },
    [selectedDocumentId, layouts, loadPageCache, setDocTranslatingPage, handleTranslationCompleted, handleTranslationErrorToast]
  )

  const setDocBatchQueue = useCallback((docId: string, progress: BatchQueueProgress | null): void => {
    setBatchQueuesByDocId(prev => {
      if (progress === null) {
        if (!(docId in prev)) return prev
        const next = { ...prev }
        delete next[docId]
        return next
      }
      return { ...prev, [docId]: progress }
    })
  }, [])

  const analyzeStandalonePdfPage = useCallback(async (pdf: PDFDocumentProxy, pageNumber: number): Promise<PageLayoutResult | null> => {
    if (pageNumber < 1 || pageNumber > pdf.numPages) return null
    const pageObj = await pdf.getPage(pageNumber)
    try {
      const viewport = pageObj.getViewport({ scale: 1 })
      const geometry: PageGeometry = {
        pageNumber,
        viewport,
        outputScale: { x: 1, y: 1 }
      }
      const textContent = (await pageObj.getTextContent({ includeMarkedContent: true })) as Parameters<
        typeof analyzePageLayout
      >[0]
      const operatorList = await pageObj.getOperatorList().catch(() => null)
      const graphicHints = operatorList
        ? extractPageGraphicHints(operatorList as unknown as PdfOperatorListLike, geometry)
        : undefined
      return analyzePageLayout(textContent, geometry, { graphicHints })
    } finally {
      if (!pageObj.destroyed) pageObj.cleanup()
    }
  }, [])

  const handleCancelTranslation = useCallback((targetDocId?: string): void => {
    const docId = targetDocId ?? selectedDocumentIdRef.current ?? undefined
    if (docId) {
      const token = batchAbortMapRef.current.get(docId)
      if (token) token.aborted = true
      setDocBatchQueue(docId, null)
      setDocTranslatingPage(docId, null)
    } else {
      for (const token of batchAbortMapRef.current.values()) {
        token.aborted = true
      }
      setBatchQueuesByDocId({})
    }
    void window.paperflow.cancelTranslation(docId).catch(() => {})
  }, [setDocBatchQueue, setDocTranslatingPage])

  const handleEditBlockTranslation = useCallback(
    async (pageNumber: number, blockKey: string, sourceHash: string, translatedText: string): Promise<void> => {
      const targetDocumentId = selectedDocumentIdRef.current
      if (!targetDocumentId) return
      const source = buildSingleBlockTranslationInput(layoutsRef.current.get(pageNumber), blockKey)
      if (source?.sourceHash === sourceHash && !matchesFormulaPlaceholders(source.sourceText, translatedText)) {
        throw new Error('请保留译文中的所有公式占位符。')
      }
      const updated = await window.paperflow.updateBlockTranslation({
        documentId: targetDocumentId,
        pageNumber,
        blockId: blockKey,
        sourceHash,
        translatedText
      })
      if (selectedDocumentIdRef.current !== targetDocumentId) return
      setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, [updated]))
    },
    []
  )

  const handleRetranslateBlock = useCallback(
    async (pageNumber: number, blockKey: string): Promise<void> => {
      const targetDocumentId = selectedDocumentId
      if (!targetDocumentId) return
      const input = buildSingleBlockTranslationInput(layoutsRef.current.get(pageNumber), blockKey)
      if (!input) return

      setTranslationError(null)
      setRetranslatingBlockKeys(prev => {
        const next = new Set(prev)
        next.add(blockKey)
        return next
      })
      try {
        const context = buildPageTranslationContext(
          layoutsRef.current,
          pageNumber,
          translationsByPageRef.current,
          blockKey
        )
        const result = await window.paperflow.translatePage({
          documentId: targetDocumentId,
          pageNumber,
          blocks: [input],
          force: true,
          ...(context ? { context } : {})
        })
        void handleTranslationCompleted(targetDocumentId, result)
        if (selectedDocumentIdRef.current !== targetDocumentId) return
        setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, result.items))
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/已取消/.test(message)) {
          handleTranslationErrorToast(message)
        }
        if (selectedDocumentIdRef.current === targetDocumentId) {
          if (!/已取消/.test(message)) {
            setTranslationError(message)
          }
        }
      } finally {
        setRetranslatingBlockKeys(prev => {
          const next = new Set(prev)
          next.delete(blockKey)
          return next
        })
      }
    },
    [selectedDocumentId, handleTranslationCompleted, handleTranslationErrorToast]
  )

  const handleTranslateBatch = useCallback(
    async (
      startPage: number,
      options?: { rangeText?: string; skipReferences?: boolean }
    ): Promise<void> => {
      const targetDocumentId = selectedDocumentId
      const totalPageCount = mirrorState.pageCount
      if (!targetDocumentId || totalPageCount <= 0) return

      const pagePlan = parseBatchPageRange(options?.rangeText ?? '', totalPageCount, startPage)
      if (pagePlan.length === 0) {
        library.reportError(`页码范围无效，请输入 1-${totalPageCount} 之间的页码（如 1-5, 8）。`)
        return
      }

      const prevToken = batchAbortMapRef.current.get(targetDocumentId)
      if (prevToken) prevToken.aborted = true
      const token = { aborted: false }
      batchAbortMapRef.current.set(targetDocumentId, token)

      const skipReferences = Boolean(options?.skipReferences)
      const totalPages = pagePlan.length
      setBatchOptionsOpen(false)
      setTranslationError(null)
      setDocBatchQueue(targetDocumentId, {
        currentPage: pagePlan[0],
        completedPages: 0,
        totalPages
      })

      let batchTranslatedPages = 0
      let batchTranslatedBlocks = 0
      let batchPromptTokens = 0
      let batchCompletionTokens = 0
      let batchTotalTokens = 0
      let batchLatencyMs = 0
      let lastBatchResult: TranslatePageResult | null = null
      let skippedFromPage: number | null = null
      let bgPdfHandle: { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> } | null = null
      let bgPdfDoc: PDFDocumentProxy | null = null
      const loopLayouts = new Map<number, PageLayoutResult>(
        selectedDocumentIdRef.current === targetDocumentId ? layoutsRef.current : []
      )
      const loopTranslations = new Map<number, Map<string, TranslatedBlockRecord>>(
        selectedDocumentIdRef.current === targetDocumentId ? translationsByPageRef.current : []
      )

      try {
        for (let idx = 0; idx < pagePlan.length; idx += 1) {
          const pageNumber = pagePlan[idx]
          if (token.aborted) break
          setDocBatchQueue(targetDocumentId, {
            currentPage: pageNumber,
            completedPages: idx,
            totalPages
          })

          let layout: PageLayoutResult | undefined =
            selectedDocumentIdRef.current === targetDocumentId ? layoutsRef.current.get(pageNumber) : undefined
          if (!layout && selectedDocumentIdRef.current === targetDocumentId && analyzePageRef.current) {
            const analyzed = await analyzePageRef.current(pageNumber)
            if (analyzed) {
              if (selectedDocumentIdRef.current === targetDocumentId) {
                handlePageLayout(pageNumber, analyzed)
              }
              layout = analyzed
            }
          }
          // 用户切换了当前阅读 PDF 时，在后台用独立 PDF.js 句柄提取剩余页，确保连续翻译不中断
          if (!layout) {
            if (!bgPdfDoc) {
              const bytes = await window.paperflow.readPdfBytes(targetDocumentId)
              bgPdfHandle = loadPdf(bytes)
              bgPdfDoc = await bgPdfHandle.promise
            }
            const analyzedBg = await analyzeStandalonePdfPage(bgPdfDoc, pageNumber)
            if (analyzedBg) {
              layout = analyzedBg
            }
          }
          if (layout) loopLayouts.set(pageNumber, layout)
          if (token.aborted) break

          let allBlocks = buildPageTranslationInputs(layout)
          if (skipReferences && pageNumber > 1 && allBlocks.length > 0) {
            const refHeadingIdx = findReferencesHeadingBlockIndex(
              allBlocks.map(b => ({ kind: b.kind, text: b.sourceText }))
            )
            if (refHeadingIdx >= 0) {
              skippedFromPage = pageNumber
              allBlocks = allBlocks.slice(0, refHeadingIdx)
              if (allBlocks.length === 0) {
                break
              }
            }
          }
          if (allBlocks.length === 0) {
            if (skippedFromPage !== null) break
            continue
          }

          let pageMap =
            selectedDocumentIdRef.current === targetDocumentId ? translationsByPageRef.current.get(pageNumber) : undefined
          if (!pageMap || pageMap.size < allBlocks.length) {
            const cachedRows = await window.paperflow
              .getPageTranslations(targetDocumentId, pageNumber)
              .catch(() => [] as TranslatedBlockRecord[])
            if (cachedRows.length > 0) {
              const merged = new Map(pageMap ?? [])
              for (const row of cachedRows) merged.set(row.blockId, row)
              pageMap = merged
              if (selectedDocumentIdRef.current === targetDocumentId) {
                setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, cachedRows))
              }
            }
          }
          if (pageMap) loopTranslations.set(pageNumber, pageMap)

          const allCached = allBlocks.every(block =>
            isUsableTranslation(pageMap?.get(block.blockId), block.sourceHash, block.sourceText)
          )
          if (!allCached) {
            setDocTranslatingPage(targetDocumentId, pageNumber)
            const context = buildPageTranslationContext(loopLayouts, pageNumber, loopTranslations)
            const result = await window.paperflow.translatePage({
              documentId: targetDocumentId,
              pageNumber,
              blocks: allBlocks,
              force: false,
              ...(context ? { context } : {})
            })
            const updatedPageMap = new Map(loopTranslations.get(pageNumber) ?? [])
            for (const row of result.items) updatedPageMap.set(row.blockId, row)
            loopTranslations.set(pageNumber, updatedPageMap)
            if (result.translatedCount > 0) {
              batchTranslatedPages += 1
              batchTranslatedBlocks += result.translatedCount
              batchPromptTokens += result.usage?.promptTokens ?? 0
              batchCompletionTokens += result.usage?.completionTokens ?? 0
              batchTotalTokens += result.usage?.totalTokens ?? 0
              batchLatencyMs += result.latencyMs ?? 0
              lastBatchResult = result
            }
            if (selectedDocumentIdRef.current === targetDocumentId) {
              setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, result.items))
            }
          }

          if (skippedFromPage !== null) {
            break
          }
        }
        if (lastBatchResult && batchTranslatedPages > 0) {
          const aggregated: TranslatePageResult = {
            ...lastBatchResult,
            translatedCount: batchTranslatedBlocks,
            latencyMs: batchLatencyMs,
            ...(batchTotalTokens > 0
              ? {
                  usage: {
                    promptTokens: batchPromptTokens,
                    completionTokens: batchCompletionTokens,
                    totalTokens: batchTotalTokens
                  }
                }
              : {})
          }
          void handleTranslationCompleted(targetDocumentId, aggregated, {
            pageCountOverride: batchTranslatedPages > 1 ? batchTranslatedPages : undefined
          })
        }
        if (skippedFromPage !== null && !token.aborted) {
          library.reportNotice(`连续翻译已完成（已自动跳过自第 ${skippedFromPage} 页起的参考文献页）。`)
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/已取消/.test(message)) {
          handleTranslationErrorToast(message)
        }
        if (selectedDocumentIdRef.current === targetDocumentId && !/已取消/.test(message)) {
          setTranslationError(message)
        }
      } finally {
        if (bgPdfHandle) {
          await bgPdfHandle.destroy().catch(() => {})
        }
        if (batchAbortMapRef.current.get(targetDocumentId) === token) {
          batchAbortMapRef.current.delete(targetDocumentId)
          setDocBatchQueue(targetDocumentId, null)
          setDocTranslatingPage(targetDocumentId, null)
        }
      }
    },
    [
      selectedDocumentId,
      mirrorState.pageCount,
      library,
      setDocBatchQueue,
      handlePageLayout,
      analyzeStandalonePdfPage,
      setDocTranslatingPage,
      handleTranslationCompleted,
      handleTranslationErrorToast
    ]
  )

  const handleExportTranslationDocument = useCallback(
    async (format: TranslationExportFormat): Promise<void> => {
      const targetDoc = library.selected
      if (!targetDoc || exportingTranslation) return
      setTranslationExportOpen(false)
      setExportingTranslation(true)
      let bgPdfHandle: { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> } | null = null
      let bgPdfDoc: PDFDocumentProxy | null = null
      try {
        const cachedPages = await window.paperflow.listDocumentTranslations(targetDoc.id)
        const totalTranslated = cachedPages.reduce((sum, page) => sum + page.items.length, 0)
        if (totalTranslated === 0) {
          library.reportNotice('当前文献暂无已翻译内容，请先翻译至少一页再导出。')
          return
        }

        const pagePayload: ExportTranslationPage[] = []
        for (const cachedPage of cachedPages) {
          let layout: PageLayoutResult | undefined =
            selectedDocumentIdRef.current === targetDoc.id ? layoutsRef.current.get(cachedPage.pageNumber) : undefined
          if (!layout && selectedDocumentIdRef.current === targetDoc.id && analyzePageRef.current) {
            layout = (await analyzePageRef.current(cachedPage.pageNumber)) ?? undefined
          }
          if (!layout) {
            if (!bgPdfDoc) {
              const bytes = await window.paperflow.readPdfBytes(targetDoc.id)
              bgPdfHandle = loadPdf(bytes)
              bgPdfDoc = await bgPdfHandle.promise
            }
            layout = (await analyzeStandalonePdfPage(bgPdfDoc, cachedPage.pageNumber)) ?? undefined
          }

          const byBlockId = new Map(cachedPage.items.map(item => [item.blockId, item]))
          const blocks: ExportTranslationPageBlock[] = []
          if (layout) {
            for (const block of buildPageTranslationInputs(layout)) {
              const matched = byBlockId.get(block.blockId)
              const translatedText =
                isUsableTranslation(matched, block.sourceHash, block.sourceText)
                  ? matched.translatedText.trim()
                  : null
              blocks.push({
                kind: block.kind,
                sourceText: block.sourceText,
                translatedText
              })
            }
          }
          if (blocks.length === 0) {
            for (const item of cachedPage.items) {
              if (!item.translatedText.trim()) continue
              blocks.push({
                kind: 'paragraph',
                sourceText: '',
                translatedText: item.translatedText.trim()
              })
            }
          }
          if (blocks.some(b => Boolean(b.translatedText))) {
            pagePayload.push({ pageNumber: cachedPage.pageNumber, blocks })
          }
        }

        if (pagePayload.length === 0) {
          library.reportNotice('当前文献暂无匹配原文版面的已翻译内容。')
          return
        }

        const res = await window.paperflow.exportTranslationDocument({
          documentId: targetDoc.id,
          title: targetDoc.displayTitle || targetDoc.originalFilename.replace(/\.pdf$/i, ''),
          format,
          pages: pagePayload
        })
        if (!res.canceled && res.fileName) {
          library.reportNotice(`已导出译文文件「${res.fileName}」（共 ${res.pageCount} 页）`)
        }
      } catch (err: unknown) {
        library.reportError(err instanceof Error ? err.message : '导出译文失败，请重试。')
      } finally {
        if (bgPdfHandle) {
          await bgPdfHandle.destroy().catch(() => {})
        }
        setExportingTranslation(false)
      }
    },
    [library, exportingTranslation, analyzeStandalonePdfPage]
  )

  useEffect(() => {
    if (
      !prefetchNextPage ||
      viewMode === 'source' ||
      !selectedDocumentId ||
      mirrorState.pageCount <= 1 ||
      translatingPage !== null ||
      batchQueue !== null
    ) {
      return
    }
    const nextPage = mirrorState.currentPage + 1
    if (nextPage > mirrorState.pageCount) return
    const currentLayout = layouts.get(mirrorState.currentPage)
    const currentProgress = countTranslatedBlocks(currentLayout, translationsByPage.get(mirrorState.currentPage))
    if (currentProgress.total === 0 || currentProgress.translated < currentProgress.total) {
      return
    }
    const prefetchKey = `${selectedDocumentId}:${nextPage}`
    if (prefetchedPagesRef.current.has(prefetchKey)) {
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      if (cancelled || selectedDocumentIdRef.current !== selectedDocumentId) return
      prefetchedPagesRef.current.add(prefetchKey)
      void (async () => {
        let nextLayout = layoutsRef.current.get(nextPage)
        if (!nextLayout && analyzePageRef.current) {
          const analyzed = await analyzePageRef.current(nextPage).catch(() => null)
          if (analyzed && !cancelled && selectedDocumentIdRef.current === selectedDocumentId) {
            handlePageLayout(nextPage, analyzed)
            nextLayout = analyzed
          }
        }
        if (cancelled || selectedDocumentIdRef.current !== selectedDocumentId || !nextLayout) return
        const blocks = buildPageTranslationInputs(nextLayout)
        if (blocks.length === 0) return

        const cachedRows = await window.paperflow
          .getPageTranslations(selectedDocumentId, nextPage)
          .catch(() => [] as TranslatedBlockRecord[])
        const cachedById = new Map(cachedRows.map(r => [r.blockId, r]))
        const allCached = blocks.every(block =>
          isUsableTranslation(cachedById.get(block.blockId), block.sourceHash, block.sourceText)
        )
        if (allCached || cancelled || selectedDocumentIdRef.current !== selectedDocumentId) return

        const context = buildPageTranslationContext(
          layoutsRef.current,
          nextPage,
          translationsByPageRef.current
        )
        const result = await window.paperflow
          .translatePage({
            documentId: selectedDocumentId,
            pageNumber: nextPage,
            blocks,
            force: false,
            ...(context ? { context } : {})
          })
          .catch(() => null)
        if (!result || cancelled || selectedDocumentIdRef.current !== selectedDocumentId) return
        setTranslationsByPage(prev => mergePageTranslationRecords(prev, nextPage, result.items))
        void handleTranslationCompleted(selectedDocumentId, result, { suppressToast: true })
      })()
    }, 900)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    prefetchNextPage,
    viewMode,
    selectedDocumentId,
    mirrorState.currentPage,
    mirrorState.pageCount,
    translatingPage,
    batchQueue,
    layouts,
    translationsByPage,
    handlePageLayout,
    handleTranslationCompleted
  ])

  // 用户主动打开原译双栏后，为尚无译文的非中文文献预译前两页。
  useEffect(() => {
    if (
      !selectedDocumentId ||
      autoTranslateRequestedDocumentRef.current !== selectedDocumentId ||
      viewMode !== 'dual' ||
      isCompareMode ||
      mirrorState.pageCount <= 0 ||
      mirrorState.toolbarDisabled ||
      !translationSettings
    ) {
      return
    }
    if (
      autoTranslateEvaluatedRef.current.has(selectedDocumentId) ||
      autoTranslateInFlightRef.current.has(selectedDocumentId)
    ) {
      return
    }
    if (
      translatingPagesByDocIdRef.current[selectedDocumentId] !== undefined ||
      batchQueuesByDocIdRef.current[selectedDocumentId] !== undefined
    ) {
      return
    }

    const targetDocId = selectedDocumentId
    const totalPageCount = mirrorState.pageCount
    const currentSettings = translationSettings
    const doc = docByIdRef.current.get(targetDocId)
    const docTitle = doc?.displayTitle || doc?.originalFilename || ''
    const stillRequested = (): boolean => selectedDocumentIdRef.current === targetDocId &&
      autoTranslateRequestedDocumentRef.current === targetDocId && viewModeRef.current === 'dual' && !isCompareModeRef.current

    autoTranslateEvaluatedRef.current.add(targetDocId)
    autoTranslateInFlightRef.current.add(targetDocId)

    void (async () => {
      let bgPdfHandle: { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> } | null = null
      let bgPdfDoc: PDFDocumentProxy | null = null
      let ownedToken: { aborted: boolean } | null = null

      try {
        const existingPages = await window.paperflow.listDocumentTranslations(targetDocId)
        const hasAnyTranslated = existingPages.some(page =>
          page.items.some(item => item.translatedText.trim().length > 0)
        )
        if (hasAnyTranslated) {
          return
        }
        if (!stillRequested()) {
          autoTranslateEvaluatedRef.current.delete(targetDocId)
          return
        }

        const page1Layout =
          layoutsRef.current.get(1) ?? (await analyzePageRef.current?.(1).catch(() => null)) ?? null
        if (!page1Layout || !stillRequested()) {
          autoTranslateEvaluatedRef.current.delete(targetDocId)
          return
        }
        handlePageLayout(1, page1Layout)

        const page1Blocks = buildPageTranslationInputs(page1Layout)
        let sampleText = page1Blocks.map(block => block.sourceText).join('\n')
        let lang = classifyPdfLanguageFromText(sampleText)
        let page2Layout: PageLayoutResult | null = null

        if (lang === 'insufficient' && totalPageCount >= 2) {
          page2Layout =
            layoutsRef.current.get(2) ?? (await analyzePageRef.current?.(2).catch(() => null)) ?? null
          if (!stillRequested()) {
            autoTranslateEvaluatedRef.current.delete(targetDocId)
            return
          }
          if (page2Layout) {
            handlePageLayout(2, page2Layout)
            const page2Blocks = buildPageTranslationInputs(page2Layout)
            sampleText = `${sampleText}\n${page2Blocks.map(block => block.sourceText).join('\n')}`
            lang = classifyPdfLanguageFromText(sampleText)
          }
        }

        if (lang !== 'non-chinese') {
          return
        }

        let detectedClients: DetectedLocalAiClient[] | null = null
        if (
          currentSettings.provider === 'cli' &&
          (currentSettings.cli.preset === 'codex' || currentSettings.cli.preset === 'gemini') &&
          currentSettings.cli.command.trim().toLowerCase() === currentSettings.cli.preset
        ) {
          detectedClients = await window.paperflow.detectLocalAiClients().catch(() => null)
          if (!stillRequested()) {
            autoTranslateEvaluatedRef.current.delete(targetDocId)
            return
          }
        }

        if (!isTranslationEngineConfigured(currentSettings, detectedClients)) {
          if (stillRequested()) {
            setUnconfiguredPrompt({ documentId: targetDocId, documentTitle: docTitle })
          }
          return
        }

        if (
          !stillRequested() ||
          translatingPagesByDocIdRef.current[targetDocId] !== undefined ||
          batchQueuesByDocIdRef.current[targetDocId] !== undefined
        ) {
          return
        }

        setUnconfiguredPrompt(curr => (curr?.documentId === targetDocId ? null : curr))
        const targetPages = totalPageCount >= 2 ? [1, 2] : [1]
        if (batchAbortMapRef.current.has(targetDocId)) return
        ownedToken = { aborted: false }
        batchAbortMapRef.current.set(targetDocId, ownedToken)
        setDocBatchQueue(targetDocId, {
          currentPage: targetPages[0],
          completedPages: 0,
          totalPages: targetPages.length
        })

        let translatedPages = 0
        let translatedBlocks = 0
        let promptTokens = 0
        let completionTokens = 0
        let totalTokens = 0
        let latencyMs = 0
        let lastResult: TranslatePageResult | null = null
        const preLayouts = new Map<number, PageLayoutResult>(
          selectedDocumentIdRef.current === targetDocId ? layoutsRef.current : []
        )
        if (page1Layout) preLayouts.set(1, page1Layout)
        if (page2Layout) preLayouts.set(2, page2Layout)
        const preTranslations = new Map<number, Map<string, TranslatedBlockRecord>>(
          selectedDocumentIdRef.current === targetDocId ? translationsByPageRef.current : []
        )

        for (let idx = 0; idx < targetPages.length; idx += 1) {
          const pageNumber = targetPages[idx]
          if (ownedToken.aborted || !stillRequested()) break
          setDocBatchQueue(targetDocId, {
            currentPage: pageNumber,
            completedPages: idx,
            totalPages: targetPages.length
          })

          let layout: PageLayoutResult | null =
            pageNumber === 1
              ? page1Layout
              : pageNumber === 2 && page2Layout
                ? page2Layout
                : selectedDocumentIdRef.current === targetDocId
                  ? layoutsRef.current.get(pageNumber) ?? null
                  : null

          if (!layout && selectedDocumentIdRef.current === targetDocId && analyzePageRef.current) {
            const analyzed = await analyzePageRef.current(pageNumber).catch(() => null)
            if (analyzed && selectedDocumentIdRef.current === targetDocId) {
              handlePageLayout(pageNumber, analyzed)
            }
            layout = analyzed
          }
          if (!layout) {
            if (!bgPdfDoc) {
              const bytes = await window.paperflow.readPdfBytes(targetDocId)
              bgPdfHandle = loadPdf(bytes)
              bgPdfDoc = await bgPdfHandle.promise
            }
            layout = await analyzeStandalonePdfPage(bgPdfDoc, pageNumber)
          }
          if (ownedToken.aborted || !stillRequested() || !layout) continue
          preLayouts.set(pageNumber, layout)

          const allBlocks = buildPageTranslationInputs(layout)
          if (allBlocks.length === 0) continue

          let pageMap =
            selectedDocumentIdRef.current === targetDocId
              ? translationsByPageRef.current.get(pageNumber)
              : undefined
          if (!pageMap || pageMap.size < allBlocks.length) {
            const cachedRows = await window.paperflow
              .getPageTranslations(targetDocId, pageNumber)
              .catch(() => [] as TranslatedBlockRecord[])
            if (cachedRows.length > 0) {
              const merged = new Map(pageMap ?? [])
              for (const row of cachedRows) merged.set(row.blockId, row)
              pageMap = merged
              if (selectedDocumentIdRef.current === targetDocId) {
                setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, cachedRows))
              }
            }
          }
          if (pageMap) preTranslations.set(pageNumber, pageMap)

          const allCached = allBlocks.every(block =>
            isUsableTranslation(pageMap?.get(block.blockId), block.sourceHash, block.sourceText)
          )
          if (allCached || ownedToken.aborted || !stillRequested()) continue

          setDocTranslatingPage(targetDocId, pageNumber)
          const context = buildPageTranslationContext(preLayouts, pageNumber, preTranslations)
          const result = await window.paperflow.translatePage({
            documentId: targetDocId,
            pageNumber,
            blocks: allBlocks,
            force: false,
            ...(context ? { context } : {})
          })
          const updatedPreMap = new Map(preTranslations.get(pageNumber) ?? [])
          for (const row of result.items) updatedPreMap.set(row.blockId, row)
          preTranslations.set(pageNumber, updatedPreMap)
          if (result.translatedCount > 0) {
            translatedPages += 1
            translatedBlocks += result.translatedCount
            promptTokens += result.usage?.promptTokens ?? 0
            completionTokens += result.usage?.completionTokens ?? 0
            totalTokens += result.usage?.totalTokens ?? 0
            latencyMs += result.latencyMs ?? 0
            lastResult = result
          }
          if (selectedDocumentIdRef.current === targetDocId) {
            setTranslationsByPage(prev => mergePageTranslationRecords(prev, pageNumber, result.items))
          }
        }

        if (lastResult && translatedPages > 0 && !ownedToken.aborted) {
          const aggregated: TranslatePageResult = {
            ...lastResult,
            translatedCount: translatedBlocks,
            latencyMs,
            ...(totalTokens > 0
              ? {
                  usage: {
                    promptTokens,
                    completionTokens,
                    totalTokens
                  }
                }
              : {})
          }
          void handleTranslationCompleted(targetDocId, aggregated, {
            pageCountOverride: translatedPages > 1 ? translatedPages : undefined
          })
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/已取消/.test(message)) {
          handleTranslationErrorToast(message)
          if (selectedDocumentIdRef.current === targetDocId) {
            setTranslationError(message)
          }
        }
      } finally {
        if (bgPdfHandle) {
          await bgPdfHandle.destroy().catch(() => {})
        }
        if (ownedToken && batchAbortMapRef.current.get(targetDocId) === ownedToken) {
          batchAbortMapRef.current.delete(targetDocId)
          setDocBatchQueue(targetDocId, null)
          setDocTranslatingPage(targetDocId, null)
        }
        autoTranslateInFlightRef.current.delete(targetDocId)
      }
    })()
  }, [
    selectedDocumentId,
    isCompareMode,
    viewMode,
    mirrorState.pageCount,
    mirrorState.toolbarDisabled,
    translationSettings,
    autoTranslateRetryTick,
    handlePageLayout,
    analyzeStandalonePdfPage,
    setDocBatchQueue,
    setDocTranslatingPage,
    handleTranslationCompleted,
    handleTranslationErrorToast
  ])

  const handleLeftSourceInteract = useCallback(
    (event: LeftSourceInteractEvent): void => {
      setEditingAnnotation(null)
      const step = reduceLeftSourceInteract(activeLinkRef.current, event, layouts)
      if (step.kind === 'noop') return
      if (step.kind === 'clear') {
        activeLinkRef.current = null
        setActiveLink(null)
        return
      }
      clearOtherSecondarySelections()
      setSecondarySelection(null)
      setActivePaneId(primaryPaneId)
      if (step.kind === 'set') {
        activeLinkRef.current = step.link
        setActiveLink(step.link)
      }
    },
    [layouts, clearOtherSecondarySelections, primaryPaneId]
  )

  const handleRightSentenceSelect = useCallback(
    (selection: TargetSentenceSelection | null): void => {
      setEditingAnnotation(null)
      if (!selection) {
        activeLinkRef.current = null
        setActiveLink(null)
        return
      }
      clearOtherSecondarySelections()
      setSecondarySelection(null)
      setActivePaneId(primaryPaneId)
      const step = reduceRightSentenceSelect(activeLinkRef.current, selection)
      if (step.kind === 'clear') {
        activeLinkRef.current = null
        setActiveLink(null)
      } else if (step.kind === 'set') {
        activeLinkRef.current = step.link
        setActiveLink(step.link)
      }
    },
    [clearOtherSecondarySelections, primaryPaneId]
  )

  useEffect(() => {
    if (!activeLink || scrollSyncLocked || effectivePrimaryViewMode !== 'dual') return
    const rafId = window.requestAnimationFrame(() => {
      scrollOppositePaneToActiveLink(activeLink, pdfScrollEl, translationScrollEl)
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [activeLink, scrollSyncLocked, effectivePrimaryViewMode, pdfScrollEl, translationScrollEl])

  const activeSentenceIds = useMemo(() => new Set(activeLink?.sentenceIds ?? []), [activeLink])
  const activeSourceSentence = useMemo(
    () =>
      activeLink && !activeLink.suppressLeftOverlay
        ? {
            pageNumber: activeLink.pageNumber,
            rects:
              activeLink.sentenceRects && activeLink.sentenceRects.length > 0
                ? activeLink.sentenceRects
                : activeLink.sourceRects
          }
        : null,
    [activeLink]
  )

  const activeAnnotations = useMemo(
    () => (activeDocumentId ? annotationsByDocId.get(activeDocumentId) ?? [] : []),
    [annotationsByDocId, activeDocumentId]
  )

  const annotationsByPageByDocId = useMemo(() => {
    const docMap = new Map<string, Map<number, AnnotationRecord[]>>()
    for (const [docId, items] of annotationsByDocId.entries()) {
      const pageMap = new Map<number, AnnotationRecord[]>()
      for (const item of items) {
        const list = pageMap.get(item.pageNumber)
        if (list) list.push(item)
        else pageMap.set(item.pageNumber, [item])
      }
      docMap.set(docId, pageMap)
    }
    return docMap
  }, [annotationsByDocId])

  const primaryAnnotationsByPage =
    (primaryPane ? annotationsByPageByDocId.get(primaryPane.document.id) : undefined) ?? EMPTY_ANNOTATIONS_BY_PAGE

  const mirrorStateRef = useRef(mirrorState)
  mirrorStateRef.current = mirrorState
  const pdfScrollElRef = useRef(pdfScrollEl)
  pdfScrollElRef.current = pdfScrollEl
  const translationScrollElRef = useRef(translationScrollEl)
  translationScrollElRef.current = translationScrollEl
  const effectivePrimaryViewModeRef = useRef(effectivePrimaryViewMode)
  effectivePrimaryViewModeRef.current = effectivePrimaryViewMode
  const primaryPaneIdRef = useRef(primaryPaneId)
  primaryPaneIdRef.current = primaryPaneId
  const handlePageLayoutRef = useRef(handlePageLayout)
  handlePageLayoutRef.current = handlePageLayout
  const handleRetranslateBlockRef = useRef(handleRetranslateBlock)
  handleRetranslateBlockRef.current = handleRetranslateBlock
  const resolvedPanesRef = useRef(resolvedPanes)
  resolvedPanesRef.current = resolvedPanes

  const navigatePrimaryReader = useCallback((pageNumber: number): void => {
    navigateToPageRef.current?.(pageNumber)
    if (effectivePrimaryViewModeRef.current === 'translation') {
      translationScrollElRef.current
        ?.querySelector<HTMLElement>(`.translation-page[data-page-number="${pageNumber}"]`)
        ?.scrollIntoView({ block: 'start' })
    }
  }, [])

  const handleTranslationCurrentPage = useCallback((pageNumber: number): void => {
    if (effectivePrimaryViewModeRef.current === 'translation' && mirrorStateRef.current.currentPage !== pageNumber) {
      navigateToPageRef.current?.(pageNumber)
    }
  }, [])

  const resolvePaneHandle = useCallback((paneId: string): PaneStudyHandle | null => {
    const primaryId = primaryPaneIdRef.current
    if (paneId === primaryId || (!paneId && selectedDocumentIdRef.current)) {
      const docId = resolvedPanesRef.current[0]?.document.id ?? selectedDocumentIdRef.current
      if (!docId) return null
      return {
        paneId: primaryId,
        documentId: docId,
        getPageNumber: () => mirrorStateRef.current.currentPage,
        getPageCount: () => mirrorStateRef.current.pageCount,
        getViewMode: () => effectivePrimaryViewModeRef.current,
        getLayouts: () => layoutsRef.current,
        getScrollElements: () => ({
          pdf: pdfScrollElRef.current,
          translation: translationScrollElRef.current
        }),
        extractCurrentPageText: async () => {
          const fn = extractPageTextRef.current
          if (!fn) return null
          return fn(mirrorStateRef.current.currentPage)
        },
        extractPageText: async pageNumber => {
          const fn = extractPageTextRef.current
          if (!fn) return null
          return fn(pageNumber)
        },
        analyzePage: async pageNumber => {
          const fn = analyzePageRef.current
          if (!fn) return null
          return fn(pageNumber)
        },
        extractCitationSource: async () => {
          const fn = extractCitationSourceRef.current
          if (!fn) return null
          return fn()
        },
        renderRegionPreview: async (pageNumber, kind, captionBounds, obstacleBounds) => {
          const fn = renderRegionPreviewRef.current
          if (!fn) return null
          return fn(pageNumber, kind, captionBounds, obstacleBounds)
        },
        navigateToPage: navigatePrimaryReader,
        highlightAnnotation: annotation => {
          const layout = layoutsRef.current.get(annotation.pageNumber)
          let resolvedSentenceIds = [...annotation.sentenceIds]
          const matchedBlockKeys = new Set<string>()
          const matchedSentenceRects: PageRect[] = []
          if (layout && resolvedSentenceIds.length === 0 && annotation.rects.length > 0) {
            const recovered = matchSelectionRegionsToSentences(
              new Map([[annotation.pageNumber, layout]]),
              annotation.rects.map(rect => ({ pageNumber: annotation.pageNumber, rect })),
              annotation.quoteText
            )
            if (recovered && recovered.sentenceIds.length > 0) {
              resolvedSentenceIds = [...recovered.sentenceIds]
            } else {
              const firstRect = annotation.rects[0]
              const hit = hitTestPageSentence(
                layout,
                { x: firstRect.x + firstRect.width / 2, y: firstRect.y + firstRect.height / 2 },
                18
              )
              if (hit) resolvedSentenceIds = [hit.sentence.id]
            }
          }
          if (layout && resolvedSentenceIds.length > 0) {
            const targetIds = new Set(resolvedSentenceIds)
            for (const block of layout.blocks) {
              if (block.sentences.some(sentence => targetIds.has(sentence.id))) {
                matchedBlockKeys.add(computeStableTranslationBlockKey(block))
              }
            }
            for (const sentence of layout.sentences) {
              if (targetIds.has(sentence.id) && sentence.rects.length > 0) {
                matchedSentenceRects.push(...sentence.rects)
              }
            }
          }
          setSecondarySelection(null)
          clearOtherSecondarySelections()
          setActiveLink({
            pageNumber: annotation.pageNumber,
            sentenceIds: resolvedSentenceIds,
            blockKeys: Array.from(matchedBlockKeys),
            sourceRects: annotation.rects.map(({ x, y, width, height }) => ({ x, y, width, height })),
            sentenceRects: matchedSentenceRects.length > 0 ? matchedSentenceRects : undefined,
            selectedText: annotation.quoteText,
            origin: 'right',
            suppressLeftOverlay: false
          })
        },
        syncPostHighlightSentence: info => {
          setSecondarySelection(null)
          clearOtherSecondarySelections()
          setActiveLink({
            pageNumber: info.pageNumber,
            sentenceIds: info.sentenceIds,
            blockKeys: info.blockKeys,
            sourceRects: info.sourceRects,
            sentenceRects: info.sentenceRects.length > 0 ? info.sentenceRects : undefined,
            selectedText: info.selectedText,
            origin: 'left',
            suppressLeftOverlay: true
          })
        },
        clearSelection: () => {
          setActiveLink(null)
        },
        applyAnalyzedLayout: (pageNumber, layout) => {
          handlePageLayoutRef.current(pageNumber, layout)
        },
        retranslateBlock: async (pageNumber, blockKey) => {
          await handleRetranslateBlockRef.current(pageNumber, blockKey)
        }
      }
    }
    return paneStudyHandlesRef.current.get(paneId) ?? null
  }, [clearOtherSecondarySelections, navigatePrimaryReader])

  const primarySelection = useMemo((): PaneSelectionSnapshot | null => {
    if (!activeLink || !selectedDocumentId) return null
    const hasSelectedText = Boolean(activeLink.selectedText?.trim()) && activeLink.sourceRects.length > 0
    if (activeLink.sentenceIds.length === 0 && !hasSelectedText) return null
    const layout = layouts.get(activeLink.pageNumber)
    if (!layout && !hasSelectedText) return null
    const selectedSentences = layout ? layout.sentences.filter(sentence => activeSentenceIds.has(sentence.id)) : []
    if (selectedSentences.length === 0 && !hasSelectedText) return null

    const sentenceQuote = selectedSentences
      .map(sentence => sentence.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    const quoteText = activeLink.selectedText?.trim() || sentenceQuote
    if (!quoteText) return null

    const blockKeySet = new Set(activeLink.blockKeys)
    const matchedBlocks = layout
      ? layout.blocks.filter(block => blockKeySet.has(computeStableTranslationBlockKey(block)))
      : []
    const contextText =
      matchedBlocks
        .map(block => getBlockPlainText(block))
        .filter(Boolean)
        .join('\n') ||
      sentenceQuote ||
      quoteText

    const isFormulaLikely =
      selectedSentences.some(sentence => sentence.blockKind === 'formula') ||
      matchedBlocks.some(block => block.kind === 'formula' || Boolean(block.inlineFormulas?.length))

    return {
      paneId: primaryPaneId,
      documentId: selectedDocumentId,
      pageNumber: activeLink.pageNumber,
      quoteText,
      contextText,
      isFormulaLikely,
      sentenceIds: activeLink.sentenceIds,
      blockKeys: activeLink.blockKeys,
      sourceRects: activeLink.sourceRects
    }
  }, [activeLink, selectedDocumentId, layouts, activeSentenceIds, primaryPaneId])

  const effectiveSelection = secondarySelection ?? primarySelection

  const selectionCompanion = useMemo((): SelectionCompanionState | null => {
    if (!effectiveSelection) return null
    return {
      pageNumber: effectiveSelection.pageNumber,
      quoteText: effectiveSelection.quoteText,
      contextText: effectiveSelection.contextText,
      isFormulaLikely: effectiveSelection.isFormulaLikely
    }
  }, [effectiveSelection])

  const activeEditingAnnotation = useMemo(() => {
    if (!editingAnnotation) return null
    const list = annotationsByDocId.get(editingAnnotation.documentId)
    return list?.find(item => item.id === editingAnnotation.annotationId) ?? null
  }, [annotationsByDocId, editingAnnotation])

  const handlePaneAnnotationClick = useCallback(
    (paneId: string, annotation: AnnotationRecord): void => {
      const paneHandle = resolvePaneHandle(paneId)
      const paneLayouts = paneHandle?.getLayouts()
      const pageLayout = paneLayouts?.get(annotation.pageNumber)

      let resolvedSentenceIds = [...annotation.sentenceIds]
      const matchedBlockKeys = new Set<string>()
      const matchedSentenceRects: PageRect[] = []
      if (resolvedSentenceIds.length === 0 && paneLayouts && annotation.rects.length > 0) {
        const recovered = matchSelectionRegionsToSentences(
          paneLayouts,
          annotation.rects.map(rect => ({ pageNumber: annotation.pageNumber, rect })),
          annotation.quoteText
        )
        if (recovered && recovered.sentenceIds.length > 0) {
          resolvedSentenceIds = [...recovered.sentenceIds]
          for (const key of recovered.blockKeys) matchedBlockKeys.add(key)
        } else if (pageLayout) {
          const firstRect = annotation.rects[0]
          const hit = hitTestPageSentence(
            pageLayout,
            { x: firstRect.x + firstRect.width / 2, y: firstRect.y + firstRect.height / 2 },
            18
          )
          if (hit) {
            resolvedSentenceIds = [hit.sentence.id]
            matchedBlockKeys.add(hit.blockKey)
          }
        }
      }
      if (pageLayout && resolvedSentenceIds.length > 0) {
        const targetIds = new Set(resolvedSentenceIds)
        for (const block of pageLayout.blocks) {
          if (block.sentences.some(sentence => targetIds.has(sentence.id))) {
            matchedBlockKeys.add(computeStableTranslationBlockKey(block))
          }
        }
        for (const sentence of pageLayout.sentences) {
          if (targetIds.has(sentence.id) && sentence.rects.length > 0) {
            matchedSentenceRects.push(...sentence.rects)
          }
        }
      }

      if (paneId !== primaryPaneId) {
        setActiveLink(null)
        expectEditingSyncPaneRef.current = paneId
      } else {
        setSecondarySelection(null)
      }
      clearOtherSecondarySelections(paneId)
      setActivePaneId(paneId)

      paneHandle?.syncPostHighlightSentence({
        pageNumber: annotation.pageNumber,
        sentenceIds: resolvedSentenceIds,
        blockKeys: Array.from(matchedBlockKeys),
        sourceRects: annotation.rects.map(({ x, y, width, height }) => ({ x, y, width, height })),
        sentenceRects: matchedSentenceRects,
        selectedText: annotation.quoteText
      })
      setEditingAnnotation({
        paneId,
        documentId: annotation.documentId,
        annotationId: annotation.id
      })
    },
    [resolvePaneHandle, primaryPaneId, clearOtherSecondarySelections]
  )

  const handleCreateHighlight = useCallback(
    async (color: AnnotationColor, note?: string): Promise<void> => {
      if (!effectiveSelection || !selectionCompanion) return
      const targetDocumentId = effectiveSelection.documentId
      const paneHandle = resolvePaneHandle(effectiveSelection.paneId)
      const paneLayouts = paneHandle?.getLayouts()
      const pageLayout = paneLayouts?.get(effectiveSelection.pageNumber)

      let resolvedSentenceIds = [...effectiveSelection.sentenceIds]
      let resolvedBlockKeys = [...effectiveSelection.blockKeys]
      if (resolvedSentenceIds.length === 0 && paneLayouts && effectiveSelection.sourceRects.length > 0) {
        const recovered = matchSelectionRegionsToSentences(
          paneLayouts,
          effectiveSelection.sourceRects.map(rect => ({
            pageNumber: effectiveSelection.pageNumber,
            rect
          })),
          selectionCompanion.quoteText
        )
        if (recovered && recovered.sentenceIds.length > 0) {
          resolvedSentenceIds = [...recovered.sentenceIds]
          resolvedBlockKeys = [...recovered.blockKeys]
        } else if (pageLayout) {
          const firstRect = effectiveSelection.sourceRects[0]
          const hit = hitTestPageSentence(
            pageLayout,
            { x: firstRect.x + firstRect.width / 2, y: firstRect.y + firstRect.height / 2 },
            18
          )
          if (hit) {
            resolvedSentenceIds = [hit.sentence.id]
            resolvedBlockKeys = [hit.blockKey]
          }
        }
      }

      const resolvedSentenceRects: PageRect[] = []
      if (pageLayout && resolvedSentenceIds.length > 0) {
        const idSet = new Set(resolvedSentenceIds)
        for (const sentence of pageLayout.sentences) {
          if (idSet.has(sentence.id) && sentence.rects.length > 0) {
            resolvedSentenceRects.push(...sentence.rects)
          }
        }
      }

      setSavingAnnotation(true)
      try {
        const exactRects = effectiveSelection.sourceRects.map(({ x, y, width, height }) => ({ x, y, width, height }))
        const created = await window.paperflow.createAnnotation({
          documentId: targetDocumentId,
          pageNumber: effectiveSelection.pageNumber,
          color,
          quoteText: selectionCompanion.quoteText,
          note: note?.trim() ? note.trim() : undefined,
          rects: exactRects,
          sentenceIds: resolvedSentenceIds
        })
        loadedAnnotationDocsRef.current.add(targetDocumentId)
        setAnnotationsByDocId(prev => {
          const next = new Map(prev)
          next.set(targetDocumentId, [...(next.get(targetDocumentId) ?? []), created])
          return next
        })
        window.getSelection()?.removeAllRanges()
        if (effectiveSelection.paneId !== primaryPaneId) {
          expectEditingSyncPaneRef.current = effectiveSelection.paneId
        }
        paneHandle?.syncPostHighlightSentence({
          pageNumber: effectiveSelection.pageNumber,
          sentenceIds: resolvedSentenceIds,
          blockKeys: resolvedBlockKeys,
          sourceRects: exactRects,
          sentenceRects: resolvedSentenceRects,
          selectedText: selectionCompanion.quoteText
        })
        setEditingAnnotation({
          paneId: effectiveSelection.paneId,
          documentId: targetDocumentId,
          annotationId: created.id
        })
      } catch (err: unknown) {
        setTranslationError(err instanceof Error ? err.message : String(err))
      } finally {
        setSavingAnnotation(false)
      }
    },
    [effectiveSelection, selectionCompanion, resolvePaneHandle, primaryPaneId]
  )

  const handleExplainSelection = useCallback(
    (mode: ExplainMode): void => {
      if (!selectionCompanion || !effectiveSelection) return
      const targetPaneId = effectiveSelection.paneId
      const targetDocumentId = effectiveSelection.documentId
      const requestId = explainRequestIdRef.current + 1
      explainRequestIdRef.current = requestId
      const snapshot = selectionCompanion
      explainAnchorRef.current = {
        paneId: targetPaneId,
        documentId: targetDocumentId,
        pageNumber: effectiveSelection.pageNumber,
        rects: effectiveSelection.sourceRects.map(({ x, y, width, height }) => ({ x, y, width, height })),
        sentenceIds: [...effectiveSelection.sentenceIds]
      }

      setExplainState({
        loading: true,
        mode,
        quoteText: snapshot.quoteText,
        pageNumber: snapshot.pageNumber,
        answer: null,
        error: null
      })

      void window.paperflow
        .explainSelection({
          documentId: targetDocumentId,
          pageNumber: snapshot.pageNumber,
          selectedText: snapshot.quoteText,
          contextText: snapshot.contextText,
          mode
        })
        .then(res => {
          void refreshUsageAndBalance({ refreshBalance: false })
          if (explainRequestIdRef.current !== requestId) return
          setExplainState({
            loading: false,
            mode: res.mode,
            quoteText: snapshot.quoteText,
            pageNumber: snapshot.pageNumber,
            answer: res.answer,
            error: null
          })
        })
        .catch((err: unknown) => {
          if (explainRequestIdRef.current !== requestId) return
          setExplainState({
            loading: false,
            mode,
            quoteText: snapshot.quoteText,
            pageNumber: snapshot.pageNumber,
            answer: null,
            error: err instanceof Error ? err.message : String(err)
          })
        })
    },
    [selectionCompanion, effectiveSelection, refreshUsageAndBalance]
  )

  const handleSaveExplainAsNote = useCallback(async (): Promise<void> => {
    if (!explainState?.answer) return
    const fallbackAnchor =
      explainAnchorRef.current && explainAnchorRef.current.pageNumber === explainState.pageNumber
        ? explainAnchorRef.current
        : null
    const targetDocumentId = fallbackAnchor?.documentId ?? effectiveSelection?.documentId ?? activeDocumentId
    if (!targetDocumentId) return
    setSavingAnnotation(true)
    try {
      const rects =
        effectiveSelection &&
        effectiveSelection.documentId === targetDocumentId &&
        effectiveSelection.pageNumber === explainState.pageNumber &&
        effectiveSelection.sourceRects.length > 0
          ? effectiveSelection.sourceRects.map(({ x, y, width, height }) => ({ x, y, width, height }))
          : fallbackAnchor && fallbackAnchor.rects.length > 0
            ? fallbackAnchor.rects
            : [{ x: 0, y: 0, width: 1, height: 1 }]
      const sentenceIds =
        effectiveSelection &&
        effectiveSelection.documentId === targetDocumentId &&
        effectiveSelection.pageNumber === explainState.pageNumber
          ? effectiveSelection.sentenceIds
          : (fallbackAnchor?.sentenceIds ?? [])
      const created = await window.paperflow.createAnnotation({
        documentId: targetDocumentId,
        pageNumber: explainState.pageNumber,
        color: 'blue',
        quoteText: explainState.quoteText,
        note: explainState.answer,
        rects,
        sentenceIds
      })
      loadedAnnotationDocsRef.current.add(targetDocumentId)
      setAnnotationsByDocId(prev => {
        const next = new Map(prev)
        next.set(targetDocumentId, [...(next.get(targetDocumentId) ?? []), created])
        return next
      })
    } catch (err: unknown) {
      setTranslationError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingAnnotation(false)
    }
  }, [explainState, effectiveSelection, activeDocumentId])

  const handleUpdateAnnotation = useCallback(
    async (id: string, patch: { color?: AnnotationColor; note?: string }): Promise<void> => {
      const updated = await window.paperflow.updateAnnotation({ id, ...patch })
      setAnnotationsByDocId(prev => {
        const next = new Map(prev)
        const existing = next.get(updated.documentId)
        if (existing) {
          next.set(
            updated.documentId,
            existing.map(item => (item.id === id ? updated : item))
          )
        }
        return next
      })
    },
    []
  )

  const handleDeleteAnnotation = useCallback(
    async (id: string): Promise<void> => {
      await window.paperflow.deleteAnnotation(id)
      setAnnotationsByDocId(prev => {
        const next = new Map(prev)
        for (const [docId, list] of next.entries()) {
          if (list.some(item => item.id === id)) {
            next.set(
              docId,
              list.filter(item => item.id !== id)
            )
          }
        }
        return next
      })
      if (editingAnnotation?.annotationId === id) {
        const targetPaneId = editingAnnotation.paneId
        setEditingAnnotation(null)
        if (targetPaneId === primaryPaneId) {
          setActiveLink(null)
        } else {
          resolvePaneHandle(targetPaneId)?.clearSelection()
          setSecondarySelection(prev => (prev?.paneId === targetPaneId ? null : prev))
        }
      }
    },
    [editingAnnotation, primaryPaneId, resolvePaneHandle]
  )

  const handleExportAnnotationsMarkdown = useCallback(async () => {
    if (!activeDocumentId) return null
    return await window.paperflow.exportAnnotationsMarkdown(activeDocumentId)
  }, [activeDocumentId])

  const handleJumpToAnnotation = useCallback(
    (annotation: AnnotationRecord): void => {
      const matchingPane =
        resolvedPanes.find(r => r.pane.id === effectiveActivePaneId && r.document.id === annotation.documentId) ??
        resolvedPanes.find(r => r.document.id === annotation.documentId)
      const targetPaneId = matchingPane?.pane.id ?? primaryPaneId
      const handle = resolvePaneHandle(targetPaneId)
      if (!handle) return
      setActivePaneId(targetPaneId)
      handle.navigateToPage(annotation.pageNumber)
      if (annotation.rects.length > 0) {
        handle.highlightAnnotation(annotation)
      }
    },
    [resolvedPanes, effectiveActivePaneId, primaryPaneId, resolvePaneHandle]
  )

  const handleSaveAiReplyAsNote = useCallback(
    async (input: { quoteText: string; note: string; pageNumber?: number }): Promise<boolean> => {
      const targetDocId = activeDocumentIdRef.current
      if (!targetDocId) return false
      const fallbackPage = resolvePaneHandle(effectiveActivePaneId)?.getPageNumber() ?? mirrorState.currentPage ?? 1
      const pageNumber = Math.max(1, input.pageNumber ?? fallbackPage)
      try {
        const created = await window.paperflow.createAnnotation({
          documentId: targetDocId,
          pageNumber,
          color: 'blue',
          quoteText: input.quoteText.trim().slice(0, 4000) || '[AI 笔记]',
          note: input.note.trim().slice(0, 8000),
          rects: [],
          sentenceIds: []
        })
        loadedAnnotationDocsRef.current.add(targetDocId)
        setAnnotationsByDocId(prev => {
          const next = new Map(prev)
          next.set(targetDocId, [...(next.get(targetDocId) ?? []), created])
          return next
        })
        return true
      } catch (err: unknown) {
        library.reportError(err instanceof Error ? err.message : '保存 AI 对话为批注失败。')
        return false
      }
    },
    [effectiveActivePaneId, mirrorState.currentPage, resolvePaneHandle, library]
  )

  const referenceTargets = useMemo(
    () => (selectionCompanion ? extractReferenceTargets(selectionCompanion.quoteText) : []),
    [selectionCompanion]
  )

  const handlePeekReference = useCallback(
    (target: ReferenceTarget): void => {
      const targetPaneId = effectiveSelection?.paneId ?? effectiveActivePaneId
      const handle = resolvePaneHandle(targetPaneId)
      if (!handle) return
      const targetDocId = handle.documentId
      peekPaneIdRef.current = targetPaneId
      const reqId = peekRequestIdRef.current + 1
      peekRequestIdRef.current = reqId
      const currentPage = handle.getPageNumber()
      const totalPages = handle.getPageCount()

      const isTargetStillAlive = (): boolean => {
        if (peekRequestIdRef.current !== reqId) return false
        const liveHandle = resolvePaneHandle(targetPaneId)
        return Boolean(liveHandle && liveHandle.documentId === targetDocId)
      }

      const attachFigureThumbnail = async (baseMatch: ReferencePeekMatch): Promise<void> => {
        if (target.kind !== 'figure' && target.kind !== 'table') return
        const liveHandle = resolvePaneHandle(targetPaneId)
        if (!liveHandle) return
        let captionBounds = baseMatch.captionBounds
        let targetLayout = liveHandle.getLayouts().get(baseMatch.pageNumber) ?? null
        if (!targetLayout) {
          const analyzed = await liveHandle.analyzePage(baseMatch.pageNumber).catch(() => null)
          if (!isTargetStillAlive()) return
          if (analyzed) {
            liveHandle.applyAnalyzedLayout(baseMatch.pageNumber, analyzed)
            targetLayout = analyzed
          }
        }
        if (!captionBounds && targetLayout) {
          const refined = findReferenceMatchInPages(
            target,
            new Map<number, ReferencePageSource>([
              [
                baseMatch.pageNumber,
                {
                  text: targetLayout.blocks.map(block => getBlockPlainText(block)).join('\n'),
                  blocks: targetLayout.blocks.map(block => ({
                    kind: block.kind,
                    text: getBlockPlainText(block),
                    bounds: block.bounds
                  }))
                }
              ]
            ]),
            currentPage
          )
          if (refined?.captionBounds) captionBounds = refined.captionBounds
        }
        // 提取同页正文段落与章节标题作为硬边界障碍，防止紧密排版下把上方/下方正文误裁进速览图
        const obstacleBounds = targetLayout
          ? targetLayout.blocks
              .filter(block => {
                if (block.kind === 'heading') return true
                if (block.kind !== 'paragraph') return false
                const textLen = getBlockPlainText(block).length
                const widthRatio = targetLayout!.naturalWidth > 0 ? block.displayBounds.width / targetLayout!.naturalWidth : 0
                return textLen >= 55 && widthRatio >= 0.28
              })
              .map(block => block.bounds)
          : undefined
        const imageDataUrl = await liveHandle
          .renderRegionPreview(baseMatch.pageNumber, target.kind, captionBounds, obstacleBounds)
          .catch(() => null)
        if (!imageDataUrl || !isTargetStillAlive()) return
        setPeekState(prev =>
          prev && prev.match
            ? {
                ...prev,
                match: { ...prev.match, captionBounds, imageDataUrl }
              }
            : prev
        )
      }

      const pageMap = new Map<number, ReferencePageSource>()
      for (const [pNum, layout] of handle.getLayouts().entries()) {
        pageMap.set(pNum, {
          text: layout.blocks.map(block => getBlockPlainText(block)).join('\n'),
          blocks: layout.blocks.map(block => ({
            kind: block.kind,
            text: getBlockPlainText(block),
            bounds: block.bounds
          }))
        })
      }

      const immediate = findReferenceMatchInPages(target, pageMap, currentPage)
      if (immediate) {
        setPeekState({ loading: false, target, match: immediate })
        void attachFigureThumbnail(immediate)
        return
      }

      setPeekState({ loading: true, target, match: null })
      void (async () => {
        if (totalPages > 0) {
          const order =
            target.kind === 'citation'
              ? Array.from({ length: totalPages }, (_, i) => totalPages - i)
              : Array.from({ length: totalPages }, (_, i) => i + 1)

          for (const pNum of order) {
            if (!isTargetStillAlive()) return
            if (pageMap.has(pNum)) continue
            const text = await handle.extractPageText(pNum)
            if (!isTargetStillAlive()) return
            if (!text) continue
            const singleMap = new Map<number, ReferencePageSource>([[pNum, { text }]])
            const found = findReferenceMatchInPages(target, singleMap, currentPage)
            if (found) {
              setPeekState({ loading: false, target, match: found })
              void attachFigureThumbnail(found)
              return
            }
          }
        }
        if (isTargetStillAlive()) {
          setPeekState({ loading: false, target, match: null })
        }
      })()
    },
    [effectiveSelection?.paneId, effectiveActivePaneId, resolvePaneHandle]
  )

  const handleJumpToPage = useCallback(
    (targetPage: number, fromPage?: number): void => {
      const targetPaneId = peekPaneIdRef.current ?? effectiveSelection?.paneId ?? effectiveActivePaneId
      const handle = resolvePaneHandle(targetPaneId)
      if (fromPage && fromPage !== targetPage) {
        setReturnTarget({ paneId: targetPaneId, pageNumber: fromPage })
      }
      handle?.navigateToPage(targetPage)
      setPeekState(null)
      setPeekPinned(false)
    },
    [effectiveSelection?.paneId, effectiveActivePaneId, resolvePaneHandle]
  )

  // 未固定速览卡片：点击阅读正文区域或滚动超过 120px 时自动收起，省去每次手动点 ×
  useEffect(() => {
    if (!peekState || peekPinned) return
    const targetPaneId = peekPaneIdRef.current ?? effectiveSelection?.paneId ?? effectiveActivePaneId
    const scrolls = resolvePaneHandle(targetPaneId)?.getScrollElements() ?? {
      pdf: pdfScrollEl,
      translation: translationScrollEl
    }
    const targetPdfEl = scrolls.pdf
    const targetTransEl = scrolls.translation
    const startPdfTop = targetPdfEl?.scrollTop ?? 0
    const startTransTop = targetTransEl?.scrollTop ?? 0

    const dismiss = (): void => {
      peekRequestIdRef.current += 1
      setPeekState(null)
    }

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      if (target.closest('.study-companion-dock')) return
      if (target.closest('.reader-panel') || target.closest('.translation-panel')) {
        dismiss()
      }
    }

    const onPdfScroll = (): void => {
      if (targetPdfEl && Math.abs(targetPdfEl.scrollTop - startPdfTop) > 120) {
        dismiss()
      }
    }

    const onTransScroll = (): void => {
      if (targetTransEl && Math.abs(targetTransEl.scrollTop - startTransTop) > 120) {
        dismiss()
      }
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    targetPdfEl?.addEventListener('scroll', onPdfScroll, { passive: true })
    targetTransEl?.addEventListener('scroll', onTransScroll, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      targetPdfEl?.removeEventListener('scroll', onPdfScroll)
      targetTransEl?.removeEventListener('scroll', onTransScroll)
    }
  }, [peekState, peekPinned, effectiveSelection?.paneId, effectiveActivePaneId, resolvePaneHandle, pdfScrollEl, translationScrollEl])

  // 点击目录标题：跳转目标页并同步在原文 / 双栏 / 译文中高亮定位该章节标题
  const handleOutlineNavigate = useCallback(
    (item: PdfOutlineItem): void => {
      const targetPage = item.pageNumber
      const targetDocId = selectedDocumentIdRef.current
      if (!targetPage || !targetDocId) return
      const reqId = ++outlineRequestIdRef.current

      const pickMatchedBlock = (layout: PageLayoutResult) => {
        let bestBlock: PageLayoutResult['blocks'][number] | null = null
        let bestScore = 0
        for (const block of layout.blocks) {
          const score = scoreOutlineHeadingMatch(getBlockPlainText(block), block.kind, item.title)
          if (score > bestScore) {
            bestScore = score
            bestBlock = block
          }
        }
        return bestScore >= 68 ? bestBlock : null
      }

      const scrollHighlightIntoView = (pageNum: number, attempt = 0): void => {
        if (outlineRequestIdRef.current !== reqId || selectedDocumentIdRef.current !== targetDocId) return
        const leftHighlight = pdfScrollEl?.querySelector<HTMLElement>(
          `.pdf-page[data-page-number="${pageNum}"] .pdf-sentence-highlight`
        )
        const rightHighlight =
          translationScrollEl?.querySelector<HTMLElement>(
            `.translation-page[data-page-number="${pageNum}"] .translation-overlay-sentence.is-active`
          ) ??
          translationScrollEl?.querySelector<HTMLElement>(
            `.translation-page[data-page-number="${pageNum}"] .translation-mirror-sentence.is-active`
          )
        if (leftHighlight && pdfScrollEl) {
          const pageEl = pdfScrollEl.querySelector<HTMLElement>(`.pdf-page[data-page-number="${pageNum}"]`)
          const rootBox = pdfScrollEl.getBoundingClientRect()
          const hlBox = leftHighlight.getBoundingClientRect()
          const pageTopScroll = pageEl
            ? pdfScrollEl.scrollTop + (pageEl.getBoundingClientRect().top - rootBox.top - pdfScrollEl.clientTop)
            : 0
          const offsetFromTop = Math.min(96, pdfScrollEl.clientHeight * 0.16)
          const desired = pdfScrollEl.scrollTop + (hlBox.top - rootBox.top - pdfScrollEl.clientTop) - offsetFromTop
          const clamped = Math.max(
            pageTopScroll,
            Math.min(Math.max(0, pdfScrollEl.scrollHeight - pdfScrollEl.clientHeight), desired)
          )
          if (Math.abs(pdfScrollEl.scrollTop - clamped) > 4) {
            cancelNavigationRef.current?.()
            pdfScrollEl.scrollTop = clamped
          }
        }
        if (rightHighlight && translationScrollEl && (effectivePrimaryViewMode === 'translation' || !scrollSyncLocked)) {
          const pageEl = translationScrollEl.querySelector<HTMLElement>(`.translation-page[data-page-number="${pageNum}"]`)
          const rootBox = translationScrollEl.getBoundingClientRect()
          const hlBox = rightHighlight.getBoundingClientRect()
          const pageTopScroll = pageEl
            ? translationScrollEl.scrollTop + (pageEl.getBoundingClientRect().top - rootBox.top - translationScrollEl.clientTop)
            : 0
          const offsetFromTop = Math.min(96, translationScrollEl.clientHeight * 0.16)
          const desired =
            translationScrollEl.scrollTop + (hlBox.top - rootBox.top - translationScrollEl.clientTop) - offsetFromTop
          const clamped = Math.max(
            pageTopScroll,
            Math.min(Math.max(0, translationScrollEl.scrollHeight - translationScrollEl.clientHeight), desired)
          )
          if (Math.abs(translationScrollEl.scrollTop - clamped) > 4) {
            translationScrollEl.scrollTop = clamped
          }
        }
        if (!leftHighlight && !rightHighlight && attempt < 12) {
          window.setTimeout(() => scrollHighlightIntoView(pageNum, attempt + 1), 80)
        }
      }

      void (async () => {
        let layout = layoutsRef.current.get(targetPage) ?? null
        if (!layout && analyzePageRef.current) {
          layout = await analyzePageRef.current(targetPage).catch(() => null)
          if (layout && selectedDocumentIdRef.current === targetDocId) {
            handlePageLayout(targetPage, layout)
          }
        }
        if (!layout || selectedDocumentIdRef.current !== targetDocId || outlineRequestIdRef.current !== reqId) return
        const block = pickMatchedBlock(layout)
        if (!block) return
        const sentenceIds = block.sentences.map(s => s.id)
        const blockRects = block.sentences.flatMap(s => s.rects)
        const nextSentenceRects = blockRects.length > 0 ? blockRects : [block.bounds]
        setActiveLink({
          pageNumber: targetPage,
          sentenceIds,
          blockKeys: [computeStableTranslationBlockKey(block)],
          sourceRects: nextSentenceRects,
          sentenceRects: nextSentenceRects,
          origin: 'right',
          suppressLeftOverlay: false
        })
        window.requestAnimationFrame(() => scrollHighlightIntoView(targetPage, 0))
      })()
    },
    [handlePageLayout, pdfScrollEl, translationScrollEl, effectivePrimaryViewMode, scrollSyncLocked]
  )

  const handleReturnToPage = useCallback((): void => {
    if (!returnTarget) return
    resolvePaneHandle(returnTarget.paneId)?.navigateToPage(returnTarget.pageNumber)
    setReturnTarget(null)
  }, [returnTarget, resolvePaneHandle])

  const selectDocument = library.select
  const handleJumpToSearchHit = useCallback(
    (documentId: string, pageNumber: number | null): void => {
      if (documentId !== selectedDocumentIdRef.current) {
        pendingJumpRef.current = pageNumber !== null ? { documentId, pageNumber } : null
        selectDocument(documentId)
        return
      }
      if (pageNumber !== null) {
        navigateToPageRef.current?.(pageNumber)
      }
    },
    [selectDocument]
  )

  const handleRightDrivingLeft = useCallback((): void => {
    cancelNavigationRef.current?.()
  }, [])

  const { syncRightToLeft } = useDualScrollSync({
    leftEl: pdfScrollEl,
    rightEl: effectivePrimaryViewMode === 'dual' ? translationScrollEl : null,
    locked: scrollSyncLocked && effectivePrimaryViewMode === 'dual',
    onRightDrivingLeft: handleRightDrivingLeft
  })

  const pageSizeCount = Object.keys(mirrorState.pageSizes).length
  const pageInsetCount = Object.keys(mirrorState.pageInsets).length

  useLayoutEffect(() => {
    if (
      !scrollSyncLocked ||
      effectivePrimaryViewMode !== 'dual' ||
      !pdfScrollEl ||
      !translationScrollEl ||
      mirrorState.pageCount <= 0
    ) {
      return
    }
    syncRightToLeft(true)
  }, [
    scrollSyncLocked,
    effectivePrimaryViewMode,
    isCompareMode,
    pdfScrollEl,
    translationScrollEl,
    mirrorState.pageCount,
    mirrorState.scale,
    mirrorState.cropMargins,
    mirrorState.headerOffsetPx,
    pageSizeCount,
    pageInsetCount,
    dualSplitRatio,
    libraryCollapsed,
    syncRightToLeft
  ])

  const getSplitDragContext = useCallback((): { leftWidth: number; rightWidth: number } | null => {
    const reader = readerPanelRef.current
    const workspace = workspaceRef.current
    if (!reader || !workspace) return null
    const rightEl = workspace.querySelector<HTMLElement>('.translation-panel')
    if (!rightEl) return null
    return {
      leftWidth: reader.getBoundingClientRect().width,
      rightWidth: rightEl.getBoundingClientRect().width
    }
  }, [])

  const targetImportFolderId = useMemo(() => {
    if (!activeFolderId || activeFolderId === 'unassigned') return null
    return library.folders.some(f => f.id === activeFolderId) ? activeFolderId : null
  }, [activeFolderId, library.folders])

  const importPdf = useCallback((): void => {
    void library.importPdf(targetImportFolderId)
  }, [library, targetImportFolderId])
  const retryLibrary = (): void => { void library.refresh() }

  const handleAutoDetectTitle = useCallback(
    async (doc: DocumentRecord): Promise<void> => {
      try {
        const bytes = await window.paperflow.readPdfBytes(doc.id)
        const detected = await extractTitleFromPdfBytes(bytes, doc.displayTitle)
        if (!detected) {
          library.reportNotice('未能从首页提取到更清晰的论文标题，可点击重命名手动修改。')
          return
        }
        const ok = await library.renameDocument(doc.id, detected)
        if (ok) {
          library.reportNotice(`已识别论文标题：「${detected}」`)
        }
      } catch {
        library.reportError('识别论文标题失败，请重试。')
      }
    },
    [library]
  )

  const handleBatchMoveToFolder = useCallback(
    async (documentIds: string[], folderId: string | null): Promise<void> => {
      let moved = 0
      for (const documentId of documentIds) {
        const ok = await library.updateDocumentMeta({ documentId, folderId })
        if (ok) moved += 1
      }
      if (selectedDocumentIdRef.current && documentIds.includes(selectedDocumentIdRef.current)) {
        await refreshDocumentScope(selectedDocumentIdRef.current)
      }
      if (moved > 0) {
        const folderName = folderId
          ? library.folders.find(f => f.id === folderId)?.name ?? '目标分类'
          : '未分类'
        library.reportNotice(`已将 ${moved} 篇文献移动到「${folderName}」`)
      }
    },
    [library, refreshDocumentScope]
  )

  const handleBatchAddTag = useCallback(
    async (documentIds: string[], rawTag: string): Promise<void> => {
      const cleanTag = rawTag.trim()
      if (!cleanTag) return
      let updated = 0
      for (const documentId of documentIds) {
        const doc = library.documents.find(d => d.id === documentId)
        if (!doc) continue
        const existing = doc.tags ?? []
        if (existing.some(t => t.toLowerCase() === cleanTag.toLowerCase())) continue
        const ok = await library.updateDocumentMeta({ documentId, tags: [...existing, cleanTag] })
        if (ok) updated += 1
      }
      if (updated > 0) {
        library.reportNotice(`已为 ${updated} 篇文献添加标签 #${cleanTag}`)
      }
    },
    [library]
  )

  const handleAddGlossaryTerm = useCallback(
    async (input: { source: string; target: string; retranslateAfter?: boolean }): Promise<boolean> => {
      const targetDocId = effectiveSelection?.documentId ?? activeDocumentIdRef.current
      if (!targetDocId) return false
      const source = input.source.trim()
      const target = input.target.trim()
      if (!source || !target) return false

      const targetFolderId = documentScope?.folderId ?? null
      if (targetFolderId) {
        const folder = library.folders.find(f => f.id === targetFolderId)
        if (!folder) return false
        const nextGlossary = [
          ...folder.glossary.filter(item => item.source.trim().toLowerCase() !== source.toLowerCase()),
          { source, target }
        ]
        const savedFolder = await library.updateFolder({
          id: folder.id,
          glossary: nextGlossary
        })
        if (!savedFolder) return false
      } else {
        const current = await window.paperflow.getTranslationSettings()
        const nextGlossary = [
          ...current.glossary.filter(item => item.source.trim().toLowerCase() !== source.toLowerCase()),
          { source, target }
        ]
        const savedSettings = await window.paperflow.saveTranslationSettings({
          provider: current.provider,
          targetLanguage: current.targetLanguage,
          glossary: nextGlossary,
          openai: {
            baseUrl: current.openai.baseUrl,
            model: current.openai.model
          },
          cli: current.cli
        })
        setTranslationSettings(savedSettings)
      }

      await refreshDocumentScope(targetDocId)

      if (input.retranslateAfter && effectiveSelection && effectiveSelection.blockKeys.length > 0) {
        const handle = resolvePaneHandle(effectiveSelection.paneId)
        for (const blockKey of effectiveSelection.blockKeys) {
          if (handle) {
            void handle.retranslateBlock(effectiveSelection.pageNumber, blockKey)
          }
        }
      }
      return true
    },
    [documentScope?.folderId, library, refreshDocumentScope, effectiveSelection, resolvePaneHandle]
  )

  const handleExportBackup = useCallback(async (): Promise<void> => {
    if (backingUp) return
    setBackingUp(true)
    try {
      const result = await window.paperflow.exportBackup()
      if (!result.canceled) {
        library.reportNotice(
          `已导出备份 ${result.fileName ?? '.zip'}：${result.documentCount} 篇文献、${result.annotationCount} 条批注、${result.glossaryCount} 条术语（含 Zotero/EndNote/Obsidian 兼容文件）`
        )
      }
    } catch (err: unknown) {
      library.reportError(err instanceof Error ? err.message : '导出备份失败，请重试。')
    } finally {
      setBackingUp(false)
    }
  }, [backingUp, library])

  const handleExportFolderPdfs = useCallback(
    async (input: ExportFolderPdfsInput): Promise<void> => {
      if (backingUp) return
      setBackingUp(true)
      try {
        const result = await window.paperflow.exportFolderPdfs(input)
        if (!result.canceled) {
          const notesPart =
            result.exportedNotesCount > 0 ? `、${result.exportedNotesCount} 份批注 (.md)` : ''
          library.reportNotice(
            `已按分类目录导出 ${result.exportedCount} 篇 PDF${notesPart}（${result.folderCount} 个文件夹）至：${result.targetDir ?? ''}`
          )
        }
      } catch (err: unknown) {
        library.reportError(err instanceof Error ? err.message : '导出分类 PDF 失败，请重试。')
      } finally {
        setBackingUp(false)
      }
    },
    [backingUp, library]
  )

  const handleExportFolderBibtex = useCallback(
    async (input: { scope: 'all' | 'unassigned' | 'folder'; folderId?: string }): Promise<void> => {
      if (backingUp) return
      setBackingUp(true)
      try {
        const citationsByDocId: Record<
          string,
          {
            title?: string
            authors?: string[]
            year?: string
            venue?: string
            doi?: string
            citeKey?: string
          }
        > = {}
        for (const doc of library.documents) {
          try {
            const raw = localStorage.getItem(`paperflow:citation:v2:${doc.id}`)
            if (!raw) continue
            const parsed = JSON.parse(raw) as Partial<{
              title: string
              authors: string[]
              year: string
              venue: string
              doi: string
              citeKey: string
            }>
            citationsByDocId[doc.id] = {
              ...(typeof parsed.title === 'string' && parsed.title.trim() ? { title: parsed.title.trim() } : {}),
              ...(Array.isArray(parsed.authors)
                ? { authors: parsed.authors.filter((a): a is string => typeof a === 'string' && Boolean(a.trim())) }
                : {}),
              ...(typeof parsed.year === 'string' && parsed.year.trim() ? { year: parsed.year.trim() } : {}),
              ...(typeof parsed.venue === 'string' && parsed.venue.trim() ? { venue: parsed.venue.trim() } : {}),
              ...(typeof parsed.doi === 'string' && parsed.doi.trim() ? { doi: parsed.doi.trim() } : {}),
              ...(typeof parsed.citeKey === 'string' && parsed.citeKey.trim() ? { citeKey: parsed.citeKey.trim() } : {})
            }
          } catch {
            // 忽略单篇坏缓存，回退默认文献标题
          }
        }
        const result = await window.paperflow.exportFolderBibtex({
          ...input,
          citationsByDocId
        })
        if (result.count === 0) {
          library.reportNotice('当前所选分类下暂无文献，未生成 .bib 文件。')
        } else if (!result.canceled && result.fileName) {
          library.reportNotice(`已批量导出 ${result.count} 条引用至 ${result.fileName}`)
        }
      } catch (err: unknown) {
        library.reportError(err instanceof Error ? err.message : '批量导出 .bib 失败，请重试。')
      } finally {
        setBackingUp(false)
      }
    },
    [backingUp, library]
  )

  const handleImportBackup = useCallback(async (): Promise<void> => {
    if (backingUp) return
    setBackingUp(true)
    try {
      const result = await window.paperflow.importBackup()
      if (!result.canceled) {
        await library.refresh()
        const settings = await window.paperflow.getTranslationSettings().catch(() => null)
        if (settings) setTranslationSettings(settings)
        const restoredProfile = await window.paperflow.getResearchProfile().catch(() => null)
        if (restoredProfile) setResearchProfile(restoredProfile)
        loadedAnnotationDocsRef.current.clear()
        const nextAnnMap = new Map<string, AnnotationRecord[]>()
        for (const docId of openAnnotationDocIds) {
          loadedAnnotationDocsRef.current.add(docId)
          const items = await window.paperflow.listAnnotations(docId).catch(() => null)
          if (items) nextAnnMap.set(docId, items)
        }
        setAnnotationsByDocId(nextAnnMap)
        queriedCachePagesRef.current.clear()
        setTranslationRevision(r => r + 1)
        library.reportNotice(
          `已恢复 ${result.fileName ?? '备份'}：新增 ${result.importedDocuments} 篇、已有 ${result.existingDocuments} 篇、批注 ${result.restoredAnnotations} 条、译文 ${result.restoredTranslations} 块、术语 ${result.restoredGlossary} 条`
        )
      }
    } catch (err: unknown) {
      library.reportError(err instanceof Error ? err.message : '恢复备份失败，请确认压缩包有效。')
    } finally {
      setBackingUp(false)
    }
  }, [backingUp, library, openAnnotationDocIds])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (onboardingOpen || event.defaultPrevented) return
      if (event.key === 'Escape') {
        if (shortcutsOpen) {
          setShortcutsOpen(false)
        } else if (citationOpen) {
          setCitationOpen(false)
        } else if (!settingsOpen) {
          if (peekState) {
            peekRequestIdRef.current += 1
            setPeekState(null)
          } else if (explainState) {
            explainRequestIdRef.current += 1
            setExplainState(null)
          } else {
            setActiveLink(null)
            setEditingAnnotation(null)
            setSecondarySelection(null)
            clearOtherSecondarySelections()
            window.getSelection()?.removeAllRanges()
          }
        }
        return
      }

      if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return
      if (settingsOpen) return

      if (matchesShortcutEvent(event, shortcuts.toggleShortcuts)) {
        event.preventDefault()
        setCitationOpen(false)
        setShortcutsOpen(open => !open)
        return
      }

      if (shortcutsOpen || citationOpen) return

      if (matchesShortcutEvent(event, shortcuts.toggleTheme)) {
        event.preventDefault()
        setTheme(curr => (curr === 'light' ? 'sepia' : curr === 'sepia' ? 'dark' : 'light'))
        return
      }
      if (matchesShortcutEvent(event, shortcuts.toggleLibrary)) {
        event.preventDefault()
        setLibraryCollapsed(c => !c)
        return
      }
      if (matchesShortcutEvent(event, shortcuts.toggleAiChat)) {
        event.preventDefault()
        setAiChatOpen(open => !open)
        setAiChatDrawerExpanded(true)
        return
      }
      if (!selectedDocumentId) return
      if (matchesShortcutEvent(event, shortcuts.cycleViewMode)) {
        event.preventDefault()
        if (isCompareMode) {
          setSplitPanes(prev =>
            prev.map(p => {
              if (p.id !== effectiveActivePaneId) return p
              const curr = getPaneViewMode(p)
              const next: SplitPaneViewMode = curr === 'dual' ? 'translation' : curr === 'translation' ? 'source' : 'dual'
              return { ...p, viewMode: next }
            })
          )
        } else {
          setViewMode(curr => (curr === 'dual' ? 'translation' : curr === 'translation' ? 'source' : 'dual'), true)
        }
      } else if (matchesShortcutEvent(event, shortcuts.toggleOutline)) {
        event.preventDefault()
        if (isCompareMode) {
          const activeIdx = resolvedPanes.findIndex(item => item.pane.id === effectiveActivePaneId)
          const targetIdx = activeIdx >= 0 ? activeIdx : 0
          const targetPane = resolvedPanes[targetIdx]
          if (targetPane) {
            if (getPaneViewMode(targetPane.pane) === 'translation') {
              handleChangePaneViewMode(targetPane.pane.id, 'dual')
            }
            if (targetIdx === 0) {
              toolbarActionsRef.current?.toggleOutline()
            } else {
              getPaneToolbarRef(targetPane.pane.id).current?.toggleOutline()
            }
          }
        } else {
          if (viewMode === 'translation') {
            setViewMode('dual')
          }
          toolbarActionsRef.current?.toggleOutline()
        }
      } else if (matchesShortcutEvent(event, shortcuts.toggleAnnotations)) {
        event.preventDefault()
        setAnnotationsOpen(open => !open)
      } else if (matchesShortcutEvent(event, shortcuts.openCitation)) {
        event.preventDefault()
        setCitationOpen(true)
      } else if (matchesShortcutEvent(event, shortcuts.quickHighlight) && selectionCompanion && !savingAnnotation) {
        event.preventDefault()
        void handleCreateHighlight('yellow')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    onboardingOpen,
    settingsOpen,
    shortcutsOpen,
    citationOpen,
    shortcuts,
    peekState,
    explainState,
    selectedDocumentId,
    isCompareMode,
    effectiveActivePaneId,
    resolvedPanes,
    viewMode,
    setViewMode,
    handleChangePaneViewMode,
    getPaneToolbarRef,
    selectionCompanion,
    savingAnnotation,
    handleCreateHighlight,
    clearOtherSecondarySelections
  ])

  useEffect(() => {
    const resetDrop = (): void => {
      dragDepthRef.current = 0
      setDropActive(false)
      setDragHover(null)
      setActiveWorkspaceDrag(null)
    }
    window.addEventListener('blur', resetDrop)
    window.addEventListener('dragend', resetDrop)
    return () => {
      window.removeEventListener('blur', resetDrop)
      window.removeEventListener('dragend', resetDrop)
    }
  }, [])

  const onShellDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (hasDraggedFiles(event.dataTransfer)) event.preventDefault()
  }

  const onShellDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (hasDraggedFiles(event.dataTransfer)) event.preventDefault()
  }

  const onWorkspaceDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDropActive(true)
  }

  const onWorkspaceDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const onWorkspaceDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDropActive(false)
  }

  const onWorkspaceDrop = (event: DragEvent<HTMLElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDropActive(false)
    const files = event.dataTransfer.files
    if (files.length > 0 && !library.importing) {
      void library.importDroppedFiles(files, targetImportFolderId)
    }
  }

  const hasDocument = Boolean(library.selected)
  const shownTitle = useMemo(() => {
    const doc = library.selected
    if (!doc) return ''
    const defaultTitle = doc.originalFilename.replace(/\.pdf$/i, '') || doc.originalFilename
    return doc.displayTitle !== defaultTitle ? doc.displayTitle : doc.originalFilename
  }, [library.selected])

  const engineLabel = useMemo(() => {
    if (!translationSettings) return undefined
    if (translationSettings.provider === 'openai-compatible') {
      return translationSettings.openai.model || undefined
    }
    if (translationSettings.cli.preset === 'codex') return 'Codex CLI'
    if (translationSettings.cli.preset === 'gemini') return 'Gemini CLI'
    return translationSettings.cli.command || '自定义 CLI'
  }, [translationSettings])

  const currentLayout = layouts.get(mirrorState.currentPage)
  const currentCache = translationsByPage.get(mirrorState.currentPage)
  const currentProgress = countTranslatedBlocks(currentLayout, currentCache)
  const isCurrentTranslating = translatingPage === mirrorState.currentPage
  const isCurrentNoText =
    mirrorState.pageTextStatus[mirrorState.currentPage] === false ||
    (currentLayout !== undefined && !currentLayout.hasText)
  const isCurrentFullyTranslated =
    currentProgress.total > 0 && currentProgress.translated === currentProgress.total

  let summaryText = ''
  if (hasDocument) {
    if (batchQueue) {
      summaryText = `连续翻译 第 ${batchQueue.currentPage}/${batchQueue.totalPages} 页 (已完成 ${batchQueue.completedPages} 页)…`
    } else if (isCurrentNoText) {
      summaryText = `第 ${mirrorState.currentPage} 页 · 扫描页`
    } else if (!currentLayout) {
      summaryText = `第 ${mirrorState.currentPage} 页 · 待解析`
    } else if (isCurrentTranslating) {
      summaryText = `第 ${mirrorState.currentPage} 页 · 正在翻译 (${currentProgress.translated}/${currentProgress.total})…`
    } else if (isCurrentFullyTranslated || currentProgress.translated > 0) {
      summaryText = `第 ${mirrorState.currentPage} 页 · 已译 ${currentProgress.translated}/${currentProgress.total}`
    } else {
      const colLabel = currentLayout.columnCount >= 2 ? `${currentLayout.columnCount} 栏` : '单栏'
      summaryText = `第 ${mirrorState.currentPage} 页 · ${colLabel} · ${currentProgress.total} 块待译`
    }
  }
  const fullSummary = engineLabel ? `${summaryText} · ${engineLabel}` : summaryText

  const researchBadgeLabel = useMemo(() => formatResearchProfileBadge(researchProfile), [researchProfile])
  const headerEnginePill = useMemo(
    () => formatHeaderEnginePill(translationSettings, engineLabel ?? null, providerBalance, usageSummary),
    [translationSettings, engineLabel, providerBalance, usageSummary]
  )

  const staleScopeNotice = useMemo(() => {
    if (!documentScope) return null
    const pageCache = translationsByPage.get(mirrorState.currentPage)
    if (!pageCache || pageCache.size === 0) return null
    const expectedSuffix = `|scope:${documentScope.scopeFingerprint}`
    let staleCount = 0
    for (const row of pageCache.values()) {
      if (
        row.translatedText.trim() &&
        row.providerSignature.includes('|scope:') &&
        !row.providerSignature.endsWith(expectedSuffix)
      ) {
        staleCount += 1
      }
    }
    if (staleCount === 0) return null
    return `当前页有 ${staleCount} 段译文基于旧词库/旧分类缓存`
  }, [documentScope, translationsByPage, mirrorState.currentPage])

  const editingFolder = useMemo(
    () => (editingFolderId ? library.folders.find(f => f.id === editingFolderId) ?? null : null),
    [editingFolderId, library.folders]
  )

  const openPaneLabels = useMemo((): Record<string, string> => {
    const map: Record<string, string> = {}
    if (resolvedPanes.length <= 1) return map
    resolvedPanes.forEach((item, index) => {
      const badge = formatPaneBadgeShort(index, resolvedPanes.length)
      map[item.document.id] = map[item.document.id] ? `${map[item.document.id]}/${badge}` : badge
    })
    return map
  }, [resolvedPanes])

  const viewedLibraryDocuments = useMemo(() => {
    if (resolvedPanes.length === 0) return []
    if (resolvedPanes.length === 1) return [{ document: resolvedPanes[0].document }]
    return resolvedPanes.map((item, index) => ({
      document: item.document,
      paneLabel: formatPaneSlotLabel(index, resolvedPanes.length)
    }))
  }, [resolvedPanes])

  const collectChatContexts = useCallback(
    async (scope: AiChatScope): Promise<AiChatContextDocument[]> => {
      if (scope === 'free' || resolvedPanes.length === 0) return []
      const targets =
        scope === 'all-open'
          ? resolvedPanes
          : [resolvedPanes.find(r => r.pane.id === effectiveActivePaneId) ?? resolvedPanes[0]]
      const out: AiChatContextDocument[] = []
      for (const item of targets) {
        const index = resolvedPanes.indexOf(item)
        const paneLabel =
          resolvedPanes.length >= 2 ? formatPaneSlotLabel(index, resolvedPanes.length) : undefined
        let pageNumber = mirrorState.currentPage
        let rawText: string | null = null
        if (index === 0) {
          pageNumber = mirrorState.currentPage
          rawText = extractPageTextRef.current ? await extractPageTextRef.current(pageNumber) : null
        } else {
          const reader = paneStudyHandlesRef.current.get(item.pane.id)
          if (reader) {
            pageNumber = reader.getPageNumber()
            rawText = await reader.extractCurrentPageText()
          }
        }
        const cleaned = rawText ? rawText.replace(/\s+/g, ' ').trim().slice(0, 2600) : undefined
        out.push({
          documentId: item.document.id,
          title: (item.document.displayTitle || item.document.originalFilename).slice(0, 200),
          ...(paneLabel ? { paneLabel } : {}),
          pageNumber,
          ...(cleaned ? { excerpt: cleaned } : {})
        })
      }
      return out
    },
    [resolvedPanes, effectiveActivePaneId, mirrorState.currentPage]
  )

  const collectSkillContexts = useCallback(
    async (scope: AiChatScope, sampling?: SkillSamplingOptions): Promise<AiChatContextDocument[]> => {
      if (scope === 'free' || resolvedPanes.length === 0) return []
      const targets =
        scope === 'all-open'
          ? resolvedPanes
          : [resolvedPanes.find(r => r.pane.id === effectiveActivePaneId) ?? resolvedPanes[0]]
      const out: AiChatContextDocument[] = []

      for (const item of targets) {
        const index = resolvedPanes.indexOf(item)
        const paneLabel =
          resolvedPanes.length >= 2 ? formatPaneSlotLabel(index, resolvedPanes.length) : undefined
        const reader = paneStudyHandlesRef.current.get(item.pane.id)
        const currentPage = index === 0 ? mirrorState.currentPage : (reader?.getPageNumber() ?? 1)
        const pageCount = Math.max(1, index === 0 ? mirrorState.pageCount : (reader?.getPageCount() ?? 1))
        const extractor = index === 0 ? extractPageTextRef.current : (reader ? reader.extractPageText : null)

        const candidatePages = selectBalancedSkillPages({
          pageCount,
          currentPage,
          mode: sampling?.mode,
          customRange: sampling?.customRange
        })

        const pageTexts: Array<{ pageNumber: number; text: string }> = []
        for (const p of candidatePages) {
          if (!extractor) break
          const rawText = await extractor(p).catch(() => null)
          if (rawText && rawText.trim()) {
            pageTexts.push({ pageNumber: p, text: rawText })
          }
        }

        const docAnnotations = annotationsByDocId.get(item.document.id) ?? []
        const { excerpt: fullExcerpt } = assembleSkillExcerpt({
          pageTexts,
          annotations: docAnnotations,
          maxChars: 15_600
        })

        out.push({
          documentId: item.document.id,
          title: (item.document.displayTitle || item.document.originalFilename).slice(0, 200),
          ...(paneLabel ? { paneLabel } : {}),
          pageNumber: currentPage,
          ...(fullExcerpt ? { excerpt: fullExcerpt } : {})
        })
      }
      return out
    },
    [resolvedPanes, effectiveActivePaneId, mirrorState.currentPage, mirrorState.pageCount, annotationsByDocId]
  )

  const allLibraryTags = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const doc of library.documents) {
      for (const tag of doc.tags ?? []) {
        const key = tag.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          list.push(tag)
        }
      }
    }
    return list
  }, [library.documents])

  const openPaneSummaries = useMemo(
    () =>
      resolvedPanes.map((item, index) => ({
        paneId: item.pane.id,
        label: formatPaneSlotLabel(index, resolvedPanes.length),
        title: item.document.displayTitle || item.document.originalFilename
      })),
    [resolvedPanes]
  )

  const activePaneLabel = useMemo(() => {
    if (resolvedPanes.length < 2) return null
    const index = resolvedPanes.findIndex(item => item.pane.id === effectiveActivePaneId)
    return formatPaneSlotLabel(index >= 0 ? index : 0, resolvedPanes.length)
  }, [resolvedPanes, effectiveActivePaneId])

  const openPaneAnnotationSummaries = useMemo(
    () =>
      resolvedPanes.map((item, index) => ({
        paneId: item.pane.id,
        documentId: item.document.id,
        label: formatPaneSlotLabel(index, resolvedPanes.length),
        title: item.document.displayTitle || item.document.originalFilename,
        annotationCount: (annotationsByDocId.get(item.document.id) ?? []).length
      })),
    [resolvedPanes, annotationsByDocId]
  )

  const effectiveSelectionPaneLabel = useMemo(() => {
    if (!isCompareMode) return null
    const targetPaneId = effectiveSelection?.paneId ?? peekPaneIdRef.current ?? effectiveActivePaneId
    const index = resolvedPanes.findIndex(item => item.pane.id === targetPaneId)
    if (index < 0) return activePaneLabel
    return formatPaneSlotLabel(index, resolvedPanes.length)
  }, [isCompareMode, effectiveSelection?.paneId, effectiveActivePaneId, resolvedPanes, activePaneLabel])

  const handleFocusPaneAtPoint = useCallback((clientX: number, clientY: number): void => {
    const panels = workspaceRef.current?.querySelectorAll<HTMLElement>('.reader-panel[data-pane-id]')
    if (!panels || panels.length === 0) return
    let hitPaneId: string | null = null
    let horizontalFallbackId: string | null = null
    for (const panel of panels) {
      const rect = panel.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      const paneId = panel.dataset.paneId ?? null
      if (!paneId) continue
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        hitPaneId = paneId
        break
      }
      if (clientX >= rect.left && clientX <= rect.right && !horizontalFallbackId) {
        horizontalFallbackId = paneId
      }
    }
    const targetId = hitPaneId ?? horizontalFallbackId
    if (targetId) {
      setActivePaneId(prev => (prev === targetId ? prev : targetId))
    }
  }, [])

  const workspaceClasses = ['workspace']
  if (dropActive) workspaceClasses.push('workspace--drop-active')
  if (libraryCollapsed) workspaceClasses.push('workspace--library-collapsed')
  if (isCompareMode) {
    workspaceClasses.push('workspace--reading-compare')
  } else if (hasDocument) {
    workspaceClasses.push(
      viewMode === 'dual'
        ? 'workspace--reading-dual'
        : viewMode === 'translation'
          ? 'workspace--reading-translation'
          : 'workspace--reading-single'
    )
  }

  const workspaceStyle: CSSProperties = {
    '--library-col-width': libraryCollapsed ? '0px' : `${libraryWidthPx}px`,
    ...(!isCompareMode && hasDocument && viewMode === 'dual' && dualSplitRatio !== null
      ? {
          '--dual-left-fr': `${dualSplitRatio}fr`,
          '--dual-right-fr': `${Number((1 - dualSplitRatio).toFixed(4))}fr`
        }
      : {})
  } as CSSProperties

  const renderPrimaryReaderToolbar = (): React.JSX.Element => (
    <ReaderToolbar
      pageNumber={mirrorState.currentPage}
      pageCount={mirrorState.pageCount}
      scale={mirrorState.scale}
      disabled={mirrorState.toolbarDisabled}
      cropMargins={mirrorState.cropMargins}
      onNavigate={page => handleJumpToPage(page)}
      onScale={next => toolbarActionsRef.current?.setScale(next)}
      onFitWidth={() => toolbarActionsRef.current?.fitWidth()}
      onToggleCropMargins={() => toolbarActionsRef.current?.toggleCropMargins()}
    />
  )

  return (
    <div
      className="app-shell"
      data-onboarding-ready={onboardingReady ? 'true' : 'false'}
      onDragOver={onShellDragOver}
      onDrop={onShellDrop}
    >
      <WorkspaceHeader
        libraryCollapsed={libraryCollapsed}
        onToggleLibrary={() => setLibraryCollapsed(collapsed => !collapsed)}
        researchBadgeLabel={researchBadgeLabel}
        onOpenOnboarding={() => setOnboardingOpen(true)}
        hasDocument={hasDocument}
        isCompareMode={isCompareMode}
        activePaneLabel={activePaneLabel}
        activeDocument={activeDocument}
        documentScope={documentScope}
        onOpenScopeGlossary={folderId => {
          if (folderId) {
            setEditingFolderId(folderId)
          } else {
            setSettingsOpen(true)
          }
        }}
        annotationsOpen={annotationsOpen}
        annotationCount={activeAnnotations.length}
        onToggleAnnotations={() => setAnnotationsOpen(open => !open)}
        citationOpen={citationOpen}
        onOpenCitation={() => setCitationOpen(true)}
        headerEnginePill={headerEnginePill}
        onOpenEngineSettings={() => {
          setSettingsFocusSection('default')
          setSettingsOpen(true)
        }}
        themeMenuRef={themeMenuRef}
        theme={theme}
        themeMenuOpen={themeMenuOpen}
        onToggleThemeMenu={() => setThemeMenuOpen(open => !open)}
        onSelectTheme={nextTheme => {
          setTheme(nextTheme)
          setThemeMenuOpen(false)
        }}
        aiChatOpen={aiChatOpen}
        onToggleAiChat={() => {
          if (!aiChatOpen) {
            setAiChatOpen(true)
            setAiChatDrawerExpanded(true)
          } else {
            setAiChatOpen(false)
          }
        }}
        shortcutsOpen={shortcutsOpen}
        onToggleShortcuts={() => setShortcutsOpen(open => !open)}
      />
      {openTabs.length > 0 || hasDocument ? (
        <WorkspaceTabsBar
          openTabs={openTabs}
          resolvedPanes={resolvedPanes}
          translatingPagesByDocId={translatingPagesByDocId}
          hasSelectedDocument={Boolean(library.selected)}
          isCompareMode={isCompareMode}
          shownTitle={shownTitle}
          outlineOpen={mirrorState.outlineOpen}
          searchOpen={mirrorState.searchOpen}
          toolbarDisabled={mirrorState.toolbarDisabled}
          viewMode={viewMode}
          fullSummary={fullSummary}
          translatingPage={translatingPage}
          batchQueue={batchQueue}
          isCurrentFullyTranslated={isCurrentFullyTranslated}
          hasCurrentLayout={Boolean(currentLayout)}
          currentProgressTotal={currentProgress.total}
          isCurrentNoText={isCurrentNoText}
          currentPage={mirrorState.currentPage}
          pageCount={mirrorState.pageCount}
          batchOptionsOpen={batchOptionsOpen}
          batchRangeDraft={batchRangeDraft}
          batchSkipReferences={batchSkipReferences}
          translationExportOpen={translationExportOpen}
          exportingTranslation={exportingTranslation}
          scrollSyncLocked={scrollSyncLocked}
          libraryCollapsed={libraryCollapsed}
          libraryImporting={library.importing}
          onOpenDocument={handleOpenDocument}
          onOpenInSplit={handleOpenInSplit}
          onCloseTab={handleCloseTab}
          onToggleOutline={() => {
            if (viewMode === 'translation') setViewMode('dual')
            toolbarActionsRef.current?.toggleOutline()
          }}
          onToggleSearch={() => {
            if (viewMode === 'translation') setViewMode('dual')
            toolbarActionsRef.current?.toggleSearch()
          }}
          onChangeViewMode={mode => setViewMode(mode, true)}
          onCancelTranslation={() => handleCancelTranslation()}
          onTranslatePage={(pageNumber, force) => {
            void handleTranslatePage(pageNumber, force)
          }}
          onTranslateBatch={(startPage, options) => {
            void handleTranslateBatch(startPage, options)
          }}
          onToggleBatchOptions={() => {
            setTranslationExportOpen(false)
            setBatchRangeDraft(curr =>
              curr.trim() ? curr : `${mirrorState.currentPage}-${mirrorState.pageCount}`
            )
            setBatchOptionsOpen(open => !open)
          }}
          onChangeBatchRangeDraft={setBatchRangeDraft}
          onChangeBatchSkipReferences={setBatchSkipReferences}
          onToggleTranslationExport={() => {
            setBatchOptionsOpen(false)
            setTranslationExportOpen(open => !open)
          }}
          onExportTranslationDocument={format => {
            void handleExportTranslationDocument(format)
          }}
          onToggleScrollSyncLocked={() => setScrollSyncLocked(locked => !locked)}
          onImportPdf={importPdf}
          onToggleCompareMode={handleToggleCompareMode}
        />
      ) : null}
      <main
        ref={workspaceRef}
        className={workspaceClasses.join(' ')}
        style={workspaceStyle}
        onDragEnter={onWorkspaceDragEnter}
        onDragOver={onWorkspaceDragOver}
        onDragLeave={onWorkspaceDragLeave}
        onDrop={onWorkspaceDrop}
      >
        <LibraryPanel
          documents={library.documents}
          folders={library.folders}
          activeFolderId={activeFolderId}
          readerProgress={library.readerProgress}
          recommendedTags={researchProfile?.recommendedTags ?? []}
          selectedId={library.selected?.id}
          secondarySelectedId={isCompareMode ? resolvedPanes[1]?.document.id : undefined}
          openPaneLabels={openPaneLabels}
          translatingPagesByDocId={translatingPagesByDocId}
          viewedDocuments={viewedLibraryDocuments}
          loading={library.loading}
          loadError={library.loadError}
          importing={library.importing}
          error={library.error}
          errorDetails={library.errorDetails}
          notice={library.notice}
          onImport={importPdf}
          onImportFolder={parentId => void library.importFolder(parentId)}
          onRetry={retryLibrary}
          onSelect={handleOpenDocument}
          onOpenInSplit={handleOpenInSplit}
          onSelectFolder={setActiveFolderId}
          onOpenFolderSettings={folderId => setEditingFolderId(folderId)}
          onCreateFolder={library.createFolder}
          onUpdateFolder={library.updateFolder}
          onDeleteFolder={library.deleteFolder}
          onRename={library.renameDocument}
          onAutoDetectTitle={handleAutoDetectTitle}
          onUpdateMeta={library.updateDocumentMeta}
          onBatchMoveToFolder={handleBatchMoveToFolder}
          onBatchAddTag={handleBatchAddTag}
          onJumpToSearchHit={handleJumpToSearchHit}
          onDelete={library.deleteDocument}
          onResetLibrary={async () => {
            const ok = await library.resetLibrary()
            if (ok) {
              autoTranslateEvaluatedRef.current.clear()
              autoTranslateInFlightRef.current.clear()
              autoTranslateRequestedDocumentRef.current = null
              settingsFromUnconfiguredPromptRef.current = null
              setUnconfiguredPrompt(null)
              setDocViewModes({})
              try {
                localStorage.removeItem(DOC_VIEW_MODES_STORAGE_KEY)
              } catch {
                // 忽略存储清除限制
              }
            }
            return ok
          }}
          onOpenLiteratureSearch={preset =>
            setLiteratureSearchModal({
              open: true,
              initialQuery: preset?.query,
              initialTags: preset?.tags
            })
          }
          backingUp={backingUp}
          onExportBackup={() => void handleExportBackup()}
          onImportBackup={() => void handleImportBackup()}
          onExportFolderPdfs={input => void handleExportFolderPdfs(input)}
          onExportFolderBibtex={input => void handleExportFolderBibtex(input)}
          exportIncludeNotes={exportIncludeNotes}
          onToggleExportIncludeNotes={setExportIncludeNotes}
          onDismissError={library.dismissErrors}
          onDismissNotice={library.dismissNotice}
          onReportError={library.reportError}
        />
        {!libraryCollapsed ? (
          <div
            className="library-sidebar-resizer"
            data-testid="library-sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整左侧文献库宽度"
            aria-valuenow={libraryWidthPx}
            aria-valuemin={MIN_LIBRARY_WIDTH_PX}
            aria-valuemax={MAX_LIBRARY_WIDTH_PX}
            title="左右拖拽调整文献库宽度，双击恢复默认"
            onPointerDown={handleLibraryResizerPointerDown}
            onPointerMove={handleLibraryResizerPointerMove}
            onPointerUp={handleLibraryResizerPointerUp}
            onPointerCancel={handleLibraryResizerPointerUp}
            onDoubleClick={() => setLibraryWidthPx(DEFAULT_LIBRARY_WIDTH_PX)}
          />
        ) : null}
        {isCompareMode && primaryPane ? (
          <div className="split-panes-stage-wrap">
          {stageOverflow.left ? <div className="split-stage-fade split-stage-fade--left" aria-hidden="true" /> : null}
          {stageOverflow.right ? <div className="split-stage-fade split-stage-fade--right" aria-hidden="true" /> : null}
          <div
            ref={splitStageRef}
            className="split-panes-stage"
            data-testid="split-panes-stage"
            data-pane-count={resolvedPanes.length}
          >
            <section
              ref={readerPanelRef}
              className={`reader-panel reader-panel--primary${
                effectiveActivePaneId === primaryPane.pane.id ? ' is-pane-focused' : ''
              }${primaryPaneViewMode === 'dual' ? ' is-pane-dual' : ''}${
                effectiveExpandedPaneId === primaryPane.pane.id ? ' is-pane-expanded' : ''
              }${effectiveExpandedPaneId && effectiveExpandedPaneId !== primaryPane.pane.id ? ' is-pane-dimmed' : ''}`}
              data-testid="split-pane-primary"
              data-pane-index={0}
              data-pane-id={primaryPane.pane.id}
              data-document-id={primaryPane.document.id}
              data-pane-view-mode={primaryPaneViewMode}
              data-pane-expanded={effectiveExpandedPaneId === primaryPane.pane.id ? 'true' : 'false'}
              style={{ '--pane-weight': primaryPane.pane.weight } as CSSProperties}
              aria-label="左栏 PDF 阅读器"
              onMouseDown={() => setActivePaneId(primaryPane.pane.id)}
              onDragOver={event => handlePaneDragOver(primaryPane.pane.id, event)}
              onDragLeave={event => handlePaneDragLeave(primaryPane.pane.id, event)}
              onDrop={event => handlePaneDrop(primaryPane.pane.id, event)}
            >
              <div className="split-pane-header">
                <div className="split-pane-header__left">
                  <div
                    className="split-pane-header__drag-zone"
                    draggable
                    data-testid="pane-drag-handle-0"
                    title="按住此区域拖拽到其它分栏可互换或重排位置"
                    onDragStart={event => {
                      event.dataTransfer.setData(PANE_DRAG_MIME, primaryPane.pane.id)
                      event.dataTransfer.setData(DOC_DRAG_MIME, primaryPane.document.id)
                      event.dataTransfer.effectAllowed = 'move'
                      setActiveWorkspaceDrag({
                        kind: 'pane',
                        paneId: primaryPane.pane.id,
                        documentId: primaryPane.document.id
                      })
                    }}
                    onDragEnd={() => setActiveWorkspaceDrag(null)}
                  >
                    <span className="split-pane-header__grip" aria-hidden="true">
                      ⋮⋮
                    </span>
                    <span className="split-pane-header__badge">
                      {formatPaneSlotLabel(0, resolvedPanes.length)}
                    </span>
                  </div>
                  <select
                    className="split-pane-header__select"
                    data-testid="primary-pane-select"
                    aria-label="切换左栏文献"
                    value={primaryPane.document.id}
                    onChange={event => {
                      const nextId = event.target.value
                      setSplitPanes(prev =>
                        prev.map(p => (p.id === primaryPane.pane.id ? { ...p, documentId: nextId } : p))
                      )
                      library.select(nextId)
                    }}
                  >
                    {library.documents.map(doc => (
                      <option key={doc.id} value={doc.id}>
                        {doc.displayTitle || doc.originalFilename}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="split-pane-header__right">
                  <div className="split-pane-mode-switcher" role="group" aria-label="左栏视图模式">
                    {(
                      [
                        { id: 'source', short: '原', full: '原文模式' },
                        { id: 'dual', short: '双', full: '双栏对照' },
                        { id: 'translation', short: '译', full: '纯译文' }
                      ] as const
                    ).map(mode => (
                      <button
                        key={mode.id}
                        type="button"
                        data-testid={`pane-mode-0-${mode.id}`}
                        className={primaryPaneViewMode === mode.id ? 'is-selected' : undefined}
                        aria-label={`左栏${mode.full}`}
                        aria-pressed={primaryPaneViewMode === mode.id}
                        title={mode.full}
                        onClick={() => handleChangePaneViewMode(primaryPane.pane.id, mode.id)}
                      >
                        {mode.short}
                      </button>
                    ))}
                  </div>
                  {primaryPaneViewMode !== 'source' ? (
                    <>
                      {translatingPage !== null || batchQueue ? (
                        <button
                          type="button"
                          className="split-pane-header__translate-btn is-danger"
                          data-testid="pane-translate-btn-0"
                          aria-label="取消左栏翻译"
                          onClick={() => handleCancelTranslation()}
                        >
                          取消
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={
                            isCurrentFullyTranslated
                              ? 'split-pane-header__translate-btn'
                              : 'split-pane-header__translate-btn is-primary'
                          }
                          data-testid="pane-translate-btn-0"
                          aria-label={`左栏${isCurrentFullyTranslated ? '重译本页' : '翻译本页'}`}
                          title={
                            isCurrentFullyTranslated
                              ? '忽略本页本地 SQLite 缓存并重新调用翻译引擎'
                              : '翻译左栏当前这一页'
                          }
                          disabled={!currentLayout || currentProgress.total === 0 || isCurrentNoText}
                          onClick={() => {
                            void handleTranslatePage(mirrorState.currentPage, isCurrentFullyTranslated)
                          }}
                        >
                          {isCurrentFullyTranslated ? '重译' : '翻译'}
                        </button>
                      )}
                      {primaryPaneViewMode === 'dual' ? (
                        <button
                          type="button"
                          className={`split-pane-header__icon-btn${scrollSyncLocked ? ' is-active' : ''}`}
                          data-testid="pane-sync-toggle-0"
                          aria-label="左栏滚动同步锁定"
                          aria-pressed={scrollSyncLocked}
                          title={scrollSyncLocked ? '已锁定同步滚动（点击解锁）' : '已解锁自由滚动（点击锁定）'}
                          onClick={() => setScrollSyncLocked(locked => !locked)}
                        >
                          <LockIcon locked={scrollSyncLocked} />
                        </button>
                      ) : null}
                    </>
                  ) : null}
                  <button
                    type="button"
                    className={`split-pane-header__outline-btn${mirrorState.outlineOpen ? ' is-active' : ''}`}
                    data-testid="pane-outline-btn-0"
                    aria-label="左栏文档目录"
                    aria-expanded={mirrorState.outlineOpen}
                    title="左栏文档目录 (聚焦本栏按 O)"
                    disabled={mirrorState.toolbarDisabled}
                    onClick={() => {
                      setActivePaneId(primaryPane.pane.id)
                      if (primaryPaneViewMode === 'translation') {
                        handleChangePaneViewMode(primaryPane.pane.id, 'dual')
                      }
                      toolbarActionsRef.current?.toggleOutline()
                    }}
                  >
                    <PaneOutlineIcon />
                    <span className="split-pane-header__btn-label">目录</span>
                  </button>
                  <button
                    type="button"
                    className={`split-pane-header__icon-btn${mirrorState.searchOpen ? ' is-active' : ''}`}
                    aria-label="左栏文内搜索"
                    aria-expanded={mirrorState.searchOpen}
                    title="文内搜索"
                    disabled={mirrorState.toolbarDisabled}
                    onClick={() => {
                      setActivePaneId(primaryPane.pane.id)
                      if (primaryPaneViewMode === 'translation') {
                        handleChangePaneViewMode(primaryPane.pane.id, 'dual')
                      }
                      toolbarActionsRef.current?.toggleSearch()
                    }}
                  >
                    <PaneSearchIcon />
                  </button>
                  <button
                    type="button"
                    className={`split-pane-header__icon-btn${effectiveExpandedPaneId === primaryPane.pane.id ? ' is-active' : ''}`}
                    data-testid="pane-expand-btn-0"
                    aria-label={effectiveExpandedPaneId === primaryPane.pane.id ? '还原左栏多开比例' : '临时放大左栏'}
                    aria-pressed={effectiveExpandedPaneId === primaryPane.pane.id}
                    title={effectiveExpandedPaneId === primaryPane.pane.id ? '还原多开分栏比例' : '临时放大本栏聚焦精读'}
                    onClick={() =>
                      setExpandedPaneId(curr => (curr === primaryPane.pane.id ? null : primaryPane.pane.id))
                    }
                  >
                    <PaneExpandIcon expanded={effectiveExpandedPaneId === primaryPane.pane.id} />
                  </button>
                  <button
                    type="button"
                    className="split-pane-header__icon-btn"
                    data-testid="close-primary-pane-btn"
                    aria-label="关闭左栏"
                    title="关闭左栏"
                    onClick={() => {
                      const next = closeSplitPane(resolvedPanes.map(r => r.pane), primaryPane.pane.id)
                      setSplitPanes(next)
                      setActivePaneId(next[0].id)
                      syncPrimarySelected(next)
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div className={`split-pane-body split-pane-body--${primaryPaneViewMode}`}>
                <div className="split-pane-source-slot">
                  <PdfViewer
                    key={primaryPane.document.id}
                    document={primaryPane.document}
                    layoutKey={primaryPaneViewMode}
                    translationPageNumbers={primaryPaneViewMode === 'source' ? undefined : visibleTranslationPages}
                    onKeyboardNavigate={primaryPaneViewMode === 'translation' ? navigatePrimaryReader : undefined}
                    isActivePane={effectiveActivePaneId === primaryPane.pane.id}
                    shortcuts={shortcuts}
                    onPageCount={library.refresh}
                    onPageLayout={handlePageLayout}
                    onPageBackdrop={handlePageBackdrop}
                    onScrollRootChange={setPdfScrollEl}
                    onMirrorStateChange={setMirrorState}
                    cancelNavigationRef={cancelNavigationRef}
                    navigateToPageRef={navigateToPageRef}
                    analyzePageRef={analyzePageRef}
                    extractPageTextRef={extractPageTextRef}
                    extractCitationSourceRef={extractCitationSourceRef}
                    renderRegionPreviewRef={renderRegionPreviewRef}
                    toolbarActionsRef={toolbarActionsRef}
                    hideFloatingPill={primaryPaneViewMode !== 'source'}
                    annotationsByPage={primaryAnnotationsByPage}
                    editingAnnotationId={editingAnnotation?.paneId === primaryPane.pane.id ? editingAnnotation.annotationId : null}
                    activeSentence={activeSourceSentence}
                    onSourceSentenceInteract={handleLeftSourceInteract}
                    onAnnotationClick={ann => handlePaneAnnotationClick(primaryPane.pane.id, ann)}
                    onOutlineNavigate={handleOutlineNavigate}
                  />
                </div>
                {primaryPaneViewMode !== 'source' ? (
                  <TranslationPanel
                    hasDocument
                    documentId={primaryPane.document.id}
                    onVisiblePagesChange={handleTranslationVisiblePages}
                    onCurrentPageChange={primaryPaneViewMode === 'translation' ? handleTranslationCurrentPage : undefined}
                    mirror={mirrorState}
                    layouts={layouts}
                    backdrops={backdrops}
                    translationsByPage={translationsByPage}
                    translatingPage={translatingPage}
                    retranslatingBlockKeys={retranslatingBlockKeys}
                    translationError={translationError}
                    staleScopeNotice={staleScopeNotice}
                    onRefreshStalePage={pageNumber => {
                      void handleTranslatePage(pageNumber, true)
                    }}
                    onRetranslateBlock={(pageNumber, blockKey) => {
                      void handleRetranslateBlock(pageNumber, blockKey)
                    }}
                    onEditBlockTranslation={handleEditBlockTranslation}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onDismissTranslationError={() => setTranslationError(null)}
                    scrollRef={setTranslationScrollEl}
                    activePageNumber={activeLink?.pageNumber ?? null}
                    activeSentenceIds={activeSentenceIds}
                    onSelectTargetSentences={handleRightSentenceSelect}
                    onZoomDelta={delta => toolbarActionsRef.current?.adjustScale(delta)}
                    bottomPill={
                      primaryPaneViewMode === 'translation' ? renderPrimaryReaderToolbar() : undefined
                    }
                  />
                ) : null}
                {primaryPaneViewMode === 'dual' ? (
                  <div className="split-pane-dual-pill-dock" data-testid="pane-dual-pill-dock-0">
                    {renderPrimaryReaderToolbar()}
                  </div>
                ) : null}
              </div>
              {dragHover?.targetPaneId === primaryPane.pane.id ? (
                <div className={`split-drop-overlay split-drop-overlay--${dragHover.zone}`} aria-hidden="true">
                  <div className="split-drop-overlay__badge">
                    {describeDropAction(dragHover.zone, dragHover.sourceKind === 'pane')}
                  </div>
                </div>
              ) : null}
            </section>
            {resolvedPanes.slice(1).map((item, offset) => {
              const index = offset + 1
              return (
                <SplitPdfPane
                  key={item.pane.id}
                  pane={item.pane}
                  index={index}
                  totalPanes={resolvedPanes.length}
                  document={item.document}
                  allDocuments={library.documents}
                  annotationsByPage={annotationsByPageByDocId.get(item.document.id) ?? EMPTY_ANNOTATIONS_BY_PAGE}
                  editingAnnotationId={editingAnnotation?.paneId === item.pane.id ? editingAnnotation.annotationId : null}
                  isFocused={effectiveActivePaneId === item.pane.id}
                  isExpanded={effectiveExpandedPaneId === item.pane.id}
                  isDimmed={effectiveExpandedPaneId !== null && effectiveExpandedPaneId !== item.pane.id}
                  activeDropZone={dragHover?.targetPaneId === item.pane.id ? dragHover.zone : null}
                  activeDropIsPane={dragHover?.sourceKind === 'pane'}
                  translationRevision={translationRevision}
                  activeTranslatingPage={translatingPagesByDocId[item.document.id] ?? null}
                  shortcuts={shortcuts}
                  onTranslatingPageChange={setDocTranslatingPage}
                  onTranslationComplete={(docId, result) => {
                    void handleTranslationCompleted(docId, result)
                  }}
                  onTranslationError={(_docId, message) => handleTranslationErrorToast(message)}
                  toolbarActionsRef={getPaneToolbarRef(item.pane.id)}
                  extractPageTextRef={getPaneExtractTextRef(item.pane.id)}
                  onFocus={() => setActivePaneId(item.pane.id)}
                  onSelectDocument={nextId => {
                    setOpenTabIds(prev => (prev.includes(nextId) ? prev : [...prev, nextId]))
                    setSplitPanes(prev =>
                      prev.map(p => (p.id === item.pane.id ? { ...p, documentId: nextId } : p))
                    )
                  }}
                  onChangeViewMode={mode => handleChangePaneViewMode(item.pane.id, mode)}
                  onToggleExpand={() => setExpandedPaneId(curr => (curr === item.pane.id ? null : item.pane.id))}
                  onSelectionChange={handleSecondarySelectionChange}
                  onAnnotationClick={handlePaneAnnotationClick}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onClose={() => {
                    const next = closeSplitPane(resolvedPanes.map(r => r.pane), item.pane.id)
                    setSplitPanes(next)
                    if (effectiveActivePaneId === item.pane.id) {
                      setActivePaneId(next[Math.max(0, index - 1)]?.id ?? next[0].id)
                    }
                    syncPrimarySelected(next)
                  }}
                  onPageCount={library.refresh}
                  onResizerPointerDown={event => handlePaneResizerPointerDown(item.pane.id, event)}
                  onResizerPointerMove={handlePaneResizerPointerMove}
                  onResizerPointerUp={handlePaneResizerPointerUp}
                  onResetWeights={handleResetPaneWeights}
                  onDragOverPane={event => handlePaneDragOver(item.pane.id, event)}
                  onDragLeavePane={event => handlePaneDragLeave(item.pane.id, event)}
                  onDropOnPane={event => handlePaneDrop(item.pane.id, event)}
                  onRegisterStudyHandle={handleRegisterStudyHandle}
                />
              )
            })}
          </div>
          </div>
        ) : (
          <>
            <section
              ref={readerPanelRef}
              className="reader-panel reader-panel--primary"
              aria-label="PDF 阅读器"
              onMouseDown={() => setActivePaneId(primaryPaneId)}
              onDragOver={event => {
                if (library.selected) handlePaneDragOver(primaryPaneId, event)
              }}
              onDragLeave={event => {
                if (library.selected) handlePaneDragLeave(primaryPaneId, event)
              }}
              onDrop={event => {
                if (library.selected) handlePaneDrop(primaryPaneId, event)
              }}
            >
              {library.selected ? (
                <PdfViewer
                  key={library.selected.id}
                  document={library.selected}
                  layoutKey={viewMode}
                  translationPageNumbers={viewMode === 'source' ? undefined : visibleTranslationPages}
                  onKeyboardNavigate={viewMode === 'translation' ? navigatePrimaryReader : undefined}
                  isActivePane
                  shortcuts={shortcuts}
                  onPageCount={library.refresh}
                  onPageLayout={handlePageLayout}
                  onPageBackdrop={handlePageBackdrop}
                  onScrollRootChange={setPdfScrollEl}
                  onMirrorStateChange={setMirrorState}
                  cancelNavigationRef={cancelNavigationRef}
                  navigateToPageRef={navigateToPageRef}
                  analyzePageRef={analyzePageRef}
                  extractPageTextRef={extractPageTextRef}
                  extractCitationSourceRef={extractCitationSourceRef}
                  renderRegionPreviewRef={renderRegionPreviewRef}
                  toolbarActionsRef={toolbarActionsRef}
                  hideFloatingPill={viewMode !== 'source'}
                  annotationsByPage={primaryAnnotationsByPage}
                  editingAnnotationId={editingAnnotation?.paneId === primaryPaneId ? editingAnnotation.annotationId : null}
                  activeSentence={activeSourceSentence}
                  onSourceSentenceInteract={handleLeftSourceInteract}
                  onAnnotationClick={ann => handlePaneAnnotationClick(primaryPaneId, ann)}
                  onOutlineNavigate={handleOutlineNavigate}
                />
              ) : library.loading ? (
                <div className="reader-placeholder" aria-busy="true"><h1>正在打开文献库</h1></div>
              ) : library.loadError ? (
                <div className="reader-placeholder">
                  <h1>无法打开文献库</h1>
                  <button type="button" className="reader-placeholder__import" onClick={retryLibrary}>重新读取文献库</button>
                </div>
              ) : (
                <div className="reader-placeholder">
                  <h1>打开一篇 PDF</h1>
                  <p>在本地阅读、翻页和缩放。拖选原文后按 <kbd>Ctrl</kbd> + <kbd>C</kbd> 复制。</p>
                  <button type="button" className="reader-placeholder__import" aria-label="选择 PDF 文件"
                    disabled={library.importing} onClick={importPdf}>
                    {library.importing ? '正在导入…' : '选择 PDF 文件'}
                  </button>
                  <p className="reader-placeholder__detail">支持拖拽 PDF 到此窗口；重新打开文献时会恢复上次的页码和缩放。</p>
                </div>
              )}
              {dragHover?.targetPaneId === primaryPaneId ? (
                <div className={`split-drop-overlay split-drop-overlay--${dragHover.zone}`} aria-hidden="true">
                  <div className="split-drop-overlay__badge">
                    {describeDropAction(dragHover.zone, dragHover.sourceKind === 'pane')}
                  </div>
                </div>
              ) : null}
            </section>
            {!hasDocument || viewMode !== 'source' ? (
              <TranslationPanel
                hasDocument={hasDocument}
                documentId={selectedDocumentId}
                onVisiblePagesChange={handleTranslationVisiblePages}
                onCurrentPageChange={viewMode === 'translation' ? handleTranslationCurrentPage : undefined}
                mirror={mirrorState}
                layouts={layouts}
                backdrops={backdrops}
                translationsByPage={translationsByPage}
                translatingPage={translatingPage}
                retranslatingBlockKeys={retranslatingBlockKeys}
                translationError={translationError}
                staleScopeNotice={staleScopeNotice}
                onRefreshStalePage={pageNumber => { void handleTranslatePage(pageNumber, true) }}
                onRetranslateBlock={(pageNumber, blockKey) => { void handleRetranslateBlock(pageNumber, blockKey) }}
                onEditBlockTranslation={handleEditBlockTranslation}
                onOpenSettings={() => setSettingsOpen(true)}
                onDismissTranslationError={() => setTranslationError(null)}
                scrollRef={setTranslationScrollEl}
                activePageNumber={activeLink?.pageNumber ?? null}
                activeSentenceIds={activeSentenceIds}
                onSelectTargetSentences={handleRightSentenceSelect}
                onChangeSplitRatio={viewMode === 'dual' ? setDualSplitRatio : undefined}
                onZoomDelta={delta => toolbarActionsRef.current?.adjustScale(delta)}
                getSplitDragContext={getSplitDragContext}
                splitDropActive={dragHover?.targetPaneId === 'translation'}
                onDragOverSplitTarget={hasDocument ? handleTranslationDragOver : undefined}
                onDragLeaveSplitTarget={hasDocument ? handleTranslationDragLeave : undefined}
                onDropSplitTarget={hasDocument ? handleTranslationDrop : undefined}
                bottomPill={
                  hasDocument && viewMode === 'translation' ? renderPrimaryReaderToolbar() : undefined
                }
              />
            ) : null}
          </>
        )}
        {hasDocument && (
          <SelectionCompanionBar
            selection={selectionCompanion}
            activeAnnotation={activeEditingAnnotation}
            explainState={explainState}
            savingAnnotation={savingAnnotation}
            referenceTargets={referenceTargets}
            peekState={peekState}
            peekPinned={peekPinned}
            returnPageNumber={returnTarget?.pageNumber ?? null}
            onCreateHighlight={handleCreateHighlight}
            onUpdateAnnotation={handleUpdateAnnotation}
            onDeleteAnnotation={handleDeleteAnnotation}
            onCloseNoteEditor={() => setEditingAnnotation(null)}
            onExplain={handleExplainSelection}
            onSaveExplainAsNote={handleSaveExplainAsNote}
            onCloseExplain={() => {
              explainRequestIdRef.current += 1
              setExplainState(null)
            }}
            onClearSelection={() => {
              setActiveLink(null)
              setEditingAnnotation(null)
              setSecondarySelection(null)
              clearOtherSecondarySelections()
              window.getSelection()?.removeAllRanges()
            }}
            onPeekReference={handlePeekReference}
            onClosePeek={() => {
              peekRequestIdRef.current += 1
              setPeekState(null)
              setPeekPinned(false)
            }}
            onTogglePeekPin={() => setPeekPinned(p => !p)}
            onJumpToPage={handleJumpToPage}
            onReturnToPage={handleReturnToPage}
            glossaryScopeLabel={
              documentScope?.folderId
                ? `分类「${documentScope.folderName}」专属词库`
                : '全局翻译词库'
            }
            sourcePaneLabel={effectiveSelectionPaneLabel}
            onAddGlossaryTerm={handleAddGlossaryTerm}
            onAskAi={quoteText => {
              if (effectiveSelection?.paneId) {
                setActivePaneId(effectiveSelection.paneId)
              }
              setAiChatPendingQuote(quoteText)
              setAiChatOpen(true)
              setAiChatDrawerExpanded(true)
            }}
          />
        )}
        {!isCompareMode && hasDocument && viewMode === 'dual' ? (
          <div className="workspace-dual-pill-dock" data-testid="dual-centered-pill-dock">
            {renderPrimaryReaderToolbar()}
          </div>
        ) : null}
        <AiChatWidget
          open={aiChatOpen}
          dockMode={aiChatDockMode}
          drawerExpanded={aiChatDrawerExpanded}
          activeDocument={activeDocument}
          activePaneId={effectiveActivePaneId}
          activePaneLabel={activePaneLabel}
          openPaneCount={resolvedPanes.length}
          openPaneSummaries={openPaneSummaries}
          pendingQuote={aiChatPendingQuote}
          onClearPendingQuote={() => setAiChatPendingQuote(null)}
          onChangeDockMode={setAiChatDockMode}
          onToggleDrawerExpanded={() => setAiChatDrawerExpanded(expanded => !expanded)}
          onFocusPaneAtPoint={handleFocusPaneAtPoint}
          onSelectPaneId={setActivePaneId}
          onClose={() => setAiChatOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          collectContexts={collectChatContexts}
          collectSkillContexts={collectSkillContexts}
          onJumpToPage={handleJumpToPage}
          onSaveReplyAsNote={handleSaveAiReplyAsNote}
          onOpenLiteratureSearch={preset =>
            setLiteratureSearchModal({
              open: true,
              initialQuery: preset?.query,
              initialTags: preset?.tags
            })
          }
          onUsageMutated={() => {
            void refreshUsageAndBalance({ refreshBalance: false })
          }}
        />
        <AnnotationsDrawer
          open={annotationsOpen && hasDocument}
          documentId={activeDocumentId}
          annotations={activeAnnotations}
          activePaneId={effectiveActivePaneId}
          activeDocumentTitle={activeDocument?.displayTitle || activeDocument?.originalFilename || null}
          openPaneSummaries={isCompareMode ? openPaneAnnotationSummaries : undefined}
          onSelectPaneId={setActivePaneId}
          onClose={() => setAnnotationsOpen(false)}
          onSelectAnnotation={handleJumpToAnnotation}
          onUpdateAnnotation={handleUpdateAnnotation}
          onDeleteAnnotation={handleDeleteAnnotation}
          onExportMarkdown={handleExportAnnotationsMarkdown}
        />
        {dropActive && (
          <div className="workspace-dropzone" role="status" aria-live="polite">
            <div className="workspace-dropzone__card">
              <strong>释放以导入 PDF 文献</strong>
              <span>仅在本地校验并存入您的文献库，不上传任何文件</span>
            </div>
          </div>
        )}
      </main>
      <UsageToastLayer
        toast={usageToast}
        unconfiguredPrompt={
          isCompareMode || annotationsOpen || settingsOpen || (aiChatOpen && aiChatDrawerExpanded)
            ? null
            : unconfiguredPrompt
        }
        onDismiss={() => setUsageToast(null)}
        onDismissUnconfiguredPrompt={() => setUnconfiguredPrompt(null)}
        onOpenEngineSettings={() => {
          settingsFromUnconfiguredPromptRef.current =
            unconfiguredPrompt?.documentId ?? selectedDocumentIdRef.current
          setUnconfiguredPrompt(null)
          setSettingsFocusSection('default')
          setSettingsOpen(true)
        }}
        onOpenUsageDetails={() => {
          setUsageToast(null)
          setSettingsFocusSection('usage')
          setSettingsOpen(true)
        }}
      />
      <TranslationSettingsModal
        open={settingsOpen}
        documentId={activeDocumentId}
        initialBalance={providerBalance}
        initialUsageSummary={usageSummary}
        focusSection={settingsFocusSection}
        prefetchNextPage={prefetchNextPage}
        onPrefetchNextPageChange={handlePrefetchNextPageChange}
        onClose={() => {
          settingsFromUnconfiguredPromptRef.current = null
          setSettingsOpen(false)
          setSettingsFocusSection('default')
        }}
        onBalanceUpdated={setProviderBalance}
        onUsageUpdated={setUsageSummary}
        onSaved={settings => {
          setTranslationSettings(settings)
          setTranslationError(null)
          setUnconfiguredPrompt(null)
          setTranslationRevision(r => r + 1)
          const pendingDocId = settingsFromUnconfiguredPromptRef.current
          settingsFromUnconfiguredPromptRef.current = null
          if (
            pendingDocId &&
            pendingDocId === selectedDocumentIdRef.current &&
            isTranslationEngineConfigured(settings)
          ) {
            autoTranslateEvaluatedRef.current.delete(pendingDocId)
            setAutoTranslateRetryTick(t => t + 1)
          }
          void refreshUsageAndBalance()
          void refreshDocumentScope(activeDocumentId)
          if (selectedDocumentId && mirrorState.pageCount > 0) {
            queriedCachePagesRef.current.clear()
            setTranslationsByPage(new Map())
            const minPage = Math.max(1, mirrorState.currentPage - 1)
            const maxPage = Math.min(mirrorState.pageCount, mirrorState.currentPage + 1)
            for (let p = minPage; p <= maxPage; p += 1) {
              queriedCachePagesRef.current.add(p)
              void loadPageCache(selectedDocumentId, p)
            }
          }
        }}
        onDocumentCacheCleared={() => {
          queriedCachePagesRef.current.clear()
          setTranslationsByPage(new Map())
          setTranslationRevision(r => r + 1)
          if (activeDocumentId) {
            setDocTranslatingPage(activeDocumentId, null)
          }
        }}
      />
      <LiteratureSearchModal
        open={literatureSearchModal.open}
        initialQuery={literatureSearchModal.initialQuery}
        initialTags={literatureSearchModal.initialTags}
        libraryTags={allLibraryTags}
        recommendedTags={researchProfile?.recommendedTags ?? []}
        localDocuments={library.documents}
        activeFolderId={activeFolderId}
        onClose={() => setLiteratureSearchModal({ open: false })}
        onImported={async () => {
          await library.refresh()
        }}
        onOpenDocument={docId => {
          setLiteratureSearchModal({ open: false })
          handleOpenDocument(docId)
        }}
      />
      <FolderSettingsModal
        open={Boolean(editingFolder)}
        folder={editingFolder}
        allFolders={library.folders}
        onClose={() => setEditingFolderId(null)}
        onSave={async input => {
          const updated = await library.updateFolder(input)
          if (updated) {
            void refreshDocumentScope(activeDocumentId)
          }
          return updated
        }}
        onDelete={async folderId => {
          const deleted = await library.deleteFolder(folderId)
          if (deleted) {
            setEditingFolderId(null)
            void refreshDocumentScope(activeDocumentId)
          }
          return deleted
        }}
        onExportFolder={folderId =>
          void handleExportFolderPdfs({
            scope: 'folder',
            folderId,
            includeAnnotations: exportIncludeNotes
          })
        }
      />
      <ShortcutsModal
        open={shortcutsOpen}
        shortcuts={shortcuts}
        onUpdateShortcut={handleUpdateShortcut}
        onSwapShortcuts={handleSwapShortcuts}
        onResetShortcut={handleResetShortcut}
        onResetAllShortcuts={handleResetAllShortcuts}
        onClose={() => setShortcutsOpen(false)}
      />
      <CitationModal
        open={citationOpen && hasDocument}
        document={activeDocument}
        paneLabel={isCompareMode ? activePaneLabel : null}
        extractCitationSource={() => resolvePaneHandle(effectiveActivePaneId)?.extractCitationSource() ?? Promise.resolve(null)}
        onClose={() => setCitationOpen(false)}
      />
      <ResearchOnboardingModal
        open={onboardingOpen}
        initialProfile={researchProfile}
        isFirstLaunch={!researchProfile || !researchProfile.completed}
        onClose={() => setOnboardingOpen(false)}
        onSaved={profile => {
          setResearchProfile(profile)
          setOnboardingOpen(false)
          void library.refresh()
          void window.paperflow.getTranslationSettings().then(setTranslationSettings).catch(() => {})
        }}
      />
    </div>
  )
}
