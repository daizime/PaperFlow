import type {
  CliPreset,
  ProviderBalanceSnapshot,
  TokenUsageDelta,
  TranslationProviderType,
  UsageBucketStats,
  UsagePreferences,
  UsageStatsSummary
} from '../../shared/contracts'
import { usagePreferencesSchema } from '../../shared/schemas'
import { detectProviderBillingKind, formatCliPresetLabel, isLoopbackHost } from '../../shared/usage-billing'
import type { LibraryDatabase } from './database'

export { detectProviderBillingKind }

const USAGE_LEDGER_KEY = 'usage.ledger.v1'
const USAGE_PREFS_KEY = 'usage.preferences.v1'

const DEFAULT_PREFERENCES: UsagePreferences = {
  lowBalanceThreshold: 2,
  priceCurrency: 'CNY',
  inputPricePer1M: null,
  outputPricePer1M: null
}

function createEmptyBucket(): UsageBucketStats {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    apiRequests: 0,
    translatedBlocks: 0,
    translatedPages: 0,
    cacheHitBlocks: 0
  }
}

interface StoredUsageLedger {
  todayDate: string
  today: UsageBucketStats
  total: UsageBucketStats
  updatedAt: string
}

export interface UsageServiceOptions {
  database: LibraryDatabase
  fetchImpl?: typeof fetch
  now?: () => Date
}

