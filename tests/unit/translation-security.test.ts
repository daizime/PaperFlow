import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LibraryDatabase } from '../../src/main/services/database'
import { TranslationService, type SafeStorageAdapter } from '../../src/main/services/translation-service'
import type { SaveTranslationSettingsInput, TranslationBlockInput } from '../../src/shared/contracts'

let directory: string
let db: LibraryDatabase
beforeEach(async () => {
  const parent = join(process.cwd(), 'test-results')
  await mkdir(parent, { recursive: true })
  directory = await mkdtemp(join(parent, 'translation-security-'))
  db = new LibraryDatabase(join(directory, 'library.sqlite'))
})
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
// 仅合成内容、模拟 fetch 与加密；没有真实外网、系统凭据或 CLI 执行。
const syntheticStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: text => Buffer.from('SYNTHETIC:' + text),
  decryptString: cipher => cipher.toString().slice('SYNTHETIC:'.length)
}
function settings(baseUrl = 'https://api.deepseek.com/v1', apiKey?: string): SaveTranslationSettingsInput {
  return { provider: 'openai-compatible', targetLanguage: 'zh-CN',
    openai: { baseUrl, model: 'synthetic-model', ...(apiKey !== undefined ? { apiKey } : {}) },
    cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 30 } }
}
function documentId(): string {
  const id = randomUUID()
  db.insertDocument({ id, sha256: 'a'.repeat(64), originalFilename: 'synthetic.pdf', displayTitle: '合成素材',
    storedFilename: `${id}.pdf`, byteSize: 1024, pageCount: 2, importedAt: new Date().toISOString() })
  return id
}
function response(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { headers: { 'Content-Type': 'application/json' } })
}

describe('服务层凭据与授权的合成回归', () => {
  test('草稿测试、余额与保存后请求均按完整规范 Base URL 取密钥，地址切换不复用旧 Key', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') })
      if (String(input).includes('/user/balance')) return new Response(JSON.stringify({ is_available: true, balance_infos: [] }))
      return response('{"translations":[{"id":"test-b001","text":"合成连接测试"}]}')
    }
    const service = new TranslationService({ database: db, safeStorage: syntheticStorage, fetchImpl })
    service.saveSettings(settings(undefined, 'synthetic-key-a'))
    expect((await service.testConnection(settings('HTTPS://API.DEEPSEEK.COM:443/v1/'))).ok).toBe(true)
    expect(calls.at(-1)?.authorization).toBe('Bearer synthetic-key-a')
    const b = settings('https://api.deepseek.com/other/v1')
    await service.testConnection(b)
    expect(calls.at(-1)?.authorization).toBeNull()
    expect(calls.at(-1)?.url).toBe('https://api.deepseek.com/other/v1/chat/completions')
    const count = calls.length
    expect((await service.getProviderBalance(b)).error).toContain('尚未填写 API Key')
    expect(calls).toHaveLength(count)
    await service.getProviderBalance(settings(b.openai.baseUrl, 'synthetic-draft-key-b'))
    expect(calls.at(-1)?.authorization).toBe('Bearer synthetic-draft-key-b')
    expect(service.getSettings().openai.hasApiKey).toBe(true)
    service.saveSettings(b)
    expect(service.getSettings().openai.hasApiKey).toBe(false)
    await service.testConnection()
    expect(calls.at(-1)?.authorization).toBeNull()
    service.saveSettings(settings())
    await service.testConnection()
    expect(calls.at(-1)?.authorization).toBe('Bearer synthetic-key-a')
    service.saveSettings(settings(b.openai.baseUrl, 'synthetic-key-b'))
    service.saveSettings(settings())
    await service.testConnection()
    expect(calls.at(-1)?.authorization).toBe('Bearer synthetic-key-a')
  })

  test('无加密服务时保存失败且不切换配置；旧无地址 enc/plain 都不自动使用', async () => {
    const service = new TranslationService({ database: db, safeStorage: { ...syntheticStorage, isEncryptionAvailable: () => false } })
    expect(() => service.saveSettings(settings('https://synthetic.example/v1', 'synthetic-secret'))).toThrow('系统安全加密不可用')
    expect(db.getSetting('translation.config.v1')).toBeNull()
    expect(db.getSetting('translation.openaiCredentials.v2')).toBeNull()
    for (const encoded of ['plain:v1:' + Buffer.from('synthetic-legacy').toString('base64'), 'enc:v1:' + Buffer.from('SYNTHETIC:synthetic-legacy').toString('base64')]) {
      db.setSetting('translation.openaiApiKey.v1', encoded)
      expect(service.getSettings().openai.hasApiKey).toBe(false)
      expect(db.getSetting('translation.openaiApiKey.v1')).toBe(encoded.startsWith('enc:') ? encoded : null)
    }
  })

  test('自定义配置仅保存不会获得授权；所有直接测试/翻译调用均在 spawn 前拒绝', async () => {
    const program = join(directory, 'synthetic-not-executable.fixture')
    await writeFile(program, 'This is synthetic data, never execute it.')
    const confirm = vi.fn(async () => false)
    const service = new TranslationService({ database: db, safeStorage: syntheticStorage, authorizeCli: confirm })
    const input = settings()
    input.provider = 'cli'
    input.cli = { preset: 'custom', command: program, model: '', extraArgs: ['-EncodedCommand', 'SYNTHETIC'], timeoutSec: 30 }
    service.saveSettings(input)
    expect(service.getSettings().cli.authorized).toBe(false)
    const tested = await service.testConnection(input)
    expect(tested.ok).toBe(false)
    expect(tested.error).toContain('请在翻译设置中确认本机程序')
    expect(confirm).not.toHaveBeenCalled()
    const id = documentId()
    await expect(service.translatePage({ documentId: id, pageNumber: 1, blocks: [block('b1', 'Synthetic paragraph.')] }))
      .rejects.toThrow('请在翻译设置中确认本机程序')
    expect(confirm).not.toHaveBeenCalled()
    expect(await service.authorizeCliSettings(input)).toMatchObject({ authorized: false })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(service.getSettings().cli.authorized).toBe(false)
  })

  test('API连接和余额请求均禁止自动重定向，直接本机随机端口仍保持可用请求路径', async () => {
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
    let redirectReply = true
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), redirect: init?.redirect })
      if (redirectReply) return new Response('', { status: 307, headers: { Location: 'https://untrusted.synthetic.example/collect' } })
      return response('{"translations":[{"id":"test-b001","text":"合成直连成功"}]}')
    }
    const service = new TranslationService({ database: db, safeStorage: syntheticStorage, fetchImpl })
    service.saveSettings(settings(undefined, 'synthetic-secret'))
    expect((await service.testConnection()).ok).toBe(false)
    expect(requests).toHaveLength(1)
    expect(requests[0].redirect).toBe('error')
    await service.getProviderBalance()
    expect(requests).toHaveLength(2)
    expect(requests[1].redirect).toBe('error')
    expect(requests.some(request => request.url.includes('untrusted.synthetic'))).toBe(false)
    redirectReply = false
    const local = 'http://127.0.0.1:49173/v1'
    expect((await service.testConnection(settings(local, 'synthetic-local-key'))).ok).toBe(true)
    expect(requests.at(-1)).toEqual({ url: local + '/chat/completions', redirect: 'error' })
  })
})

