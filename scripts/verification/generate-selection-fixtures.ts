import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

async function main(): Promise<void> {
const root = resolve('tests/fixtures/verification/selection')
const cache = resolve('.cache/reader/20261028-selection-01')
const document = await PDFDocument.create()
const date = new Date('2026-10-28T00:00:00Z')
document.setTitle('PaperFlow original blank-drag selection fixture')
document.setAuthor('PaperFlow synthetic verification fixtures')
document.setSubject('Original synthetic content; no scientific claims or copied paper')
document.setCreationDate(date)
document.setModificationDate(date)
const font = await document.embedFont(StandardFonts.Courier)
const width = 600
const height = 780
const definitions = [
  { id: 'heading', text: 'ORIGINAL SYNTHETIC SELECTION FIXTURE', x: 48, y: 744, size: 10 },
  { id: 'left-alpha', text: 'LEFT_ALPHA_TARGET_12345678', x: 48, y: 700, size: 14 },
  { id: 'right-alpha', text: 'RIGHT_ALPHA_OTHER_12345678', x: 300, y: 700, size: 14 },
  { id: 'left-beta', text: 'LEFT_BETA_OTHER_1234567890', x: 48, y: 676, size: 14 },
  { id: 'right-beta', text: 'RIGHT_BETA_OTHER_123456789', x: 300, y: 676, size: 14 },
  { id: 'left-gamma', text: 'LEFT_GAMMA_OTHER_123456789', x: 48, y: 652, size: 14 },
  { id: 'right-gamma', text: 'RIGHT_GAMMA_OTHER_12345678', x: 300, y: 652, size: 14 },
  { id: 'double-control', text: 'DOUBLECHECK', x: 48, y: 606, size: 18 },
  { id: 'reset-control', text: 'RESETWORD', x: 300, y: 606, size: 18 },
  { id: 'above-formula', text: 'ABOVE_FORMULA_OTHER', x: 72, y: 552, size: 10 },
  { id: 'formula-main', text: 'E=mc', x: 72, y: 520, size: 20 },
  { id: 'formula-super', text: '2', x: 120, y: 531, size: 12 },
  { id: 'formula-plus', text: '+a', x: 134, y: 520, size: 20 },
  { id: 'formula-sub', text: '1', x: 158, y: 514, size: 12 },
  { id: 'remote-formula', text: 'REMOTE_FORMULA_9', x: 324, y: 520, size: 14 },
  { id: 'below-formula', text: 'BELOW_FORMULA_OTHER', x: 72, y: 480, size: 10 },
  { id: 'numerator', text: 'a+b', x: 84, y: 422, size: 16 },
  { id: 'denominator', text: 'c+d', x: 84, y: 392, size: 16 },
  { id: 'remote-fraction', text: 'REMOTE_FRACTION_7', x: 324, y: 414, size: 12 },
  { id: 'fraction-below', text: 'FRACTION_BELOW_OTHER', x: 72, y: 360, size: 10 },
  { id: 'footer', text: 'Synthetic data. Vector fraction rule is not a slash character.', x: 48, y: 40, size: 8 }
]
const runs = definitions.map((run, index) => ({ ...run, drawOrder: index, width: font.widthOfTextAtSize(run.text, run.size), height: font.heightAtSize(run.size) }))
const pages = [0, 90].map((rotation, index) => ({ number: index + 1, rotation, view: [0, 0, width, height], userUnit: 1 }))
for (const specification of pages) {
  const page = document.addPage([width, height])
  page.setRotation(degrees(specification.rotation))
  for (const run of runs) page.drawText(run.text, { x: run.x, y: run.y, size: run.size, font, color: rgb(0, 0, 0) })
  page.drawLine({ start: { x: 80, y: 414 }, end: { x: 122, y: 414 }, thickness: 1 })
}
const left = runs.find(run => run.id === 'left-alpha')!
const right = runs.find(run => run.id === 'right-alpha')!
const control = runs.find(run => run.id === 'double-control')!
const reset = runs.find(run => run.id === 'reset-control')!
const fraction = runs.find(run => run.id === 'numerator')!
type Point = { x: number; y: number; space?: 'reader-gray' | 'left-gray' }
type Gesture = { id: string; group: string; description: string; points: Point[]; expected: string; mode?: 'double-click'; diagnosticOnly?: boolean; pages?: number[]; steps?: number }
const gestures: Gesture[] = [
  { id: 'blank-gutter', group: 'blank', description: '整段在栏间空白内起拖和结束，不经过任何字形', points: [{ x: 282, y: 706 }, { x: 282, y: 662 }], expected: '' },
  { id: 'blank-far', group: 'blank', description: '整段在右页边空白内，不应吸附远处正文或公式', points: [{ x: 554, y: 590 }, { x: 576, y: 565 }], expected: '' },
  { id: 'blank-reader-gray', group: 'blank', description: '阅读容器左侧灰底起拖，坐标在客户区内且不命中原生滚动条', points: [{ x: 8, y: 80, space: 'reader-gray' }, { x: 8, y: 190, space: 'reader-gray' }], expected: '' },
  { id: 'text-to-gutter', group: 'text', description: '左栏单行从首字符拖到栏间空白，不进入右栏字形', points: [{ x: left.x + 0.4, y: 705 }, { x: 282, y: 705 }], expected: left.text },
  { id: 'text-reverse-margin', group: 'text', description: '左栏单行从末字符反向拖到左页边空白', points: [{ x: left.x + left.width - 0.4, y: 705 }, { x: 24, y: 705 }], expected: left.text },
  { id: 'text-to-gap', group: 'text', description: '左栏单行末端拖入邻行之间空白，不进入下一行字形', points: [{ x: left.x + 0.4, y: 705 }, { x: left.x + left.width - 0.4, y: 694 }], expected: left.text },
  { id: 'text-return', group: 'text', description: '从目标拖至空白，再返回目标末字符后松开', points: [{ x: left.x + 0.4, y: 705 }, { x: 282, y: 705 }, { x: left.x + left.width - 0.4, y: 705 }], expected: left.text },
  { id: 'right-to-margin', group: 'text', description: '右栏目标拖到右页边空白，不跨过另一栏', points: [{ x: right.x + 0.4, y: 705 }, { x: 550, y: 705 }], expected: right.text },
  { id: 'text-to-reader-gray', group: 'text', description: '正向页面从独立控制词末端反拖出白页至灰底，不经过另一栏', points: [{ x: control.x + control.width - 0.4, y: 612 }, { x: 8, y: 0, space: 'left-gray' }], expected: control.text, pages: [1] },
  { id: 'formula-to-blank', group: 'formula', description: '独立公式首字符经下标末端拖到右侧空白', points: [{ x: 72.4, y: 526 }, { x: 164.8, y: 518 }, { x: 224, y: 518 }], expected: 'E=mc2+a1' },
  { id: 'formula-single-step', group: 'formula', description: '真实单步快速拖拽：从公式首span直接移动到公式后空白，不能只保留首TextItem', points: [{ x: 72.4, y: 526 }, { x: 224, y: 518 }], expected: 'E=mc2+a1', steps: 1 },
  { id: 'formula-reverse', group: 'formula', description: '公式下标末端反向返回左页边空白', points: [{ x: 164.8, y: 518 }, { x: 72.4, y: 526 }, { x: 54, y: 526 }], expected: 'E=mc2+a1' },
  { id: 'formula-return', group: 'formula', description: '公式拖入空白再返回下标，不应跳选另一公式', points: [{ x: 72.4, y: 526 }, { x: 224, y: 518 }, { x: 164.8, y: 518 }], expected: 'E=mc2+a1' },
  { id: 'numerator-to-blank', group: 'fraction', description: '分子拖入本行空白，矢量分数线不是文本字符', points: [{ x: 84.4, y: 427 }, { x: 164, y: 427 }], expected: 'a+b' },
  { id: 'denominator-reverse', group: 'fraction', description: '分母末端反向拖至左侧空白，不跳至分子/远处公式', points: [{ x: fraction.x + fraction.width - 0.4, y: 397 }, { x: 64, y: 397 }], expected: 'c+d' },
  { id: 'whole-fraction', group: 'fraction', description: '分子首字到分母末字；仅断言已有字符序列，不要求LaTex或斜线', points: [{ x: 84.4, y: 427 }, { x: fraction.x + fraction.width - 0.4, y: 397 }], expected: 'a+bc+d' },
  { id: 'recovery-setup', group: 'recovery', description: '先执行空白拖拽，只记录其结果，继续测试mouseup后的原生选择', points: [{ x: 282, y: 706 }, { x: 282, y: 662 }], expected: '', diagnosticOnly: true },
  { id: 'normal-after-mouseup', group: 'recovery', description: '不清空DOM Selection，mouseup后再次普通拖选独立控制词', points: [{ x: control.x + 0.4, y: 612 }, { x: control.x + control.width - 0.4, y: 612 }], expected: control.text },
  { id: 'double-click-after-mouseup', group: 'recovery', description: 'mouseup后双击另一独立控制词并真实复制', points: [{ x: reset.x + reset.width / 2, y: 612 }], expected: reset.text, mode: 'double-click' }
]
await mkdir(root, { recursive: true })
await mkdir(cache, { recursive: true })
const bytes = await document.save()
const pdfName = 'blank-drag-columns-formulas.pdf'
await writeFile(resolve(root, pdfName), bytes)
const task = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/', useSystemFonts: false })
const extracted = []
try {
  const pdf = await task.promise
  if (pdf.numPages !== 2) throw new Error('Unexpected fixture page count')
  for (const specification of pages) {
    const page = await pdf.getPage(specification.number)
    if (page.rotate !== specification.rotation) throw new Error('Unexpected fixture rotation')
    const content = await page.getTextContent({ includeMarkedContent: true })
    extracted.push({ pageNumber: specification.number, rotation: page.rotate, viewport: { width: page.getViewport({ scale: 1 }).width, height: page.getViewport({ scale: 1 }).height }, items: content.items.map((item, index) => 'str' in item ? { index, str: item.str, transform: item.transform, width: item.width, height: item.height, fontName: item.fontName, hasEOL: item.hasEOL } : { index, markedContent: true }) })
  }
} finally { await task.destroy() }
const sourceFiles = ['node_modules/pdfjs-dist/web/pdf_viewer.mjs', 'node_modules/pdfjs-dist/web/pdf_viewer.css', 'node_modules/pdfjs-dist/build/pdf.mjs']
const references = await Promise.all(sourceFiles.map(async file => ({ file, version: '6.4.299', license: 'Apache-2.0', sha256: createHash('sha256').update(await readFile(resolve(file))).digest('hex') })))
const manifest = {
  schemaVersion: 1, source: '原创合成测试文字、矢量图形与PDF，未复制论文/外部PDF/字体文件。', license: 'AGPL-3.0-only（同项目）',
  generator: 'scripts/verification/generate-selection-fixtures.ts', dependencies: { 'pdf-lib': '1.17.1', 'pdfjs-dist': '6.4.299' },
  file: { name: pdfName, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  pages, font: 'Standard 14 Courier（引用标准字体名称）', runs, gestures,
  policy: ['仅空白路径不应吸附远处字符。', '文字/独立公式拖入未经过其他字形的空白，不应跳选另一栏/另一公式。', '字符串只规范化空白，不删除干扰字符；公式只要求已有字符序列，不承诺LaTex。', '左右同基线按L1,R1,L2,R2交错绘制；跨多行原始流顺序单独记录，本轮不重排整页阅读顺序。'],
  extraction: extracted, localUpstreamReferences: references
}
await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(resolve(cache, 'fixture-audit.json'), JSON.stringify({ file: manifest.file, pages: extracted, references }, null, 2) + '\n')
console.log(JSON.stringify({ file: manifest.file, pages: pages.length, gestures: gestures.length }, null, 2))
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
