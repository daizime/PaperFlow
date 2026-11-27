import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { LibraryDatabase } from '../../src/main/services/database'
import { readOpenAiStreamOrJsonWithUsage } from '../../src/main/services/openai-stream'
import { TranslationService, type SafeStorageAdapter } from '../../src/main/services/translation-service'
import {
  buildBalanceEndpointUrl,
  detectProviderBillingKind,
  getLocalDateKey,
  mergeTokenUsage,
  parseDeepSeekBalancePayload,
  UsageService
} from '../../src/main/services/usage-service'
import {
  buildTranslationCompletionToast,
  defaultBillingNote,
  estimateReferenceCost,
  formatCompactTokens,
  formatHeaderEnginePill,
  inferBillingKindFromDraft,
  isLowBalance
} from '../../src/renderer/src/features/translation/usage-format'
import type { ProviderBalanceSnapshot, TranslationSettings, UsageStatsSummary } from '../../src/shared/contracts'

let workRoot: string
let dbPath: string

const fakeSafeStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(`MOCKENC:${plain}`, 'utf8'),
  decryptString: buf => buf.toString('utf8').replace(/^MOCKENC:/, '')
}

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'paperflow-usage-'))
  dbPath = join(workRoot, 'paperflow.sqlite')
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

describe('UsageService 与余额检测逻辑', () => {
  test('精确区分 DeepSeek、Ollama、通用 API 与 CLI 计费类型并构造 /user/balance 地址', () => {
    expect(detectProviderBillingKind('openai-compatible', 'https://api.deepseek.com/v1', true)).toBe('deepseek-balance')
    expect(detectProviderBillingKind('openai-compatible', 'http://127.0.0.1:43210/deepseek/v1', true)).toBe(
      'deepseek-balance'
    )
    expect(detectProviderBillingKind('openai-compatible', 'http://127.0.0.1:11434/v1', false)).toBe('ollama-local')
    expect(detectProviderBillingKind('openai-compatible', 'https://api.openai.com/v1', true)).toBe('openai-generic')
    expect(detectProviderBillingKind('cli', 'https://api.deepseek.com/v1', true)).toBe('cli-local')

    expect(buildBalanceEndpointUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/user/balance')
    expect(buildBalanceEndpointUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/user/balance')
    expect(buildBalanceEndpointUrl('http://127.0.0.1:43210/deepseek/v1')).toBe(
      'http://127.0.0.1:43210/deepseek/user/balance'
    )
    expect(buildBalanceEndpointUrl('https://api.openai.com/v1')).toBeNull()
  })

  test('支持本地 SQLite 持久化统计、跨天自动归零今日桶、重置与参考单价保存', () => {
    const db = new LibraryDatabase(dbPath)
    let fakeNow = new Date('2026-11-27T10:00:00+08:00')
    try {
      const usage = new UsageService({ database: db, now: () => fakeNow })
      usage.recordUsage({
        usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        apiRequests: 1,
        translatedBlocks: 6,
        translatedPages: 1,
        cacheHitBlocks: 2
      })

      let summary = usage.getSummary()
      expect(summary.todayDate).toBe(getLocalDateKey(fakeNow))
      expect(summary.today.totalTokens).toBe(1500)
      expect(summary.today.translatedBlocks).toBe(6)
      expect(summary.total.totalTokens).toBe(1500)

      // 模拟跨天
      fakeNow = new Date('2026-11-28T09:00:00+08:00')
      summary = usage.getSummary()
      expect(summary.today.totalTokens).toBe(0)
      expect(summary.total.totalTokens).toBe(1500)

      usage.savePreferences({
        lowBalanceThreshold: 5,
        priceCurrency: 'USD',
        inputPricePer1M: 0.5,
        outputPricePer1M: 1.5
      })
      const prefs = usage.getPreferences()
      expect(prefs.lowBalanceThreshold).toBe(5)
      expect(prefs.priceCurrency).toBe('USD')

      const resetAll = usage.resetStats('all')
      expect(resetAll.total.totalTokens).toBe(0)
      expect(resetAll.today.totalTokens).toBe(0)
    } finally {
      db.close()
    }
  })

  test('readOpenAiStreamOrJsonWithUsage 同时支持 JSON 与 SSE usage 解析', async () => {
    const jsonRes = new Response(
      JSON.stringify({
        choices: [{ message: { content: '你好' } }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
    const r1 = await readOpenAiStreamOrJsonWithUsage(jsonRes)
    expect(r1.text).toBe('你好')
    expect(r1.usage).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150 })

    const sseBody = [
      'data: {"choices":[{"delta":{"content":"学术"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"翻译"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":80,"total_tokens":280}}\n\n',
      'data: [DONE]\n\n'
    ].join('')
    const sseRes = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
    const r2 = await readOpenAiStreamOrJsonWithUsage(sseRes)
    expect(r2.text).toBe('学术翻译')
    expect(r2.usage).toEqual({ promptTokens: 200, completionTokens: 80, totalTokens: 280 })
  })

  test('parseDeepSeekBalancePayload 与 mergeTokenUsage 准确解析货币余额并累加用量', () => {
    const parsed = parseDeepSeekBalancePayload(
      {
        is_available: true,
        balance_infos: [
          { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
          { currency: 'CNY', total_balance: '18.42', granted_balance: '3.42', topped_up_balance: '15.00' }
        ]
      },
      '2026-11-27T09:30:00.000Z',
      'deepseek-chat'
    )
    expect(parsed.currency).toBe('CNY')
    expect(parsed.totalBalance).toBe(18.42)
    expect(parsed.grantedBalance).toBe(3.42)
    expect(parsed.toppedUpBalance).toBe(15)

    expect(
      mergeTokenUsage(
        { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        { promptTokens: 20, completionTokens: 10, totalTokens: 30 }
      )
    ).toEqual({ promptTokens: 30, completionTokens: 15, totalTokens: 45 })
  })

  test('TranslationService 翻译后自动刷新 DeepSeek 余额、累计 Token，并显式报错 HTTP 402', async () => {
    let balanceToReturn = '18.42'
    let failBalance = false
    let forceStatus = 200

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/deepseek/user/balance') {
        if (failBalance) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'temporary' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            is_available: true,
            balance_infos: [
              {
                currency: 'CNY',
                total_balance: balanceToReturn,
                granted_balance: '0.00',
                topped_up_balance: balanceToReturn
              }
            ]
          })
        )
        return
      }

      if (forceStatus !== 200) {
        res.writeHead(forceStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Insufficient Balance' } }))
        return
      }

      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content: string }>
      }
      const userPrompt = body.messages[body.messages.length - 1]?.content ?? ''
      const arrStart = userPrompt.lastIndexOf('[')
      const blocks = JSON.parse(userPrompt.slice(arrStart)) as Array<{ id: string; text: string }>
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: blocks.map(b => ({ id: b.id, text: `译：${b.text}` }))
                })
              }
            }
          ],
          usage: { prompt_tokens: 1120, completion_tokens: 720, total_tokens: 1840 }
        })
      )
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }

    const db = new LibraryDatabase(dbPath)
    const docId = randomUUID()
    db.insertDocument({
      id: docId,
      sha256: 'c'.repeat(64),
      originalFilename: 'usage-doc.pdf',
      displayTitle: 'usage-doc',
      storedFilename: `${docId}.pdf`,
      byteSize: 2048,
      pageCount: 1,
      importedAt: new Date().toISOString()
    })

    const svc = new TranslationService({ database: db, safeStorage: fakeSafeStorage })
    try {
      svc.saveSettings({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        openai: {
          baseUrl: `http://127.0.0.1:${addr.port}/deepseek/v1`,
          model: 'deepseek-chat',
          apiKey: 'sk-deepseek-test-1234'
        },
        cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 120 }
      })

      const res1 = await svc.translatePage({
        documentId: docId,
        pageNumber: 1,
        blocks: [{ blockId: 'b1', kind: 'paragraph', sourceText: 'ScaleStore uses RDMA.', sourceHash: 'a'.repeat(16) }]
      })
      expect(res1.usage).toEqual({ promptTokens: 1120, completionTokens: 720, totalTokens: 1840 })
      expect(res1.billingKind).toBe('deepseek-balance')
      expect(res1.balance?.totalBalance).toBe(18.42)
      expect(svc.getUsageSummary().today.totalTokens).toBe(1840)

      // 即使 /user/balance 失败也不应阻塞翻译成功
      failBalance = true
      const res2 = await svc.translatePage({
        documentId: docId,
        pageNumber: 1,
        blocks: [{ blockId: 'b1', kind: 'paragraph', sourceText: 'ScaleStore uses RDMA.', sourceHash: 'a'.repeat(16) }],
        force: true
      })
      expect(res2.translatedCount).toBe(1)
      expect(res2.balance?.error).toContain('HTTP 500')
      expect(svc.getUsageSummary().today.totalTokens).toBe(3680)

      // HTTP 402 明确提示余额不足
      forceStatus = 402
      await expect(
        svc.translatePage({
          documentId: docId,
          pageNumber: 1,
          blocks: [{ blockId: 'b2', kind: 'paragraph', sourceText: 'Second block.', sourceHash: 'b'.repeat(16) }]
        })
      ).rejects.toThrow(/HTTP 402|余额不足/)

      forceStatus = 200
      failBalance = false
      balanceToReturn = '1.20'
      const lowBal = await svc.getProviderBalance()
      expect(lowBal.totalBalance).toBe(1.2)
    } finally {
      db.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('渲染格式化工具正确生成 4 种计费场景的顶栏胶囊与 5 秒完成提示', () => {
    expect(formatCompactTokens(840)).toBe('840')
    expect(formatCompactTokens(12420)).toBe('12.4k')

    const settings: TranslationSettings = {
      provider: 'openai-compatible',
      targetLanguage: 'zh-CN',
      glossary: [],
      openai: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        hasApiKey: true,
        apiKeyPreview: 'sk-1***9999'
      },
      cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 120 }
    }
    const summary: UsageStatsSummary = {
      todayDate: '2026-11-27',
      today: {
        promptTokens: 8000,
        completionTokens: 4420,
        totalTokens: 12420,
        apiRequests: 4,
        translatedBlocks: 20,
        translatedPages: 2,
        cacheHitBlocks: 5
      },
      total: {
        promptTokens: 8000,
        completionTokens: 4420,
        totalTokens: 12420,
        apiRequests: 4,
        translatedBlocks: 20,
        translatedPages: 2,
        cacheHitBlocks: 5
      },
      preferences: { lowBalanceThreshold: 2, priceCurrency: 'CNY', inputPricePer1M: 1, outputPricePer1M: 2 },
      updatedAt: '2026-11-27T10:00:00.000Z'
    }

    const okBalance: ProviderBalanceSnapshot = {
      supported: true,
      billingKind: 'deepseek-balance',
      provider: 'openai-compatible',
      modelLabel: 'deepseek-chat',
      available: true,
      currency: 'CNY',
      totalBalance: 18.42,
      grantedBalance: 3.42,
      toppedUpBalance: 15,
      fetchedAt: '2026-11-27T10:00:00.000Z',
      note: 'ok'
    }
    expect(isLowBalance(okBalance, summary.preferences)).toBe(false)
    expect(formatHeaderEnginePill(settings, 'deepseek-chat', okBalance, summary).text).toBe(
      'API · deepseek-chat · 余 ¥18.42'
    )

    const lowBalance: ProviderBalanceSnapshot = { ...okBalance, totalBalance: 1.2 }
    expect(isLowBalance(lowBalance, summary.preferences)).toBe(true)
    const lowPill = formatHeaderEnginePill(settings, 'deepseek-chat', lowBalance, summary)
    expect(lowPill.tone).toBe('warn')
    expect(lowPill.text).toContain('余 ¥1.20 ⚠')

    const est = estimateReferenceCost({ promptTokens: 1120, completionTokens: 720, totalTokens: 1840 }, summary.preferences)
    expect(est?.text).toBe('≈ ¥0.0026')

    const lowToast = buildTranslationCompletionToast({
      result: {
        documentId: 'doc-1',
        pageNumber: 1,
        items: [],
        fromCacheCount: 0,
        translatedCount: 8,
        usage: { promptTokens: 1120, completionTokens: 720, totalTokens: 1840 },
        latencyMs: 2400,
        billingKind: 'deepseek-balance',
        balance: lowBalance
      },
      settings,
      balance: lowBalance,
      usageSummary: summary
    })
    expect(lowToast.tone).toBe('warn')
    expect(lowToast.title).toContain('余额偏低：剩余 ¥1.20')

    const genericSettings: TranslationSettings = {
      ...settings,
      openai: { ...settings.openai, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
    }
    expect(formatHeaderEnginePill(genericSettings, 'gpt-4o-mini', null, summary).text).toBe(
      'API · gpt-4o-mini · 今日 12.4k tok'
    )

    const cliSettings: TranslationSettings = { ...settings, provider: 'cli' }
    expect(formatHeaderEnginePill(cliSettings, 'Codex CLI', null, summary).text).toBe('CLI · Codex CLI · 订阅配额')

    // 草稿页签切换推理不串台
    expect(
      inferBillingKindFromDraft({
        provider: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        hasApiKey: true
      })
    ).toBe('deepseek-balance')
    expect(
      inferBillingKindFromDraft({
        provider: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        hasApiKey: true
      })
    ).toBe('openai-generic')
    expect(
      inferBillingKindFromDraft({
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        hasApiKey: false
      })
    ).toBe('ollama-local')
    expect(
      inferBillingKindFromDraft({
        provider: 'cli',
        baseUrl: 'https://api.deepseek.com/v1',
        hasApiKey: true
      })
    ).toBe('cli-local')

    expect(defaultBillingNote('openai-generic')).toContain('OpenAI 兼容服务商未提供标准 Key 查余额接口')
    expect(defaultBillingNote('deepseek-balance', true)).toContain('预览未保存')
    expect(defaultBillingNote('ollama-local')).toContain('Ollama')
    expect(defaultBillingNote('cli-local')).toContain('本机 AI CLI')
    expect(defaultBillingNote('cli-local')).toContain('订阅配额')
  })
})
