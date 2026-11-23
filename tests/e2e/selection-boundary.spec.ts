import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { createTestData, importFixture, launchApp } from './helpers'
import manifest from '../fixtures/verification/selection-boundary/manifest.json'

interface Point {
  x: number
  y: number
}

interface Rect extends Point {
  width: number
  height: number
}

interface PartSpec {
  id: string
  pageNumber: number
  rowId: string
  group: string
  text: string
  font: string
  size: number
  width: number
  role: string
  x: number
  y: number
  pdfX: number
  pdfY: number
  drawOrder: number
}

interface BridgeSpec {
  id: string
  pageNumber: number
  kind: string
  cases: string[]
  sourcePartIds: string[]
  pdfWindow: Rect
  description: string
}

interface GuardSpec {
  id: string
  pageNumber: number
  cases: string[]
  pdfWindow: Rect
  reason: string
}

const criteria = {
  whiteMinimumChannel: 245,
  whiteMaximumSpread: 8,
  referenceMinimumTintDistance: 20,
  referenceMinimumTintedFraction: 0.8,
  referenceMinimumSamples: 48,
  referenceMinimumBlueBias: 16,
  maximumBlueChannelDifference: 14,
  minimumWindowSamples: 4,
  minimumGuardSamples: 32,
  minimumWindowColumns: 2,
  minimumWindowRows: 2,
  minimumAxisSamples: 2,
  minimumBridgeBlueFraction: 0.95,
  minimumAxisBlueFraction: 0.9,
  minimumGuardWhiteFraction: 0.95,
  inkMaximumBeforeChannel: 100,
  inkMinimumSamples: 3,
  inkMinimumTinySamples: 1,
  inkMinimumContrastFromTint: 40,
  minimumPreservedInkFraction: 0.9,
  interiorCss: 0.25,
  maximumGeometryDriftCss: 0.25,
  rectDeduplicationCss: 0.05
} as const

const canonical = (value: string): string => value.replace(/\s/g, '')

async function frame(page: Page, pageNumber: number) {
  return page.locator(`.pdf-page[data-page-number="${pageNumber}"] canvas`).evaluate(canvas => {
    const pageEl = canvas.closest<HTMLElement>('.pdf-page')!
    const root = canvas.closest<HTMLElement>('.pdf-scroll')!
    const box = canvas.getBoundingClientRect()
    const reader = root.getBoundingClientRect()
    const layer = pageEl.querySelector<HTMLElement>('.textLayer')
    const shape = pageEl.querySelector<SVGSVGElement>('.pdf-selection-shape')
    const path = shape?.querySelector<SVGPathElement>('path')
    const shapeStyle = shape ? getComputedStyle(shape) : null
    return {
      canvas: { x: box.x, y: box.y, width: box.width, height: box.height },
      reader: { x: reader.x + root.clientLeft, y: reader.y + root.clientTop, width: root.clientWidth, height: root.clientHeight },
      scrollTop: root.scrollTop,
      scrollLeft: root.scrollLeft,
      viewport: { width: innerWidth, height: innerHeight },
      dpr: devicePixelRatio,
      hasFocus: document.hasFocus(),
      forcedColors: matchMedia('(forced-colors: active)').matches,
      continuousSelectionAttr: layer?.hasAttribute('data-continuous-selection') ?? false,
      selectionPathLength: path?.getAttribute('d')?.length ?? 0,
      shapeDisplay: shapeStyle?.display ?? null,
      shapeFillOpacity: shapeStyle?.fillOpacity ?? null,
      shapeStroke: shapeStyle?.stroke ?? null
    }
  })
}

function toClient(pageNumber: number, point: Point, geometry: Awaited<ReturnType<typeof frame>>): Point {
  const specification = manifest.pages.find(value => value.number === pageNumber)!
  const [x0, y0, x1, y1] = specification.view
  const u = (point.x - x0) / (x1 - x0)
  const v = (point.y - y0) / (y1 - y0)
  const rotated =
    specification.rotation === 0
      ? { x: u, y: 1 - v }
      : specification.rotation === 90
        ? { x: v, y: u }
        : specification.rotation === 180
          ? { x: 1 - u, y: v }
          : { x: 1 - v, y: 1 - u }
  return {
    x: geometry.canvas.x + rotated.x * geometry.canvas.width,
    y: geometry.canvas.y + rotated.y * geometry.canvas.height
  }
}

