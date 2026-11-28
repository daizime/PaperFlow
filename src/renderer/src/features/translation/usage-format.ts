import type {
  ProviderBalanceSnapshot,
  ProviderBillingKind,
  TokenUsageDelta,
  TranslatePageResult,
  TranslationProviderType,
  TranslationSettings,
  UsageBucketStats,
  UsagePreferences,
  UsageStatsSummary
} from '../../../../shared/contracts'
import { detectProviderBillingKind } from '../../../../shared/usage-billing'

export function detectCacheSavingsRate(bucket: UsageBucketStats | undefined): number | null {
  if (!bucket) return null
  const totalLookups = bucket.translatedBlocks + bucket.cacheHitBlocks
  if (totalLookups <= 0) return null
  return Math.round((bucket.cacheHitBlocks / totalLookups) * 100)
}

export interface UsageToastState {
  id: string
  tone: 'ok' | 'warn'
  title: string
  body: string
  actionLabel: string
}

export function formatCompactTokens(tokens: number): string {
  const safe = Math.max(0, Math.trunc(tokens))
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(2)}M`
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}k`
  return String(safe)
}

export function formatExactTokens(tokens: number): string {
  return Math.max(0, Math.trunc(tokens)).toLocaleString('en-US')
}

export function currencySymbol(currency: string | null | undefined): string {
  const code = (currency ?? '').trim().toUpperCase()
  if (code === 'USD') return '$'
  if (code === 'CNY' || code === 'RMB') return '¥'
  return code ? `${code} ` : '¥'
}

export function formatMoney(amount: number, currency: string | null | undefined, digits = 2): string {
  return `${currencySymbol(currency)}${amount.toFixed(digits)}`
}

export function estimateReferenceCost(
  usage: TokenUsageDelta | undefined,
  prefs: UsagePreferences | undefined
): { text: string; amount: number } | null {
  if (!usage || !prefs) return null
  if (prefs.inputPricePer1M === null && prefs.outputPricePer1M === null) return null
  const inputRate = prefs.inputPricePer1M ?? 0
  const outputRate = prefs.outputPricePer1M ?? 0
  if (inputRate <= 0 && outputRate <= 0) return null
  const amount =
    (Math.max(0, usage.promptTokens) / 1_000_000) * inputRate +
    (Math.max(0, usage.completionTokens) / 1_000_000) * outputRate
  const digits = amount > 0 && amount < 0.01 ? 4 : amount < 0.1 ? 3 : 2
  return {
    amount,
    text: `≈ ${formatMoney(amount, prefs.priceCurrency, digits)}`
  }
}

export function isLowBalance(
  balance: ProviderBalanceSnapshot | null | undefined,
  prefs: UsagePreferences | undefined
): boolean {
  if (!balance || !balance.supported) return false
  if (balance.available === false) return true
  const threshold = prefs?.lowBalanceThreshold ?? 2
  if (balance.totalBalance !== null && threshold > 0 && balance.totalBalance < threshold) {
    return true
  }
  return false
}

export function inferBillingKindFromDraft(draft: {
  provider: TranslationProviderType
  baseUrl: string
  hasApiKey: boolean
}): ProviderBillingKind {
  return detectProviderBillingKind(draft.provider, draft.baseUrl, draft.hasApiKey)
}

export function inferBillingKindFromSettings(settings: TranslationSettings): ProviderBillingKind {
  return inferBillingKindFromDraft({
    provider: settings.provider,
    baseUrl: settings.openai.baseUrl,
    hasApiKey: settings.openai.hasApiKey
  })
}

export function defaultBillingNote(billingKind: ProviderBillingKind, isPreviewingOtherProvider = false): string {
  switch (billingKind) {
    case 'cli-local':
      return '本机 AI CLI 使用本地已登录客户端订阅配额，不消耗外部 API 余额；已完成译文均已写入 SQLite 缓存。'
    case 'ollama-local':
      return '本地 Ollama 离线推理不消耗云端额度；已完成译文均已写入 SQLite 缓存。'
    case 'deepseek-balance':
      return isPreviewingOtherProvider
        ? '当前正在预览未保存的 API 配置；可点击右上「刷新余额」测试查询真实余额，或点击底部「保存并切换为 API」启用。'
        : 'DeepSeek 官方接口支持 GET /user/balance 实时查询真实余额；点击右上「刷新余额」或完成一次翻译后自动刷新。'
    default:
      return '当前 OpenAI 兼容服务商未提供标准 Key 查余额接口；系统仍会在每次翻译后精确记录实测 Token，并可在上方填写参考单价估算费用。'
  }
}

