import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import type {
  AcademicSlideDeck,
  CliPreset,
  DetectedLocalAiClient,
  DocumentPageTranslations,
  DocumentTranslationScope,
  ExplainSelectionInput,
  ExplainSelectionResult,
  GlossaryEntry,
  ProviderBalanceSnapshot,
  RunAiSkillInput,
  RunAiSkillResult,
  SaveTranslationSettingsInput,
  SendAiChatInput,
  SendAiChatResult,
  TokenUsageDelta,
  TranslatePageInput,
  TranslatePageResult,
  TranslatedBlockRecord,
  TranslationBlockInput,
  TranslationProgressEvent,
  TranslationProviderType,
  TranslationSettings,
  TranslationTestResult,
  UpdateBlockTranslationInput,
  UsagePreferences,
  UsageStatsSummary
} from '../../shared/contracts'
import {
  documentIdSchema,
  explainSelectionInputSchema,
  glossaryEntrySchema,
  pageNumberSchema,
  runAiSkillInputSchema,
  saveTranslationSettingsSchema,
  sendAiChatInputSchema,
  translatePageInputSchema,
  updateBlockTranslationInputSchema
} from '../../shared/schemas'
import { buildAcademicSkillPrompt } from './academic-skills'
import { DOC_SUMMARY_SETTING_PREFIX, type LibraryDatabase } from './database'
import { formatSlideDeckMarkdown, parseSlideDeckJson } from './pptx-builder'
import { readOpenAiStreamOrJsonWithUsage } from './openai-stream'
import { resolveEffectiveTranslationScope } from './research-profile'
import { detectProviderBillingKind, mergeTokenUsage, UsageService } from './usage-service'
import { matchesFormulaPlaceholders } from '../../shared/formula-placeholders'
import { normalizeTranslationBaseUrl, TranslationCredentialStore, type SafeStorageAdapter } from './translation-credentials'
import { cliArgumentTemplate, TranslationCliAuthorization, type CliAuthorizationAdapter } from './translation-cli-authorization'
export type { SafeStorageAdapter } from './translation-credentials'
export type { CliAuthorizationRequest, CliAuthorizationAdapter } from './translation-cli-authorization'

export interface TranslationServiceOptions {
  database: LibraryDatabase
  safeStorage?: SafeStorageAdapter
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  authorizeCli?: CliAuthorizationAdapter
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
const BATCH_MAX_CHARS = 3800
const BATCH_MAX_ITEMS = 10

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
  return normalizeTranslationBaseUrl(baseUrl)
}

function formatOpenAiHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl
  } catch {
    return baseUrl
  }
}

function formatTestedEngineMeta(
  config: StoredTranslationConfig,
  resolvedCommand?: string
): {
  testedProvider: TranslationProviderType
  testedLabel: string
  testedTarget: string
} {
  if (config.provider === 'openai-compatible') {
    return {
      testedProvider: 'openai-compatible',
      testedLabel: config.openai.model,
      testedTarget: formatOpenAiHost(config.openai.baseUrl)
    }
  }
  const cliBaseName =
    config.cli.preset === 'codex'
      ? 'Codex CLI'
      : config.cli.preset === 'gemini'
        ? 'Gemini CLI'
        : '自定义 CLI'
  return {
    testedProvider: 'cli',
    testedLabel: config.cli.model ? `${cliBaseName} · ${config.cli.model}` : cliBaseName,
    testedTarget: resolvedCommand ?? config.cli.command
  }
}

function buildStoredConfigFromInput(
  validated: SaveTranslationSettingsInput,
  fallbackGlossary: GlossaryEntry[]
): StoredTranslationConfig {
  return {
    provider: validated.provider,
    targetLanguage: validated.targetLanguage,
    glossary: validated.glossary ?? fallbackGlossary,
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
}

function providerSignatureFor(config: StoredTranslationConfig, scopeFingerprint?: string): string {
  const base =
    config.provider === 'openai-compatible'
      ? `openai:${normalizeBaseUrl(config.openai.baseUrl)}|${config.openai.model}|${config.targetLanguage}`
      : `cli:${config.cli.preset}|${config.cli.command}|${config.cli.model}|${config.targetLanguage}`
  return scopeFingerprint ? `${base}|scope:${scopeFingerprint}` : base
}

function isExecutableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * 纯文件系统扫描 PATH / 标准 Node 工具路径及常见本机客户端安装目录解析可执行命令，
 * 在 Windows 上优先匹配 `.exe`/`.com`，其次匹配 npm 生成的 `.cmd`/`.bat` 包装脚本。
 */
function resolveCliExecutableInternal(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { includeCodexRuntimeFallback?: boolean } = {}
): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  const isWindows = process.platform === 'win32'
  const winExts = ['.exe', '.com', '.cmd', '.bat']
  const includeCodexRuntimeFallback = options.includeCodexRuntimeFallback !== false

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

  const rawEntries = (env.PATH || env.Path || '')
    .split(isWindows ? ';' : ':')
    .map(p => p.trim())
    .filter(Boolean)

  if (isWindows) {
    if (env.APPDATA) rawEntries.push(join(env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA) {
      rawEntries.push(join(env.LOCALAPPDATA, 'pnpm'))
      rawEntries.push(join(env.LOCALAPPDATA, 'Programs'))
    }
    if (env.USERPROFILE) {
      rawEntries.push(
        join(env.USERPROFILE, '.local', 'bin'),
        join(env.USERPROFILE, '.bun', 'bin'),
        join(env.USERPROFILE, '.volta', 'bin'),
        join(env.USERPROFILE, 'scoop', 'shims')
      )
    }
    if (trimmed.toLowerCase() === 'codex' && includeCodexRuntimeFallback && env.USERPROFILE) {
      rawEntries.push(
        join(env.USERPROFILE, '.codex', '.sandbox-bin'),
        join(env.USERPROFILE, '.codex', 'plugins', '.plugin-appserver')
      )
    }
  } else {
    if (env.HOME) {
      rawEntries.push(
        join(env.HOME, '.local', 'bin'),
        join(env.HOME, '.npm-global', 'bin'),
        join(env.HOME, '.bun', 'bin'),
        join(env.HOME, '.volta', 'bin')
      )
    }
    rawEntries.push('/opt/homebrew/bin', '/usr/local/bin')
  }

  const seen = new Set<string>()
  for (const dir of rawEntries) {
    const key = isWindows ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    const hit = probeCandidate(join(dir, trimmed))
    if (hit) return hit
  }
  return null
}

export function resolveCliExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveCliExecutableInternal(command, env, { includeCodexRuntimeFallback: true })
}

