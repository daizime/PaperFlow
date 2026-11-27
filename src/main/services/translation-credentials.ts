export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface TranslationSettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  deleteSetting(key: string): void
}

export const TRANSLATION_CREDENTIALS_KEY = 'translation.openaiCredentials.v2'
export const LEGACY_TRANSLATION_API_KEY = 'translation.openaiApiKey.v1'

/** 凭据绑定完整服务根路径；不接受会改变实际请求目的地的 userinfo/query/hash。 */
export function normalizeTranslationBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API Base URL 必须是无用户名、查询串和片段的 http(s) 服务地址。')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

interface CredentialEntry { baseUrl: string; cipher: string }

/** v1 密钥没有可靠的服务地址来源，禁止自动猜测归属或读取明文降级。 */
export class TranslationCredentialStore {
  constructor(
    private readonly database: TranslationSettingsStore,
    private readonly safeStorage?: SafeStorageAdapter,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  private encryptionAvailable(): boolean {
    try {
      if (!this.safeStorage?.isEncryptionAvailable()) return false
      if (this.platform !== 'linux') return true
      const backend = this.safeStorage.getSelectedStorageBackend?.()
      return Boolean(backend && backend !== 'basic_text' && backend !== 'unknown')
    } catch { return false }
  }

  private removeLegacyKey(discardEncrypted = false): void {
    const legacy = this.database.getSetting(LEGACY_TRANSLATION_API_KEY)
    // 只读检查不销毁旧密文；只有用户明确重填或清除时才替换它。
    if (legacy !== null && (discardEncrypted || legacy.startsWith('plain:v1:'))) {
      this.database.deleteSetting(LEGACY_TRANSLATION_API_KEY)
    }
  }

  private entries(): CredentialEntry[] {
    const raw = this.database.getSetting(TRANSLATION_CREDENTIALS_KEY)
    if (!raw) return []
    try {
      const data: unknown = JSON.parse(raw)
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 2 ||
          !('entries' in data) || !Array.isArray(data.entries)) return []
      return data.entries.slice(0, 64).flatMap((entry: unknown): CredentialEntry[] => {
        if (!entry || typeof entry !== 'object' || !('baseUrl' in entry) || !('cipher' in entry) ||
            typeof entry.baseUrl !== 'string' || typeof entry.cipher !== 'string' ||
            entry.baseUrl.length > 512 || entry.cipher.length > 16384) return []
        return [{ baseUrl: entry.baseUrl, cipher: entry.cipher }]
      })
    } catch { return [] }
  }

  read(baseUrl: string): string | null {
    this.removeLegacyKey()
    if (!this.encryptionAvailable()) return null
    const scope = normalizeTranslationBaseUrl(baseUrl)
    const entry = this.entries().find(item => item.baseUrl === scope)
    if (!entry || !this.safeStorage) return null
    try {
      // 地址同时包含在密文内，篡改外层索引不能给密钥换绑地址。
      const payload: unknown = JSON.parse(this.safeStorage.decryptString(Buffer.from(entry.cipher, 'base64')))
      if (!payload || typeof payload !== 'object' || !('baseUrl' in payload) || payload.baseUrl !== scope ||
          !('apiKey' in payload) || typeof payload.apiKey !== 'string' || payload.apiKey.length > 512) return null
      return payload.apiKey.trim() || null
    } catch { return null }
  }

  write(baseUrl: string, apiKey: string): void {
    const scope = normalizeTranslationBaseUrl(baseUrl)
    const key = apiKey.trim()
    if (key && !this.encryptionAvailable()) {
      throw new Error('系统安全加密不可用，无法保存 API Key。请启用系统密钥服务后重试；旧版未绑定服务地址的密钥需重新填写。')
    }
    const remaining = this.entries().filter(item => item.baseUrl !== scope)
    if (key && this.safeStorage) {
      const cipher = this.safeStorage.encryptString(JSON.stringify({ baseUrl: scope, apiKey: key })).toString('base64')
      remaining.unshift({ baseUrl: scope, cipher })
    }
    this.database.setSetting(TRANSLATION_CREDENTIALS_KEY, JSON.stringify({ version: 2, entries: remaining.slice(0, 64) }))
    this.removeLegacyKey(true)
  }
}
