import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  clientPointToPdf, pdfPointToViewport, pdfRectToViewport, viewportPointToPdf, viewportRectToPdf,
  type PageGeometry, type PagePoint
} from '../../src/renderer/src/features/reader/pdf-geometry'
import manifest from '../fixtures/verification/reader/manifest.json'

const fixtureRoot = resolve('tests/fixtures/verification/reader')
const options = { standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/', useSystemFonts: false, stopAtErrors: true }
const scales = [0.5, 0.75, 1, 1.33, 2, 2.75, 3]
const outputScales = [1, 1.25, 2, 3]
let pdf: PDFDocumentProxy
let geometryTask: ReturnType<typeof getDocument>
const metrics = { viewportCases: 0, pointComparisons: 0, rectComparisons: 0, maxPointError: 0, maxRectError: 0, longOperatorListMs: 0, longPages: 0 }

function checkPoint(actual: PagePoint, expected: PagePoint): void {
  const error = Math.max(Math.abs(actual.x - expected.x), Math.abs(actual.y - expected.y))
  metrics.pointComparisons++
  metrics.maxPointError = Math.max(metrics.maxPointError, error)
  expect(error).toBeLessThan(1e-9)
}

beforeAll(async () => {
  geometryTask = getDocument({ ...options, data: new Uint8Array(await readFile(resolve(fixtureRoot, 'geometry.pdf'))) })
  pdf = await geometryTask.promise
})
afterAll(async () => {
  await geometryTask?.destroy()
  await mkdir(resolve('.cache/reader'), { recursive: true })
  await writeFile(resolve('.cache/reader/geometry-metrics.json'), JSON.stringify(metrics, null, 2) + '\n')
})

describe('actual PDF.js PageViewport and production geometry helpers', () => {
  for (const specification of manifest.geometry) {
    test(`page ${specification.number}: rotation ${specification.rotation}, UserUnit ${specification.userUnit}, crop ${specification.view.join(',')}`, async () => {
      const page = await pdf.getPage(specification.number)
      expect(page.rotate).toBe(specification.rotation)
      expect(page.userUnit).toBe(specification.userUnit)
      expect(page.view).toEqual(specification.view)
      const [x0, y0, x1, y1] = specification.view
      const points = [{ x: x0, y: y0 }, { x: x1, y: y1 }, { x: x0 + 17.125, y: y0 + 29.875 }, { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }]
      for (const scale of scales) {
        const viewport = page.getViewport({ scale })
        const factor = scale * specification.userUnit
        const width = (x1 - x0) * factor
        const height = (y1 - y0) * factor
        const sideways = specification.rotation % 180 !== 0
        expect(viewport.width).toBeCloseTo(sideways ? height : width, 10)
        expect(viewport.height).toBeCloseTo(sideways ? width : height, 10)
        for (const outputScale of outputScales) {
          const geometry: PageGeometry = { pageNumber: specification.number, viewport, outputScale: { x: outputScale, y: outputScale + 0.125 } }
          metrics.viewportCases++
          for (const point of points) {
            const u = (point.x - x0) * factor
            const v = (point.y - y0) * factor
            // Independent known-angle expectations catch matching forward/inverse mistakes.
            const expected = specification.rotation === 0 ? { x: u, y: height - v }
              : specification.rotation === 90 ? { x: v, y: u }
                : specification.rotation === 180 ? { x: width - u, y: v } : { x: height - v, y: width - u }
            const mapped = pdfPointToViewport(geometry, point)
            checkPoint(mapped, expected)
            checkPoint(viewportPointToPdf(geometry, mapped), point)
            const bounds = { left: 113.25, top: 79.5, width: viewport.width * 0.8, height: viewport.height * 1.1 } as DOMRectReadOnly
            checkPoint(clientPointToPdf(geometry, bounds, { x: bounds.left + mapped.x * 0.8, y: bounds.top + mapped.y * 1.1 }), point)
          }
          const rect = { x: x0 + 13.125, y: y0 + 19.875, width: 123.456, height: 89.123 }
          const mapped = pdfRectToViewport(geometry, rect)
          expect(mapped.width).toBeCloseTo((sideways ? rect.height : rect.width) * factor, 10)
          expect(mapped.height).toBeCloseTo((sideways ? rect.width : rect.height) * factor, 10)
          const restored = viewportRectToPdf(geometry, mapped)
          const error = Math.max(...Object.keys(rect).map(key => Math.abs(restored[key as keyof typeof rect] - rect[key as keyof typeof rect])))
          metrics.rectComparisons++
          metrics.maxRectError = Math.max(metrics.maxRectError, error)
          expect(error).toBeLessThan(1e-9)
        }
      }
      page.cleanup()
    })
  }
  test('unlaid-out client bounds fail explicitly', async () => {
    const viewport = (await pdf.getPage(1)).getViewport({ scale: 1 })
    const geometry: PageGeometry = { pageNumber: 1, viewport, outputScale: { x: 1, y: 1 } }
    expect(() => clientPointToPdf(geometry, { width: 0, height: 100 } as DOMRectReadOnly, { x: 1, y: 1 })).toThrow('尚未布局')
    expect(() => clientPointToPdf(geometry, { width: 100, height: 0 } as DOMRectReadOnly, { x: 1, y: 1 })).toThrow('尚未布局')
  })
})

describe('real original encrypted PDF', () => {
  for (const [password, code] of [[undefined, 1], ['incorrect-password', 2]] as const) {
    test(password ? 'wrong password is rejected by the real parser' : 'no password is rejected by the real parser', async () => {
      const task = getDocument({ ...options, data: new Uint8Array(await readFile(resolve(fixtureRoot, 'encrypted-r2.pdf'))), password })
      try { await expect(task.promise).rejects.toMatchObject({ name: 'PasswordException', code }) }
      finally { await task.destroy() }
    })
  }
  for (const [role, password] of Object.entries(manifest.passwords)) {
    test(`${role} password decrypts actual page text`, async () => {
      const task = getDocument({ ...options, data: new Uint8Array(await readFile(resolve(fixtureRoot, 'encrypted-r2.pdf'))), password })
      try {
        const document = await task.promise
        expect(document.numPages).toBe(1)
        const page = await document.getPage(1)
        expect((await page.getOperatorList()).fnArray.length).toBeGreaterThan(0)
        expect((await page.getTextContent()).items.filter(item => 'str' in item).map(item => item.str).join(' ')).toContain('PaperFlow encrypted original text')
      } finally { await task.destroy() }
    })
  }
})

test('600-page fixture has valid operator lists on every page and distinct first/middle/last text', async () => {
  const task = getDocument({ ...options, data: new Uint8Array(await readFile(resolve(fixtureRoot, 'long-600.pdf'))) })
  try {
    const document = await task.promise
    expect(document.numPages).toBe(600)
    const started = performance.now()
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number)
      expect((await page.getOperatorList()).fnArray.length).toBeGreaterThan(0)
      if ([1, 300, 600].includes(number)) {
        expect((await page.getTextContent()).items.filter(item => 'str' in item).map(item => item.str).join(' ')).toContain(`Long document page ${number} of 600`)
      }
      page.cleanup()
    }
    metrics.longOperatorListMs = performance.now() - started
    metrics.longPages = document.numPages
  } finally { await task.destroy() }
}, 30000)
