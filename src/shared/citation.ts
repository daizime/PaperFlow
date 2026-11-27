export interface CitationMetadata {
  title: string
  authors: string[]
  year: string
  venue: string
  doi: string
  citeKey: string
}

export interface FirstPageTextItem {
  str: string
  fontSize: number
  x: number
  y: number
  width?: number
  hasEOL?: boolean
}

export interface FirstPageCitationSource {
  page1Text: string
  items?: readonly FirstPageTextItem[]
  pdfInfo?: {
    title?: string
    author?: string
    subject?: string
    creationDate?: string
  }
}

const JOURNAL_HINT_RE =
  /\b(Journal|Transactions|Trans\.|Letters|Magazine|Review|Nature|Science|Comput\.\s+Surv\.|PVLDB|Proc\.\s+VLDB\s+Endow\.)\b/i

const CONFERENCE_HINT_RE =
  /\b(Proceedings|Symposium|Conference|Workshop|SIGMOD|VLDB|ICDE|SOSP|OSDI|NSDI|ATC|EuroSys|ICML|NeurIPS|NIPS|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|AAAI|IJCAI|KDD|WWW|CHI|UIST|PLDI|POPL|ICSE|FSE|ASE)\b/i

const VENUE_HINT_RE =
  /\b(SIGMOD|VLDB|PVLDB|ICDE|SOSP|OSDI|NSDI|ATC|EuroSys|ICML|NeurIPS|NIPS|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|AAAI|IJCAI|KDD|WWW|CHI|UIST|PLDI|POPL|ICSE|FSE|ASE|IEEE|ACM|Springer|Elsevier|Nature|Science|arXiv|Proceedings|Symposium|Conference|Journal|Transactions|Workshop)\b/i

const META_LABEL_LINE_RE =
  /^(?:ACM\s+Reference\s+Format|Cite\s+this\s+article|Permission\s+to\s+make|Copyright|©|Received:|Revised:|Accepted:|Published\s+online|CCS\s+CONCEPTS|KEYWORDS|Index\s+Terms|Additional\s+Key\s+Words|Author(?:'s)?\s+address|Corresponding\s+author)/i

const PUBLISHER_BANNER_RE =
  /^(?:SPECIAL\s+ISSUE\s+PAPER|ORIGINAL\s+(?:PAPER|ARTICLE|RESEARCH)|RESEARCH\s+(?:ARTICLE|PAPER)|REGULAR\s+PAPER|REVIEW\s+(?:ARTICLE|PAPER)|TECHNICAL\s+(?:PAPER|REPORT)|FULL\s+PAPER|SHORT\s+PAPER|SURVEY\s+PAPER|VISION\s+PAPER|SYSTEMS\s+PAPER|PREPRINT|EXTENDED\s+ABSTRACT|OPEN\s+ACCESS|ARTICLE|PAPER|LETTER|BRIEF\s+ANNOUNCEMENT)$/i

const AFFILIATION_HINT_RE =
  /\b(University|Universität|Universitat|Université|Institute|Institut|Lab|Laboratory|College|Department|Dept\.?|Faculty|School|Center|Centre|Research|Academy|Inc\.|Corp\.|Corporation|Ltd\.|Google|Microsoft|Meta|Facebook|Amazon|Apple|IBM|Intel|NVIDIA|Alibaba|Tencent|ByteDance|Huawei|ETH|EPFL|MIT|CMU|Stanford|Berkeley|Darmstadt|Erlangen|Nürnberg|Zurich|Zürich|Munich|Berlin|Oxford|Cambridge|Beijing|Shanghai|China|USA|Germany|Switzerland|UK)\b/i

const COMMON_STOP_WORDS = new Set([
  'a', 'an', 'the', 'on', 'in', 'of', 'for', 'to', 'and', 'or', 'with', 'via', 'by', 'from', 'using', 'towards'
])

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

function cleanDoi(raw: string): string {
  return raw.replace(/[.,;)\]]+$/, '').trim()
}

