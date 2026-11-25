import type { PageRect } from '../reader/pdf-geometry'

export interface CropBoxPx {
  sx: number
  sy: number
  sw: number
  sh: number
}

const INK_ALPHA_MIN = 64
const INK_CHANNEL_MAX = 240

function isInkPixel(pixels: ArrayLike<number>, idx: number): boolean {
  if (pixels[idx + 3] < INK_ALPHA_MIN) return false
  return Math.min(pixels[idx], pixels[idx + 1], pixels[idx + 2]) < INK_CHANNEL_MAX
}

function rowInkRatio(
  pixels: ArrayLike<number>,
  width: number,
  y: number,
  x0: number,
  x1: number,
  stepX = 2
): number {
  let ink = 0
  let total = 0
  const rowOffset = y * width
  for (let x = x0; x < x1; x += stepX) {
    total += 1
    if (isInkPixel(pixels, (rowOffset + x) * 4)) ink += 1
  }
  return total > 0 ? ink / total : 0
}

/**
 * 基于像素墨迹密度、同栏正文段落边界与空白间隔带，从离屏 PDF 画布中紧致裁剪图表区域（去除大片白边并避免误裁正文段落）。
 * 适用于单栏、双栏及跨栏图表，零模型依赖。
 */
export function computeTightFigureCropBox(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  kind: 'figure' | 'table',
  captionViewportRect?: PageRect,
  obstacleViewportRects?: readonly PageRect[]
): CropBoxPx | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 24 || height < 24) return null
  if (pixels.length < width * height * 4) return null

  let bandLeft = Math.round(width * 0.04)
  let bandRight = Math.round(width * 0.96)
  let regionTop = Math.round(height * 0.1)
  let regionBottom = Math.round(height * 0.65)

  const blankGapThreshold = Math.max(12, Math.round(height * 0.011))
  const captionToBodyGapLimit = Math.max(36, Math.round(height * 0.045))

  if (captionViewportRect && captionViewportRect.width > 0 && captionViewportRect.height > 0) {
    const capTop = Math.max(0, Math.min(height - 1, Math.floor(captionViewportRect.y)))
    const capBottom = Math.max(capTop + 4, Math.min(height, Math.ceil(captionViewportRect.y + captionViewportRect.height)))
    const wideSpan = captionViewportRect.width >= width * 0.45

    if (wideSpan) {
      bandLeft = Math.max(0, Math.round(width * 0.04))
      bandRight = Math.min(width, Math.round(width * 0.96))
    } else {
      const centerX = captionViewportRect.x + captionViewportRect.width / 2
      const inLeftCol = centerX < width * 0.5
      const padX = Math.round(width * 0.025)
      if (inLeftCol) {
        bandLeft = Math.max(0, Math.min(Math.round(width * 0.04), Math.floor(captionViewportRect.x - padX)))
        bandRight = Math.min(width, Math.max(Math.round(width * 0.50), Math.ceil(captionViewportRect.x + captionViewportRect.width + padX)))
      } else {
        bandLeft = Math.max(0, Math.min(Math.round(width * 0.49), Math.floor(captionViewportRect.x - padX)))
        bandRight = Math.min(width, Math.max(Math.round(width * 0.96), Math.ceil(captionViewportRect.x + captionViewportRect.width + padX)))
      }
    }

    // 过滤出与当前图/表横向重叠的正文障碍块，形成硬性上界/下界，避免紧凑排版中误裁入相邻正文段落
    const overlappingObstacles = (obstacleViewportRects ?? []).filter(obs => {
      const overlapX = Math.min(bandRight, obs.x + obs.width) - Math.max(bandLeft, obs.x)
      return overlapX > Math.min(obs.width, bandRight - bandLeft) * 0.35
    })

    const scanUpward = (startY: number, maxReach: number): number => {
      let minY = Math.max(0, startY - maxReach)
      for (const obs of overlappingObstacles) {
        const obsBottom = Math.ceil(obs.y + obs.height)
        if (obsBottom <= startY - 12 && obsBottom > minY) {
          minY = obsBottom + 2
        }
      }
      let enteredGraphic = false
      let emptyStreak = 0
      let topMostInkY = startY
      let initialGap = 0
      for (let y = startY - 1; y >= minY; y -= 1) {
        const ratio = rowInkRatio(pixels, width, y, bandLeft, bandRight)
        if (ratio >= 0.003) {
          enteredGraphic = true
          emptyStreak = 0
          topMostInkY = y
        } else if (!enteredGraphic) {
          initialGap += 1
          if (initialGap > captionToBodyGapLimit) break
        } else {
          emptyStreak += 1
          if (emptyStreak >= blankGapThreshold) break
        }
      }
      return enteredGraphic ? topMostInkY : Math.max(minY, startY - Math.round(height * 0.22))
    }

    const scanDownward = (startY: number, maxReach: number): number => {
      let maxY = Math.min(height, startY + maxReach)
      for (const obs of overlappingObstacles) {
        const obsTop = Math.floor(obs.y)
        if (obsTop >= startY + 12 && obsTop < maxY) {
          maxY = obsTop - 2
        }
      }
      let enteredGraphic = false
      let emptyStreak = 0
      let bottomMostInkY = startY
      let initialGap = 0
      for (let y = startY; y < maxY; y += 1) {
        const ratio = rowInkRatio(pixels, width, y, bandLeft, bandRight)
        if (ratio >= 0.003) {
          enteredGraphic = true
          emptyStreak = 0
          bottomMostInkY = y + 1
        } else if (!enteredGraphic) {
          initialGap += 1
          if (initialGap > captionToBodyGapLimit) break
        } else {
          emptyStreak += 1
          if (emptyStreak >= blankGapThreshold) break
        }
      }
      return enteredGraphic ? bottomMostInkY : Math.min(maxY, startY + Math.round(height * 0.22))
    }

    if (kind === 'figure') {
      if (capTop >= height * 0.12) {
        regionTop = scanUpward(capTop, Math.round(height * 0.48))
        regionBottom = Math.min(height, capBottom + 8)
      } else {
        regionTop = Math.max(0, capTop - 6)
        regionBottom = scanDownward(capBottom, Math.round(height * 0.45))
      }
    } else {
      if (height - capBottom >= height * 0.14) {
        regionTop = Math.max(0, capTop - 6)
        regionBottom = scanDownward(capBottom, Math.round(height * 0.45))
      } else {
        regionTop = scanUpward(capTop, Math.round(height * 0.45))
        regionBottom = Math.min(height, capBottom + 8)
      }
    }
  }

  // 对初选区域做四边紧致墨迹收边，彻底消除大片空白边
  let minX = bandRight
  let maxX = bandLeft - 1
  let minY = regionBottom
  let maxY = regionTop - 1

  const stride = width > 1000 ? 2 : 1
  for (let y = regionTop; y < regionBottom; y += stride) {
    const rowOffset = y * width
    for (let x = bandLeft; x < bandRight; x += stride) {
      if (isInkPixel(pixels, (rowOffset + x) * 4)) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    const sw = bandRight - bandLeft
    const sh = regionBottom - regionTop
    return sw >= 24 && sh >= 24 ? { sx: bandLeft, sy: regionTop, sw, sh } : null
  }

  const pad = 12
  const sx = Math.max(0, minX - pad)
  const sy = Math.max(0, minY - pad)
  const ex = Math.min(width, maxX + 1 + pad)
  const ey = Math.min(height, maxY + 1 + pad)
  const sw = ex - sx
  const sh = ey - sy
  return sw >= 24 && sh >= 24 ? { sx, sy, sw, sh } : null
}
