import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import type {
  CliPreset,
  ExplainSelectionInput,
  ExplainSelectionResult,
  GlossaryEntry,
  SaveTranslationSettingsInput,
  TranslatePageInput,
  TranslatePageResult,
  TranslatedBlockRecord,
  TranslationBlockInput,
  TranslationProgressEvent,
  TranslationSettings,
  TranslationTestResult
} from '../../shared/contracts'
import {
  documentIdSchema,
  explainSelectionInputSchema,
  glossaryEntrySchema,
  pageNumberSchema,
  saveTranslationSettingsSchema,
  translatePageInputSchema
} from '../../shared/schemas'
import type { LibraryDatabase } from './database'

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface TranslationServiceOptions {
  database: LibraryDatabase
  safeStorage?: SafeStorageAdapter
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
}

interface StoredTranslationConfig {
  provider: TranslationSettings['provider']
  targetLanguage: string
  glossary: GlossaryEntry[]
  openai: {
    baseUrl: string
    model: string
  }
  cli: {
    preset: CliPreset
    command: string
    model: string
    extraArgs: string[]
    timeoutSec: number
  }
}

const SETTINGS_KEY = 'translation.config.v1'
const API_KEY_SETTING = 'translation.openaiApiKey.v1'
const BATCH_MAX_CHARS = 2400
const BATCH_MAX_ITEMS = 8

const DEFAULT_CONFIG: StoredTranslationConfig = {
  provider: 'openai-compatible',
  targetLanguage: 'zh-CN',
  glossary: [],
  openai: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  cli: {
    preset: 'codex',
    command: 'codex',
    model: '',
    extraArgs: [],
    timeoutSec: 120
  }
}

function maskApiKey(rawKey: string | null): string | null {
  if (!rawKey) return null
  if (rawKey.length <= 8) return '已安全保存'
  return `${rawKey.slice(0, 4)}***${rawKey.slice(-4)}`
}

function languageLabel(code: string): string {
  const lower = code.trim().toLowerCase()
  if (lower === 'zh-cn' || lower === 'zh' || lower === 'zh-hans') return '简体中文'
  if (lower === 'zh-tw' || lower === 'zh-hant') return '繁體中文'
  if (lower === 'en' || lower.startsWith('en-')) return 'English'
  if (lower === 'ja') return '日本語'
  return code
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function providerSignatureFor(config: StoredTranslationConfig): string {
  if (config.provider === 'openai-compatible') {
    return `openai:${normalizeBaseUrl(config.openai.baseUrl)}|${config.openai.model}|${config.targetLanguage}`
  }
  return `cli:${config.cli.preset}|${config.cli.command}|${config.cli.model}|${config.targetLanguage}`
}

function isExecutableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * 纯文件系统扫描 PATH / 标准 Node 工具路径解析可执行命令，避免额外唤起 which/where shell 进程。
 * 在 Windows 上优先匹配 `.exe`/`.com`，其次匹配 npm 生成的 `.cmd`/`.bat` 包装脚本。
 */
export function resolveCliExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  const isWindows = process.platform === 'win32'
  const winExts = ['.exe', '.com', '.cmd', '.bat']

  const probeCandidate = (basePath: string): string | null => {
    if (!isWindows) return isExecutableFile(basePath) ? basePath : null
    const ext = extname(basePath).toLowerCase()
    if (ext) return isExecutableFile(basePath) ? basePath : null
    for (const candidateExt of winExts) {
      const withExt = `${basePath}${candidateExt}`
      if (isExecutableFile(withExt)) return withExt
    }
    return isExecutableFile(basePath) ? basePath : null
  }

  if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return probeCandidate(resolve(trimmed))
  }

  const pathEntries = (env.PATH || env.Path || '')
    .split(isWindows ? ';' : ':')
    .map(p => p.trim())
    .filter(Boolean)

  if (isWindows) {
    if (env.APPDATA) pathEntries.push(join(env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA) pathEntries.push(join(env.LOCALAPPDATA, 'Programs'))
    if (env.USERPROFILE) pathEntries.push(join(env.USERPROFILE, '.local', 'bin'))
  } else if (env.HOME) {
    pathEntries.push(join(env.HOME, '.local', 'bin'))
  }

  for (const dir of pathEntries) {
    const hit = probeCandidate(join(dir, trimmed))
    if (hit) return hit
  }
  return null
}