/** 识别拉宽字母间距的出版商栏目标签（如 "S P E C I A L I S S U E P A P E R" 或 "ORIGINAL PAPER"）。 */
export function isBannerOrLabelLine(line: string): boolean {
  const clean = normalizeLine(line)
  if (!clean) return true
  if (PUBLISHER_BANNER_RE.test(clean)) return true
  // 检测拉宽单字母排版的全大写标牌（如 "S P E C I A L I S S U E P A P E R"）
  const tokens = clean.split(/\s+/)
  if (tokens.length >= 5) {
    const singleUpperCount = tokens.filter(t => /^[A-Z]$/.test(t)).length
    if (singleUpperCount / tokens.length >= 0.8) {
      return true
    }
  }
  return false
}

function stripLeadingSpacedBanner(text: string): string {
  const match = text.match(/^((?:[A-Z]\s+){5,}[A-Z])\s+(?=[A-Z0-9])/)
  if (!match) return text
  const collapsed = match[1].replace(/\s+/g, '')
  if (/^(?:SPECIALISSUEPAPER|ORIGINALPAPER|RESEARCHARTICLE|REGULARPAPER|REVIEWARTICLE|TECHNICALPAPER|FULLPAPER|SHORTPAPER|SURVEYPAPER|OPENACCESS|ARTICLE)$/.test(collapsed)) {
    return text.slice(match[0].length).trim()
  }
  return text
}

function isUsablePdfInfoTitle(rawTitle: string | undefined): string | null {
  if (!rawTitle) return null
  const clean = normalizeLine(rawTitle)
  if (clean.length < 4 || clean.length > 260) return null
  if (/\.(?:pdf|tex|dvi|docx?|pptx?)$/i.test(clean)) return null
  if (/^(?:untitled|microsoft\s+word|latex|document|paper|manuscript|main|draft|slide)/i.test(clean)) return null
  return clean
}

function parseAuthorString(raw: string): string[] {
  const cleaned = raw
    .replace(/[*†‡§¶∗]+/g, '')
    .replace(/\b(?:and|&)\b/gi, ',')
    .replace(/[·•|]+/g, ',')
    .replace(/(?<=\D)\d+(?:,\d+)*(?=\s|,|;|$)/g, '')
  const parts = cleaned
    .split(/[,;]+/)
    .map(p => normalizeLine(p))
    .filter(p => p.length >= 2 && p.length <= 60 && !/\d{2,}/.test(p))
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    if (out.length >= 12) break
    if (part.includes('@') || /https?:\/\//i.test(part) || AFFILIATION_HINT_RE.test(part)) continue
    if (META_LABEL_LINE_RE.test(part) || isBannerOrLabelLine(part)) continue
    const looksLikeLatinAuthor =
      /^[\p{Lu}][\p{L}.'-]+(?:\s+(?:[\p{L}.'-]+)){1,4}$/u.test(part) &&
      !/^(?:The|This|That|For|With|From|Under|Over|Into|Using|Based|Towards)\s/i.test(part)
    const looksLikeCjkAuthor = /^[\u4e00-\u9fff·]{2,5}$/.test(part)
    if (!looksLikeLatinAuthor && !looksLikeCjkAuthor) continue
    const key = part.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(part)
    }
  }
  return out
}

export function buildCitationKey(meta: Pick<CitationMetadata, 'title' | 'authors' | 'year'>): string {
  const firstAuthor = meta.authors[0]?.trim() ?? ''
  const surnameToken =
    firstAuthor
      .split(/[\s,]+/)
      .filter(Boolean)
      .pop()
      ?.replace(/[^A-Za-z0-9]/g, '') ?? ''
  const yearToken = (meta.year || '').replace(/[^0-9]/g, '') || ''
  const titleWords = (meta.title || '')
    .split(/[^A-Za-z0-9]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !COMMON_STOP_WORDS.has(w.toLowerCase()))
  const titleToken = titleWords[0] ?? 'paper'
  const base = `${surnameToken || 'paper'}${yearToken}${titleToken.slice(0, 1).toUpperCase()}${titleToken.slice(1).toLowerCase()}`
  const ascii = base.replace(/[^A-Za-z0-9_-]/g, '')
  return ascii || 'paperRef'
}

interface VisualLine {
  text: string
  fontSize: number
  y: number
  x: number
}

