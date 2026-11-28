import {
  MAX_PDF_BYTES,
  type EnrichCitationInput,
  type EnrichCitationResult,
  type ImportLiteraturePdfInput,
  type ImportResult,
  type LiteratureSearchItem,
  type SearchLiteratureInput,
  type SearchLiteratureResult,
  type SummarizeLiteratureAbstractInput,
  type SummarizeLiteratureAbstractResult
} from '../../shared/contracts'
import {
  enrichCitationInputSchema,
  importLiteraturePdfInputSchema,
  searchLiteratureInputSchema,
  summarizeLiteratureAbstractInputSchema
} from '../../shared/schemas'
import type { LibraryDatabase } from './database'
import type { DocumentService } from './document-service'
import { requestLiteratureResponse, validateExternalHttpsUrl } from './literature-http'
import type { TranslationService } from './translation-service'

const DEFAULT_OPENALEX_BASE = 'https://api.openalex.org'
const DEFAULT_ARXIV_BASE = 'https://export.arxiv.org'
const LITERATURE_USER_AGENT = 'Foliopair (Academic Reader)'
const SEARCH_TIMEOUT_MS = 12_000
const DOWNLOAD_TIMEOUT_MS = 30_000
const MAX_REDIRECT_HOPS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export function reconstructOpenAlexAbstract(
  invertedIndex: Record<string, number[]> | null | undefined
): string {
  if (!invertedIndex || typeof invertedIndex !== 'object') return ''
  let maxPos = -1
  for (const positions of Object.values(invertedIndex)) {
    if (!Array.isArray(positions)) continue
    for (const pos of positions) {
      if (typeof pos === 'number' && Number.isInteger(pos) && pos >= 0 && pos < 5000 && pos > maxPos) {
        maxPos = pos
      }
    }
  }
  if (maxPos < 0) return ''
  const words = new Array<string>(maxPos + 1).fill('')
  for (const [token, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue
    for (const pos of positions) {
      if (typeof pos === 'number' && Number.isInteger(pos) && pos >= 0 && pos <= maxPos) {
        words[pos] = token
      }
    }
  }
  return words.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
}

function extractFirstTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const match = re.exec(xml)
  return match ? decodeXmlEntities(match[1]).replace(/\s+/g, ' ').trim() : ''
}

