import { describe, expect, it } from 'vitest'
import { currentTranslationPage, navigateVisibleReaderPage, normalizeTranslationPages, sameTranslationPages, visibleTranslationPages } from '../../src/renderer/src/features/translation/translation-viewport'

describe('独立译文可视范围（原创合成几何数据）', () => {
  const pages = Array.from({ length: 12 }, (_, index) => ({ pageNumber: index + 1, top: index * 820, bottom: index * 820 + 792 }))
  it('右侧到第8页时加载自身邻近页，不依赖左侧第1页', () => {
    expect(visibleTranslationPages(pages, 5740, 6440)).toEqual([7, 8, 9])
    expect(currentTranslationPage(pages, 5740, 700)).toBe(8)
  })
  it('页间空白、首尾留白和空文献均返回合理边界', () => {
    expect(currentTranslationPage(pages, -200, 100)).toBe(1)
    expect(currentTranslationPage(pages, 20000, 100)).toBe(12)
    expect(currentTranslationPage([], 0, 700)).toBeNull()
    expect(visibleTranslationPages(pages, 5740, 6440, 0)).toEqual([8])
  })
  it('按文献页数筛除过期/无效页并稳定去重', () => {
    expect(normalizeTranslationPages([9, 2, 2, 0, 3.5, NaN, 3], 3)).toEqual([2, 3])
    expect(sameTranslationPages([2, 3], [2, 3])).toBe(true)
    expect(sameTranslationPages([2, 3], [3, 2])).toBe(false)
  })
  it('仅译文快捷键走可见栏导航，原文模式保留源栏路径', () => {
    const source: number[] = []
    const visible: number[] = []
    navigateVisibleReaderPage(9, 8, page => source.push(page), page => visible.push(page))
    expect(visible).toEqual([8])
    expect(source).toEqual([])
    navigateVisibleReaderPage(0, 8, page => source.push(page))
    expect(source).toEqual([1])
    navigateVisibleReaderPage(NaN, 8, page => source.push(page))
    expect(source).toEqual([1])
  })
})