export interface HeaderEnginePillModel {
  text: string
  compactText: string
  detailBadge: string | null
  tone: 'ok' | 'warn'
  tooltip: string
}

export function formatHeaderEnginePill(
  settings: TranslationSettings | null,
  engineLabel: string | null,
  balance: ProviderBalanceSnapshot | null,
  usageSummary: UsageStatsSummary | null
): HeaderEnginePillModel {
  if (!settings) {
    return {
      text: '设置',
      compactText: '设置',
      detailBadge: null,
      tone: 'ok',
      tooltip: '翻译引擎、模型、余额与词库设置'
    }
  }

  const baseText =
    settings.provider === 'cli'
      ? `CLI · ${engineLabel ?? '本机 CLI'}`
      : `API · ${engineLabel ?? settings.openai.model}`

  const billingKind = balance?.billingKind ?? inferBillingKindFromSettings(settings)
  const warn = isLowBalance(balance, usageSummary?.preferences)

  if (billingKind === 'deepseek-balance' && balance?.totalBalance !== null && balance?.totalBalance !== undefined) {
    const moneyText = formatMoney(balance.totalBalance, balance.currency, 2)
    return {
      text: `${baseText} · 余 ${moneyText}${warn ? ' ⚠' : ''}`,
      compactText: warn ? `${baseText} · 余 ${moneyText} ⚠` : baseText,
      detailBadge: warn ? `余 ${moneyText} ⚠ · 低于预警线` : `实时余额 ${moneyText}`,
      tone: warn ? 'warn' : 'ok',
      tooltip: warn
        ? `当前 DeepSeek 账户余额 ${moneyText}，已低于预警线；点击查看余额详情或充值`
        : `当前引擎：${baseText} · DeepSeek 实时余额 ${moneyText}（今日累计 ${formatExactTokens(usageSummary?.today.totalTokens ?? 0)} tok）`
    }
  }

  if (billingKind === 'ollama-local') {
    return {
      text: `${baseText} · 离线免费`,
      compactText: baseText,
      detailBadge: '离线免费',
      tone: 'ok',
      tooltip: `当前使用本机离线模型（${baseText}），零外部计费`
    }
  }

  if (billingKind === 'cli-local') {
    return {
      text: `${baseText} · 订阅配额`,
      compactText: baseText,
      detailBadge: '订阅配额',
      tone: 'ok',
      tooltip: `当前使用本机 CLI 客户端（${baseText}），消耗已登录订阅账号配额；已完成 ${usageSummary?.today.translatedBlocks ?? 0} 块`
    }
  }

  const todayTokens = usageSummary?.today.totalTokens ?? 0
  if (todayTokens > 0) {
    const compactTok = `今日 ${formatCompactTokens(todayTokens)} tok`
    return {
      text: `${baseText} · ${compactTok}`,
      compactText: baseText,
      detailBadge: compactTok,
      tone: 'ok',
      tooltip: `当前引擎：${baseText}（无官方余额查询接口；今日实测累计 ${formatExactTokens(todayTokens)} tokens）`
    }
  }

  return {
    text: baseText,
    compactText: baseText,
    detailBadge: 'OpenAI 兼容 API',
    tone: 'ok',
    tooltip: `当前生效引擎：OpenAI 兼容 API · ${settings.openai.model}；点击查看用量与余额详情`
  }
}