export function parseArxivAtomFeed(xml: string): LiteratureSearchItem[] {
  if (!xml || !xml.includes('<entry')) return []
  const items: LiteratureSearchItem[] = []
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
  let entryMatch: RegExpExecArray | null
  while ((entryMatch = entryRe.exec(xml)) !== null) {
    const body = entryMatch[1]
    const rawId = extractFirstTag(body, 'id')
    const title = extractFirstTag(body, 'title')
    if (!title) continue
    const summary = extractFirstTag(body, 'summary')
    const published = extractFirstTag(body, 'published')
    const yearMatch = /^(\d{4})/.exec(published)
    const year = yearMatch ? Number.parseInt(yearMatch[1], 10) : null

    const authors: string[] = []
    const authorRe = /<author\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi
    let aMatch: RegExpExecArray | null
    while ((aMatch = authorRe.exec(body)) !== null) {
      const name = decodeXmlEntities(aMatch[1]).replace(/\s+/g, ' ').trim()
      if (name) authors.push(name)
      if (authors.length >= 6) break
    }

    let pdfUrl: string | null = null
    let landingUrl: string | null = rawId || null
    const linkRe = /<link\b([^>]*?)\/?>/gi
    let lMatch: RegExpExecArray | null
    while ((lMatch = linkRe.exec(body)) !== null) {
      const attrs = lMatch[1]
      const hrefMatch = /\bhref=["']([^"']+)["']/i.exec(attrs)
      const href = hrefMatch ? decodeXmlEntities(hrefMatch[1]).trim() : ''
      if (!href) continue
      if (/\btitle=["']pdf["']/i.test(attrs) || /\btype=["']application\/pdf["']/i.test(attrs)) {
        pdfUrl = href
      } else if (/\brel=["']alternate["']/i.test(attrs) && !landingUrl) {
        landingUrl = href
      }
    }
    if (!pdfUrl && rawId && rawId.includes('/abs/')) {
      pdfUrl = rawId.replace('/abs/', '/pdf/') + '.pdf'
    }
    if (pdfUrl && pdfUrl.startsWith('http://arxiv.org/')) {
      pdfUrl = `https://${pdfUrl.slice('http://'.length)}`
    }
    if (landingUrl && landingUrl.startsWith('http://arxiv.org/')) {
      landingUrl = `https://${landingUrl.slice('http://'.length)}`
    }

    const doiRaw = extractFirstTag(body, 'arxiv:doi') || extractFirstTag(body, 'doi')
    const doi = doiRaw ? doiRaw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') : null
    const journalRef = extractFirstTag(body, 'arxiv:journal_ref')

    const topics: string[] = []
    const catRe = /<category\b[^>]*\bterm=["']([^"']+)["']/gi
    let cMatch: RegExpExecArray | null
    while ((cMatch = catRe.exec(body)) !== null) {
      const term = cMatch[1].trim()
      if (term && !topics.includes(term)) topics.push(term)
      if (topics.length >= 4) break
    }

    items.push({
      id: rawId || `arxiv:${title.slice(0, 48)}`,
      source: 'arxiv',
      title,
      authors,
      year,
      venue: journalRef || 'arXiv',
      abstract: summary,
      citationCount: null,
      doi,
      landingUrl,
      pdfUrl,
      isOpenAccess: Boolean(pdfUrl),
      topics
    })
  }
  return items
}

interface OpenAlexWork {
  id?: string
  doi?: string | null
  title?: string | null
  display_name?: string | null
  publication_year?: number | null
  cited_by_count?: number | null
  abstract_inverted_index?: Record<string, number[]> | null
  open_access?: { is_oa?: boolean; oa_url?: string | null } | null
  best_oa_location?: {
    pdf_url?: string | null
    landing_page_url?: string | null
    source?: { display_name?: string | null } | null
  } | null
  primary_location?: {
    landing_page_url?: string | null
    pdf_url?: string | null
    source?: { display_name?: string | null } | null
  } | null
  authorships?: Array<{ author?: { display_name?: string | null } | null }> | null
  topics?: Array<{ display_name?: string | null }> | null
  concepts?: Array<{ display_name?: string | null }> | null
}

function parseOpenAlexWorks(works: readonly OpenAlexWork[]): LiteratureSearchItem[] {
  const items: LiteratureSearchItem[] = []
  for (const w of works) {
    const title = (w.title || w.display_name || '').replace(/\s+/g, ' ').trim()
    if (!title) continue
    const authors = (w.authorships ?? [])
      .map(a => a.author?.display_name?.trim() ?? '')
      .filter(Boolean)
      .slice(0, 6)
    const doi = w.doi ? w.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') : null
    const pdfUrl = w.best_oa_location?.pdf_url || w.primary_location?.pdf_url || null
    const landingUrl =
      w.primary_location?.landing_page_url ||
      w.best_oa_location?.landing_page_url ||
      w.open_access?.oa_url ||
      (doi ? `https://doi.org/${doi}` : w.id ?? null)
    const venue =
      w.primary_location?.source?.display_name?.trim() ||
      w.best_oa_location?.source?.display_name?.trim() ||
      ''
    const topics = (w.topics && w.topics.length > 0 ? w.topics : w.concepts ?? [])
      .map(t => t.display_name?.trim() ?? '')
      .filter(Boolean)
      .slice(0, 4)

    items.push({
      id: w.id || doi || `oa:${title.slice(0, 48)}`,
      source: 'openalex',
      title,
      authors,
      year: typeof w.publication_year === 'number' ? w.publication_year : null,
      venue,
      abstract: reconstructOpenAlexAbstract(w.abstract_inverted_index),
      citationCount: typeof w.cited_by_count === 'number' ? w.cited_by_count : null,
      doi,
      landingUrl,
      pdfUrl,
      isOpenAccess: Boolean(w.open_access?.is_oa || pdfUrl),
      topics
    })
  }
  return items
}

function normalizeTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

function safePdfFilenameFromTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${cleaned || 'Foliopair-article'}.pdf`
}

function parseExpandedKeywords(rawOutput: string): string[] {
  const trimmed = rawOutput.trim()
  const jsonMatch =
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ??
    (() => {
      const s = trimmed.indexOf('[')
      const e = trimmed.lastIndexOf(']')
      return s !== -1 && e > s ? trimmed.slice(s, e + 1) : ''
    })()

  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch) as unknown
      if (Array.isArray(arr)) {
        return arr
          .filter((item): item is string => typeof item === 'string')
          .map(s => s.replace(/\s+/g, ' ').trim())
          .filter(s => s.length >= 2 && s.length <= 80)
          .slice(0, 5)
      }
    } catch {
      // 回退为按分隔符解析
    }
  }
  return trimmed
    .split(/[\n,;，；]+/)
    .map(s => s.replace(/^[-*•\d.)\s"']+|["'\s]+$/g, '').trim())
    .filter(s => s.length >= 2 && s.length <= 60)
    .slice(0, 5)
}

export interface DirectPaperIdentifier {
  kind: 'doi' | 'arxiv'
  value: string
}

/**
 * 识别用户在检索框直接粘贴的 DOI 链接/编号或 arXiv 链接/编号。
 */
export function detectDirectPaperIdentifier(raw: string): DirectPaperIdentifier | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const arxivUrlMatch = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)(?:\.pdf)?(?:[?#].*)?$/i.exec(
    trimmed
  )
  if (arxivUrlMatch) {
    return { kind: 'arxiv', value: arxivUrlMatch[1] }
  }

  const arxivPrefixMatch = /^arxiv:\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)$/i.exec(trimmed)
  if (arxivPrefixMatch) {
    return { kind: 'arxiv', value: arxivPrefixMatch[1] }
  }

  if (/^[0-9]{4}\.[0-9]{4,5}(?:v\d+)?$/i.test(trimmed)) {
    return { kind: 'arxiv', value: trimmed }
  }

  const doiUrlMatch = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/\S+?)\/?$/i.exec(trimmed)
  if (doiUrlMatch) {
    return { kind: 'doi', value: doiUrlMatch[1].replace(/[.,;)]+$/, '') }
  }

  const bareDoiMatch = /^(10\.\d{4,9}\/\S+)$/i.exec(trimmed)
  if (bareDoiMatch) {
    return { kind: 'doi', value: bareDoiMatch[1].replace(/[.,;)]+$/, '') }
  }

  return null
}

export interface LiteratureSearchServiceOptions {
  database: LibraryDatabase
  documents: DocumentService
  translations?: TranslationService
  fetchImpl?: typeof fetch
  openAlexBaseUrl?: string
  arxivBaseUrl?: string
  allowInsecureTestBase?: string
}

export class LiteratureSearchService {
  private readonly database: LibraryDatabase
  private readonly documents: DocumentService
  private readonly translations?: TranslationService
  private readonly fetchImpl?: typeof fetch
  private readonly openAlexBaseUrl: string
  private readonly arxivBaseUrl: string
  private readonly allowInsecureTestBase?: string

  constructor(options: LiteratureSearchServiceOptions) {
    this.database = options.database
    this.documents = options.documents
    this.translations = options.translations
    this.fetchImpl = options.fetchImpl
    this.openAlexBaseUrl = (options.openAlexBaseUrl ?? DEFAULT_OPENALEX_BASE).replace(/\/+$/, '')
    this.arxivBaseUrl = (options.arxivBaseUrl ?? DEFAULT_ARXIV_BASE).replace(/\/+$/, '')
    this.allowInsecureTestBase = options.allowInsecureTestBase
  }

  private async getLiteratureResponse(rawUrl: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs)
    let currentUrl = validateExternalHttpsUrl(rawUrl, this.allowInsecureTestBase)

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const response = this.fetchImpl
        ? await this.fetchImpl(currentUrl.toString(), { headers, redirect: 'manual', signal })
        : await requestLiteratureResponse(currentUrl, headers, signal, this.allowInsecureTestBase)
      if (!REDIRECT_STATUSES.has(response.status)) return response

      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location) throw new Error('学术请求收到缺少目标地址的重定向。')
      if (hop === MAX_REDIRECT_HOPS) break
      currentUrl = validateExternalHttpsUrl(new URL(location, currentUrl).toString(), this.allowInsecureTestBase)
    }
    throw new Error('学术请求重定向次数过多。')
  }

  private async expandQueryWithAi(query: string, tags: readonly string[]): Promise<string[]> {
    if (!this.translations?.hasConfiguredAiEngine()) return []
    const tagPart = tags.length > 0 ? `Tags: ${tags.join(', ')}. ` : ''
    const queryPart = query ? `User query: "${query}". ` : ''
    const prompt = `${queryPart}${tagPart}Convert the research topic/tags into 2 to 4 concise English scholarly search phrases suitable for OpenAlex / arXiv. Return STRICT JSON array of strings only, e.g. ["phrase one", "phrase two"].`
    try {
      const raw = await this.translations.completeAcademicTask({
        systemPrompt: 'You are an academic search strategist. Return strict JSON array of English search keywords only.',
        userPrompt: prompt,
        timeoutMs: 12_000
      })
      return parseExpandedKeywords(raw)
    } catch {
      return []
    }
  }

  async search(input: SearchLiteratureInput): Promise<SearchLiteratureResult> {
    const validated = searchLiteratureInputSchema.parse(input)
    const rawQuery = validated.query.trim()
    const tags = (validated.tags ?? []).map(t => t.trim()).filter(Boolean)
    const directId = rawQuery ? detectDirectPaperIdentifier(rawQuery) : null
    const baseTokens = [rawQuery, ...tags].filter(Boolean)
    const baseQuery = baseTokens.join(' ').replace(/\s+/g, ' ').trim()

    let aiKeywords: string[] = []
    let usedAiExpansion = false
    if (!directId && validated.useAiAssist !== false) {
      aiKeywords = await this.expandQueryWithAi(rawQuery, tags)
      usedAiExpansion = aiKeywords.length > 0
    }

    const effectiveQuery = directId
      ? directId.value
      : usedAiExpansion
        ? aiKeywords.join(' ').slice(0, 200)
        : baseQuery

    const limit = validated.limit ?? 15
    const perSourceLimit = Math.min(25, Math.max(limit, 12))
    const headers = { 'User-Agent': LITERATURE_USER_AGENT }

    let oaRequestUrl: string
    let oaSingleWork = false
    let arxivRequestUrl: string

    if (directId?.kind === 'doi') {
      oaRequestUrl = `${this.openAlexBaseUrl}/works/https://doi.org/${encodeURIComponent(directId.value)}`
      oaSingleWork = true
      const arxivUrl = new URL(`${this.arxivBaseUrl}/api/query`)
      arxivUrl.searchParams.set('search_query', `all:${directId.value}`)
      arxivUrl.searchParams.set('max_results', '5')
      arxivRequestUrl = arxivUrl.toString()
    } else if (directId?.kind === 'arxiv') {
      const bareId = directId.value.replace(/v\d+$/i, '')
      oaRequestUrl = `${this.openAlexBaseUrl}/works/https://doi.org/${encodeURIComponent(`10.48550/arXiv.${bareId}`)}`
      oaSingleWork = true
      const arxivUrl = new URL(`${this.arxivBaseUrl}/api/query`)
      arxivUrl.searchParams.set('id_list', directId.value)
      arxivRequestUrl = arxivUrl.toString()
    } else {
      const oaUrl = new URL(`${this.openAlexBaseUrl}/works`)
      oaUrl.searchParams.set('search', effectiveQuery)
      oaUrl.searchParams.set('per-page', String(perSourceLimit))
      const filters: string[] = []
      if (validated.openAccessOnly) filters.push('is_oa:true')
      if (validated.yearFrom) filters.push(`from_publication_date:${validated.yearFrom}-01-01`)
      if (filters.length > 0) oaUrl.searchParams.set('filter', filters.join(','))
      if (validated.sort === 'citations') oaUrl.searchParams.set('sort', 'cited_by_count:desc')
      else if (validated.sort === 'recent') oaUrl.searchParams.set('sort', 'publication_year:desc')
      oaRequestUrl = oaUrl.toString()

      const arxivUrl = new URL(`${this.arxivBaseUrl}/api/query`)
      arxivUrl.searchParams.set('search_query', `all:${effectiveQuery}`)
      arxivUrl.searchParams.set('start', '0')
      arxivUrl.searchParams.set('max_results', String(Math.min(15, perSourceLimit)))
      if (validated.sort === 'recent') {
        arxivUrl.searchParams.set('sortBy', 'submittedDate')
        arxivUrl.searchParams.set('sortOrder', 'descending')
      } else {
        arxivUrl.searchParams.set('sortBy', 'relevance')
        arxivUrl.searchParams.set('sortOrder', 'descending')
      }
      arxivRequestUrl = arxivUrl.toString()
    }

    const [oaSettled, arxivSettled] = await Promise.allSettled([
      this.getLiteratureResponse(oaRequestUrl, headers, SEARCH_TIMEOUT_MS).then(async res => {
        if (!res.ok) {
          await res.body?.cancel().catch(() => {})
          if (oaSingleWork && res.status === 404) return []
          throw new Error(`OpenAlex HTTP ${res.status}`)
        }
        const data = (await res.json()) as { results?: OpenAlexWork[] } & OpenAlexWork
        if (oaSingleWork) {
          return Array.isArray(data.results) ? parseOpenAlexWorks(data.results) : parseOpenAlexWorks([data])
        }
        return parseOpenAlexWorks(Array.isArray(data.results) ? data.results : [])
      }),
      this.getLiteratureResponse(arxivRequestUrl, headers, SEARCH_TIMEOUT_MS).then(async res => {
        if (!res.ok) {
          await res.body?.cancel().catch(() => {})
          throw new Error(`arXiv HTTP ${res.status}`)
        }
        const xml = await res.text()
        return parseArxivAtomFeed(xml)
      })
    ])

    const warnings: string[] = []
    const sourcesQueried: Array<'openalex' | 'arxiv'> = []
    const merged: LiteratureSearchItem[] = []

    if (oaSettled.status === 'fulfilled') {
      sourcesQueried.push('openalex')
      merged.push(...oaSettled.value)
    } else {
      warnings.push(`OpenAlex 查询失败：${oaSettled.reason instanceof Error ? oaSettled.reason.message : String(oaSettled.reason)}`)
    }
    if (arxivSettled.status === 'fulfilled') {
      sourcesQueried.push('arxiv')
      merged.push(...arxivSettled.value)
    } else {
      warnings.push(`arXiv 查询失败：${arxivSettled.reason instanceof Error ? arxivSettled.reason.message : String(arxivSettled.reason)}`)
    }

    // 按 DOI 或规范化标题去重，优先补齐 PDF 下载直链与摘要
    const deduped: LiteratureSearchItem[] = []
    const seenByKey = new Map<string, number>()
    for (const item of merged) {
      const doiKey = item.doi ? `doi:${item.doi.toLowerCase()}` : null
      const titleKey = `title:${normalizeTitleKey(item.title)}`
      const existingIdx = (doiKey ? seenByKey.get(doiKey) : undefined) ?? seenByKey.get(titleKey)
      if (existingIdx !== undefined) {
        const prev = deduped[existingIdx]
        deduped[existingIdx] = {
          ...prev,
          pdfUrl: prev.pdfUrl || item.pdfUrl,
          landingUrl: prev.landingUrl || item.landingUrl,
          abstract: prev.abstract.length >= item.abstract.length ? prev.abstract : item.abstract,
          citationCount: prev.citationCount ?? item.citationCount,
          isOpenAccess: prev.isOpenAccess || item.isOpenAccess
        }
        continue
      }
      const nextIdx = deduped.length
      deduped.push(item)
      if (doiKey) seenByKey.set(doiKey, nextIdx)
      if (titleKey !== 'title:') seenByKey.set(titleKey, nextIdx)
    }

    const filtered = deduped.filter(item => {
      if (validated.openAccessOnly && !item.pdfUrl && !item.isOpenAccess) return false
      if (validated.yearFrom && item.year !== null && item.year < validated.yearFrom) return false
      return true
    })

    if (validated.sort === 'citations') {
      filtered.sort((a, b) => (b.citationCount ?? -1) - (a.citationCount ?? -1))
    } else if (validated.sort === 'recent') {
      filtered.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    }

    return {
      query: baseQuery,
      effectiveQuery,
      usedAiExpansion,
      aiKeywords,
      items: filtered.slice(0, limit),
      sourcesQueried,
      warnings
    }
  }

  async importPaperPdf(input: ImportLiteraturePdfInput): Promise<ImportResult> {
    const validated = importLiteraturePdfInputSchema.parse(input)
    const response = await this.getLiteratureResponse(validated.pdfUrl, {
      'User-Agent': LITERATURE_USER_AGENT,
      Accept: 'application/pdf,*/*;q=0.8'
    }, DOWNLOAD_TIMEOUT_MS)
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`下载开放获取 PDF 失败（HTTP ${response.status}），建议改为“浏览器打开”后手动保存导入。`)
    }

    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
      await response.body?.cancel().catch(() => {})
      throw new Error('远端 PDF 超过 100 MiB 大小限制。')
    }

    const reader = response.body?.getReader()
    let bytes: Buffer
    if (reader) {
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > MAX_PDF_BYTES) {
            await reader.cancel().catch(() => {})
            throw new Error('远端 PDF 超过 100 MiB 大小限制。')
          }
          chunks.push(value)
        }
      }
      bytes = Buffer.concat(chunks, total)
    } else {
      const arr = new Uint8Array(await response.arrayBuffer())
      if (arr.byteLength > MAX_PDF_BYTES) {
        throw new Error('远端 PDF 超过 100 MiB 大小限制。')
      }
      bytes = Buffer.from(arr)
    }

    if (bytes.length < 8 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('该链接返回的是网页而非直接 PDF 文件（可能受出版商页面跳转限制），请点击“浏览器打开”手动下载。')
    }

    const imported = await this.documents.importBuffer(safePdfFilenameFromTitle(validated.title), bytes)
    let finalDoc = imported.document
    if (imported.status === 'imported' && validated.title.trim()) {
      finalDoc = this.database.renameDocument(finalDoc.id, validated.title.trim().slice(0, 200))
    }

    const incomingTags = (validated.tags ?? []).map(t => t.trim()).filter(Boolean)
    const mergedTags = Array.from(new Set([...(finalDoc.tags ?? []), ...incomingTags])).slice(0, 16)
    const needsMetaUpdate =
      mergedTags.length !== (finalDoc.tags ?? []).length ||
      (validated.folderId !== undefined && validated.folderId !== finalDoc.folderId)
    if (needsMetaUpdate) {
      finalDoc = this.database.updateDocumentMeta({
        documentId: finalDoc.id,
        tags: mergedTags,
        ...(validated.folderId !== undefined ? { folderId: validated.folderId } : {})
      })
    }

    return { status: imported.status, document: finalDoc }
  }

  async summarizeAbstract(input: SummarizeLiteratureAbstractInput): Promise<SummarizeLiteratureAbstractResult> {
    const validated = summarizeLiteratureAbstractInputSchema.parse(input)
    if (!this.translations?.hasConfiguredAiEngine()) {
      throw new Error('请先在顶栏「设置」中配置 API 或本机 AI CLI 后再使用中文速览。')
    }
    const raw = await this.translations.completeAcademicTask({
      systemPrompt:
        'You are a scholarly paper triage assistant. Summarize the paper abstract in 1-2 concise Simplified Chinese sentences covering: (1) core problem, (2) method/technique, (3) key result if stated. Output plain text only.',
      userPrompt: `Title: ${validated.title}\n\nAbstract:\n${validated.abstract}`,
      timeoutMs: 25_000
    })
    return {
      summary: raw.replace(/\s+/g, ' ').trim()
    }
  }

  /**
   * 经由主进程受控查询 OpenAlex 元数据（优先 DOI 精确匹配，其次标题高置信匹配），用于补全作者、年份、期刊与 DOI。
   */
  async enrichCitation(input: EnrichCitationInput): Promise<EnrichCitationResult> {
    const validated = enrichCitationInputSchema.parse(input)
    const rawDoi = validated.doi?.trim() ?? ''
    const rawTitle = validated.title?.trim() ?? ''
    const headers = { 'User-Agent': LITERATURE_USER_AGENT }

    let cleanDoi = ''
    if (rawDoi) {
      const detected = detectDirectPaperIdentifier(rawDoi)
      if (detected?.kind === 'doi') {
        cleanDoi = detected.value
      } else {
        cleanDoi = rawDoi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/[.,;)]+$/, '').trim()
      }
    }

    if (cleanDoi) {
      try {
        const encodedDoiPath = cleanDoi.split('/').map(encodeURIComponent).join('/')
        const doiUrl = `${this.openAlexBaseUrl}/works/https://doi.org/${encodedDoiPath}`
        const res = await this.getLiteratureResponse(doiUrl, headers, SEARCH_TIMEOUT_MS)
        if (res.ok) {
          const data = (await res.json()) as { results?: OpenAlexWork[] } & OpenAlexWork
          const items = Array.isArray(data.results) ? parseOpenAlexWorks(data.results) : parseOpenAlexWorks([data])
          const hit = items[0]
          if (hit) {
            return {
              matched: true,
              source: 'openalex',
              confidence: 'doi',
              citation: {
                title: hit.title,
                authors: hit.authors,
                year: hit.year !== null ? String(hit.year) : '',
                venue: hit.venue,
                doi: hit.doi ?? cleanDoi
              },
              message: '已通过 OpenAlex 按 DOI 精确校对文献元数据。'
            }
          }
        } else await res.body?.cancel().catch(() => {})
      } catch {
        // DOI 精确查询失败时继续尝试标题检索，或诚实返回未命中
      }
    }

    if (rawTitle) {
      try {
        const oaUrl = new URL(`${this.openAlexBaseUrl}/works`)
        oaUrl.searchParams.set('search', rawTitle)
        oaUrl.searchParams.set('per-page', '5')
        const res = await this.getLiteratureResponse(oaUrl.toString(), headers, SEARCH_TIMEOUT_MS)
        if (res.ok) {
          const data = (await res.json()) as { results?: OpenAlexWork[] }
          const candidates = parseOpenAlexWorks(Array.isArray(data.results) ? data.results : [])
          const queryTokens = new Set(
            rawTitle
              .toLowerCase()
              .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
              .split(/\s+/)
              .filter(t => t.length >= 2)
          )
          const normalizedQuery = normalizeTitleKey(rawTitle)

          let bestItem: LiteratureSearchItem | null = null
          let bestScore = 0
          for (const item of candidates) {
            const normCand = normalizeTitleKey(item.title)
            if (normalizedQuery && normCand && (normCand === normalizedQuery || normCand.includes(normalizedQuery) || normalizedQuery.includes(normCand))) {
              bestItem = item
              bestScore = 1
              break
            }
            const candTokens = new Set(
              item.title
                .toLowerCase()
                .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
                .split(/\s+/)
                .filter(t => t.length >= 2)
            )
            if (queryTokens.size === 0 || candTokens.size === 0) continue
            let overlap = 0
            for (const tok of queryTokens) {
              if (candTokens.has(tok)) overlap += 1
            }
            const union = queryTokens.size + candTokens.size - overlap
            const jaccard = union > 0 ? overlap / union : 0
            if (jaccard > bestScore) {
              bestScore = jaccard
              bestItem = item
            }
          }

          if (bestItem && bestScore >= 0.55) {
            return {
              matched: true,
              source: 'openalex',
              confidence: 'title',
              citation: {
                title: bestItem.title,
                authors: bestItem.authors,
                year: bestItem.year !== null ? String(bestItem.year) : '',
                venue: bestItem.venue,
                doi: bestItem.doi ?? cleanDoi
              },
              message: '已通过 OpenAlex 按标题匹配校对文献元数据（请核对后使用）。'
            }
          }
        } else {
          await res.body?.cancel().catch(() => {})
          return {
            matched: false,
            source: null,
            confidence: null,
            citation: null,
            message: `联网校对请求返回 HTTP ${res.status}，请稍后重试或手动编辑。`
          }
        }
      } catch (err: unknown) {
        return {
          matched: false,
          source: null,
          confidence: null,
          citation: null,
          message: `联网校对失败：${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    return {
      matched: false,
      source: null,
      confidence: null,
      citation: null,
      message: '未在 OpenAlex 找到高匹配度的文献条目，已保留当前表单内容。'
    }
  }
}
