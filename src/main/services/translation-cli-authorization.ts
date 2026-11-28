import { createHash } from 'node:crypto'
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import type { CliPreset, SaveTranslationSettingsInput } from '../../shared/contracts'
import type { TranslationSettingsStore } from './translation-credentials'

export type CliConfiguration = SaveTranslationSettingsInput['cli']
export interface CliAuthorizationRequest {
  preset: CliPreset
  resolvedExecutable: string
  /** 确切参数模板；仅应用自行产生的临时输出路径使用固定占位符。 */
  args: string[]
  model: string
  timeoutSec: number
  configurationFingerprint: string
  reason: 'settings'
}
export type CliAuthorizationAdapter = (request: CliAuthorizationRequest) => Promise<boolean>
export const CLI_AUTHORIZATION_KEY = 'translation.cliAuthorizations.v1'
const CONFIRM_MESSAGE = '请在翻译设置中确认本机程序及参数后再使用 CLI。'

interface ExecutableIdentity { path: string; sha256: string; byteSize: number; mtimeMs: number }
interface AuthorizationRecord extends ExecutableIdentity {
  configurationFingerprint: string
  configDigest: string
  approvedAt: string
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function configDigest(config: CliConfiguration): string {
  return digest([config.preset, config.command, config.model, config.extraArgs, config.timeoutSec])
}
// 默认占位符参与持久化授权指纹，确认对话框使用当前展示名。
export function cliArgumentTemplate(config: CliConfiguration, outputPath = '<PaperFlow 临时输出文件>'): string[] {
  if (config.preset === 'codex') {
    return ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '-o', outputPath,
      ...(config.model ? ['-m', config.model] : []), ...config.extraArgs, '-']
  }
  if (config.preset === 'gemini') return [...(config.model ? ['-m', config.model] : []), ...config.extraArgs]
  return [...config.extraArgs]
}

async function executableIdentity(executable: string): Promise<ExecutableIdentity> {
  const path = await realpath(executable)
  const before = await stat(path)
  if (!before.isFile()) throw new Error('所选 CLI 不是普通可执行文件。')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const after = await stat(path)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error('本机 CLI 程序在校验期间发生变化，请重新确认。')
  }
  return { path, sha256: hash.digest('hex'), byteSize: after.size, mtimeMs: after.mtimeMs }
}

function fingerprint(config: CliConfiguration, identity: ExecutableIdentity): string {
  return digest([configDigest(config), identity.path, identity.sha256, cliArgumentTemplate(config)])
}

/** 授权记录独立于可由 renderer 保存的配置；执行路径只核验，绝不后台弹框。 */
export class TranslationCliAuthorization {
  private readonly pending = new Map<string, Promise<boolean>>()
  constructor(private readonly database: TranslationSettingsStore, private readonly authorize?: CliAuthorizationAdapter) {}

  private records(): AuthorizationRecord[] {
    const raw = this.database.getSetting(CLI_AUTHORIZATION_KEY)
    if (!raw) return []
    try {
      const value: unknown = JSON.parse(raw)
      if (!Array.isArray(value)) return []
      return value.slice(0, 64).flatMap((item: unknown): AuthorizationRecord[] => {
        if (!item || typeof item !== 'object' || !('path' in item) || typeof item.path !== 'string' ||
            !('sha256' in item) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
            !('configurationFingerprint' in item) || typeof item.configurationFingerprint !== 'string' ||
            !('configDigest' in item) || typeof item.configDigest !== 'string' ||
            !('byteSize' in item) || typeof item.byteSize !== 'number' ||
            !('mtimeMs' in item) || typeof item.mtimeMs !== 'number' ||
            !('approvedAt' in item) || typeof item.approvedAt !== 'string') return []
        return [{ path: item.path, sha256: item.sha256, configurationFingerprint: item.configurationFingerprint,
          configDigest: item.configDigest, byteSize: item.byteSize, mtimeMs: item.mtimeMs, approvedAt: item.approvedAt }]
      })
    } catch { return [] }
  }

  /** UI 状态仅作提示；实际执行始终重新读取程序并计算哈希。 */
  hasConfiguredAuthorization(config: CliConfiguration): boolean {
    return this.records().some(record => {
      if (record.configDigest !== configDigest(config)) return false
      try {
        const current = statSync(realpathSync(record.path))
        return current.isFile() && current.size === record.byteSize && current.mtimeMs === record.mtimeMs
      } catch { return false }
    })
  }

  async approve(config: CliConfiguration, executable: string): Promise<boolean> {
    const identity = await executableIdentity(executable)
    const configurationFingerprint = fingerprint(config, identity)
    const existing = this.records()
    const approved = existing.find(record => record.configurationFingerprint === configurationFingerprint)
    if (approved) {
      // 内容哈希未变时沿用原确认，但刷新 mtime 等提示元数据，避免状态永久假阴性。
      if (approved.mtimeMs !== identity.mtimeMs || approved.byteSize !== identity.byteSize) {
        this.database.setSetting(CLI_AUTHORIZATION_KEY, JSON.stringify(existing.map(record =>
          record.configurationFingerprint === configurationFingerprint ? { ...record, ...identity } : record)))
      }
      return true
    }
    if (!this.authorize) throw new Error(CONFIRM_MESSAGE)
    const active = this.pending.get(configurationFingerprint)
    if (active) return active
    const approval = (async (): Promise<boolean> => {
      const accepted = await this.authorize?.({ preset: config.preset, resolvedExecutable: identity.path,
        args: cliArgumentTemplate(config, '<Foliopair 临时输出文件>'), model: config.model, timeoutSec: config.timeoutSec,
        configurationFingerprint, reason: 'settings' })
      if (!accepted) return false
      // 用户阅读确认框期间程序发生变化，则不为替换后的程序颁发授权。
      const current = await executableIdentity(executable)
      if (fingerprint(config, current) !== configurationFingerprint) throw new Error('CLI 程序已变化，请重新确认本机程序。')
      const remaining = this.records().filter(record => record.configurationFingerprint !== configurationFingerprint)
      remaining.unshift({ ...current, configurationFingerprint, configDigest: configDigest(config), approvedAt: new Date().toISOString() })
      this.database.setSetting(CLI_AUTHORIZATION_KEY, JSON.stringify(remaining.slice(0, 64)))
      return true
    })()
    this.pending.set(configurationFingerprint, approval)
    try { return await approval } finally { this.pending.delete(configurationFingerprint) }
  }

  async requireApproved(config: CliConfiguration, executable: string): Promise<string> {
    const identity = await executableIdentity(executable)
    if (!this.records().some(record => record.configurationFingerprint === fingerprint(config, identity))) {
      throw new Error(CONFIRM_MESSAGE)
    }
    return identity.path
  }
}
