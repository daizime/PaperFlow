import { describe, expect, test } from 'vitest'
import {
  alignBlockSentences,
  computeColumnLeftEdges,
  computeColumnRightEdges,
  computeOverlayBlockIndent,
  getBlockTranslationSourceText,
  hitTestPageSentence,
  isTranslatableBlock,
  matchSelectionRegionsToSentences,
  resolveMirrorDragSelection,
  resolveOverlayBlockGeometries,
  splitTextWithInlineFormulas,
  splitTranslatedSentences
} from '../../src/renderer/src/features/translation/sentence-alignment'
import { computeStableTranslationBlockKey, type AnalyzedBlock, type AnalyzedSentence, type PageLayoutResult } from '../../src/renderer/src/features/reader/layout-analysis'
import {
  cleanSelectedQuoteText,
  mergeViewportLineRects,
  type PageRect
} from '../../src/renderer/src/features/reader/pdf-geometry'

function makeSentence(
  id: string,
  text: string,
  rects: PageRect[],
  order = 1
): AnalyzedSentence {
  return {
    id,
    pageNumber: 1,
    order,
    blockId: 'p1-b001',
    blockKind: 'paragraph',
    columnIndex: 1,
    text,
    rects,
    displayRects: rects,
    bounds: rects[0],
    displayBounds: rects[0],
    fragments: [],
    crossColumn: false
  }
}

