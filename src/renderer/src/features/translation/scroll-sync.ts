export interface ScrollMetrics {
  scrollTop: number
  scrollLeft: number
  scrollHeight: number
  scrollWidth: number
  clientHeight: number
  clientWidth: number
}

export interface ScrollOffset {
  top: number
  left: number
}

export interface ExpectedEcho {
  top: number
  left: number
  expiresAt: number
}

function clampScroll(value: number, max: number): number {
  if (!Number.isFinite(value) || max <= 0) return 0
  return Math.max(0, Math.min(max, value))
}

/**
 * 计算源滚动容器变动后，目标镜像容器应当同步到的目标位置（纵向 1:1 像素对齐，横向按可滚动范围比例对齐）。
 * 当源容器不存在横向溢出（maxLeft <= 0）时保留目标横向位置（返回 left: null），防止纵向浏览打断用户横向查看。
 */
export function computeSyncedScrollPosition(
  source: ScrollMetrics,
  target: ScrollMetrics,
  previousSource: ScrollOffset,
  forceBothAxes = false
): { top: number | null; left: number | null } {
  const sourceMaxY = Math.max(0, source.scrollHeight - source.clientHeight)
  const targetMaxY = Math.max(0, target.scrollHeight - target.clientHeight)
  const sourceMaxX = Math.max(0, source.scrollWidth - source.clientWidth)
  const targetMaxX = Math.max(0, target.scrollWidth - target.clientWidth)

  const deltaY = Math.abs(source.scrollTop - previousSource.top)
  const deltaX = Math.abs(source.scrollLeft - previousSource.left)

  let nextTop: number | null = null
  if (forceBothAxes || deltaY > 0.5) {
    nextTop = sourceMaxY <= 0 && targetMaxY <= 0 ? 0 : clampScroll(source.scrollTop, targetMaxY)
  }

  let nextLeft: number | null = null
  if (forceBothAxes || deltaX > 0.5) {
    if (sourceMaxX > 0.5 && targetMaxX > 0.5) {
      const ratio = Math.max(0, Math.min(1, source.scrollLeft / sourceMaxX))
      nextLeft = clampScroll(ratio * targetMaxX, targetMaxX)
    } else if (sourceMaxX > 0.5 && targetMaxX <= 0.5) {
      nextLeft = 0
    } else {
      // sourceMaxX <= 0.5：源栏没有横向滚动条（内容已完全横向展开），不覆盖目标栏当前横向查看位置
      nextLeft = null
    }
  }

  return { top: nextTop, left: nextLeft }
}

/** 判定当前滚动态是否属于刚由对侧代码写入引起的同步回声，避免震荡或误打断导航锚定。 */
export function isEchoScroll(
  actualTop: number,
  actualLeft: number,
  expected: ExpectedEcho | null,
  now: number
): boolean {
  if (!expected || now > expected.expiresAt) return false
  return Math.abs(actualTop - expected.top) <= 1.5 && Math.abs(actualLeft - expected.left) <= 1.5
}
