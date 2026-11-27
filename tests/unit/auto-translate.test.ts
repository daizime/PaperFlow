import { describe, expect, test } from 'vitest'
import type { DetectedLocalAiClient, TranslationSettings } from '../../src/shared/contracts'
import {
  classifyPdfLanguageFromText,
  isTranslationEngineConfigured,
  loadStoredDocViewModes,
  resolveDocumentViewMode
} from '../../src/renderer/src/features/translation/auto-translate'

function makeSettings(overrides: Partial<TranslationSettings> = {}): TranslationSettings {
  return {
    provider: 'openai-compatible',
    targetLanguage: 'zh-CN',
    glossary: [],
    openai: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      hasApiKey: false,
      apiKeyPreview: null
    },
    cli: {
      preset: 'codex',
      command: 'codex',
      model: '',
      extraArgs: [],
      timeoutSec: 120
    },
    ...overrides
  }
}

describe('auto-translate: PDF 语言识别、引擎配置检查与分文献视图模式恢复（合成素材）', () => {
  test('classifyPdfLanguageFromText accurately separates Chinese papers from English, Japanese, Korean, and empty pages', () => {
    // 1. 纯中文及夹杂英文缩写的中文论文（合成素材）
    expect(
      classifyPdfLanguageFromText(
        '基于 NVMe 与 RDMA 网络的高性能分布式存储引擎架构设计。本文分析了 DRAM 内存容量墙问题，并在 OLTP 负载下评估系统吞吐与尾延迟表现。'
      )
    ).toBe('chinese')

    // 2. 纯中文短封面标题（合成素材）
    expect(classifyPdfLanguageFromText('计算机科学与技术学院研究生培养方案')).toBe('chinese')

    // 3. 含中文作者/单位注释或零星汉字引用的英文论文仍归为 non-chinese（合成素材）
    expect(
      classifyPdfLanguageFromText(
        'ScaleStore: A Fast and Cost-Efficient Storage Engine using DRAM, NVMe, and RDMA. ' +
          'Modern data-intensive workloads exceed single-node DRAM capacities while demanding microsecond latency. ' +
          'We evaluate in-memory DBMS architectures across multiple nodes over InfiniBand networks. ' +
          'Correspondence: 张伟 (Tsinghua University). References include baseline storage systems.'
      )
    ).toBe('non-chinese')

    // 4. 日文与韩文包含汉字或独立音节文字时不应误判为中文（合成素材）
    expect(
      classifyPdfLanguageFromText(
        '本稿では分散ストレージシステムにおけるメモリ管理とネットワーク最適化の手法について述べる。'
      )
    ).toBe('non-chinese')
    expect(
      classifyPdfLanguageFromText(
        '이 논문에서는 분산 저장 시스템의 메모리 관리와 네트워크 최적화 기법을 제안하고 실험을 통해 성능을 검증한다.'
      )
    ).toBe('non-chinese')

    // 5. 空白或纯数字扫描页返回 insufficient（合成素材）
    expect(classifyPdfLanguageFromText('   12345 - 2026   ')).toBe('insufficient')
    expect(classifyPdfLanguageFromText('')).toBe('insufficient')
  })

  test('isTranslationEngineConfigured validates API keys, Ollama local endpoints, and CLI availability', () => {
    expect(isTranslationEngineConfigured(null)).toBe(false)
    expect(isTranslationEngineConfigured(makeSettings())).toBe(false)

    expect(
      isTranslationEngineConfigured(
        makeSettings({
          openai: {
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            hasApiKey: true,
            apiKeyPreview: 'sk-t***1234'
          }
        })
      )
    ).toBe(true)

    expect(
      isTranslationEngineConfigured(
        makeSettings({
          openai: {
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'qwen2.5:7b',
            hasApiKey: false,
            apiKeyPreview: null
          }
        })
      )
    ).toBe(true)

    const unavailableCodex: DetectedLocalAiClient[] = [
      {
        preset: 'codex',
        name: 'Codex CLI',
        status: 'not-found',
        command: null,
        source: null,
        version: null,
        hint: '未检测到可执行的 CLI'
      }
    ]
    const availableCodex: DetectedLocalAiClient[] = [
      {
        preset: 'codex',
        name: 'Codex CLI',
        status: 'ready',
        command: 'C:\\tools\\codex.cmd',
        source: 'PATH',
        version: '0.1.0',
        hint: '已就绪'
      }
    ]

    const unapprovedCli = makeSettings({ provider: 'cli' })
    expect(isTranslationEngineConfigured(unapprovedCli, availableCodex)).toBe(false)
    const cliSettings = { ...unapprovedCli, cli: { ...unapprovedCli.cli, authorized: true } }
    expect(isTranslationEngineConfigured(cliSettings, unavailableCodex)).toBe(false)
    expect(isTranslationEngineConfigured(cliSettings, availableCodex)).toBe(true)

    expect(
      isTranslationEngineConfigured(
        makeSettings({
          provider: 'cli',
          cli: {
            preset: 'custom',
            command: '/tmp/custom-cli.js',
            authorized: true,
            model: '',
            extraArgs: [],
            timeoutSec: 120
          }
        })
      )
    ).toBe(true)

    expect(
      isTranslationEngineConfigured(
        makeSettings({
          provider: 'cli',
          cli: {
            preset: 'custom',
            command: '   ',
            model: '',
            extraArgs: [],
            timeoutSec: 120
          }
        })
      )
    ).toBe(false)
  })

  test('loadStoredDocViewModes & resolveDocumentViewMode default to source and restore dual/translation per document', () => {
    const mockStorage = {
      getItem: (key: string): string | null =>
        key === 'paperflow:doc-view-modes'
          ? JSON.stringify({
              'doc-1': 'dual',
              'doc-2': 'translation',
              'doc-bad': 'invalid-mode'
            })
          : null
    }
    const map = loadStoredDocViewModes(mockStorage, 'paperflow:doc-view-modes')
    expect(map).toEqual({ 'doc-1': 'dual', 'doc-2': 'translation' })
    expect(resolveDocumentViewMode(map, 'doc-1')).toBe('dual')
    expect(resolveDocumentViewMode(map, 'doc-2')).toBe('translation')
    expect(resolveDocumentViewMode(map, 'doc-new')).toBe('source')
    expect(resolveDocumentViewMode(map, null)).toBe('source')

    const corruptStorage = { getItem: (): string => '{not-json' }
    expect(loadStoredDocViewModes(corruptStorage, 'paperflow:doc-view-modes')).toEqual({})
  })
})