function quoteCmdToken(token: string): string {
  if (/[\r\n&|<>^%"]/.test(token)) {
    throw new Error('命令行参数包含不支持的控制或特殊字符。')
  }
  return `"${token}"`
}

async function probeWindowsAppxExecutable(
  packageName: 'OpenAI.Codex',
  relativeSegments: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (process.platform !== 'win32' || env.PAPERFLOW_SKIP_APPX_PROBE === '1') {
    return null
  }
  return new Promise<string | null>(resolvePromise => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }

    let child: ChildProcess
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-AppxPackage -Name '${packageName}').InstallLocation`],
        {
          env,
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true
        }
      )
    } catch {
      finish(null)
      return
    }

    let stdout = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      finish(null)
    }, 4000)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.once('error', () => finish(null))
    child.once('close', () => {
      const locations = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
      for (const dir of locations) {
        const candidate = join(dir, ...relativeSegments)
        if (isExecutableFile(candidate)) {
          finish(candidate)
          return
        }
      }
      finish(null)
    })
  })
}

async function probeCliVersion(
  executablePath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (env.PAPERFLOW_SKIP_VERSION_PROBE === '1') return null
  const isWindows = process.platform === 'win32'
  const ext = extname(executablePath).toLowerCase()
  const isWinBatch = isWindows && (ext === '.cmd' || ext === '.bat')

  return new Promise<string | null>(resolvePromise => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }

    let child: ChildProcess
    try {
      if (isWinBatch) {
        const cmdLine = `"${quoteCmdToken(executablePath)} --version"`
        child = spawn(env.ComSpec || env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', cmdLine], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: true
        })
      } else {
        child = spawn(executablePath, ['--version'], {
          env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      }
    } catch {
      finish(null)
      return
    }

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      if (isWinBatch && typeof child.pid === 'number' && child.pid > 0) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } catch {
          // ignore
        }
      } else {
        try {
          child.kill('SIGTERM')
        } catch {
          // ignore
        }
      }
      finish(null)
    }, 2500)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', () => finish(null))
    child.once('close', code => {
      if (code !== 0) {
        finish(null)
        return
      }
      const line = `${stdout}\n${stderr}`
        .split(/\r?\n/)
        .map(item => item.trim())
        .find(Boolean)
      finish(line ? line.slice(0, 80) : null)
    })
  })
}

async function detectGuiOnlyClient(
  _preset: 'gemini',
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (process.platform === 'win32') {
    const geminiBase = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Google', 'Gemini') : null
    if (geminiBase && existsSync(geminiBase)) {
      try {
        const entries = readdirSync(geminiBase, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith('app-'))
          .sort((a, b) => b.name.localeCompare(a.name))
        for (const entry of entries) {
          const exePath = join(geminiBase, entry.name, 'Gemini.exe')
          if (isExecutableFile(exePath)) return exePath
        }
      } catch {
        // 忽略目录不可读
      }
    }
    return null
  }

  if (process.platform === 'darwin') {
    return existsSync('/Applications/Gemini.app') ? '/Applications/Gemini.app' : null
  }

  return null
}

/**
 * 扫描本机已安装的 AI 客户端（OpenAI Codex / Gemini CLI）及仅桌面端应用，
 * 供「翻译引擎设置」中一键识别并设为翻译引擎。
 */
export async function detectLocalAiClients(
  env: NodeJS.ProcessEnv = process.env,
  options: { probeVersion?: boolean } = {}
): Promise<DetectedLocalAiClient[]> {
  // 发现文件不等于授权运行，默认不执行 --version 探针。
  const probeVersion = options.probeVersion === true

  const detectCodex = async (): Promise<DetectedLocalAiClient> => {
    const pathHit = resolveCliExecutableInternal('codex', env, { includeCodexRuntimeFallback: false })
    if (pathHit) {
      return {
        preset: 'codex',
        name: 'OpenAI Codex',
        status: 'ready',
        command: pathHit,
        source: 'Codex CLI (PATH)',
        version: null,
        hint: '已就绪，可直接点击「设为翻译引擎」使用本机已登录的 Codex CLI。'
      }
    }
    const appxHit = await probeWindowsAppxExecutable('OpenAI.Codex', ['app', 'resources', 'codex.exe'], env)
    if (appxHit) {
      return {
        preset: 'codex',
        name: 'OpenAI Codex',
        status: 'ready',
        command: appxHit,
        source: 'OpenAI Codex 客户端',
        version: null,
        hint: '已从本机 OpenAI Codex 客户端发现内置 CLI，可直接一键设为翻译引擎。'
      }
    }
    const fallbackHit = resolveCliExecutableInternal('codex', env, { includeCodexRuntimeFallback: true })
    if (fallbackHit) {
      return {
        preset: 'codex',
        name: 'OpenAI Codex',
        status: 'ready',
        command: fallbackHit,
        source: 'Codex 本地运行时',
        version: null,
        hint: '已检测到本机 Codex 运行时 CLI，可直接一键设为翻译引擎。'
      }
    }
    return {
      preset: 'codex',
      name: 'OpenAI Codex',
      status: 'not-found',
      command: null,
      source: null,
      version: null,
      hint: '未检测到 Codex 客户端或 codex CLI，可点击「手动指定…」选择本地可执行程序。'
    }
  }

  const detectGemini = async (): Promise<DetectedLocalAiClient> => {
    const cliHit = resolveCliExecutableInternal('gemini', env, { includeCodexRuntimeFallback: false })
    if (cliHit) {
      return {
        preset: 'gemini',
        name: 'Gemini CLI',
        status: 'ready',
        command: cliHit,
        source: 'Gemini CLI',
        version: null,
        hint: '已就绪，可直接点击「设为翻译引擎」使用本机 Gemini CLI。'
      }
    }
    const guiHit = await detectGuiOnlyClient('gemini', env)
    if (guiHit) {
      return {
        preset: 'gemini',
        name: 'Gemini CLI',
        status: 'gui-only',
        command: null,
        source: 'Gemini 桌面应用（仅桌面端）',
        version: null,
        hint: '检测到本机 Gemini 桌面窗口应用（无 CLI 接口），如需接入请安装 Gemini CLI（gemini）或点击「手动指定…」。'
      }
    }
    return {
      preset: 'gemini',
      name: 'Gemini CLI',
      status: 'not-found',
      command: null,
      source: null,
      version: null,
      hint: '未检测到 Gemini CLI，安装 gemini 后点击「重新扫描」或「手动指定…」。'
    }
  }

  const detected = await Promise.all([detectCodex(), detectGemini()])
  if (probeVersion) {
    await Promise.all(
      detected.map(async entry => {
        if (entry.status === 'ready' && entry.command) {
          entry.version = await probeCliVersion(entry.command, env)
        }
      })
    )
  }
  return detected
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
  return matchesFormulaPlaceholders(sourceText, translatedText)
}

export interface AcademicPromptContext {
  documentSummary?: string
  sectionHeading?: string
  previousPageTail?: readonly string[]
  precedingPairs?: ReadonlyArray<{ sourceText: string; translatedText?: string }>
}

function sanitizePromptSnippet(raw: string, maxChars: number): string {
  let clean = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    clean += code < 32 || code === 127 ? ' ' : raw[i]
  }
  const normalized = clean.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`
}

