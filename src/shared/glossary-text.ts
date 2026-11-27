import type { GlossaryEntry } from './contracts'

export function formatGlossaryLines(entries: readonly GlossaryEntry[]): string {
  return entries.map(entry => `${entry.source} => ${entry.target}`).join('\n')
}

export function parseGlossaryLines(rawText: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = []
  const seen = new Set<string>()
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(.+?)(?:\s*(?:=>|->|=|：|:)\s*)(.+)$/)
    if (!match) continue
    const source = match[1].trim()
    const target = match[2].trim()
    if (!source || !target) continue
    const key = source.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ source: source.slice(0, 120), target: target.slice(0, 120) })
    if (entries.length >= 200) break
  }
  return entries
}
