/** 译文可以调整语序，但每个公式标记的编号和出现次数都必须保留。 */
export function matchesFormulaPlaceholders(source: string, translation: string): boolean {
  const marker = /⟪M\d+⟫/g
  const expected = new Map<string, number>()
  for (const token of source.match(marker) ?? []) {
    expected.set(token, (expected.get(token) ?? 0) + 1)
  }
  for (const token of translation.match(marker) ?? []) {
    const remaining = expected.get(token)
    if (!remaining) return false
    if (remaining === 1) expected.delete(token)
    else expected.set(token, remaining - 1)
  }
  return expected.size === 0
}