function clientWindow(window: Rect, pageNumber: number, geometry: Awaited<ReturnType<typeof frame>>): Rect {
  const a = toClient(pageNumber, window, geometry)
  const b = toClient(pageNumber, { x: window.x + window.width, y: window.y + window.height }, geometry)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function zoomTo100(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await page.getByTestId('zoom-level').innerText()) === '50%') break
    await page.getByRole('button', { name: '缩小', exact: true }).click()
  }
  await expect(page.getByTestId('zoom-level')).toHaveText('50%')
  for (let step = 0; step < 5; step++) {
    await page.getByRole('button', { name: '放大', exact: true }).click()
  }
  await expect(page.getByTestId('zoom-level')).toHaveText('100%')
}

async function snapshotPages(page: Page, pageNumbers: number[], parts: PartSpec[]) {
  return page.evaluate(
    ({ pageNumbers, parts, tolerance }) => {
      const rectData = (rect: DOMRect): Rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      const deduplicate = (rects: Rect[]) =>
        rects.filter(
          (rect, index) =>
            rect.width > 0 &&
            rect.height > 0 &&
            !rects
              .slice(0, index)
              .some(other => (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(rect[key] - other[key]) <= tolerance))
        )
      const selection = window.getSelection()
      const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, index) => selection!.getRangeAt(index))
      const data = (node: Node | null) => ({
        type: node?.nodeName ?? null,
        text: node?.textContent ?? null,
        page: node?.parentElement?.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber ?? null
      })

      const pageIndex = new Map<
        number,
        {
          nodes: Text[]
          normalizedStream: string
          streamIndices: number[]
          cursor: number
        }
      >()

      for (const number of pageNumbers) {
        const root = document.querySelector(`.pdf-page[data-page-number="${number}"] .textLayer`)!
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        const nodes: Text[] = []
        let next: Node | null
        while ((next = walker.nextNode())) nodes.push(next as Text)
        const stream = nodes.map(node => node.data).join('')
        const streamIndices: number[] = []
        let normalizedStream = ''
        for (let i = 0; i < stream.length; i++) {
          if (!/\s/.test(stream[i])) {
            normalizedStream += stream[i]
            streamIndices.push(i)
          }
        }
        pageIndex.set(number, { nodes, normalizedStream, streamIndices, cursor: 0 })
      }

      const boundary = (nodes: Text[], position: number, end: boolean) => {
        let consumed = 0
        for (const node of nodes) {
          if (position < consumed + node.length || (end && position === consumed + node.length)) {
            return { node, offset: position - consumed }
          }
          consumed += node.length
        }
        return null
      }

      const measuredParts = parts.map(part => {
        const state = pageIndex.get(part.pageNumber)
        if (!state) {
          return { id: part.id, pageNumber: part.pageNumber, size: part.size, role: part.role, found: false, fullySelected: false, rects: [] as Rect[] }
        }
        const content = part.text.replace(/\s/g, '')
        const index = state.normalizedStream.indexOf(content, state.cursor)
        if (index < 0) {
          return { id: part.id, pageNumber: part.pageNumber, size: part.size, role: part.role, found: false, fullySelected: false, rects: [] as Rect[] }
        }
        state.cursor = index + content.length
        const originalStart = state.streamIndices[index]
        const originalEnd = state.streamIndices[index + content.length - 1] + 1
        const start = boundary(state.nodes, originalStart, false)
        const end = boundary(state.nodes, originalEnd, true)
        if (!start || !end) {
          return { id: part.id, pageNumber: part.pageNumber, size: part.size, role: part.role, found: false, fullySelected: false, rects: [] as Rect[] }
        }
        const range = document.createRange()
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
        const fullySelected = ranges.some(
          selected =>
            selected.compareBoundaryPoints(Range.START_TO_START, range) <= 0 &&
            selected.compareBoundaryPoints(Range.END_TO_END, range) >= 0
        )
        return {
          id: part.id,
          pageNumber: part.pageNumber,
          size: part.size,
          role: part.role,
          found: true,
          fullySelected,
          rects: fullySelected ? deduplicate(Array.from(range.getClientRects(), rectData)) : []
        }
      })

      return {
        text: selection?.toString() ?? '',
        anchor: data(selection?.anchorNode ?? null),
        focus: data(selection?.focusNode ?? null),
        measuredParts
      }
    },
    { pageNumbers, parts, tolerance: criteria.rectDeduplicationCss }
  )
}

