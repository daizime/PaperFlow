import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ZERO_CROP_INSETS, measureCanvasCropInsets } from '../../src/renderer/src/features/reader/margin-crop'
import { extractPdfOutline, type OutlineDocumentLike } from '../../src/renderer/src/features/reader/pdf-outline'
import {
  PdfSearchService,
  buildPageTextIndex,
  findMatchesInText,
  findTextRangesForMatch,
  type SearchDocumentLike
} from '../../src/renderer/src/features/reader/pdf-search'

function createCanvasPixels(width: number, height: number, fill = [255, 255, 255, 255]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]
    data[i + 1] = fill[1]
    data[i + 2] = fill[2]
    data[i + 3] = fill[3]
  }
  return data
}

function paintRect(
  pixels: Uint8ClampedArray,
  canvasWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
  rgba: [number, number, number, number]
): void {
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) {
      const idx = (row * canvasWidth + col) * 4
      pixels[idx] = rgba[0]
      pixels[idx + 1] = rgba[1]
      pixels[idx + 2] = rgba[2]
      pixels[idx + 3] = rgba[3]
    }
  }
}

describe('margin-crop measureCanvasCropInsets', () => {
  test('returns zero insets for blank white pages and near-white/transparent noise', () => {
    const blank = createCanvasPixels(100, 120)
    expect(measureCanvasCropInsets(blank, 100, 120, 8)).toEqual(ZERO_CROP_INSETS)

    // Near-white (min channel >= 240) and low alpha (< 64) should still count as blank
    paintRect(blank, 100, 20, 20, 40, 40, [240, 240, 240, 255])
    paintRect(blank, 100, 40, 40, 20, 20, [0, 0, 0, 63])
    expect(measureCanvasCropInsets(blank, 100, 120, 8)).toEqual(ZERO_CROP_INSETS)

    expect(measureCanvasCropInsets(new Uint8ClampedArray(10), 10, 10, 8)).toEqual(ZERO_CROP_INSETS)
  })

  test('computes normalized insets with padding for centered ink box', () => {
    const pixels = createCanvasPixels(200, 200)
    // Ink spans x=[40..159], y=[50..149] (even coordinates hit by stride 2)
    paintRect(pixels, 200, 40, 50, 120, 100, [10, 10, 10, 255])
    const insets = measureCanvasCropInsets(pixels, 200, 200, 10)
    // minX=40, maxX=158 -> contentLeft=30, contentRight=169 -> left=30/200=0.15, right=31/200=0.155
    expect(insets.left).toBeCloseTo(0.15, 3)
    expect(insets.right).toBeCloseTo(0.155, 3)
    // minY=50, maxY=148 -> contentTop=40, contentBottom=159 -> top=0.2, bottom=0.205
    expect(insets.top).toBeCloseTo(0.2, 3)
    expect(insets.bottom).toBeCloseTo(0.205, 3)
  })

  test('clamps each side to <= 0.35 and combined axis crop to <= 0.65', () => {
    const pixels = createCanvasPixels(200, 200)
    // Tiny centered ink at (100, 100)
    paintRect(pixels, 200, 100, 100, 2, 2, [0, 0, 0, 255])
    const insets = measureCanvasCropInsets(pixels, 200, 200, 4)
    expect(insets.left).toBeLessThanOrEqual(0.35)
    expect(insets.right).toBeLessThanOrEqual(0.35)
    expect(insets.top).toBeLessThanOrEqual(0.35)
    expect(insets.bottom).toBeLessThanOrEqual(0.35)
    expect(insets.left + insets.right).toBeCloseTo(0.65, 6)
    expect(insets.top + insets.bottom).toBeCloseTo(0.65, 6)
  })
})