function quoteCmdToken(token: string): string {
  if (/[\r\n&|<>^%"]/.test(token)) {
    throw new Error('命令行参数包含不支持的控制或特殊字符。')
  }
  return `"${token}"`
}

function extractJsonObjectOrArray(rawText: string): unknown {
  let cleaned = rawText.trim()
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) cleaned = fenceMatch[1].trim()

  const firstObj = cleaned.indexOf('{')
  const lastObj = cleaned.lastIndexOf('}')
  if (firstObj !== -1 && lastObj > firstObj) {
    try {
      return JSON.parse(cleaned.slice(firstObj, lastObj + 1)) as unknown
    } catch {
      // 继续尝试顶层解析或数组提取
    }
  }

  const firstArr = cleaned.indexOf('[')
  const lastArr = cleaned.lastIndexOf(']')
  if (firstArr !== -1 && lastArr > firstArr) {
    try {
      return JSON.parse(cleaned.slice(firstArr, lastArr + 1)) as unknown
    } catch {
      // ignore
    }
  }

  return JSON.parse(cleaned) as unknown
}

/**
 * 规整单个译文块内部的多余换行，防止覆盖层出现额外空行，同时完整保留所有字符与符号原貌。
 */
export function normalizeTranslatedBlockText(text: string): string {
  const lf = text.replace(/\r\n?/g, '\n')
  const joinedCjk = lf.replace(
    /([\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af，。！？；：、（）《》「」『』【】])\s*\n+\s*([\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af（《「『【])/g,
    '$1$2'
  )
  return joinedCjk
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function parseBatchTranslationOutput(
  rawText: string,
  expectedBlocks: readonly TranslationBlockInput[]
): Map<string, string> {
  const result = new Map<string, string>()
  try {
    const parsed = extractJsonObjectOrArray(rawText)
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { translations?: unknown }).translations)
        ? (parsed as { translations: unknown[] }).translations
        : null

    if (items) {
      for (const entry of items) {
        if (!entry || typeof entry !== 'object') continue
        const obj = entry as { id?: unknown; blockId?: unknown; text?: unknown; translatedText?: unknown }
        const id = typeof obj.id === 'string' ? obj.id : typeof obj.blockId === 'string' ? obj.blockId : ''
        const rawValue =
          typeof obj.text === 'string'
            ? obj.text
            : typeof obj.translatedText === 'string'
              ? obj.translatedText
              : ''
        const text = normalizeTranslatedBlockText(rawValue)
        if (id && text) {
          result.set(id, text)
        }
      }
    } else if (expectedBlocks.length === 1 && parsed && typeof parsed === 'object') {
      const obj = parsed as { text?: unknown; translatedText?: unknown }
      const rawValue =
        typeof obj.text === 'string'
          ? obj.text
          : typeof obj.translatedText === 'string'
            ? obj.translatedText
            : ''
      const singleText = normalizeTranslatedBlockText(rawValue)
      if (singleText) {
        result.set(expectedBlocks[0].blockId, singleText)
      }
    }
  } catch {
    if (expectedBlocks.length === 1) {
      const stripped = normalizeTranslatedBlockText(
        rawText
          .trim()
          .replace(/^```(?:text|markdown|json)?\s*/i, '')
          .replace(/```$/i, '')
      )
      if (stripped && !stripped.startsWith('{')) {
        result.set(expectedBlocks[0].blockId, stripped)
      }
    }
  }
  return result
}

export function hasAllExpectedFormulaPlaceholders(sourceText: string, translatedText: string): boolean {
  const tokens = sourceText.match(/⟪M\d+⟫/g)
  if (!tokens || tokens.length === 0) return true
  const seen = new Set(tokens)
  for (const token of seen) {
    if (!translatedText.includes(token)) return false
  }
  return true
}

