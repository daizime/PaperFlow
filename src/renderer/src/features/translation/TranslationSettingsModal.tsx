import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CliPreset,
  DetectedLocalAiClient,
  ProviderBalanceSnapshot,
  SaveTranslationSettingsInput,
  TranslationProviderType,
  TranslationSettings,
  TranslationTestResult,
  UsagePreferences,
  UsageStatsSummary
} from '../../../../shared/contracts'
import { formatGlossaryLines, parseGlossaryLines } from '../../../../shared/glossary-text'
import { formatCliPresetLabel } from '../../../../shared/usage-billing'
import {
  currencySymbol,
  defaultBillingNote,
  detectCacheSavingsRate,
  estimateReferenceCost,
  formatExactTokens,
  formatMoney,
  inferBillingKindFromDraft,
  isLowBalance
} from './usage-format'

function formatHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host || baseUrl.trim()
  } catch {
    return baseUrl.trim()
  }
}

function formatCommandLeaf(command: string): string {
  const parts = command.trim().split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? command.trim()
}

export interface TranslationSettingsModalProps {
  open: boolean
  documentId: string | null
  initialBalance?: ProviderBalanceSnapshot | null
  initialUsageSummary?: UsageStatsSummary | null
  focusSection?: 'default' | 'usage'
  prefetchNextPage?: boolean
  onPrefetchNextPageChange?(enabled: boolean): void
  onClose(): void
  onSaved(settings: TranslationSettings): void
  onDocumentCacheCleared?(): void
  onBalanceUpdated?(balance: ProviderBalanceSnapshot): void
  onUsageUpdated?(summary: UsageStatsSummary): void
}

