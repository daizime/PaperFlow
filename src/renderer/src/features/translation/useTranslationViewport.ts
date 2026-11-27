import { useLayoutEffect, useRef, useState } from 'react'
import { currentTranslationPage, sameTranslationPages, visibleTranslationPages } from './translation-viewport'

interface Options {
  root: HTMLDivElement | null
  documentId: string | null | undefined
  pageCount: number
  initialPage: number
  onVisiblePagesChange?(pages: readonly number[]): void
  onCurrentPageChange?(page: number): void
}

/** 右侧独立观察滚动与布局，不通过移动左侧来触发懒加载。 */
export function useTranslationViewport({ root, documentId, pageCount, initialPage, onVisiblePagesChange, onCurrentPageChange }: Options): ReadonlySet<number> {
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(() => new Set())
  const callbacks = useRef({ onVisiblePagesChange, onCurrentPageChange })
  const initialPageRef = useRef(initialPage)
  const restored = useRef<{ root: HTMLDivElement; documentId: string | null | undefined } | null>(null)
  const tracksCurrentPage = Boolean(onCurrentPageChange)
  useLayoutEffect(() => {
    callbacks.current = { onVisiblePagesChange, onCurrentPageChange }
    initialPageRef.current = initialPage
  }, [onVisiblePagesChange, onCurrentPageChange, initialPage])

  useLayoutEffect(() => {
    if (!root || pageCount < 1) {
      setVisiblePages(new Set())
      callbacks.current.onVisiblePagesChange?.([])
      return
    }
    const pageElements = Array.from(root.querySelectorAll<HTMLElement>('.translation-page[data-page-number]'))
    if (restored.current?.root !== root || restored.current.documentId !== documentId) {
      restored.current = { root, documentId }
      const target = Math.max(1, Math.min(pageCount, initialPageRef.current))
      const page = pageElements[target - 1]
      if (target === 1) root.scrollTop = 0
      else if (page) root.scrollTop += page.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop
    }
    let frame: number | null = null
    let lastPages: readonly number[] = []
    let lastCurrent: number | null = null
    const measure = (): void => {
      frame = null
      const rootBox = root.getBoundingClientRect()
      const top = rootBox.top + root.clientTop
      const pages = pageElements.map(element => {
        const box = element.getBoundingClientRect()
        return { pageNumber: Number(element.dataset.pageNumber), top: box.top, bottom: box.bottom }
      })
      const visible = visibleTranslationPages(pages, top, top + root.clientHeight)
      if (!sameTranslationPages(lastPages, visible)) {
        lastPages = visible
        setVisiblePages(new Set(visible))
        callbacks.current.onVisiblePagesChange?.(visible)
      }
      const current = currentTranslationPage(pages, top, root.clientHeight)
      if (current !== null && current !== lastCurrent) {
        lastCurrent = current
        callbacks.current.onCurrentPageChange?.(current)
      }
    }
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(measure)
    }
    root.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(root)
    const pagesContainer = root.querySelector('.translation-pages')
    if (pagesContainer) observer.observe(pagesContainer)
    measure()
    return () => {
      root.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      callbacks.current.onVisiblePagesChange?.([])
    }
  }, [root, documentId, pageCount, tracksCurrentPage])
  return visiblePages
}
