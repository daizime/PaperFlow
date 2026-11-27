import type { DocumentRecord, LiteratureSearchItem } from '../../../../shared/contracts'

function normalizeMatchTitle(raw: string): string {
  return raw
    .replace(/\.pdf$/i, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim()
}

function extractArxivIdToken(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = /(?:arxiv(?:\.org\/(?:abs|pdf)\/|:|\s*)|10\.48550\/arxiv\.)([0-9]{4}\.[0-9]{4,5})/i.exec(raw)
  return m ? m[1].toLowerCase() : null
}

/**
 * 匹配远端检索结果是否已导入本地文献库（标题归一化匹配或 arXiv ID / DOI 匹配）。
 */
export function findMatchingLocalDocument(
  item: LiteratureSearchItem,
  localDocuments: readonly DocumentRecord[]
): DocumentRecord | null {
  if (localDocuments.length === 0) return null
  const targetTitle = normalizeMatchTitle(item.title)
  const itemArxiv =
    extractArxivIdToken(item.id) || extractArxivIdToken(item.pdfUrl) || extractArxivIdToken(item.landingUrl)
  const itemDoi = item.doi?.trim().toLowerCase() || null

  for (const doc of localDocuments) {
    const candidateNames = [doc.displayTitle, doc.originalFilename].filter(Boolean)
    for (const rawName of candidateNames) {
      const normalized = normalizeMatchTitle(rawName)
      if (targetTitle.length >= 6 && normalized === targetTitle) {
        return doc
      }
      if (itemArxiv && rawName.toLowerCase().includes(itemArxiv)) {
        return doc
      }
      if (itemDoi && rawName.toLowerCase().includes(itemDoi)) {
        return doc
      }
    }
  }
  return null
}