function buildReadOnlyContextLines(promptContext?: AcademicPromptContext): string[] {
  if (!promptContext) return []
  const items: string[] = []
  const docSummary = sanitizePromptSnippet(promptContext.documentSummary ?? '', 500)
  const secHeading = sanitizePromptSnippet(promptContext.sectionHeading ?? '', 180)
  const prevTail = (promptContext.previousPageTail ?? [])
    .map(t => sanitizePromptSnippet(t, 180))
    .filter(Boolean)
  const pairs = (promptContext.precedingPairs ?? [])
    .map(p => ({
      sourceText: sanitizePromptSnippet(p.sourceText, 240),
      translatedText: p.translatedText ? sanitizePromptSnippet(p.translatedText, 240) : ''
    }))
    .filter(p => p.sourceText.length > 0)
    .slice(-3)

  if (docSummary) items.push(`- 论文背景：${docSummary}`)
  if (secHeading) items.push(`- 当前章节：${secHeading}`)
  if (prevTail.length > 0 && pairs.length < 2) {
    const joinedTail = sanitizePromptSnippet(prevTail.slice(-2).join(' '), 360)
    if (joinedTail) items.push(`- 上页结尾参考译文：${joinedTail}`)
  }
  if (pairs.length > 0) {
    let budget = 900
    const pairLines: string[] = []
    for (let i = pairs.length - 1; i >= 0; i -= 1) {
      const pair = pairs[i]
      const formatted = pair.translatedText
        ? `- 前文：${pair.sourceText} => 译文：${pair.translatedText}`
        : `- 前文（原文）：${pair.sourceText}`
      if (pairLines.length > 0 && formatted.length > budget) break
      pairLines.unshift(formatted.length > budget ? `${formatted.slice(0, budget - 1)}…` : formatted)
      budget -= formatted.length
    }
    items.push(...pairLines)
  }

  if (items.length === 0) return []
  return [
    '上下文参考（只读，用于理解代词指代、主题语境并保持术语译法前后一致；严禁翻译此区内容或将其输出到 translations 数组中）：',
    ...items
  ]
}

export function buildAcademicPrompt(
  targetLanguage: string,
  blocks: readonly TranslationBlockInput[],
  glossary: readonly GlossaryEntry[] = [],
  researchContext = '',
  promptContext?: AcademicPromptContext
): string {
  const targetName = languageLabel(targetLanguage)
  const payload = blocks.map(b => ({ id: b.blockId, kind: b.kind, text: b.sourceText }))
  const cleanContext = researchContext.trim()
  const contextLines = cleanContext
    ? [
        `读者科研背景（仅在当前论文与该学科相关时作为术语风格参考；若当前论文属于其他学科，请完全以论文本身学科规范为准）：${cleanContext}`
      ]
    : []
  const glossaryLines =
    glossary.length > 0
      ? [
          '参考术语表（当下列术语在当前论文语境下学科与词义一致时，请优先采用此统一译法；若当前论文属于其他学科或该词在上下文中有不同专指含义，请按论文本身语境准确翻译，切勿生搬硬套）：',
          ...glossary.slice(0, 200).map(item => `- ${item.source} => ${item.target}`)
        ]
      : []
  const readOnlyContextLines = buildReadOnlyContextLines(promptContext)
  return [
    `你是一位学术论文翻译助手。请将输入 JSON 数组中的英文论文文本准确翻译为${targetName}。`,
    '翻译要求：',
    '1. 忠实严谨、绝不遗漏输入中的任何词句、编号、注脚或限定语，也不擅自扩写或删改。',
    '2. 完整保留公式与符号原貌：若原文包含 ⟪M1⟫、⟪M2⟫ 等行内公式占位符，必须在译文对应语序位置原样保留每一个占位符，严禁删除、合并或改写编号；其余未替换为占位符的所有行内公式、数学符号、变量记号、希腊字母（如 α、δ、Θ）、上下标、运算符、复杂度记号（如 O(n log n)）、计量单位与硬件规格（如 μs、GB/s、$/TB、4 KB、4×）、参考文献编号（如 [1]、(Smith et al., 2025)）及图表/章节编号（如 Fig. 1、Table 2、Sect. 4）必须直接保留原文写法，切勿汉化符号、展开单位或改写为 $...$ / LaTeX 代码。',
    '3. 保留专有英文名词不译：除非参考术语表另有指定，系统/模型/算法/协议/数据集/软件/实验方法专名（如 Transformer、ResNet、CRISPR）、技术缩写与标准规范（如 DRAM、RDMA、MRI、PCR、SQL、API）、作者与机构名、会议期刊名（如 ACM、IEEE、Nature）、代码标识符以及 URL/DOI/邮箱一律保留英文原文，禁止意译或音译。',
    '4. 尽量保持与原文块一致的自然句数量与句末标点边界，不随意合句或拆句，并结合上下文保持术语译法与指代一致，便于逐句对照高亮。',
    '5. 紧凑单段纯文本排版：每个译文块仅输出单段连续纯文本，禁止在块内插入多余换行符、空行或 Markdown 标记（如 **粗体**、`代码`、# 标题）。',
    '6. 仅返回严格合法的 JSON 对象，格式为 {"translations":[{"id":"原id","text":"译文"}]}，确保输入中的每个 id 都有对应译文，禁止附加解释或无关文字。',
    ...contextLines,
    ...glossaryLines,
    ...readOnlyContextLines,
    '',
    JSON.stringify(payload)
  ].join('\n')
}

