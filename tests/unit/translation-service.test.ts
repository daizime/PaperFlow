import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { LibraryDatabase } from '../../src/main/services/database'
import {
  buildAcademicPrompt,
  buildExplainPrompt,
  detectLocalAiClients,
  hasAllExpectedFormulaPlaceholders,
  normalizeTranslatedBlockText,
  parseBatchTranslationOutput,
  resolveCliExecutable,
  TranslationService,
  type SafeStorageAdapter
} from '../../src/main/services/translation-service'
import { saveTranslationSettingsSchema } from '../../src/shared/schemas'

let workRoot: string
let dbPath: string

const fakeSafeStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: plain => Buffer.from(`MOCKENC:${plain}`, 'utf8'),
  decryptString: buf => {
    const str = buf.toString('utf8')
    if (!str.startsWith('MOCKENC:')) throw new Error('Invalid ciphertext')
    return str.slice('MOCKENC:'.length)
  }
}

async function authorizeCurrentSyntheticCli(service: TranslationService): Promise<void> {
  const settings = service.getSettings()
  await service.authorizeCliSettings({ provider: 'cli', targetLanguage: settings.targetLanguage,
    openai: { baseUrl: settings.openai.baseUrl, model: settings.openai.model },
    cli: { preset: settings.cli.preset, command: settings.cli.command, model: settings.cli.model,
      extraArgs: settings.cli.extraArgs, timeoutSec: settings.cli.timeoutSec } })
}

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'paperflow-trans-'))
  dbPath = join(workRoot, 'paperflow.sqlite')
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

function insertSampleDocument(db: LibraryDatabase): string {
  const id = randomUUID()
  db.insertDocument({
    id,
    sha256: 'a'.repeat(64),
    originalFilename: 'sample.pdf',
    displayTitle: 'sample',
    storedFilename: `${id}.pdf`,
    byteSize: 1024,
    pageCount: 2,
    importedAt: new Date().toISOString()
  })
  return id
}

