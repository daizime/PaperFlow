import { describe, expect, test } from 'vitest'
import { buildHighlightPolygons } from '../../src/renderer/src/features/reader/highlight-polygon'

describe('highlight-polygon: unified rounded-corner orthogonal polygon union', () => {
  test('renders a single rectangle as a single 4-vertex closed rounded SVG path', () => {
    const polys = buildHighlightPolygons([{ x: 50, y: 100, width: 140, height: 12 }])
    expect(polys).toHaveLength(1)
    expect(polys[0].points).toHaveLength(4)
    expect(polys[0].path).toMatch(/^M .+ L .+ Q .+ Z$/)
  })

  test('fuses a stepped 3-line sentence with vertical leading gaps and sub-pixel margin jitter into 1 seamless polygon', () => {
    const steppedRects = [
      // Row 1: right half ("We next consider an alternative")
      { x: 168.2, y: 118, width: 121.8, height: 11 },
      // Row 2: full line width ("approach that decomposes a delta relation into a union of fac-") with 3px leading gap
      { x: 50.1, y: 132, width: 240.1, height: 11 },
      // Row 3: left third ("torizable relations.") with 3px leading gap & slight 0.3px left-edge jitter
      { x: 49.8, y: 146, width: 92, height: 11 }
    ]

    const polys = buildHighlightPolygons(steppedRects, { padX: 2, padY: 1, radius: 3.5 })
    expect(polys).toHaveLength(1)
    // Stepped 3-line staircase polygon without jagged inner gaps or edge notches:
    // Top-right step -> right edge -> mid-bottom step -> bottom-left -> top-left step (exactly 8 vertices)
    expect(polys[0].points).toHaveLength(8)
    expect(polys[0].path.match(/Z/g)).toHaveLength(1)
  })

  test('keeps two-column cross-column sentence fragments as 2 separate polygons', () => {
    const crossColumnRects = [
      { x: 54, y: 520, width: 160, height: 11 },
      { x: 326, y: 120, width: 150, height: 11 }
    ]
    const polys = buildHighlightPolygons(crossColumnRects)
    expect(polys).toHaveLength(2)
    expect(polys[0].points).toHaveLength(4)
    expect(polys[1].points).toHaveLength(4)
  })
})
