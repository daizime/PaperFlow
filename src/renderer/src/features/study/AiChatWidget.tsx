import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type {
  AcademicSlideDeck,
  AiChatContextDocument,
  AiChatMessageRecord,
  AiChatScope,
  AiResearchSkillId,
  CustomAiSkillRecord,
  DocumentRecord
} from '../../../../shared/contracts'
import './ai-chat.css'
import {
  clampDockWidth,
  clampFloatingRect,
  clampFloatSize,
  computeResizedFloatingRect,
  DEFAULT_DOCK_WIDTH,
  DEFAULT_FLOAT_SIZE,
  type ResizeDirection
} from './ai-chat-geometry'
import { MarkdownMessage } from './MarkdownMessage'
import { PptPreviewModal } from './PptPreviewModal'
import type { SkillSamplingMode, SkillSamplingOptions } from './skill-context'

export type AiChatDockMode = 'floating' | 'dock-right' | 'dock-left'
type ActivePopover = null | 'scope' | 'more' | 'skills' | 'sampling'

export interface AiChatWidgetProps {
  open: boolean
  dockMode: AiChatDockMode
  drawerExpanded: boolean
  activeDocument: DocumentRecord | null
  activePaneId?: string
  activePaneLabel?: string | null
  openPaneCount: number
  openPaneSummaries?: Array<{ paneId: string; label: string; title: string }>
  pendingQuote: string | null
  onClearPendingQuote(): void
  onChangeDockMode(mode: AiChatDockMode): void
  onToggleDrawerExpanded(): void
  onFocusPaneAtPoint?(clientX: number, clientY: number): void
  onSelectPaneId?(paneId: string): void
  onClose(): void
  onOpenSettings(): void
  collectContexts(scope: AiChatScope): Promise<AiChatContextDocument[]>
  collectSkillContexts?(scope: AiChatScope, sampling?: SkillSamplingOptions): Promise<AiChatContextDocument[]>
  onOpenLiteratureSearch?(preset?: { query?: string; tags?: string[] }): void
  onJumpToPage?(pageNumber: number): void
  onSaveReplyAsNote?(input: { quoteText: string; note: string; pageNumber?: number }): Promise<boolean>
  onUsageMutated?(): void
}

const FLOAT_POS_STORAGE_KEY = 'paperflow:ai-chat-pos'
const FLOAT_SIZE_STORAGE_KEY = 'paperflow:ai-chat-size'
const DOCK_WIDTH_STORAGE_KEY = 'paperflow:ai-chat-dock-width'
const EDGE_DOCK_POINTER_THRESHOLD_PX = 8
const MIN_DRAG_DISTANCE_FOR_DOCK_PX = 16
const RESIZE_DIRECTIONS: readonly ResizeDirection[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']

function computeEdgeSnap(
  clientX: number,
  stageRect: { left: number; right: number },
  dragDistance: number
): 'dock-left' | 'dock-right' | null {
  if (dragDistance < MIN_DRAG_DISTANCE_FOR_DOCK_PX) return null
  if (clientX - stageRect.left <= EDGE_DOCK_POINTER_THRESHOLD_PX) {
    return 'dock-left'
  }
  if (stageRect.right - clientX <= EDGE_DOCK_POINTER_THRESHOLD_PX) {
    return 'dock-right'
  }
  return null
}

function readStoredFloatSize(): { width: number; height: number } {
  try {
    const raw = localStorage.getItem(FLOAT_SIZE_STORAGE_KEY)
    if (!raw) return DEFAULT_FLOAT_SIZE
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown }
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      return clampFloatSize(
        { width: parsed.width, height: parsed.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    }
    return DEFAULT_FLOAT_SIZE
  } catch {
    return DEFAULT_FLOAT_SIZE
  }
}

function readStoredDockWidth(): number {
  try {
    const raw = Number(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY))
    return Number.isFinite(raw) && raw > 0 ? clampDockWidth(raw, window.innerWidth) : DEFAULT_DOCK_WIDTH
  } catch {
    return DEFAULT_DOCK_WIDTH
  }
}