export function getLocalDateKey(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function mergeTokenUsage(a?: TokenUsageDelta, b?: TokenUsageDelta): TokenUsageDelta | undefined {
  if (!a && !b) return undefined
  const promptTokens = (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0)
  const completionTokens = (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0)
  const totalTokens = (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0)
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined
  return { promptTokens, completionTokens, totalTokens }
}

export function buildBalanceEndpointUrl(baseUrl: string): string | null {
  try {
    const trimmed = baseUrl.trim().replace(/\/+$/, '')
    const parsed = new URL(trimmed)
    const hostname = parsed.hostname.toLowerCase()
    const pathLower = parsed.pathname.toLowerCase()
    if (!(hostname === 'api.deepseek.com' || (isLoopbackHost(hostname) && pathLower.includes('/deepseek')))) {
      return null
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')
    parsed.pathname = `${cleanPath}/user/balance`.replace(/\/{2,}/g, '/')
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

function parseNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value.trim())
    return Number.isFinite(num) ? num : null
  }
  return null
}

export function parseDeepSeekBalancePayload(
  payload: unknown,
  fetchedAt: string,
  modelLabel: string
): ProviderBalanceSnapshot {
  const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const available = typeof obj.is_available === 'boolean' ? obj.is_available : null
  const infos = Array.isArray(obj.balance_infos)
    ? obj.balance_infos.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : []

  const cnyPositive = infos.find(
    item => String(item.currency ?? '').toUpperCase() === 'CNY' && (parseNumberOrNull(item.total_balance) ?? 0) > 0
  )
  const cnyAny = infos.find(item => String(item.currency ?? '').toUpperCase() === 'CNY')
  const firstPositive = infos.find(item => (parseNumberOrNull(item.total_balance) ?? 0) > 0)
  const picked = cnyPositive ?? firstPositive ?? cnyAny ?? infos[0] ?? null

  const totalBalance = picked ? parseNumberOrNull(picked.total_balance) : null
  const grantedBalance = picked ? parseNumberOrNull(picked.granted_balance) : null
  const toppedUpBalance = picked ? parseNumberOrNull(picked.topped_up_balance) : null
  const currency = picked && typeof picked.currency === 'string' && picked.currency.trim()
    ? picked.currency.trim().toUpperCase()
    : 'CNY'

  return {
    supported: true,
    billingKind: 'deepseek-balance',
    provider: 'openai-compatible',
    modelLabel,
    available,
    currency,
    totalBalance,
    grantedBalance,
    toppedUpBalance,
    fetchedAt,
    note: 'DeepSeek 官方接口支持 GET /user/balance 实时查询真实余额；每次翻译结束后自动刷新一次。'
  }
}

function formatModelLabel(params: {
  provider: TranslationProviderType
  model: string
  cliPreset: CliPreset
  cliModel: string
}): string {
  if (params.provider === 'openai-compatible') {
    return params.model.trim() || 'OpenAI 兼容模型'
  }
  return formatCliPresetLabel(params.cliPreset, params.cliModel)
}

function normalizeBucket(raw: unknown): UsageBucketStats {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const num = (key: keyof UsageBucketStats): number => {
    const val = obj[key]
    return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? Math.trunc(val) : 0
  }
  return {
    promptTokens: num('promptTokens'),
    completionTokens: num('completionTokens'),
    totalTokens: num('totalTokens'),
    apiRequests: num('apiRequests'),
    translatedBlocks: num('translatedBlocks'),
    translatedPages: num('translatedPages'),
    cacheHitBlocks: num('cacheHitBlocks')
  }
}

function applyDeltaToBucket(
  bucket: UsageBucketStats,
  delta: {
    usage?: TokenUsageDelta
    apiRequests?: number
    translatedBlocks?: number
    translatedPages?: number
    cacheHitBlocks?: number
  }
): UsageBucketStats {
  const prompt = Math.max(0, Math.trunc(delta.usage?.promptTokens ?? 0))
  const completion = Math.max(0, Math.trunc(delta.usage?.completionTokens ?? 0))
  const total = Math.max(0, Math.trunc(delta.usage?.totalTokens ?? prompt + completion))
  return {
    promptTokens: bucket.promptTokens + prompt,
    completionTokens: bucket.completionTokens + completion,
    totalTokens: bucket.totalTokens + total,
    apiRequests: bucket.apiRequests + Math.max(0, Math.trunc(delta.apiRequests ?? 0)),
    translatedBlocks: bucket.translatedBlocks + Math.max(0, Math.trunc(delta.translatedBlocks ?? 0)),
    translatedPages: bucket.translatedPages + Math.max(0, Math.trunc(delta.translatedPages ?? 0)),
    cacheHitBlocks: bucket.cacheHitBlocks + Math.max(0, Math.trunc(delta.cacheHitBlocks ?? 0))
  }
}

export class UsageService {
  private readonly database: LibraryDatabase
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(options: UsageServiceOptions) {
    this.database = options.database
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  getPreferences(): UsagePreferences {
    const raw = this.database.getSetting(USAGE_PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFERENCES }
    try {
      const parsed = usagePreferencesSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : { ...DEFAULT_PREFERENCES }
    } catch {
      return { ...DEFAULT_PREFERENCES }
    }
  }

  savePreferences(input: UsagePreferences): UsageStatsSummary {
    const validated = usagePreferencesSchema.parse(input)
    this.database.setSetting(USAGE_PREFS_KEY, JSON.stringify(validated))
    return this.getSummary()
  }

  private readLedger(): StoredUsageLedger {
    const todayDate = getLocalDateKey(this.now())
    const raw = this.database.getSetting(USAGE_LEDGER_KEY)
    if (!raw) {
      return {
        todayDate,
        today: createEmptyBucket(),
        total: createEmptyBucket(),
        updatedAt: this.now().toISOString()
      }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredUsageLedger>
      const total = normalizeBucket(parsed.total)
      const isSameDay = parsed.todayDate === todayDate
      const today = isSameDay ? normalizeBucket(parsed.today) : createEmptyBucket()
      return {
        todayDate,
        today,
        total,
        updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt ? parsed.updatedAt : this.now().toISOString()
      }
    } catch {
      return {
        todayDate,
        today: createEmptyBucket(),
        total: createEmptyBucket(),
        updatedAt: this.now().toISOString()
      }
    }
  }

  private writeLedger(ledger: StoredUsageLedger): void {
    this.database.setSetting(USAGE_LEDGER_KEY, JSON.stringify(ledger))
  }

  getSummary(): UsageStatsSummary {
    const ledger = this.readLedger()
    return {
      todayDate: ledger.todayDate,
      today: ledger.today,
      total: ledger.total,
      preferences: this.getPreferences(),
      updatedAt: ledger.updatedAt
    }
  }

  recordUsage(delta: {
    usage?: TokenUsageDelta
    apiRequests?: number
    translatedBlocks?: number
    translatedPages?: number
    cacheHitBlocks?: number
  }): UsageStatsSummary {
    const ledger = this.readLedger()
    const nowIso = this.now().toISOString()
    const next: StoredUsageLedger = {
      todayDate: ledger.todayDate,
      today: applyDeltaToBucket(ledger.today, delta),
      total: applyDeltaToBucket(ledger.total, delta),
      updatedAt: nowIso
    }
    this.writeLedger(next)
    return {
      todayDate: next.todayDate,
      today: next.today,
      total: next.total,
      preferences: this.getPreferences(),
      updatedAt: nowIso
    }
  }

  resetStats(scope: 'today' | 'all' = 'today'): UsageStatsSummary {
    const ledger = this.readLedger()
    const nowIso = this.now().toISOString()
    const next: StoredUsageLedger = {
      todayDate: ledger.todayDate,
      today: createEmptyBucket(),
      total: scope === 'all' ? createEmptyBucket() : ledger.total,
      updatedAt: nowIso
    }
    this.writeLedger(next)
    return {
      todayDate: next.todayDate,
      today: next.today,
      total: next.total,
      preferences: this.getPreferences(),
      updatedAt: nowIso
    }
  }

  async fetchProviderBalance(
    params: {
      provider: TranslationProviderType
      baseUrl: string
      model: string
      cliPreset: CliPreset
      cliModel: string
      apiKey: string | null
    },
    timeoutMs = 4500
  ): Promise<ProviderBalanceSnapshot> {
    const fetchedAt = this.now().toISOString()
    const modelLabel = formatModelLabel(params)
    const billingKind = detectProviderBillingKind(params.provider, params.baseUrl, Boolean(params.apiKey?.trim()))

    if (billingKind === 'cli-local') {
      return {
        supported: false,
        billingKind,
        provider: params.provider,
        modelLabel,
        available: null,
        currency: null,
        totalBalance: null,
        grantedBalance: null,
        toppedUpBalance: null,
        fetchedAt,
        note: '本机 AI CLI 使用本地已登录客户端订阅配额，不消耗外部 API 余额；已完成译文均已写入 SQLite 缓存。'
      }
    }

    if (billingKind === 'ollama-local') {
      return {
        supported: false,
        billingKind,
        provider: params.provider,
        modelLabel,
        available: null,
        currency: null,
        totalBalance: null,
        grantedBalance: null,
        toppedUpBalance: null,
        fetchedAt,
        note: '当前连接本机离线模型（如 Ollama），本地推理零费用，不产生外部账单。'
      }
    }

    if (billingKind === 'openai-generic') {
      return {
        supported: false,
        billingKind,
        provider: params.provider,
        modelLabel,
        available: null,
        currency: null,
        totalBalance: null,
        grantedBalance: null,
        toppedUpBalance: null,
        fetchedAt,
        note: '该服务商未开放 API Key 余额查询接口，已基于 /chat/completions 响应 usage 字段如实累计本地 Token 用量。'
      }
    }

    const endpoint = buildBalanceEndpointUrl(params.baseUrl)
    const trimmedKey = params.apiKey?.trim() ?? ''
    if (!endpoint || !trimmedKey) {
      return {
        supported: true,
        billingKind: 'deepseek-balance',
        provider: 'openai-compatible',
        modelLabel,
        available: null,
        currency: 'CNY',
        totalBalance: null,
        grantedBalance: null,
        toppedUpBalance: null,
        fetchedAt,
        note: 'DeepSeek 官方接口支持实时查询余额；请先填写 API Key。',
        error: '尚未填写 API Key，无法查询 DeepSeek 余额。'
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('TIMEOUT')), timeoutMs)
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      })
      if (!response.ok) {
        return {
          supported: true,
          billingKind: 'deepseek-balance',
          provider: 'openai-compatible',
          modelLabel,
          available: null,
          currency: 'CNY',
          totalBalance: null,
          grantedBalance: null,
          toppedUpBalance: null,
          fetchedAt,
          note: 'DeepSeek 余额查询返回异常，请检查 API Key 是否有效或稍后重试。',
          error:
            response.status === 401 || response.status === 403
              ? `余额查询鉴权失败（HTTP ${response.status}）`
              : `余额查询失败（HTTP ${response.status}）`
        }
      }
      const payload = (await response.json()) as unknown
      return parseDeepSeekBalancePayload(payload, fetchedAt, modelLabel)
    } catch (err: unknown) {
      const message =
        controller.signal.aborted
          ? '余额查询超时，请稍后手动刷新。'
          : err instanceof Error
            ? err.message
            : String(err)
      return {
        supported: true,
        billingKind: 'deepseek-balance',
        provider: 'openai-compatible',
        modelLabel,
        available: null,
        currency: 'CNY',
        totalBalance: null,
        grantedBalance: null,
        toppedUpBalance: null,
        fetchedAt,
        note: '暂未获取到 DeepSeek 实时余额，不影响翻译与本地 Token 统计。',
        error: message
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