export function TranslationSettingsModal({
  open,
  documentId,
  initialBalance = null,
  initialUsageSummary = null,
  focusSection = 'default',
  prefetchNextPage = false,
  onPrefetchNextPageChange,
  onClose,
  onSaved,
  onDocumentCacheCleared,
  onBalanceUpdated,
  onUsageUpdated
}: TranslationSettingsModalProps): React.JSX.Element | null {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testingElapsedSec, setTestingElapsedSec] = useState(0)
  const [clearing, setClearing] = useState(false)
  const [savedSettings, setSavedSettings] = useState<TranslationSettings | null>(null)

  const [provider, setProvider] = useState<TranslationProviderType>('openai-compatible')
  const [targetLanguage, setTargetLanguage] = useState('zh-CN')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1')
  const [model, setModel] = useState('deepseek-chat')
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [hasStoredKey, setHasStoredKey] = useState(false)
  const [apiKeyPreview, setApiKeyPreview] = useState<string | null>(null)
  const [clearKeyRequested, setClearKeyRequested] = useState(false)

  const [cliPreset, setCliPreset] = useState<CliPreset>('codex')
  const [cliCommand, setCliCommand] = useState('codex')
  const [cliModel, setCliModel] = useState('')
  const [cliExtraArgsText, setCliExtraArgsText] = useState('')
  const [cliTimeoutSec, setCliTimeoutSec] = useState(120)
  const [glossaryText, setGlossaryText] = useState('')

  const [balanceSnapshot, setBalanceSnapshot] = useState<ProviderBalanceSnapshot | null>(initialBalance)
  const [usageSummary, setUsageSummary] = useState<UsageStatsSummary | null>(initialUsageSummary)
  const [refreshingBalance, setRefreshingBalance] = useState(false)
  const [resettingUsage, setResettingUsage] = useState(false)
  const [lowBalanceThresholdText, setLowBalanceThresholdText] = useState('2')
  const [priceCurrency, setPriceCurrency] = useState<'CNY' | 'USD'>('CNY')
  const [inputPriceText, setInputPriceText] = useState('')
  const [outputPriceText, setOutputPriceText] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<TranslationTestResult | null>(null)
  const [detectedClients, setDetectedClients] = useState<DetectedLocalAiClient[]>([])
  const [scanningClients, setScanningClients] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  const usageCardRef = useRef<HTMLDivElement | null>(null)
  const openSyncRef = useRef({
    initialBalance,
    initialUsageSummary,
    onBalanceUpdated,
    onUsageUpdated
  })
  openSyncRef.current = {
    initialBalance,
    initialUsageSummary,
    onBalanceUpdated,
    onUsageUpdated
  }

  const applyUsageSummary = useCallback((summary: UsageStatsSummary): void => {
    setUsageSummary(summary)
    setLowBalanceThresholdText(String(summary.preferences.lowBalanceThreshold))
    setPriceCurrency(summary.preferences.priceCurrency)
    setInputPriceText(summary.preferences.inputPricePer1M !== null ? String(summary.preferences.inputPricePer1M) : '')
    setOutputPriceText(summary.preferences.outputPricePer1M !== null ? String(summary.preferences.outputPricePer1M) : '')
  }, [])

  const applySettings = (settings: TranslationSettings): void => {
    setSavedSettings(settings)
    setProvider(settings.provider)
    setTargetLanguage(settings.targetLanguage)
    setBaseUrl(settings.openai.baseUrl)
    setModel(settings.openai.model)
    setHasStoredKey(settings.openai.hasApiKey)
    setApiKeyPreview(settings.openai.apiKeyPreview)
    setApiKeyDraft('')
    setClearKeyRequested(false)
    setCliPreset(settings.cli.preset)
    setCliCommand(settings.cli.command)
    setCliModel(settings.cli.model)
    setCliExtraArgsText(settings.cli.extraArgs.join(' '))
    setCliTimeoutSec(settings.cli.timeoutSec)
    setGlossaryText(formatGlossaryLines(settings.glossary ?? []))
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotice(null)
    setTestResult(null)
    const {
      initialBalance: initBal,
      initialUsageSummary: initUsage,
      onBalanceUpdated: emitBalance,
      onUsageUpdated: emitUsage
    } = openSyncRef.current
    if (initBal) setBalanceSnapshot(initBal)
    if (initUsage) applyUsageSummary(initUsage)

    void Promise.all([
      window.paperflow.getTranslationSettings(),
      window.paperflow.getUsageSummary().catch(() => null),
      window.paperflow.getProviderBalance().catch(() => null)
    ])
      .then(([settings, summary, balance]) => {
        if (cancelled) return
        applySettings(settings)
        if (summary) {
          applyUsageSummary(summary)
          emitUsage?.(summary)
        }
        if (balance) {
          setBalanceSnapshot(balance)
          emitBalance?.(balance)
        }
        if (focusSection === 'usage') {
          window.requestAnimationFrame(() => {
            usageCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, focusSection, applyUsageSummary])

  const runLocalClientScan = useCallback(async (): Promise<void> => {
    setScanningClients(true)
    setScanError(null)
    try {
      const items = await window.paperflow.detectLocalAiClients()
      setDetectedClients(items)
    } catch (err: unknown) {
      setScanError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanningClients(false)
    }
  }, [])

  useEffect(() => {
    if (!open || provider !== 'cli') return
    void runLocalClientScan()
  }, [open, provider, runLocalClientScan])

  useEffect(() => {
    if (!open || !testResult?.ok) return
    const timer = window.setTimeout(() => {
      setTestResult(null)
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [open, testResult])

  useEffect(() => {
    if (!open || !notice) return
    const timer = window.setTimeout(() => {
      setNotice(null)
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [open, notice])

  useEffect(() => {
    if (!testing) {
      setTestingElapsedSec(0)
      return
    }
    const started = Date.now()
    setTestingElapsedSec(0)
    const timer = window.setInterval(() => {
      setTestingElapsedSec(Math.floor((Date.now() - started) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [testing])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const buildPayload = (): SaveTranslationSettingsInput => {
    const trimmedKey = apiKeyDraft.trim()
    const apiKeyField = clearKeyRequested ? '' : trimmedKey.length > 0 ? trimmedKey : undefined
    const parsedExtraArgs = cliExtraArgsText
      .split(/\s+/)
      .map(token => token.trim())
      .filter(Boolean)

    return {
      provider,
      targetLanguage,
      glossary: parseGlossaryLines(glossaryText),
      openai: {
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKeyField !== undefined ? { apiKey: apiKeyField } : {})
      },
      cli: {
        preset: cliPreset,
        command: cliCommand.trim(),
        model: cliModel.trim(),
        extraArgs: parsedExtraArgs,
        timeoutSec: Math.max(10, Math.min(300, Math.trunc(Number(cliTimeoutSec) || 120)))
      }
    }
  }

  const buildUsagePrefsPayload = (): UsagePreferences => {
    const parseOptNum = (raw: string, fallback: number | null): number | null => {
      const trimmed = raw.trim()
      if (!trimmed) return fallback
      const num = Number(trimmed)
      return Number.isFinite(num) && num >= 0 ? num : fallback
    }
    const thresholdRaw = parseOptNum(lowBalanceThresholdText, 2) ?? 2
    return {
      lowBalanceThreshold: Math.min(100000, Math.max(0, thresholdRaw)),
      priceCurrency,
      inputPricePer1M: parseOptNum(inputPriceText, null),
      outputPricePer1M: parseOptNum(outputPriceText, null)
    }
  }

  const persistCurrent = async (): Promise<TranslationSettings | null> => {
    setError(null)
    setNotice(null)
    setSaving(true)
    try {
      const saved = await window.paperflow.saveTranslationSettings(buildPayload())
      applySettings(saved)
      onSaved(saved)
      const prefs = buildUsagePrefsPayload()
      const updatedSummary = await window.paperflow.saveUsagePreferences(prefs).catch(() => null)
      if (updatedSummary) {
        applyUsageSummary(updatedSummary)
        onUsageUpdated?.(updatedSummary)
      }
      const updatedBalance = await window.paperflow.getProviderBalance().catch(() => null)
      if (updatedBalance) {
        setBalanceSnapshot(updatedBalance)
        onBalanceUpdated?.(updatedBalance)
      }
      return saved
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setSaving(false)
    }
  }

  const handleRefreshBalance = async (): Promise<void> => {
    setRefreshingBalance(true)
    setError(null)
    try {
      const balance = await window.paperflow.getProviderBalance(buildPayload())
      setBalanceSnapshot(balance)
      if (savedSettings && balance.provider === savedSettings.provider) {
        onBalanceUpdated?.(balance)
      }
      if (balance.error) {
        setNotice(`余额检查提示：${balance.error}`)
      } else if (balance.supported && balance.totalBalance !== null) {
        setNotice(`已刷新真实余额：${formatMoney(balance.totalBalance, balance.currency, 2)}`)
      } else {
        setNotice(balance.note)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshingBalance(false)
    }
  }

  const handleResetUsage = async (): Promise<void> => {
    setResettingUsage(true)
    setError(null)
    try {
      const updated = await window.paperflow.resetUsageStats('all')
      applyUsageSummary(updated)
      onUsageUpdated?.(updated)
      setNotice('已清零本地累计 Token 与缓存命中统计。')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setResettingUsage(false)
    }
  }

  const handleSaveAndClose = async (): Promise<void> => {
    const saved = await persistCurrent()
    if (saved) onClose()
  }

  const handleTest = async (): Promise<void> => {
    setError(null)
    setNotice(null)
    setTestResult(null)
    setTesting(true)
    try {
      const payload = buildPayload()
      const res = await window.paperflow.testTranslationConnection(payload)
      setTestResult(res)
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        latencyMs: 0,
        testedProvider: provider,
        testedLabel:
          provider === 'openai-compatible'
            ? model.trim() || 'OpenAI 兼容 API'
            : formatCliPresetLabel(cliPreset, cliModel),
        testedTarget:
          provider === 'openai-compatible' ? formatHostLabel(baseUrl) : cliCommand.trim() || cliPreset,
        error: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setTesting(false)
    }
  }

  const handleClearCache = async (): Promise<void> => {
    if (!documentId) return
    setClearing(true)
    setError(null)
    try {
      await window.paperflow.clearDocumentTranslations(documentId)
      setNotice('已清空本文档本地译文缓存。')
      onDocumentCacheCleared?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearing(false)
    }
  }

  const handleBrowseExecutable = async (targetPreset?: Exclude<CliPreset, 'custom'>, targetName?: string): Promise<void> => {
    setError(null)
    try {
      const picked = await window.paperflow.pickCliExecutable()
      if (picked.canceled || !picked.filePath) return
      setProvider('cli')
      if (targetPreset) {
        setCliPreset(targetPreset)
      }
      setCliCommand(picked.filePath)
      setTestResult(null)
      setNotice(`已选择${targetName ? ` ${targetName}` : ''}可执行文件，点击「测试连接」验证或「保存设置」生效。`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleApplyDetectedClient = (client: DetectedLocalAiClient): void => {
    if (!client.command) return
    setProvider('cli')
    setCliPreset(client.preset)
    setCliCommand(client.command)
    setTestResult(null)
    setError(null)
    const switchHint = savedSettings && savedSettings.provider !== 'cli' ? '保存并切换为本机 CLI' : '保存设置'
    setNotice(`已填入 ${client.name}（尚未切换生效），可先点下方测试验证，或点击「${switchHint}」正式启用。`)
  }

  const handleSwitchProviderTab = (nextProvider: TranslationProviderType): void => {
    setProvider(nextProvider)
    setNotice(null)
    setTestResult(null)
    setError(null)
  }

  const findReadyCommand = (preset: Exclude<CliPreset, 'custom'>): string =>
    detectedClients.find(item => item.preset === preset && item.status === 'ready' && item.command)?.command ?? preset

  const isPreviewingOtherProvider = Boolean(savedSettings && provider !== savedSettings.provider)
  const testButtonText = testing
    ? testingElapsedSec > 0
      ? `测试中 (${testingElapsedSec}s)…`
      : '测试中…'
    : provider === 'openai-compatible'
      ? `测试 API（${model.trim() || '未填模型'}）`
      : `测试 CLI（${formatCliPresetLabel(cliPreset, cliModel)}）`
  const saveButtonText = saving
    ? '保存中…'
    : isPreviewingOtherProvider
      ? provider === 'cli'
        ? '保存并切换为本机 CLI'
        : '保存并切换为 API'
      : '保存设置'

  return (
    <div
      className="translation-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="translation-modal" role="dialog" aria-modal="true" aria-labelledby="translation-settings-title">
        <div className="translation-modal__header">
          <div>
            <h3 id="translation-settings-title">翻译与 AI 引擎设置</h3>
            <p className="translation-modal__subtitle">用于双栏对照翻译、划词解释、AI 对话与科研技能</p>
          </div>
          <button type="button" className="translation-modal__close" aria-label="关闭设置" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="translation-modal__body">
          {loading ? (
            <p className="translation-modal__hint">正在加载配置…</p>
          ) : (
            <>
              {savedSettings ? (
                <div className="translation-modal__active-banner" data-testid="active-engine-banner">
                  <div className="translation-modal__active-main">
                    <span className="translation-modal__active-dot" aria-hidden="true" />
                    <span>
                      当前实际生效引擎：
                      <strong>
                        {savedSettings.provider === 'openai-compatible'
                          ? `OpenAI 兼容 API · ${savedSettings.openai.model}`
                          : `本机 AI CLI · ${formatCliPresetLabel(savedSettings.cli.preset, savedSettings.cli.model)}`}
                      </strong>
                      <small className="translation-modal__active-target">
                        （
                        {savedSettings.provider === 'openai-compatible'
                          ? formatHostLabel(savedSettings.openai.baseUrl)
                          : formatCommandLeaf(savedSettings.cli.command)}
                        ）
                      </small>
                    </span>
                  </div>
                  {isPreviewingOtherProvider ? (
                    <span className="translation-modal__draft-badge" data-testid="engine-draft-preview-badge">
                      正在预览未保存页签
                    </span>
                  ) : null}
                </div>
              ) : null}

              <div className="translation-modal__field">
                <span className="translation-modal__label">选择引擎类型（仅保存选中的那一侧会生效，另一侧配置自动保留）</span>
                <div className="translation-modal__segmented">
                  <button
                    type="button"
                    className={provider === 'openai-compatible' ? 'is-active' : undefined}
                    onClick={() => handleSwitchProviderTab('openai-compatible')}
                  >
                    <span className="translation-modal__tab-head">
                      <span>OpenAI 兼容 API</span>
                      {savedSettings?.provider === 'openai-compatible' ? (
                        <span className="translation-modal__tab-active-pill" data-testid="engine-active-pill-openai">
                          ● 生效中
                        </span>
                      ) : null}
                    </span>
                    <span className="translation-modal__tab-desc">DeepSeek / OpenAI / 本机 Ollama HTTP 接口</span>
                  </button>
                  <button
                    type="button"
                    className={provider === 'cli' ? 'is-active' : undefined}
                    onClick={() => handleSwitchProviderTab('cli')}
                  >
                    <span className="translation-modal__tab-head">
                      <span>本机 AI CLI / 客户端</span>
                      {savedSettings?.provider === 'cli' ? (
                        <span className="translation-modal__tab-active-pill" data-testid="engine-active-pill-cli">
                          ● 生效中
                        </span>
                      ) : null}
                    </span>
                    <span className="translation-modal__tab-desc">Codex / Gemini CLI（本机客户端均由 CLI 驱动）</span>
                  </button>
                </div>
              </div>

              <label className="translation-modal__field">
                <span className="translation-modal__label">目标语言</span>
                <select value={targetLanguage} onChange={e => setTargetLanguage(e.target.value)}>
                  <option value="zh-CN">简体中文（zh-CN）</option>
                  <option value="zh-TW">繁體中文（zh-TW）</option>
                  <option value="en">English（en）</option>
                  <option value="ja">日本語（ja）</option>
                </select>
              </label>

              {provider === 'openai-compatible' ? (
                <>
                  <div className="translation-modal__presets">
                    <span>常用预设：</span>
                    <button
                      type="button"
                      onClick={() => {
                        setBaseUrl('https://api.deepseek.com/v1')
                        setModel('deepseek-chat')
                        setTestResult(null)
                        setNotice(null)
                      }}
                    >
                      DeepSeek
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBaseUrl('https://api.openai.com/v1')
                        setModel('gpt-4o-mini')
                        setTestResult(null)
                        setNotice(null)
                      }}
                    >
                      OpenAI
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBaseUrl('http://127.0.0.1:11434/v1')
                        setModel('qwen2.5:7b')
                        setClearKeyRequested(true)
                        setTestResult(null)
                        setNotice(null)
                      }}
                    >
                      Ollama（本机离线）
                    </button>
                  </div>

                  <label className="translation-modal__field">
                    <span className="translation-modal__label">API Base URL</span>
                    <input
                      type="url"
                      aria-label="API Base URL"
                      value={baseUrl}
                      onChange={e => setBaseUrl(e.target.value)}
                      placeholder="https://api.deepseek.com/v1"
                    />
                  </label>

                  <label className="translation-modal__field">
                    <span className="translation-modal__label">模型名称</span>
                    <input
                      type="text"
                      aria-label="API 模型名称"
                      value={model}
                      onChange={e => setModel(e.target.value)}
                      placeholder="deepseek-chat"
                    />
                  </label>

                  <div className="translation-modal__field">
                    <div className="translation-modal__label-row">
                      <span className="translation-modal__label">API Key（本地加密保存，可选）</span>
                      {hasStoredKey && !clearKeyRequested ? (
                        <button
                          type="button"
                          className="translation-modal__link"
                          onClick={() => {
                            setClearKeyRequested(true)
                            setApiKeyDraft('')
                          }}
                        >
                          清除已存密钥
                        </button>
                      ) : null}
                    </div>
                    <input
                      type="password"
                      aria-label="API Key"
                      value={apiKeyDraft}
                      onChange={e => {
                        setApiKeyDraft(e.target.value)
                        if (e.target.value.length > 0) setClearKeyRequested(false)
                      }}
                      placeholder={
                        clearKeyRequested
                          ? '保存时将清空密钥（本机 Ollama 可留空）'
                          : hasStoredKey
                            ? `已安全保存 (${apiKeyPreview ?? '***'})，留空保持不变`
                            : '填写密钥；连接本机 Ollama 可留空'
                      }
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="translation-modal__clients" data-testid="local-ai-clients-panel">
                    <div className="translation-modal__clients-head">
                      <div>
                        <span className="translation-modal__label">本机 AI 客户端自动发现（均由 CLI 引擎驱动）</span>
                        <p className="translation-modal__hint">
                          点击「选中填入」仅将对应客户端路径填入下方命令行；点击底部保存后才正式切换生效，原有 API 密钥会保留。
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={scanningClients}
                        onClick={() => void runLocalClientScan()}
                      >
                        {scanningClients ? '扫描中…' : '重新扫描'}
                      </button>
                    </div>

                    {scanError ? (
                      <div role="alert" className="error-banner">
                        {scanError}
                      </div>
                    ) : null}

                    <div className="translation-client-list">
                      {detectedClients.map(client => {
                        const isSelected =
                          cliPreset === client.preset &&
                          Boolean(client.command && cliCommand.trim() === client.command)
                        const isActiveOnDisk =
                          savedSettings?.provider === 'cli' &&
                          savedSettings.cli.preset === client.preset &&
                          Boolean(client.command && savedSettings.cli.command.trim() === client.command)
                        const badgeClass =
                          client.status === 'ready'
                            ? 'translation-client-card__badge--ready'
                            : client.status === 'gui-only'
                              ? 'translation-client-card__badge--gui'
                              : 'translation-client-card__badge--missing'
                        const badgeLabel =
                          client.status === 'ready'
                            ? '已就绪'
                            : client.status === 'gui-only'
                              ? '仅桌面端'
                              : '未检测到'
                        return (
                          <div
                            key={client.preset}
                            data-testid={`local-ai-client-${client.preset}`}
                            className={`translation-client-card${isSelected ? ' is-selected' : ''}`}
                          >
                            <div className="translation-client-card__main">
                              <div className="translation-client-card__title-row">
                                <strong>{client.name}</strong>
                                <span className={`translation-client-card__badge ${badgeClass}`}>
                                  {badgeLabel}
                                </span>
                                {client.version ? (
                                  <span className="translation-client-card__version">{client.version}</span>
                                ) : null}
                                {isActiveOnDisk ? (
                                  <span className="translation-client-card__active-tag">● 已生效</span>
                                ) : isSelected ? (
                                  <span className="translation-client-card__selected-tag">已填入（待保存）</span>
                                ) : null}
                              </div>
                              {client.command ? (
                                <div className="translation-client-card__path" title={client.command}>
                                  {client.source ? `${client.source} · ` : ''}
                                  {client.command}
                                </div>
                              ) : (
                                <div className="translation-client-card__hint">{client.hint}</div>
                              )}
                            </div>
                            <div className="translation-client-card__actions">
                              {client.status === 'ready' && client.command ? (
                                <button
                                  type="button"
                                  className={isSelected ? 'is-selected' : undefined}
                                  onClick={() => handleApplyDetectedClient(client)}
                                >
                                  {isSelected ? '已填入' : '选中填入'}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void handleBrowseExecutable(client.preset, client.name)}
                                >
                                  手动指定…
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="translation-modal__presets">
                    <span>CLI 预设：</span>
                    <button
                      type="button"
                      onClick={() => {
                        setCliPreset('codex')
                        setCliCommand(findReadyCommand('codex'))
                        setTestResult(null)
                      }}
                    >
                      Codex CLI
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCliPreset('gemini')
                        setCliCommand(findReadyCommand('gemini'))
                        setTestResult(null)
                      }}
                    >
                      Gemini CLI
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCliPreset('custom')
                        setTestResult(null)
                      }}
                    >
                      自定义 CLI
                    </button>
                  </div>

                  <label className="translation-modal__field">
                    <span className="translation-modal__label">命令名称或绝对路径</span>
                    <div className="translation-modal__input-row">
                      <input
                        type="text"
                        aria-label="CLI 命令"
                        value={cliCommand}
                        onChange={e => setCliCommand(e.target.value)}
                        placeholder="codex"
                      />
                      <button type="button" onClick={() => void handleBrowseExecutable()}>
                        浏览程序…
                      </button>
                    </div>
                  </label>

                  <div className="translation-modal__row">
                    <label className="translation-modal__field">
                      <span className="translation-modal__label">模型名称（可选）</span>
                      <input
                        type="text"
                        aria-label="CLI 模型参数"
                        value={cliModel}
                        onChange={e => setCliModel(e.target.value)}
                        placeholder="留空使用 CLI 默认模型"
                      />
                    </label>
                    <label className="translation-modal__field translation-modal__field--small">
                      <span className="translation-modal__label">超时（秒）</span>
                      <input
                        type="number"
                        min={10}
                        max={300}
                        aria-label="CLI 超时时间"
                        value={cliTimeoutSec}
                        onChange={e => setCliTimeoutSec(Number(e.target.value))}
                      />
                    </label>
                  </div>

                  <label className="translation-modal__field">
                    <span className="translation-modal__label">附加参数（空格分隔，可选）</span>
                    <input
                      type="text"
                      aria-label="CLI 附加参数"
                      value={cliExtraArgsText}
                      onChange={e => setCliExtraArgsText(e.target.value)}
                      placeholder="例如：--profile fast"
                    />
                  </label>
                </>
              )}

              <label className="translation-modal__field">
                <div className="translation-modal__label-row">
                  <span className="translation-modal__label">自定义术语表（每行一条：原文 =&gt; 译文）</span>
                  <span className="translation-modal__hint">
                    已识别 {parseGlossaryLines(glossaryText).length} 条
                  </span>
                </div>
                <span className="translation-modal__hint">
                  此为全局默认术语表；若文献已归入左侧分类文件夹，翻译时将优先按该分类的专属术语表独立生效。
                </span>
                <textarea
                  rows={3}
                  aria-label="自定义术语表"
                  value={glossaryText}
                  onChange={e => setGlossaryText(e.target.value)}
                  placeholder={'F-IVM => F-IVM\nview tree => 视图树\nmarginalization => 边缘化'}
                />
              </label>

              {onPrefetchNextPageChange ? (
                <label className="translation-prefetch-row">
                  <input
                    type="checkbox"
                    data-testid="prefetch-next-page-toggle"
                    checked={prefetchNextPage}
                    onChange={e => onPrefetchNextPageChange(e.target.checked)}
                  />
                  <div>
                    <strong>翻页自动静默预译下一页（默认关闭）</strong>
                    <div className="translation-modal__hint">
                      开启后，当你在双栏或译文视图读完已译的当前页时，后台静默预译下一页，减少翻页等待（会消耗对应 API 额度）。
                    </div>
                  </div>
                </label>
              ) : null}

              {(() => {
                const livePrefs = buildUsagePrefsPayload()
                const draftHasApiKey = !clearKeyRequested && (apiKeyDraft.trim().length > 0 || hasStoredKey)
                const activeBillingKind = inferBillingKindFromDraft({
                  provider,
                  baseUrl,
                  hasApiKey: draftHasApiKey
                })
                const effectiveBalance =
                  balanceSnapshot &&
                  balanceSnapshot.provider === provider &&
                  balanceSnapshot.billingKind === activeBillingKind
                    ? balanceSnapshot
                    : null
                const lowWarn = isLowBalance(effectiveBalance, livePrefs)
                const isCliTab = provider === 'cli'
                const todayBucket = usageSummary?.today
                const totalBucket = usageSummary?.total
                const todayCostEst = estimateReferenceCost(
                  todayBucket
                    ? {
                        promptTokens: todayBucket.promptTokens,
                        completionTokens: todayBucket.completionTokens,
                        totalTokens: todayBucket.totalTokens
                      }
                    : undefined,
                  livePrefs
                )
                const showCostEst = !isCliTab ? todayCostEst : null
                const cacheRate = detectCacheSavingsRate(totalBucket)
                return (
                  <div ref={usageCardRef} className="translation-usage-card" data-testid="usage-balance-card">
                    <div className="translation-usage-card__head">
                      <div>
                        <span className="translation-modal__label">账户余额与本地用量统计</span>
                        <p className="translation-modal__hint">
                          仅展示服务端真实返回余额及接口响应 usage 实测 Token，绝不伪造账单。
                        </p>
                      </div>
                      <div className="translation-usage-card__head-actions">
                        {!isCliTab ? (
                          <button
                            type="button"
                            data-testid="refresh-balance-btn"
                            disabled={refreshingBalance || loading}
                            onClick={() => void handleRefreshBalance()}
                          >
                            {refreshingBalance ? '刷新中…' : '刷新余额'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          data-testid="reset-usage-btn"
                          disabled={resettingUsage || loading}
                          onClick={() => void handleResetUsage()}
                        >
                          {resettingUsage ? '清零中…' : '清零统计'}
                        </button>
                      </div>
                    </div>

                    <div className="translation-usage-card__grid">
                      <div className={`translation-usage-metric${lowWarn ? ' is-warn' : ''}`}>
                        <div className="translation-usage-metric__label">
                          {activeBillingKind === 'deepseek-balance'
                            ? lowWarn
                              ? 'DeepSeek 可用余额（低余额预警）'
                              : 'DeepSeek 账户可用余额'
                            : '余额接口状态'}
                        </div>
                        <div className="translation-usage-metric__value" data-testid="usage-balance-value">
                          {activeBillingKind === 'deepseek-balance'
                            ? effectiveBalance?.totalBalance !== null && effectiveBalance?.totalBalance !== undefined
                              ? `${currencySymbol(effectiveBalance.currency)} ${effectiveBalance.totalBalance.toFixed(2)}`
                              : effectiveBalance?.error
                                ? '查询受限'
                                : '待查询'
                            : activeBillingKind === 'ollama-local'
                              ? '本机离线免费'
                              : activeBillingKind === 'cli-local'
                                ? 'CLI 订阅配额'
                                : '服务商未开放'}
                        </div>
                        <div className="translation-usage-metric__sub">
                          {activeBillingKind === 'deepseek-balance'
                            ? effectiveBalance?.error
                              ? effectiveBalance.error
                              : effectiveBalance?.totalBalance !== null && effectiveBalance?.totalBalance !== undefined
                                ? `充值 ${currencySymbol(effectiveBalance.currency)}${(effectiveBalance.toppedUpBalance ?? 0).toFixed(2)} + 赠送 ${currencySymbol(effectiveBalance.currency)}${(effectiveBalance.grantedBalance ?? 0).toFixed(2)}`
                                : '点击右上「刷新余额」或完成一次翻译后自动刷新'
                            : activeBillingKind === 'cli-local'
                              ? 'Codex / Gemini CLI 额度由各自客户端后台托管'
                              : activeBillingKind === 'ollama-local'
                                ? '本地 Ollama 推理不消耗云端额度'
                                : 'OpenAI / 多数中转站出于安全不提供 Key 查余额 API'}
                        </div>
                      </div>

                      <div className="translation-usage-metric">
                        <div className="translation-usage-metric__label">今日实测累计用量</div>
                        <div className="translation-usage-metric__value" data-testid="usage-today-tokens">
                          {todayBucket && todayBucket.totalTokens > 0
                            ? `${formatExactTokens(todayBucket.totalTokens)} tok`
                            : todayBucket && todayBucket.translatedBlocks > 0
                              ? `${todayBucket.translatedBlocks} 块 · ${todayBucket.translatedPages} 页`
                              : '0 tok'}
                        </div>
                        <div className="translation-usage-metric__sub">
                          {todayBucket && todayBucket.totalTokens > 0
                            ? `输入 ${formatExactTokens(todayBucket.promptTokens)} / 输出 ${formatExactTokens(todayBucket.completionTokens)}（历史累计 ${formatExactTokens(totalBucket?.totalTokens ?? 0)} tok）`
                            : `累计完成 ${totalBucket?.translatedBlocks ?? 0} 块（${totalBucket?.translatedPages ?? 0} 页），均写 SQLite`}
                        </div>
                      </div>

                      <div className="translation-usage-metric">
                        <div className="translation-usage-metric__label">
                          {showCostEst ? '今日参考估算费用' : '本地缓存省流命中'}
                        </div>
                        <div className="translation-usage-metric__value">
                          {showCostEst
                            ? showCostEst.text
                            : cacheRate !== null
                              ? `${cacheRate}%`
                              : `${totalBucket?.cacheHitBlocks ?? 0} 块`}
                        </div>
                        <div className="translation-usage-metric__sub">
                          {showCostEst
                            ? `基于实测 tokens × 自填参考单价（${priceCurrency}）`
                            : `缓存命中 ${totalBucket?.cacheHitBlocks ?? 0} 块 · 重复打开 0 Token 消耗`}
                        </div>
                      </div>
                    </div>

                    {!isCliTab ? (
                      <div className="translation-usage-card__prefs">
                        <label>
                          <span>低余额预警线（{priceCurrency}）</span>
                          <input
                            type="number"
                            min={0}
                            step="0.5"
                            aria-label="低余额预警线"
                            value={lowBalanceThresholdText}
                            onChange={e => setLowBalanceThresholdText(e.target.value)}
                          />
                        </label>
                        <label>
                          <span>参考币种</span>
                          <select
                            aria-label="参考计价币种"
                            value={priceCurrency}
                            onChange={e => setPriceCurrency(e.target.value === 'USD' ? 'USD' : 'CNY')}
                          >
                            <option value="CNY">CNY (¥)</option>
                            <option value="USD">USD ($)</option>
                          </select>
                        </label>
                        <label>
                          <span>输入单价（每 1M tok，可选）</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            aria-label="输入单价"
                            placeholder="留空不估价"
                            value={inputPriceText}
                            onChange={e => setInputPriceText(e.target.value)}
                          />
                        </label>
                        <label>
                          <span>输出单价（每 1M tok，可选）</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            aria-label="输出单价"
                            placeholder="留空不估价"
                            value={outputPriceText}
                            onChange={e => setOutputPriceText(e.target.value)}
                          />
                        </label>
                      </div>
                    ) : null}

                    <div className="translation-usage-card__note">
                      {effectiveBalance?.note ?? defaultBillingNote(activeBillingKind, isPreviewingOtherProvider)}
                    </div>
                  </div>
                )
              })()}

              {error ? (
                <div role="alert" className="error-banner">
                  {error}
                </div>
              ) : null}
            </>
          )}
        </div>

        {notice || testResult ? (
          <div className="translation-modal__toast-layer" aria-live="polite">
            {notice ? (
              <div
                role="status"
                data-testid="translation-notice-toast"
                className="translation-modal__status translation-modal__status--ok translation-modal__toast"
              >
                <button
                  type="button"
                  className="translation-modal__toast-close"
                  aria-label="关闭提示"
                  onClick={() => setNotice(null)}
                >
                  ×
                </button>
                <div>{notice}</div>
                <span key={notice} className="translation-modal__toast-progress" aria-hidden="true" />
              </div>
            ) : null}

            {testResult ? (
              <div
                role="status"
                data-testid="translation-test-result"
                className={`translation-modal__status translation-modal__toast ${
                  testResult.ok ? 'translation-modal__status--ok' : 'translation-modal__status--err'
                }`}
              >
                <button
                  type="button"
                  className="translation-modal__toast-close"
                  aria-label="关闭测试提示"
                  onClick={() => setTestResult(null)}
                >
                  ×
                </button>
                {testResult.ok ? (
                  <>
                    <div className="translation-modal__status-head">
                      <strong>
                        连接成功 [{testResult.testedProvider === 'openai-compatible' ? 'OpenAI 兼容 API' : '本机 AI CLI'}]
                        （{testResult.latencyMs} ms）
                      </strong>
                      <span className="translation-modal__status-target">
                        {testResult.testedLabel} · {testResult.testedTarget}
                      </span>
                    </div>
                    <div>示例译文：{testResult.sampleOutput ?? '已返回有效响应'}</div>
                    {savedSettings && testResult.testedProvider !== savedSettings.provider ? (
                      <div className="translation-modal__status-warn">
                        注：本次仅测试当前草稿，尚未更改实际生效引擎；如需启用请点击右下角「{saveButtonText}」。
                      </div>
                    ) : null}
                    <span
                      key={`${testResult.testedProvider}-${testResult.testedTarget}-${testResult.latencyMs}`}
                      className="translation-modal__toast-progress"
                      aria-hidden="true"
                    />
                  </>
                ) : (
                  <>
                    <div className="translation-modal__status-head">
                      <strong>
                        连接失败 [
                        {testResult.testedProvider === 'openai-compatible' ? 'OpenAI 兼容 API' : '本机 AI CLI'} ·{' '}
                        {testResult.testedLabel}]
                      </strong>
                      <span className="translation-modal__status-target">{testResult.testedTarget}</span>
                    </div>
                    <div>{testResult.error}</div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="translation-modal__footer">
          <button
            type="button"
            data-testid="translation-test-btn"
            disabled={loading || saving || testing}
            onClick={() => void handleTest()}
          >
            {testButtonText}
          </button>
          {testing ? (
            <button
              type="button"
              data-testid="translation-test-cancel-btn"
              onClick={() => void window.paperflow.cancelAiChat()}
            >
              取消测试
            </button>
          ) : null}
          {documentId ? (
            <button type="button" disabled={loading || clearing} onClick={() => void handleClearCache()}>
              {clearing ? '清空中…' : '清空本文缓存'}
            </button>
          ) : null}
          <div className="translation-modal__footer-right">
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              data-testid="translation-save-btn"
              className="translation-modal__primary"
              disabled={loading || saving || testing}
              onClick={() => void handleSaveAndClose()}
            >
              {saveButtonText}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
