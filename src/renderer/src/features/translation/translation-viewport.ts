export interface TranslationPageBounds {
  pageNumber: number
  top: number
  bottom: number
}

/** 基于右侧自身坐标选取可视/预加载页，不能借用左侧的当前页。 */
export function visibleTranslationPages(
  pages: readonly TranslationPageBounds[],
  viewportTop: number,
  viewportBottom: number,
  margin = 800
): number[] {
  return pages
    .filter(page => page.bottom >= viewportTop - margin && page.top <= viewportBottom + margin)
    .map(page => page.pageNumber)
}

export function currentTranslationPage(
  pages: readonly TranslationPageBounds[],
  viewportTop: number,
  viewportHeight: number
): number | null {
  const line = viewportTop + Math.min(160, Math.max(0, viewportHeight) * 0.25)
  const containing = pages.find(page => page.top <= line && page.bottom > line)
  if (containing) return containing.pageNumber
  // 页间空白取靠近阅读基准线的一页；在首尾留白内也保持有效页码。
  let closest: TranslationPageBounds | undefined
  let distance = Number.POSITIVE_INFINITY
  for (const page of pages) {
    const next = Math.min(Math.abs(page.top - line), Math.abs(page.bottom - line))
    if (next < distance) { closest = page; distance = next }
  }
  return closest?.pageNumber ?? null
}

export function sameTranslationPages(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((page, index) => page === b[index])
}

export function normalizeTranslationPages(pages: readonly number[], pageCount: number): number[] {
  return [...new Set(pages.filter(page => Number.isInteger(page) && page >= 1 && page <= pageCount))].sort((a, b) => a - b)
}

/** 窗口快捷键与可见栏共用导航入口，默认仍允许独立原文阅读器导航。 */
export function navigateVisibleReaderPage(
  pageNumber: number,
  pageCount: number,
  navigateSource: (page: number) => void,
  navigateVisible?: (page: number) => void
): void {
  if (!Number.isFinite(pageNumber) || pageCount < 1) return
  const target = Math.max(1, Math.min(pageCount, Math.trunc(pageNumber)))
  ;(navigateVisible ?? navigateSource)(target)
}