function buildVisualLines(items: readonly FirstPageTextItem[]): VisualLine[] {
  const lines: VisualLine[] = []
  let buf = ''
  let weightedSize = 0
  let weightChars = 0
  let startX = 0
  let lineY: number | null = null
  let lastEndX: number | null = null

  const flush = (): void => {
    const text = normalizeLine(buf)
    if (text && lineY !== null) {
      lines.push({
        text,
        fontSize: weightChars > 0 ? weightedSize / weightChars : 10,
        y: lineY,
        x: startX
      })
    }
    buf = ''
    weightedSize = 0
    weightChars = 0
    lineY = null
    lastEndX = null
  }

  for (const item of items) {
    if (!item.str) {
      if (item.hasEOL) flush()
      continue
    }
    const isSuperscriptDigit =
      /^[0-9,†‡*§¶∗]+$/.test(item.str.trim()) &&
      weightChars > 0 &&
      item.fontSize < (weightedSize / weightChars) * 0.85 &&
      lineY !== null &&
      item.y > lineY + 1 &&
      item.y < lineY + 7

    if (isSuperscriptDigit) {
      // 跳过作者名右上角的机构编号上标，避免把同行作者拆行
      if (typeof item.width === 'number') {
        lastEndX = item.x + Math.max(0, item.width)
      }
      continue
    }

    const yChanged = lineY !== null && Math.abs(item.y - lineY) > Math.max(4.5, (weightChars > 0 ? weightedSize / weightChars : 10) * 0.45)
    const bigColJump = lastEndX !== null && Math.abs(item.x - lastEndX) > 70
    if ((yChanged || bigColJump) && buf.trim().length > 0) {
      flush()
    }
    if (lineY === null) {
      lineY = item.y
      startX = item.x
    }
    if (buf && !buf.endsWith(' ') && !item.str.startsWith(' ')) {
      buf += ' '
    }
    buf += item.str
    const len = item.str.trim().length
    if (len > 0 && item.fontSize > 0) {
      weightedSize += item.fontSize * len
      weightChars += len
    }
    lastEndX = item.x + (typeof item.width === 'number' ? Math.max(0, item.width) : item.str.length * 4)
    if (item.hasEOL) flush()
  }
  flush()
  return lines
}

function extractVenueFromText(rawLines: readonly string[], fullText: string): string {
  // 1) 优先识别 ACM Reference Format 里的 "In Proceedings of ... (SIGMOD '22)"
  const acmRefMatch = fullText.match(/ACM\s+Reference\s+Format:\s*([\s\S]{20,650}?)(?:\n\s*(?:\d+\s+INTRODUCTION|Permission\s+to\s+make)|$)/i)
  if (acmRefMatch) {
    const collapsed = normalizeLine(acmRefMatch[1])
    const inProc = collapsed.match(/\bIn\s+(Proceedings\s+of\s+[^.]+?(?:\([^)]+\))?)(?:,|\.)/i)
    if (inProc?.[1]) {
      return normalizeLine(inProc[1]).slice(0, 140)
    }
  }

  // 2) 页眉期刊/会议卷期行（跳过元标签、版权与长正文句）
  for (const line of rawLines) {
    if (line.length < 6 || line.length > 140) continue
    if (META_LABEL_LINE_RE.test(line) || isBannerOrLabelLine(line)) continue
    if (/^https?:\/\//i.test(line)) continue
    if (VENUE_HINT_RE.test(line)) {
      // 跳过把期刊/会议词夹在长摘要正文里的句子
      if (line.split(/\s+/).length > 18 && !/\b(?:Proceedings|Journal|Transactions|arXiv)\b/i.test(line)) {
        continue
      }
      return line.slice(0, 140)
    }
  }
  return ''
}

