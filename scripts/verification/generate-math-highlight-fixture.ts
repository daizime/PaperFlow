import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

interface Point { x: number; y: number }
interface Rect extends Point { width: number; height: number }
interface Part {
  id: string; text: string; font: string; x: number; y: number; size: number; width: number
  role: 'body' | 'operator' | 'subscript' | 'superscript'
}
const fixtureRoot = resolve('tests/fixtures/verification/math-highlight')
const auditRoot = resolve('.cache/reader/20261122-math-highlight-reader-01/generator')
const generator = 'scripts/verification/generate-math-highlight-fixture.ts'
const pdfName = 'math-selection-continuity.pdf'
const fixedDate = '2026-11-22T00:00:00.000Z'
const round = (value: number): number => Number(value.toFixed(6))
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const withoutWhitespace = (text: string): string => text.replace(/\s+/gu, '')
// Plain Tj has no pair kerning; sum individual advances, then audit with PDF.js.
const advance = (font: PDFFont, text: string, size: number): number => round([...text].reduce((sum, character) => sum + font.widthOfTextAtSize(character, size), 0))
const auditJson = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => typeof entry === 'number' && !Number.isFinite(entry) ? String(entry) : entry, 2) + '\n'

async function main(): Promise<void> {
  const document = await PDFDocument.create({ updateMetadata: false })
  document.setTitle('PaperFlow original synthetic math selection continuity fixture')
  document.setAuthor('PaperFlow synthetic verification fixtures')
  document.setSubject('Original synthetic characters, no copied paper or scientific claim. Selection continuity only.')
  document.setCreator('PaperFlow deterministic fixture generator')
  document.setProducer('pdf-lib 1.17.1 / PaperFlow synthetic fixture')
  document.setCreationDate(new Date(fixedDate))
  document.setModificationDate(new Date(fixedDate))
  const roman = await document.embedFont(StandardFonts.TimesRoman)
  const symbol = await document.embedFont(StandardFonts.Symbol)
  const fonts = new Map([['Times-Roman', roman], ['Symbol', symbol]])
  const symbolCandidates = ['⊕', '⊗', '⊙']
  const operatorText = symbolCandidates.find(character => { try { symbol.encodeText(character); return true } catch { return false } })
  if (!operatorText) throw new Error('Standard Symbol cannot encode any declared synthetic operator')
  const makePart = (id: string, text: string, font: string, x: number, y: number, size: number, role: Part['role']): Part => ({ id, text, font, x: round(x), y, size, width: advance(fonts.get(font)!, text, size), role })
  const first = makePart('formula-p', 'p', 'Times-Roman', 64, 510, 18, 'body')
  const subscript = makePart('formula-sub-i', 'i', 'Times-Roman', first.x + first.width + 0.5, 503, 12, 'subscript')
  const operator = makePart('formula-op', operatorText, 'Symbol', subscript.x + subscript.width + 6, 492, 72, 'operator')
  const next = makePart('formula-q', 'q', 'Times-Roman', operator.x + operator.width + 6, 510, 18, 'body')
  const superscript = makePart('formula-super-two', '2', 'Times-Roman', next.x + next.width + 0.5, 522, 12, 'superscript')
  const tail = makePart('formula-tail', ' = r', 'Times-Roman', superscript.x + superscript.width + 6, 510, 18, 'body')
  const lower = makePart('selected-lower-body', 'Selected lower row keeps these symbols together.', 'Times-Roman', 64, 480, 18, 'body')
  const formulaParts = [first, subscript, operator, next, superscript, tail]
  const parts = [...formulaParts, lower]
  const excludedRuns = [
    makePart('unselected-title', 'ORIGINAL SYNTHETIC MATH SELECTION', 'Times-Roman', 48, 744, 11, 'body'),
    makePart('unselected-body', 'Synthetic text: two selected rows, one large operator, real small scripts.', 'Times-Roman', 48, 692, 12, 'body'),
    makePart('remote-sentinel', 'UNSELECTED_REMOTE_SENTINEL_SYNTHETIC_06', 'Times-Roman', 48, 300, 12, 'body')
  ]
  const drawOrder = [excludedRuns[0], excludedRuns[1], ...parts, excludedRuns[2]]
  const page = document.addPage([600, 780])
  for (const part of drawOrder) {
    if (part.x < 0 || part.x + part.width > 600 || part.y < 0 || part.y + part.size > 780) throw new Error(`Synthetic run is outside page: ${part.id}`)
    page.drawText(part.text, { x: part.x, y: part.y, size: part.size, font: fonts.get(part.font)!, color: rgb(0, 0, 0) })
  }
  const bytes = await document.save({ useObjectStreams: false })
  const file = { name: pdfName, bytes: bytes.length, sha256: sha256(bytes) }
  const pages = [{ number: 1, width: 600, height: 780, rotation: 0, view: [0, 0, 600, 780], userUnit: 1 }]
  const task = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/', useSystemFonts: false })
  let rawContent: unknown
  let formulaExtracted = ''
  let lowerExtracted = ''
  const matchedItems: { partId: string; itemIndex: number; str: string; width: number; height: number }[] = []
  try {
    const pdf = await task.promise
    if (pdf.numPages !== 1) throw new Error('Unexpected synthetic page count')
    const actualPage = await pdf.getPage(1)
    const viewport = actualPage.getViewport({ scale: 1 })
    if (viewport.width !== 600 || viewport.height !== 780 || actualPage.rotate !== 0 || actualPage.userUnit !== 1 || actualPage.view.some((value, index) => value !== pages[0].view[index])) throw new Error('Unexpected synthetic page geometry')
    const content = await actualPage.getTextContent({ includeMarkedContent: true })
    let expectedIndex = 0
    let formulaActive = false
    for (let itemIndex = 0; itemIndex < content.items.length; itemIndex++) {
      const item = content.items[itemIndex]
      if (!('str' in item)) continue
      if (!item.str.trim()) { if (formulaActive) formulaExtracted += item.str; continue }
      const expected = drawOrder[expectedIndex++]
      // PDF.js may separate leading spaces from a nonempty Tj item. Audit the
      // exact copy characters/order here and retain raw geometry for inspection.
      if (!expected || withoutWhitespace(item.str) !== withoutWhitespace(expected.text) || Math.abs(item.height - expected.size) > 0.001 || Math.abs(item.transform[5] - expected.y) > 0.001) throw new Error(`PDF.js item differs from authored part: ${expected?.id ?? itemIndex}`)
      matchedItems.push({ partId: expected.id, itemIndex, str: item.str, width: item.width, height: item.height })
      if (formulaParts.some(part => part.id === expected.id)) { formulaActive = true; formulaExtracted += item.str }
      else if (expected.id === lower.id) { formulaActive = false; lowerExtracted = item.str }
    }
    if (expectedIndex !== drawOrder.length || withoutWhitespace(formulaExtracted) !== withoutWhitespace(formulaParts.map(part => part.text).join('')) || lowerExtracted !== lower.text) throw new Error('Synthetic copy character/order audit failed')
    rawContent = { pageNumber: 1, view: actualPage.view, rotation: actualPage.rotate, userUnit: actualPage.userUnit, viewport: { width: viewport.width, height: viewport.height }, content, matchedItems }
  } finally { await task.destroy() }
  const formulaText = formulaExtracted.replace(/\s+/gu, ' ').trim()
  const formulaStart = { x: round(first.x + 0.4), y: first.y + 6 }
  const formulaEnd = { x: round(tail.x + tail.width - 0.4), y: tail.y + 6 }
  const selectedRows = [
    { id: 'selected-formula-row', text: formulaText, partIds: formulaParts.map(part => part.id), role: 'formula' },
    { id: 'selected-body-row', text: lowerExtracted, partIds: [lower.id], role: 'body' }
  ]
  const bridgeCandidates: { id: string; kind: 'horizontal' | 'vertical'; sourcePartIds: string[]; sourceRowIds: string[]; pdfWindow: Rect }[] = [
    { id: 'subscript-to-operator', kind: 'horizontal', sourcePartIds: [subscript.id, operator.id], sourceRowIds: ['selected-formula-row'], pdfWindow: { x: round(subscript.x + subscript.width + 1), y: 506, width: 4, height: 4 } },
    { id: 'operator-to-body', kind: 'horizontal', sourcePartIds: [operator.id, next.id], sourceRowIds: ['selected-formula-row'], pdfWindow: { x: round(operator.x + operator.width + 1), y: 514, width: 4, height: 5 } },
    { id: 'superscript-to-tail', kind: 'horizontal', sourcePartIds: [superscript.id, tail.id], sourceRowIds: ['selected-formula-row'], pdfWindow: { x: round(superscript.x + superscript.width + 1), y: 519, width: 4, height: 3 } },
    // Only the ordinary tail's horizontal range: the large operator is elsewhere.
    { id: 'tail-to-lower-row', kind: 'vertical', sourcePartIds: [tail.id, lower.id], sourceRowIds: ['selected-formula-row', 'selected-body-row'], pdfWindow: { x: round(tail.x + 5), y: 495, width: 15, height: 9 } }
  ]
  const guardWindows = [
    { id: 'after-formula-end', pdfWindow: { x: round(tail.x + tail.width + 12), y: 513, width: 18, height: 5 }, reason: '公式选中末尾之外的同基线空白，不得延长' },
    { id: 'wide-column-gap', pdfWindow: { x: 460, y: 492, width: 64, height: 28 }, reason: '远离两行选中字符的宽栏缝，不得连接' },
    { id: 'paragraph-gap-below', pdfWindow: { x: 90, y: 430, width: 230, height: 12 }, reason: '第二行下方独立段落间空白，不得连接到远处哨兵' }
  ]
  const references = await Promise.all([
    { path: 'node_modules/pdf-lib/es/core/embedders/StandardFontEmbedder.js', version: '1.17.1', license: 'MIT' },
    { path: 'node_modules/pdfjs-dist/legacy/build/pdf.mjs', version: '6.4.299', license: 'Apache-2.0' }
  ].map(async reference => ({ ...reference, sha256: sha256(await readFile(resolve(reference.path))) })))
  const manifest = {
    schemaVersion: 1, source: 'PaperFlow 原创合成文字、字符组合与 PDF；不复制论文、截图正文或用户文献；公式无数学事实或 LaTeX 主张。',
    license: 'AGPL-3.0-only（同项目；依赖许可单列）', generator, fixedMetadataDate: fixedDate, file, pages, parts,
    formula: { pageNumber: 1, start: formulaStart, end: formulaEnd, expectedText: formulaText, operatorId: operator.id, bodyIds: [first.id, next.id, tail.id], operatorProbe: { x: operator.x, y: 470, width: operator.width, height: 94 } },
    selectedRows,
    selection: { pageNumber: 1, start: formulaStart, end: { x: round(lower.x + lower.width - 0.4), y: lower.y + 6 }, expectedText: selectedRows.map(row => row.text).join('\n'), expectedLines: selectedRows.map(row => row.text), normalization: 'remove-whitespace-only' },
    bridgeCandidates, guardWindows, reference: { bodyPartIds: [tail.id, lower.id], bodyRowIds: ['selected-body-row'] }, excludedRuns,
    font: { names: ['Times-Roman', 'Symbol'], standard: 'PDF Standard 14 font-name references; no font files copied or embedded', requestedOperator: '⊕', chosenOperator: operatorText, fallbackUsed: operatorText !== symbolCandidates[0], operatorSize: 72 },
    coordinates: { space: 'PDF default user space, lower-left origin, x right, y up', widthMethod: 'Sum of individual glyph advances, audited against Node PDF.js; no AFM pair kerning in plain Tj', pointMethod: 'fixed authored first character x+0.4 and last character x+width−0.4; body baseline+6; never aimed from TextLayer', bridgePolicy: 'Candidate windows only: require real selected source parts, before-white pixels and measured Range geometry. Never treat real scripts as blank. Vertical window uses ordinary tail x only, not the large-operator row envelope.' },
    extraction: { file: 'raw-extraction.json', tool: 'Node PDF.js 6.4.299', result: 'passed exact non-whitespace characters/order, font size/baseline and page geometry; raw widths/x retained, leading Tj spaces may form separate items; expectedText taken from actual extraction with whitespace collapsed', serialization: 'Nonfinite numeric extraction values are recorded as strings NaN/Infinity, not silently null.' },
    localReferences: references,
    verificationBoundary: { executed: ['生成一页原创合成 PDF', 'Node PDF.js 实际提取及制作参数核对'], notExecuted: ['Electron/真实鼠标选择和剪贴板', '浏览器 Range 实测', '蓝框连接像素与 guard 白底实测', '用户原文档验证'] }
  }
  const readme = [
    '# 公式选区连续性合成素材', '',
    '本目录为 PFV-READER-006 阶段 A 原创合成素材，不复制论文、截图正文或用户文献。英文和公式字符仅供测试，无科学事实或 LaTeX 主张。', '',
    '## 内容和制作坐标', '',
    '- 单页 600 × 780、0°、UserUnit 1。独立未选标题和说明在选中两行之前；远哨兵在两行之后绘制，避免合法 DOM 区间误夹哨兵。',
    '- 第一行正文 Times-Roman 18 pt，真实下标 i 和上标 2 为 12 pt；大运算符优先 Symbol 的 U+2295 circled-plus，72 pt。字体仅引用 Standard 14 名称，不复制或嵌入字体文件。',
    '- 公式依制作顺序排列 p、下标 i、运算符、q、上标 2、尾部 = r；相邻组按逐字符 advance 串排并保留 6 PDF 单位短空白。第二行基线为 480，比公式普通正文 510 低 30。',
    '- `manifest.json` 的 parts、selectedRows、selection 给出实际提取字符、制作坐标与完整两行预期。固定端点使用首字 x+0.4、末字 x+width−0.4、正文 baseline+6；不得从 TextLayer 包围框反向瞄点或为测试结果移动点。',
    '- bridgeCandidates 是短横向间隙和普通 tail 与下一行共用 X 范围的竖缝候选窗；不得用大运算符整行 envelope 推断没有竖缝。真实上下标始终是选中字符，不是待覆盖空白。operatorProbe 仅作局部记录，不作为裁掉上凸蓝块的通过判据。',
    '- guardWindows 保留公式末尾外、远处宽栏缝和第二行下方段落空白；所有连接仍须由实际选区、Range 和选前白底证明，不能只凭 manifest 判通过。', '',
    '## 再生及实际审计', '', '```powershell', `pnpm exec tsx ${generator}`, '```', '',
    `PDF 元数据日期固定为 ${fixedDate}，无随机量。普通 Tj 不含 AFM pair kerning，行宽逐字相加并与 PDF.js 实际提取核对。`,
    '`raw-extraction.json` 保存实际 Node PDF.js 原始 item/styles 和制作 part 映射；NaN/Infinity 数值显式写为字符串。expectedText 来自实际提取，仅统一空白；E2E 的 remove-whitespace-only 只可忽略空白，不可删除或替换非空白字符。', '',
    '## 验证边界', '',
    '**已真实执行**：生成及 Node PDF.js 非空白字符/顺序、基线、字号、页几何审计；宽度和 X 原样保留（前导空格可能拆成单独 item），不声称每个 item 与整段 advance 等宽。**待 QA**：真实鼠标跨两行选择、Ctrl+C、原生 Range、连接 ROI 和 guard 像素。Poppler 静态预览只能检查 PDF 本身，不显示浏览器 Selection，不证明产品蓝框连接已通过。用户原 PDF 未读取或验证。', ''
  ].join('\n')
  await mkdir(fixtureRoot, { recursive: true })
  await mkdir(auditRoot, { recursive: true })
  await writeFile(resolve(fixtureRoot, pdfName), bytes)
  await writeFile(resolve(fixtureRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(resolve(fixtureRoot, 'raw-extraction.json'), auditJson({ file, page: rawContent, formulaExtracted, lowerExtracted }))
  await writeFile(resolve(fixtureRoot, 'README.md'), readme)
  await writeFile(resolve(auditRoot, 'generation-audit.json'), auditJson({ generatedAt: new Date().toISOString(), node: process.version, file, authoredDrawOrder: drawOrder, matchedItems, references, boundary: manifest.verificationBoundary }))
  console.log(JSON.stringify({ file, chosenOperator: operatorText, formula: manifest.formula, selection: manifest.selection, bridgeCandidates, guardWindows, audit: manifest.extraction.result }, null, 2))
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