export function buildExplainPrompt(
  input: Pick<ExplainSelectionInput, 'selectedText' | 'contextText' | 'mode' | 'pageNumber'>,
  targetLanguage: string,
  glossary: readonly GlossaryEntry[] = [],
  researchContext = ''
): string {
  const targetName = languageLabel(targetLanguage)
  const cleanContext = researchContext.trim()
  const profileBlock = cleanContext
    ? `\n读者科研背景（仅在当前论文与该学科相关时参考；若论文属于其他领域请以论文本身语境为准）：${cleanContext}`
    : ''
  const glossaryBlock =
    glossary.length > 0
      ? `\n参考术语表（仅在当前论文语境与学科词义一致时参考，切勿跨学科生搬硬套）：\n${glossary
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
      profileBlock,
      glossaryBlock,
      `\n目标公式/表达式：\n${input.selectedText.trim()}`,
      contextBlock
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (input.mode === 'translate') {
    return [
      `你是一位学术论文翻译助手。请将下方选中片段准确译为${targetName}。`,
      '要求：保留全部行内公式、数学符号、变量、希腊字母、计量单位（如 μs、GB/s）与引用编号；除参考术语表明确指定外，系统/模型/算法/协议/数据集/技术缩写（如 DRAM、NVMe、RDMA、OLTP）、人名机构及代码标识符等英文专有名词一律保留英文原文不译。直接输出译文。',
      profileBlock,
      glossaryBlock,
      `\n选中片段：\n${input.selectedText.trim()}`,
      contextBlock
    ]
      .filter(Boolean)
      .join('\n')
  }

  return [
    `你是一位科研论文精读助手。请使用${targetName}对下方选中的论文片段做精要解读（自动判断正文或公式）：`,
    '1. 若选中内容包含数学公式、符号表达式或变量记号，先一句话概括其在论证/推导中的核心物理或数学含义，再逐项拆解关键变量、上下标与运算符（保持原符号写法，勿擅自改名）；',
    '2. 若为常规学术正文，先给出准确通顺的核心意思，再点明涉及的技术方法、因果逻辑或关键术语含义；',
    '3. 控制在 3–5 句或简洁要点内，方便读者记入笔记。',
    profileBlock,
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
  private readonly credentials: TranslationCredentialStore
  private readonly cliAuthorization: TranslationCliAuthorization
  private readonly fetchImpl: typeof fetch
  private readonly env: NodeJS.ProcessEnv
  private readonly usageService: UsageService
  private readonly activeTasks = new Map<
    string,
    {
      documentId?: string
      requestId?: string
      kind?: 'translate' | 'chat' | 'test'
      abort: () => void
    }
  >()

  constructor(options: TranslationServiceOptions) {
    this.database = options.database
    this.credentials = new TranslationCredentialStore(options.database, options.safeStorage)
    this.cliAuthorization = new TranslationCliAuthorization(options.database, options.authorizeCli)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.env = options.env ?? process.env
    this.usageService = new UsageService({
      database: this.database,
      // 余额请求也不得借 HTTP 重定向把绑定地址的凭据送到其他路径/主机。
      fetchImpl: (input, init) => this.fetchImpl(input, { ...init, redirect: 'error' })
    })
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
          preset: parsed.cli?.preset && ['codex', 'gemini', 'custom'].includes(parsed.cli.preset)
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

  private readApiKey(baseUrl = this.readStoredConfig().openai.baseUrl): string | null {
    return this.credentials.read(baseUrl)
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
        timeoutSec: config.cli.timeoutSec,
        authorized: this.cliAuthorization.hasConfiguredAuthorization(config.cli)
      }
    }
  }

  saveSettings(input: SaveTranslationSettingsInput): TranslationSettings {
    const validated = saveTranslationSettingsSchema.parse(input)
    const previous = this.readStoredConfig()
    const config = buildStoredConfigFromInput(validated, previous.glossary)
    if (validated.openai.apiKey !== undefined) {
      this.credentials.write(config.openai.baseUrl, validated.openai.apiKey)
    }
    this.database.setSetting(SETTINGS_KEY, JSON.stringify(config))
    return this.getSettings()
  }

  async authorizeCliSettings(input: SaveTranslationSettingsInput): Promise<{ authorized: boolean; resolvedCommand: string }> {
    const validated = saveTranslationSettingsSchema.parse(input)
    if (validated.provider !== 'cli') return { authorized: false, resolvedCommand: '' }
    const resolved = await this.resolveCliExecutableAsync(validated.cli.preset, validated.cli.command)
    if (!resolved) throw new Error('未找到所选本机 CLI 程序，请在翻译设置中选择可执行文件。')
    return { authorized: await this.cliAuthorization.approve(validated.cli, resolved), resolvedCommand: resolved }
  }

  getPageTranslations(documentId: string, pageNumber: number): TranslatedBlockRecord[] {
    const id = documentIdSchema.parse(documentId)
    const page = pageNumberSchema.parse(pageNumber)
    const config = this.readStoredConfig()
    return this.database.getPageTranslations(id, page, config.targetLanguage)
  }

  listDocumentTranslations(documentId: string): DocumentPageTranslations[] {
    const id = documentIdSchema.parse(documentId)
    const config = this.readStoredConfig()
    return this.database.listDocumentTranslations(id, config.targetLanguage)
  }

  updateBlockTranslation(input: UpdateBlockTranslationInput): TranslatedBlockRecord {
    const validated = updateBlockTranslationInputSchema.parse(input)
    const config = this.readStoredConfig()
    // 手动校对译文不带 |scope: 标签，确保不被后续切分/连翻缓存失效检测误覆写；仅用户主动点「重译」时替换
    this.database.upsertPageTranslations(
      validated.documentId,
      validated.pageNumber,
      config.targetLanguage,
      'manual-edit',
      [
        {
          blockId: validated.blockId,
          sourceHash: validated.sourceHash,
          translatedText: validated.translatedText
        }
      ]
    )
    const rows = this.database.getPageTranslations(
      validated.documentId,
      validated.pageNumber,
      config.targetLanguage
    )
    const matched = rows.find(row => row.blockId === validated.blockId)
    if (!matched) {
      throw new Error('保存手动修改的译文失败，请重试。')
    }
    return matched
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

  cancelAiTask(requestId?: string): void {
    for (const [taskId, task] of this.activeTasks.entries()) {
      if (requestId) {
        if (task.requestId === requestId || taskId === requestId) {
          this.activeTasks.delete(taskId)
          task.abort()
        }
      } else if (task.kind === 'chat' || task.kind === 'test') {
        this.activeTasks.delete(taskId)
        task.abort()
      }
    }
  }

  cancelAll(): void {
    this.cancel(undefined)
  }

  getUsageSummary(): UsageStatsSummary {
    return this.usageService.getSummary()
  }

  saveUsagePreferences(input: UsagePreferences): UsageStatsSummary {
    return this.usageService.savePreferences(input)
  }

  resetUsageStats(scope?: 'today' | 'all'): UsageStatsSummary {
    return this.usageService.resetStats(scope)
  }

  async getProviderBalance(draft?: SaveTranslationSettingsInput): Promise<ProviderBalanceSnapshot> {
    const storedConfig = this.readStoredConfig()
    let config = storedConfig
    let apiKey = this.readApiKey()
    if (draft !== undefined) {
      const validated = saveTranslationSettingsSchema.parse(draft)
      config = buildStoredConfigFromInput(validated, storedConfig.glossary)
      apiKey = validated.openai.apiKey !== undefined
        ? validated.openai.apiKey.trim() || null
        : this.readApiKey(config.openai.baseUrl)
    }
    return this.usageService.fetchProviderBalance({
      provider: config.provider,
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
      cliPreset: config.cli.preset,
      cliModel: config.cli.model,
      apiKey
    })
  }

  private async invokeOpenAiCompatible(
    config: StoredTranslationConfig,
    apiKey: string | null,
    prompt: string,
    signal: AbortSignal,
    timeoutMs: number,
    systemPrompt = 'You are a precise academic translator. Reply with strict JSON only.',
    chatMessages?: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    onDelta?: (delta: string, fullText: string) => void
  ): Promise<{ output: string; usage?: TokenUsageDelta }> {
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
      const messages = chatMessages && chatMessages.length > 0
        ? [...chatMessages]
        : [
            { role: 'system' as const, content: systemPrompt },
            { role: 'user' as const, content: prompt }
          ]
      const sendRequest = async (includeStreamUsageOption: boolean): Promise<Response> =>
        this.fetchImpl(endpoint, {
          method: 'POST',
          headers,
          redirect: 'error',
          signal: controller.signal,
          body: JSON.stringify({
            model: config.openai.model,
            temperature: 0.2,
            ...(onDelta
              ? includeStreamUsageOption
                ? { stream: true, stream_options: { include_usage: true } }
                : { stream: true }
              : {}),
            messages
          })
        })

      let response = await sendRequest(Boolean(onDelta))
      if (!response.ok && onDelta && (response.status === 400 || response.status === 422)) {
        await response.body?.cancel().catch(() => {})
        response = await sendRequest(false)
      }

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
        if (response.status === 402) {
          throw new Error(`翻译接口账户余额不足（HTTP 402），请先充值后再试${hint}`)
        }
        if (response.status === 404) {
          throw new Error(`未找到翻译接口端点（HTTP 404），请确认 Base URL 是否包含 /v1${hint}`)
        }
        if (response.status === 429) {
          throw new Error(`翻译接口请求过于频繁或额度不足（HTTP 429）${hint}`)
        }
        throw new Error(`翻译接口返回异常（HTTP ${response.status}）${hint}`)
      }

      const { text, usage } = await readOpenAiStreamOrJsonWithUsage(response, onDelta)
      return { output: text, usage }
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

  async detectLocalAiClients(): Promise<DetectedLocalAiClient[]> {
    return detectLocalAiClients(this.env, { probeVersion: false })
  }

  private async resolveCliExecutableAsync(_preset: CliPreset, command: string): Promise<string | null> {
    const trimmed = command.trim()
    if (!trimmed) return null
    if (trimmed.toLowerCase() === 'codex' && process.platform === 'win32') {
      const standard = resolveCliExecutableInternal('codex', this.env, { includeCodexRuntimeFallback: false })
      if (standard) return standard
      const appx = await probeWindowsAppxExecutable('OpenAI.Codex', ['app', 'resources', 'codex.exe'], this.env)
      if (appx) return appx
      return resolveCliExecutableInternal('codex', this.env, { includeCodexRuntimeFallback: true })
    }
    return resolveCliExecutable(trimmed, this.env)
  }

  private async invokeCli(
    config: StoredTranslationConfig,
    prompt: string,
    signal: AbortSignal
  ): Promise<{ output: string; resolvedCommand: string }> {
    const located = await this.resolveCliExecutableAsync(config.cli.preset, config.cli.command)
    if (!located) {
      throw new Error(`未在系统路径或本机客户端目录中找到 CLI 命令「${config.cli.command}」，请检查是否已安装或点击「浏览程序…」选择可执行文件。`)
    }
    const resolved = await this.cliAuthorization.requireApproved(config.cli, located)
    if (signal.aborted) throw new Error('翻译任务已取消。')

    const workDir = mkdtempSync(join(tmpdir(), 'paperflow-cli-'))
    const codexOutFile = join(workDir, 'codex-last.txt')
    const timeoutMs = config.cli.timeoutSec * 1000
    const { preset } = config.cli
    const args = cliArgumentTemplate(config.cli, codexOutFile)

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
            child = spawn(this.env.ComSpec || this.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', cmdLine], {
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
    systemPrompt?: string,
    onDelta?: (delta: string, fullText: string) => void
  ): Promise<{ output: string; resolvedCommand?: string; usage?: TokenUsageDelta }> {
    if (config.provider === 'openai-compatible') {
      return await this.invokeOpenAiCompatible(
        config,
        apiKey,
        prompt,
        signal,
        timeoutMs,
        systemPrompt,
        undefined,
        onDelta
      )
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
    const scope = resolveEffectiveTranslationScope(this.database, validated.documentId, config.glossary)
    const prompt = buildExplainPrompt(validated, config.targetLanguage, scope.glossary, scope.researchContext)

    try {
      const { output, usage } = await this.runModelPrompt(
        config,
        apiKey,
        prompt,
        controller.signal,
        config.provider === 'openai-compatible' ? 60000 : config.cli.timeoutSec * 1000,
        'You are a rigorous academic paper reading assistant. Reply concisely in clear prose.'
      )
      if (usage || config.provider === 'openai-compatible') {
        this.usageService.recordUsage({
          usage,
          apiRequests: config.provider === 'openai-compatible' ? 1 : 0
        })
      }
      return {
        mode: validated.mode,
        answer: output.trim(),
        latencyMs: Math.max(1, Date.now() - started),
        ...(usage ? { usage } : {})
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

  async chat(
    input: SendAiChatInput,
    onStream?: (delta: string, fullText: string) => void
  ): Promise<SendAiChatResult> {
    const validated = sendAiChatInputSchema.parse(input)
    const config = this.readStoredConfig()
    const apiKey = this.readApiKey()
    const history = this.database.listChatMessages(validated.sessionKey).slice(-10)
    const primaryContext = validated.contexts[0]
    const scope = primaryContext
      ? resolveEffectiveTranslationScope(this.database, primaryContext.documentId, config.glossary)
      : { glossary: config.glossary, researchContext: '' }

    const taskId = validated.requestId ?? randomUUID()
    const controller = new AbortController()
    this.activeTasks.set(taskId, {
      documentId: primaryContext?.documentId,
      requestId: taskId,
      kind: 'chat',
      abort: () => controller.abort()
    })
    const started = Date.now()

    const systemParts: string[] = [
      `You are PaperFlow's academic research assistant. Reply in ${languageLabel(config.targetLanguage)} unless the user requests another language.`,
      'Be accurate, concise, and explicitly distinguish cited paper observations from general inference. When referencing specific findings or sections from the provided pages, include page markers like P.3 when known.'
    ]
    if (scope.researchContext.trim()) {
      systemParts.push(`Research domain context: ${scope.researchContext.trim()}`)
    }
    if (scope.glossary.length > 0) {
      systemParts.push(
        `Domain terminology glossary:\n${scope.glossary
          .slice(0, 40)
          .map(item => `- ${item.source} => ${item.target}`)
          .join('\n')}`
      )
    }

    const contextSections = validated.contexts.map((ctx, index) => {
      const label = ctx.paneLabel ? `[${ctx.paneLabel}] ` : validated.contexts.length > 1 ? `[文献 ${index + 1}] ` : ''
      const pagePart = ctx.pageNumber ? ` (P.${ctx.pageNumber})` : ''
      const bodyPart = ctx.excerpt?.trim() ? `\nExcerpt:\n${ctx.excerpt.trim()}` : ''
      return `${label}${ctx.title}${pagePart}${bodyPart}`
    })

    const userSections: string[] = []
    if (contextSections.length > 0) {
      userSections.push(`Active paper context:\n${contextSections.join('\n\n')}`)
    }
    if (validated.quoteText?.trim()) {
      userSections.push(`Highlighted selection:\n"${validated.quoteText.trim()}"`)
    }
    userSections.push(`Question:\n${validated.question}`)
    const composedUserTurn = userSections.join('\n\n')

    const contextSummary = validated.contexts
      .map(ctx => `${ctx.paneLabel ? `${ctx.paneLabel}:` : ''}${ctx.title}${ctx.pageNumber ? `#P.${ctx.pageNumber}` : ''}`)
      .join(' · ')
      .slice(0, 240)

    try {
      let answerText = ''
      let chatUsage: TokenUsageDelta | undefined
      const timeoutMs = config.provider === 'openai-compatible' ? 60000 : config.cli.timeoutSec * 1000
      if (config.provider === 'openai-compatible') {
        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemParts.join('\n\n') },
          ...history.map(item => ({ role: item.role, content: item.content })),
          { role: 'user', content: composedUserTurn }
        ]
        const res = await this.invokeOpenAiCompatible(
          config,
          apiKey,
          composedUserTurn,
          controller.signal,
          timeoutMs,
          undefined,
          messages,
          onStream
        )
        answerText = res.output
        chatUsage = res.usage
      } else {
        const historyBlock =
          history.length > 0
            ? `Recent conversation:\n${history
                .map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`)
                .join('\n\n')}\n\n`
            : ''
        const cliPrompt = `${systemParts.join('\n\n')}\n\n${historyBlock}${composedUserTurn}`
        const res = await this.invokeCli(config, cliPrompt, controller.signal)
        answerText = res.output
      }

      if (chatUsage || config.provider === 'openai-compatible') {
        this.usageService.recordUsage({
          usage: chatUsage,
          apiRequests: config.provider === 'openai-compatible' ? 1 : 0
        })
      }

      const now = Date.now()
      const userMessage = this.database.appendChatMessage({
        sessionKey: validated.sessionKey,
        role: 'user',
        content: validated.question,
        quoteText: validated.quoteText ?? '',
        contextSummary,
        createdAt: new Date(now).toISOString()
      })
      const assistantMessage = this.database.appendChatMessage({
        sessionKey: validated.sessionKey,
        role: 'assistant',
        content: answerText.trim(),
        quoteText: '',
        contextSummary,
        createdAt: new Date(now + 1).toISOString()
      })
      return {
        userMessage,
        assistantMessage,
        latencyMs: Math.max(1, Date.now() - started),
        ...(chatUsage ? { usage: chatUsage } : {})
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new Error('AI 对话请求已取消。')
      }
      throw error
    } finally {
      this.activeTasks.delete(taskId)
    }
  }

  hasConfiguredAiEngine(): boolean {
    const config = this.readStoredConfig()
    if (config.provider === 'openai-compatible') {
      return Boolean(this.readApiKey())
    }
    return this.cliAuthorization.hasConfiguredAuthorization(config.cli)
  }

  async completeAcademicTask(options: {
    systemPrompt: string
    userPrompt: string
    timeoutMs?: number
  }): Promise<string> {
    const config = this.readStoredConfig()
    const apiKey = this.readApiKey()
    if (config.provider === 'openai-compatible' && !apiKey) {
      throw new Error('尚未配置 API Key。')
    }
    const taskId = randomUUID()
    const controller = new AbortController()
    this.activeTasks.set(taskId, { abort: () => controller.abort() })
    const timeoutMs =
      options.timeoutMs ?? (config.provider === 'openai-compatible' ? 45_000 : config.cli.timeoutSec * 1000)
    try {
      const { output, usage } = await this.runModelPrompt(
        config,
        apiKey,
        options.userPrompt,
        controller.signal,
        timeoutMs,
        options.systemPrompt
      )
      if (usage || config.provider === 'openai-compatible') {
        this.usageService.recordUsage({
          usage,
          apiRequests: config.provider === 'openai-compatible' ? 1 : 0
        })
      }
      return output.trim()
    } finally {
      this.activeTasks.delete(taskId)
    }
  }

  async runAcademicSkill(
    input: RunAiSkillInput,
    onStream?: (delta: string, fullText: string) => void
  ): Promise<RunAiSkillResult> {
    const validated = runAiSkillInputSchema.parse(input)
    const config = this.readStoredConfig()
    const apiKey = this.readApiKey()
    const primaryContext = validated.contexts[0]
    const scope = primaryContext
      ? resolveEffectiveTranslationScope(this.database, primaryContext.documentId, config.glossary)
      : { glossary: config.glossary, researchContext: '' }

    const glossaryText =
      scope.glossary.length > 0
        ? scope.glossary
            .slice(0, 40)
            .map(item => `- ${item.source} => ${item.target}`)
            .join('\n')
        : ''

    const promptSpec = buildAcademicSkillPrompt({
      skill: validated.skill,
      targetLanguage: languageLabel(config.targetLanguage),
      researchContext: scope.researchContext,
      glossaryText,
      customInstruction: validated.customInstruction,
      customSkillName: validated.customSkillName,
      customPrompt: validated.customPrompt,
      contexts: validated.contexts
    })

    const taskId = validated.requestId ?? randomUUID()
    const controller = new AbortController()
    this.activeTasks.set(taskId, {
      documentId: primaryContext?.documentId,
      requestId: taskId,
      kind: 'chat',
      abort: () => controller.abort()
    })
    const started = Date.now()
    const contextSummary =
      validated.contexts.length > 0
        ? validated.contexts
            .map(ctx => `${ctx.paneLabel ? `${ctx.paneLabel}:` : ''}${ctx.title}`)
            .join(' · ')
            .slice(0, 240)
        : promptSpec.displayTitle

    try {
      const timeoutMs = config.provider === 'openai-compatible' ? 90_000 : config.cli.timeoutSec * 1000
      const streamCb = validated.skill === 'ppt-deck' ? undefined : onStream
      const { output, usage } = await this.runModelPrompt(
        config,
        apiKey,
        promptSpec.userPrompt,
        controller.signal,
        timeoutMs,
        promptSpec.systemPrompt,
        streamCb
      )
      if (usage || config.provider === 'openai-compatible') {
        this.usageService.recordUsage({
          usage,
          apiRequests: config.provider === 'openai-compatible' ? 1 : 0
        })
      }

      let slideDeck: AcademicSlideDeck | undefined
      let assistantText = output.trim()
      if (validated.skill === 'ppt-deck') {
        const fallbackTitle = primaryContext?.title || '论文汇报幻灯片'
        slideDeck = parseSlideDeckJson(assistantText, fallbackTitle)
        assistantText = formatSlideDeckMarkdown(slideDeck)
      }

      const now = Date.now()
      const userMessage = this.database.appendChatMessage({
        sessionKey: validated.sessionKey,
        role: 'user',
        content: promptSpec.userLabel,
        quoteText: '',
        contextSummary,
        createdAt: new Date(now).toISOString()
      })
      const assistantMessage = this.database.appendChatMessage({
        sessionKey: validated.sessionKey,
        role: 'assistant',
        content: assistantText,
        quoteText: '',
        contextSummary: slideDeck
          ? `${promptSpec.displayTitle} · 共 ${slideDeck.slides.length} 页`
          : promptSpec.displayTitle,
        createdAt: new Date(now + 1).toISOString()
      })

      return {
        skill: validated.skill,
        userMessage,
        assistantMessage,
        ...(slideDeck ? { slideDeck } : {}),
        latencyMs: Math.max(1, Date.now() - started),
        ...(usage ? { usage } : {})
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new Error('科研技能生成请求已取消。')
      }
      throw error
    } finally {
      this.activeTasks.delete(taskId)
    }
  }

  getDocumentTranslationScope(documentId: string): DocumentTranslationScope {
    const validatedId = documentIdSchema.parse(documentId)
    const config = this.readStoredConfig()
    const scope = resolveEffectiveTranslationScope(this.database, validatedId, config.glossary)
    return {
      documentId: validatedId,
      folderId: scope.folder?.id ?? null,
      folderName: scope.folder?.name ?? null,
      inheritGlobalGlossary: scope.folder ? scope.folder.inheritGlobalGlossary : true,
      effectiveGlossaryCount: scope.glossary.length,
      folderGlossaryCount: scope.folderGlossaryCount,
      globalGlossaryCount: scope.globalGlossaryCount,
      scopeFingerprint: scope.scopeFingerprint,
      effectiveGlossary: scope.glossary
    }
  }

  async testConnection(draft?: SaveTranslationSettingsInput): Promise<TranslationTestResult> {
    const storedConfig = this.readStoredConfig()
    let config = storedConfig
    let apiKey = this.readApiKey()
    if (draft !== undefined) {
      const validated = saveTranslationSettingsSchema.parse(draft)
      config = buildStoredConfigFromInput(validated, storedConfig.glossary)
      apiKey = validated.openai.apiKey !== undefined
        ? validated.openai.apiKey.trim() || null
        : this.readApiKey(config.openai.baseUrl)
    }

    const taskId = randomUUID()
    const controller = new AbortController()
    this.activeTasks.set(taskId, { kind: 'test', abort: () => controller.abort() })
    const started = Date.now()

    const sampleBlock: TranslationBlockInput = {
      blockId: 'test-b001',
      kind: 'paragraph',
      sourceText: 'Local offline reader.',
      sourceHash: '0123456789abcdef'
    }

    try {
      const { output, resolvedCommand, usage } = await this.runModelPrompt(
        config,
        apiKey,
        buildAcademicPrompt(config.targetLanguage, [sampleBlock]),
        controller.signal,
        config.provider === 'openai-compatible' ? 25000 : config.cli.timeoutSec * 1000
      )
      if (usage || config.provider === 'openai-compatible') {
        this.usageService.recordUsage({
          usage,
          apiRequests: config.provider === 'openai-compatible' ? 1 : 0
        })
      }
      const parsed = parseBatchTranslationOutput(output, [sampleBlock])
      const sampleOutput = parsed.get(sampleBlock.blockId) ?? output.slice(0, 120)
      return {
        ok: true,
        latencyMs: Math.max(1, Date.now() - started),
        ...formatTestedEngineMeta(config, resolvedCommand),
        sampleOutput,
        resolvedCommand,
        ...(usage ? { usage } : {})
      }
    } catch (error: unknown) {
      const resolvedCommand =
        config.provider === 'cli'
          ? (await this.resolveCliExecutableAsync(config.cli.preset, config.cli.command)) ?? undefined
          : undefined
      return {
        ok: false,
        latencyMs: Math.max(1, Date.now() - started),
        ...formatTestedEngineMeta(config, resolvedCommand),
        error: error instanceof Error ? error.message : String(error),
        resolvedCommand
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
    const started = Date.now()
    const engineMeta = formatTestedEngineMeta(config)
    const billingKind = detectProviderBillingKind(config.provider, config.openai.baseUrl, Boolean(apiKey?.trim()))
    const scope = resolveEffectiveTranslationScope(this.database, validated.documentId, config.glossary)
    const signature = providerSignatureFor(config, scope.scopeFingerprint)

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
      const scopeMatches =
        !cached?.providerSignature.includes('|scope:') || cached.providerSignature === signature
      if (
        !validated.force &&
        cached &&
        cached.sourceHash === block.sourceHash &&
        cached.translatedText.trim() &&
        hasAllExpectedFormulaPlaceholders(block.sourceText, cached.translatedText) &&
        scopeMatches
      ) {
        fromCacheCount += 1
      } else {
        pendingBlocks.push(block)
      }
    }

    if (pendingBlocks.length === 0) {
      if (fromCacheCount > 0) {
        this.usageService.recordUsage({ cacheHitBlocks: fromCacheCount })
      }
      const items = validated.blocks
        .map(block => existingById.get(block.blockId))
        .filter((row): row is TranslatedBlockRecord => Boolean(row))
      return {
        documentId: validated.documentId,
        pageNumber: validated.pageNumber,
        items,
        fromCacheCount,
        translatedCount: 0,
        latencyMs: Math.max(1, Date.now() - started),
        billingKind,
        providerLabel: engineMeta.testedLabel
      }
    }

    const taskId = randomUUID()
    const controller = new AbortController()
    this.activeTasks.set(taskId, {
      documentId: validated.documentId,
      abort: () => controller.abort()
    })

    const summaryKey = `${DOC_SUMMARY_SETTING_PREFIX}${validated.documentId}`
    let documentSummary = sanitizePromptSnippet(validated.context?.documentSummary ?? '', 500)
    if (documentSummary) {
      this.database.setSetting(summaryKey, documentSummary)
    } else {
      documentSummary = sanitizePromptSnippet(this.database.getSetting(summaryKey) ?? '', 500)
      if (!documentSummary && validated.pageNumber === 1) {
        const p1Title =
          validated.blocks.find(b => b.kind === 'heading')?.sourceText ?? validated.blocks[0]?.sourceText ?? ''
        const p1AbstractIdx = validated.blocks.findIndex(
          b => b.kind === 'heading' && /^abstract\b/i.test(b.sourceText.trim())
        )
        const p1Para =
          (p1AbstractIdx >= 0
            ? validated.blocks.slice(p1AbstractIdx + 1).find(b => b.kind === 'paragraph')
            : undefined) ?? validated.blocks.find(b => b.kind === 'paragraph' && b.sourceText.length >= 40)
        const summaryParts = [
          p1Title ? `标题：${sanitizePromptSnippet(p1Title, 180)}` : '',
          p1Para && p1Para.sourceText !== p1Title ? `摘要：${sanitizePromptSnippet(p1Para.sourceText, 280)}` : ''
        ].filter(Boolean)
        documentSummary = sanitizePromptSnippet(summaryParts.join('；'), 500)
        if (documentSummary) {
          this.database.setSetting(summaryKey, documentSummary)
        }
      }
      if (!documentSummary) {
        const docMeta = this.database.getDocument(validated.documentId)
        if (docMeta?.displayTitle) {
          documentSummary = `标题：${sanitizePromptSnippet(docMeta.displayTitle, 180)}`
        }
      }
    }

    let previousPageTail: string[] = []
    if (
      validated.pageNumber > 1 &&
      !(validated.context?.precedingBlocks && validated.context.precedingBlocks.length > 0)
    ) {
      const prevRows = this.database.getPageTranslations(
        validated.documentId,
        validated.pageNumber - 1,
        config.targetLanguage
      )
      const nonCaptionPrev = prevRows.filter(
        r => r.translatedText.trim().length > 0 && !r.blockId.includes('-caption-')
      )
      const tailPool = nonCaptionPrev.length > 0 ? nonCaptionPrev : prevRows.filter(r => r.translatedText.trim().length > 0)
      previousPageTail = tailPool
        .slice(-2)
        .map(r => sanitizePromptSnippet(r.translatedText, 180))
        .filter(Boolean)
    }

    const knownTranslations = new Map<string, string>()
    for (const row of existingRows) {
      if (row.translatedText.trim()) {
        knownTranslations.set(row.blockId, row.translatedText.trim())
      }
    }
    const blockIndexById = new Map<string, number>()
    validated.blocks.forEach((b, idx) => blockIndexById.set(b.blockId, idx))

    const buildBatchPromptContext = (targetBatch: readonly TranslationBlockInput[]): AcademicPromptContext => {
      const firstIdx = blockIndexById.get(targetBatch[0]?.blockId ?? '') ?? 0
      const precedingAll = firstIdx > 0 ? validated.blocks.slice(0, firstIdx) : []
      const inPageHeadings = precedingAll
        .filter(b => b.kind === 'heading')
        .map(b => sanitizePromptSnippet(b.sourceText, 120))
        .filter(Boolean)
      const sectionHeading =
        inPageHeadings.length > 0
          ? sanitizePromptSnippet(inPageHeadings.slice(-2).join(' > '), 180)
          : sanitizePromptSnippet(validated.context?.sectionHeading ?? '', 180)

      const nonCaptions = precedingAll.filter(b => b.kind !== 'caption')
      const inPagePool = nonCaptions.length > 0 ? nonCaptions : precedingAll
      let precedingPairs: Array<{ sourceText: string; translatedText?: string }> = inPagePool.slice(-3).map(b => ({
        sourceText: b.sourceText,
        translatedText: knownTranslations.get(b.blockId)
      }))

      if (
        precedingPairs.length === 0 &&
        validated.context?.precedingBlocks &&
        validated.context.precedingBlocks.length > 0
      ) {
        precedingPairs = validated.context.precedingBlocks.slice(-3).map(entry => ({
          sourceText: entry.sourceText,
          translatedText: entry.translatedText
        }))
      }

      return {
        ...(documentSummary ? { documentSummary } : {}),
        ...(sectionHeading ? { sectionHeading } : {}),
        ...(previousPageTail.length > 0 ? { previousPageTail } : {}),
        ...(precedingPairs.length > 0 ? { precedingPairs } : {})
      }
    }

    let translatedCount = 0
    let pageUsage: TokenUsageDelta | undefined
    let apiRequests = 0
    try {
      const batches = chunkTranslationBlocks(pendingBlocks)
      for (const batch of batches) {
        if (controller.signal.aborted) throw new Error('翻译任务已取消。')

        const prompt = buildAcademicPrompt(
          config.targetLanguage,
          batch,
          scope.glossary,
          scope.researchContext,
          buildBatchPromptContext(batch)
        )
        const { output, usage: batchUsage } = await this.runModelPrompt(config, apiKey, prompt, controller.signal)
        if (config.provider === 'openai-compatible') apiRequests += 1
        pageUsage = mergeTokenUsage(pageUsage, batchUsage)
        const mapped = parseBatchTranslationOutput(output, batch)

        const missing: TranslationBlockInput[] = []
        const completedBatch: Array<{ blockId: string; sourceHash: string; translatedText: string }> = []
        for (const block of batch) {
          const text = mapped.get(block.blockId)
          if (text && hasAllExpectedFormulaPlaceholders(block.sourceText, text)) {
            knownTranslations.set(block.blockId, text)
            completedBatch.push({ blockId: block.blockId, sourceHash: block.sourceHash, translatedText: text })
          } else {
            missing.push(block)
          }
        }

        // 若多块批输出不完整、格式偏差或丢失公式占位符，仅对相关块按单块稳健重试与回退
        for (const single of missing) {
          if (controller.signal.aborted) throw new Error('翻译任务已取消。')
          const singlePrompt = buildAcademicPrompt(
            config.targetLanguage,
            [single],
            scope.glossary,
            scope.researchContext,
            buildBatchPromptContext([single])
          )
          const { output: singleOutput, usage: singleUsage } = await this.runModelPrompt(
            config,
            apiKey,
            singlePrompt,
            controller.signal
          )
          if (config.provider === 'openai-compatible') apiRequests += 1
          pageUsage = mergeTokenUsage(pageUsage, singleUsage)
          const singleMapped = parseBatchTranslationOutput(singleOutput, [single])
          const retriedText = singleMapped.get(single.blockId)
          if (!retriedText || !hasAllExpectedFormulaPlaceholders(single.sourceText, retriedText)) {
            throw new Error(`块 ${single.blockId} 译文解析失败或公式标记不完整，未保存该批译文。请重试或切换模型。`)
          }
          knownTranslations.set(single.blockId, retriedText)
          completedBatch.push({
            blockId: single.blockId,
            sourceHash: single.sourceHash,
            translatedText: retriedText
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

      this.usageService.recordUsage({
        usage: pageUsage,
        apiRequests,
        translatedBlocks: translatedCount,
        translatedPages: translatedCount > 0 ? 1 : 0,
        cacheHitBlocks: fromCacheCount
      })

      let balance: ProviderBalanceSnapshot | null = null
      if (translatedCount > 0 && billingKind === 'deepseek-balance' && apiKey) {
        balance = await this.usageService
          .fetchProviderBalance(
            {
              provider: config.provider,
              baseUrl: config.openai.baseUrl,
              model: config.openai.model,
              cliPreset: config.cli.preset,
              cliModel: config.cli.model,
              apiKey
            },
            3500
          )
          .catch(() => null)
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
        translatedCount,
        ...(pageUsage ? { usage: pageUsage } : {}),
        latencyMs: Math.max(1, Date.now() - started),
        billingKind,
        providerLabel: engineMeta.testedLabel,
        ...(balance ? { balance } : {})
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
