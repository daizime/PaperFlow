import { describe, expect, it } from 'vitest'
import { selectionBridges, type SelectionRun } from '../../src/renderer/src/features/reader/selection-bridges'

describe('公式与相邻行的选区连接', () => {
  it('用同一行带覆盖公式中分开的小段', () => {
    const runs: SelectionRun[] = [
      { rect: { x: 12, y: 10, width: 24, height: 20 }, baseline: 25, em: 16, math: false },
      { rect: { x: 43, y: 2, width: 13, height: 29 }, baseline: 25, em: 25, math: true },
      { rect: { x: 62, y: 10, width: 46, height: 20 }, baseline: 25, em: 16, math: false }
    ]
    expect(selectionBridges(runs)).toEqual([{ x: 12, y: 10, width: 96, height: 20 }])
  })

  it('只连接相邻两行实际选中范围的水平交集', () => {
    const runs: SelectionRun[] = [
      { rect: { x: 12, y: 10, width: 60, height: 20 }, baseline: 26, em: 16, math: true },
      { rect: { x: 36, y: 35, width: 51, height: 20 }, baseline: 51, em: 16, math: false },
      { rect: { x: 140, y: 35, width: 32, height: 20 }, baseline: 51, em: 16, math: false }
    ]
    expect(selectionBridges(runs)).toEqual([{ x: 36, y: 30, width: 36, height: 5 }])
  })

  it('把偏移的下标接在公式上，并连接到真实相邻行', () => {
    const runs: SelectionRun[] = [
      { rect: { x: 12, y: 10, width: 60, height: 20 }, baseline: 27, em: 18, math: true },
      { rect: { x: 20, y: 32, width: 15, height: 9 }, baseline: 38, em: 8, math: false },
      { rect: { x: 19, y: 44, width: 57, height: 20 }, baseline: 60, em: 18, math: false }
    ]
    expect(selectionBridges(runs)).toEqual(expect.arrayContaining([
      { x: 20, y: 30, width: 15, height: 2 }, { x: 19, y: 30, width: 53, height: 14 }
    ]))
  })

  it('覆盖大运算符为独立公式行带来的额外行距', () => {
    const runs: SelectionRun[] = [
      { rect: { x: 12, y: 16, width: 28, height: 23 }, baseline: 34, em: 18, math: false },
      { rect: { x: 49, y: 4, width: 20, height: 35 }, baseline: 35, em: 31, math: true },
      { rect: { x: 78, y: 16, width: 69, height: 23 }, baseline: 34, em: 18, math: false },
      { rect: { x: 22, y: 69, width: 106, height: 23 }, baseline: 87, em: 18, math: false }
    ]
    expect(selectionBridges(runs)).toContainEqual({ x: 22, y: 39, width: 106, height: 30 })
  })

  it('用可见高度归并基线偏低的大运算符，避免把它当作下一行', () => {
    const runs: SelectionRun[] = [
      { rect: { x: 64, y: 250, width: 9, height: 26 }, baseline: 270, em: 18, math: false },
      { rect: { x: 83, y: 226, width: 55, height: 75 }, baseline: 288, em: 72, math: true },
      { rect: { x: 144, y: 250, width: 9, height: 26 }, baseline: 270, em: 18, math: false },
      { rect: { x: 166, y: 250, width: 25, height: 26 }, baseline: 270, em: 18, math: true },
      { rect: { x: 64, y: 280, width: 355, height: 26 }, baseline: 300, em: 18, math: false }
    ]
    expect(selectionBridges(runs)).toEqual(expect.arrayContaining([
      { x: 64, y: 250, width: 127, height: 26 }, { x: 64, y: 276, width: 127, height: 4 }
    ]))
  })

  it('保留宽栏缝和段落空白，并连接相邻普通正文行', () => {
    const formula: SelectionRun = { rect: { x: 12, y: 9, width: 60, height: 20 }, baseline: 25, em: 16, math: true }
    const otherColumn: SelectionRun = { rect: { x: 100, y: 9, width: 74, height: 20 }, baseline: 25, em: 16, math: false }
    const nextParagraph: SelectionRun = { rect: { x: 12, y: 60, width: 60, height: 20 }, baseline: 76, em: 16, math: false }
    expect(selectionBridges([formula, otherColumn, nextParagraph])).toEqual([])
    const ordinary = { ...formula, math: false }
    const nextLine = { ...nextParagraph, rect: { ...nextParagraph.rect, y: 33 }, baseline: 49 }
    expect(selectionBridges([ordinary, nextLine])).toEqual([{ x: 12, y: 29, width: 60, height: 4 }])
  })

  it('无数学符号时也能桥接字体切换产生的行内碎缝与连续正文行', () => {
    const row1: SelectionRun[] = [
      { rect: { x: 48, y: 100, width: 42, height: 14 }, baseline: 111, em: 12, math: false },
      { rect: { x: 92, y: 100, width: 11, height: 14 }, baseline: 111, em: 12, math: false },
      { rect: { x: 105, y: 100, width: 24, height: 14 }, baseline: 111, em: 12, math: false },
      { rect: { x: 131, y: 100, width: 11, height: 14 }, baseline: 111, em: 12, math: false },
      { rect: { x: 144, y: 100, width: 80, height: 14 }, baseline: 111, em: 12, math: false }
    ]
    expect(selectionBridges(row1)).toEqual([{ x: 48, y: 100, width: 176, height: 14 }])

    const row2: SelectionRun = { rect: { x: 48, y: 118, width: 90, height: 14 }, baseline: 129, em: 12, math: false }
    const otherCol: SelectionRun = { rect: { x: 460, y: 100, width: 60, height: 14 }, baseline: 111, em: 12, math: false }
    const farPara: SelectionRun = { rect: { x: 48, y: 160, width: 120, height: 14 }, baseline: 171, em: 12, math: false }
    expect(selectionBridges([...row1, row2, otherCol, farPara])).toEqual([
      { x: 48, y: 114, width: 90, height: 4 },
      { x: 48, y: 100, width: 176, height: 14 }
    ])
  })

  it('将宽正下方下标并入宿主水平区间，消除大运算符两侧断缝并双向连接上下正文', () => {
    const upperProse: SelectionRun = { rect: { x: 48, y: 170, width: 202, height: 14 }, baseline: 181, em: 12, math: false }
    const eqLeft: SelectionRun = { rect: { x: 70, y: 200, width: 45, height: 14 }, baseline: 211, em: 12, math: false }
    const eqOp: SelectionRun = { rect: { x: 135, y: 194, width: 16, height: 23 }, baseline: 211, em: 20, math: true }
    const wideSub: SelectionRun = { rect: { x: 117, y: 219, width: 52, height: 9 }, baseline: 226, em: 8, math: false }
    const eqRight: SelectionRun = { rect: { x: 172, y: 200, width: 58, height: 14 }, baseline: 211, em: 12, math: false }
    const lowerProse: SelectionRun = { rect: { x: 48, y: 232, width: 212, height: 14 }, baseline: 243, em: 12, math: false }

    const bridges = selectionBridges([upperProse, eqLeft, eqOp, wideSub, eqRight, lowerProse])
    expect(bridges).toEqual(expect.arrayContaining([
      { x: 70, y: 200, width: 160, height: 14 },
      { x: 117, y: 214, width: 52, height: 5 },
      { x: 70, y: 184, width: 160, height: 16 },
      { x: 70, y: 214, width: 160, height: 18 }
    ]))
  })

  it('连续桥接行内宽下标、右侧紧邻下标与抬升居中点，且不把下一行误判为下标', () => {
    const inlineRuns: SelectionRun[] = [
      { rect: { x: 48, y: 300, width: 28, height: 14 }, baseline: 311, em: 12, math: false },
      { rect: { x: 96, y: 297, width: 15, height: 18 }, baseline: 311, em: 16, math: true },
      { rect: { x: 78, y: 318, width: 51, height: 9 }, baseline: 325, em: 8, math: false },
      { rect: { x: 131, y: 300, width: 44, height: 14 }, baseline: 311, em: 12, math: false },
      { rect: { x: 179, y: 298, width: 14, height: 17 }, baseline: 311, em: 15, math: true },
      { rect: { x: 194, y: 308, width: 6, height: 9 }, baseline: 315, em: 8, math: false },
      {
        rect: { x: 204, y: 295, width: 14, height: 17 },
        ink: { x: 204, y: 304, width: 14, height: 5 },
        baseline: 306,
        em: 12,
        math: true
      },
      { rect: { x: 222, y: 298, width: 14, height: 17 }, baseline: 311, em: 15, math: true },
      { rect: { x: 237, y: 308, width: 6, height: 9 }, baseline: 315, em: 8, math: false },
      { rect: { x: 244, y: 300, width: 96, height: 14 }, baseline: 311, em: 12, math: false },
      { rect: { x: 48, y: 326, width: 272, height: 14 }, baseline: 337, em: 12, math: false }
    ]

    const bridges = selectionBridges(inlineRuns)
    expect(bridges).toContainEqual({ x: 48, y: 300, width: 292, height: 17 })
    expect(bridges).toContainEqual({ x: 78, y: 314, width: 51, height: 4 })
    expect(bridges).toContainEqual({ x: 48, y: 314, width: 272, height: 12 })

    // 未裁剪的抬升英文句点序列同样并入同行，独立右侧下标亦补短横缝。
    const raisedDots: SelectionRun[] = [
      { rect: { x: 179, y: 298, width: 14, height: 17 }, baseline: 311, em: 15, math: true },
      { rect: { x: 194, y: 308, width: 6, height: 9 }, baseline: 315, em: 8, math: false },
      { rect: { x: 204, y: 296, width: 14, height: 14 }, baseline: 306, em: 12, math: false },
      { rect: { x: 222, y: 298, width: 14, height: 17 }, baseline: 311, em: 15, math: true },
      { rect: { x: 237, y: 308, width: 6, height: 9 }, baseline: 315, em: 8, math: false }
    ]
    const dotBridges = selectionBridges(raisedDots)
    expect(dotBridges).toContainEqual({ x: 179, y: 298, width: 57, height: 19 })
    expect(dotBridges).toContainEqual({ x: 236, y: 308, width: 1, height: 7 })
  })

  it('双栏与超距段落间隔不产生跨栏或跨段误连', () => {
    const left1: SelectionRun = { rect: { x: 48, y: 100, width: 160, height: 14 }, baseline: 111, em: 12, math: false }
    const left2: SelectionRun = { rect: { x: 48, y: 118, width: 160, height: 14 }, baseline: 129, em: 12, math: false }
    const right1: SelectionRun = { rect: { x: 320, y: 100, width: 160, height: 14 }, baseline: 111, em: 12, math: false }
    const right2: SelectionRun = { rect: { x: 320, y: 118, width: 160, height: 14 }, baseline: 129, em: 12, math: false }
    const farDisplayBelow: SelectionRun = { rect: { x: 48, y: 165, width: 160, height: 24 }, baseline: 184, em: 20, math: true }

    expect(selectionBridges([left1, left2, right1, right2, farDisplayBelow])).toEqual([
      { x: 48, y: 114, width: 160, height: 4 },
      { x: 320, y: 114, width: 160, height: 4 }
    ])
  })

  it('超大运算符不会吞并正常上标、下标和空格导致行带缩成小字号', () => {
    const runs: SelectionRun[] = [
      { rect: { x: 64, y: 250, width: 9, height: 26 }, baseline: 270, em: 18, math: false },
      { rect: { x: 73.5, y: 259, width: 3.3, height: 17 }, baseline: 277, em: 12, math: false },
      { rect: { x: 76.8, y: 259, width: 3, height: 17 }, baseline: 277, em: 12, math: false },
      {
        rect: { x: 82.8, y: 226, width: 55.3, height: 75 },
        ink: { x: 82.8, y: 238, width: 55.3, height: 63 },
        baseline: 288,
        em: 72,
        math: true
      },
      { rect: { x: 144.1, y: 250, width: 9, height: 26 }, baseline: 270, em: 18, math: false },
      { rect: { x: 153.6, y: 245, width: 6, height: 17 }, baseline: 258, em: 12, math: false },
      { rect: { x: 159.6, y: 245, width: 3, height: 17 }, baseline: 258, em: 12, math: false },
      { rect: { x: 165.6, y: 250, width: 25.1, height: 26 }, baseline: 270, em: 18, math: true }
    ]
    const bridges = selectionBridges(runs)
    expect(bridges).toHaveLength(1)
    expect(bridges[0].x).toBeCloseTo(64, 5)
    expect(bridges[0].y).toBeCloseTo(242.8, 5)
    expect(bridges[0].width).toBeCloseTo(126.7, 5)
    expect(bridges[0].height).toBeCloseTo(40.4, 5)
  })
})