function block(blockId: string, sourceText: string): TranslationBlockInput {
  return { blockId, sourceText, kind: 'paragraph', sourceHash: '0123456789abcdef' }
}
function syntheticTranslator(outputs: Array<Record<string, string>>): { service: TranslationService; fetchImpl: ReturnType<typeof vi.fn<typeof fetch>> } {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const output = outputs.shift() ?? {}
    return response(JSON.stringify({ translations: Object.entries(output).map(([id, text]) => ({ id, text })) }))
  })
  const service = new TranslationService({ database: db, safeStorage: syntheticStorage, fetchImpl })
  service.saveSettings(settings('https://synthetic.example/v1', 'synthetic-key'))
  return { service, fetchImpl }
}

describe('公式标记完整性：模拟模型响应，不启动服务', () => {
  test('批次与单块重试均丢标记时明确失败，完整同批块也不以部分成功入库', async () => {
    const id = documentId(), progress = vi.fn()
    const { service, fetchImpl } = syntheticTranslator([{ good: '完整正文', bad: '缺失 ⟪M1⟫' }, { bad: '仍缺少标记' }])
    await expect(service.translatePage({ documentId: id, pageNumber: 1,
      blocks: [block('good', 'Synthetic paragraph.'), block('bad', 'Use ⟪M1⟫ and ⟪M2⟫.')] }, progress))
      .rejects.toThrow('公式标记不完整')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(db.getPageTranslations(id, 1, 'zh-CN')).toHaveLength(0)
    expect(progress).not.toHaveBeenCalled()
  })

  test('识别旧坏缓存后重新请求；完整重试才保存并在下一次命中', async () => {
    const id = documentId(), source = block('b1', 'Use ⟪M1⟫ and again ⟪M1⟫.')
    db.upsertPageTranslations(id, 1, 'zh-CN', 'legacy-signature', [{ blockId: source.blockId, sourceHash: source.sourceHash, translatedText: '旧缓存只含 ⟪M1⟫' }])
    const { service, fetchImpl } = syntheticTranslator([{ b1: '重试完整 ⟪M1⟫ 与 ⟪M1⟫。' }])
    const repaired = await service.translatePage({ documentId: id, pageNumber: 1, blocks: [source] })
    expect(repaired).toMatchObject({ fromCacheCount: 0, translatedCount: 1 })
    expect(repaired.items[0].translatedText).toContain('⟪M1⟫ 与 ⟪M1⟫')
    expect((await service.translatePage({ documentId: id, pageNumber: 1, blocks: [source] })).fromCacheCount).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('额外/重复编号不能冒充完整，单块重试保留全部标记后才成功', async () => {
    const id = documentId()
    const { service, fetchImpl } = syntheticTranslator([{ b1: '额外 ⟪M1⟫ ⟪M1⟫ ⟪M2⟫' }, { b1: '调整语序 ⟪M2⟫ 与 ⟪M1⟫' }])
    const result = await service.translatePage({ documentId: id, pageNumber: 1, blocks: [block('b1', 'Use ⟪M1⟫ and ⟪M2⟫.')] })
    expect(result.translatedCount).toBe(1)
    expect(result.items[0].translatedText).toBe('调整语序 ⟪M2⟫ 与 ⟪M1⟫')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
