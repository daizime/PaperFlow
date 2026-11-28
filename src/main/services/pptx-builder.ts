import {
  type AcademicSlideDeck,
  type AcademicSlideLayout,
  type AcademicSlideMetric,
  type AcademicSlideSpec
} from '../../shared/contracts'
import { createZipBuffer, type ZipInputEntry } from './zip-archive'

// 16:9 宽屏标准尺寸（单位：EMU，1 inch = 914400 EMU）
const SLIDE_W = 12192000 // 13.333 in
const SLIDE_H = 6858000 // 7.5 in
const INCH = 914400

// 借鉴 anthropics/skills pptx 的学术汇报“三明治”配色体系：深海蓝封面/结语 + 素雅浅灰内容页
const PALETTE = {
  navy: '162238',
  navyDeep: '0F1829',
  royal: '2B5BB5',
  royalSoft: 'E9F0FD',
  surfaceLight: 'F6F8FC',
  cardBg: 'FFFFFF',
  cardBorder: 'D6E0F0',
  slateDark: '1E293B',
  slateMuted: '52627A',
  goldAccent: 'D99B26',
  white: 'FFFFFF',
  inkOnDarkMuted: 'B8C7E0'
} as const

function stripInvalidXmlChars(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd)
    ) {
      out += raw[i]
    }
  }
  return out
}

