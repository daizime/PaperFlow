import { mkdtemp, rm, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CLI_AUTHORIZATION_KEY, TranslationCliAuthorization, cliArgumentTemplate,
  type CliConfiguration } from '../../src/main/services/translation-cli-authorization'
import type { TranslationSettingsStore } from '../../src/main/services/translation-credentials'

let root: string
let program: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paperflow-cli-authorization-'))
  program = join(root, 'synthetic-cli.fixture')
  await writeFile(program, 'SYNTHETIC-PROGRAM-A')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function memoryStore(): TranslationSettingsStore {
  const values = new Map<string, string>()
  return { getSetting: key => values.get(key) ?? null, setSetting: (key, value) => { values.set(key, value) },
    deleteSetting: key => { values.delete(key) } }
}
function configuration(): CliConfiguration {
  return { preset: 'custom', command: program, model: '', extraArgs: ['--synthetic'], timeoutSec: 60 }
}

describe('本机 CLI 主进程授权（只读取合成文件，绝不执行程序）', () => {
  test('旧配置无授权凭证，缺少确认 adapter 或用户拒绝时均不能执行', async () => {
    const db = memoryStore(), config = configuration()
    await expect(new TranslationCliAuthorization(db).requireApproved(config, program)).rejects.toThrow('请在翻译设置中确认本机程序')
    await expect(new TranslationCliAuthorization(db).approve(config, program)).rejects.toThrow('请在翻译设置中确认本机程序')
    const confirm = vi.fn(async () => false)
    const auth = new TranslationCliAuthorization(db, confirm)
    expect(await auth.approve(config, program)).toBe(false)
    expect(db.getSetting(CLI_AUTHORIZATION_KEY)).toBeNull()
    await expect(auth.requireApproved(config, program)).rejects.toThrow('确认本机程序')
  })

  test('确认确切程序/参数后凭证可重启复用，所有用户可控配置变化都需重确认', async () => {
    const db = memoryStore(), config = configuration(), confirm = vi.fn(async () => true)
    const auth = new TranslationCliAuthorization(db, confirm)
    expect(await auth.approve(config, program)).toBe(true)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ preset: 'custom', args: ['--synthetic'], timeoutSec: 60, reason: 'settings' }))
    expect(auth.hasConfiguredAuthorization(config)).toBe(true)
    const restarted = new TranslationCliAuthorization(db)
    await expect(restarted.requireApproved(config, program)).resolves.toBeTruthy()
    expect(await auth.approve(config, program)).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    for (const changed of [{ ...config, model: 'changed' }, { ...config, extraArgs: ['--other'] },
      { ...config, command: config.command + '.other' }, { ...config, preset: 'codex' as const }, { ...config, timeoutSec: 90 }]) {
      await expect(restarted.requireApproved(changed, program)).rejects.toThrow('确认本机程序')
    }
  })

  test('替换程序即使恢复原mtime且大小不变，也因内容哈希改变而撤销执行授权', async () => {
    const db = memoryStore(), config = configuration()
    const auth = new TranslationCliAuthorization(db, async () => true)
    await auth.approve(config, program)
    const original = await stat(program)
    await writeFile(program, 'SYNTHETIC-PROGRAM-B')
    await utimes(program, original.atime, original.mtime)
    await expect(auth.requireApproved(config, program)).rejects.toThrow('确认本机程序')
  })

  test('程序内容相同但mtime变化时，在设置中复核会刷新授权提示元数据', async () => {
    const db = memoryStore(), config = configuration(), confirm = vi.fn(async () => true)
    const auth = new TranslationCliAuthorization(db, confirm)
    await auth.approve(config, program)
    const original = await stat(program)
    await utimes(program, original.atime, new Date(original.mtimeMs + 5000))
    expect(auth.hasConfiguredAuthorization(config)).toBe(false)
    expect(await auth.approve(config, program)).toBe(true)
    expect(auth.hasConfiguredAuthorization(config)).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    await expect(auth.requireApproved(config, program)).resolves.toBeTruthy()
  })

  test('确认期间程序被替换不保存凭证；并发同配置确认只弹一次', async () => {
    const db = memoryStore(), config = configuration()
    const changing = new TranslationCliAuthorization(db, async () => { await writeFile(program, 'REPLACED'); return true })
    await expect(changing.approve(config, program)).rejects.toThrow('程序已变化')
    expect(db.getSetting(CLI_AUTHORIZATION_KEY)).toBeNull()
    const confirm = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return true })
    const auth = new TranslationCliAuthorization(db, confirm)
    expect(await Promise.all([auth.approve(config, program), auth.approve(config, program)])).toEqual([true, true])
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  test('Codex/Gemini/自定义确切参数模板保持兼容，授权对话框显示当前名称', async () => {
    const config = configuration()
    const codexConfig = { ...config, preset: 'codex' as const, model: 'synthetic-model', extraArgs: ['--color', 'never'] }
    expect(cliArgumentTemplate(codexConfig))
      .toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '-o', '<PaperFlow 临时输出文件>', '-m', 'synthetic-model', '--color', 'never', '-'])
    expect(cliArgumentTemplate({ ...config, preset: 'gemini', model: 'synthetic-model' })).toEqual(['-m', 'synthetic-model', '--synthetic'])
    const store = memoryStore()
    const confirm = vi.fn(async () => true)
    const auth = new TranslationCliAuthorization(store, confirm)
    await expect(auth.approve(codexConfig, program)).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      args: cliArgumentTemplate(codexConfig, '<Foliopair 临时输出文件>')
    }))
    await expect(new TranslationCliAuthorization(store).requireApproved(codexConfig, program)).resolves.toBeTruthy()
  })
})