export function buildAcademicPrompt(
  targetLanguage: string,
  blocks: readonly TranslationBlockInput[],
  glossary: readonly GlossaryEntry[] = []
): string {
  const targetName = languageLabel(targetLanguage)
  const payload = blocks.map(b => ({ id: b.blockId, kind: b.kind, text: b.sourceText }))
  const glossaryLines =
    glossary.length > 0
      ? [
          '术语表（译文中遇到下列术语须严格按此统一译法）：',
          ...glossary.slice(0, 200).map(item => `- ${item.source} => ${item.target}`)
        ]
      : []
  return [
    `你是一位学术论文翻译助手。请将输入 JSON 数组中的英文论文文本准确翻译为${targetName}。`,
    '翻译要求：',
    '1. 忠实严谨、绝不遗漏输入中的任何词句、编号、注脚或限定语，也不擅自扩写或删改。',
    '2. 完整保留公式与符号原貌：若原文包含 ⟪M1⟫、⟪M2⟫ 等行内公式占位符，必须在译文对应语序位置原样保留每一个占位符，严禁删除、合并或改写编号；其余行内变量、运算符、参考文献编号（如 [1]、(Smith et al., 2025)）及图表/章节编号（如 Fig. 1、Table 2、Sect. 4）须保持原文写法，切勿汉化符号或改写为 $...$ / LaTeX 代码。',
    '3. 尽量保持与原文块一致的自然句数量与句末标点边界，不随意合句或拆句，便于逐句对照高亮。',
    '4. 紧凑单段纯文本排版：每个译文块仅输出单段连续纯文本，禁止在块内插入多余换行符、空行或 Markdown 标记（如 **粗体**、`代码`、# 标题）。',
    '5. 仅返回严格合法的 JSON 对象，格式为 {"translations":[{"id":"原id","text":"译文"}]}，确保输入中的每个 id 都有对应译文，禁止附加解释或无关文字。',
    ...glossaryLines,
    '',
    JSON.stringify(payload)
  ].join('\n')
}

