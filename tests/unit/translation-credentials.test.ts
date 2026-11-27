import { describe, expect, test, vi } from 'vitest'
import {
  LEGACY_TRANSLATION_API_KEY, TRANSLATION_CREDENTIALS_KEY, TranslationCredentialStore,
  normalizeTranslationBaseUrl, type SafeStorageAdapter, type TranslationSettingsStore
} from '../../src/main/services/translation-credentials'

// 全部为合成凭据和可逆测试适配器，不使用系统密钥或真实网络。
function memoryStore(): TranslationSettingsStore {
  const values = new Map<string, string>()
  return { getSetting: key => values.get(key) ?? null,
    setSetting: (key, value) => { values.set(key, value) }, deleteSetting: key => { values.delete(key) } }
}
const mockEncryption: SafeStorageAdapter = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: value => Buffer.from('SYNTHETIC:' + value),
  decryptString: buffer => {
    const value = buffer.toString()
    if (!value.startsWith('SYNTHETIC:')) throw new Error('synthetic invalid ciphertext')
    return value.slice('SYNTHETIC:'.length)
  }
}

describe('服务地址绑定与系统加密凭据', () => {
  test('规范化完整 Base URL，并拒绝有歧义的 userinfo/query/hash', () => {
    expect(normalizeTranslationBaseUrl(' HTTPS://API.EXAMPLE.COM:443/v1/// ')).toBe('https://api.example.com/v1')
    expect(normalizeTranslationBaseUrl('https://api.example.com/')).toBe('https://api.example.com')
    for (const url of ['file:///tmp/x', 'https://u:p@api.example.com/v1', 'https://api.example.com/v1?q=x', 'https://api.example.com/v1#x']) {
      expect(() => normalizeTranslationBaseUrl(url)).toThrow()
    }
  })

  test('密钥仅在绑定的规范地址可读，切换主机/端口/路径/协议不复用', () => {
    const db = memoryStore()
    const credentials = new TranslationCredentialStore(db, mockEncryption, 'win32')
    credentials.write('https://api.example.com:443/v1/', 'synthetic-key-a')
    expect(credentials.read('HTTPS://API.EXAMPLE.COM/v1')).toBe('synthetic-key-a')
    for (const other of ['https://other.example.com/v1', 'https://api.example.com/v2',
      'https://api.example.com:8443/v1', 'http://api.example.com/v1']) expect(credentials.read(other)).toBeNull()
    credentials.write('https://other.example.com/v1', 'synthetic-key-b')
    expect(credentials.read('https://api.example.com/v1')).toBe('synthetic-key-a')
    expect(credentials.read('https://other.example.com/v1')).toBe('synthetic-key-b')
    expect(db.getSetting(TRANSLATION_CREDENTIALS_KEY)).not.toContain('synthetic-key-a')
    credentials.write('https://other.example.com/v1', '')
    expect(credentials.read('https://other.example.com/v1')).toBeNull()
    expect(credentials.read('https://api.example.com/v1')).toBe('synthetic-key-a')
  })

  test('只改密文外的地址索引不能换绑 API Key', () => {
    const db = memoryStore()
    const credentials = new TranslationCredentialStore(db, mockEncryption, 'win32')
    credentials.write('https://a.example/v1', 'synthetic-key')
    const record = JSON.parse(db.getSetting(TRANSLATION_CREDENTIALS_KEY)!) as { version: number; entries: Array<{ baseUrl: string; cipher: string }> }
    record.entries[0].baseUrl = 'https://b.example/v1'
    db.setSetting(TRANSLATION_CREDENTIALS_KEY, JSON.stringify(record))
    expect(credentials.read('https://b.example/v1')).toBeNull()
  })

  test('加密不可用或 Linux basic_text/unknown 不落盘，不读旧明文或旧无地址密钥', () => {
    for (const adapter of [undefined, { ...mockEncryption, isEncryptionAvailable: () => false },
      { ...mockEncryption, getSelectedStorageBackend: () => 'basic_text' },
      { ...mockEncryption, getSelectedStorageBackend: () => 'unknown' },
      { ...mockEncryption, getSelectedStorageBackend: undefined }]) {
      const db = memoryStore()
      const credentials = new TranslationCredentialStore(db, adapter, 'linux')
      expect(() => credentials.write('https://api.example/v1', 'synthetic-private-key')).toThrow('系统安全加密不可用')
      expect(db.getSetting(TRANSLATION_CREDENTIALS_KEY)).toBeNull()
      db.setSetting(LEGACY_TRANSLATION_API_KEY, 'plain:v1:' + Buffer.from('synthetic-old-key').toString('base64'))
      expect(credentials.read('https://api.example/v1')).toBeNull()
      expect(db.getSetting(LEGACY_TRANSLATION_API_KEY)).toBeNull()
    }
    const db = memoryStore()
    const decrypt = vi.fn(mockEncryption.decryptString)
    db.setSetting(LEGACY_TRANSLATION_API_KEY, 'enc:v1:' + Buffer.from('SYNTHETIC:synthetic-old-key').toString('base64'))
    expect(new TranslationCredentialStore(db, { ...mockEncryption, decryptString: decrypt }, 'linux').read('https://api.example/v1')).toBeNull()
    expect(decrypt).not.toHaveBeenCalled()
    expect(db.getSetting(LEGACY_TRANSLATION_API_KEY)).toMatch(/^enc:v1:/)
    new TranslationCredentialStore(db, mockEncryption, 'linux').write('https://api.example/v1', 'synthetic-reentered')
    expect(db.getSetting(LEGACY_TRANSLATION_API_KEY)).toBeNull()
  })

  test('密钥服务暂不可用时不降级读取、不覆盖已有 v2 密文', () => {
    const db = memoryStore()
    new TranslationCredentialStore(db, mockEncryption, 'linux').write('https://api.example/v1', 'synthetic-original')
    const original = db.getSetting(TRANSLATION_CREDENTIALS_KEY)
    const unavailable = new TranslationCredentialStore(db, { ...mockEncryption, isEncryptionAvailable: () => false }, 'linux')
    expect(unavailable.read('https://api.example/v1')).toBeNull()
    expect(() => unavailable.write('https://api.example/v1', 'synthetic-new')).toThrow()
    expect(db.getSetting(TRANSLATION_CREDENTIALS_KEY)).toBe(original)
  })
})
