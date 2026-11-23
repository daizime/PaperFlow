export interface PdfOutlineRef {
  num: number
  gen: number
}

export interface RawOutlineNode {
  title?: string | null
  dest?: string | unknown[] | null
  url?: string | null
  items?: RawOutlineNode[]
}

export interface OutlineDocumentLike {
  numPages: number
  getOutline(): Promise<RawOutlineNode[] | null>
  getDestination(id: string): Promise<unknown[] | null>
  getPageIndex(ref: PdfOutlineRef): Promise<number>
}

export interface PdfOutlineItem {
  id: string
  title: string
  pageNumber: number | null
  items: PdfOutlineItem[]
}

function isOutlineRef(value: unknown): value is PdfOutlineRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    'num' in value &&
    'gen' in value &&
    typeof value.num === 'number' &&
    typeof value.gen === 'number'
  )
}

/** 仅解析文档内部 destination；严禁读取、打开或跳转外部 item.url。 */
export async function extractPdfOutline(
  pdf: OutlineDocumentLike,
  signal?: AbortSignal
): Promise<PdfOutlineItem[]> {
  const rawOutline = await pdf.getOutline()
  if (signal?.aborted || !rawOutline || rawOutline.length === 0) return []

  const destinationCache = new Map<string, unknown[] | null>()
  const pageIndexCache = new Map<string, number | null>()

  async function resolvePageNumber(dest: string | unknown[] | null | undefined): Promise<number | null> {
    if (signal?.aborted || !dest) return null
    let destArray: unknown[] | null = null
    if (typeof dest === 'string') {
      if (destinationCache.has(dest)) {
        destArray = destinationCache.get(dest) ?? null
      } else {
        try {
          destArray = await pdf.getDestination(dest)
        } catch {
          destArray = null
        }
        destinationCache.set(dest, destArray)
      }
    } else if (Array.isArray(dest)) {
      destArray = dest
    }

    if (signal?.aborted || !destArray || destArray.length === 0) return null
    const target = destArray[0]
    if (typeof target === 'number') {
      if (Number.isInteger(target) && target >= 0 && target < pdf.numPages) return target + 1
      return null
    }
    if (!isOutlineRef(target)) return null

    const cacheKey = `${target.num}:${target.gen}`
    let index: number | null
    if (pageIndexCache.has(cacheKey)) {
      index = pageIndexCache.get(cacheKey) ?? null
    } else {
      try {
        const resolved = await pdf.getPageIndex(target)
        index = Number.isInteger(resolved) && resolved >= 0 && resolved < pdf.numPages ? resolved : null
      } catch {
        index = null
      }
      pageIndexCache.set(cacheKey, index)
    }
    return index === null ? null : index + 1
  }

  async function visitNodes(nodes: readonly RawOutlineNode[], prefix: string): Promise<PdfOutlineItem[]> {
    const result: PdfOutlineItem[] = []
    for (let index = 0; index < nodes.length; index++) {
      if (signal?.aborted) return result
      const node = nodes[index]
      const id = prefix ? `${prefix}-${index}` : String(index)
      const children = Array.isArray(node.items) && node.items.length > 0 ? await visitNodes(node.items, id) : []
      if (signal?.aborted) return result
      const pageNumber = await resolvePageNumber(node.dest)
      if (signal?.aborted) return result
      // 纯外部 URL 书签忽略不展示，避免暴露未处理的外部链接节点。
      if (pageNumber === null && node.url && children.length === 0) continue
      const title = (node.title ?? '').trim() || '未命名书签'
      result.push({ id, title, pageNumber, items: children })
    }
    return result
  }

  return visitNodes(rawOutline, 'outline')
}