function extractYearFromSources(venue: string, rawLines: readonly string[], fullText: string): string {
  // 1) 优先取正式期刊/会议卷期行里的 4 位年份（如 "The VLDB Journal (2024)" 或 "Proceedings of the 2022 ..."）
  const venueYear = venue.match(/\b((?:19|20)\d{2})\b/)
  if (venueYear) return venueYear[1]

  // 2) 次优先：ACM Reference Format / Proceedings / Published 行
  const acmRef = fullText.match(/ACM\s+Reference\s+Format:[\s\S]{0,220}?\b((?:19|20)\d{2})\b/i)
  if (acmRef) return acmRef[1]

  for (const line of rawLines) {
    if (/\b(?:Proceedings|Journal|Transactions|Conference|Symposium|SIGMOD|VLDB|arXiv)\b/i.test(line)) {
      const m = line.match(/\b((?:19|20)\d{2})\b/)
      if (m) return m[1]
    }
  }

  // 3) Published online / Accepted
  for (const line of rawLines) {
    if (/\b(?:Published|Accepted)\b/i.test(line)) {
      const m = line.match(/\b((?:19|20)\d{2})\b/)
      if (m) return m[1]
    }
  }

  // 4) Copyright / ©
  for (const line of rawLines) {
    if (/(?:©|Copyright)/i.test(line)) {
      const m = line.match(/\b((?:19|20)\d{2})\b/)
      if (m) return m[1]
    }
  }

  // 5) 兜底
  for (const line of rawLines) {
    const m = line.match(/\b((?:19|20)\d{2})\b/)
    if (m) return m[1]
  }
  return ''
}

