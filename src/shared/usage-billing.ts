import type { CliPreset, ProviderBillingKind, TranslationProviderType } from './contracts'

export function isLoopbackHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase()
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1' || clean === '[::1]'
}

export function detectProviderBillingKind(
  provider: TranslationProviderType,
  baseUrl: string,
  hasApiKey: boolean
): ProviderBillingKind {
  if (provider === 'cli') return 'cli-local'
  try {
    const parsed = new URL(baseUrl.trim())
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()
    if (hostname === 'api.deepseek.com' || (isLoopbackHost(hostname) && pathname.includes('/deepseek'))) {
      return 'deepseek-balance'
    }
    if (isLoopbackHost(hostname) && (parsed.port === '11434' || !hasApiKey)) {
      return 'ollama-local'
    }
  } catch {
    if (!hasApiKey) return 'ollama-local'
  }
  return 'openai-generic'
}

export function formatCliPresetLabel(preset: CliPreset, modelName?: string): string {
  const base =
    preset === 'codex' ? 'Codex CLI' : preset === 'gemini' ? 'Gemini CLI' : '自定义 CLI'
  const cleanModel = modelName?.trim()
  return cleanModel ? `${base} · ${cleanModel}` : base
}