function escapeXml(raw: string): string {
  return stripInvalidXmlChars(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function clampText(raw: string | undefined, maxLen: number): string {
  if (!raw) return ''
  const cleaned = stripInvalidXmlChars(raw).replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLen) return cleaned
  return `${cleaned.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`
}

interface ParagraphSpec {
  text: string
  fontSizePt?: number
  bold?: boolean
  italic?: boolean
  colorHex?: string
  align?: 'l' | 'ctr' | 'r'
  bullet?: boolean
  spaceAfterPt?: number
}

function buildTextBodyXml(paragraphs: readonly ParagraphSpec[], anchor: 't' | 'ctr' = 't'): string {
  const safeParas = paragraphs.length > 0 ? paragraphs : [{ text: ' ' }]
  const pXml = safeParas
    .map(p => {
      const sz = Math.round((p.fontSizePt ?? 15) * 100)
      const boldAttr = p.bold ? ' b="1"' : ' b="0"'
      const italicAttr = p.italic ? ' i="1"' : ''
      const colorHex = p.colorHex ?? PALETTE.slateDark
      const align = p.align ?? 'l'
      const spaceAfter = Math.round((p.spaceAfterPt ?? 6) * 100)
      const pPr = p.bullet
        ? `<a:pPr algn="${align}" marL="274320" indent="-274320"><a:spcAft><a:spcPts val="${spaceAfter}"/></a:spcAft><a:buChar char="•"/></a:pPr>`
        : `<a:pPr algn="${align}"><a:spcAft><a:spcPts val="${spaceAfter}"/></a:spcAft></a:pPr>`
      const escaped = escapeXml(p.text || ' ')
      return `<a:p>${pPr}<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${sz}"${boldAttr}${italicAttr} dirty="0"><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill><a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei UI"/></a:rPr><a:t>${escaped}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${sz}"/></a:p>`
    })
    .join('')
  return `<p:txBody><a:bodyPr wrap="square" anchor="${anchor}" lIns="114300" tIns="76200" rIns="114300" bIns="76200"/><a:lstStyle/>${pXml}</p:txBody>`
}

function buildRectShapeXml(options: {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  fillHex?: string
  lineHex?: string
  linePt?: number
  rounded?: boolean
  paragraphs?: readonly ParagraphSpec[]
  anchor?: 't' | 'ctr'
}): string {
  const geom = options.rounded ? 'roundRect' : 'rect'
  const avLst = options.rounded ? '<a:avLst><a:gd name="adj" fmla="val 5000"/></a:avLst>' : '<a:avLst/>'
  const fillXml = options.fillHex
    ? `<a:solidFill><a:srgbClr val="${options.fillHex}"/></a:solidFill>`
    : '<a:noFill/>'
  const lineXml = options.lineHex
    ? `<a:ln w="${Math.round((options.linePt ?? 1) * 12700)}"><a:solidFill><a:srgbClr val="${options.lineHex}"/></a:solidFill></a:ln>`
    : '<a:ln><a:noFill/></a:ln>'
  const txBody = options.paragraphs
    ? buildTextBodyXml(options.paragraphs, options.anchor ?? 't')
    : '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>'

  return `<p:sp><p:nvSpPr><p:cNvPr id="${options.id}" name="${escapeXml(options.name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(options.x)}" y="${Math.round(options.y)}"/><a:ext cx="${Math.round(options.w)}" cy="${Math.round(options.h)}"/></a:xfrm><a:prstGeom prst="${geom}">${avLst}</a:prstGeom>${fillXml}${lineXml}</p:spPr>${txBody}</p:sp>`
}

function renderSlideXml(slide: AcademicSlideSpec, index: number, total: number, deck: AcademicSlideDeck): string {
  const layout: AcademicSlideLayout = slide.layout
  const isDarkBookend = layout === 'cover' || layout === 'closing'
  const bgHex = isDarkBookend ? PALETTE.navy : PALETTE.surfaceLight
  const shapes: string[] = []
  let nextId = 2

  const pushRect = (opts: Omit<Parameters<typeof buildRectShapeXml>[0], 'id'>): void => {
    shapes.push(buildRectShapeXml({ ...opts, id: nextId }))
    nextId += 1
  }

  if (layout === 'cover') {
    // 顶部品牌标识条与封面居中视觉结构
    pushRect({
      name: 'CoverAccentBar',
      x: Math.round(0.75 * INCH),
      y: Math.round(1.65 * INCH),
      w: Math.round(1.4 * INCH),
      h: Math.round(0.08 * INCH),
      fillHex: PALETTE.goldAccent
    })
    pushRect({
      name: 'CoverTitle',
      x: Math.round(0.75 * INCH),
      y: Math.round(1.95 * INCH),
      w: Math.round(11.8 * INCH),
      h: Math.round(1.9 * INCH),
      paragraphs: [
        {
          text: clampText(slide.title || deck.deckTitle, 110),
          fontSizePt: 34,
          bold: true,
          colorHex: PALETTE.white,
          spaceAfterPt: 12
        },
        ...(slide.subtitle || deck.subtitle
          ? [
              {
                text: clampText(slide.subtitle || deck.subtitle, 160),
                fontSizePt: 17,
                colorHex: PALETTE.inkOnDarkMuted,
                spaceAfterPt: 8
              }
            ]
          : [])
      ]
    })
    const metaBullets = (slide.bullets ?? []).slice(0, 4)
    if (deck.authors || metaBullets.length > 0) {
      pushRect({
        name: 'CoverMetaCard',
        x: Math.round(0.75 * INCH),
        y: Math.round(4.35 * INCH),
        w: Math.round(11.8 * INCH),
        h: Math.round(2.1 * INCH),
        fillHex: PALETTE.navyDeep,
        lineHex: PALETTE.royal,
        linePt: 1,
        rounded: true,
        paragraphs: [
          ...(deck.authors
            ? [
                {
                  text: clampText(deck.authors, 140),
                  fontSizePt: 14,
                  bold: true,
                  colorHex: PALETTE.goldAccent,
                  spaceAfterPt: 8
                }
              ]
            : []),
          ...metaBullets.map(item => ({
            text: clampText(item, 150),
            fontSizePt: 13.5,
            colorHex: PALETTE.white,
            bullet: true,
            spaceAfterPt: 5
          }))
        ]
      })
    }
  } else if (layout === 'closing') {
    pushRect({
      name: 'ClosingAccent',
      x: Math.round(0.75 * INCH),
      y: Math.round(1.0 * INCH),
      w: Math.round(1.2 * INCH),
      h: Math.round(0.08 * INCH),
      fillHex: PALETTE.goldAccent
    })
    pushRect({
      name: 'ClosingTitle',
      x: Math.round(0.75 * INCH),
      y: Math.round(1.25 * INCH),
      w: Math.round(11.8 * INCH),
      h: Math.round(1.1 * INCH),
      paragraphs: [
        {
          text: clampText(slide.title, 100),
          fontSizePt: 30,
          bold: true,
          colorHex: PALETTE.white,
          spaceAfterPt: 6
        },
        ...(slide.subtitle
          ? [
              {
                text: clampText(slide.subtitle, 150),
                fontSizePt: 15,
                colorHex: PALETTE.inkOnDarkMuted
              }
            ]
          : [])
      ]
    })
    const points = (slide.bullets ?? []).slice(0, 5)
    pushRect({
      name: 'ClosingTakeaways',
      x: Math.round(0.75 * INCH),
      y: Math.round(2.65 * INCH),
      w: Math.round(11.8 * INCH),
      h: Math.round(3.6 * INCH),
      fillHex: PALETTE.navyDeep,
      lineHex: PALETTE.royal,
      linePt: 1,
      rounded: true,
      paragraphs: [
        ...(points.length > 0
          ? points.map(b => ({
              text: clampText(b, 170),
              fontSizePt: 15,
              colorHex: PALETTE.white,
              bullet: true,
              spaceAfterPt: 10
            }))
          : [
              {
                text: clampText(slide.takeaway || '感谢聆听，欢迎交流与指正。', 180),
                fontSizePt: 18,
                colorHex: PALETTE.white
              }
            ]),
        ...(slide.takeaway && points.length > 0
          ? [
              {
                text: `核心结论：${clampText(slide.takeaway, 160)}`,
                fontSizePt: 14,
                bold: true,
                colorHex: PALETTE.goldAccent,
                spaceAfterPt: 4
              }
            ]
          : [])
      ]
    })
  } else {
    // 浅色内容页公共页眉与页脚
    pushRect({
      name: 'TopRule',
      x: Math.round(0.6 * INCH),
      y: Math.round(0.42 * INCH),
      w: Math.round(0.65 * INCH),
      h: Math.round(0.06 * INCH),
      fillHex: PALETTE.royal
    })
    pushRect({
      name: 'SlideHeader',
      x: Math.round(0.6 * INCH),
      y: Math.round(0.54 * INCH),
      w: Math.round(12.1 * INCH),
      h: Math.round(1.0 * INCH),
      paragraphs: [
        {
          text: clampText(slide.title, 95),
          fontSizePt: 23,
          bold: true,
          colorHex: PALETTE.slateDark,
          spaceAfterPt: 4
        },
        ...(slide.subtitle
          ? [
              {
                text: clampText(slide.subtitle, 145),
                fontSizePt: 13,
                colorHex: PALETTE.slateMuted,
                spaceAfterPt: 2
              }
            ]
          : [])
      ]
    })

    const contentTop = Math.round(1.68 * INCH)
    const footerTop = Math.round(6.28 * INCH)
    const contentHeight = Math.round(4.4 * INCH)

    if (layout === 'metrics') {
      const metrics: AcademicSlideMetric[] =
        slide.metrics && slide.metrics.length > 0
          ? slide.metrics.slice(0, 4)
          : (slide.bullets ?? []).slice(0, 3).map((b, i) => ({
              value: `0${i + 1}`,
              label: clampText(b, 80)
            }))
      const count = Math.max(1, metrics.length)
      const gap = Math.round(0.24 * INCH)
      const totalW = Math.round(12.13 * INCH)
      const cardW = Math.round((totalW - gap * (count - 1)) / count)
      const cardH = slide.bullets && slide.bullets.length > 0 ? Math.round(2.35 * INCH) : contentHeight
      metrics.forEach((m, idx) => {
        pushRect({
          name: `MetricCard-${idx + 1}`,
          x: Math.round(0.6 * INCH + idx * (cardW + gap)),
          y: contentTop,
          w: cardW,
          h: cardH,
          fillHex: PALETTE.cardBg,
          lineHex: PALETTE.cardBorder,
          linePt: 1.2,
          rounded: true,
          anchor: 'ctr',
          paragraphs: [
            {
              text: clampText(m.value, 24),
              fontSizePt: 34,
              bold: true,
              colorHex: PALETTE.royal,
              align: 'ctr',
              spaceAfterPt: 8
            },
            {
              text: clampText(m.label, 65),
              fontSizePt: 14,
              bold: true,
              colorHex: PALETTE.slateDark,
              align: 'ctr',
              spaceAfterPt: 4
            },
            ...(m.detail
              ? [
                  {
                    text: clampText(m.detail, 95),
                    fontSizePt: 11.5,
                    colorHex: PALETTE.slateMuted,
                    align: 'ctr' as const
                  }
                ]
              : [])
          ]
        })
      })
      if (slide.bullets && slide.bullets.length > 0) {
        pushRect({
          name: 'MetricHighlights',
          x: Math.round(0.6 * INCH),
          y: Math.round(contentTop + cardH + 0.22 * INCH),
          w: totalW,
          h: Math.round(contentHeight - cardH - 0.22 * INCH),
          fillHex: PALETTE.cardBg,
          lineHex: PALETTE.cardBorder,
          linePt: 1,
          rounded: true,
          paragraphs: slide.bullets.slice(0, 4).map(b => ({
            text: clampText(b, 165),
            fontSizePt: 13.5,
            colorHex: PALETTE.slateDark,
            bullet: true,
            spaceAfterPt: 5
          }))
        })
      }
    } else if (layout === 'two-column') {
      const cols =
        slide.columns && slide.columns.length >= 2
          ? slide.columns.slice(0, 2)
          : [
              {
                heading: '核心方法与机制',
                points: (slide.bullets ?? []).slice(0, Math.ceil((slide.bullets?.length ?? 0) / 2))
              },
              {
                heading: '关键发现与对比',
                points: (slide.bullets ?? []).slice(Math.ceil((slide.bullets?.length ?? 0) / 2))
              }
            ]
      const gap = Math.round(0.28 * INCH)
      const colW = Math.round((12.13 * INCH - gap) / 2)
      cols.forEach((col, idx) => {
        pushRect({
          name: `Column-${idx + 1}`,
          x: Math.round(0.6 * INCH + idx * (colW + gap)),
          y: contentTop,
          w: colW,
          h: contentHeight,
          fillHex: PALETTE.cardBg,
          lineHex: idx === 0 ? PALETTE.royal : PALETTE.cardBorder,
          linePt: idx === 0 ? 1.5 : 1,
          rounded: true,
          paragraphs: [
            {
              text: clampText(col.heading, 60),
              fontSizePt: 16,
              bold: true,
              colorHex: PALETTE.royal,
              spaceAfterPt: 10
            },
            ...(col.points.length > 0 ? col.points : ['暂无补充细节']).slice(0, 6).map(pt => ({
              text: clampText(pt, 155),
              fontSizePt: 13.5,
              colorHex: PALETTE.slateDark,
              bullet: true,
              spaceAfterPt: 7
            }))
          ]
        })
      })
    } else {
      // 'cards': 将结构化卡片或要点排布成 2×2 或多卡片网格，拒绝单调纯列表页
      const cards =
        slide.columns && slide.columns.length > 0
          ? slide.columns.slice(0, 4)
          : (slide.bullets ?? []).slice(0, 4).map((b, idx) => ({
              heading: `要点 0${idx + 1}`,
              points: [b]
            }))
      const safeCards = cards.length > 0 ? cards : [{ heading: '核心内容', points: [slide.takeaway || slide.title] }]
      const colsPerRow = safeCards.length <= 2 ? safeCards.length : 2
      const rows = Math.ceil(safeCards.length / colsPerRow)
      const gapX = Math.round(0.24 * INCH)
      const gapY = Math.round(0.22 * INCH)
      const cardW = Math.round((12.13 * INCH - gapX * (colsPerRow - 1)) / colsPerRow)
      const cardH = Math.round((contentHeight - gapY * (rows - 1)) / rows)

      safeCards.forEach((card, idx) => {
        const colIdx = idx % colsPerRow
        const rowIdx = Math.floor(idx / colsPerRow)
        pushRect({
          name: `InfoCard-${idx + 1}`,
          x: Math.round(0.6 * INCH + colIdx * (cardW + gapX)),
          y: Math.round(contentTop + rowIdx * (cardH + gapY)),
          w: cardW,
          h: cardH,
          fillHex: PALETTE.cardBg,
          lineHex: PALETTE.cardBorder,
          linePt: 1.1,
          rounded: true,
          paragraphs: [
            {
              text: clampText(card.heading, 65),
              fontSizePt: 15,
              bold: true,
              colorHex: PALETTE.royal,
              spaceAfterPt: 7
            },
            ...card.points.slice(0, 4).map(pt => ({
              text: clampText(pt, 155),
              fontSizePt: 13,
              colorHex: PALETTE.slateDark,
              bullet: card.points.length > 1,
              spaceAfterPt: 5
            }))
          ]
        })
      })
    }

    // 底部结论胶囊条与页码
    if (slide.takeaway) {
      pushRect({
        name: 'TakeawayBar',
        x: Math.round(0.6 * INCH),
        y: footerTop,
        w: Math.round(10.6 * INCH),
        h: Math.round(0.68 * INCH),
        fillHex: PALETTE.royalSoft,
        lineHex: PALETTE.cardBorder,
        linePt: 0.8,
        rounded: true,
        anchor: 'ctr',
        paragraphs: [
          {
            text: `核心要点：${clampText(slide.takeaway, 130)}`,
            fontSizePt: 12.5,
            bold: true,
            colorHex: PALETTE.royal,
            spaceAfterPt: 0
          }
        ]
      })
    }
    pushRect({
      name: 'SlideNumberFooter',
      x: Math.round(11.35 * INCH),
      y: footerTop,
      w: Math.round(1.38 * INCH),
      h: Math.round(0.68 * INCH),
      anchor: 'ctr',
      paragraphs: [
        {
          text: `${index + 1} / ${total}`,
          fontSizePt: 11,
          colorHex: PALETTE.slateMuted,
          align: 'r',
          spaceAfterPt: 0
        }
      ]
    })
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${shapes.join('\n      ')}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`
}

function renderNotesSlideXml(slideNumber: number, speakerNotes: string | undefined): string {
  const safeNotes = escapeXml((speakerNotes || `第 ${slideNumber} 页演讲备注：结合论文图表与核心结论进行展开讲解。`).trim())
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p><a:r><a:rPr lang="zh-CN" dirty="0"/><a:t>${safeNotes}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:notes>`
}

/**
 * 纯 TypeScript 生成标准 OOXML `.pptx` 压缩包（16:9 宽屏、结构化分栏/指标卡排版 + 每页演讲备注）。
 * 无需 Python、LibreOffice 或外部二进制依赖，直接通过内置 Zip 引擎组装。
 */
export function buildAcademicPptxBuffer(deck: AcademicSlideDeck): Buffer {
  const slides = deck.slides.length > 0 ? deck.slides : [{ title: deck.deckTitle, layout: 'cover' as const }]
  const entries: ZipInputEntry[] = []
  const nowIso = new Date().toISOString()

  const slideContentTypes = slides
    .map(
      (_s, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
        `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
    )
    .join('')

  entries.push({
    name: '[Content_Types].xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>
  ${slideContentTypes}
</Types>`,
      'utf8'
    )
  })

  entries.push({
    name: '_rels/.rels',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
      'utf8'
    )
  })

  entries.push({
    name: 'docProps/core.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(deck.deckTitle)}</dc:title>
  <dc:creator>${escapeXml(deck.authors || 'Foliopair AI')}</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified>
</cp:coreProperties>`,
      'utf8'
    )
  })

  entries.push({
    name: 'docProps/app.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Foliopair</Application>
  <Slides>${slides.length}</Slides>
  <ScaleCrop>false</ScaleCrop>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>1.0</AppVersion>
</Properties>`,
      'utf8'
    )
  })

  const sldIdEntries = slides
    .map((_s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 5}"/>`)
    .join('')
  const slideRelsEntries = slides
    .map(
      (_s, i) =>
        `<Relationship Id="rId${i + 5}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
    )
    .join('')

  entries.push({
    name: 'ppt/presentation.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>
  <p:sldIdLst>${sldIdEntries}</p:sldIdLst>
  <p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="screen16x9"/>
  <p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>
</p:presentation>`,
      'utf8'
    )
  })

  entries.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
  ${slideRelsEntries}
  <Relationship Id="rId${slides.length + 5}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rId${slides.length + 6}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
