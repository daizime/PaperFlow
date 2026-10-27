import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const root = resolve('tests/fixtures')
const fixtureDate = new Date('2026-10-27T00:00:00.000Z')

function crc32(data: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of data) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ ((value & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

type Pixel = readonly [number, number, number]

/** Generates original PNG pixels rather than redistributing a photograph. */
function makePng(width: number, height: number, pixel: (x: number, y: number) => Pixel): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = pixel(x, y)
      const offset = y * (width * 3 + 1) + 1 + x * 3
      raw[offset] = color[0]
      raw[offset + 1] = color[1]
      raw[offset + 2] = color[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function configureMetadata(document: PDFDocument, title: string): void {
  document.setTitle(title)
  document.setAuthor('PaperFlow test fixtures')
  document.setSubject('Original synthetic test content; no real research claims')
  document.setCreator('PaperFlow fixture generator (pdf-lib)')
  document.setCreationDate(fixtureDate)
  document.setModificationDate(fixtureDate)
}

async function save(name: string, bytes: Uint8Array): Promise<void> {
  const path = resolve(root, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

async function createResearchPdf(variant: string): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  configureMetadata(document, `PaperFlow Research Fixture ${variant}`)
  const body = await document.embedFont(StandardFonts.TimesRoman)
  const heading = await document.embedFont(StandardFonts.HelveticaBold)
  const math = await document.embedFont(StandardFonts.TimesRomanItalic)
  const chartPng = makePng(240, 120, (x, y) => {
    if (x < 2 || y > 117) return [65, 83, 107]
    const bar = Math.floor(x / 40)
    if (x % 40 > 10 && x % 40 < 31 && y > 100 - bar * 13) return [56, 100, 181]
    return [244, 247, 252]
  })
  const chart = await document.embedPng(chartPng)
  const lines = [
    'This is original synthetic research text.',
    'The reader preserves selectable characters.',
    'Each page uses the same viewport for layers.',
    'Canvas displays figures and page graphics.',
    'Text selection should remain aligned at zoom.',
    'These sentences make no scientific claims.',
    'Local documents stay inside the local library.',
    'The fixture contains two independent columns.',
    'Scroll to explore all three generated pages.',
    'Page coordinates remain available for tools.',
    'Rapid navigation must cancel expired tasks.',
    'This paragraph is safe to redistribute.'
  ]
  for (let number = 1; number <= 3; number++) {
    const page = document.addPage([612, 792])
    page.drawText('PaperFlow Research Fixture', { x: 48, y: 742, size: 21, font: heading, color: rgb(0.15, 0.23, 0.37) })
    page.drawText(`Selectable text on page ${number} - Variant ${variant}`, { x: 48, y: 712, size: 14, font: body })
    page.drawLine({ start: { x: 48, y: 696 }, end: { x: 564, y: 696 }, thickness: 1, color: rgb(0.75, 0.8, 0.88) })
    for (let column = 0; column < 2; column++) {
      const x = column === 0 ? 48 : 318
      page.drawText(column === 0 ? '1. Synthetic methods' : '2. Synthetic observations', { x, y: 670, size: 13, font: heading })
      lines.forEach((line, index) => {
        page.drawText(line, { x, y: 646 - index * 18, size: 10.5, font: body })
      })
    }
    // A genuine vector formula with a separate superscript, not an image.
    page.drawText('E = mc', { x: 64, y: 352, size: 26, font: math })
    page.drawText('2', { x: 139, y: 364, size: 15, font: body })
    page.drawText('f(x) = x + 1', { x: 64, y: 313, size: 20, font: math })
    page.drawImage(chart, { x: 318, y: 280, width: 240, height: 120 })
    page.drawText('Figure 1. Original generated pixels.', { x: 318, y: 261, size: 9, font: body })
    page.drawRectangle({ x: 48, y: 105, width: 516, height: 110, borderWidth: 0.7, borderColor: rgb(0.75, 0.8, 0.88) })
    page.drawText('Rendering, selection, formula and image test area', { x: 64, y: 181, size: 13, font: heading })
    page.drawText('All text and graphics in this file were generated for PaperFlow tests.', { x: 64, y: 151, size: 11, font: body })
    page.drawText(`Page ${number} of 3`, { x: 270, y: 45, size: 11, font: body })
  }
  return document.save()
}

async function createImageOnlyPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  configureMetadata(document, 'PaperFlow image-only fixture')
  const pixels = makePng(400, 540, (x, y) => {
    if (x > 25 && x < 375 && y > 25 && y < 100) return [56, 100, 181]
    if (x > 35 && x < 365 && y > 140 && y < 360 && y % 24 < 8) return [85, 96, 113]
    if (x > 90 && x < 310 && y > 410 && y < 495) return [177, 201, 235]
    return [248, 249, 251]
  })
  const image = await document.embedPng(pixels)
  const page = document.addPage([612, 792])
  page.drawImage(image, { x: 56, y: 56, width: 500, height: 680 })
  return document.save()
}

async function main(): Promise<void> {
  const variantA = await createResearchPdf('A')
  await save('valid.pdf', variantA)
  await save('same-name-a/paper.pdf', variantA)
  await save('same-name-b/paper.pdf', await createResearchPdf('B'))
  await save('scanned.pdf', await createImageOnlyPdf())
  await save('corrupt.pdf', Buffer.from('%PDF-1.7\nThis file has no valid PDF objects or cross-reference table.\n%%EOF\n'))
  await save('invalid-header.pdf', Buffer.from('This is plain text, not a PDF document.\n'))
  console.log('Generated six original PaperFlow PDF fixtures in tests/fixtures.')
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
