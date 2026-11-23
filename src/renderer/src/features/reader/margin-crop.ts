export interface CropInsets {
  left: number
  top: number
  right: number
  bottom: number
}

export const ZERO_CROP_INSETS: CropInsets = { left: 0, top: 0, right: 0, bottom: 0 }

const MAX_SIDE_CROP = 0.35
const MAX_AXIS_CROP = 0.65
const INK_ALPHA_THRESHOLD = 64
const INK_CHANNEL_THRESHOLD = 240
const SCAN_STRIDE = 2

const clampSide = (value: number): number => Math.min(MAX_SIDE_CROP, Math.max(0, value))

/**
 * 扫描画布 RGBA 像素中的非空白墨迹包围盒，返回归一化四边裁剪比例。
 * 空白页返回全 0；单边上限 0.35，单轴双边累计上限 0.65。
 */
export function measureCanvasCropInsets(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  marginPx = 8
): CropInsets {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    pixels.length < width * height * 4
  ) {
    return ZERO_CROP_INSETS
  }

  let minX = width
  let maxX = -1
  let minY = height
  let maxY = -1

  for (let y = 0; y < height; y += SCAN_STRIDE) {
    const rowOffset = y * width
    for (let x = 0; x < width; x += SCAN_STRIDE) {
      const index = (rowOffset + x) * 4
      if (pixels[index + 3] < INK_ALPHA_THRESHOLD) continue
      if (Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) >= INK_CHANNEL_THRESHOLD) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < minX || maxY < minY) {
    return ZERO_CROP_INSETS
  }

  const padding = Number.isFinite(marginPx) && marginPx > 0 ? marginPx : 0
  const contentLeft = Math.max(0, minX - padding)
  const contentTop = Math.max(0, minY - padding)
  const contentRight = Math.min(width, maxX + 1 + padding)
  const contentBottom = Math.min(height, maxY + 1 + padding)

  let left = clampSide(contentLeft / width)
  let top = clampSide(contentTop / height)
  let right = clampSide((width - contentRight) / width)
  let bottom = clampSide((height - contentBottom) / height)

  const horizontalTotal = left + right
  if (horizontalTotal > MAX_AXIS_CROP) {
    const factor = MAX_AXIS_CROP / horizontalTotal
    left *= factor
    right *= factor
  }

  const verticalTotal = top + bottom
  if (verticalTotal > MAX_AXIS_CROP) {
    const factor = MAX_AXIS_CROP / verticalTotal
    top *= factor
    bottom *= factor
  }

  return { left, top, right, bottom }
}
