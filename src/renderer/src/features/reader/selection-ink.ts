import type { PageGeometry, PageRect } from './pdf-geometry'

let reader: CanvasRenderingContext2D | null = null

/** 从已渲染的 PDF 画布找字形边界。背景复杂时保留原选框。 */
export function selectionInk(canvas: HTMLCanvasElement, rect: PageRect, geometry: PageGeometry): PageRect | undefined {
  const { x: scaleX, y: scaleY } = geometry.outputScale
  const x = Math.max(0, Math.floor(rect.x * scaleX))
  const y = Math.max(0, Math.floor(rect.y * scaleY))
  const width = Math.min(canvas.width, Math.ceil((rect.x + rect.width) * scaleX)) - x
  const height = Math.min(canvas.height, Math.ceil((rect.y + rect.height) * scaleY)) - y
  if (width <= 0 || height <= 0 || width * height > 512 * 512) return

  reader ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!reader) return
  reader.canvas.width = width
  reader.canvas.height = height
  reader.drawImage(canvas, x, y, width, height, 0, 0, width, height)
  const { data } = reader.getImageData(0, 0, width, height)
  let left = width, top = height, right = 0, bottom = 0
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const p = 4 * (row * width + column)
      if (data[p + 3] < 64 || Math.min(data[p], data[p + 1], data[p + 2]) >= 235) continue
      left = Math.min(left, column)
      right = Math.max(right, column + 1)
      top = Math.min(top, row)
      bottom = Math.max(bottom, row + 1)
    }
  }
  if (right <= left || bottom <= top) return
  const padding = 2
  const inkLeft = Math.max(rect.x, (x + left) / scaleX - padding)
  const inkRight = Math.min(rect.x + rect.width, (x + right) / scaleX + padding)
  const inkTop = Math.max(rect.y, (y + top) / scaleY - padding)
  const inkBottom = Math.min(rect.y + rect.height, (y + bottom) / scaleY + padding)
  return { x: inkLeft, y: inkTop, width: inkRight - inkLeft, height: inkBottom - inkTop }
}
