import type { TokenUsageDelta } from '../../shared/contracts'

function extractTextFromChoiceContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('')
  }
  return ''
}

function toNonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/** 规范化 OpenAI 兼容接口返回的 usage 对象，若 prompt/completion/total 全为 0 则返回 undefined。 */
export function normalizeTokenUsage(raw: unknown): TokenUsageDelta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
    input_tokens?: unknown
    output_tokens?: unknown
  }
  const promptTokens = toNonNegInt(obj.prompt_tokens ?? obj.input_tokens)
  const completionTokens = toNonNegInt(obj.completion_tokens ?? obj.output_tokens)
  const rawTotal = toNonNegInt(obj.total_tokens)
  const totalTokens = rawTotal > 0 ? rawTotal : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return undefined
  }
  return { promptTokens, completionTokens, totalTokens }
}

/**
 * 统一读取 OpenAI 兼容 `/chat/completions` 响应并返回文本与实测 Token `usage`：
 * - 若服务端返回 `text/event-stream`，按 SSE 增量解码并逐段回调 `onDelta`；
 * - 若服务端返回普通 JSON（包括离线代理或测试桩），自动兼容解析完整回复与 usage。
 */
export async function readOpenAiStreamOrJsonWithUsage(
  response: Response,
  onDelta?: (delta: string, fullText: string) => void
): Promise<{ text: string; usage?: TokenUsageDelta }> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  const shouldStream = contentType.includes('text/event-stream') && Boolean(response.body)

  if (!shouldStream) {
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown }; delta?: { content?: unknown } }>
      usage?: unknown
    }
    const text = extractTextFromChoiceContent(
      payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.delta?.content
    ).trim()
    if (!text) {
      throw new Error('翻译接口未返回有效的文本内容。')
    }
    onDelta?.(text, text)
    return {
      text,
      usage: normalizeTokenUsage(payload.usage)
    }
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let fullText = ''
  let latestUsage: TokenUsageDelta | undefined

  const processLine = (rawLine: string): boolean => {
    const line = rawLine.trim()
    if (!line || !line.startsWith('data:')) return false
    const data = line.slice(5).trim()
    if (!data) return false
    if (data === '[DONE]') return true
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>
        usage?: unknown
      }
      const chunkUsage = normalizeTokenUsage(parsed.usage)
      if (chunkUsage) {
        latestUsage = chunkUsage
      }
      const deltaText = extractTextFromChoiceContent(
        parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content
      )
      if (deltaText) {
        fullText += deltaText
        onDelta?.(deltaText, fullText)
      }
    } catch {
      // 忽略单个心跳或半截注释包，后续数据包继续拼接
    }
    return false
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      if (processLine(line)) {
        await reader.cancel().catch(() => {})
        buffer = ''
        break
      }
      newlineIndex = buffer.indexOf('\n')
    }
  }

  const rest = (buffer + decoder.decode()).trim()
  if (rest) {
    for (const tailLine of rest.split(/\r?\n/)) {
      if (processLine(tailLine)) break
    }
  }

  const finalTrimmed = fullText.trim()
  if (!finalTrimmed) {
    throw new Error('翻译接口流式响应未返回有效文本内容。')
  }
  return {
    text: finalTrimmed,
    usage: latestUsage
  }
}

/** 保持旧签名的兼容导出：仅返回文本响应。 */
export async function readOpenAiStreamOrJson(
  response: Response,
  onDelta?: (delta: string, fullText: string) => void
): Promise<string> {
  const { text } = await readOpenAiStreamOrJsonWithUsage(response, onDelta)
  return text
}
