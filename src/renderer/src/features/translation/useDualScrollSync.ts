import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  computeSyncedScrollPosition,
  isEchoScroll,
  type ExpectedEcho,
  type ScrollMetrics,
  type ScrollOffset
} from './scroll-sync'

export interface UseDualScrollSyncOptions {
  leftEl: HTMLElement | null
  rightEl: HTMLElement | null
  locked: boolean
  /** 仅当用户在锁定态主动滑动右侧面板并带动左侧时触发，用于取消左侧旧的程序导航锚点。 */
  onRightDrivingLeft?: () => void
}

export interface DualScrollSyncControls {
  /** 在重新锁定、缩放或白边裁剪切换后，强制以左侧位置对齐右侧镜像面板。 */
  syncRightToLeft: (forceBothAxes?: boolean) => void
}

function readMetrics(el: HTMLElement): ScrollMetrics {
  return {
    scrollTop: el.scrollTop,
    scrollLeft: el.scrollLeft,
    scrollHeight: el.scrollHeight,
    scrollWidth: el.scrollWidth,
    clientHeight: el.clientHeight,
    clientWidth: el.clientWidth
  }
}

/**
 * 封装双栏面板（原文与译文结构视图）双向同步滚动小功能：
 * 默认锁定（同向上下/左右同步），支持随时手动解锁为两侧完全独立自由滑动，重新锁定时自动对齐回原文位置。
 */
export function useDualScrollSync({
  leftEl,
  rightEl,
  locked,
  onRightDrivingLeft
}: UseDualScrollSyncOptions): DualScrollSyncControls {
  const lockedRef = useRef(locked)
  const wasLockedRef = useRef(locked)
  const onRightDrivingLeftRef = useRef(onRightDrivingLeft)
  const leftElRef = useRef<HTMLElement | null>(leftEl)
  const rightElRef = useRef<HTMLElement | null>(rightEl)

  const lastLeftPosRef = useRef<ScrollOffset>({ top: 0, left: 0 })
  const lastRightPosRef = useRef<ScrollOffset>({ top: 0, left: 0 })
  const expectedLeftEchoRef = useRef<ExpectedEcho | null>(null)
  const expectedRightEchoRef = useRef<ExpectedEcho | null>(null)

  useLayoutEffect(() => {
    lockedRef.current = locked
    onRightDrivingLeftRef.current = onRightDrivingLeft
    leftElRef.current = leftEl
    rightElRef.current = rightEl
  }, [locked, onRightDrivingLeft, leftEl, rightEl])

  const applySync = useCallback(
    (
      source: HTMLElement,
      target: HTMLElement,
      lastSourcePos: React.MutableRefObject<ScrollOffset>,
      lastTargetPos: React.MutableRefObject<ScrollOffset>,
      expectedTargetEcho: React.MutableRefObject<ExpectedEcho | null>,
      forceBothAxes: boolean,
      notifyBeforeWrite?: () => void
    ): boolean => {
      const sourceMetrics = readMetrics(source)
      const targetMetrics = readMetrics(target)
      const { top, left } = computeSyncedScrollPosition(
        sourceMetrics,
        targetMetrics,
        lastSourcePos.current,
        forceBothAxes
      )
      lastSourcePos.current = { top: sourceMetrics.scrollTop, left: sourceMetrics.scrollLeft }

      const shouldWriteTop = top !== null && Math.abs(target.scrollTop - top) > 0.5
      const shouldWriteLeft = left !== null && Math.abs(target.scrollLeft - left) > 0.5
      if (!shouldWriteTop && !shouldWriteLeft) return false

      notifyBeforeWrite?.()

      const beforeTop = target.scrollTop
      const beforeLeft = target.scrollLeft
      if (shouldWriteTop && top !== null) target.scrollTop = top
      if (shouldWriteLeft && left !== null) target.scrollLeft = left

      const appliedTop = target.scrollTop
      const appliedLeft = target.scrollLeft
      lastTargetPos.current = { top: appliedTop, left: appliedLeft }

      if (Math.abs(appliedTop - beforeTop) > 0.1 || Math.abs(appliedLeft - beforeLeft) > 0.1) {
        expectedTargetEcho.current = {
          top: appliedTop,
          left: appliedLeft,
          expiresAt: performance.now() + 180
        }
        return true
      }
      return false
    },
    []
  )

  const syncRightToLeft = useCallback(
    (forceBothAxes = true): void => {
      const left = leftElRef.current
      const right = rightElRef.current
      if (!left || !right || !lockedRef.current) return
      applySync(
        left,
        right,
        lastLeftPosRef,
        lastRightPosRef,
        expectedRightEchoRef,
        forceBothAxes
      )
    },
    [applySync]
  )

  useEffect(() => {
    if (!leftEl) {
      lastLeftPosRef.current = { top: 0, left: 0 }
      expectedLeftEchoRef.current = null
      return
    }
    lastLeftPosRef.current = { top: leftEl.scrollTop, left: leftEl.scrollLeft }

    const handleLeftScroll = (): void => {
      if (isEchoScroll(leftEl.scrollTop, leftEl.scrollLeft, expectedLeftEchoRef.current, performance.now())) {
        expectedLeftEchoRef.current = null
        lastLeftPosRef.current = { top: leftEl.scrollTop, left: leftEl.scrollLeft }
        return
      }
      expectedLeftEchoRef.current = null

      const right = rightElRef.current
      if (!lockedRef.current || !right) {
        lastLeftPosRef.current = { top: leftEl.scrollTop, left: leftEl.scrollLeft }
        return
      }

      applySync(leftEl, right, lastLeftPosRef, lastRightPosRef, expectedRightEchoRef, false)
    }

    leftEl.addEventListener('scroll', handleLeftScroll, { passive: true })
    return () => leftEl.removeEventListener('scroll', handleLeftScroll)
  }, [leftEl, applySync])

  useEffect(() => {
    if (!rightEl) {
      lastRightPosRef.current = { top: 0, left: 0 }
      expectedRightEchoRef.current = null
      return
    }
    lastRightPosRef.current = { top: rightEl.scrollTop, left: rightEl.scrollLeft }

    const handleRightScroll = (): void => {
      if (isEchoScroll(rightEl.scrollTop, rightEl.scrollLeft, expectedRightEchoRef.current, performance.now())) {
        expectedRightEchoRef.current = null
        lastRightPosRef.current = { top: rightEl.scrollTop, left: rightEl.scrollLeft }
        return
      }
      expectedRightEchoRef.current = null

      const left = leftElRef.current
      if (!lockedRef.current || !left) {
        lastRightPosRef.current = { top: rightEl.scrollTop, left: rightEl.scrollLeft }
        return
      }

      applySync(
        rightEl,
        left,
        lastRightPosRef,
        lastLeftPosRef,
        expectedLeftEchoRef,
        false,
        () => onRightDrivingLeftRef.current?.()
      )
    }

    rightEl.addEventListener('scroll', handleRightScroll, { passive: true })
    return () => rightEl.removeEventListener('scroll', handleRightScroll)
  }, [rightEl, applySync])

  useEffect(() => {
    const unlockedToLocked = !wasLockedRef.current && locked
    wasLockedRef.current = locked
    if (unlockedToLocked) {
      syncRightToLeft(true)
    }
  }, [locked, syncRightToLeft])

  return { syncRightToLeft }
}