describe('sentence-alignment: CJK/Latin sentence splitting, alignment, hit testing & selection lookup', () => {
  test('splits Chinese and mixed Latin/abbreviation sentences losslessly without breaking Fig. 1 or 3.14', () => {
    const cjk = '现代阅读器需要稳定的架构（如 Smith 等，2025）。如图 1 所示，比例因子为 3.14！这是第三句？是的。'
    const cjkSegs = splitTranslatedSentences(cjk)
    expect(cjkSegs.map(s => s.text)).toEqual([
      '现代阅读器需要稳定的架构（如 Smith 等，2025）。',
      '如图 1 所示，比例因子为 3.14！',
      '这是第三句？',
      '是的。'
    ])
    expect(cjkSegs.map(s => s.text).join('')).toBe(cjk)

    const en = 'As shown in Fig. 1 (e.g., Smith et al., 2025), alpha is 3.14. Second sentence follows cleanly!'
    const enSegs = splitTranslatedSentences(en)
    expect(enSegs.map(s => s.text)).toEqual([
      'As shown in Fig. 1 (e.g., Smith et al., 2025), alpha is 3.14. ',
      'Second sentence follows cleanly!'
    ])
    expect(enSegs.map(s => s.text).join('')).toBe(en)

    const single = '没有内部句号的标题文本'
    expect(splitTranslatedSentences(single)).toEqual([{ index: 0, text: single, start: 0, end: single.length }])
  })

  test('aligns 1:1 equal sentence counts as well as N->M merged/split translations bidirectionally', () => {
    const s1 = makeSentence('s1', 'First sentence is relatively brief.', [{ x: 50, y: 650, width: 180, height: 10 }], 1)
    const s2 = makeSentence('s2', 'Second sentence explains experimental methodology.', [{ x: 50, y: 635, width: 200, height: 10 }], 2)
    const s3 = makeSentence('s3', 'Third sentence concludes cleanly.', [{ x: 50, y: 620, width: 150, height: 10 }], 3)

    // 2 -> 2 exact correspondence
    const exact = alignBlockSentences([s1, s2], '第一句简明扼要。第二句说明实验方法。')
    expect(exact.sourceToTarget.get('s1')).toEqual([0])
    expect(exact.sourceToTarget.get('s2')).toEqual([1])
    expect(exact.targetToSource.get(0)).toEqual(['s1'])
    expect(exact.targetToSource.get(1)).toEqual(['s2'])

    // 3 -> 2 merged correspondence: every source and every target must remain mapped
    const merged = alignBlockSentences([s1, s2, s3], '第一句简述并在前半部分衔接核心实验方法。随后第二部分完整给出实验方法并简明收尾结论。')
    expect(merged.sourceToTarget.get('s1')!.length).toBeGreaterThanOrEqual(1)
    expect(merged.sourceToTarget.get('s2')!.length).toBeGreaterThanOrEqual(1)
    expect(merged.sourceToTarget.get('s3')!.length).toBeGreaterThanOrEqual(1)
    expect(merged.targetToSource.get(0)!.length).toBeGreaterThanOrEqual(1)
    expect(merged.targetToSource.get(1)!.length).toBeGreaterThanOrEqual(1)

    // 2 -> 3 split correspondence
    const split = alignBlockSentences([s1, s2], '第一句较短。第二句被译文拆分。补充细节结尾。')
    expect(split.targetToSource.get(0)).toEqual(['s1'])
    expect(split.targetToSource.get(1)!.length).toBeGreaterThanOrEqual(1)
    expect(split.targetToSource.get(2)!.length).toBeGreaterThanOrEqual(1)
  })

  test('hitTestPageSentence & matchSelectionRegionsToSentences accurately match coordinates while rejecting whitespace/tiny touches', () => {
    const s1 = makeSentence('s1', 'Alpha sentence.', [{ x: 54, y: 650, width: 160, height: 10 }], 1)
    const s2 = makeSentence('s2', 'Beta sentence.', [{ x: 54, y: 634, width: 160, height: 10 }], 2)
    const block: AnalyzedBlock = {
      id: 'p1-b001',
      pageNumber: 1,
      order: 1,
      kind: 'paragraph',
      columnIndex: 1,
      fontSize: 10,
      isBold: false,
      bounds: { x: 54, y: 634, width: 160, height: 26 },
      displayBounds: { x: 54, y: 132, width: 160, height: 26 },
      sentences: [s1, s2]
    }
    const layout: PageLayoutResult = {
      pageNumber: 1,
      naturalWidth: 612,
      naturalHeight: 792,
      columnCount: 2,
      bodyFontSize: 10,
      hasText: true,
      blocks: [block],
      sentences: [s1, s2],
      filteredItems: []
    }
    const expectedKey = computeStableTranslationBlockKey(block)

    expect(hitTestPageSentence(layout, { x: 90, y: 655 })?.sentence.id).toBe('s1')
    expect(hitTestPageSentence(layout, { x: 90, y: 633 })?.sentence.id).toBe('s2') // within 1.5pt edge tolerance
    expect(hitTestPageSentence(layout, { x: 400, y: 300 })).toBeNull()

    const layoutsMap = new Map([[1, layout]])
    // 真实覆盖 s1 并且仅擦边接触 s2 不足 0.5pt（不应误命中 s2）
    const singleMatch = matchSelectionRegionsToSentences(layoutsMap, [
      { pageNumber: 1, rect: { x: 60, y: 649.6, width: 80, height: 9 } }
    ])
    expect(singleMatch?.sentenceIds).toEqual(['s1'])
    expect(singleMatch?.blockKeys).toEqual([expectedKey])

    // 跨两句选区同时命中 s1 和 s2
    const multiMatch = matchSelectionRegionsToSentences(layoutsMap, [
      { pageNumber: 1, rect: { x: 60, y: 651, width: 80, height: 8 } },
      { pageNumber: 1, rect: { x: 60, y: 636, width: 80, height: 8 } }
    ])
    expect(multiMatch?.sentenceIds).toEqual(['s1', 's2'])
  })

  test('does not leak into preceding same-line sentence on proportional overshoot, vertical bleed, or tight seam clicks', () => {
    const s1 = makeSentence(
      's1',
      'Factorizable updates arise in many domains such as linear algebra and machine learning.',
      [
        { x: 54, y: 650, width: 220, height: 10 },
        { x: 54, y: 638, width: 120, height: 10 }
      ],
      1
    )
    const s2 = makeSentence(
      's2',
      'Section 8 demonstrates how our framework can be used for the incremental evaluation of matrix chain multiplication, recovering prior work on this [44].',
      [
        { x: 166, y: 638, width: 108, height: 10 },
        { x: 54, y: 626, width: 220, height: 10 },
        { x: 54, y: 614, width: 220, height: 10 },
        { x: 54, y: 602, width: 22, height: 10 }
      ],
      2
    )
    const s3 = makeSentence(
      's3',
      'Matrix chain computation can be phrased in our language.',
      [{ x: 80, y: 602, width: 194, height: 10 }],
      3
    )

    const block: AnalyzedBlock = {
      id: 'p1-b001',
      pageNumber: 1,
      order: 1,
      kind: 'paragraph',
      columnIndex: 1,
      fontSize: 10,
      isBold: false,
      bounds: { x: 54, y: 602, width: 220, height: 58 },
      displayBounds: { x: 54, y: 132, width: 220, height: 58 },
      sentences: [s1, s2, s3]
    }
    const layout: PageLayoutResult = {
      pageNumber: 1,
      naturalWidth: 612,
      naturalHeight: 792,
      columnCount: 2,
      bodyFontSize: 10,
      hasText: true,
      blocks: [block],
      sentences: [s1, s2, s3],
      filteredItems: []
    }
    const layoutsMap = new Map([[1, layout]])

    const s2FullText =
      'Section 8 demonstrates how our framework can be used for the incremental evaluation of matrix chain multiplication, recovering prior work on this [44].'

    // A. DOM selection rect on line 2 (y=637..651) bleeds 1pt vertically into s1 line 1 and overlaps s1 line 2 by 8pt
    const lineRegions = [
      { pageNumber: 1, rect: { x: 166, y: 637, width: 108, height: 14 } },
      { pageNumber: 1, rect: { x: 54, y: 625, width: 220, height: 13 } },
      { pageNumber: 1, rect: { x: 54, y: 613, width: 220, height: 13 } },
      { pageNumber: 1, rect: { x: 54, y: 601, width: 22, height: 13 } }
    ]
    expect(matchSelectionRegionsToSentences(layoutsMap, lineRegions)?.sentenceIds).toEqual(['s2'])
    expect(matchSelectionRegionsToSentences(layoutsMap, lineRegions, s2FullText)?.sentenceIds).toEqual(['s2'])

    // B. Extreme 18pt horizontal overshoot into s1 on line 2 is still pruned via selectedText boundary matching
    const overshootRegions = [
      { pageNumber: 1, rect: { x: 156, y: 638, width: 118, height: 10 } },
      { pageNumber: 1, rect: { x: 54, y: 626, width: 220, height: 10 } },
      { pageNumber: 1, rect: { x: 54, y: 614, width: 220, height: 10 } },
      { pageNumber: 1, rect: { x: 54, y: 602, width: 22, height: 10 } }
    ]
    expect(matchSelectionRegionsToSentences(layoutsMap, overshootRegions, s2FullText)?.sentenceIds).toEqual(['s2'])

    // C. Genuine cross-sentence drag starting inside s1 tail keeps both s1 and s2
    const crossRegions = [
      { pageNumber: 1, rect: { x: 135, y: 638, width: 139, height: 10 } },
      { pageNumber: 1, rect: { x: 54, y: 626, width: 220, height: 10 } }
    ]
    expect(
      matchSelectionRegionsToSentences(layoutsMap, crossRegions, 'machine learning. Section 8 demonstrates how')
        ?.sentenceIds
    ).toEqual(['s1', 's2'])

    // D. Short single-word drag ("Section" / "Se") inside s2 matches only s2,
    //    keeps exact dragged rect in sourceRects while returning full enclosing sentence rects in sentenceRects
    const wordMatch = matchSelectionRegionsToSentences(
      layoutsMap,
      [{ pageNumber: 1, rect: { x: 167, y: 638, width: 28, height: 10 } }],
      'Section'
    )
    expect(wordMatch?.sentenceIds).toEqual(['s2'])
    expect(wordMatch?.sourceRects).toEqual([{ x: 167, y: 638, width: 28, height: 10 }])
    expect(wordMatch?.sentenceRects).toEqual(s2.rects)

    expect(
      matchSelectionRegionsToSentences(
        layoutsMap,
        [{ pageNumber: 1, rect: { x: 167, y: 638, width: 7, height: 10 } }],
        'Se'
      )?.sentenceIds
    ).toEqual(['s2'])

    // F. Slightly offset narrow single-word rect (10pt below s2) resolves via widened 12pt fallback
    expect(
      matchSelectionRegionsToSentences(
        layoutsMap,
        [{ pageNumber: 1, rect: { x: 60, y: 590, width: 14, height: 8 } }],
        '44'
      )?.sentenceIds
    ).toEqual(['s2'])

    // E. Interior point hit strictly inside s2 beats nearby s1 edge tolerance even if s1 has smaller area
    const smallS1 = makeSentence('s1-small', 'Short end.', [{ x: 100, y: 638, width: 65.5, height: 10 }], 1)
    const bigS2 = makeSentence('s2-big', 'Section 8 long sentence.', [{ x: 166, y: 638, width: 140, height: 10 }], 2)
    const tightLayout: PageLayoutResult = {
      ...layout,
      blocks: [{ ...block, sentences: [smallS1, bigS2] }],
      sentences: [smallS1, bigS2]
    }
    expect(hitTestPageSentence(tightLayout, { x: 166.5, y: 643 })?.sentence.id).toBe('s2-big')
  })

  test('resolveMirrorDragSelection supports mid-line reading sweeps, reverse drags, and whitespace marquee selection', () => {
    const makeDualSentence = (
      id: string,
      text: string,
      displayRects: PageRect[],
      rects: PageRect[],
      order: number
    ): AnalyzedSentence => ({
      id,
      pageNumber: 1,
      order,
      blockId: 'p1-b001',
      blockKind: 'paragraph',
      columnIndex: 1,
      text,
      rects,
      displayRects,
      bounds: rects[0],
      displayBounds: displayRects[0],
      fragments: [],
      crossColumn: false
    })

    // Top-down display Y: Line 1 y=140, Line 2 y=152, Line 3 y=164, Line 4 y=176
    const s1 = makeDualSentence(
      's1',
      'First sentence ending.',
      [
        { x: 54, y: 140, width: 220, height: 10 },
        { x: 54, y: 152, width: 112, height: 10 }
      ],
      [
        { x: 54, y: 642, width: 220, height: 10 },
        { x: 54, y: 630, width: 112, height: 10 }
      ],
      1
    )
    const s2 = makeDualSentence(
      's2',
      'Section 8 mid-line sentence.',
      [
        { x: 168, y: 152, width: 106, height: 10 },
        { x: 54, y: 164, width: 220, height: 10 },
        { x: 54, y: 176, width: 32, height: 10 }
      ],
      [
        { x: 168, y: 630, width: 106, height: 10 },
        { x: 54, y: 618, width: 220, height: 10 },
        { x: 54, y: 606, width: 32, height: 10 }
      ],
      2
    )
    const s3 = makeDualSentence(
      's3',
      'Third following sentence.',
      [{ x: 90, y: 176, width: 184, height: 10 }],
      [{ x: 90, y: 606, width: 184, height: 10 }],
      3
    )
    const layout: PageLayoutResult = {
      pageNumber: 1,
      naturalWidth: 612,
      naturalHeight: 792,
      columnCount: 2,
      bodyFontSize: 10,
      hasText: true,
      blocks: [
        {
          id: 'p1-b001',
          pageNumber: 1,
          order: 1,
          kind: 'paragraph',
          columnIndex: 1,
          fontSize: 10,
          isBold: false,
          bounds: { x: 54, y: 606, width: 220, height: 46 },
          displayBounds: { x: 54, y: 140, width: 220, height: 46 },
          sentences: [s1, s2, s3]
        }
      ],
      sentences: [s1, s2, s3],
      filteredItems: []
    }

    // 1. Mid-line sweep inside s2 only (Line 2 right -> Line 4 left): selects ONLY s2
    const onlyS2 = resolveMirrorDragSelection(layout, { x: 170, y: 157 }, { x: 75, y: 181 })
    expect(onlyS2?.sentenceIds).toEqual(['s2'])
    expect(onlyS2?.usedMarquee).toBe(false)

    // 2. Cross-sentence forward and reverse sweep (s1 <-> s2)
    expect(resolveMirrorDragSelection(layout, { x: 80, y: 145 }, { x: 120, y: 169 })?.sentenceIds).toEqual(['s1', 's2'])
    expect(resolveMirrorDragSelection(layout, { x: 120, y: 169 }, { x: 80, y: 145 })?.sentenceIds).toEqual(['s1', 's2'])

    // 3. Marquee starting in blank left margin covering s2's Line 3 while barely grazing s1 Line 2 vertically by 1pt
    const marqueeS2 = resolveMirrorDragSelection(layout, { x: 10, y: 161 }, { x: 260, y: 173 })
    expect(marqueeS2?.sentenceIds).toEqual(['s2'])
    expect(marqueeS2?.usedMarquee).toBe(true)
  })

  test('computeOverlayBlockIndent restores multi-line and single-line paragraph indentation while ignoring bearings/headings', () => {
    const makeBlock = (
      id: string,
      kind: AnalyzedBlock['kind'],
      columnIndex: number,
      displayBounds: PageRect,
      firstRect: PageRect
    ): AnalyzedBlock => ({
      id,
      pageNumber: 9,
      order: 1,
      kind,
      columnIndex,
      fontSize: 10,
      isBold: kind === 'heading',
      bounds: displayBounds,
      displayBounds,
      sentences: [
        makeSentence(`${id}-s1`, 'Sample text.', [firstRect], 1).bounds
          ? {
              ...makeSentence(`${id}-s1`, 'Sample text.', [firstRect], 1),
              displayRects: [firstRect]
            }
          : makeSentence(`${id}-s1`, 'Sample text.', [firstRect], 1)
      ]
    })

    const multiLineIndented = makeBlock(
      'b-multi',
      'paragraph',
      1,
      { x: 51, y: 370.8, width: 238.1, height: 47.8 },
      { x: 62.4, y: 370.8, width: 226.7, height: 10.5 }
    )
    const flushLeft = makeBlock(
      'b-flush',
      'paragraph',
      2,
      { x: 306.2, y: 212.5, width: 238.1, height: 35.4 },
      { x: 306.2, y: 212.5, width: 238.1, height: 10.5 }
    )
    const singleLineIndented = makeBlock(
      'b-single',
      'paragraph',
      2,
      { x: 317.5, y: 388.8, width: 226.8, height: 10.5 },
      { x: 317.5, y: 388.8, width: 226.8, height: 10.5 }
    )
    const tinyItalicBearing = makeBlock(
      'b-italic',
      'paragraph',
      1,
      { x: 51, y: 668, width: 238.1, height: 47.8 },
      { x: 52.6, y: 668, width: 236.5, height: 10.5 }
    )
    const centeredFormulaText = makeBlock(
      'b-centered',
      'paragraph',
      2,
      { x: 363.1, y: 261.8, width: 47.3, height: 13.4 },
      { x: 363.1, y: 261.8, width: 47.3, height: 13.4 }
    )
    const headingBlock = makeBlock(
      'b-heading',
      'heading',
      1,
      { x: 62.4, y: 194.7, width: 121.6, height: 12.6 },
      { x: 62.4, y: 194.7, width: 121.6, height: 12.6 }
    )

    const colLefts = computeColumnLeftEdges([
      multiLineIndented,
      flushLeft,
      singleLineIndented,
      tinyItalicBearing,
      centeredFormulaText,
      headingBlock
    ])
    expect(colLefts.get(1)).toBe(51)
    expect(colLefts.get(2)).toBe(306.2)

    expect(computeOverlayBlockIndent(multiLineIndented, colLefts)).toEqual({
      anchorX: 51,
      anchorWidth: 238.1,
      firstLineIndent: 11.4
    })
    expect(computeOverlayBlockIndent(singleLineIndented, colLefts)).toEqual({
      anchorX: 306.2,
      anchorWidth: 238.1,
      firstLineIndent: 11.3
    })
    expect(computeOverlayBlockIndent(flushLeft, colLefts)).toEqual({
      anchorX: 306.2,
      anchorWidth: 238.1,
      firstLineIndent: 0
    })
    expect(computeOverlayBlockIndent(tinyItalicBearing, colLefts)).toEqual({
      anchorX: 51,
      anchorWidth: 238.1,
      firstLineIndent: 0
    })
    expect(computeOverlayBlockIndent(centeredFormulaText, colLefts)).toEqual({
      anchorX: 363.1,
      anchorWidth: 47.3,
      firstLineIndent: 0
    })
    expect(computeOverlayBlockIndent(headingBlock, colLefts)).toEqual({
      anchorX: 62.4,
      anchorWidth: 121.6,
      firstLineIndent: 0
    })
  })

  test('isTranslatableBlock keeps all prose/heading/caption blocks translatable while skipping formulas, pure digits, and symbol/control fragments', () => {
    const buildBlock = (kind: AnalyzedBlock['kind'], text: string): AnalyzedBlock => ({
      id: `blk-${kind}`,
      pageNumber: 1,
      order: 1,
      kind,
      columnIndex: 1,
      fontSize: 10,
      isBold: false,
      bounds: { x: 50, y: 500, width: 120, height: 12 },
      displayBounds: { x: 50, y: 150, width: 120, height: 12 },
      sentences: text ? [makeSentence('s-test', text, [{ x: 50, y: 500, width: 120, height: 10 }])] : []
    })

    expect(isTranslatableBlock(buildBlock('heading', 'Abstract'))).toBe(true)
    expect(isTranslatableBlock(buildBlock('heading', '6 Factorizable updates'))).toBe(true)
    expect(isTranslatableBlock(buildBlock('paragraph', 'The delta view computes δS[A, C] in O(1) time.'))).toBe(true)
    expect(isTranslatableBlock(buildBlock('caption', 'Fig. 7 Creating a delta view tree.'))).toBe(true)
    expect(isTranslatableBlock(buildBlock('list-item', '[1] First item in list.'))).toBe(true)

    expect(isTranslatableBlock(buildBlock('formula', 'E = mc^2 (1)'))).toBe(false)
    expect(isTranslatableBlock(buildBlock('table', 'DRAM 5000 0.1 92.0'))).toBe(false)
    expect(isTranslatableBlock(buildBlock('figure', 'Client RDMA Read'))).toBe(false)
    expect(isTranslatableBlock(buildBlock('paragraph', ''))).toBe(false)
    expect(isTranslatableBlock(buildBlock('paragraph', '123'))).toBe(false)
    expect(isTranslatableBlock(buildBlock('paragraph', '\u0005\u0006'))).toBe(false)
    expect(isTranslatableBlock(buildBlock('paragraph', '︸ ︸'))).toBe(false)
  })

  test('getBlockTranslationSourceText & splitTextWithInlineFormulas map placeholders and omit stray tokens cleanly', () => {
    const formula = {
      token: '⟪M1⟫',
      fallbackText: 'δVRST@A',
      displayRect: { x: 100, y: 200, width: 24, height: 14 },
      baselineY: 210,
      lineFontSize: 10
    }
    const blockWithInline: AnalyzedBlock = {
      id: 'b-inline',
      pageNumber: 9,
      order: 1,
      kind: 'paragraph',
      columnIndex: 2,
      fontSize: 10,
      isBold: false,
      bounds: { x: 50, y: 500, width: 180, height: 14 },
      displayBounds: { x: 50, y: 200, width: 180, height: 14 },
      sentences: [makeSentence('s-in', 'Compute δVRST@A efficiently.', [{ x: 50, y: 500, width: 180, height: 10 }])],
      inlineFormulas: [formula],
      translationSourceText: 'Compute ⟪M1⟫ efficiently.'
    }
    expect(getBlockTranslationSourceText(blockWithInline)).toBe('Compute ⟪M1⟫ efficiently.')
    expect(splitTextWithInlineFormulas('高效计算 ⟪M1⟫ 以及 ⟪M99⟫ 结束。', blockWithInline.inlineFormulas)).toEqual([
      { kind: 'text', text: '高效计算 ' },
      { kind: 'formula', formula },
      { kind: 'text', text: ' 以及 ' },
      { kind: 'text', text: ' 结束。' }
    ])
  })

  test('partial drag selection preserves exact region rects without expanding to full sentence bounds and cleans quote text', () => {
    const fullSentence = makeSentence(
      's1',
      'This avoids cache line invalidations for latch acquisition and is crucial for making reads scalable on multi-core CPUs.',
      [
        { x: 54, y: 650, width: 220, height: 10 },
        { x: 54, y: 638, width: 220, height: 10 }
      ],
      1
    )
    const block: AnalyzedBlock = {
      id: 'p1-b001',
      pageNumber: 1,
      order: 1,
      kind: 'paragraph',
      columnIndex: 1,
      fontSize: 10,
      isBold: false,
      bounds: { x: 54, y: 638, width: 220, height: 22 },
      displayBounds: { x: 54, y: 132, width: 220, height: 22 },
      sentences: [fullSentence]
    }
    const layout: PageLayoutResult = {
      pageNumber: 1,
      naturalWidth: 612,
      naturalHeight: 792,
      columnCount: 2,
      bodyFontSize: 10,
      hasText: true,
      blocks: [block],
      sentences: [fullSentence],
      filteredItems: []
    }
    const partialRects = [
      { x: 108, y: 650, width: 166, height: 10 },
      { x: 54, y: 638, width: 132, height: 10 }
    ]
    const matched = matchSelectionRegionsToSentences(
      new Map([[1, layout]]),
      partialRects.map(rect => ({ pageNumber: 1, rect })),
      'line invalidations for latch acquisition\nand is crucial'
    )
    expect(matched?.sentenceIds).toEqual(['s1'])
    expect(matched?.sourceRects).toEqual(partialRects)

    expect(
      mergeViewportLineRects([
        { x: 20, y: 100, width: 32, height: 12 },
        { x: 55, y: 100, width: 48, height: 12 },
        { x: 320, y: 100, width: 40, height: 12 },
        { x: 20, y: 116, width: 80, height: 12 }
      ])
    ).toEqual([
      { x: 20, y: 100, width: 83, height: 12 },
      { x: 320, y: 100, width: 40, height: 12 },
      { x: 20, y: 116, width: 80, height: 12 }
    ])

    expect(cleanSelectedQuoteText('invalida-\ntions \u0007\uFB01x  line')).toBe('invalidations fix line')
    expect(cleanSelectedQuoteText('   \n\t  ')).toBeNull()
  })

  test('matches single narrow words, common tokens near same-line seams, and proportional seam drifts accurately', () => {
    const s1 = makeSentence(
      's1',
      'We evaluate in the early setup with fast caching.',
      [
        { x: 54, y: 650, width: 220, height: 10 },
        { x: 54, y: 638, width: 112, height: 10 }
      ],
      1
    )
    const s2 = makeSentence(
      's2',
      'In contrast, dual-column mode preserves equation layout.',
      [
        { x: 168, y: 638, width: 106, height: 10 },
        { x: 54, y: 626, width: 220, height: 10 }
      ],
      2
    )
    const block: AnalyzedBlock = {
      id: 'p1-b001',
      pageNumber: 1,
      order: 1,
      kind: 'paragraph',
      columnIndex: 1,
      fontSize: 10,
      isBold: false,
      bounds: { x: 54, y: 626, width: 220, height: 34 },
      displayBounds: { x: 54, y: 132, width: 220, height: 34 },
      sentences: [s1, s2]
    }
    const dualS1: AnalyzedSentence = {
      ...s1,
      displayRects: [
        { x: 54, y: 132, width: 220, height: 10 },
        { x: 54, y: 144, width: 112, height: 10 }
      ],
      displayBounds: { x: 54, y: 132, width: 220, height: 22 }
    }
    const dualS2: AnalyzedSentence = {
      ...s2,
      displayRects: [
        { x: 168, y: 144, width: 106, height: 10 },
        { x: 54, y: 156, width: 220, height: 10 }
      ],
      displayBounds: { x: 54, y: 144, width: 220, height: 22 }
    }
    const layout: PageLayoutResult = {
      pageNumber: 1,
      naturalWidth: 612,
      naturalHeight: 792,
      columnCount: 2,
      bodyFontSize: 10,
      hasText: true,
      blocks: [{ ...block, sentences: [dualS1, dualS2] }],
      sentences: [dualS1, dualS2],
      filteredItems: []
    }
    const layoutsMap = new Map([[1, layout]])

    // 1. Narrow single word ("in" at start of s2, grazing s1 seam) must prune s1 even though "in" appears earlier in s1
    const narrowIn = matchSelectionRegionsToSentences(
      layoutsMap,
      [{ pageNumber: 1, rect: { x: 164, y: 638, width: 7, height: 10 } }],
      'In'
    )
    expect(narrowIn?.sentenceIds).toEqual(['s2'])

    // 2. Proportional-split seam drift: DOM rect for "contrast" sits slightly inside s1's estimated box, text snaps to s2
    const seamDrift = matchSelectionRegionsToSentences(
      layoutsMap,
      [{ pageNumber: 1, rect: { x: 150, y: 638, width: 15, height: 10 } }],
      'contrast'
    )
    expect(seamDrift?.sentenceIds).toEqual(['s2'])

    // 3. Slightly vertically offset narrow selection falls back to center-point hit test
    const fallbackWord = matchSelectionRegionsToSentences(
      layoutsMap,
      [{ pageNumber: 1, rect: { x: 195, y: 636, width: 6, height: 2 } }],
      'dual'
    )
    expect(fallbackWord?.sentenceIds).toEqual(['s2'])

    // 4. Small single-line marquee in resolveMirrorDragSelection starting in margin whitespace that mostly covers s2 while grazing s1 selects only s2
    const smallMarquee = resolveMirrorDragSelection(layout, { x: 282, y: 145 }, { x: 164, y: 153 })
    expect(smallMarquee?.sentenceIds).toEqual(['s2'])
    expect(smallMarquee?.usedMarquee).toBe(true)
  })

  test('resolveOverlayBlockGeometries eliminates adjacent vertical overlaps across tight blocks, obstacles, and masks (合成素材)', () => {
    const mkBlock = (
      id: string,
      opts: {
        kind: AnalyzedBlock['kind']
        col: number
        fontSize: number
        rect: PageRect
        text?: string
        continued?: boolean
      }
    ): AnalyzedBlock => {
      const sentenceText = opts.text ?? ''
      const sentences: AnalyzedSentence[] = sentenceText
        ? [
            {
              id: `${id}-s1`,
              pageNumber: 1,
              order: 1,
              blockId: id,
              blockKind: opts.kind,
              columnIndex: opts.col,
              text: sentenceText,
              rects: [opts.rect],
              displayRects: [opts.rect],
              bounds: opts.rect,
              displayBounds: opts.rect,
              fragments: [],
              crossColumn: false
            }
          ]
        : []
      return {
        id,
        pageNumber: 1,
        order: 1,
        kind: opts.kind,
        columnIndex: opts.col,
        fontSize: opts.fontSize,
        isBold: opts.kind === 'caption',
        continuedFromPrevColumn: opts.continued,
        bounds: opts.rect,
        displayBounds: opts.rect,
        sentences
      }
    }

    // 1. 极紧邻的两段 7pt 版权/脚注（含 1pt 间隙与 -1pt 原始包围盒重叠）以及下方紧贴的短单行块
    const tightTop1 = mkBlock('b-top1', {
      kind: 'paragraph',
      col: 1,
      fontSize: 7,
      rect: { x: 54, y: 700, width: 220, height: 22 },
      text: 'Permission to make digital or hard copies.'
    })
    const tightNext2 = mkBlock('b-next2', {
      kind: 'paragraph',
      col: 1,
      fontSize: 7,
      rect: { x: 54, y: 721, width: 220, height: 32 },
      text: 'Copyrights for components owned by others must be honored.'
    })
    const shortLineAboveDoi = mkBlock('b-isbn', {
      kind: 'paragraph',
      col: 1,
      fontSize: 7.5,
      rect: { x: 54, y: 754, width: 180, height: 8 },
      text: 'ACM ISBN 978-1-4503-9249-5.'
    })
    const doiLine = mkBlock('b-doi', {
      kind: 'paragraph',
      col: 1,
      fontSize: 7.5,
      rect: { x: 54, y: 763, width: 190, height: 8 },
      text: 'https://doi.org/10.1145/3514221.3526187'
    })

    // 2. 题注紧邻不可译表格障碍物，及栏首空续句遮罩紧贴下一段
    const captionAboveTable = mkBlock('b-cap', {
      kind: 'caption',
      col: 2,
      fontSize: 9,
      rect: { x: 312, y: 120, width: 220, height: 10 },
      text: 'Table 1: Hardware metrics.'
    })
    const tableObstacle = mkBlock('b-tab', {
      kind: 'table',
      col: 2,
      fontSize: 9,
      rect: { x: 312, y: 131, width: 220, height: 60 },
      text: 'DRAM 5000 0.1 92.0'
    })
    const prevColMask = mkBlock('b-mask', {
      kind: 'paragraph',
      col: 2,
      fontSize: 9.5,
      rect: { x: 312, y: 210, width: 220, height: 18 },
      continued: true
    })
    const afterMask = mkBlock('b-after-mask', {
      kind: 'paragraph',
      col: 2,
      fontSize: 9.5,
      rect: { x: 312, y: 229, width: 220, height: 42 },
      text: 'However, in-memory DBMSs incur high costs.'
    })
    // 3. 间距充裕的普通正文（允许适度往下扩高，且不受另一栏影响）
    const spacedPara = mkBlock('b-spaced', {
      kind: 'paragraph',
      col: 2,
      fontSize: 10,
      rect: { x: 312, y: 290, width: 220, height: 32 },
      text: 'A spacious paragraph with generous vertical gap.'
    })
    const belowSpaced = mkBlock('b-below-spaced', {
      kind: 'paragraph',
      col: 2,
      fontSize: 10,
      rect: { x: 312, y: 342, width: 220, height: 30 },
      text: 'Following section continues normally.'
    })

    const layout: PageLayoutResult = {
      pageNumber: 1,
      naturalWidth: 612,
      naturalHeight: 792,
      columnCount: 2,
      bodyFontSize: 10,
      hasText: true,
      blocks: [
        tightTop1,
        tightNext2,
        shortLineAboveDoi,
        doiLine,
        captionAboveTable,
        tableObstacle,
        prevColMask,
        afterMask,
        spacedPara,
        belowSpaced
      ],
      sentences: [],
      filteredItems: []
    }

    const colLefts = computeColumnLeftEdges(layout.blocks)
    const colRights = new Map<number, number>([
      [1, 274],
      [2, 540]
    ])
    const solved = resolveOverlayBlockGeometries(layout, 1, colLefts, colRights)

    expect(solved.has('b-tab')).toBe(false)

    const g1 = solved.get('b-top1')!
    const g2 = solved.get('b-next2')!
    expect(g1.top + g1.height).toBeLessThanOrEqual(g2.top)
    expect(g1.tightBottom).toBe(true)
    expect(g2.tightTop).toBe(true)
    expect(g1.maxSafeHeight).toBe(g1.height)

    // 短单行不再因 15px 保底高度而侵占下一行
    const gIsbn = solved.get('b-isbn')!
    const gDoi = solved.get('b-doi')!
    expect(gIsbn.top + gIsbn.height).toBeLessThanOrEqual(gDoi.top)
    expect(gIsbn.tightBottom).toBe(true)
    expect(gDoi.tightTop).toBe(true)

    // 题注不覆盖紧邻表格障碍物，遮罩不覆盖下方段落
    const gCap = solved.get('b-cap')!
    expect(gCap.top + gCap.height).toBeLessThanOrEqual(tableObstacle.displayBounds.y)
    const gMask = solved.get('b-mask')!
    const gAfterMask = solved.get('b-after-mask')!
    expect(gMask.top + gMask.height).toBeLessThanOrEqual(gAfterMask.top)

    // 间距充裕段落允许扩高且保留至少 3px 呼吸距
    const gSpaced = solved.get('b-spaced')!
    const gBelow = solved.get('b-below-spaced')!
    expect(gSpaced.maxSafeHeight).toBeGreaterThan(gSpaced.height)
    expect(gSpaced.top + gSpaced.maxSafeHeight).toBeLessThanOrEqual(gBelow.top - 3)
  })

  test('resolveOverlayBlockGeometries prevents diagonal/vertical overlap and cross-column intrusion across zoom scales (合成素材)', () => {
    const mkBlock = (
      id: string,
      opts: {
        kind: AnalyzedBlock['kind']
        col: number
        fontSize: number
        rect: PageRect
        text: string
      }
    ): AnalyzedBlock => ({
      id,
      pageNumber: 1,
      order: 1,
      kind: opts.kind,
      columnIndex: opts.col,
      fontSize: opts.fontSize,
      isBold: opts.kind === 'heading',
      bounds: opts.rect,
      displayBounds: opts.rect,
      sentences: [
        {
          id: `${id}-s1`,
          pageNumber: 1,
          order: 1,
          blockId: id,
          blockKind: opts.kind,
          columnIndex: opts.col,
          text: opts.text,
          rects: [opts.rect],
          displayRects: [opts.rect],
          bounds: opts.rect,
          displayBounds: opts.rect,
          fragments: [],
          crossColumn: false
        }
      ]
    })

    // 合成密集双栏页面：包含窄标题上方扩宽、紧凑段落链、高密度多小块及相邻右栏（合成素材）
    const blocks: AnalyzedBlock[] = [
      mkBlock('l-p1', {
        kind: 'paragraph',
        col: 1,
        fontSize: 9,
        rect: { x: 54, y: 160, width: 236, height: 34 },
        text: 'ScaleStore combines low-latency RDMA with local DRAM caching.'
      }),
      mkBlock('l-head', {
        kind: 'heading',
        col: 1,
        fontSize: 9.5,
        rect: { x: 54, y: 196, width: 72, height: 11 },
        text: '2.1 Design'
      }),
      mkBlock('l-p2', {
        kind: 'paragraph',
        col: 1,
        fontSize: 9,
        rect: { x: 54, y: 209, width: 236, height: 42 },
        text: 'Page identifiers abstract whether pages live locally or on remote servers.'
      }),
      mkBlock('l-p3', {
        kind: 'paragraph',
        col: 1,
        fontSize: 9,
        rect: { x: 54, y: 253, width: 236, height: 30 },
        text: 'Eviction removes cold pages when working sets exceed DRAM.'
      }),
      mkBlock('r-p1', {
        kind: 'paragraph',
        col: 2,
        fontSize: 9,
        rect: { x: 304, y: 160, width: 240, height: 32 },
        text: 'Right column begins with distributed cache coherence analysis.'
      }),
      mkBlock('r-head', {
        kind: 'heading',
        col: 2,
        fontSize: 9.5,
        rect: { x: 304, y: 194, width: 112, height: 11 },
        text: '2.2 Epoch GC'
      }),
      mkBlock('r-p2', {
        kind: 'paragraph',
        col: 2,
        fontSize: 9,
        rect: { x: 304, y: 207, width: 240, height: 48 },
        text: 'Epoch-based reclamation ensures safe optimistic lock-free traversal.'
      })
    ]

    const layout: PageLayoutResult = {
      pageNumber: 1,
      naturalWidth: 612,
      naturalHeight: 792,
      columnCount: 2,
      bodyFontSize: 9,
      hasText: true,
      blocks,
      sentences: blocks.flatMap(b => b.sentences),
      filteredItems: []
    }

    const colLefts = computeColumnLeftEdges(layout.blocks)
    const colRights = new Map<number, number>([
      [1, 290],
      [2, 544]
    ])

    for (const scale of [0.85, 1, 1.25, 1.5]) {
      const solved = resolveOverlayBlockGeometries(layout, scale, colLefts, colRights)
      expect(solved.size).toBe(blocks.length)

      const rightColLeftPx = (colLefts.get(2) ?? 304) * scale
      for (const col of [1, 2]) {
        const colBoxes = blocks
          .filter(b => b.columnIndex === col)
          .map(b => solved.get(b.id)!)
          .sort((a, b) => a.top - b.top)

        for (let i = 0; i < colBoxes.length; i++) {
          const cur = colBoxes[i]
          if (col === 1) {
            expect(cur.left + cur.maxSafeWidth).toBeLessThan(rightColLeftPx)
          }
          for (let j = i + 1; j < colBoxes.length; j++) {
            const nxt = colBoxes[j]
            const horizOverlap =
              cur.left < nxt.left + nxt.maxSafeWidth - 0.5 && nxt.left < cur.left + cur.maxSafeWidth - 0.5
            if (horizOverlap) {
              expect(cur.top + cur.height).toBeLessThanOrEqual(nxt.top + 0.01)
              expect(cur.top + cur.maxSafeHeight).toBeLessThanOrEqual(nxt.top + 0.01)
            }
          }
        }
      }
    }
  })

  test('computeColumnLeftEdges / computeColumnRightEdges 与 resolveOverlayBlockGeometries 约束单栏与通栏右缘齐平不外溢 (合成素材)', () => {
    const mkSingleBlock = (
      id: string,
      opts: {
        kind: AnalyzedBlock['kind']
        col: number
        rect: PageRect
        firstLineX?: number
        text: string
      }
    ): AnalyzedBlock => ({
      id,
      pageNumber: 1,
      order: 1,
      kind: opts.kind,
      columnIndex: opts.col,
      fontSize: 10,
      isBold: opts.kind === 'heading',
      bounds: opts.rect,
      displayBounds: opts.rect,
      sentences: [
        {
          id: `${id}-s1`,
          pageNumber: 1,
          order: 1,
          blockId: id,
          blockKind: opts.kind,
          columnIndex: opts.col,
          text: opts.text,
          rects: [opts.rect],
          displayRects: [
            opts.firstLineX !== undefined
              ? { x: opts.firstLineX, y: opts.rect.y, width: opts.rect.width - (opts.firstLineX - opts.rect.x), height: 10 }
              : opts.rect
          ],
          bounds: opts.rect,
          displayBounds: opts.rect,
          fragments: [],
          crossColumn: false
        }
      ]
    })

    // 1. 典型 SIGMOD 单栏论文页（左右各有 72pt 宽外边距，正文区 x=72..540，合成素材）
    const singleBlocks: AnalyzedBlock[] = [
      mkSingleBlock('s-title', {
        kind: 'heading',
        col: 0,
        rect: { x: 156, y: 60, width: 300, height: 18 },
        text: 'Centered Single-Column Paper Title'
      }),
      mkSingleBlock('s-cap', {
        kind: 'caption',
        col: 0,
        rect: { x: 72, y: 180, width: 468, height: 28 },
        text: 'Fig. 1. Multi-line caption spanning exact content width.'
      }),
      mkSingleBlock('s-p1', {
        kind: 'paragraph',
        col: 0,
        rect: { x: 72, y: 220, width: 456, height: 44 },
        text: 'First multi-line paragraph wraps slightly before 540pt.'
      }),
      mkSingleBlock('s-p2', {
        kind: 'paragraph',
        col: 0,
        rect: { x: 84, y: 276, width: 456, height: 11 },
        text: 'Single-line indented paragraph in single-column paper.'
      }),
      mkSingleBlock('s-p3', {
        kind: 'paragraph',
        col: 0,
        rect: { x: 72, y: 298, width: 468, height: 52 },
        firstLineX: 84,
        text: 'Multi-line indented paragraph aligns with full content margin.'
      }),
      mkSingleBlock('s-narrow', {
        kind: 'paragraph',
        col: 0,
        rect: { x: 72, y: 362, width: 180, height: 24 },
        text: 'Short narrow block should not falsely stretch baseWidth.'
      })
    ]

    const singleLayout: PageLayoutResult = {
      pageNumber: 1,
      naturalWidth: 612,
      naturalHeight: 792,
      columnCount: 1,
      bodyFontSize: 10,
      hasText: true,
      blocks: singleBlocks,
      sentences: singleBlocks.flatMap(b => b.sentences),
      filteredItems: []
    }

    const colLefts = computeColumnLeftEdges(singleLayout.blocks)
    const colRights = computeColumnRightEdges(singleLayout.blocks, colLefts)
    expect(colLefts.get(0)).toBe(72)
    expect(colRights.get(0)).toBe(540)

    for (const scale of [1, 1.25]) {
      const solved = resolveOverlayBlockGeometries(singleLayout, scale, colLefts, colRights)
      const contentRightEdgePx = 540 * scale + 2

      for (const blk of singleBlocks) {
        const g = solved.get(blk.id)!
        // 严禁任意单栏块冲入右侧 72pt 留白区域
        expect(g.left + g.maxSafeWidth).toBeLessThanOrEqual(contentRightEdgePx + 0.1)
      }

      const gCap = solved.get('s-cap')!
      const gP1 = solved.get('s-p1')!
      const gP2 = solved.get('s-p2')!
      const gP3 = solved.get('s-p3')!
      const gNarrow = solved.get('s-narrow')!

      expect(gP2.firstLineIndentPx).toBeCloseTo(12 * scale, 1)
      expect(gP2.left).toBeCloseTo(72 * scale - 1, 1)
      expect(gP3.firstLineIndentPx).toBeCloseTo(12 * scale, 1)
      expect(gP1.left + gP1.baseWidth).toBeCloseTo(gCap.left + gCap.baseWidth, 1)
      expect(gP3.left + gP3.baseWidth).toBeCloseTo(gCap.left + gCap.baseWidth, 1)
      expect(gNarrow.baseWidth).toBeCloseTo(180 * scale + 2, 1)
    }

    // 2. 双栏页顶部的通栏摘要/标题 (columnIndex = 0) 也不得越过右栏外边界（合成素材）
    const mixedBlocks: AnalyzedBlock[] = [
      mkSingleBlock('m-title', {
        kind: 'heading',
        col: 0,
        rect: { x: 180, y: 60, width: 252, height: 16 },
        text: 'Two-Column Paper Title'
      }),
      mkSingleBlock('m-abs', {
        kind: 'paragraph',
        col: 0,
        rect: { x: 54, y: 92, width: 492, height: 36 },
        text: 'Abstract paragraph spans full two-column content area cleanly.'
      }),
      mkSingleBlock('m-c1', {
        kind: 'paragraph',
        col: 1,
        rect: { x: 54, y: 150, width: 231, height: 60 },
        text: 'Left column body prose aligned cleanly before column gutter.'
      }),
      mkSingleBlock('m-c2', {
        kind: 'paragraph',
        col: 2,
        rect: { x: 305, y: 150, width: 253, height: 60 },
        text: 'Right column body prose defines page outer right boundary.'
      })
    ]
    const mixedLayout: PageLayoutResult = {
      pageNumber: 1,
      naturalWidth: 612,
      naturalHeight: 792,
      columnCount: 2,
      bodyFontSize: 10,
      hasText: true,
      blocks: mixedBlocks,
      sentences: mixedBlocks.flatMap(b => b.sentences),
      filteredItems: []
    }
    const mixedLefts = computeColumnLeftEdges(mixedLayout.blocks)
    const mixedRights = computeColumnRightEdges(mixedLayout.blocks, mixedLefts)
    expect(mixedRights.get(0)).toBe(558)
    expect(mixedRights.get(1)).toBe(285)
    expect(mixedRights.get(2)).toBe(558)

    const mixedSolved = resolveOverlayBlockGeometries(mixedLayout, 1, mixedLefts, mixedRights)
    const gAbs = mixedSolved.get('m-abs')!
    const gC1 = mixedSolved.get('m-c1')!
    const gC2 = mixedSolved.get('m-c2')!
    expect(gAbs.left + gAbs.maxSafeWidth).toBeLessThanOrEqual(558 + 2.1)
    expect(gAbs.left + gAbs.baseWidth).toBeCloseTo(gC2.left + gC2.baseWidth, 1)
    expect(gC1.left + gC1.maxSafeWidth).toBeLessThan(305)
  })
})