describe('pdf-search pure helpers and cancelable service', () => {
  test('buildPageTextIndex preserves divIndex parity with TextLayer and separates EOL', () => {
    const index = buildPageTextIndex({
      items: [
        { type: 'beginMarkedContent', id: 'mc1' },
        { str: 'Title', hasEOL: false },
        { str: '', hasEOL: true },
        { str: 'QUANTUM_', hasEOL: false },
        { str: 'BENCHMARK', hasEOL: true },
        { type: 'endMarkedContent' },
        { str: 'Next line', hasEOL: false }
      ]
    })

    expect(index.text).toBe('Title\nQUANTUM_BENCHMARK\nNext line')
    expect(index.spans).toEqual([
      { divIndex: 0, startOffset: 0, endOffset: 5 },
      // divIndex 1 was str === '' with hasEOL: true -> inserted '\n' at offset 5
      { divIndex: 2, startOffset: 6, endOffset: 14 },
      { divIndex: 3, startOffset: 14, endOffset: 23 },
      // hasEOL at offset 23 -> '\n'
      { divIndex: 4, startOffset: 24, endOffset: 33 }
    ])

    const matches = findMatchesInText(index.text, 'quantum_benchmark', 1, { caseSensitive: false })
    expect(matches).toHaveLength(1)
    expect(matches[0]).toEqual({
      id: '1:0:6:23',
      pageNumber: 1,
      matchIndexOnPage: 0,
      startOffset: 6,
      endOffset: 23
    })

    expect(findTextRangesForMatch(index.spans, matches[0].startOffset, matches[0].endOffset)).toEqual([
      { divIndex: 2, localStart: 0, localEnd: 8 },
      { divIndex: 3, localStart: 0, localEnd: 9 }
    ])
  })

  test('findMatchesInText handles case sensitivity and Unicode expansion offsets', () => {
    expect(findMatchesInText('abc', '', 1, { caseSensitive: false })).toEqual([])
    const text = 'İ alpha BETA beta'
    const insensitive = findMatchesInText(text, 'beta', 2, { caseSensitive: false })
    expect(insensitive.map(m => text.slice(m.startOffset, m.endOffset))).toEqual(['BETA', 'beta'])
    expect(insensitive.map(m => m.matchIndexOnPage)).toEqual([0, 1])

    const sensitive = findMatchesInText(text, 'beta', 2, { caseSensitive: true })
    expect(sensitive.map(m => text.slice(m.startOffset, m.endOffset))).toEqual(['beta'])
  })

  test('PdfSearchService caches pages lazily, yields across batches, and cancels via AbortSignal', async () => {
    const getTextContent = vi.fn(async (pageNumber: number) => ({
      items: [{ str: `Page ${pageNumber} QUANTUM_BENCHMARK`, hasEOL: false }]
    }))
    const doc: SearchDocumentLike = {
      numPages: 45,
      getPage: vi.fn(async (pageNumber: number) => ({
        getTextContent: () => getTextContent(pageNumber)
      }))
    }

    const service = new PdfSearchService(doc)
    const progressBatches: number[] = []
    const matches = await service.search('QUANTUM_BENCHMARK', { caseSensitive: true }, {
      yieldEvery: 20,
      onProgress: (partial, done) => {
        if (!done) progressBatches.push(partial.length)
      }
    })

    expect(matches).toHaveLength(45)
    expect(progressBatches).toEqual([20, 40])
    expect(getTextContent).toHaveBeenCalledTimes(45)

    // Second query reuses cached page text without invoking getPage again
    const second = await service.search('Page 45', { caseSensitive: true })
    expect(second).toHaveLength(1)
    expect(second[0].pageNumber).toBe(45)
    expect(getTextContent).toHaveBeenCalledTimes(45)

    // Abort mid-scan on a fresh uncached service
    const abortController = new AbortController()
    let calls = 0
    const slowDoc: SearchDocumentLike = {
      numPages: 50,
      getPage: async pageNumber => ({
        getTextContent: async () => {
          calls++
          if (pageNumber === 5) abortController.abort()
          return { items: [{ str: `Hit ${pageNumber}`, hasEOL: false }] }
        }
      })
    }
    const slowService = new PdfSearchService(slowDoc)
    const abortedResult = await slowService.search('Hit', { caseSensitive: false }, { signal: abortController.signal })
    expect(abortedResult).toEqual([])
    expect(calls).toBeLessThanOrEqual(5)
  })
})

describe('pdf-outline extraction and reader-ux fixture audit', () => {
  test('extractPdfOutline ignores external URLs and resolves internal destinations', async () => {
    const mockPdf: OutlineDocumentLike = {
      numPages: 5,
      getOutline: async () => [
        { title: 'External Link', dest: null, url: 'https://example.invalid/evil', items: [] },
        {
          title: 'Chapter 1',
          dest: 'named-ch1',
          url: null,
          items: [
            { title: '', dest: [{ num: 10, gen: 0 }, { name: 'Fit' }], url: null, items: [] }
          ]
        },
        {
          title: 'Grouping Header',
          dest: null,
          url: null,
          items: [{ title: 'Nested Valid', dest: [4, { name: 'Fit' }], url: null, items: [] }]
        }
      ],
      getDestination: async id => (id === 'named-ch1' ? [{ num: 2, gen: 0 }] : null),
      getPageIndex: async ref => (ref.num === 2 ? 0 : ref.num === 10 ? 2 : -1)
    }

    const outline = await extractPdfOutline(mockPdf)
    expect(outline).toEqual([
      {
        id: 'outline-1',
        title: 'Chapter 1',
        pageNumber: 1,
        items: [{ id: 'outline-1-0', title: '未命名书签', pageNumber: 3, items: [] }]
      },
      {
        id: 'outline-2',
        title: 'Grouping Header',
        pageNumber: null,
        items: [{ id: 'outline-2-0', title: 'Nested Valid', pageNumber: 5, items: [] }]
      }
    ])
  })

  test('real reader-ux-fixture.pdf extracts outlines and search counts via PDF.js', async () => {
    const pdfBytes = new Uint8Array(
      await readFile(resolve('tests/fixtures/verification/reader-ux/reader-ux-fixture.pdf'))
    )
    const task = getDocument({
      data: pdfBytes,
      standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
      useSystemFonts: false
    })
    try {
      const pdf = await task.promise
      const outlines = await extractPdfOutline(pdf)
      expect(outlines).toHaveLength(3)
      expect(outlines[1].title).toBe('2. Cropped Layout Methods')
      expect(outlines[1].pageNumber).toBe(2)
      expect(outlines[1].items[0].title).toBe('2.1 Nested Bookmark Target')
      expect(outlines[1].items[0].pageNumber).toBe(2)

      const service = new PdfSearchService(pdf)
      const insensitive = await service.search('QUANTUM_BENCHMARK', { caseSensitive: false })
      const sensitive = await service.search('QUANTUM_BENCHMARK', { caseSensitive: true })
      expect(insensitive).toHaveLength(6)
      expect(sensitive).toHaveLength(3)
      expect(sensitive.map(m => m.pageNumber)).toEqual([1, 2, 3])
    } finally {
      await task.destroy()
    }
  })
})
