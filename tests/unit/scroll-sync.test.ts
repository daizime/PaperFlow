import { describe, expect, test } from 'vitest'
import {
  computeSyncedScrollPosition,
  isEchoScroll,
  type ScrollMetrics
} from '../../src/renderer/src/features/translation/scroll-sync'

function makeMetrics(overrides: Partial<ScrollMetrics> = {}): ScrollMetrics {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 2000,
    scrollWidth: 900,
    clientHeight: 600,
    clientWidth: 500,
    ...overrides
  }
}

describe('scroll-sync pure helpers', () => {
  test('syncs vertical scroll 1:1 in pixels and clamps to target bounds', () => {
    const source = makeMetrics({ scrollTop: 420 })
    const target = makeMetrics({ scrollHeight: 1000, clientHeight: 600 })
    const res = computeSyncedScrollPosition(source, target, { top: 100, left: 0 })
    expect(res.top).toBe(400)
    expect(res.left).toBeNull()
  })

  test('syncs horizontal scroll proportionally when both sides overflow horizontally', () => {
    // sourceMaxX = 900 - 500 = 400; scrollLeft = 200 (50%)
    // targetMaxX = 900 - 260 = 640; expected = 320
    const source = makeMetrics({ scrollTop: 0, scrollLeft: 200, scrollWidth: 900, clientWidth: 500 })
    const target = makeMetrics({ scrollTop: 0, scrollLeft: 0, scrollWidth: 900, clientWidth: 260 })
    const res = computeSyncedScrollPosition(source, target, { top: 0, left: 0 })
    expect(res.top).toBeNull()
    expect(res.left).toBe(320)
  })

  test('preserves target horizontal scroll (returns left: null) when source has no horizontal overflow', () => {
    const source = makeMetrics({ scrollTop: 300, scrollLeft: 0, scrollWidth: 600, clientWidth: 700 })
    const target = makeMetrics({ scrollTop: 50, scrollLeft: 180, scrollWidth: 600, clientWidth: 250 })
    const res = computeSyncedScrollPosition(source, target, { top: 100, left: 0 }, true)
    expect(res.top).toBe(300)
    expect(res.left).toBeNull()
  })

  test('forceBothAxes synchronizes both axes when source has horizontal overflow', () => {
    const source = makeMetrics({ scrollTop: 512, scrollLeft: 100, scrollWidth: 900, clientWidth: 500 })
    const target = makeMetrics({ scrollTop: 0, scrollLeft: 0, scrollWidth: 900, clientWidth: 260 })
    const res = computeSyncedScrollPosition(source, target, { top: 512, left: 100 }, true)
    expect(res.top).toBe(512)
    expect(res.left).toBe(160)
  })

  test('isEchoScroll detects programmatic mirror writes inside tolerance window and expires properly', () => {
    const expected = { top: 320, left: 160, expiresAt: 1000 }
    expect(isEchoScroll(321, 159.2, expected, 950)).toBe(true)
    expect(isEchoScroll(330, 160, expected, 950)).toBe(false)
    expect(isEchoScroll(320, 160, expected, 1001)).toBe(false)
    expect(isEchoScroll(320, 160, null, 950)).toBe(false)
  })
})
