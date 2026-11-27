import { describe, expect, test } from 'vitest'
import {
  clampDockWidth,
  computeMaxFloatSize,
  computeResizedFloatingRect,
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH
} from '../../src/renderer/src/features/study/ai-chat-geometry'

describe('AI 对话悬浮窗四边四角缩放与尺寸限制', () => {
  const stage = { width: 1200, height: 800 }
  const origin = { x: 760, y: 40, width: 400, height: 490 }

  test('向左边框拖拽扩宽时保持右边界固定并向左侧伸展', () => {
    const next = computeResizedFloatingRect(origin, 'w', -150, 0, stage)
    expect(next.x + next.width).toBe(origin.x + origin.width)
    expect(next.x).toBe(610)
    expect(next.width).toBe(550)
    expect(next.height).toBe(490)
  })

  test('向左上角拖拽时同时调整位置与宽高，且固定右下角不动', () => {
    const next = computeResizedFloatingRect(origin, 'nw', -100, -25, stage)
    expect(next.x + next.width).toBe(origin.x + origin.width)
    expect(next.y + next.height).toBe(origin.y + origin.height)
    expect(next.x).toBe(660)
    expect(next.y).toBe(15)
    expect(next.width).toBe(500)
    expect(next.height).toBe(515)
  })

  test('向右下缩小时不会低于最小安全尺寸，放大时动态受限于视口比例而非死锁 600px', () => {
    const tiny = computeResizedFloatingRect({ x: 100, y: 100, width: 400, height: 490 }, 'se', -300, -300, stage)
    expect(tiny.width).toBe(MIN_FLOAT_WIDTH)
    expect(tiny.height).toBe(MIN_FLOAT_HEIGHT)

    const max = computeMaxFloatSize(stage)
    expect(max.maxWidth).toBeGreaterThan(600)
    const huge = computeResizedFloatingRect({ x: 20, y: 20, width: 400, height: 490 }, 'se', 950, 650, stage)
    expect(huge.width).toBeLessThanOrEqual(max.maxWidth)
    expect(huge.height).toBeLessThanOrEqual(max.maxHeight)
    expect(huge.width).toBeGreaterThan(600)
  })

  test('停靠抽屉宽度合理夹紧在 300-760px 区间', () => {
    expect(clampDockWidth(180)).toBe(300)
    expect(clampDockWidth(640, 1200)).toBe(640)
    expect(clampDockWidth(1000, 1200)).toBe(760)
  })
})