async function pixelEvidence(
  page: Page,
  before: Buffer,
  after: Buffer,
  referenceRects: Rect[],
  bridges: (BridgeSpec & { client: Rect })[],
  guards: (GuardSpec & { client: Rect })[],
  glyphs: { id: string; size: number; role: string; rects: Rect[] }[]
) {
  return page.evaluate(
    async ({ before, after, referenceRects, bridges, guards, glyphs, criteria }) => {
      async function decode(base64: string) {
        const bitmap = await createImageBitmap(
          new Blob([Uint8Array.from(atob(base64), ch => ch.charCodeAt(0))], { type: 'image/png' })
        )
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(bitmap, 0, 0)
        bitmap.close()
        return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data }
      }

      const [a, b] = await Promise.all([decode(before), decode(after)])
      const white = (rgb: number[]) =>
        Math.min(...rgb) >= criteria.whiteMinimumChannel && Math.max(...rgb) - Math.min(...rgb) <= criteria.whiteMaximumSpread
      const whiteDistance = (rgb: number[]) => Math.hypot(255 - rgb[0], 255 - rgb[1], 255 - rgb[2])
      const median = (values: number[]) => (values.length ? [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] : null)
      const colorAt = (image: typeof a, x: number, y: number) =>
        Array.from(image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3))

      type Sample = [number, number, number, number, number, number, number, number, number, number, number | null]
      const collect = (rects: Rect[], mode: 'white' | 'ink'): Sample[] => {
        const result: Sample[] = []
        const seen = new Set<string>()
        for (const rect of rects) {
          for (let y = Math.ceil(rect.y); y + 0.5 < rect.y + rect.height - criteria.interiorCss; y++) {
            for (let x = Math.ceil(rect.x); x + 0.5 < rect.x + rect.width - criteria.interiorCss; x++) {
              if (
                x + 0.5 <= rect.x + criteria.interiorCss ||
                y + 0.5 <= rect.y + criteria.interiorCss ||
                x < 0 ||
                y < 0 ||
                x >= a.width ||
                y >= a.height ||
                x >= b.width ||
                y >= b.height ||
                seen.has(`${x},${y}`)
              ) {
                continue
              }
              seen.add(`${x},${y}`)
              const original = colorAt(a, x, y)
              const selected = colorAt(b, x, y)
              if (mode === 'white' ? !white(original) : Math.max(...original) > criteria.inkMaximumBeforeChannel) continue
              result.push([
                x,
                y,
                original[0],
                original[1],
                original[2],
                selected[0],
                selected[1],
                selected[2],
                whiteDistance(original),
                whiteDistance(selected),
                null
              ])
            }
          }
        }
        return result
      }

      const referenceRaw = collect(referenceRects, 'white')
      const tinted = referenceRaw.filter(sample => sample[9] >= criteria.referenceMinimumTintDistance)
      const referenceColor = [5, 6, 7].map(channel => median(tinted.map(sample => sample[channel] as number)))
      const referenceValid = referenceColor.every(channel => channel !== null)
      const difference = (sample: Sample) =>
        referenceValid ? Math.max(...[5, 6, 7].map((channel, index) => Math.abs((sample[channel] as number) - referenceColor[index]!))) : null
      for (const sample of referenceRaw) sample[10] = difference(sample)
      const matching = (sample: Sample) => sample[10] !== null && sample[10] <= criteria.maximumBlueChannelDifference

      function axis(raw: Sample[], coordinate: 0 | 1) {
        const groups = new Map<number, Sample[]>()
        for (const sample of raw) {
          const group = groups.get(sample[coordinate]) ?? []
          group.push(sample)
          groups.set(sample[coordinate], group)
        }
        return [...groups]
          .map(([position, samples]) => ({
            position,
            count: samples.length,
            blueFraction: samples.filter(matching).length / samples.length
          }))
          .filter(group => group.count >= criteria.minimumAxisSamples)
      }

      const measuredBridges = bridges.map(bridge => {
        const raw = collect([bridge.client], 'white')
        for (const sample of raw) sample[10] = difference(sample)
        const columns = axis(raw, 0)
        const rows = axis(raw, 1)
        return {
          ...bridge,
          samples: raw.length,
          columns,
          rows,
          blueFraction: raw.length ? raw.filter(matching).length / raw.length : null,
          minimumColumnBlueFraction: columns.length ? Math.min(...columns.map(group => group.blueFraction)) : null,
          minimumRowBlueFraction: rows.length ? Math.min(...rows.map(group => group.blueFraction)) : null
        }
      })

      const measuredGuards = guards.map(guard => {
        const raw = collect([guard.client], 'white')
        return {
          ...guard,
          samples: raw.length,
          whiteFractionAfter: raw.length ? raw.filter(sample => white(sample.slice(5, 8) as number[])).length / raw.length : null
        }
      })

      const measuredGlyphs = glyphs.map(glyph => {
        const raw = collect(glyph.rects, 'ink')
        for (const sample of raw) sample[10] = difference(sample)
        return {
          ...glyph,
          samples: raw.length,
          preservedInkFraction:
            raw.length && referenceValid ? raw.filter(sample => sample[10]! >= criteria.inkMinimumContrastFromTint).length / raw.length : null
        }
      })

      return {
        beforeSize: { width: a.width, height: a.height },
        afterSize: { width: b.width, height: b.height },
        reference: {
          color: referenceColor,
          samples: referenceRaw.length,
          tintedSamples: tinted.length,
          tintedFraction: referenceRaw.length ? tinted.length / referenceRaw.length : 0,
          blueBias: referenceValid ? referenceColor[2]! - referenceColor[0]! : null
        },
        bridges: measuredBridges,
        guards: measuredGuards,
        glyphs: measuredGlyphs
      }
    },
    { before: before.toString('base64'), after: after.toString('base64'), referenceRects, bridges, guards, glyphs, criteria }
  )
}

