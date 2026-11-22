import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb } from 'pdf-lib'

const root = resolve('tests/fixtures/verification/reader')
const date = new Date('2026-10-27T00:00:00.000Z')
export const LONG_PAGE_COUNT = 600
export const USER_PASSWORD = 'paperflow-reader-test'
export const OWNER_PASSWORD = 'paperflow-owner-test'
const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')
const md5 = (bytes: Uint8Array): Buffer => createHash('md5').update(bytes).digest()
const padPassword = (password: string): Buffer => Buffer.concat([Buffer.from(password, 'ascii'), padding]).subarray(0, 32)

/** Original RC4 implementation, used only for an interoperable legacy test fixture. */
function rc4(key: Uint8Array, input: Uint8Array): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 255
    ;[state[i], state[j]] = [state[j], state[i]]
  }
  const output = Buffer.alloc(input.length)
  let i = 0
  j = 0
  for (let offset = 0; offset < input.length; offset++) {
    i = (i + 1) & 255
    j = (j + state[i]) & 255
    ;[state[i], state[j]] = [state[j], state[i]]
    output[offset] = input[offset] ^ state[(state[i] + state[j]) & 255]
  }
  return output
}

/** PDF Reference 1.4 §3.5, algorithms 3.1–3.4; actual /V 1 /R 2 encryption. */
function encryptedPdf(): Uint8Array {
  const id = md5(Buffer.from('PaperFlow original encrypted fixture v1'))
  const owner = rc4(md5(padPassword(OWNER_PASSWORD)).subarray(0, 5), padPassword(USER_PASSWORD))
  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-4)
  const key = md5(Buffer.concat([padPassword(USER_PASSWORD), owner, permissions, id])).subarray(0, 5)
  const user = rc4(key, padding)
  // Content stream is object 4, generation 0. All strings in the stream are encrypted.
  const objectId = Buffer.from([4, 0, 0, 0, 0])
  const objectKey = md5(Buffer.concat([key, objectId])).subarray(0, 10)
  const stream = rc4(objectKey, Buffer.from('BT /F1 18 Tf 48 720 Td (PaperFlow encrypted original text) Tj ET\n', 'ascii'))
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.concat([Buffer.from('<< /Length ' + stream.length + ' >>\nstream\n'), stream, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.from('<< /Filter /Standard /V 1 /R 2 /O <' + owner.toString('hex') + '> /U <' + user.toString('hex') + '> /P -4 >>')
  ]
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = [0]
  let position = chunks[0].length
  objects.forEach((body, index) => {
    offsets.push(position)
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')])
    chunks.push(object)
    position += object.length
  })
  const xref = 'xref\n0 7\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  chunks.push(Buffer.from(xref + 'trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<' + id.toString('hex') + '><' + id.toString('hex') + '>] >>\nstartxref\n' + position + '\n%%EOF\n'))
  return Buffer.concat(chunks)
}

async function documentWithFont(title: string) {
  const document = await PDFDocument.create()
  document.setTitle(title)
  document.setAuthor('PaperFlow original verification fixtures')
  document.setSubject('Synthetic test content; no scientific claims')
  document.setCreator('PaperFlow TypeScript verification generator')
  document.setCreationDate(date)
  document.setModificationDate(date)
  const font = await document.embedFont(StandardFonts.Helvetica)
  return { document, font }
}

async function geometryPdf() {
  const { document, font } = await documentWithFont('PaperFlow geometry verification')
  const pages = []
  for (const userUnit of [1, 2.5]) {
    for (const cropped of [false, true]) {
      for (const rotation of [0, 90, 180, 270]) {
        const page = document.addPage([612, 792])
        const crop = cropped ? { x: 23, y: 37, width: 500, height: 700 } : { x: 0, y: 0, width: 612, height: 792 }
        page.setCropBox(crop.x, crop.y, crop.width, crop.height)
        page.setRotation(degrees(rotation))
        page.node.set(PDFName.of('UserUnit'), PDFNumber.of(userUnit))
        const number: number = pages.length + 1
        page.drawRectangle({ x: crop.x + 24, y: crop.y + 24, width: crop.width - 48, height: crop.height - 48, borderWidth: 1, borderColor: rgb(0, 0, 0) })
        page.drawText('Geometry marker ' + number, { x: crop.x + 48, y: crop.y + crop.height - 80, size: 16, font })
        page.drawText('Original text: viewport, crop, rotation, unit.', { x: crop.x + 48, y: crop.y + crop.height - 110, size: 11, font })
        pages.push({ number, rotation, userUnit, view: [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height] })
      }
    }
  }
  return { bytes: await document.save(), pages }
}

async function longPdf(): Promise<Uint8Array> {
  const { document, font } = await documentWithFont('PaperFlow 600-page synthetic document')
  for (let number = 1; number <= LONG_PAGE_COUNT; number++) {
    const page = document.addPage([612, 792])
    page.drawText('Long document page ' + number + ' of ' + LONG_PAGE_COUNT, { x: 48, y: 720, size: 18, font })
    page.drawText('Original synthetic text for lazy rendering and navigation.', { x: 48, y: 680, size: 12, font })
    page.drawRectangle({ x: 48, y: 100, width: 516, height: 540, borderWidth: 1 })
  }
  return document.save()
}

async function main(): Promise<void> {
  await mkdir(root, { recursive: true })
  const geometry = await geometryPdf()
  const files = [
    { name: 'encrypted-r2.pdf', bytes: encryptedPdf(), pages: 1 },
    { name: 'geometry.pdf', bytes: geometry.bytes, pages: geometry.pages.length },
    { name: 'long-600.pdf', bytes: await longPdf(), pages: LONG_PAGE_COUNT }
  ]
  for (const file of files) await writeFile(resolve(root, file.name), file.bytes)
  const manifest = {
    schemaVersion: 1, source: 'Original TypeScript-generated content; no external PDF or copied prose',
    license: 'AGPL-3.0-only (same as project)', generator: 'scripts/verification/generate-reader-fixtures.ts',
    dependencies: { 'pdf-lib': '1.17.1' },
    algorithmReference: { url: 'https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.4.pdf', section: '3.5, algorithms 3.1–3.4', license: 'Adobe copyright; no redistribution license verified; reference only', sha256: 'unverified: browsed specification, no external document downloaded or redistributed' },
    passwords: { user: USER_PASSWORD, owner: OWNER_PASSWORD },
    geometry: geometry.pages,
    files: files.map(file => ({ name: file.name, bytes: file.bytes.length, pages: file.pages, sha256: createHash('sha256').update(file.bytes).digest('hex') }))
  }
  await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest.files, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
}