export function buildExplainPrompt(
  input: Pick<ExplainSelectionInput, 'selectedText' | 'contextText' | 'mode' | 'pageNumber'>,
  targetLanguage: string,
  glossary: readonly GlossaryEntry[] = []
): string {
  const targetName = languageLabel(targetLanguage)
  const glossaryBlock =
    glossary.length > 0
      ? `\n参考术语表：\n${glossary
          .slice(0, 80)
          .map(item => `- ${item.source} => ${item.target}`)
          .join('\n')}`
      : ''
  const contextBlock = input.contextText?.trim() ? `\n所在段落上下文（第 ${input.pageNumber} 页）：\n${input.contextText.trim()}` : ''

  if (input.mode === 'formula') {
    return [
      `你是一位科研论文精读助手。请使用${targetName}清晰解析下面选中的论文公式或符号表达式：`,
      '1. 先一句话说明该式在整个论证/推导中的核心物理或数学含义；',
      '2. 逐项解释关键变量、上下标与运算符（保持原符号写法，勿擅自改名）；',
      '3. 若上下文足以判断输入输出或复杂度结论，请简要补充说明。直接输出精炼说明文字。',
      glossaryBlock,
      `\n目标公式/表达式：\n${input.selectedText.trim()}`,
      contextBlock
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (input.mode === 'translate') {
    return [
      `你是一位学术论文翻译助手。请将下方选中片段准确译为${targetName}，保留全部专有术语、公式变量与引用编号。直接输出译文。`,
      glossaryBlock,
      `\n选中片段：\n${input.selectedText.trim()}`,
      contextBlock
    ]
      .filter(Boolean)
      .join('\n')
  }

  return [
    `你是一位科研论文精读助手。请使用${targetName}对下方选中的论文片段做精要解读：`,
    '1. 先给出准确通顺的核心意思；',
    '2. 点明涉及的技术方法、因果逻辑或关键术语含义；',
    '3. 控制在 3–5 句或简洁要点内，方便读者记入笔记。',
    glossaryBlock,
    `\n选中文本：\n${input.selectedText.trim()}`,
    contextBlock
  ]
    .filter(Boolean)
    .join('\n')
}

function chunkTranslationBlocks(blocks: readonly TranslationBlockInput[]): TranslationBlockInput[][] {
  const batches: TranslationBlockInput[][] = []
  let current: TranslationBlockInput[] = []
  let currentChars = 0

  for (const block of blocks) {
    const len = block.sourceText.length
    if (current.length > 0 && (current.length >= BATCH_MAX_ITEMS || currentChars + len > BATCH_MAX_CHARS)) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(block)
    currentChars += len
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /已取消|aborted/i.test(error.message))
}

export class TranslationService {
  private readonly database: LibraryDatabase
  private readonly safeStorage?: SafeStorageAdapter
  private readonly fetchImpl: typeof fetch
  private readonly env: NodeJS.ProcessEnv
  private readonly activeTasks = new Map<string, { documentId?: string; abort: () => void }>()

  constructor(options: TranslationServiceOptions) {
    this.database = options.database
    this.safeStorage = options.safeStorage
    this.fetchImpl = options.fetchImpl ?? fetch
    this.env = options.env ?? process.env
  }

  private readStoredConfig(): StoredTranslationConfig {
    const raw = this.database.getSetting(SETTINGS_KEY)
    if (!raw) return structuredClone(DEFAULT_CONFIG)
    try {
      const parsed = JSON.parse(raw) as Partial<StoredTranslationConfig>
      const glossary: GlossaryEntry[] = []
      if (Array.isArray(parsed.glossary)) {
        for (const item of parsed.glossary) {
          const check = glossaryEntrySchema.safeParse(item)
          if (check.success) glossary.push(check.data)
          if (glossary.length >= 200) break
        }
      }
      return {
        provider: parsed.provider === 'cli' ? 'cli' : 'openai-compatible',
        targetLanguage: typeof parsed.targetLanguage === 'string' && parsed.targetLanguage.trim()
          ? parsed.targetLanguage
          : DEFAULT_CONFIG.targetLanguage,
        glossary,
        openai: {
          baseUrl: typeof parsed.openai?.baseUrl === 'string' && parsed.openai.baseUrl.trim()
            ? parsed.openai.baseUrl
            : DEFAULT_CONFIG.openai.baseUrl,
          model: typeof parsed.openai?.model === 'string' && parsed.openai.model.trim()
            ? parsed.openai.model
            : DEFAULT_CONFIG.openai.model
        },
        cli: {
          preset: parsed.cli?.preset && ['codex', 'claude', 'gemini', 'custom'].includes(parsed.cli.preset)
            ? parsed.cli.preset
            : DEFAULT_CONFIG.cli.preset,
          command: typeof parsed.cli?.command === 'string' && parsed.cli.command.trim()
            ? parsed.cli.command
            : DEFAULT_CONFIG.cli.command,
          model: typeof parsed.cli?.model === 'string' ? parsed.cli.model : DEFAULT_CONFIG.cli.model,
          extraArgs: Array.isArray(parsed.cli?.extraArgs)
            ? parsed.cli.extraArgs.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            : [],
          timeoutSec: typeof parsed.cli?.timeoutSec === 'number' && parsed.cli.timeoutSec >= 10 && parsed.cli.timeoutSec <= 300
            ? Math.trunc(parsed.cli.timeoutSec)
            : DEFAULT_CONFIG.cli.timeoutSec
        }
      }
    } catch {
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  private readApiKey(): string | null {
    const encoded = this.database.getSetting(API_KEY_SETTING)
    if (!encoded) return null
    try {
      if (encoded.startsWith('enc:v1:')) {
        if (!this.safeStorage?.isEncryptionAvailable()) return null
        return this.safeStorage.decryptString(Buffer.from(encoded.slice('enc:v1:'.length), 'base64'))
      }
      if (encoded.startsWith('plain:v1:')) {
        return Buffer.from(encoded.slice('plain:v1:'.length), 'base64').toString('utf8')
      }
      return null
    } catch {
      return null
    }
  }

  private writeApiKey(plainKey: string): void {
    const trimmed = plainKey.trim()
    if (!trimmed) {
      this.database.deleteSetting(API_KEY_SETTING)
      return
    }
    if (this.safeStorage?.isEncryptionAvailable()) {
      const cipher = this.safeStorage.encryptString(trimmed).toString('base64')
      this.database.setSetting(API_KEY_SETTING, `enc:v1:${cipher}`)
    } else {
      const plain = Buffer.from(trimmed, 'utf8').toString('base64')
      this.database.setSetting(API_KEY_SETTING, `plain:v1:${plain}`)
    }
  }

  getSettings(): TranslationSettings {
    const config = this.readStoredConfig()
    const apiKey = this.readApiKey()
    return {
      provider: config.provider,
      targetLanguage: config.targetLanguage,
      glossary: config.glossary,
      openai: {
        baseUrl: config.openai.baseUrl,
        model: config.openai.model,
        hasApiKey: Boolean(apiKey),
        apiKeyPreview: maskApiKey(apiKey)
      },
      cli: {
        preset: config.cli.preset,
        command: config.cli.command,
        model: config.cli.model,
        extraArgs: config.cli.extraArgs,
        timeoutSec: config.cli.timeoutSec
      }
    }
  }

  saveSettings(input: SaveTranslationSettingsInput): TranslationSettings {
    const validated = saveTranslationSettingsSchema.parse(input)
    const previous = this.readStoredConfig()
    const config: StoredTranslationConfig = {
      provider: validated.provider,
      targetLanguage: validated.targetLanguage,
      glossary: validated.glossary ?? previous.glossary,
      openai: {
        baseUrl: normalizeBaseUrl(validated.openai.baseUrl),
        model: validated.openai.model
      },
      cli: {
        preset: validated.cli.preset,
        command: validated.cli.command,
        model: validated.cli.model,
        extraArgs: validated.cli.extraArgs,
        timeoutSec: validated.cli.timeoutSec
      }
    }
    this.database.setSetting(SETTINGS_KEY, JSON.stringify(config))
    if (validated.openai.apiKey !== undefined) {
      this.writeApiKey(validated.openai.apiKey)
    }
    return this.getSettings()
  }

  getPageTranslations(documentId: string, pageNumber: number): TranslatedBlockRecord[] {
    const id = documentIdSchema.parse(documentId)
    const page = pageNumberSchema.parse(pageNumber)
    const config = this.readStoredConfig()
    return this.database.getPageTranslations(id, page, config.targetLanguage)
  }

  clearDocumentTranslations(documentId: string): void {
    const id = documentIdSchema.parse(documentId)
    this.cancel(id)
    this.database.clearDocumentTranslations(id)
  }

  cancel(documentId?: string): void {
    for (const [taskId, task] of this.activeTasks.entries()) {
      if (!documentId || task.documentId === documentId) {
        this.activeTasks.delete(taskId)
        task.abort()
      }
    }
  }

  cancelAll(): void {
    this.cancel(undefined)
  }

  private async invokeOpenAiCompatible(
    config: StoredTranslationConfig,
    apiKey: string | null,
    prompt: string,
    signal: AbortSignal,
    timeoutMs: number,
    systemPrompt = 'You are a precise academic translator. Reply with strict JSON only.'
  ): Promise<string> {
    const endpoint = `${normalizeBaseUrl(config.openai.baseUrl)}/chat/completions`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }

    const controller = new AbortController()
    const onParentAbort = (): void => controller.abort()
    signal.addEventListener('abort', onParentAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('TIMEOUT')), timeoutMs)

    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: config.openai.model,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            { role: 'user', content: prompt }
          ]
        })
      })

      if (!response.ok) {
        let hint = ''
        try {
          const errText = await response.text()
          if (errText) hint = `：${errText.slice(0, 180)}`
        } catch {
          // ignore read error
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error(`翻译接口鉴权失败（HTTP ${response.status}），请检查 API Key${hint}`)
        }
        if (response.status === 404) {
          throw new Error(`未找到翻译接口端点（HTTP 404），请确认 Base URL 是否包含 /v1${hint}`)
        }
        if (response.status === 429) {
          throw new Error(`翻译接口请求过于频繁或额度不足（HTTP 429）${hint}`)
        }
        throw new Error(`翻译接口返回异常（HTTP ${response.status}）${hint}`)
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>
      }
      const content = payload.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.trim()) return content
      if (Array.isArray(content)) {
        const joined = content
          .map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : ''))
          .join('')
          .trim()
        if (joined) return joined
      }
      throw new Error('翻译接口未返回有效的文本内容。')
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new Error('翻译任务已取消。')
      }
      if (controller.signal.aborted) {
        throw new Error(`翻译请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）。`)
      }
      if (error instanceof Error) throw error
      throw new Error(String(error))
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onParentAbort)
    }
  }

  private async invokeCli(
    config: StoredTranslationConfig,
    prompt: string,
    signal: AbortSignal
  ): Promise<{ output: string; resolvedCommand: string }> {
    const resolved = resolveCliExecutable(config.cli.command, this.env)
    if (!resolved) {
      throw new Error(`未在系统路径中找到 CLI 命令「${config.cli.command}」，请检查是否已安装或填写绝对路径。`)
    }

    const workDir = mkdtempSync(join(tmpdir(), 'paperflow-cli-'))
    const codexOutFile = join(workDir, 'codex-last.txt')
    const timeoutMs = config.cli.timeoutSec * 1000
    const { preset, model, extraArgs } = config.cli

    const args: string[] = []
    if (preset === 'codex') {
      args.push('exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '-o', codexOutFile)
      if (model) args.push('-m', model)
      args.push(...extraArgs, '-')
    } else if (preset === 'claude') {
      args.push('-p', '--output-format', 'text')
      if (model) args.push('--model', model)
      args.push(...extraArgs)
    } else if (preset === 'gemini') {
      if (model) args.push('-m', model)
      args.push(...extraArgs)
    } else {
      args.push(...extraArgs)
    }

    const isWindows = process.platform === 'win32'
    const ext = extname(resolved).toLowerCase()
    const isWinBatch = isWindows && (ext === '.cmd' || ext === '.bat')

    const terminateChild = (child: ChildProcess): void => {
      if (child.killed || child.exitCode !== null) return
      if (isWindows && typeof child.pid === 'number' && Number.isInteger(child.pid) && child.pid > 0 && isWinBatch) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          return
        } catch {
          // 回退常规 kill
        }
      }
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }

    try {
      const result = await new Promise<string>((resolvePromise, rejectPromise) => {
        if (signal.aborted) {
          rejectPromise(new Error('翻译任务已取消。'))
          return
        }

        let child: ChildProcess
        try {
          if (isWinBatch) {
            const cmdLine = `"${[quoteCmdToken(resolved), ...args.map(quoteCmdToken)].join(' ')}"`
            child = spawn(this.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdLine], {
              cwd: workDir,
              env: this.env,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
              windowsVerbatimArguments: true
            })
          } else {
            child = spawn(resolved, args, {
              cwd: workDir,
              env: this.env,
              shell: false,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true
            })
          }
        } catch (spawnError: unknown) {
          rejectPromise(new Error(`启动 CLI 失败：${spawnError instanceof Error ? spawnError.message : String(spawnError)}`))
          return
        }

        let stdout = ''
        let stderr = ''
        let settled = false
        let timedOut = false

        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          fn()
        }

        const onAbort = (): void => {
          terminateChild(child)
          finish(() => rejectPromise(new Error('翻译任务已取消。')))
        }

        signal.addEventListener('abort', onAbort, { once: true })
        const timer = setTimeout(() => {
          timedOut = true
          terminateChild(child)
          finish(() => rejectPromise(new Error(`CLI 翻译超时（超过 ${config.cli.timeoutSec} 秒）。`)))
        }, timeoutMs)

        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => { stdout += chunk })
        child.stderr?.on('data', (chunk: string) => { stderr += chunk })

        child.once('error', error => {
          finish(() => rejectPromise(new Error(`CLI 执行出错：${error.message}`)))
        })

        child.once('close', code => {
          finish(() => {
            if (signal.aborted) {
              rejectPromise(new Error('翻译任务已取消。'))
              return
            }
            if (timedOut) {
              rejectPromise(new Error(`CLI 翻译超时（超过 ${config.cli.timeoutSec} 秒）。`))
              return
            }
            if (code !== 0) {
              const detail = (stderr || stdout).trim().slice(0, 240)
              rejectPromise(new Error(`CLI 退出码 ${code ?? 'null'}${detail ? `：${detail}` : ''}`))
              return
            }
            let finalOutput = stdout.trim()
            if (preset === 'codex' && existsSync(codexOutFile)) {
              const msg = readFileSync(codexOutFile, 'utf8').trim()
              if (msg) finalOutput = msg
            }
            if (!finalOutput) {
              rejectPromise(new Error('CLI 已完成但未返回任何译文内容。'))
              return
            }
            resolvePromise(finalOutput)
          })
        })

        try {
          child.stdin?.write(prompt, 'utf8')
          child.stdin?.end()
        } catch {
          // 进程提前退出时由 error/close 处理
        }
      })

      return { output: result, resolvedCommand: resolved }
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // 清理临时目录失败不掩盖主流程结果
      }
    }
  }

  private async runModelPrompt(
    config: StoredTranslationConfig,
    apiKey: string | null,
    prompt: string,
    signal: AbortSignal,
    timeoutMs = 90000,
    systemPrompt?: string
  ): Promise<{ output: string; resolvedCommand?: string }> {
    if (config.provider === 'openai-compatible') {
      const output = await this.invokeOpenAiCompatible(config, apiKey, prompt, signal, timeoutMs, systemPrompt)
      return { output }
    }
    return this.invokeCli(config, prompt, signal)
  }

  async explainSelection(input: ExplainSelectionInput): Promise<ExplainSelectionResult> {
    const validated = explainSelectionInputSchema.parse(input)
    const config = this.readStoredConfig()
    const apiKey = this.readApiKey()
    const taskId = randomUUID()
    const controller = new AbortController()
    this.activeTasks.set(taskId, {
      documentId: validated.documentId,
      abort: () => controller.abort()
    })
    const started = Date.now()
    const prompt = buildExplainPrompt(validated, config.targetLanguage, config.glossary)

    try {
      const { output } = await this.runModelPrompt(
        config,
        apiKey,
        prompt,
        controller.signal,
        config.provider === 'openai-compatible' ? 60000 : config.cli.timeoutSec * 1000,
        'You are a rigorous academic paper reading assistant. Reply concisely in clear prose.'
      )
      return {
        mode: validated.mode,
        answer: output.trim(),
        latencyMs: Math.max(1, Date.now() - started)
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new Error('解释请求已取消。')
      }
      throw error
    } finally {
      this.activeTasks.delete(taskId)
    }
  }

  async testConnection(): Promise<TranslationTestResult> {
    const config = this.readStoredConfig()
    const apiKey = this.readApiKey()
    const taskId = randomUUID()
    const controller = new AbortController()
    this.activeTasks.set(taskId, { abort: () => controller.abort() })
    const started = Date.now()

    const sampleBlock: TranslationBlockInput = {
      blockId: 'test-b001',
      kind: 'paragraph',
      sourceText: 'Local offline reader.',
      sourceHash: '0123456789abcdef'
    }

    try {
      const { output, resolvedCommand } = await this.runModelPrompt(
        config,
        apiKey,
        buildAcademicPrompt(config.targetLanguage, [sampleBlock]),
        controller.signal,
        config.provider === 'openai-compatible' ? 25000 : config.cli.timeoutSec * 1000
      )
      const parsed = parseBatchTranslationOutput(output, [sampleBlock])
      const sampleOutput = parsed.get(sampleBlock.blockId) ?? output.slice(0, 120)
      return {
        ok: true,
        latencyMs: Math.max(1, Date.now() - started),
        sampleOutput,
        resolvedCommand
      }
    } catch (error: unknown) {
      return {
        ok: false,
        latencyMs: Math.max(1, Date.now() - started),
        error: error instanceof Error ? error.message : String(error),
        resolvedCommand:
          config.provider === 'cli' ? resolveCliExecutable(config.cli.command, this.env) ?? undefined : undefined
      }
    } finally {
      this.activeTasks.delete(taskId)
    }
  }

  async translatePage(
    input: TranslatePageInput,
    onProgress?: (event: TranslationProgressEvent) => void
  ): Promise<TranslatePageResult> {
    const validated = translatePageInputSchema.parse(input)
    const config = this.readStoredConfig()
    const apiKey = this.readApiKey()
    const signature = providerSignatureFor(config)

    const existingRows = this.database.getPageTranslations(
      validated.documentId,
      validated.pageNumber,
      config.targetLanguage
    )
    const existingById = new Map(existingRows.map(row => [row.blockId, row]))

    const pendingBlocks: TranslationBlockInput[] = []
    let fromCacheCount = 0

    for (const block of validated.blocks) {
      const cached = existingById.get(block.blockId)
      if (!validated.force && cached && cached.sourceHash === block.sourceHash && cached.translatedText.trim()) {
        fromCacheCount += 1
      } else {
        pendingBlocks.push(block)
      }
    }

    if (pendingBlocks.length === 0) {
      const items = validated.blocks
        .map(block => existingById.get(block.blockId))
        .filter((row): row is TranslatedBlockRecord => Boolean(row))
      return {
        documentId: validated.documentId,
        pageNumber: validated.pageNumber,
        items,
        fromCacheCount,
        translatedCount: 0
      }
    }

    const taskId = randomUUID()
    const controller = new AbortController()
    this.activeTasks.set(taskId, {
      documentId: validated.documentId,
      abort: () => controller.abort()
    })

    let translatedCount = 0
    try {
      const batches = chunkTranslationBlocks(pendingBlocks)
      for (const batch of batches) {
        if (controller.signal.aborted) throw new Error('翻译任务已取消。')

        const prompt = buildAcademicPrompt(config.targetLanguage, batch, config.glossary)
        const { output } = await this.runModelPrompt(config, apiKey, prompt, controller.signal)
        const mapped = parseBatchTranslationOutput(output, batch)

        const missing: TranslationBlockInput[] = []
        const partialFallback = new Map<string, string>()
        const completedBatch: Array<{ blockId: string; sourceHash: string; translatedText: string }> = []
        for (const block of batch) {
          const text = mapped.get(block.blockId)
          if (text && hasAllExpectedFormulaPlaceholders(block.sourceText, text)) {
            completedBatch.push({ blockId: block.blockId, sourceHash: block.sourceHash, translatedText: text })
          } else {
            if (text) partialFallback.set(block.blockId, text)
            missing.push(block)
          }
        }

        // 若多块批输出不完整、格式偏差或丢失公式占位符，仅对相关块按单块稳健重试与回退
        for (const single of missing) {
          if (controller.signal.aborted) throw new Error('翻译任务已取消。')
          const singlePrompt = buildAcademicPrompt(config.targetLanguage, [single], config.glossary)
          const { output: singleOutput } = await this.runModelPrompt(
            config,
            apiKey,
            singlePrompt,
            controller.signal
          )
          const singleMapped = parseBatchTranslationOutput(singleOutput, [single])
          const retriedText = singleMapped.get(single.blockId)
          const firstFallback = partialFallback.get(single.blockId)
          const translatedText =
            retriedText && hasAllExpectedFormulaPlaceholders(single.sourceText, retriedText)
              ? retriedText
              : retriedText || firstFallback
          if (!translatedText) {
            throw new Error(`块 ${single.blockId} 译文解析失败，请重试或切换模型。`)
          }
          completedBatch.push({
            blockId: single.blockId,
            sourceHash: single.sourceHash,
            translatedText
          })
        }

        if (completedBatch.length > 0) {
          this.database.upsertPageTranslations(
            validated.documentId,
            validated.pageNumber,
            config.targetLanguage,
            signature,
            completedBatch
          )
          translatedCount += completedBatch.length
          if (onProgress) {
            const updatedAt = new Date().toISOString()
            onProgress({
              documentId: validated.documentId,
              pageNumber: validated.pageNumber,
              items: completedBatch.map(entry => ({
                blockId: entry.blockId,
                sourceHash: entry.sourceHash,
                translatedText: entry.translatedText,
                providerSignature: signature,
                updatedAt
              })),
              completedCount: translatedCount,
              totalCount: pendingBlocks.length
            })
          }
        }
      }

      const refreshed = this.database.getPageTranslations(
        validated.documentId,
        validated.pageNumber,
        config.targetLanguage
      )
      const refreshedById = new Map(refreshed.map(row => [row.blockId, row]))
      const orderedItems = validated.blocks
        .map(block => refreshedById.get(block.blockId))
        .filter((row): row is TranslatedBlockRecord => Boolean(row))

      return {
        documentId: validated.documentId,
        pageNumber: validated.pageNumber,
        items: orderedItems,
        fromCacheCount,
        translatedCount
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new Error('翻译任务已取消。')
      }
      throw error
    } finally {
      this.activeTasks.delete(taskId)
    }
  }
}