test('PFV boundary cross-page continuous selection renders unified SVG across Page 1 and Page 2', async () => {
  const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
  let held = false
  try {
    await importFixture(app, page, 'verification/selection-boundary/' + manifest.file.name)
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    await zoomTo100(page)
    await expect.poll(async () => Math.abs((await frame(page, 1)).canvas.width - 600)).toBeLessThan(0.1)

    const spec = manifest.selections.crossPageMultiLine
    const initialP1 = await frame(page, 1)
    const initialP2 = await frame(page, 2)
    const initialStart = toClient(1, spec.start, initialP1)
    const initialEnd = toClient(2, spec.end, initialP2)

    await page.getByLabel('PDF 阅读区域', { exact: true }).evaluate(
      (root, delta) => {
        root.scrollTop += delta.y
        root.scrollLeft += delta.x
      },
      {
        x: (initialStart.x + initialEnd.x) / 2 - initialP1.reader.x - initialP1.reader.width / 2,
        y: (initialStart.y + initialEnd.y) / 2 - initialP1.reader.y - initialP1.reader.height / 2
      }
    )
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    await expect(page.locator('.pdf-page[data-page-number="2"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    await settled(page)

    const p1Frame = await frame(page, 1)
    const p2Frame = await frame(page, 2)
    const start = toClient(1, spec.start, p1Frame)
    const end = toClient(2, spec.end, p2Frame)
    for (const point of [start, end]) {
      expect(point.x).toBeGreaterThan(p1Frame.reader.x + 36)
      expect(point.x).toBeLessThan(p1Frame.reader.x + p1Frame.reader.width - 36)
      expect(point.y).toBeGreaterThan(p1Frame.reader.y + 36)
      expect(point.y).toBeLessThan(p1Frame.reader.y + p1Frame.reader.height - 36)
    }

    const bridges = (manifest.bridgeCandidates as BridgeSpec[])
      .filter(candidate => candidate.cases.includes('crossPageMultiLine'))
      .map(candidate => ({
        ...candidate,
        client: clientWindow(candidate.pdfWindow, candidate.pageNumber, candidate.pageNumber === 1 ? p1Frame : p2Frame)
      }))
    const guards = (manifest.guardWindows as GuardSpec[])
      .filter(guard => guard.cases.includes('crossPageMultiLine'))
      .map(guard => ({
        ...guard,
        client: clientWindow(guard.pdfWindow, guard.pageNumber, guard.pageNumber === 1 ? p1Frame : p2Frame)
      }))

    await page.mouse.move(start.x, start.y)
    const before = await page.screenshot({ scale: 'css', animations: 'disabled' })
    await page.mouse.down()
    held = true
    await page.mouse.move(end.x, end.y, { steps: 32 })
    await page.mouse.up()
    held = false
    await settled(page)
    const after = await page.screenshot({ scale: 'css', animations: 'disabled' })

    const selected = await snapshotPages(page, [1, 2], manifest.parts as PartSpec[])
    await app.evaluate(({ clipboard }) => clipboard.writeText('boundary-cross-page-sentinel'))
    await page.keyboard.press('Control+C')
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())

    expect(canonical(selected.text)).toBe(canonical(spec.expectedText))
    expect(canonical(clipboard)).toBe(canonical(spec.expectedText))
    expect(selected.anchor.page).toBe('1')
    expect(selected.focus.page).toBe('2')
    for (const excluded of manifest.excludedRuns.filter(r => r.pageNumber <= 2)) {
      expect(canonical(selected.text)).not.toContain(canonical(excluded.text))
      expect(canonical(clipboard)).not.toContain(canonical(excluded.text))
    }

    const p1After = await frame(page, 1)
    const p2After = await frame(page, 2)
    expect(p1After.continuousSelectionAttr, '跨页选区第 1 页必须启用统一 SVG 叠层').toBe(true)
    expect(p1After.selectionPathLength).toBeGreaterThan(0)
    expect(p2After.continuousSelectionAttr, '跨页选区第 2 页必须启用统一 SVG 叠层').toBe(true)
    expect(p2After.selectionPathLength).toBeGreaterThan(0)

    const selectedParts = selected.measuredParts.filter(part => spec.selectedPartIds.includes(part.id))
    expect(selectedParts).toHaveLength(spec.selectedPartIds.length)
    for (const part of selectedParts) {
      expect(part.found && part.fullySelected && part.rects.length > 0).toBe(true)
    }

    const referenceRects = selectedParts.filter(part => spec.referencePartIds.includes(part.id)).flatMap(part => part.rects)
    const measured = await pixelEvidence(page, before, after, referenceRects, bridges, guards, selectedParts)
    expect(measured.reference.samples).toBeGreaterThanOrEqual(criteria.referenceMinimumSamples)
    expect(measured.reference.tintedFraction).toBeGreaterThanOrEqual(criteria.referenceMinimumTintedFraction)
    expect(measured.reference.blueBias!).toBeGreaterThanOrEqual(criteria.referenceMinimumBlueBias)

    for (const window of measured.bridges) {
      expect(window.samples, `${window.id}:样本不足`).toBeGreaterThanOrEqual(criteria.minimumWindowSamples)
      expect(window.columns.length, `${window.id}:列数不足`).toBeGreaterThanOrEqual(criteria.minimumWindowColumns)
      expect(window.rows.length, `${window.id}:行数不足`).toBeGreaterThanOrEqual(criteria.minimumWindowRows)
      expect(window.blueFraction!, `${window.id}:跨页双方选区蓝框须连续`).toBeGreaterThanOrEqual(criteria.minimumBridgeBlueFraction)
      expect(window.minimumColumnBlueFraction!).toBeGreaterThanOrEqual(criteria.minimumAxisBlueFraction)
      expect(window.minimumRowBlueFraction!).toBeGreaterThanOrEqual(criteria.minimumAxisBlueFraction)
    }
    for (const guard of measured.guards) {
      expect(guard.samples, `${guard.id}:守卫样本不足`).toBeGreaterThanOrEqual(criteria.minimumGuardSamples)
      expect(guard.whiteFractionAfter!, `${guard.id}:未选区域须保持白底`).toBeGreaterThanOrEqual(criteria.minimumGuardWhiteFraction)
    }
    for (const glyph of measured.glyphs) {
      expect(glyph.samples).toBeGreaterThanOrEqual(criteria.inkMinimumSamples)
      expect(glyph.preservedInkFraction!).toBeGreaterThanOrEqual(criteria.minimumPreservedInkFraction)
    }

    // 即使每页仅选中单个 run（bridges.length === 0），跨页时两页仍须统一走 SVG 叠层。
    const singleSpec = manifest.selections.crossPageSingleRunPerPage
    const singleStart = toClient(1, singleSpec.start, p1After)
    const singleEnd = toClient(2, singleSpec.end, p2After)
    await page.mouse.move(singleStart.x, singleStart.y)
    await page.mouse.down()
    held = true
    await page.mouse.move(singleEnd.x, singleEnd.y, { steps: 24 })
    await page.mouse.up()
    held = false
    await settled(page)

    const singleSelected = await snapshotPages(page, [1, 2], manifest.parts as PartSpec[])
    expect(canonical(singleSelected.text)).toBe(canonical(singleSpec.expectedText))
    const p1Single = await frame(page, 1)
    const p2Single = await frame(page, 2)
    expect(p1Single.continuousSelectionAttr, '单 run 跨页第 1 页亦须启用统一 SVG 叠层').toBe(true)
    expect(p1Single.selectionPathLength).toBeGreaterThan(0)
    expect(p2Single.continuousSelectionAttr, '单 run 跨页第 2 页亦须启用统一 SVG 叠层').toBe(true)
    expect(p2Single.selectionPathLength).toBeGreaterThan(0)
  } finally {
    if (held) await page.mouse.up().catch(() => {})
    await app.close()
  }
})

test('PFV boundary rotated 90deg Page 3 formula and multi-line continuity at 100pct DPR1', async () => {
  const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
  let held = false
  try {
    await importFixture(app, page, 'verification/selection-boundary/' + manifest.file.name)
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    const input = page.getByRole('spinbutton', { name: '当前页码' })
    await input.fill('3')
    await input.press('Enter')
    await zoomTo100(page)
    await expect(page.locator('.pdf-page[data-page-number="3"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    await expect.poll(async () => Math.abs((await frame(page, 3)).canvas.width - 600)).toBeLessThan(0.1)

    const spec = manifest.selections.rotatedPage3
    const initial = await frame(page, 3)
    const initialStart = toClient(3, spec.start, initial)
    const initialEnd = toClient(3, spec.end, initial)
    await page.getByLabel('PDF 阅读区域', { exact: true }).evaluate(
      (root, delta) => {
        root.scrollTop += delta.y
        root.scrollLeft += delta.x
      },
      {
        x: (initialStart.x + initialEnd.x) / 2 - initial.reader.x - initial.reader.width / 2,
        y: (initialStart.y + initialEnd.y) / 2 - initial.reader.y - initial.reader.height / 2
      }
    )
    await settled(page)

    const prepared = await frame(page, 3)
    const start = toClient(3, spec.start, prepared)
    const end = toClient(3, spec.end, prepared)
    for (const point of [start, end]) {
      expect(point.x).toBeGreaterThan(prepared.reader.x + 36)
      expect(point.x).toBeLessThan(prepared.reader.x + prepared.reader.width - 36)
      expect(point.y).toBeGreaterThan(prepared.reader.y + 36)
      expect(point.y).toBeLessThan(prepared.reader.y + prepared.reader.height - 36)
    }

    const bridges = (manifest.bridgeCandidates as BridgeSpec[])
      .filter(candidate => candidate.cases.includes('rotatedPage3'))
      .map(candidate => ({ ...candidate, client: clientWindow(candidate.pdfWindow, 3, prepared) }))
    const guards = (manifest.guardWindows as GuardSpec[])
      .filter(guard => guard.cases.includes('rotatedPage3'))
      .map(guard => ({ ...guard, client: clientWindow(guard.pdfWindow, 3, prepared) }))

    await page.mouse.move(start.x, start.y)
    const before = await page.screenshot({ scale: 'css', animations: 'disabled' })
    await page.mouse.down()
    held = true
    await page.mouse.move(end.x, end.y, { steps: 32 })
    await page.mouse.up()
    held = false
    await settled(page)

    const after = await page.screenshot({ scale: 'css', animations: 'disabled' })
    const shotPath = process.env.PAPERFLOW_BOUNDARY_SHOT?.trim()
    if (shotPath) {
      await mkdir(dirname(shotPath), { recursive: true })
      await writeFile(shotPath, after)
    }

    const selected = await snapshotPages(page, [3], manifest.parts as PartSpec[])
    await app.evaluate(({ clipboard }) => clipboard.writeText('boundary-rotated-sentinel'))
    await page.keyboard.press('Control+C')
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())

    expect(canonical(selected.text)).toBe(canonical(spec.expectedText))
    expect(canonical(clipboard)).toBe(canonical(spec.expectedText))
    expect(selected.anchor.page).toBe('3')
    expect(selected.focus.page).toBe('3')
    for (const excluded of manifest.excludedRuns.filter(r => r.pageNumber === 3)) {
      expect(canonical(selected.text)).not.toContain(canonical(excluded.text))
      expect(canonical(clipboard)).not.toContain(canonical(excluded.text))
    }

    const finished = await frame(page, 3)
    expect(finished.continuousSelectionAttr).toBe(true)
    expect(finished.selectionPathLength).toBeGreaterThan(0)

    const selectedParts = selected.measuredParts.filter(part => spec.selectedPartIds.includes(part.id))
    expect(selectedParts).toHaveLength(spec.selectedPartIds.length)
    for (const part of selectedParts) {
      expect(part.found && part.fullySelected && part.rects.length > 0).toBe(true)
    }

    const referenceRects = selectedParts.filter(part => spec.referencePartIds.includes(part.id)).flatMap(part => part.rects)
    const measured = await pixelEvidence(page, before, after, referenceRects, bridges, guards, selectedParts)
    expect(measured.reference.samples).toBeGreaterThanOrEqual(criteria.referenceMinimumSamples)
    expect(measured.reference.tintedFraction).toBeGreaterThanOrEqual(criteria.referenceMinimumTintedFraction)
    expect(measured.reference.blueBias!).toBeGreaterThanOrEqual(criteria.referenceMinimumBlueBias)

    for (const window of measured.bridges) {
      expect(window.samples, `${window.id}:样本不足`).toBeGreaterThanOrEqual(criteria.minimumWindowSamples)
      expect(window.columns.length, `${window.id}:列数不足`).toBeGreaterThanOrEqual(criteria.minimumWindowColumns)
      expect(window.rows.length, `${window.id}:行数不足`).toBeGreaterThanOrEqual(criteria.minimumWindowRows)
      expect(window.blueFraction!, `${window.id}:90度旋转页蓝框须连续`).toBeGreaterThanOrEqual(criteria.minimumBridgeBlueFraction)
      expect(window.minimumColumnBlueFraction!).toBeGreaterThanOrEqual(criteria.minimumAxisBlueFraction)
      expect(window.minimumRowBlueFraction!).toBeGreaterThanOrEqual(criteria.minimumAxisBlueFraction)
    }
    for (const guard of measured.guards) {
      expect(guard.samples, `${guard.id}:守卫样本不足`).toBeGreaterThanOrEqual(criteria.minimumGuardSamples)
      expect(guard.whiteFractionAfter!, `${guard.id}:未选区域须保持白底`).toBeGreaterThanOrEqual(criteria.minimumGuardWhiteFraction)
    }
    for (const glyph of measured.glyphs) {
      const minSamples = glyph.size < 12 && glyph.role === 'subscript' ? criteria.inkMinimumTinySamples : criteria.inkMinimumSamples
      expect(glyph.samples, `${glyph.id}:ink样本不足`).toBeGreaterThanOrEqual(minSamples)
      expect(glyph.preservedInkFraction!, `${glyph.id}:90度旋转页字形墨迹须保留`).toBeGreaterThanOrEqual(criteria.minimumPreservedInkFraction)
    }
  } finally {
    if (held) await page.mouse.up().catch(() => {})
    await app.close()
  }
})

test('PFV boundary Windows high contrast (forced-colors: active) keeps SVG selection semi-transparent and preserves glyph ink', async () => {
  const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
  let held = false
  try {
    await importFixture(app, page, 'verification/selection-boundary/' + manifest.file.name)
    await page.emulateMedia({ forcedColors: 'active' })
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    const input = page.getByRole('spinbutton', { name: '当前页码' })
    await input.fill('3')
    await input.press('Enter')
    await zoomTo100(page)
    await expect(page.locator('.pdf-page[data-page-number="3"]')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })
    await expect.poll(async () => Math.abs((await frame(page, 3)).canvas.width - 600)).toBeLessThan(0.1)

    const spec = manifest.selections.rotatedPage3
    const initial = await frame(page, 3)
    expect(initial.forcedColors).toBe(true)
    const initialStart = toClient(3, spec.start, initial)
    const initialEnd = toClient(3, spec.end, initial)
    await page.getByLabel('PDF 阅读区域', { exact: true }).evaluate(
      (root, delta) => {
        root.scrollTop += delta.y
        root.scrollLeft += delta.x
      },
      {
        x: (initialStart.x + initialEnd.x) / 2 - initial.reader.x - initial.reader.width / 2,
        y: (initialStart.y + initialEnd.y) / 2 - initial.reader.y - initial.reader.height / 2
      }
    )
    await settled(page)

    const uiStyles = await page.evaluate(() => {
      const selectedDoc = document.querySelector<HTMLElement>('.document-item.selected')
      const toolbarButton = document.querySelector<HTMLElement>('.reader-toolbar button')
      const importButton = document.querySelector<HTMLElement>('.library-import-button')
      return {
        selectedDocOutline: selectedDoc ? getComputedStyle(selectedDoc).outlineStyle : null,
        toolbarBorder: toolbarButton ? getComputedStyle(toolbarButton).borderTopStyle : null,
        importBorder: importButton ? getComputedStyle(importButton).borderTopStyle : null
      }
    })
    expect(uiStyles.selectedDocOutline).not.toBe('none')
    expect(uiStyles.toolbarBorder).not.toBe('none')
    expect(uiStyles.importBorder).not.toBe('none')

    const prepared = await frame(page, 3)
    const start = toClient(3, spec.start, prepared)
    const end = toClient(3, spec.end, prepared)

    await page.mouse.move(start.x, start.y)
    const before = await page.screenshot({ scale: 'css', animations: 'disabled' })
    await page.mouse.down()
    held = true
    await page.mouse.move(end.x, end.y, { steps: 32 })
    await page.mouse.up()
    held = false
    await settled(page)
    const after = await page.screenshot({ scale: 'css', animations: 'disabled' })
    const hcShotPath = process.env.PAPERFLOW_BOUNDARY_HC_SHOT?.trim()
    if (hcShotPath) {
      await mkdir(dirname(hcShotPath), { recursive: true })
      await writeFile(hcShotPath, after)
    }

    const selected = await snapshotPages(page, [3], manifest.parts as PartSpec[])
    await app.evaluate(({ clipboard }) => clipboard.writeText('boundary-hc-sentinel'))
    await page.keyboard.press('Control+C')
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())

    expect(canonical(selected.text)).toBe(canonical(spec.expectedText))
    expect(canonical(clipboard)).toBe(canonical(spec.expectedText))

    const finished = await frame(page, 3)
    expect(finished.forcedColors).toBe(true)
    expect(finished.continuousSelectionAttr).toBe(true)
    expect(finished.selectionPathLength).toBeGreaterThan(0)
    expect(finished.shapeDisplay).toBe('block')
    expect(finished.shapeStroke).toBe('none')
    const fillOpacity = Number.parseFloat(finished.shapeFillOpacity ?? '1')
    expect(fillOpacity).toBeGreaterThan(0.1)
    expect(fillOpacity).toBeLessThan(0.8)

    const selectedParts = selected.measuredParts.filter(part => spec.selectedPartIds.includes(part.id))
    expect(selectedParts).toHaveLength(spec.selectedPartIds.length)
    const referenceRects = selectedParts.filter(part => spec.referencePartIds.includes(part.id)).flatMap(part => part.rects)
    const measured = await pixelEvidence(page, before, after, referenceRects, [], [], selectedParts)

    expect(measured.reference.samples).toBeGreaterThanOrEqual(criteria.referenceMinimumSamples)
    expect(measured.reference.tintedFraction, '高对比度选区背景须相对白底明显着色').toBeGreaterThanOrEqual(
      criteria.referenceMinimumTintedFraction
    )
    for (const glyph of measured.glyphs) {
      const minSamples = glyph.size < 12 && glyph.role === 'subscript' ? criteria.inkMinimumTinySamples : criteria.inkMinimumSamples
      expect(glyph.samples, `${glyph.id}:高对比度ink样本不足`).toBeGreaterThanOrEqual(minSamples)
      expect(glyph.preservedInkFraction!, `${glyph.id}:高对比度选区不得掩盖字形墨迹`).toBeGreaterThanOrEqual(
        criteria.minimumPreservedInkFraction
      )
    }
  } finally {
    if (held) await page.mouse.up().catch(() => {})
    await app.close()
  }
})