/** 结合 PDF 内嵌元数据、首页字号层级与结构化文本提取引用信息（跨 ACM/Springer/IEEE/arXiv/中文论文通用）。 */
export function extractCitationMetadata(source: FirstPageCitationSource, fallbackTitle: string): CitationMetadata {
  const cleanFallback = normalizeLine(fallbackTitle.replace(/\.pdf$/i, '')) || 'Untitled Paper'
  const rawLines = source.page1Text
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(line => line.length > 0)

  const doiMatch = source.page1Text.match(/\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/)
  const doi = doiMatch ? cleanDoi(doiMatch[1]) : ''

  const venue = extractVenueFromText(rawLines, source.page1Text)
  const year = extractYearFromSources(venue, rawLines, source.page1Text)

  const infoTitle = isUsablePdfInfoTitle(source.pdfInfo?.title)
  let title = ''
  let authors: string[] = []

  // 若提供首页带字号文本项，优先使用最大字号层级精准识别标题（自动跳过小字号栏目标签与页眉）
  if (source.items && source.items.length > 0) {
    const visualLines = buildVisualLines(source.items)
    const abstractIdx = visualLines.findIndex(line => /^(?:abstract|摘要)\b[:.\s]*/i.test(line.text))
    const headerRegion = abstractIdx > 0 ? visualLines.slice(0, abstractIdx) : visualLines.slice(0, 28)

    const titleCandidates = headerRegion.filter(
      line =>
        line.text.length >= 4 &&
        !isBannerOrLabelLine(line.text) &&
        !META_LABEL_LINE_RE.test(line.text) &&
        !/^https?:\/\//i.test(line.text) &&
        !/^arXiv:/i.test(line.text) &&
        !/^\d+$/.test(line.text) &&
        line.text !== venue
    )

    if (titleCandidates.length > 0) {
      const maxFont = Math.max(...titleCandidates.map(l => l.fontSize))
      const fontSizes = visualLines.map(l => l.fontSize).sort((a, b) => a - b)
      const medianFont = fontSizes[Math.floor(fontSizes.length / 2)] ?? 10
      if (maxFont >= Math.max(11.5, medianFont * 1.15)) {
        const firstTitleIdx = headerRegion.findIndex(
          line =>
            titleCandidates.includes(line) &&
            line.fontSize >= maxFont * 0.88
        )
        if (firstTitleIdx >= 0) {
          const titleParts: string[] = []
          let lastTitleIdx = firstTitleIdx
          for (let i = firstTitleIdx; i < headerRegion.length && titleParts.length < 4; i += 1) {
            const candidate = headerRegion[i]
            if (candidate.fontSize < maxFont * 0.88) break
            if (isBannerOrLabelLine(candidate.text) || META_LABEL_LINE_RE.test(candidate.text)) break
            titleParts.push(candidate.text)
            lastTitleIdx = i
          }
          title = normalizeLine(titleParts.join(' '))

          // 从标题之后至 Abstract 之前的所有行提取作者（支持多栏作者与中圆点分隔）
          const authorLines = headerRegion.slice(lastTitleIdx + 1)
          const collected: string[] = []
          const seen = new Set<string>()
          for (const line of authorLines) {
            if (/^(?:Received:|Revised:|Accepted:|Published|©|Copyright|Keywords|CCS\s+CONCEPTS)/i.test(line.text)) {
              break
            }
            for (const name of parseAuthorString(line.text)) {
              const key = name.toLowerCase()
              if (!seen.has(key)) {
                seen.add(key)
                collected.push(name)
              }
            }
          }
          authors = collected
        }
      }
    }
  }

  // 若 PDF 内嵌 Title 合法且视觉标题为空或包含残余前缀，优先采用干净标题
  if (!title && infoTitle) {
    title = infoTitle
  }

  // 纯文本兜底路径（用于无 items 的纯文本调用）
  if (!title) {
    const abstractIdx = rawLines.findIndex(line => /^(?:abstract|摘要)\b[:.\s]*/i.test(line))
    const headerLines = (abstractIdx > 0 ? rawLines.slice(0, abstractIdx) : rawLines.slice(0, 20)).filter(
      line =>
        !/^https?:\/\//i.test(line) &&
        !/^arXiv:/i.test(line) &&
        !META_LABEL_LINE_RE.test(line) &&
        !isBannerOrLabelLine(line)
    )

    let titleLineIndex = -1
    for (let i = 0; i < Math.min(headerLines.length, 8); i += 1) {
      const line = stripLeadingSpacedBanner(headerLines[i])
      if (!line || line === venue || (VENUE_HINT_RE.test(line) && line.length < 85 && i <= 1)) continue
      if (/^\d+$/.test(line)) continue
      if (line.length >= 6) {
        title = line
        titleLineIndex = i
        const next = headerLines[i + 1]
        if (
          next &&
          next.length >= 4 &&
          next.length <= 95 &&
          !next.includes('@') &&
          !AFFILIATION_HINT_RE.test(next) &&
          parseAuthorString(next).length === 0
        ) {
          title = normalizeLine(`${title} ${next}`)
          titleLineIndex = i + 1
        }
        break
      }
    }

    if (authors.length === 0) {
      const start = titleLineIndex >= 0 ? titleLineIndex + 1 : 1
      const seen = new Set<string>()
      for (let i = start; i < headerLines.length; i += 1) {
        const line = headerLines[i]
        if (/^(?:keywords|index terms|关键词|received:|revised:|accepted:)/i.test(line)) break
        for (const name of parseAuthorString(line)) {
          const key = name.toLowerCase()
          if (!seen.has(key)) {
            seen.add(key)
            authors.push(name)
          }
        }
      }
    }
  }

  // 使用 PDF 内嵌 Author 元数据作为可靠补全（如多栏排版缺失或无 items 时）
  if (source.pdfInfo?.author) {
    const infoAuthors = parseAuthorString(source.pdfInfo.author)
    if (infoAuthors.length > authors.length) {
      authors = infoAuthors
    }
  }

  title = stripLeadingSpacedBanner(normalizeLine(title)) || infoTitle || cleanFallback

  const draft = { title, authors, year, venue, doi }
  return {
    ...draft,
    citeKey: buildCitationKey(draft)
  }
}

/** 兼容纯文本入口：从首页纯文本中提取引用元数据。 */
export function extractCitationMetadataFromText(page1Text: string, fallbackTitle: string): CitationMetadata {
  return extractCitationMetadata({ page1Text }, fallbackTitle)
}

function isConferenceVenue(venue: string): boolean {
  const clean = venue.trim()
  if (!clean) return false
  // 含 Journal / Transactions / Letters / Review 等明确期刊标识时优先归为 @article，避免 "The VLDB Journal" 误判为会议
  if (JOURNAL_HINT_RE.test(clean)) return false
  return CONFERENCE_HINT_RE.test(clean)
}

function escapeBibValue(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/[{}]/g, ch => `\\${ch}`).replace(/\s+/g, ' ').trim()
}

