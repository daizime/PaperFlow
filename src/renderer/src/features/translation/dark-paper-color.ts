export const DARK_PAPER_DEFAULT_BG = '#232323'

function clamp01(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function parseCssColorRgb(rawColor: string): [number, number, number] | null {
  const color = rawColor.trim().toLowerCase()
  const hexShort = color.match(/^#([0-9a-f]{3})$/)
  if (hexShort) {
    const [r, g, b] = hexShort[1].split('').map(ch => Number.parseInt(ch + ch, 16))
    return [r, g, b]
  }

  const hexFull = color.match(/^#([0-9a-f]{6})$/)
  if (hexFull) {
    const hex = hexFull[1]
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16)
    ]
  }

  const rgbMatch = color.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/)
  if (rgbMatch) {
    const r = Math.min(255, Math.max(0, Number.parseInt(rgbMatch[1], 10)))
    const g = Math.min(255, Math.max(0, Number.parseInt(rgbMatch[2], 10)))
    const b = Math.min(255, Math.max(0, Number.parseInt(rgbMatch[3], 10)))
    return [r, g, b]
  }

  return null
}

/**
 * 按 W3C CSS Filter Effects 顺序精确计算 `invert(0.88) hue-rotate(180deg) contrast(0.95)` 的输出颜色，
 * 使深色模式下译文覆写块背景与反转后的 PDF 页面底图保持无缝统一。
 */
export function mapColorToDarkPaperFilter(color: string): string {
  const parsed = parseCssColorRgb(color)
  if (!parsed) return DARK_PAPER_DEFAULT_BG

  const r0 = parsed[0] / 255
  const g0 = parsed[1] / 255
  const b0 = parsed[2] / 255

  const r1 = clamp01(0.88 - 0.76 * r0)
  const g1 = clamp01(0.88 - 0.76 * g0)
  const b1 = clamp01(0.88 - 0.76 * b0)

  const r2 = clamp01(-0.574 * r1 + 1.43 * g1 + 0.144 * b1)
  const g2 = clamp01(0.426 * r1 + 0.43 * g1 + 0.144 * b1)
  const b2 = clamp01(0.426 * r1 + 1.43 * g1 - 0.856 * b1)

  const r3 = clamp01(r2 * 0.95 + 0.025)
  const g3 = clamp01(g2 * 0.95 + 0.025)
  const b3 = clamp01(b2 * 0.95 + 0.025)

  return `rgb(${Math.round(r3 * 255)}, ${Math.round(g3 * 255)}, ${Math.round(b3 * 255)})`
}