export function AiChatWidget({
  open,
  dockMode,
  drawerExpanded,
  activeDocument,
  activePaneId,
  activePaneLabel,
  openPaneCount,
  openPaneSummaries = [],
  pendingQuote,
  onClearPendingQuote,
  onChangeDockMode,
  onToggleDrawerExpanded,
  onFocusPaneAtPoint,
  onSelectPaneId,
  onClose,
  onOpenSettings,
  collectContexts,
  collectSkillContexts,
  onOpenLiteratureSearch,
  onJumpToPage,
  onSaveReplyAsNote,
  onUsageMutated
}: AiChatWidgetProps): React.JSX.Element | null {
  const sessionKey = activeDocument ? `doc:${activeDocument.id}` : 'workspace:general'
  const [messages, setMessages] = useState<AiChatMessageRecord[]>([])
  const [scope, setScope] = useState<AiChatScope>('active')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [runningSkill, setRunningSkill] = useState<AiResearchSkillId | null>(null)
  const [slideDecksByMessageId, setSlideDecksByMessageId] = useState<Record<string, AcademicSlideDeck>>({})
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null)
  const [customSkills, setCustomSkills] = useState<CustomAiSkillRecord[]>([])
  const [customSkillEditor, setCustomSkillEditor] = useState<{
    id?: string
    name: string
    description: string
    prompt: string
    saving: boolean
    error: string | null
  } | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [samplingMode, setSamplingMode] = useState<SkillSamplingMode>('full-balanced')
  const [customPageRange, setCustomPageRange] = useState('1-3, 6-9')
  const [previewDeckMsgId, setPreviewDeckMsgId] = useState<string | null>(null)
  const [openPopover, setOpenPopover] = useState<ActivePopover>(null)
  const [dockWidth, setDockWidth] = useState<number>(readStoredDockWidth)
  const [floatSize, setFloatSize] = useState<{ width: number; height: number }>(readStoredFloatSize)
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem(FLOAT_POS_STORAGE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return { x: parsed.x, y: parsed.y }
      }
      return null
    } catch {
      return null
    }
  })
  const [snapPreview, setSnapPreview] = useState<'dock-left' | 'dock-right' | null>(null)

  const overlayRef = useRef<HTMLDivElement | null>(null)
  const widgetRef = useRef<HTMLDivElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const suppressScopeClickRef = useRef(false)
  const dragRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    originX: number
    originY: number
    startedDocked: AiChatDockMode
    startedOnScopePill: boolean
  } | null>(null)
  const resizeRef = useRef<{
    kind: ResizeDirection | 'dock-left' | 'dock-right'
    pointerId: number
    startClientX: number
    startClientY: number
    originRect: { x: number; y: number; width: number; height: number }
    startDockWidth: number
  } | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const rows = await window.paperflow.listChatMessages(sessionKey)
      setMessages(rows)
    } catch {
      // 忽略首次读取失败
    }
  }, [sessionKey])

  const loadCustomSkills = useCallback(async () => {
    try {
      const items = await window.paperflow.listCustomAiSkills()
      setCustomSkills(items)
    } catch {
      // 忽略读取自定义技能失败
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void loadHistory()
    void loadCustomSkills()
  }, [open, loadHistory, loadCustomSkills])

  useEffect(() => {
    if (!open) {
      setOpenPopover(null)
    }
  }, [open])

  useEffect(() => {
    if (!open || !drawerExpanded) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [open, drawerExpanded, messages.length, streamingText])

  useEffect(() => {
    if (!open) return
    return window.paperflow.onAiChatStream(event => {
      if (activeRequestIdRef.current && event.requestId === activeRequestIdRef.current) {
        setStreamingText(event.fullText)
      }
    })
  }, [open])

  useEffect(() => {
    if (!sending && !runningSkill) {
      setElapsedSec(0)
      return
    }
    const startedAt = Date.now()
    setElapsedSec(0)
    const timer = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [sending, runningSkill])

  useEffect(() => {
    if (openPaneCount <= 1 && scope === 'all-open') {
      setScope('active')
    }
  }, [openPaneCount, scope])

  useEffect(() => {
    if (!floatPos) return
    try {
      localStorage.setItem(FLOAT_POS_STORAGE_KEY, JSON.stringify(floatPos))
    } catch {
      // 忽略存储限制
    }
  }, [floatPos])

  useEffect(() => {
    try {
      localStorage.setItem(FLOAT_SIZE_STORAGE_KEY, JSON.stringify(floatSize))
    } catch {
      // 忽略存储限制
    }
  }, [floatSize])

  useEffect(() => {
    try {
      localStorage.setItem(DOCK_WIDTH_STORAGE_KEY, String(dockWidth))
    } catch {
      // 忽略存储限制
    }
  }, [dockWidth])

  useEffect(() => {
    if (!open || !openPopover) return
    const handlePointerDownOutside = (event: PointerEvent): void => {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('.ai-chat-popover, .ai-chat-popover-trigger')
      ) {
        return
      }
      setOpenPopover(null)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpenPopover(null)
      }
    }
    window.addEventListener('pointerdown', handlePointerDownOutside, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDownOutside, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, openPopover])

  if (!open) return null

  const effectiveScope: AiChatScope = !activeDocument && scope !== 'free' ? 'free' : scope

  const getStageSize = (): { width: number; height: number } => {
    const rect = overlayRef.current?.getBoundingClientRect()
    return {
      width: rect?.width || window.innerWidth,
      height: rect?.height || window.innerHeight
    }
  }

  const clampFloatingPos = (rawX: number, rawY: number, width: number, height: number): { x: number; y: number } => {
    const clamped = clampFloatingRect({ x: rawX, y: rawY, width, height }, getStageSize(), 8)
    return { x: clamped.x, y: clamped.y }
  }

  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as Element | null
    if (target?.closest('.ai-chat-header__actions button, .ai-chat-popover')) return
    const stage = overlayRef.current
    const widget = widgetRef.current
    if (!stage || !widget) return
    const startedOnScopePill = Boolean(target?.closest('.ai-chat-scope-pill'))
    if (!startedOnScopePill) {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    const stageRect = stage.getBoundingClientRect()
    const wRect = widget.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: wRect.left - stageRect.left,
      originY: wRect.top - stageRect.top,
      startedDocked: dockMode,
      startedOnScopePill
    }
  }

  const handleHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const stage = overlayRef.current
    const widget = widgetRef.current
    if (!drag || drag.pointerId !== event.pointerId || !stage || !widget) return

    const dx = event.clientX - drag.startClientX
    const dy = event.clientY - drag.startClientY
    const dragDist = Math.hypot(dx, dy)

    if (drag.startedOnScopePill && dragDist < 5) {
      return
    }
    if (dragDist >= 5) {
      suppressScopeClickRef.current = true
      setOpenPopover(null)
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // 忽略指针已释放的场景
        }
      }
    }

    // 从边缘停靠抽屉横向拖出超过 28px 时自动脱离停靠变成可自由移动的浮窗
    if (drag.startedDocked !== 'floating') {
      if (Math.abs(dx) < 28) return
      const w = floatSize.width
      const h = drawerExpanded ? floatSize.height : 42
      const detached = clampFloatingPos(drag.originX + dx, Math.max(12, event.clientY - stage.getBoundingClientRect().top - 20), w, h)
      drag.startedDocked = 'floating'
      drag.originX = detached.x
      drag.originY = detached.y
      drag.startClientX = event.clientX
      drag.startClientY = event.clientY
      setSnapPreview(null)
      onChangeDockMode('floating')
      setFloatPos(detached)
      return
    }

    const wRect = widget.getBoundingClientRect()
    const stageRect = stage.getBoundingClientRect()
    const clamped = clampFloatingPos(drag.originX + dx, drag.originY + dy, wRect.width, wRect.height)
    setFloatPos(clamped)

    onFocusPaneAtPoint?.(
      stageRect.left + clamped.x + wRect.width / 2,
      stageRect.top + clamped.y + Math.min(wRect.height / 2, 110)
    )
    setSnapPreview(computeEdgeSnap(event.clientX, stageRect, dragDist))
  }

  const handleHeaderPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const stageRect = overlayRef.current?.getBoundingClientRect()
    const dragDistance = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY)
    const finalSnap =
      drag.startedDocked === 'floating' && stageRect
        ? computeEdgeSnap(event.clientX, stageRect, dragDistance)
        : null
    setSnapPreview(null)
    if (finalSnap) {
      onChangeDockMode(finalSnap)
    } else if (drag.startedDocked === 'floating' && widgetRef.current && dragDistance >= 5) {
      const wRect = widgetRef.current.getBoundingClientRect()
      onFocusPaneAtPoint?.(wRect.left + wRect.width / 2, wRect.top + Math.min(wRect.height / 2, 110))
    }
    if (dragDistance < 5) {
      suppressScopeClickRef.current = false
    } else {
      window.setTimeout(() => {
        suppressScopeClickRef.current = false
      }, 0)
    }
  }

  const handleResizePointerDown = (
    kind: ResizeDirection | 'dock-left' | 'dock-right',
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    if (event.button !== 0 || !widgetRef.current) return
    event.preventDefault()
    event.stopPropagation()
    setOpenPopover(null)
    const widgetRect = widgetRef.current.getBoundingClientRect()
    const stageRect = overlayRef.current?.getBoundingClientRect()
    const originRect = {
      x: stageRect ? widgetRect.left - stageRect.left : floatPos?.x ?? 16,
      y: stageRect ? widgetRect.top - stageRect.top : floatPos?.y ?? 16,
      width: Math.round(widgetRect.width),
      height: Math.round(widgetRect.height)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = {
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originRect,
      startDockWidth: Math.round(widgetRect.width)
    }
  }

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const r = resizeRef.current
    if (!r || r.pointerId !== event.pointerId) return
    const dx = event.clientX - r.startClientX
    const dy = event.clientY - r.startClientY
    const stage = getStageSize()

    if (r.kind === 'dock-right') {
      setDockWidth(clampDockWidth(r.startDockWidth - dx, stage.width))
    } else if (r.kind === 'dock-left') {
      setDockWidth(clampDockWidth(r.startDockWidth + dx, stage.width))
    } else {
      const nextRect = computeResizedFloatingRect(r.originRect, r.kind, dx, dy, stage, 8)
      setFloatPos({ x: nextRect.x, y: nextRect.y })
      setFloatSize({ width: nextRect.width, height: nextRect.height })
    }
  }

  const handleResizePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const r = resizeRef.current
    if (!r || r.pointerId !== event.pointerId) return
    resizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleSend = async (customQuestion?: string, opts?: { quoteOverride?: string }): Promise<void> => {
    const q = (customQuestion ?? draft).trim()
    if (!q || q === '/' || sending || runningSkill) return
    const reqId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    activeRequestIdRef.current = reqId
    setOpenPopover(null)
    setStreamingText('')
    setSending(true)
    setError(null)
    if (!customQuestion) setDraft('')
    const activeQuote = opts?.quoteOverride !== undefined ? opts.quoteOverride : (pendingQuote ?? undefined)
    try {
      const contexts = effectiveScope === 'free' ? [] : await collectContexts(effectiveScope)
      const result = await window.paperflow.sendChatMessage({
        requestId: reqId,
        sessionKey,
        question: q,
        scope: effectiveScope,
        quoteText: activeQuote,
        contexts
      })
      setMessages(prev => [...prev, result.userMessage, result.assistantMessage])
      if (opts?.quoteOverride === undefined) {
        onClearPendingQuote()
      }
      onUsageMutated?.()
    } catch (err: unknown) {
      if (!customQuestion) setDraft(q)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      activeRequestIdRef.current = null
      setStreamingText('')
      setSending(false)
    }
  }

  const handleStopGenerating = (): void => {
    const reqId = activeRequestIdRef.current
    void window.paperflow.cancelAiChat(reqId ?? undefined)
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  const handleClearHistory = async (): Promise<void> => {
    setOpenPopover(null)
    await window.paperflow.clearChatMessages(sessionKey)
    setMessages([])
    setSlideDecksByMessageId({})
    setPreviewDeckMsgId(null)
    setExportNotice(null)
  }

  const handleRunSkill = async (
    skill: AiResearchSkillId,
    options?: { customSkillName?: string; customPrompt?: string; customInstructionOverride?: string }
  ): Promise<void> => {
    if (sending || runningSkill) return
    setOpenPopover(null)
    const targetScope: AiChatScope =
      skill === 'compare-matrix' && openPaneCount >= 2 ? 'all-open' : effectiveScope
    const reqId = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    activeRequestIdRef.current = reqId
    setStreamingText('')
    setRunningSkill(skill)
    setError(null)
    setExportNotice(null)
    const trimmedDraft = draft.trim()
    const customInstruction =
      options?.customInstructionOverride !== undefined
        ? options.customInstructionOverride
        : (trimmedDraft && trimmedDraft !== '/' ? trimmedDraft : undefined)
    try {
      const samplingOpts: SkillSamplingOptions = {
        mode: samplingMode,
        ...(samplingMode === 'custom' ? { customRange: customPageRange } : {})
      }
      const contexts =
        targetScope === 'free'
          ? []
          : collectSkillContexts
            ? await collectSkillContexts(targetScope, samplingOpts)
            : await collectContexts(targetScope)
      const res = await window.paperflow.runAiSkill({
        requestId: reqId,
        sessionKey,
        skill,
        scope: targetScope,
        customInstruction,
        ...(skill === 'custom'
          ? {
              customSkillName: options?.customSkillName,
              customPrompt: options?.customPrompt
            }
          : {}),
        contexts
      })
      if (options?.customInstructionOverride === undefined && trimmedDraft) setDraft('')
      setMessages(prev => [...prev, res.userMessage, res.assistantMessage])
      if (res.slideDeck) {
        const deck = res.slideDeck
        setSlideDecksByMessageId(prev => ({ ...prev, [res.assistantMessage.id]: deck }))
      }
      onUsageMutated?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      activeRequestIdRef.current = null
      setStreamingText('')
      setRunningSkill(null)
    }
  }

  const handleSaveCustomSkillTemplate = async (): Promise<void> => {
    if (!customSkillEditor || customSkillEditor.saving) return
    const name = customSkillEditor.name.trim()
    const prompt = customSkillEditor.prompt.trim()
    const description = customSkillEditor.description.trim()
    if (!name || !prompt) {
      setCustomSkillEditor(curr => (curr ? { ...curr, error: '名称与 Prompt 模板均不能为空。' } : curr))
      return
    }
    setCustomSkillEditor(curr => (curr ? { ...curr, saving: true, error: null } : curr))
    try {
      const updated = await window.paperflow.saveCustomAiSkill({
        ...(customSkillEditor.id ? { id: customSkillEditor.id } : {}),
        name,
        description,
        prompt
      })
      setCustomSkills(updated)
      setCustomSkillEditor(null)
    } catch (err: unknown) {
      setCustomSkillEditor(curr =>
        curr ? { ...curr, saving: false, error: err instanceof Error ? err.message : String(err) } : curr
      )
    }
  }

  const handleDeleteCustomSkillTemplate = async (id: string): Promise<void> => {
    try {
      const updated = await window.paperflow.deleteCustomAiSkill(id)
      setCustomSkills(updated)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRegenerateMessage = async (assistantIndex: number): Promise<void> => {
    if (sending || runningSkill) return
    let prevUser: AiChatMessageRecord | null = null
    for (let i = assistantIndex - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') {
        prevUser = messages[i]
        break
      }
    }
    if (!prevUser) return
    const raw = prevUser.content.trim()
    if (raw.startsWith('【一键技能 · FOCUS 深度总结】')) {
      const extra = raw.replace(/^【一键技能 · FOCUS 深度总结】/, '').trim()
      const isDefaultPrompt = extra.startsWith('请基于当前文献生成保留具体指标')
      await handleRunSkill('summary-focus', { customInstructionOverride: isDefaultPrompt ? undefined : extra })
      return
    }
    if (raw.startsWith('【一键技能 · 生成 PPT】')) {
      const extra = raw.replace(/^【一键技能 · 生成 PPT】/, '').trim()
      const isDefaultPrompt = extra.startsWith('请为当前文献生成结构化')
      await handleRunSkill('ppt-deck', { customInstructionOverride: isDefaultPrompt ? undefined : extra })
      return
    }
    if (raw.startsWith('【一键技能 · 审稿批判】')) {
      const extra = raw.replace(/^【一键技能 · 审稿批判】/, '').trim()
      const isDefaultPrompt = extra.startsWith('请以顶会/顶刊审稿人视角')
      await handleRunSkill('peer-review', { customInstructionOverride: isDefaultPrompt ? undefined : extra })
      return
    }
    if (raw.startsWith('【一键技能 · 多篇对比】')) {
      const extra = raw.replace(/^【一键技能 · 多篇对比】/, '').trim()
      const isDefaultPrompt = extra.startsWith('请生成同屏多篇文献的')
      await handleRunSkill('compare-matrix', { customInstructionOverride: isDefaultPrompt ? undefined : extra })
      return
    }
    const customMatch = /^【自定义技能 · ([^】]+)】(.*)$/.exec(raw)
    if (customMatch) {
      const skillName = customMatch[1].trim()
      const matched = customSkills.find(item => item.name === skillName)
      if (matched) {
        await handleRunSkill('custom', {
          customSkillName: matched.name,
          customPrompt: matched.prompt
        })
        return
      }
    }
    await handleSend(prevUser.content, { quoteOverride: prevUser.quoteText || undefined })
  }

  const handleSaveAssistantMessageAsNote = async (msg: AiChatMessageRecord, assistantIndex: number): Promise<void> => {
    if (!onSaveReplyAsNote || !activeDocument) return
    let prevUser: AiChatMessageRecord | null = null
    for (let i = assistantIndex - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') {
        prevUser = messages[i]
        break
      }
    }
    const pageMatch = /#P\.(\d+)/.exec(msg.contextSummary || '')
    const parsedPage = pageMatch ? Number.parseInt(pageMatch[1], 10) : undefined
    const questionSummary = (prevUser?.content || msg.contextSummary || 'AI 对话总结').replace(/\s+/g, ' ').trim().slice(0, 180)
    const ok = await onSaveReplyAsNote({
      quoteText: `[AI 笔记] ${questionSummary}`,
      note: msg.content,
      pageNumber: parsedPage
    })
    if (ok) {
      setSavedNoteId(msg.id)
      window.setTimeout(() => setSavedNoteId(curr => (curr === msg.id ? null : curr)), 1800)
    }
  }

  const handleTriggerLiteratureSearch = (): void => {
    if (!onOpenLiteratureSearch) return
    setOpenPopover(null)
    onOpenLiteratureSearch({
      ...(activeDocument
        ? {
            query: activeDocument.displayTitle || activeDocument.originalFilename.replace(/\.pdf$/i, ''),
            tags: activeDocument.tags ?? []
          }
        : {})
    })
  }

  const handleExportPptx = async (deck: AcademicSlideDeck): Promise<void> => {
    setError(null)
    setExportNotice(null)
    try {
      const res = await window.paperflow.exportSlideDeckPptx(deck)
      if (!res.canceled && res.fileName) {
        setExportNotice(`已导出 ${res.slideCount} 页幻灯片：${res.fileName}`)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleExportMarkdown = async (msg: AiChatMessageRecord): Promise<void> => {
    setError(null)
    setExportNotice(null)
    try {
      const baseTitle = activeDocument?.displayTitle || activeDocument?.originalFilename || 'PaperFlow总结'
      const res = await window.paperflow.exportMarkdownContent(`${baseTitle}-总结`, msg.content)
      if (!res.canceled && res.fileName) {
        setExportNotice(`已导出 Markdown：${res.fileName}`)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const isDocked = dockMode !== 'floating'
  const widgetClasses = [
    'ai-chat-widget',
    dockMode === 'floating'
      ? 'ai-chat-widget--floating'
      : dockMode === 'dock-left'
        ? 'ai-chat-widget--dock-left'
        : 'ai-chat-widget--dock-right'
  ]
  if (!drawerExpanded) {
    widgetClasses.push(isDocked ? 'is-drawer-collapsed' : 'is-collapsed')
  }

  const widgetStyle: React.CSSProperties = isDocked
    ? { width: drawerExpanded ? `${dockWidth}px` : '0px' }
    : floatPos
      ? {
          left: `${floatPos.x}px`,
          top: `${floatPos.y}px`,
          width: `${floatSize.width}px`,
          height: drawerExpanded ? `${floatSize.height}px` : 'auto'
        }
      : {
          right: '18px',
          top: '16px',
          width: `${floatSize.width}px`,
          height: drawerExpanded ? `${floatSize.height}px` : 'auto'
        }

  const scopePill = (() => {
    if (effectiveScope === 'free') {
      return {
        icon: '💬',
        text: activeDocument ? '自由对话（不带正文）' : 'AI 对话（自由问）',
        title: '自由提问模式：不附带 PDF 页面正文；点击可切换对话范围'
      }
    }
    if (effectiveScope === 'all-open' && openPaneSummaries.length > 0) {
      const fullList = openPaneSummaries.map(item => `${item.label}·${item.title}`).join(' / ')
      return {
        icon: '📚',
        text: `同屏 ${openPaneSummaries.length} 篇（${openPaneSummaries.map(item => item.label).join('/')}）`,
        title: `已识别同屏 ${openPaneSummaries.length} 篇：${fullList}；点击切换`
      }
    }
    if (activeDocument) {
      const title = activeDocument.displayTitle || activeDocument.originalFilename
      return {
        icon: '📄',
        text: `${activePaneLabel ? `${activePaneLabel} · ` : ''}${title}`,
        title: `当前识别：${activePaneLabel ? `[${activePaneLabel}] ` : ''}${title}；点击切换范围或分栏`
      }
    }
    return {
      icon: '💬',
      text: 'AI 对话',
      title: '暂未打开 PDF，可直接自由提问'
    }
  })()

  const samplingButtonText =
    samplingMode === 'around-current'
      ? '当前页附近'
      : samplingMode === 'custom'
        ? `P.${customPageRange.trim() || '自定义'}`
        : '全篇均衡'

  return (
    <div className="reading-stage-overlay" ref={overlayRef} data-testid="ai-chat-overlay">
      {snapPreview ? (
        <div
          className={`ai-chat-dock-preview ${snapPreview === 'dock-left' ? 'ai-chat-dock-preview--left' : 'ai-chat-dock-preview--right'}`}
          aria-hidden="true"
        >
          {snapPreview === 'dock-left' ? '松手停靠为左侧抽屉' : '松手停靠为右侧抽屉'}
        </div>
      ) : null}

      <div
        ref={widgetRef}
        className={widgetClasses.join(' ')}
        style={widgetStyle}
        data-testid="ai-chat-widget"
        data-dock-mode={dockMode}
        data-drawer-expanded={drawerExpanded ? 'true' : 'false'}
        role="dialog"
        aria-label="AI 论文对话助手"
      >
        {isDocked ? (
          <>
            <button
              type="button"
              className="ai-chat-edge-tab"
              data-testid="ai-chat-drawer-toggle"
              aria-label={drawerExpanded ? '收起 AI 抽屉' : '展开 AI 抽屉'}
              title={drawerExpanded ? '收起抽屉到边缘' : '展开 AI 对话抽屉'}
              onClick={onToggleDrawerExpanded}
            >
              <span>{drawerExpanded ? (dockMode === 'dock-right' ? '▸' : '◂') : (dockMode === 'dock-right' ? '◂' : '▸')}</span>
              <span className="ai-chat-edge-tab__label">{drawerExpanded ? '收起' : 'AI 助手'}</span>
            </button>
            {drawerExpanded ? (
              <div
                className="ai-chat-dock-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="调整 AI 抽屉宽度"
                onPointerDown={e => handleResizePointerDown(dockMode, e)}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerUp}
                onPointerCancel={handleResizePointerUp}
              />
            ) : null}
          </>
        ) : null}

        {!isDocked || drawerExpanded ? (
          <>
            <div
              className="ai-chat-header"
              data-testid="ai-chat-drag-handle"
              onPointerDown={handleHeaderPointerDown}
              onPointerMove={handleHeaderPointerMove}
              onPointerUp={handleHeaderPointerUp}
              onPointerCancel={handleHeaderPointerUp}
              onDoubleClick={event => {
                if ((event.target as Element | null)?.closest('button')) return
                onToggleDrawerExpanded()
              }}
            >
              <div className="ai-chat-header__left">
                <span className="ai-chat-header__grip" aria-hidden="true" title="按住拖拽移动，贴边自动停靠">⋮⋮</span>
                <button
                  type="button"
                  className={`ai-chat-scope-pill ai-chat-popover-trigger${openPopover === 'scope' ? ' is-open' : ''}`}
                  data-testid="ai-chat-context-indicator"
                  aria-expanded={openPopover === 'scope'}
                  title={scopePill.title}
                  onClick={() => {
                    if (suppressScopeClickRef.current) return
                    setOpenPopover(curr => (curr === 'scope' ? null : 'scope'))
                  }}
                >
                  <span className="ai-chat-scope-pill__icon" aria-hidden="true">{scopePill.icon}</span>
                  <span className="ai-chat-scope-pill__text">{scopePill.text}</span>
                  <span className="ai-chat-scope-pill__caret" aria-hidden="true">▾</span>
                </button>
              </div>

              <div className="ai-chat-header__actions">
                <button
                  type="button"
                  data-testid="ai-chat-dock-toggle"
                  title={dockMode === 'floating' ? '停靠为右侧抽屉' : '切换为自由拖拽浮窗'}
                  onClick={() => {
                    setOpenPopover(null)
                    onChangeDockMode(dockMode === 'floating' ? 'dock-right' : 'floating')
                  }}
                >
                  {dockMode === 'floating' ? '停靠' : '浮窗'}
                </button>
                <button
                  type="button"
                  className={`ai-chat-popover-trigger${openPopover === 'more' ? ' is-open' : ''}`}
                  data-testid="ai-chat-more-btn"
                  aria-label="更多操作"
                  aria-expanded={openPopover === 'more'}
                  title="模型设置与清空会话"
                  onClick={() => setOpenPopover(curr => (curr === 'more' ? null : 'more'))}
                >
                  ⋯
                </button>
                <button
                  type="button"
                  data-testid={!isDocked ? 'ai-chat-drawer-toggle' : 'ai-chat-inline-collapse'}
                  aria-label={drawerExpanded ? '收起为标题栏' : '展开对话内容'}
                  title={drawerExpanded ? '收起为标题栏（也可双击顶栏）' : '展开对话内容'}
                  onClick={() => {
                    setOpenPopover(null)
                    onToggleDrawerExpanded()
                  }}
                >
                  {drawerExpanded ? '−' : '+'}
                </button>
                <button
                  type="button"
                  data-testid="ai-chat-close-btn"
                  aria-label="关闭 AI 对话"
                  title="关闭窗口"
                  onClick={onClose}
                >
                  ×
                </button>
              </div>

              {openPopover === 'scope' ? (
                <div className="ai-chat-popover ai-chat-popover--scope" data-testid="ai-chat-scope-popover">
                  <div className="ai-chat-popover__title">选择对话参考范围</div>
                  <div className="ai-chat-popover__list">
                    <button
                      type="button"
                      data-testid="ai-chat-scope-active"
                      className={effectiveScope === 'active' ? 'is-active' : undefined}
                      disabled={!activeDocument}
                      onClick={() => {
                        setScope('active')
                        if (!(openPaneSummaries.length >= 2 && onSelectPaneId)) {
                          setOpenPopover(null)
                        }
                      }}
                    >
                      <span className="ai-chat-popover__item-main">📄 当前篇文献 {effectiveScope === 'active' ? '✓' : ''}</span>
                      <span className="ai-chat-popover__item-sub">
                        {activeDocument
                          ? `${activePaneLabel ? `${activePaneLabel} · ` : ''}${activeDocument.displayTitle || activeDocument.originalFilename}`
                          : '需先打开一篇 PDF'}
                      </span>
                    </button>
                    {openPaneCount >= 2 ? (
                      <button
                        type="button"
                        data-testid="ai-chat-scope-all-open"
                        className={effectiveScope === 'all-open' ? 'is-active' : undefined}
                        onClick={() => {
                          setScope('all-open')
                          setOpenPopover(null)
                        }}
                      >
                        <span className="ai-chat-popover__item-main">
                          📚 同屏 {openPaneCount} 篇 {effectiveScope === 'all-open' ? '✓' : ''}
                        </span>
                        <span className="ai-chat-popover__item-sub">
                          {openPaneSummaries.map(item => `${item.label}·${item.title}`).join(' / ')}
                        </span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-testid="ai-chat-scope-free"
                      className={effectiveScope === 'free' ? 'is-active' : undefined}
                      onClick={() => {
                        setScope('free')
                        setOpenPopover(null)
                      }}
                    >
                      <span className="ai-chat-popover__item-main">💬 自由提问模式 {effectiveScope === 'free' ? '✓' : ''}</span>
                      <span className="ai-chat-popover__item-sub">纯通用科研对话，不附加 PDF 正文</span>
                    </button>
                  </div>

                  {openPaneSummaries.length >= 2 && effectiveScope === 'active' && onSelectPaneId ? (
                    <div className="ai-chat-scope-slots" role="group" aria-label="切换识别分栏">
                      <span>分栏焦点：</span>
                      <div className="ai-chat-scope-slots__btns">
                        {openPaneSummaries.map(slot => (
                          <button
                            key={slot.paneId}
                            type="button"
                            className={slot.paneId === activePaneId ? 'is-active' : undefined}
                            title={`切换到「${slot.label}」${slot.title}`}
                            onClick={() => {
                              onSelectPaneId(slot.paneId)
                              setOpenPopover(null)
                            }}
                          >
                            {slot.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {openPopover === 'more' ? (
                <div className="ai-chat-popover ai-chat-popover--more" data-testid="ai-chat-more-popover">
                  <button
                    type="button"
                    data-testid="ai-chat-settings-btn"
                    onClick={() => {
                      setOpenPopover(null)
                      onOpenSettings()
                    }}
                  >
                    <span>引擎与余额设置</span>
                    <span className="ai-chat-popover__shortcut">API / CLI</span>
                  </button>
                  {messages.length > 0 ? (
                    <>
                      <div className="ai-chat-popover__divider" />
                      <button
                        type="button"
                        className="is-danger"
                        data-testid="ai-chat-clear-btn"
                        onClick={() => void handleClearHistory()}
                      >
                        <span>清空当前会话记录</span>
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            {drawerExpanded ? (
              <div className="ai-chat-body" data-testid="ai-chat-body">
                {exportNotice ? (
                  <div className="ai-chat-export-notice" role="status" data-testid="ai-chat-export-notice">
                    <span>{exportNotice}</span>
                    <button type="button" onClick={() => setExportNotice(null)} aria-label="关闭导出提示">
                      ×
                    </button>
                  </div>
                ) : null}

                <div className="ai-chat-messages" data-testid="ai-chat-messages">
                  {messages.length === 0 ? (
                    <div className="ai-chat-empty">
                      <div className="ai-chat-empty__lead">
                        <strong>{activeDocument ? '已连接当前文献，想让我如何协助？' : '暂未打开 PDF，可直接自由提问'}</strong>
                        <span>可直接下方输入问题，或点一键科研技能生成结构化结果</span>
                      </div>
                      <div className="ai-chat-starter-grid" data-testid="ai-skill-starter-grid">
                        <button
                          type="button"
                          data-testid="ai-skill-starter-summary-btn"
                          disabled={sending || Boolean(runningSkill)}
                          onClick={() => void handleRunSkill('summary-focus')}
                        >
                          <span className="ai-chat-starter-card__title">📝 深度总结</span>
                          <span className="ai-chat-starter-card__desc">FOCUS 精读结构化输出</span>
                        </button>
                        <button
                          type="button"
                          data-testid="ai-skill-starter-ppt-btn"
                          disabled={sending || Boolean(runningSkill)}
                          onClick={() => void handleRunSkill('ppt-deck')}
                        >
                          <span className="ai-chat-starter-card__title">📊 生成 PPT</span>
                          <span className="ai-chat-starter-card__desc">16:9 汇报可微调导出</span>
                        </button>
                        <button
                          type="button"
                          data-testid="ai-skill-starter-review-btn"
                          disabled={sending || Boolean(runningSkill)}
                          onClick={() => void handleRunSkill('peer-review')}
                        >
                          <span className="ai-chat-starter-card__title">🔍 审稿批判</span>
                          <span className="ai-chat-starter-card__desc">优势、漏洞与复现风险</span>
                        </button>
                        {onOpenLiteratureSearch ? (
                          <button
                            type="button"
                            data-testid="ai-skill-starter-search-lit-btn"
                            onClick={handleTriggerLiteratureSearch}
                          >
                            <span className="ai-chat-starter-card__title">🌐 搜相关文献</span>
                            <span className="ai-chat-starter-card__desc">按主题标签检索并入库</span>
                          </button>
                        ) : null}
                        {openPaneCount >= 2 ? (
                          <button
                            type="button"
                            className="is-wide"
                            data-testid="ai-skill-starter-compare-btn"
                            disabled={sending || Boolean(runningSkill)}
                            onClick={() => void handleRunSkill('compare-matrix')}
                          >
                            <span className="ai-chat-starter-card__title">⚖️ 多篇对比</span>
                            <span className="ai-chat-starter-card__desc">横向对比同屏 {openPaneCount} 篇文献核心方法与实验指标</span>
                          </button>
                        ) : null}
                      </div>
                      <div className="ai-chat-quick-prompts">
                        <button type="button" onClick={() => void handleSend('总结当前页的核心结论与方法要点。')}>
                          总结本页要点
                        </button>
                        {openPaneCount >= 2 ? (
                          <button type="button" onClick={() => void handleSend('对比同屏打开的这几篇文献在方法和结果上的异同。')}>
                            对比同屏多篇
                          </button>
                        ) : null}
                        <button type="button" onClick={() => void handleSend('梳理这段的关键假设、局限与复现细节。')}>
                          拆解实验与局限
                        </button>
                      </div>
                    </div>
                  ) : (
                    messages.map((msg, msgIdx) => {
                      const slideDeck = slideDecksByMessageId[msg.id]
                      return (
                        <div
                          key={msg.id}
                          className={`ai-chat-bubble ${msg.role === 'user' ? 'ai-chat-bubble--user' : 'ai-chat-bubble--assistant'}`}
                          data-testid={`ai-chat-msg-${msg.role}`}
                        >
                          {msg.quoteText ? <div className="ai-chat-bubble__quote">“{msg.quoteText}”</div> : null}
                          {msg.role === 'assistant' ? (
                            <MarkdownMessage content={msg.content} onJumpToPage={onJumpToPage} />
                          ) : (
                            <div>{msg.content}</div>
                          )}
                          {slideDeck ? (
                            <div className="ai-chat-ppt-card" data-testid="ai-chat-ppt-card">
                              <span>共 {slideDeck.slides.length} 页 16:9 学术幻灯片 · 含演讲备注</span>
                              <div className="ai-chat-ppt-card__actions">
                                <button
                                  type="button"
                                  className="ai-chat-ppt-preview-btn"
                                  data-testid="ai-chat-preview-pptx-btn"
                                  onClick={() => setPreviewDeckMsgId(msg.id)}
                                >
                                  预览与微调
                                </button>
                                <button
                                  type="button"
                                  className="ai-chat-ppt-export-btn"
                                  data-testid="ai-chat-export-pptx-btn"
                                  onClick={() => void handleExportPptx(slideDeck)}
                                >
                                  导出 .pptx
                                </button>
                              </div>
                            </div>
                          ) : null}
                          <div className="ai-chat-bubble__meta">
                            <span>{msg.contextSummary || (msg.role === 'assistant' ? 'AI 回复' : '我')}</span>
                            {msg.role === 'assistant' ? (
                              <span className="ai-chat-bubble__actions">
                                {activeDocument && onSaveReplyAsNote ? (
                                  <button
                                    type="button"
                                    className="ai-chat-bubble__copy"
                                    data-testid="ai-chat-save-note-btn"
                                    title="将本条 AI 回复保存到当前文献批注笔记中"
                                    onClick={() => void handleSaveAssistantMessageAsNote(msg, msgIdx)}
                                  >
                                    {savedNoteId === msg.id ? '已存批注 ✓' : '存为批注'}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="ai-chat-bubble__copy"
                                  data-testid="ai-chat-regenerate-btn"
                                  disabled={sending || Boolean(runningSkill)}
                                  title="基于同一问题重新生成一条回复"
                                  onClick={() => void handleRegenerateMessage(msgIdx)}
                                >
                                  重试
                                </button>
                                <button
                                  type="button"
                                  className="ai-chat-bubble__copy"
                                  data-testid="ai-chat-export-md-btn"
                                  onClick={() => void handleExportMarkdown(msg)}
                                >
                                  导出 .md
                                </button>
                                <button
                                  type="button"
                                  className="ai-chat-bubble__copy"
                                  onClick={() => {
                                    void window.paperflow.copyText(msg.content)
                                    setCopiedId(msg.id)
                                    window.setTimeout(() => setCopiedId(curr => (curr === msg.id ? null : curr)), 1600)
                                  }}
                                >
                                  {copiedId === msg.id ? '已复制' : '复制'}
                                </button>
                              </span>
                            ) : null}
                          </div>
                        </div>
                      )
                    })
                  )}
                  {sending || runningSkill ? (
                    <div
                      className="ai-chat-bubble ai-chat-bubble--assistant"
                      role="status"
                      data-testid={streamingText ? 'ai-chat-streaming-bubble' : undefined}
                    >
                      {streamingText ? (
                        <MarkdownMessage content={streamingText} onJumpToPage={onJumpToPage} />
                      ) : (
                        <div>
                          {runningSkill === 'ppt-deck'
                            ? '正在按学术汇报版式规划幻灯片大纲与演讲备注…'
                            : runningSkill === 'summary-focus'
                              ? '正在按 FOCUS 精读法提取全篇结论与定量细节…'
                              : '正在思考并整理回答…'}
                        </div>
                      )}
                      <div className="ai-chat-bubble__meta">
                        <span>{elapsedSec > 0 ? `已等待 ${elapsedSec}s` : '请求中…'}</span>
                        <button
                          type="button"
                          className="ai-chat-stop-btn"
                          data-testid="ai-chat-stop-inline-btn"
                          onClick={handleStopGenerating}
                        >
                          停止生成
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div ref={messagesEndRef} />
                </div>

                {pendingQuote ? (
                  <div className="ai-chat-quote-pill">
                    <span title={pendingQuote}>引用片段：{pendingQuote}</span>
                    <button type="button" onClick={onClearPendingQuote} aria-label="移除引用片段">
                      ×
                    </button>
                  </div>
                ) : null}

                {error ? (
                  <div className="ai-chat-error" role="alert">
                    <span>{error}</span>
                    <button type="button" onClick={onOpenSettings}>
                      检查模型配置
                    </button>
                  </div>
                ) : null}

                {openPopover === 'skills' ? (
                  <div className="ai-chat-popover ai-chat-popover--skills" data-testid="ai-skill-popover">
                    <div className="ai-chat-popover__head">
                      <span>✦ 一键科研技能（或输入 / 触发）</span>
                      <button type="button" aria-label="关闭技能菜单" onClick={() => setOpenPopover(null)}>
                        ×
                      </button>
                    </div>
                    <div className="ai-chat-popover__list">
                      <button
                        type="button"
                        data-testid="ai-skill-summary-btn"
                        disabled={sending || Boolean(runningSkill)}
                        onClick={() => void handleRunSkill('summary-focus')}
                      >
                        <span className="ai-chat-popover__item-main">📝 深度总结</span>
                        <span className="ai-chat-popover__item-sub">FOCUS 精读法保留数值与方法细节，可导出 .md</span>
                      </button>
                      <button
                        type="button"
                        data-testid="ai-skill-ppt-btn"
                        disabled={sending || Boolean(runningSkill)}
                        onClick={() => void handleRunSkill('ppt-deck')}
                      >
                        <span className="ai-chat-popover__item-main">📊 生成 PPT</span>
                        <span className="ai-chat-popover__item-sub">生成 16:9 汇报大纲与演讲备注，支持微调导出 .pptx</span>
                      </button>
                      <button
                        type="button"
                        data-testid="ai-skill-review-btn"
                        disabled={sending || Boolean(runningSkill)}
                        onClick={() => void handleRunSkill('peer-review')}
                      >
                        <span className="ai-chat-popover__item-main">🔍 审稿批判</span>
                        <span className="ai-chat-popover__item-sub">模拟顶会审稿人梳理优势、漏洞与复现风险</span>
                      </button>
                      {openPaneCount >= 2 ? (
                        <button
                          type="button"
                          data-testid="ai-skill-compare-btn"
                          disabled={sending || Boolean(runningSkill)}
                          onClick={() => void handleRunSkill('compare-matrix')}
                        >
                          <span className="ai-chat-popover__item-main">⚖️ 多篇对比</span>
                          <span className="ai-chat-popover__item-sub">横向对比同屏多篇文献的算法与实验结果</span>
                        </button>
                      ) : null}
                      {onOpenLiteratureSearch ? (
                        <button
                          type="button"
                          data-testid="ai-skill-search-lit-btn"
                          onClick={handleTriggerLiteratureSearch}
                        >
                          <span className="ai-chat-popover__item-main">🌐 搜相关文献</span>
                          <span className="ai-chat-popover__item-sub">基于当前主题与标签在线检索并一键入库 PDF</span>
                        </button>
                      ) : null}
                    </div>
                    <div className="ai-chat-custom-skills-head">
                      <span>自定义技能模板 ({customSkills.length})</span>
                      <button
                        type="button"
                        className="ai-chat-custom-skills-add"
                        data-testid="ai-custom-skill-new-btn"
                        onClick={() =>
                          setCustomSkillEditor({
                            name: '',
                            description: '',
                            prompt: '',
                            saving: false,
                            error: null
                          })
                        }
                      >
                        + 新建模板
                      </button>
                    </div>
                    {customSkills.length > 0 ? (
                      <div className="ai-chat-popover__list">
                        {customSkills.map(item => (
                          <div key={item.id} className="ai-chat-custom-skill-row">
                            <button
                              type="button"
                              data-testid={`ai-custom-skill-run-${item.id}`}
                              disabled={sending || Boolean(runningSkill)}
                              onClick={() =>
                                void handleRunSkill('custom', {
                                  customSkillName: item.name,
                                  customPrompt: item.prompt
                                })
                              }
                            >
                              <span className="ai-chat-popover__item-main">⚡ {item.name}</span>
                              <span className="ai-chat-popover__item-sub">
                                {item.description || item.prompt}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="ai-chat-custom-skill-icon"
                              aria-label={`编辑模板 ${item.name}`}
                              title="编辑此技能模板"
                              onClick={() =>
                                setCustomSkillEditor({
                                  id: item.id,
                                  name: item.name,
                                  description: item.description,
                                  prompt: item.prompt,
                                  saving: false,
                                  error: null
                                })
                              }
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              className="ai-chat-custom-skill-icon is-danger"
                              data-testid={`ai-custom-skill-delete-${item.id}`}
                              aria-label={`删除模板 ${item.name}`}
                              title="删除此技能模板"
                              onClick={() => void handleDeleteCustomSkillTemplate(item.id)}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {customSkillEditor ? (
                      <div className="ai-chat-custom-skill-form" data-testid="ai-custom-skill-form">
                        <input
                          type="text"
                          data-testid="ai-custom-skill-name-input"
                          placeholder="技能名称（例如：实验复现清单）"
                          aria-label="自定义技能名称"
                          value={customSkillEditor.name}
                          onChange={e =>
                            setCustomSkillEditor(curr => (curr ? { ...curr, name: e.target.value, error: null } : curr))
                          }
                        />
                        <input
                          type="text"
                          data-testid="ai-custom-skill-desc-input"
                          placeholder="一句话说明（可选）"
                          aria-label="自定义技能说明"
                          value={customSkillEditor.description}
                          onChange={e =>
                            setCustomSkillEditor(curr =>
                              curr ? { ...curr, description: e.target.value, error: null } : curr
                            )
                          }
                        />
                        <textarea
                          rows={3}
                          data-testid="ai-custom-skill-prompt-input"
                          placeholder="Prompt 指令模板，例如：提取本文所有实验超参、数据集与关键消融结论，标注对应页码。"
                          aria-label="自定义技能 Prompt 模板"
                          value={customSkillEditor.prompt}
                          onChange={e =>
                            setCustomSkillEditor(curr =>
                              curr ? { ...curr, prompt: e.target.value, error: null } : curr
                            )
                          }
                        />
                        {customSkillEditor.error ? (
                          <div className="translation-block-editor-popover__err" role="alert">
                            {customSkillEditor.error}
                          </div>
                        ) : null}
                        <div className="ai-chat-custom-skill-form__actions">
                          <button
                            type="button"
                            disabled={customSkillEditor.saving}
                            onClick={() => setCustomSkillEditor(null)}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="is-primary"
                            data-testid="ai-custom-skill-save-btn"
                            disabled={customSkillEditor.saving}
                            onClick={() => void handleSaveCustomSkillTemplate()}
                          >
                            {customSkillEditor.saving ? '保存中…' : '保存模板'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {openPopover === 'sampling' && activeDocument && effectiveScope !== 'free' ? (
                  <div className="ai-chat-popover ai-chat-popover--sampling" data-testid="ai-sampling-popover">
                    <div className="ai-chat-popover__head">
                      <span>📑 技能与提问读取页码范围</span>
                      <button type="button" aria-label="关闭读取范围面板" onClick={() => setOpenPopover(null)}>
                        ×
                      </button>
                    </div>
                    <div className="ai-chat-popover__list">
                      <button
                        type="button"
                        data-testid="ai-sampling-option-full-balanced"
                        className={samplingMode === 'full-balanced' ? 'is-active' : undefined}
                        onClick={() => {
                          setSamplingMode('full-balanced')
                          setOpenPopover(null)
                        }}
                      >
                        <span className="ai-chat-popover__item-main">全篇均衡采样 {samplingMode === 'full-balanced' ? '✓' : ''}</span>
                        <span className="ai-chat-popover__item-sub">自动抽取首末关键页与中间等距页面，适合总结 / PPT / 审稿</span>
                      </button>
                      <button
                        type="button"
                        data-testid="ai-sampling-option-around-current"
                        className={samplingMode === 'around-current' ? 'is-active' : undefined}
                        onClick={() => {
                          setSamplingMode('around-current')
                          setOpenPopover(null)
                        }}
                      >
                        <span className="ai-chat-popover__item-main">当前页附近 {samplingMode === 'around-current' ? '✓' : ''}</span>
                        <span className="ai-chat-popover__item-sub">聚焦当前正在阅读页及前后邻接页面</span>
                      </button>
                      <button
                        type="button"
                        data-testid="ai-sampling-option-custom"
                        className={samplingMode === 'custom' ? 'is-active' : undefined}
                        onClick={() => setSamplingMode('custom')}
                      >
                        <span className="ai-chat-popover__item-main">指定页码范围 {samplingMode === 'custom' ? '✓' : ''}</span>
                        <span className="ai-chat-popover__item-sub">手动指定页码区间（例如 1-3, 6-9）</span>
                      </button>
                    </div>
                    {samplingMode === 'custom' ? (
                      <div className="ai-chat-sampling-custom-row">
                        <span>页码：</span>
                        <input
                          type="text"
                          data-testid="ai-skill-page-range-input"
                          aria-label="自定义读取页码范围"
                          placeholder="如 1-3, 6-9"
                          value={customPageRange}
                          onChange={e => setCustomPageRange(e.target.value)}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="ai-chat-composer-wrap">
                  <div className="ai-chat-composer">
                    <textarea
                      data-testid="ai-chat-input"
                      rows={2}
                      placeholder="问这篇论文任何问题，或输入 / 呼出科研技能…"
                      value={draft}
                      disabled={sending}
                      onChange={event => {
                        const val = event.target.value
                        setDraft(val)
                        if (val.trim() === '/') {
                          setOpenPopover('skills')
                        }
                      }}
                      onKeyDown={handleComposerKeyDown}
                    />
                    <div className="ai-chat-composer__bar">
                      <div className="ai-chat-composer__tools">
                        <button
                          type="button"
                          className={`ai-chat-tool-btn ai-chat-popover-trigger${openPopover === 'skills' ? ' is-open' : ''}`}
                          data-testid="ai-skill-trigger-btn"
                          title="打开一键科研技能（或在输入框输入 /）"
                          onClick={() => setOpenPopover(curr => (curr === 'skills' ? null : 'skills'))}
                        >
                          <span>✦ 技能</span>
                          {runningSkill ? <span>· 运行中</span> : null}
                          <span aria-hidden="true">▾</span>
                        </button>
                        {activeDocument && effectiveScope !== 'free' ? (
                          <button
                            type="button"
                            className={`ai-chat-tool-btn ai-chat-tool-btn--sampling ai-chat-popover-trigger${
                              openPopover === 'sampling' ? ' is-open' : ''
                            }`}
                            data-testid="ai-sampling-trigger-btn"
                            title="切换科研技能与提问的页码读取范围"
                            onClick={() => setOpenPopover(curr => (curr === 'sampling' ? null : 'sampling'))}
                          >
                            <span>📑 {samplingButtonText}</span>
                            <span aria-hidden="true">▾</span>
                          </button>
                        ) : null}
                      </div>
                      {sending || runningSkill ? (
                        <button
                          type="button"
                          className="ai-chat-stop-main-btn"
                          data-testid="ai-chat-stop-btn"
                          onClick={handleStopGenerating}
                        >
                          ■ 停止{elapsedSec > 0 ? ` (${elapsedSec}s)` : ''}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ai-chat-send-btn"
                          data-testid="ai-chat-send-btn"
                          disabled={!draft.trim() || draft.trim() === '/'}
                          onClick={() => void handleSend()}
                        >
                          发送 ↑
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {!isDocked && drawerExpanded
              ? RESIZE_DIRECTIONS.map(dir => (
                  <div
                    key={dir}
                    className={`ai-chat-resize-handle ai-chat-resize-handle--${dir}`}
                    data-testid={`ai-chat-resize-${dir}`}
                    aria-hidden="true"
                    onPointerDown={e => handleResizePointerDown(dir, e)}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={handleResizePointerUp}
                    onPointerCancel={handleResizePointerUp}
                  />
                ))
              : null}
          </>
        ) : null}
      </div>
      <PptPreviewModal
        open={Boolean(previewDeckMsgId && slideDecksByMessageId[previewDeckMsgId])}
        deck={previewDeckMsgId ? (slideDecksByMessageId[previewDeckMsgId] ?? null) : null}
        onClose={() => setPreviewDeckMsgId(null)}
        onChangeDeck={updatedDeck => {
          if (!previewDeckMsgId) return
          setSlideDecksByMessageId(prev => ({ ...prev, [previewDeckMsgId]: updatedDeck }))
        }}
        onExport={async updatedDeck => {
          await handleExportPptx(updatedDeck)
        }}
      />
    </div>
  )
}