export function buildTranslationCompletionToast(params: {
  result: TranslatePageResult
  documentTitle?: string
  isBackground?: boolean
  settings: TranslationSettings | null
  balance: ProviderBalanceSnapshot | null
  usageSummary: UsageStatsSummary | null
  pageCountOverride?: number
}): UsageToastState {
  const { result, documentTitle, isBackground, settings, balance, usageSummary, pageCountOverride } = params
  const effectiveBalance = result.balance ?? balance
  const billingKind =
    result.billingKind ??
    effectiveBalance?.billingKind ??
    (settings ? inferBillingKindFromSettings(settings) : 'openai-generic')
  const warn = isLowBalance(effectiveBalance, usageSummary?.preferences)
  const latencyText =
    typeof result.latencyMs === 'number' && result.latencyMs > 0
      ? `，耗时 ${(result.latencyMs / 1000).toFixed(1)}s`
      : ''
  const scopePrefix = isBackground && documentTitle ? `后台 · 《${documentTitle}》` : ''
  const targetLabel = pageCountOverride
    ? `${scopePrefix}连续翻译完成（共 ${pageCountOverride} 页 / ${result.translatedCount} 块${latencyText}）`
    : `${scopePrefix}第 ${result.pageNumber} 页翻译完成（${result.translatedCount} 块${latencyText}）`

  const usage = result.usage
  const costEst = estimateReferenceCost(usage, usageSummary?.preferences)
  const tokenSegment = usage
    ? `本次消耗 ${formatExactTokens(usage.totalTokens)} tokens（输入 ${formatExactTokens(usage.promptTokens)} / 输出 ${formatExactTokens(usage.completionTokens)}）${costEst ? `（${costEst.text}）` : ''}`
    : ''

  if (billingKind === 'deepseek-balance' && effectiveBalance?.totalBalance !== null && effectiveBalance?.totalBalance !== undefined) {
    const moneyText = formatMoney(effectiveBalance.totalBalance, effectiveBalance.currency, 2)
    if (warn) {
      const thresholdText = formatMoney(
        usageSummary?.preferences.lowBalanceThreshold ?? 2,
        effectiveBalance.currency,
        2
      )
      return {
        id: `${Date.now()}-${result.pageNumber}-warn`,
        tone: 'warn',
        title: `⚠ 翻译完成（余额偏低：剩余 ${moneyText}）`,
        body: `${tokenSegment ? `${tokenSegment} · ` : ''}当前余额已低于 ${thresholdText} 预警线，建议及时充值以免批量连翻中断。`,
        actionLabel: '查看余额详情 / 调整预警线'
      }
    }
    return {
      id: `${Date.now()}-${result.pageNumber}-ok`,
      tone: 'ok',
      title: `✓ ${targetLabel}`,
      body: `${tokenSegment ? `${tokenSegment} · ` : ''}账户实时余额 ${moneyText}`,
      actionLabel: '查看用量明细'
    }
  }

  if (billingKind === 'cli-local') {
    const label = result.providerLabel || '本机 CLI'
    return {
      id: `${Date.now()}-${result.pageNumber}-cli`,
      tone: 'ok',
      title: `✓ ${targetLabel}`,
      body: `本次由 ${label} 完成，使用本地已登录客户端配额并已写入 SQLite 缓存，不消耗外部 API 余额。`,
      actionLabel: '查看本地用量统计'
    }
  }

  if (billingKind === 'ollama-local') {
    const todayTok = usageSummary?.today.totalTokens ?? usage?.totalTokens ?? 0
    return {
      id: `${Date.now()}-${result.pageNumber}-ollama`,
      tone: 'ok',
      title: `✓ ${targetLabel}`,
      body: `本机离线推理零费用（${todayTok > 0 ? `今日输出统计 ${formatExactTokens(todayTok)} tokens` : '已写入 SQLite 缓存'}）。`,
      actionLabel: '查看用量明细'
    }
  }

  const todayTotal = usageSummary?.today.totalTokens ?? usage?.totalTokens ?? 0
  return {
    id: `${Date.now()}-${result.pageNumber}-generic`,
    tone: 'ok',
    title: `✓ ${targetLabel}`,
    body: tokenSegment
      ? `${tokenSegment}（该服务商未提供余额查询接口，今日实测累计 ${formatExactTokens(todayTotal)} tokens）`
      : `已完成翻译并写入本地 SQLite 缓存（该服务商未提供余额查询接口，未返回 usage Token）。`,
    actionLabel: usageSummary?.preferences.inputPricePer1M !== null ? '查看用量明细' : '设置 Token 单价估算'
  }
}

export function buildLowBalanceErrorToast(message: string): UsageToastState {
  return {
    id: `${Date.now()}-err-402`,
    tone: 'warn',
    title: '⚠ 接口余额不足或配额受限',
    body: message,
    actionLabel: '打开引擎与余额设置'
  }
}
