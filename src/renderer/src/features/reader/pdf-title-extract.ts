import {
  extractCleanPaperTitle,
  type FirstPageCitationSource,
  type FirstPageTextItem
} from '../../../../shared/citation'
import { loadPdf } from './pdf-engine'

/**
 * 离网解析 PDF 第一页文本及元数据，提炼清晰的论文标题（未命中可靠标题时返回 null）。
 */
export async function extractTitleFromPdfBytes(
  bytes: Uint8Array,
  fallbackTitle: string
): Promise<string | null> {
  // 拷贝一份缓冲避免 PDF.js Worker 转移并分离调用方持有的 Uint8Array
  const handle = loadPdf(new Uint8Array(bytes))
  try {
    const pdf = await handle.promise
    const metadata = await pdf.getMetadata().catch(() => null)
    const infoObj = (metadata?.info as Record<string, unknown> | undefined) ?? undefined
    const page1 = await pdf.getPage(1)
    const items: FirstPageTextItem[] = []
    let page1Text = ''

    try {
      const textContent = (await page1.getTextContent()) as { items?: readonly unknown[] }
      for (const raw of textContent.items ?? []) {
        if (!raw || typeof raw !== 'object' || !('str' in raw)) continue
        const it = raw as { str?: unknown; width?: unknown; hasEOL?: unknown; transform?: unknown }
        if (typeof it.str !== 'string' || !it.str) continue
        page1Text += it.str + (it.hasEOL ? '\n' : ' ')
        const t = Array.isArray(it.transform) ? it.transform : null
        const fontSize =
          t && typeof t[0] === 'number' && typeof t[1] === 'number' ? Math.hypot(t[0], t[1]) : 10
        const x = t && typeof t[4] === 'number' ? t[4] : 0
        const y = t && typeof t[5] === 'number' ? t[5] : 0
        items.push({
          str: it.str,
          fontSize,
          x,
          y,
          width: typeof it.width === 'number' ? it.width : undefined,
          hasEOL: Boolean(it.hasEOL)
        })
      }
    } finally {
      if (!page1.destroyed) page1.cleanup()
    }

    const source: FirstPageCitationSource = {
      page1Text,
      items,
      pdfInfo: infoObj
        ? {
            title: typeof infoObj.Title === 'string' ? infoObj.Title : undefined,
            author: typeof infoObj.Author === 'string' ? infoObj.Author : undefined,
            subject: typeof infoObj.Subject === 'string' ? infoObj.Subject : undefined,
            creationDate: typeof infoObj.CreationDate === 'string' ? infoObj.CreationDate : undefined
          }
        : undefined
    }
    return extractCleanPaperTitle(source, fallbackTitle)
  } catch {
    return null
  } finally {
    await handle.destroy().catch(() => undefined)
  }
}