describe('SQLite v1 -> v2 无损迁移与缓存级联', () => {
  test('从 user_version=1 老库无损升级到 2，保留原文献与进度并创建翻译缓存表', () => {
    const raw = new Database(dbPath)
    const docId = randomUUID()
    raw.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        original_filename TEXT NOT NULL,
        display_title TEXT NOT NULL,
        stored_filename TEXT NOT NULL UNIQUE,
        byte_size INTEGER NOT NULL,
        page_count INTEGER,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE reader_state (
        document_id TEXT PRIMARY KEY NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        scale REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `)
    raw.prepare(`
      INSERT INTO documents (id, sha256, original_filename, display_title, stored_filename, byte_size, page_count, imported_at)
      VALUES (?, ?, 'legacy.pdf', 'Legacy Paper', ?, 512, 3, ?)
    `).run(docId, 'b'.repeat(64), `${docId}.pdf`, '2026-10-28T00:00:00.000Z')
    raw.prepare(`
      INSERT INTO reader_state (document_id, page_number, scale, updated_at)
      VALUES (?, 2, 1.25, ?)
    `).run(docId, '2026-10-28T00:00:00.000Z')
    raw.close()

    const db = new LibraryDatabase(dbPath)
    try {
      expect(db.listDocuments().map(d => d.displayTitle)).toEqual(['Legacy Paper'])
      expect(db.getReaderState(docId)?.pageNumber).toBe(2)

      db.upsertPageTranslations(docId, 2, 'zh-CN', 'test-sig', [
        { blockId: 'b1', sourceHash: '0123456789abcdef', translatedText: '已迁移缓存译文' }
      ])
      expect(db.getPageTranslations(docId, 2, 'zh-CN')).toHaveLength(1)

      db.deleteDocument(docId)
      const inspect = new Database(dbPath, { readonly: true })
      try {
        expect(inspect.pragma('user_version', { simple: true })).toBe(7)
        expect(inspect.prepare('SELECT COUNT(*) AS cnt FROM translation_cache').get()).toEqual({ cnt: 0 })
        expect(inspect.prepare('SELECT COUNT(*) AS cnt FROM annotations').get()).toEqual({ cnt: 0 })
      } finally {
        inspect.close()
      }
    } finally {
      db.close()
    }
  })
})

describe('TranslationService 双引擎翻译与密钥保护', () => {
  test('OpenAI 兼容模式：safeStorage 加密存 Key、批量翻译、缓存复用、401 错误及主动取消', async () => {
    let requestCount = 0
    let lastAuthHeader = ''
    let forceStatusCode = 200
    let delayMs = 0

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      requestCount += 1
      lastAuthHeader = String(req.headers.authorization || '')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      if (forceStatusCode !== 200) {
        res.statusCode = forceStatusCode
        res.end('invalid key')
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content: string }>
      }
      const userContent = body.messages[body.messages.length - 1]?.content ?? ''
      const arrayStart = userContent.lastIndexOf('[')
      const items = JSON.parse(userContent.slice(arrayStart)) as Array<{ id: string; text: string }>
      const replyJson = JSON.stringify({
        translations: items.map(item => ({ id: item.id, text: `中译：${item.text}` }))
      })
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '```json\n' + replyJson + '\n```' } }]
        })
      )
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const baseUrl = `http://127.0.0.1:${address.port}/v1`

    const db = new LibraryDatabase(dbPath)
    const service = new TranslationService({ database: db, safeStorage: fakeSafeStorage })
    const docId = insertSampleDocument(db)

    try {
      const saved = service.saveSettings({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        openai: { baseUrl, model: 'mock-gpt', apiKey: 'sk-secret-99887766' },
        cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 60 }
      })

      expect(saved.openai.hasApiKey).toBe(true)
      expect(saved.openai.apiKeyPreview).toBe('sk-s***7766')
      expect(JSON.stringify(saved)).not.toContain('sk-secret-99887766')
      // 数据库中密文不应明文存放 API Key
      expect(db.getSetting('translation.openaiApiKey.v1')).toBeNull()
      expect(db.getSetting('translation.openaiCredentials.v2')).toContain('cipher')

      const tested = await service.testConnection()
      expect(tested.ok).toBe(true)
      expect(tested.testedProvider).toBe('openai-compatible')
      expect(tested.testedLabel).toBe('mock-gpt')
      expect(tested.testedTarget).toContain('127.0.0.1')
      expect(tested.sampleOutput).toContain('中译：')
      expect(lastAuthHeader).toBe('Bearer sk-secret-99887766')

      const reqsBefore = requestCount
      const pageRes = await service.translatePage({
        documentId: docId,
        pageNumber: 1,
        blocks: [
          { blockId: 'blk-1', kind: 'heading', sourceText: '1. Introduction', sourceHash: '1111111111111111' },
          { blockId: 'blk-2', kind: 'paragraph', sourceText: 'Hello research.', sourceHash: '2222222222222222' }
        ]
      })
      expect(pageRes.translatedCount).toBe(2)
      expect(pageRes.fromCacheCount).toBe(0)
      expect(requestCount).toBe(reqsBefore + 1)

      // 重复翻译同哈希块走缓存，零网络请求
      const cachedRes = await service.translatePage({
        documentId: docId,
        pageNumber: 1,
        blocks: [
          { blockId: 'blk-1', kind: 'heading', sourceText: '1. Introduction', sourceHash: '1111111111111111' },
          { blockId: 'blk-2', kind: 'paragraph', sourceText: 'Hello research.', sourceHash: '2222222222222222' }
        ]
      })
      expect(cachedRes.fromCacheCount).toBe(2)
      expect(cachedRes.translatedCount).toBe(0)
      expect(requestCount).toBe(reqsBefore + 1)

      // force=true 重新触发翻译
      const forcedRes = await service.translatePage({
        documentId: docId,
        pageNumber: 1,
        force: true,
        blocks: [{ blockId: 'blk-1', kind: 'heading', sourceText: '1. Introduction', sourceHash: '1111111111111111' }]
      })
      expect(forcedRes.translatedCount).toBe(1)

      // 401 错误返回清晰中文说明
      forceStatusCode = 401
      await expect(
        service.translatePage({
          documentId: docId,
          pageNumber: 2,
          blocks: [{ blockId: 'blk-3', kind: 'paragraph', sourceText: 'Retry check.', sourceHash: '3333333333333333' }]
        })
      ).rejects.toThrow('鉴权失败')

      // 验证中断取消正在进行的请求
      forceStatusCode = 200
      delayMs = 5000
      const pending = service.translatePage({
        documentId: docId,
        pageNumber: 2,
        blocks: [{ blockId: 'blk-4', kind: 'paragraph', sourceText: 'Slow request.', sourceHash: '4444444444444444' }]
      })
      setTimeout(() => service.cancel(docId), 40)
      await expect(pending).rejects.toThrow('取消')
    } finally {
      service.cancelAll()
      db.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('CLI 模式：stdin 传参调用本机 Node 桩脚本并支持参数注入拦截', async () => {
    const stubScript = join(workRoot, 'cli-stub.mjs')
    await writeFile(
      stubScript,
      [
        "import { readFileSync } from 'node:fs'",
        "const input = readFileSync(0, 'utf8')",
        "const arrStart = input.lastIndexOf('[')",
        'const items = JSON.parse(input.slice(arrStart))',
        'console.log(JSON.stringify({ translations: items.map(x => ({ id: x.id, text: "CLI译：" + x.text })) }))'
      ].join('\n'),
      'utf8'
    )

    // 确认 Zod 拒绝危险 Shell 元字符注入
    expect(
      saveTranslationSettingsSchema.safeParse({
        provider: 'cli',
        targetLanguage: 'zh-CN',
        openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        cli: { preset: 'codex', command: 'codex && calc', model: '', extraArgs: [], timeoutSec: 60 }
      }).success
    ).toBe(false)

    expect(resolveCliExecutable(process.execPath)).toBeTruthy()

    const db = new LibraryDatabase(dbPath)
    const service = new TranslationService({ database: db, safeStorage: fakeSafeStorage, authorizeCli: async () => true })
    const docId = insertSampleDocument(db)

    try {
      service.saveSettings({
        provider: 'cli',
        targetLanguage: 'zh-CN',
        openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        cli: {
          preset: 'custom',
          command: process.execPath,
          model: '',
          extraArgs: [stubScript],
          timeoutSec: 30
        }
      })

      await authorizeCurrentSyntheticCli(service)
      const testRes = await service.testConnection()
      expect(testRes.ok).toBe(true)
      expect(testRes.testedProvider).toBe('cli')
      expect(testRes.testedLabel).toBe('自定义 CLI')
      expect(testRes.testedTarget).toBe(process.execPath)
      expect(testRes.sampleOutput).toContain('CLI译：')

      const pageRes = await service.translatePage({
        documentId: docId,
        pageNumber: 1,
        blocks: [
          { blockId: 'cli-1', kind: 'paragraph', sourceText: 'Two-column layout.', sourceHash: '5555555555555555' }
        ]
      })
      expect(pageRes.items[0]?.translatedText).toBe('CLI译：Two-column layout.')

      // 切换回 API 保存后，以草稿模式传入 CLI 试连不应修改磁盘已生效的 API 引擎
      service.saveSettings({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        cli: {
          preset: 'custom',
          command: process.execPath,
          model: '',
          extraArgs: [stubScript],
          timeoutSec: 30
        }
      })
      const draftCliTest = await service.testConnection({
        provider: 'cli',
        targetLanguage: 'zh-CN',
        openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        cli: {
          preset: 'custom',
          command: process.execPath,
          model: '',
          extraArgs: [stubScript],
          timeoutSec: 30
        }
      })
      expect(draftCliTest.ok).toBe(true)
      expect(draftCliTest.testedProvider).toBe('cli')
      expect(service.getSettings().provider).toBe('openai-compatible')
    } finally {
      service.cancelAll()
      db.close()
    }
  })

  test('detectLocalAiClients 自动识别 Codex / Gemini 本机客户端状态，支持 gemini 预设调用并安全回退历史 claude 配置', async () => {
    const isWin = process.platform === 'win32'
    const fakeHome = join(workRoot, 'home')
    const fakeLocalAppData = join(workRoot, 'localappdata')
    const fakeAppData = join(workRoot, 'appdata')
    const fakeBin = join(workRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    await mkdir(fakeHome, { recursive: true })
    await mkdir(fakeAppData, { recursive: true })
    await mkdir(join(fakeLocalAppData, 'Google', 'Gemini', 'app-1.0.0'), { recursive: true })

    const argLogStub = join(fakeBin, 'gemini-stub.mjs')
    await writeFile(
      argLogStub,
      [
        "import { readFileSync } from 'node:fs'",
        'const args = process.argv.slice(2)',
        "const input = readFileSync(0, 'utf8')",
        "const arrStart = input.lastIndexOf('[')",
        'const items = JSON.parse(input.slice(arrStart))',
        'const textPrefix = args.includes("-m") ? "GEMINI预设:" : "MISSING:"',
        'console.log(JSON.stringify({ translations: items.map(x => ({ id: x.id, text: textPrefix + args.join(" ") })) }))'
      ].join('\n'),
      'utf8'
    )

    const geminiBin = join(fakeBin, isWin ? 'gemini.cmd' : 'gemini')
    const codexBin = join(fakeBin, isWin ? 'codex.cmd' : 'codex')
    if (isWin) {
      await writeFile(geminiBin, `@echo off\r\n"${process.execPath}" "%~dp0gemini-stub.mjs" %*\r\n`, 'utf8')
      await writeFile(codexBin, '@echo off\r\necho codex-mock\r\n', 'utf8')
      await writeFile(join(fakeLocalAppData, 'Google', 'Gemini', 'app-1.0.0', 'Gemini.exe'), 'mock', 'utf8')
    } else {
      await writeFile(geminiBin, `#!/bin/sh\nexec "${process.execPath}" "${argLogStub}" "$@"\n`, 'utf8')
      await chmod(geminiBin, 0o755)
      await writeFile(codexBin, '#!/bin/sh\necho codex-mock\n', 'utf8')
      await chmod(codexBin, 0o755)
    }

    const fakeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: fakeBin,
      Path: fakeBin,
      ComSpec: process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: fakeAppData,
      LOCALAPPDATA: fakeLocalAppData,
      PAPERFLOW_SKIP_APPX_PROBE: '1',
      PAPERFLOW_SKIP_VERSION_PROBE: '1'
    }

    const detected = await detectLocalAiClients(fakeEnv, { probeVersion: false })
    expect(detected.map(c => c.preset)).toEqual(['codex', 'gemini'])
    expect(detected.find(c => c.preset === 'codex')).toMatchObject({
      status: 'ready',
      command: codexBin
    })
    expect(detected.find(c => c.preset === 'gemini')).toMatchObject({
      status: 'ready',
      command: geminiBin
    })

    const emptyEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: join(workRoot, 'none'),
      Path: join(workRoot, 'none'),
      HOME: join(workRoot, 'none-home'),
      USERPROFILE: join(workRoot, 'none-home'),
      APPDATA: join(workRoot, 'none-appdata'),
      LOCALAPPDATA: join(workRoot, 'none-local'),
      PAPERFLOW_SKIP_APPX_PROBE: '1',
      PAPERFLOW_SKIP_VERSION_PROBE: '1'
    }
    const noneDetected = await detectLocalAiClients(emptyEnv, { probeVersion: false })
    expect(noneDetected.every(c => c.status === 'not-found')).toBe(true)

    const guiEnv: NodeJS.ProcessEnv = {
      ...emptyEnv,
      LOCALAPPDATA: fakeLocalAppData
    }
    if (isWin) {
      const guiDetected = await detectLocalAiClients(guiEnv, { probeVersion: false })
      expect(guiDetected.find(c => c.preset === 'gemini')).toMatchObject({
        status: 'gui-only',
        command: null
      })
    }

    const db = new LibraryDatabase(dbPath)
    const service = new TranslationService({ database: db, safeStorage: fakeSafeStorage, env: fakeEnv, authorizeCli: async () => true })
    const docId = insertSampleDocument(db)
    try {
      db.setSetting(
        'translation.config.v1',
        JSON.stringify({
          provider: 'cli',
          targetLanguage: 'zh-CN',
          glossary: [],
          openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
          cli: { preset: 'claude', command: 'claude', model: '', extraArgs: [], timeoutSec: 30 }
        })
      )
      expect(service.getSettings().cli.preset).toBe('codex')

      service.saveSettings({
        provider: 'cli',
        targetLanguage: 'zh-CN',
        openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        cli: {
          preset: 'gemini',
          command: 'gemini',
          model: 'gemini-2.5-flash-test',
          extraArgs: [],
          timeoutSec: 30
        }
      })
      await authorizeCurrentSyntheticCli(service)
      const pageRes = await service.translatePage({
        documentId: docId,
        pageNumber: 1,
        blocks: [
          { blockId: 'gm-1', kind: 'paragraph', sourceText: 'Gemini preset test.', sourceHash: '6666666666666666' }
        ]
      })
      expect(pageRes.items[0]?.translatedText).toContain('GEMINI预设:-m gemini-2.5-flash-test')
    } finally {
      service.cancelAll()
      db.close()
    }
  })

  test('parseBatchTranslationOutput 兼容 Markdown 围栏、纯数组和单块回退并安全规整换行', () => {
    const blocks = [{ blockId: 'a1', kind: 'paragraph' as const, sourceText: 'Hi', sourceHash: '0123456789abcdef' }]
    expect(parseBatchTranslationOutput('```json\n{"translations":[{"id":"a1","text":"你好"}]}\n```', blocks).get('a1')).toBe('你好')
    expect(parseBatchTranslationOutput('你好世界', blocks).get('a1')).toBe('你好世界')
    expect(
      parseBatchTranslationOutput(
        JSON.stringify({
          translations: [
            {
              id: 'a1',
              text: '单元组更新 δS 在\n\nO(1) 时间内保持 ⊗ 算符不变 [44]。\r\n下一句继续。'
            }
          ]
        }),
        blocks
      ).get('a1')
    ).toBe('单元组更新 δS 在 O(1) 时间内保持 ⊗ 算符不变 [44]。下一句继续。')
    expect(normalizeTranslatedBlockText('第一行\n\n第二行  结束')).toBe('第一行第二行 结束')
  })

  test('buildAcademicPrompt 明确不遗漏、保留公式符号与英文专有名词、1:1 句边界与无换行纯文本约束', () => {
    const prompt = buildAcademicPrompt('zh-CN', [
      {
        blockId: 'blk-formula-inline',
        kind: 'paragraph',
        sourceText: 'Compute δV_R in O(1) time [44].',
        sourceHash: '0123456789abcdef'
      }
    ])
    expect(prompt).toContain('绝不遗漏')
    expect(prompt).toContain('完整保留公式与符号原貌')
    expect(prompt).toContain('保留专有英文名词不译')
    expect(prompt).toContain('ScaleStore')
    expect(prompt).toContain('DRAM、NVMe、SSD、RDMA')
    expect(prompt).toContain('μs、GB/s')
    expect(prompt).toContain('⟪M1⟫')
    expect(prompt).toContain('保持与原文块一致的自然句数量与句末标点边界')
    expect(prompt).toContain('禁止在块内插入多余换行符、空行或 Markdown 标记')
    const jsonTail = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as Array<{ id: string; text: string }>
    expect(jsonTail).toEqual([{ id: 'blk-formula-inline', kind: 'paragraph', text: 'Compute δV_R in O(1) time [44].' }])
    expect(hasAllExpectedFormulaPlaceholders('Use ⟪M1⟫ and ⟪M2⟫ here.', '在此使用 ⟪M1⟫ 与 ⟪M2⟫。')).toBe(true)
    expect(hasAllExpectedFormulaPlaceholders('Use ⟪M1⟫ and ⟪M2⟫ here.', '在此仅使用 ⟪M1⟫。')).toBe(false)

    const selectionTranslatePrompt = buildExplainPrompt(
      { pageNumber: 1, mode: 'translate', selectedText: 'ScaleStore uses RDMA with 5.0 μs latency.' },
      'zh-CN'
    )
    expect(selectionTranslatePrompt).toContain('英文专有名词一律保留英文原文不译')
    expect(selectionTranslatePrompt).toContain('μs、GB/s')
  })

  test('TranslationService 对批量响应中丢失 ⟪M#⟫ 占位符的块自动单块重试，仅完整结果落库', async () => {
    let callCount = 0
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      callCount += 1
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content: string }>
      }
      const userContent = body.messages[body.messages.length - 1]?.content ?? ''
      const items = JSON.parse(userContent.slice(userContent.lastIndexOf('\n') + 1)) as Array<{ id: string; text: string }>
      const translations = items.map(item => {
        if (callCount === 1 && item.id === 'blk-drop') {
          return { id: item.id, text: '此处漏掉了占位符的批量译文。' }
        }
        return {
          id: item.id,
          text: item.id === 'blk-drop' ? '计算 ⟪M1⟫ 只需 ⟪M2⟫。' : callCount === 1 ? '缺失公式。' : '稳健重试 ⟪M1⟫。'
        }
      })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }))
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const db = new LibraryDatabase(dbPath)
    const service = new TranslationService({ database: db, safeStorage: fakeSafeStorage })
    const docId = insertSampleDocument(db)

    try {
      service.saveSettings({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'mock-gpt', apiKey: 'sk-test-1234' },
        cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 60 }
      })

      const res = await service.translatePage({
        documentId: docId,
        pageNumber: 9,
        blocks: [
          { blockId: 'blk-drop', kind: 'paragraph', sourceText: 'Compute ⟪M1⟫ in ⟪M2⟫.', sourceHash: '1111111111111111' },
          { blockId: 'blk-fallback', kind: 'paragraph', sourceText: 'Fallback keeps ⟪M1⟫.', sourceHash: '2222222222222222' }
        ]
      })
      // 第 1 次批量响应丢失了占位符，触发了 2 次单块重试（共 3 次请求），其中 blk-drop 被成功恢复
      expect(callCount).toBe(3)
      expect(res.items.find(i => i.blockId === 'blk-drop')?.translatedText).toBe('计算 ⟪M1⟫ 只需 ⟪M2⟫。')
      expect(res.items.find(i => i.blockId === 'blk-fallback')?.translatedText).toBe('稳健重试 ⟪M1⟫。')
    } finally {
      service.cancelAll()
      db.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('TranslationService.chat 支持多篇对照上下文、多轮历史透传与 SQLite 对话持久化和清空', async () => {
    const receivedPayloads: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content: string }>
      }
      receivedPayloads.push(body)
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          choices: [{ message: { content: `第 ${receivedPayloads.length} 轮回答：已综合左/右两篇对比。` } }]
        })
      )
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const db = new LibraryDatabase(dbPath)
    const service = new TranslationService({ database: db, safeStorage: fakeSafeStorage })
    const docId = insertSampleDocument(db)

    try {
      service.saveSettings({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        glossary: [{ source: 'overpotential', target: '过电位' }],
        openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'mock-chat', apiKey: 'sk-chat-test' },
        cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 60 }
      })

      const sessionKey = `doc:${docId}`
      const first = await service.chat({
        sessionKey,
        question: '对比这两篇实验设计差异？',
        scope: 'all-open',
        quoteText: 'Low overpotential was measured.',
        contexts: [
          { documentId: docId, title: 'Paper A', paneLabel: '左栏', pageNumber: 1, excerpt: 'Method A' },
          { documentId: docId, title: 'Paper B', paneLabel: '右栏', pageNumber: 3, excerpt: 'Method B' }
        ]
      })
      expect(first.userMessage.content).toBe('对比这两篇实验设计差异？')
      expect(first.assistantMessage.content).toContain('第 1 轮回答')
      expect(receivedPayloads[0].messages[0].content).toContain('overpotential => 过电位')
      expect(receivedPayloads[0].messages[1].content).toContain('[左栏] Paper A (P.1)')
      expect(receivedPayloads[0].messages[1].content).toContain('[右栏] Paper B (P.3)')

      // 第二轮应自动附带第一轮历史消息
      await service.chat({
        sessionKey,
        question: '进一步总结优缺点',
        scope: 'active',
        contexts: [{ documentId: docId, title: 'Paper A', pageNumber: 1 }]
      })
      expect(receivedPayloads[1].messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])

      expect(db.listChatMessages(sessionKey)).toHaveLength(4)
      db.clearChatMessages(sessionKey)
      expect(db.listChatMessages(sessionKey)).toHaveLength(0)

      await service.chat({ sessionKey, question: '重建一条记录', scope: 'free', contexts: [] })
      expect(db.listChatMessages(sessionKey)).toHaveLength(2)
      db.resetLibrary()
      expect(db.listChatMessages(sessionKey)).toHaveLength(0)
    } finally {
      service.cancelAll()
      db.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
