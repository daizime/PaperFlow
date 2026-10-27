import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
// 自行绘制书页图标，无外部图像素材。
const size = 256
function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type)
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([len, name, data, crc])
}
const pixels = Buffer.alloc((size * 4 + 1) * size)
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const offset = y * (size * 4 + 1) + 1 + x * 4
    const book = x >= 53 && x <= 200 && y >= 35 && y <= 219
    const spine = x >= 53 && x < 70 && book
    const fold = x > 165 && y < 70 && x - 165 > y - 35
    const line = x >= 88 && x < 170 && (y >= 100 && y < 110 || y >= 128 && y < 138 || y >= 156 && y < 166)
    const color = !book || fold ? [0,0,0,0] : line ? [225,236,255,255] : spine ? [37,73,139,255] : [56,100,181,255]
    for (let c = 0; c < 4; c++) pixels[offset + c] = color[c]
  }
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(size,0); ihdr.writeUInt32BE(size,4); ihdr[8]=8; ihdr[9]=6
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
mkdirSync('resources', { recursive: true }); mkdirSync('build', { recursive: true })
writeFileSync('resources/icon.png', png); writeFileSync('build/icon.png', png)
const header = Buffer.alloc(22)
header.writeUInt16LE(1,2); header.writeUInt16LE(1,4)
header.writeUInt16LE(1,10); header.writeUInt16LE(32,12)
header.writeUInt32LE(png.length,14); header.writeUInt32LE(22,18)
writeFileSync('build/icon.ico', Buffer.concat([header,png]))
