export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

export interface FloatingRect {
  x: number
  y: number
  width: number
  height: number
}

export interface StageSize {
  width: number
  height: number
}

export const MIN_FLOAT_WIDTH = 310
export const MIN_FLOAT_HEIGHT = 280
export const DEFAULT_FLOAT_SIZE = { width: 400, height: 490 }
export const DEFAULT_DOCK_WIDTH = 380
export const MIN_DOCK_WIDTH = 300
export const MAX_DOCK_WIDTH = 760

export function computeMaxFloatSize(stage: StageSize): { maxWidth: number; maxHeight: number } {
  const maxWidth =
    stage.width > 0 ? Math.max(MIN_FLOAT_WIDTH, Math.min(stage.width - 16, Math.max(480, Math.floor(stage.width * 0.88)))) : 960
  const maxHeight =
    stage.height > 0 ? Math.max(MIN_FLOAT_HEIGHT, Math.min(stage.height - 16, Math.max(360, Math.floor(stage.height * 0.9)))) : 860
  return { maxWidth, maxHeight }
}

export function clampFloatSize(
  size: { width: number; height: number },
  stage: StageSize
): { width: number; height: number } {
  const { maxWidth, maxHeight } = computeMaxFloatSize(stage)
  return {
    width: Math.max(MIN_FLOAT_WIDTH, Math.min(maxWidth, Math.round(size.width))),
    height: Math.max(MIN_FLOAT_HEIGHT, Math.min(maxHeight, Math.round(size.height)))
  }
}

export function clampFloatingRect(rect: FloatingRect, stage: StageSize, margin = 8): FloatingRect {
  const size = clampFloatSize(rect, stage)
  const maxX = Math.max(margin, stage.width - size.width - margin)
  const maxY = Math.max(margin, stage.height - size.height - margin)
  return {
    x: Math.max(margin, Math.min(maxX, Math.round(rect.x))),
    y: Math.max(margin, Math.min(maxY, Math.round(rect.y))),
    width: size.width,
    height: size.height
  }
}

/**
 * 计算悬浮窗四边/四角自由拖拽缩放后的精确位置与尺寸：
 * - 向左/上边缩放时锁定对侧右/下边界，使窗体自然向左上扩展；
 * - 严格限制不越出阅读区边界与动态最小/最大尺寸。
 */
export function computeResizedFloatingRect(
  origin: FloatingRect,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  stage: StageSize,
  margin = 8
): FloatingRect {
  const { maxWidth, maxHeight } = computeMaxFloatSize(stage)
  let left = origin.x
  let top = origin.y
  let right = origin.x + origin.width
  let bottom = origin.y + origin.height

  const hasW = direction.includes('w')
  const hasE = direction.includes('e')
  const hasN = direction.includes('n')
  const hasS = direction.includes('s')

  if (hasW) {
    const minLeft = Math.max(margin, right - maxWidth)
    const maxLeft = right - MIN_FLOAT_WIDTH
    left = Math.max(minLeft, Math.min(maxLeft, Math.round(origin.x + dx)))
  } else if (hasE) {
    const minRight = left + MIN_FLOAT_WIDTH
    const maxRight = Math.min(stage.width - margin, left + maxWidth)
    right = Math.max(minRight, Math.min(maxRight, Math.round(origin.x + origin.width + dx)))
  }

  if (hasN) {
    const minTop = Math.max(margin, bottom - maxHeight)
    const maxTop = bottom - MIN_FLOAT_HEIGHT
    top = Math.max(minTop, Math.min(maxTop, Math.round(origin.y + dy)))
  } else if (hasS) {
    const minBottom = top + MIN_FLOAT_HEIGHT
    const maxBottom = Math.min(stage.height - margin, top + maxHeight)
    bottom = Math.max(minBottom, Math.min(maxBottom, Math.round(origin.y + origin.height + dy)))
  }

  return {
    x: left,
    y: top,
    width: Math.max(MIN_FLOAT_WIDTH, right - left),
    height: Math.max(MIN_FLOAT_HEIGHT, bottom - top)
  }
}

export function clampDockWidth(rawWidth: number, stageWidth?: number): number {
  const dynamicMax = stageWidth && stageWidth > 0 ? Math.max(420, Math.min(MAX_DOCK_WIDTH, Math.floor(stageWidth * 0.72))) : MAX_DOCK_WIDTH
  return Math.max(MIN_DOCK_WIDTH, Math.min(dynamicMax, Math.round(rawWidth)))
}