function sanitizeRisLineValue(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}

export function formatBibtex(
  meta: CitationMetadata,
  extra?: { filePath?: string; tags?: readonly string[]; citeKey?: string }
): string {
  const key = (extra?.citeKey || meta.citeKey || buildCitationKey(meta)).replace(/[^A-Za-z0-9_:-]/g, '') || 'paperRef'
  const isConference = isConferenceVenue(meta.venue)
  const entryType = isConference ? 'inproceedings' : 'article'
  const fields: string[] = [`  title     = {${escapeBibValue(meta.title)}}`]
  if (meta.authors.length > 0) {
    fields.push(`  author    = {${escapeBibValue(meta.authors.join(' and '))}}`)
  }
  if (meta.year.trim()) {
    fields.push(`  year      = {${escapeBibValue(meta.year)}}`)
  }
  if (meta.venue.trim()) {
    const venueField = isConference ? 'booktitle' : 'journal'
    fields.push(`  ${venueField.padEnd(9)} = {${escapeBibValue(meta.venue)}}`)
  }
  if (meta.doi.trim()) {
    fields.push(`  doi       = {${escapeBibValue(meta.doi)}}`)
  }
  if (extra?.tags && extra.tags.length > 0) {
    fields.push(`  keywords  = {${escapeBibValue(extra.tags.join(', '))}}`)
  }
  if (extra?.filePath) {
    fields.push(`  file      = {${escapeBibValue(extra.filePath)}}`)
  }
  return `@${entryType}{${key},\n${fields.join(',\n')}\n}`
}

export function formatRis(
  meta: CitationMetadata,
  extra?: { filePath?: string; tags?: readonly string[] }
): string {
  const isConference = isConferenceVenue(meta.venue)
  const lines: string[] = [`TY  - ${isConference ? 'CONF' : 'JOUR'}`, `TI  - ${sanitizeRisLineValue(meta.title)}`]
  for (const author of meta.authors) {
    const clean = sanitizeRisLineValue(author)
    if (clean) lines.push(`AU  - ${clean}`)
  }
  if (meta.year.trim()) lines.push(`PY  - ${sanitizeRisLineValue(meta.year)}`)
  if (meta.venue.trim()) lines.push(`${isConference ? 'T2' : 'JO'}  - ${sanitizeRisLineValue(meta.venue)}`)
  if (meta.doi.trim()) lines.push(`DO  - ${sanitizeRisLineValue(meta.doi)}`)
  for (const tag of extra?.tags ?? []) {
    const clean = sanitizeRisLineValue(tag)
    if (clean) lines.push(`KW  - ${clean}`)
  }
  if (extra?.filePath) lines.push(`L1  - ${sanitizeRisLineValue(extra.filePath)}`)
  lines.push('ER  - ')
  return lines.join('\n')
}

function formatIeeeAuthor(name: string): string {
  const clean = name.trim()
  if (/^[\u4e00-\u9fff·]{2,8}$/.test(clean)) return clean
  const parts = clean.split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return clean
  const surname = parts[parts.length - 1]
  const initials = parts
    .slice(0, -1)
    .map(p => `${p[0].toUpperCase()}.`)
    .join(' ')
  return `${initials} ${surname}`
}

export function formatIeee(meta: CitationMetadata): string {
  const authors = meta.authors.map(formatIeeeAuthor).filter(Boolean)
  let authorSegment = ''
  if (authors.length === 1) authorSegment = authors[0]
  else if (authors.length === 2) authorSegment = `${authors[0]} and ${authors[1]}`
  else if (authors.length > 2 && authors.length <= 6) {
    authorSegment = `${authors.slice(0, -1).join(', ')}, and ${authors[authors.length - 1]}`
  } else if (authors.length > 6) {
    authorSegment = `${authors.slice(0, 3).join(', ')}, et al.`
  }

  const tailParts: string[] = []
  if (meta.venue.trim()) tailParts.push(meta.venue.trim())
  if (meta.year.trim()) tailParts.push(meta.year.trim())
  const titlePart = tailParts.length > 0 ? `"${meta.title},"` : `"${meta.title}."`
  const prefix = authorSegment ? `${authorSegment}, ` : ''
  const main = tailParts.length > 0 ? `${prefix}${titlePart} ${tailParts.join(', ')}.` : `${prefix}${titlePart}`
  return meta.doi.trim() ? `${main} doi: ${meta.doi.trim()}.` : main
}

