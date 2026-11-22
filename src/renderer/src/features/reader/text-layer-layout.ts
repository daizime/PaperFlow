import type { PageViewport } from './pdf-engine'
import type { PageTextContent } from './pdf-geometry'

/** 补齐官方 TextLayer 未按 PDF advance 缩放的单字符，不改变原 items/节点映射。 */
export function alignSingleCharacterAdvances(content: PageTextContent, textDivs: readonly HTMLElement[], viewport: PageViewport): void {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return
  let textIndex = 0
  for (const item of content.items) {
    if (!('str' in item)) continue
    const element = textDivs[textIndex++]
    if (!element?.isConnected || element.textContent !== item.str || !item.str.trim() || [...item.str].length !== 1) continue
    const advance = (content.styles[item.fontName]?.vertical ? item.height : item.width) * viewport.scale * viewport.userUnit
    const style = getComputedStyle(element)
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const measured = context.measureText(item.str).width
    const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform)
    // 基线基矢长度保留 rotate/min-font-size 的影响，不能用旋转后 AABB 宽度推导 advance。
    const actual = measured * Math.hypot(matrix.a, matrix.b)
    const previous = Number.parseFloat(style.getPropertyValue('--scale-x'))
    const scaleX = previous * advance / actual
    if (advance > 0 && actual > 0 && Number.isFinite(scaleX) && scaleX > 0) element.style.setProperty('--scale-x', String(scaleX))
  }
}
