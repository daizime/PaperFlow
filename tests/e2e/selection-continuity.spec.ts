import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { createTestData, importFixture, launchApp } from './helpers'
import manifest from '../fixtures/verification/selection-continuity/manifest.json'

interface Point {
  x: number
  y: number
}

interface Rect extends Point {
  width: number
  height: number
}

interface Part {
  id: string
  rowId: string
  text: string
  font: string
  x: number
  y: number
  size: number
  width: number
  role: string
  drawOrder: number
}

type CaseId = 'fullFiveRows' | 'proseTwoRows'

interface WindowSpec {
  id: string
  cases: string[]
  pdfWindow: Rect
}

interface Bridge extends WindowSpec {
  kind: string
  sourcePartIds: string[]
  sourceRowIds: string[]
}

interface Guard extends WindowSpec {
  reason: string
}

interface SelectionSpec {
  pageNumber: number
  start: Point
  end: Point
  expectedText: string
  expectedLines: string[]
  normalization: string
}

// 原创合成正文、数学运算符、宽下标与哨兵均由本项目生成；不复制用户截图中的论文。
// 以下判据常数来自既定 DPR-1 像素验证契约，本身不是已测结果。
const criteria = {
  whiteMinimumChannel: 245,
  whiteMaximumSpread: 8,
  referenceMinimumTintDistance: 20,
  referenceMinimumTintedFraction: 0.8,
  referenceMinimumSamples: 64,
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
  inkMinimumContrastFromBlue: 40,
  minimumPreservedInkFraction: 0.9,
  interiorCss: 0.25,
  maximumGeometryDriftCss: 0.25,
  rectDeduplicationCss: 0.05
} as const

// 素材契约规定 remove-whitespace-only：仅忽略空白，保留全部文字、数学符号与标点。
const canonical = (value: string): string => value.replace(/\s/g, '')