</Relationships>`,
      'utf8'
    )
  })

  entries.push({
    name: 'ppt/presProps.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
      'utf8'
    )
  })
  entries.push({
    name: 'ppt/viewProps.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
      'utf8'
    )
  })
  entries.push({
    name: 'ppt/tableStyles.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
      'utf8'
    )
  })

  entries.push({
    name: 'ppt/theme/theme1.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Foliopair Academic">
  <a:themeElements>
    <a:clrScheme name="Foliopair Academic">
      <a:dk1><a:srgbClr val="${PALETTE.slateDark}"/></a:dk1>
      <a:lt1><a:srgbClr val="${PALETTE.white}"/></a:lt1>
      <a:dk2><a:srgbClr val="${PALETTE.navy}"/></a:dk2>
      <a:lt2><a:srgbClr val="${PALETTE.surfaceLight}"/></a:lt2>
      <a:accent1><a:srgbClr val="${PALETTE.royal}"/></a:accent1>
      <a:accent2><a:srgbClr val="${PALETTE.goldAccent}"/></a:accent2>
      <a:accent3><a:srgbClr val="3D7A5A"/></a:accent3>
      <a:accent4><a:srgbClr val="7A5AF8"/></a:accent4>
      <a:accent5><a:srgbClr val="0891B2"/></a:accent5>
      <a:accent6><a:srgbClr val="D97706"/></a:accent6>
      <a:hlink><a:srgbClr val="${PALETTE.royal}"/></a:hlink>
      <a:folHlink><a:srgbClr val="6B7280"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Foliopair Fonts">
      <a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei UI"/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei UI"/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Foliopair Formats">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`,
      'utf8'
    )
  })

  entries.push({
    name: 'ppt/slideMasters/slideMaster1.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
      'utf8'
    )
  })

  entries.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
      'utf8'
    )
  })

  entries.push({
    name: 'ppt/slideLayouts/slideLayout1.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`,
      'utf8'
    )
  })

  entries.push({
    name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
      'utf8'
    )
  })

  entries.push({
    name: 'ppt/notesMasters/notesMaster1.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
</p:notesMaster>`,
      'utf8'
    )
  })

  entries.push({
    name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
      'utf8'
    )
  })

  slides.forEach((slide, i) => {
    const n = i + 1
    entries.push({
      name: `ppt/slides/slide${n}.xml`,
      data: Buffer.from(renderSlideXml(slide, i, slides.length, deck), 'utf8')
    })
    entries.push({
      name: `ppt/slides/_rels/slide${n}.xml.rels`,
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>
</Relationships>`,
        'utf8'
      )
    })
    entries.push({
      name: `ppt/notesSlides/notesSlide${n}.xml`,
      data: Buffer.from(renderNotesSlideXml(n, slide.speakerNotes), 'utf8')
    })
    entries.push({
      name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${n}.xml"/>
</Relationships>`,
        'utf8'
      )
    })
  })

  return createZipBuffer(entries)
}

function normalizeLayout(raw: unknown, index: number, total: number): AcademicSlideLayout {
  if (raw === 'cover' || raw === 'metrics' || raw === 'two-column' || raw === 'cards' || raw === 'closing') {
    return raw
  }
  if (index === 0) return 'cover'
  if (index === total - 1 && total >= 3) return 'closing'
  return 'cards'
}

/**
 * 解析模型返回的 JSON 演示文稿大纲；若模型输出含代码块或非严格 JSON 文本，安全提取或自动降级为结构化幻灯片，绝不报错中断导出。
 */
export function parseSlideDeckJson(rawText: string, fallbackTitle: string): AcademicSlideDeck {
  const safeFallbackTitle = clampText(fallbackTitle, 180) || '论文精读汇报'
  const trimmed = rawText.trim()
  const jsonMatch =
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ??
    (() => {
      const start = trimmed.indexOf('{')
      const end = trimmed.lastIndexOf('}')
      return start !== -1 && end > start ? trimmed.slice(start, end + 1) : ''
    })()

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch) as {
        deckTitle?: unknown
        subtitle?: unknown
        authors?: unknown
        slides?: unknown[]
      }
      if (parsed && Array.isArray(parsed.slides) && parsed.slides.length > 0) {
        const slidesInput = parsed.slides.slice(0, 20)
        const slides: AcademicSlideSpec[] = slidesInput.map((item, idx) => {
          const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
          const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim().slice(0, 180) : `第 ${idx + 1} 页`
          const subtitle = typeof obj.subtitle === 'string' && obj.subtitle.trim() ? obj.subtitle.trim().slice(0, 260) : undefined
          const layout = normalizeLayout(obj.layout, idx, slidesInput.length)
          const bullets = Array.isArray(obj.bullets)
            ? obj.bullets.filter((b): b is string => typeof b === 'string' && b.trim().length > 0).slice(0, 8)
            : undefined
          const metrics = Array.isArray(obj.metrics)
            ? obj.metrics
                .filter((m): m is Record<string, unknown> => Boolean(m && typeof m === 'object'))
                .map(m => ({
                  value: String(m.value ?? '').trim().slice(0, 64),
                  label: String(m.label ?? '').trim().slice(0, 120),
                  ...(typeof m.detail === 'string' && m.detail.trim() ? { detail: m.detail.trim().slice(0, 240) } : {})
                }))
                .filter(m => m.value && m.label)
                .slice(0, 6)
            : undefined
          const columns = Array.isArray(obj.columns)
            ? obj.columns
                .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
                .map(c => ({
                  heading: String(c.heading ?? '').trim().slice(0, 120),
                  points: Array.isArray(c.points)
                    ? c.points.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).slice(0, 8)
                    : []
                }))
                .filter(c => c.heading)
                .slice(0, 4)
            : undefined
          const takeaway = typeof obj.takeaway === 'string' && obj.takeaway.trim() ? obj.takeaway.trim().slice(0, 320) : undefined
          const speakerNotes =
            typeof obj.speakerNotes === 'string' && obj.speakerNotes.trim()
              ? obj.speakerNotes.trim().slice(0, 2000)
              : undefined
          return {
            title,
            ...(subtitle ? { subtitle } : {}),
            layout,
            ...(bullets && bullets.length > 0 ? { bullets } : {}),
            ...(metrics && metrics.length > 0 ? { metrics } : {}),
            ...(columns && columns.length > 0 ? { columns } : {}),
            ...(takeaway ? { takeaway } : {}),
            ...(speakerNotes ? { speakerNotes } : {})
          }
        })
        return {
          deckTitle:
            typeof parsed.deckTitle === 'string' && parsed.deckTitle.trim()
              ? parsed.deckTitle.trim().slice(0, 200)
              : safeFallbackTitle,
          ...(typeof parsed.subtitle === 'string' && parsed.subtitle.trim()
            ? { subtitle: parsed.subtitle.trim().slice(0, 280) }
            : {}),
          ...(typeof parsed.authors === 'string' && parsed.authors.trim()
            ? { authors: parsed.authors.trim().slice(0, 200) }
            : {}),
          theme: 'academic-navy',
          slides
        }
      }
    } catch {
      // JSON 解析失败时走 Markdown 段落自动拆页降级逻辑
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map(l => l.replace(/^[-*#\d.)\s]+/, '').trim())
    .filter(Boolean)

  const bodyChunks: string[][] = []
  for (let i = 0; i < lines.length; i += 4) {
    bodyChunks.push(lines.slice(i, i + 4))
  }

  const slides: AcademicSlideSpec[] = [
    {
      title: safeFallbackTitle,
      subtitle: 'Foliopair 论文汇报幻灯片大纲',
      layout: 'cover',
      bullets: bodyChunks[0]?.slice(0, 3) ?? ['论文精读与方法汇报']
    },
    ...(bodyChunks.length > 0
      ? bodyChunks.slice(0, 5).map((chunk, idx) => ({
          title: `核心内容解析 (${idx + 1})`,
          layout: 'cards' as const,
          bullets: chunk
        }))
      : [
          {
            title: '核心要点',
            layout: 'cards' as const,
            bullets: [clampText(trimmed, 240) || '请补充论文页文本内容后重新生成。']
          }
        ]),
    {
      title: '总结与讨论 (Q&A)',
      layout: 'closing',
      bullets: ['方法核心贡献回顾', '局限性与未来研究方向'],
      takeaway: '基于论文正文生成 · 导出后可在 PowerPoint / WPS 中继续微调图表'
    }
  ]

  return {
    deckTitle: safeFallbackTitle,
    theme: 'academic-navy',
    slides
  }
}

export function formatSlideDeckMarkdown(deck: AcademicSlideDeck): string {
  const parts: string[] = [`# ${deck.deckTitle}`]
  if (deck.subtitle) parts.push(`> ${deck.subtitle}`)
  if (deck.authors) parts.push(`*${deck.authors}*`)

  deck.slides.forEach((slide, idx) => {
    const layoutTag =
      slide.layout === 'cover'
        ? '封面'
        : slide.layout === 'metrics'
          ? '量化指标'
          : slide.layout === 'two-column'
            ? '双栏对比'
            : slide.layout === 'closing'
              ? '总结致谢'
              : '结构卡片'
    parts.push(`\n## 第 ${idx + 1} 页 · ${slide.title}（${layoutTag}）`)
    if (slide.subtitle) parts.push(`*${slide.subtitle}*`)
    if (slide.metrics && slide.metrics.length > 0) {
      parts.push(
        slide.metrics
          .map(m => `- **${m.value}** — ${m.label}${m.detail ? `（${m.detail}）` : ''}`)
          .join('\n')
      )
    }
    if (slide.columns && slide.columns.length > 0) {
      for (const col of slide.columns) {
        parts.push(`**${col.heading}**`)
        if (col.points.length > 0) {
          parts.push(col.points.map(pt => `- ${pt}`).join('\n'))
        }
      }
    }
    if (slide.bullets && slide.bullets.length > 0) {
      parts.push(slide.bullets.map(b => `- ${b}`).join('\n'))
    }
    if (slide.takeaway) {
      parts.push(`**核心结论**：${slide.takeaway}`)
    }
    if (slide.speakerNotes) {
      parts.push(`*演讲备注*：${slide.speakerNotes}`)
    }
  })

  return parts.join('\n\n')
}