function formatGbtAuthor(name: string): string {
  const clean = name.trim()
  if (/^[\u4e00-\u9fff·]{2,8}$/.test(clean)) return clean
  const parts = clean.split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return clean
  const surname = parts[parts.length - 1].toUpperCase()
  const initials = parts
    .slice(0, -1)
    .map(p => p[0].toUpperCase())
    .join(' ')
  return `${surname} ${initials}`
}

export function formatGbt7714(meta: CitationMetadata): string {
  const authors = meta.authors.map(formatGbtAuthor).filter(Boolean)
  const authorText =
    authors.length === 0
      ? ''
      : authors.length <= 3
        ? `${authors.join(', ')}. `
        : `${authors.slice(0, 3).join(', ')}, 等. `
  const docType = isConferenceVenue(meta.venue) ? '[C]' : '[J]'
  const pubParts = [meta.venue.trim(), meta.year.trim()].filter(Boolean)
  const pubText = pubParts.length > 0 ? ` ${pubParts.join(', ')}.` : ''
  const doiText = meta.doi.trim() ? ` DOI: ${meta.doi.trim()}.` : ''
  return `${authorText}${meta.title}${docType}.${pubText}${doiText}`.trim()
}

/**
 * 判断文件名或初始展示标题是否为常见乱码/编号式学术文件名（如 arXiv 编号、ScienceDirect、Springer、DOI、长哈希或通用占位名）。
 */
export function isLikelyMessyAcademicFilename(rawName: string): boolean {
  const stem = rawName.trim().replace(/\.pdf$/i, '').trim()
  if (stem.length < 2) return false
  if (/^\d{4}\.\d{4,5}(?:v\d+)?$/i.test(stem)) return true
  if (/^[a-z-]+-\d{7}(?:v\d+)?$/i.test(stem)) return true
  if (/^1-s2\.0-/i.test(stem)) return true
  if (/^s\d{5}-\d{3}-\d{4,5}/i.test(stem)) return true
  if (/^10\.\d{4,9}[._-]/i.test(stem)) return true
  if (/^PIIS\d{8,}/i.test(stem)) return true
  if (/^PMC\d{5,}$/i.test(stem)) return true
  if (/^nihms-?\d+$/i.test(stem)) return true
  if (/^\d[\d_-]{4,}$/.test(stem)) return true
  if (/^[0-9a-f]{12,}$/i.test(stem)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)) return true
  if (/^(?:download|document|article|paper|manuscript|preprint|fulltext|main|draft|supplementary|appendix|file)[_-]\d+$/i.test(stem)) {
    return true
  }
  if (/^(?:main|manuscript|fulltext|preprint|submitted|draft|download|document|supplementary|merged)$/i.test(stem)) {
    return true
  }
  return false
}

/**
 * 从 PDF 首页文本及文档信息中提取可用于自动命名的清晰论文标题；若提取结果无改进或仍像噪声则回退 null。
 */
export function extractCleanPaperTitle(source: FirstPageCitationSource, fallbackTitle: string): string | null {
  const meta = extractCitationMetadata(source, fallbackTitle)
  const cleanTitle = normalizeLine(meta.title)
  if (cleanTitle.length < 8 || cleanTitle.length > 220) return null

  const normalizedFallback = normalizeLine(fallbackTitle.replace(/\.pdf$/i, ''))
  if (cleanTitle.toLowerCase() === normalizedFallback.toLowerCase()) return null
  if (cleanTitle === fallbackTitle.trim()) return null
  if (isLikelyMessyAcademicFilename(cleanTitle)) return null
  if (/^(?:https?:\/\/|arxiv:|doi:|abstract\b|introduction\b|keywords?\b|contents\b|references\b)/i.test(cleanTitle)) {
    return null
  }
  return cleanTitle
}
