import { useEffect, useState } from 'react'
import type {
  CliPreset,
  GlossaryEntry,
  SaveTranslationSettingsInput,
  TranslationProviderType,
  TranslationSettings,
  TranslationTestResult
} from '../../../../shared/contracts'

function formatGlossaryLines(entries: readonly GlossaryEntry[]): string {
  return entries.map(entry => `${entry.source} => ${entry.target}`).join('\n')
}

function parseGlossaryLines(rawText: string): GlossaryEntry[] {
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

export interface TranslationSettingsModalProps {
  open: boolean
  documentId: string | null
  onClose(): void
  onSaved(settings: TranslationSettings): void
  onDocumentCacheCleared?(): void
}

export function TranslationSettingsModal({
  open,
  documentId,
  onClose,
  onSaved,
  onDocumentCacheCleared
}: TranslationSettingsModalProps): React.JSX.Element | null {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [clearing, setClearing] = useState(false)

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

  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<TranslationTestResult | null>(null)

  const applySettings = (settings: TranslationSettings): void => {
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
    void window.paperflow
      .getTranslationSettings()
      .then(settings => {
        if (!cancelled) applySettings(settings)
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
  }, [open])

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

  const persistCurrent = async (): Promise<TranslationSettings | null> => {
    setError(null)
    setNotice(null)
    setSaving(true)
    try {
      const saved = await window.paperflow.saveTranslationSettings(buildPayload())
      applySettings(saved)
      onSaved(saved)
      return saved
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAndClose = async (): Promise<void> => {
    const saved = await persistCurrent()
    if (saved) onClose()
  }

  const handleTest = async (): Promise<void> => {
    setTestResult(null)
    const saved = await persistCurrent()
    if (!saved) return
    setTesting(true)
    try {
      const res = await window.paperflow.testTranslationConnection()
      setTestResult(res)
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        latencyMs: 0,
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
          <h3 id="translation-settings-title">翻译引擎设置</h3>
          <button type="button" className="translation-modal__close" aria-label="关闭设置" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="translation-modal__body">
          {loading ? (
            <p className="translation-modal__hint">正在加载配置…</p>
          ) : (
            <>
              <div className="translation-modal__field">
                <span className="translation-modal__label">引擎类型</span>
                <div className="translation-modal__segmented">
                  <button
                    type="button"
                    className={provider === 'openai-compatible' ? 'is-active' : undefined}
                    onClick={() => setProvider('openai-compatible')}
                  >
                    OpenAI 兼容 API
                  </button>
                  <button
                    type="button"
                    className={provider === 'cli' ? 'is-active' : undefined}
                    onClick={() => setProvider('cli')}
                  >
                    本机 AI CLI（Codex 等）
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
                      }}
                    >
                      DeepSeek
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBaseUrl('https://api.openai.com/v1')
                        setModel('gpt-4o-mini')
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
                  <div className="translation-modal__presets">
                    <span>CLI 预设：</span>
                    <button
                      type="button"
                      onClick={() => {
                        setCliPreset('codex')
                        setCliCommand('codex')
                      }}
                    >
                      Codex CLI
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCliPreset('claude')
                        setCliCommand('claude')
                      }}
                    >
                      Claude CLI
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCliPreset('gemini')
                        setCliCommand('gemini')
                      }}
                    >
                      Gemini CLI
                    </button>
                    <button
                      type="button"
                      onClick={() => setCliPreset('custom')}
                    >
                      自定义 CLI
                    </button>
                  </div>

                  <label className="translation-modal__field">
                    <span className="translation-modal__label">命令名称或绝对路径</span>
                    <input
                      type="text"
                      aria-label="CLI 命令"
                      value={cliCommand}
                      onChange={e => setCliCommand(e.target.value)}
                      placeholder="codex"
                    />
                  </label>

                  <div className="translation-modal__row">
                    <label className="translation-modal__field">
                      <span className="translation-modal__label">模型覆盖（留空用 CLI 默认）</span>
                      <input
                        type="text"
                        aria-label="CLI 模型参数"
                        value={cliModel}
                        onChange={e => setCliModel(e.target.value)}
                        placeholder="留空默认"
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
                <textarea
                  rows={3}
                  aria-label="自定义术语表"
                  value={glossaryText}
                  onChange={e => setGlossaryText(e.target.value)}
                  placeholder={'F-IVM => F-IVM\nview tree => 视图树\nmarginalization => 边缘化'}
                />
              </label>

              {error ? (
                <div role="alert" className="error-banner">
                  {error}
                </div>
              ) : null}

              {notice ? (
                <div role="status" className="translation-modal__status translation-modal__status--ok">
                  {notice}
                </div>
              ) : null}

              {testResult ? (
                <div
                  role="status"
                  className={
                    testResult.ok
                      ? 'translation-modal__status translation-modal__status--ok'
                      : 'translation-modal__status translation-modal__status--err'
                  }
                >
                  {testResult.ok ? (
                    <>
                      <strong>连接成功</strong>（{testResult.latencyMs} ms）：
                      {testResult.sampleOutput ?? '已返回有效响应'}
                      {testResult.resolvedCommand ? <small> · {testResult.resolvedCommand}</small> : null}
                    </>
                  ) : (
                    <>
                      <strong>连接失败</strong>：{testResult.error}
                    </>
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="translation-modal__footer">
          <button type="button" disabled={loading || saving || testing} onClick={() => void handleTest()}>
            {testing ? '测试中…' : '测试连接'}
          </button>
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
              className="translation-modal__primary"
              disabled={loading || saving || testing}
              onClick={() => void handleSaveAndClose()}
            >
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