async function frame(page: Page, pageNumber: number) {
  return page.locator(`.pdf-page[data-page-number="${pageNumber}"] canvas`).evaluate(canvas => {
    const root = canvas.closest<HTMLElement>('.pdf-scroll')!
    const box = canvas.getBoundingClientRect()
    const reader = root.getBoundingClientRect()
    const layer = canvas.closest('.pdf-page')!.querySelector<HTMLElement>('.textLayer')
    const text = layer?.querySelector('span')
    const style = text ? getComputedStyle(text, '::selection') : null
    const path = canvas.closest('.pdf-page')!.querySelector<SVGPathElement>('.pdf-selection-shape path')
    return {
      canvas: { x: box.x, y: box.y, width: box.width, height: box.height },
      reader: { x: reader.x + root.clientLeft, y: reader.y + root.clientTop, width: root.clientWidth, height: root.clientHeight },
      scrollTop: root.scrollTop,
      scrollLeft: root.scrollLeft,
      viewport: { width: innerWidth, height: innerHeight },
      dpr: devicePixelRatio,
      hasFocus: document.hasFocus(),
      activeElement: { tag: document.activeElement?.tagName ?? null, label: document.activeElement?.getAttribute('aria-label') ?? null },
      selectionStyle: { background: style?.backgroundColor ?? null, color: style?.color ?? null },
      forcedColors: matchMedia('(forced-colors: active)').matches,
      continuousSelectionAttr: layer?.hasAttribute('data-continuous-selection') ?? false,
      selectionPathLength: path?.getAttribute('d')?.length ?? 0
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

async function snapshot(page: Page, pageNumber: number) {
  return page.evaluate(
    ({ parts, tolerance, number }) => {
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
      const root = document.querySelector(`.pdf-page[data-page-number="${number}"] .textLayer`)!
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      let next: Node | null
      while ((next = walker.nextNode())) nodes.push(next as Text)
      const stream = nodes.map(node => node.data).join('')
      const boundary = (position: number, end: boolean) => {
        let consumed = 0
        for (const node of nodes) {
          if (position < consumed + node.length || (end && position === consumed + node.length)) {
            return { node, offset: position - consumed }
          }
          consumed += node.length
        }
        return null
      }
      const streamIndices: number[] = []
      let normalizedStream = ''
      for (let index = 0; index < stream.length; index++) {
        if (!/\s/.test(stream[index])) {
          normalizedStream += stream[index]
          streamIndices.push(index)
        }
      }
      const absolutePosition = (node: Node, offset: number): number | null => {
        let consumed = 0
        for (const text of nodes) {
          if (text === node) return consumed + offset
          consumed += text.length
        }
        return null
      }
      const firstRange = ranges[0]
      const selectedStart = firstRange ? absolutePosition(firstRange.startContainer, firstRange.startOffset) : null
      const selectedEnd = firstRange ? absolutePosition(firstRange.endContainer, firstRange.endOffset) : null
      let cursor = selectedStart === null ? normalizedStream.length : streamIndices.findIndex(index => index >= selectedStart)
      if (cursor < 0) cursor = normalizedStream.length

      // 手势完成后只读测量原始制作顺序中的 parts；这些 Range 不写入 Selection、不用于瞄点。
      const measuredParts = parts.map(part => {
        const content = part.text.replace(/\s/g, '')
        const index = normalizedStream.indexOf(content, cursor)
        const originalStart = index >= 0 ? streamIndices[index] : -1
        const originalEnd = index >= 0 ? streamIndices[index + content.length - 1] + 1 : -1
        const withinSelection = index >= 0 && selectedStart !== null && selectedEnd !== null && originalEnd <= selectedEnd
        const start = withinSelection ? boundary(originalStart, false) : null
        const end = withinSelection ? boundary(originalEnd, true) : null
        if (!start || !end) {
          return { id: part.id, rowId: part.rowId, size: part.size, role: part.role, text: part.text, found: false, fullySelected: false, rects: [] as Rect[] }
        }
        cursor = index + content.length
        const range = document.createRange()
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
        return {
          id: part.id,
          rowId: part.rowId,
          size: part.size,
          role: part.role,
          text: part.text,
          found: true,
          fullySelected: ranges.some(
            selected =>
              selected.compareBoundaryPoints(Range.START_TO_START, range) <= 0 &&
              selected.compareBoundaryPoints(Range.END_TO_END, range) >= 0
          ),
          rects: deduplicate(Array.from(range.getClientRects(), rectData))
        }
      })

      const rawRangeRects = ranges.flatMap(range => Array.from(range.getClientRects(), rectData))
      return {
        text: selection?.toString() ?? '',
        anchor: data(selection?.anchorNode ?? null),
        focus: data(selection?.focusNode ?? null),
        anchorOffset: selection?.anchorOffset ?? null,
        focusOffset: selection?.focusOffset ?? null,
        rawRangeRects,
        rangeRects: deduplicate(rawRangeRects),
        measuredParts,
        stream
      }
    },
    { parts: manifest.parts as Part[], tolerance: criteria.rectDeduplicationCss, number: pageNumber }
  )
}

async function pixelEvidence(
  page: Page,
  before: Buffer,
  after: Buffer,
  referenceRects: Rect[],
  bridges: (Bridge & { client: Rect })[],
  guards: (Guard & { client: Rect })[],
  glyphs: { id: string; size: number; role: string; rects: Rect[] }[]
) {
  return page.evaluate(
    async ({ before, after, referenceRects, bridges, guards, glyphs, criteria }) => {
      async function decode(base64: string) {
        const bitmap = await createImageBitmap(
          new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], { type: 'image/png' })
        )
        const canvas = document.createElement('canvas') // detached，仅解码原样 PNG，不写产品 DOM 或配色。
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
      // tuple: x, y, beforeRGB, afterRGB, beforeWhiteDistance, afterWhiteDistance, deltaToReference
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
          whiteFractionAfter: raw.length ? raw.filter(sample => white(sample.slice(5, 8) as number[])).length / raw.length : null,
          minimumColumnBlueFraction: columns.length ? Math.min(...columns.map(group => group.blueFraction)) : null,
          minimumRowBlueFraction: rows.length ? Math.min(...rows.map(group => group.blueFraction)) : null
        }
      })
      const measuredGuards = guards.map(guard => {
        const raw = collect([guard.client], 'white')
        for (const sample of raw) sample[10] = difference(sample)
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
            raw.length && referenceValid ? raw.filter(sample => sample[10]! >= criteria.inkMinimumContrastFromBlue).length / raw.length : null
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

async function runContinuityCase(caseId: CaseId, percent: 100 | 150): Promise<void> {
  const info = test.info()
  const { app, page } = await launchApp(await createTestData(), { deviceScaleFactor: 1 })
  const spec: SelectionSpec = manifest.selections[caseId]
  const activeRows = caseId === 'fullFiveRows' ? manifest.selectedRows : manifest.selectedRows.slice(0, 2)
  const unselectedRows = caseId === 'fullFiveRows' ? [] : manifest.selectedRows.slice(2)
  const selectedIds = activeRows.flatMap(row => row.partIds)
  const unselectedIds = unselectedRows.flatMap(row => row.partIds)
  const referenceBodyIds = caseId === 'fullFiveRows' ? manifest.reference.fullFiveRowsBodyPartIds : manifest.reference.proseTwoRowsBodyPartIds

  const evidence: Record<string, unknown> = {
    fixture: manifest.file,
    caseId,
    percent,
    selection: spec,
    activeRows,
    criteria,
    phases: []
  }
  const phases = evidence.phases as unknown[]
  let before: Buffer | undefined
  let after: Buffer | undefined
  let held = false
  let stage = 'script-precondition'

  try {
    expect(spec.normalization).toBe('remove-whitespace-only')
    const pageSpec = manifest.pages.find(value => value.number === spec.pageNumber)!
    expect(pageSpec.rotation).toBe(0)

    await importFixture(app, page, 'verification/selection-continuity/' + manifest.file.name)
    const element = page.locator(`.pdf-page[data-page-number="${spec.pageNumber}"]`)
    await expect(element).toHaveAttribute('data-rendered', 'true', { timeout: 30000 })

    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await page.getByTestId('zoom-level').innerText()) === '50%') break
      await page.getByRole('button', { name: '缩小', exact: true }).click()
    }
    await expect(page.getByTestId('zoom-level')).toHaveText('50%')
    for (let step = 0; step < (percent - 50) / 10; step++) {
      await page.getByRole('button', { name: '放大', exact: true }).click()
    }
    await expect(page.getByTestId('zoom-level')).toHaveText(`${percent}%`)
    await expect.poll(async () => Math.abs((await frame(page, spec.pageNumber)).canvas.width - (pageSpec.width * percent) / 100)).toBeLessThan(0.1)
    await expect(element).toHaveAttribute('data-rendered', 'true')

    const initial = await frame(page, spec.pageNumber)
    const initialStart = toClient(spec.pageNumber, spec.start, initial)
    const initialEnd = toClient(spec.pageNumber, spec.end, initial)
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

    const prepared = await frame(page, spec.pageNumber)
    const start = toClient(spec.pageNumber, spec.start, prepared)
    const end = toClient(spec.pageNumber, spec.end, prepared)
    const bridges = (manifest.bridgeCandidates as Bridge[])
      .filter(candidate => candidate.cases.includes(caseId))
      .map(candidate => ({ ...candidate, client: clientWindow(candidate.pdfWindow, spec.pageNumber, prepared) }))
    const guards = (manifest.guardWindows as Guard[])
      .filter(guard => guard.cases.includes(caseId))
      .map(guard => ({ ...guard, client: clientWindow(guard.pdfWindow, spec.pageNumber, prepared) }))

    evidence.setup = { initial, prepared, start, end, bridges, guards }

    for (const point of [start, end]) {
      expect(point.x, '固定PDF点不得触发36px边缘自动滚动').toBeGreaterThan(prepared.reader.x + 36)
      expect(point.x).toBeLessThan(prepared.reader.x + prepared.reader.width - 36)
      expect(point.y).toBeGreaterThan(prepared.reader.y + 36)
      expect(point.y).toBeLessThan(prepared.reader.y + prepared.reader.height - 36)
    }
    for (const window of [...bridges, ...guards]) {
      expect(window.client.x, `${window.id}:像素窗必须完整可见`).toBeGreaterThanOrEqual(prepared.reader.x + 1)
      expect(window.client.y, `${window.id}:像素窗必须完整可见`).toBeGreaterThanOrEqual(prepared.reader.y + 1)
      expect(window.client.x + window.client.width, `${window.id}:像素窗必须完整可见`).toBeLessThanOrEqual(
        prepared.reader.x + prepared.reader.width - 1
      )
      expect(window.client.y + window.client.height, `${window.id}:像素窗必须完整可见`).toBeLessThanOrEqual(
        prepared.reader.y + prepared.reader.height - 1
      )
    }
    expect(prepared.hasFocus).toBe(true)

    await page.mouse.move(start.x, start.y)
    before = await page.screenshot({ scale: 'css', animations: 'disabled' })
    await page.mouse.down()
    held = true
    phases.push({ phase: 'mousedown', pointer: start, geometry: await frame(page, spec.pageNumber), selection: await snapshot(page, spec.pageNumber) })
    await page.mouse.move(end.x, end.y, { steps: 32 })
    phases.push({ phase: 'mousemove', pointer: end, geometry: await frame(page, spec.pageNumber), selection: await snapshot(page, spec.pageNumber) })
    await page.mouse.up()
    held = false
    await settled(page)

    after = await page.screenshot({ scale: 'css', animations: 'disabled' })
    const shotPath = process.env.PAPERFLOW_CONTINUITY_SHOT?.trim()
    if (caseId === 'fullFiveRows' && percent === 100 && shotPath) {
      await mkdir(dirname(shotPath), { recursive: true })
      await writeFile(shotPath, after)
    }

    const selected = await snapshot(page, spec.pageNumber)
    const finished = await frame(page, spec.pageNumber)
    phases.push({ phase: 'mouseup', pointer: end, geometry: finished, selection: selected })

    const sentinel = `continuity-copy-sentinel-${caseId}-${percent}`
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), sentinel)
    await page.keyboard.press('Control+C')
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
    evidence.clipboard = clipboard

    // 先验证真实 Selection 与 Ctrl+C 内容，避免内容残缺伪装成视觉问题。
    stage = 'selection-content'
    expect(canonical(selected.text), `${caseId}:真实Selection必须完整包含目标行`).toBe(canonical(spec.expectedText))
    expect(canonical(clipboard), `${caseId}:真实Ctrl+C必须匹配完整目标文本`).toBe(canonical(spec.expectedText))
    expect(selected.anchor.page).toBe(String(spec.pageNumber))
    expect(selected.focus.page).toBe(String(spec.pageNumber))
    for (const excluded of manifest.excludedRuns) {
      expect(canonical(selected.text), `未选run(${excluded.id})不得进入Selection`).not.toContain(canonical(excluded.text))
      expect(canonical(clipboard), `未选run(${excluded.id})不得进入Clipboard`).not.toContain(canonical(excluded.text))
    }
    for (const row of unselectedRows) {
      expect(canonical(selected.text), `未选行(${row.id})不得进入Selection`).not.toContain(canonical(row.text))
      expect(canonical(clipboard), `未选行(${row.id})不得进入Clipboard`).not.toContain(canonical(row.text))
    }
    evidence.contentVerified = true

    stage = 'script-precondition'
    expect(finished.hasFocus).toBe(prepared.hasFocus)
    expect(finished.continuousSelectionAttr, '连续选区应启用单透明度SVG路径渲染').toBe(true)
    expect(finished.selectionPathLength).toBeGreaterThan(0)
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(finished.canvas[key] - prepared.canvas[key]), '前后Canvas几何必须稳定').toBeLessThanOrEqual(
        criteria.maximumGeometryDriftCss
      )
      expect(Math.abs(finished.reader[key] - prepared.reader[key]), '前后Reader几何必须稳定').toBeLessThanOrEqual(
        criteria.maximumGeometryDriftCss
      )
    }
    for (const key of ['scrollTop', 'scrollLeft'] as const) {
      expect(Math.abs(finished[key] - prepared[key])).toBeLessThanOrEqual(criteria.maximumGeometryDriftCss)
    }

    const selectedParts = selected.measuredParts.filter(part => selectedIds.includes(part.id))
    expect(selectedParts.length).toBe(selectedIds.length)
    for (const part of selectedParts) {
      expect(part.found && part.fullySelected && part.rects.length > 0, `${part.id}:只读Range必须属于实际完整选区`).toBe(true)
    }
    const unselectedParts = selected.measuredParts.filter(part => unselectedIds.includes(part.id))
    for (const part of unselectedParts) {
      expect(part.found, `${part.id}:未选行不应落在选区内`).toBe(false)
      expect(part.fullySelected).toBe(false)
    }

    const referenceRects = selectedParts.filter(part => referenceBodyIds.includes(part.id)).flatMap(part => part.rects)
    const glyphs: { id: string; size: number; role: string; rects: Rect[] }[] = selectedParts.map(part => ({
      id: part.id,
      size: part.size,
      role: part.role,
      rects: part.rects
    }))
    if (caseId === 'fullFiveRows') {
      const inlineChainIds = ['r4-op2', 'r4-sub-a', 'r4-dots', 'r4-op3', 'r4-sub-e']
      glyphs.push({
        id: 'r4-inline-chain',
        size: 15,
        role: 'operator',
        rects: selectedParts.filter(part => inlineChainIds.includes(part.id)).flatMap(part => part.rects)
      })
    }

    const measured = await pixelEvidence(page, before, after, referenceRects, bridges, guards, glyphs)
    evidence.pixels = measured
    expect(measured.beforeSize).toEqual(prepared.viewport)
    expect(measured.afterSize).toEqual(measured.beforeSize)
    expect(measured.reference.samples, '参考正文白底样本不足').toBeGreaterThanOrEqual(criteria.referenceMinimumSamples)
    expect(measured.reference.tintedSamples).toBeGreaterThanOrEqual(criteria.referenceMinimumSamples)
    expect(measured.reference.tintedFraction, '参考正文必须已着色').toBeGreaterThanOrEqual(criteria.referenceMinimumTintedFraction)
    expect(measured.reference.blueBias!, '必须能从选中普通正文估计参考蓝色').toBeGreaterThanOrEqual(criteria.referenceMinimumBlueBias)
    expect(measured.bridges.some(bridge => bridge.kind === 'horizontal')).toBe(true)
    expect(measured.bridges.some(bridge => bridge.kind === 'vertical')).toBe(true)

    for (const window of measured.bridges) {
      expect(window.samples, `${window.id}:连接窗白底样本不足`).toBeGreaterThanOrEqual(criteria.minimumWindowSamples)
      expect(window.columns.length, `${window.id}:连接窗列数不足`).toBeGreaterThanOrEqual(criteria.minimumWindowColumns)
      expect(window.rows.length, `${window.id}:连接窗行数不足`).toBeGreaterThanOrEqual(criteria.minimumWindowRows)
    }
    for (const guard of measured.guards) {
      expect(guard.samples, `${guard.id}:守卫白底样本不足`).toBeGreaterThanOrEqual(criteria.minimumGuardSamples)
    }
    for (const glyph of measured.glyphs) {
      const minSamples =
        (glyph.size < 12 && glyph.role === 'subscript') || glyph.id === 'r4-dots'
          ? criteria.inkMinimumTinySamples
          : criteria.inkMinimumSamples
      expect(glyph.samples, `${glyph.id}:真实glyph ink样本不足`).toBeGreaterThanOrEqual(minSamples)
    }
    evidence.samplingPrerequisitesVerified = true

    stage = 'product-selection-shape'
    for (const window of measured.bridges) {
      expect(window.blueFraction!, `${window.id}:所选水平或行间空隙应连续同蓝`).toBeGreaterThanOrEqual(criteria.minimumBridgeBlueFraction)
      expect(window.minimumColumnBlueFraction!, `${window.id}:不可残留竖向白缝`).toBeGreaterThanOrEqual(criteria.minimumAxisBlueFraction)
      expect(window.minimumRowBlueFraction!, `${window.id}:不可残留横向白缝`).toBeGreaterThanOrEqual(criteria.minimumAxisBlueFraction)
    }
    for (const guard of measured.guards) {
      expect(guard.whiteFractionAfter!, `${guard.id}:守卫区域应保持白底`).toBeGreaterThanOrEqual(criteria.minimumGuardWhiteFraction)
    }
    for (const glyph of measured.glyphs) {
      expect(glyph.preservedInkFraction!, `${glyph.id}:不得把真实glyph ink抹成蓝色空白`).toBeGreaterThanOrEqual(
        criteria.minimumPreservedInkFraction
      )
    }
  } catch (error) {
    evidence.failure = { category: stage, message: error instanceof Error ? error.message : String(error) }
    throw error
  } finally {
    if (held) await page.mouse.up().catch(() => {})
    try {
      if (before) await info.attach(`continuity-${caseId}-${percent}-before`, { body: before, contentType: 'image/png' })
      after ??= await page.screenshot({ scale: 'css', animations: 'disabled' }).catch(() => undefined)
      if (after) await info.attach(`continuity-${caseId}-${percent}-after`, { body: after, contentType: 'image/png' })
      evidence.finalSelection = await snapshot(page, spec.pageNumber).catch(() => null)
      evidence.finalGeometry = await frame(page, spec.pageNumber).catch(() => null)
      await info.attach(`continuity-${caseId}-${percent}-observations`, {
        body: Buffer.from(JSON.stringify(evidence, null, 2)),
        contentType: 'application/json'
      })
    } finally {
      await app.close()
    }
  }
}

for (const percent of [100, 150] as const) {
  test(`PFV continuity 5-row selection (font switches, wide underscripts, inline dots) at ${percent}pct DPR1`, async () => {
    await runContinuityCase('fullFiveRows', percent)
  })

  test(`PFV continuity prose-only Row 1 to Row 2 selection (zero math symbols) at ${percent}pct DPR1`, async () => {
    await runContinuityCase('proseTwoRows', percent)
  })
}
