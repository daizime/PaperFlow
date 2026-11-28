import { BrowserWindow, session } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ExportTranslationPage } from '../../shared/contracts'

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 将已译段落导出为中英对照或纯中文 Markdown 文本。
 */
export function formatTranslationExportMarkdown(
  title: string,
  format: 'bilingual-md' | 'zh-md',
  pages: readonly ExportTranslationPage[]
): string {
  const cleanTitle = title.trim() || 'PaperFlow 论文译文'
  const lines: string[] = [
    `# ${cleanTitle}（${format === 'bilingual-md' ? '中英对照译文' : '中文译文'}）`,
    '',
    `- 导出页数：${pages.length} 页`,
    `- 导出时间：${new Date().toISOString()}`,
    ''
  ]

  if (pages.length === 0) {
    lines.push('暂无可导出的已翻译内容。', '')
    return lines.join('\n')
  }

  for (const page of pages) {
    lines.push(`## 第 ${page.pageNumber} 页`, '')
    for (const block of page.blocks) {
      const translated = block.translatedText?.trim() ?? ''
      if (format === 'zh-md') {
        if (!translated) continue
        if (block.kind === 'heading') {
          lines.push(`### ${translated}`, '')
        } else if (block.kind === 'caption') {
          lines.push(`> ${translated}`, '')
        } else {
          lines.push(translated, '')
        }
      } else {
        const source = block.sourceText.trim()
        if (!source && !translated) continue
        if (source) {
          const quoteLines = source.split(/\r?\n/).map(line => `> ${line}`)
          lines.push(...quoteLines, '')
        }
        if (translated) {
          if (block.kind === 'heading') {
            lines.push(`**${translated}**`, '')
          } else {
            lines.push(translated, '')
          }
        } else {
          lines.push('_（本段尚未翻译）_', '')
        }
      }
    }
  }

  return lines.join('\n')
}

/**
 * 构建自包含的纯中文或中英对照打印 HTML，严密转义全部文本且禁用脚本。
 */
export function buildTranslationExportHtml(
  title: string,
  mode: 'zh-only' | 'bilingual',
  pages: readonly ExportTranslationPage[]
): string {
  const cleanTitle = escapeHtml(title.trim() || 'PaperFlow 论文译文')
  const modeLabel = mode === 'bilingual' ? '中英对照排版导出' : '中文译文排版导出'
  const sectionsHtml = pages
    .map(page => {
      const blocksHtml = page.blocks
        .map(block => {
          const translated = block.translatedText?.trim() ?? ''
          const source = block.sourceText.trim()
          if (mode === 'zh-only' && !translated) return ''
          if (mode === 'bilingual' && !source && !translated) return ''

          const kindClass = `block--${block.kind}`
          if (mode === 'zh-only') {
            return `<div class="block ${kindClass}"><p class="zh">${escapeHtml(translated)}</p></div>`
          }
          return [
            `<div class="block ${kindClass} is-bilingual">`,
            source ? `<div class="en">${escapeHtml(source)}</div>` : '',
            translated
              ? `<div class="zh">${escapeHtml(translated)}</div>`
              : `<div class="zh is-pending">（本段尚未翻译）</div>`,
            '</div>'
          ].join('')
        })
        .filter(Boolean)
        .join('\n')

      return [
        '<section class="page">',
        `<div class="page-head"><span>${cleanTitle}</span><span>第 ${page.pageNumber} 页</span></div>`,
        blocksHtml || '<p class="empty">本页暂无已译段落。</p>',
        '</section>'
      ].join('\n')
    })
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<title>${cleanTitle}</title>
<style>
  @page { size: A4; margin: 14mm 15mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    color: #1a2230;
    background: #ffffff;
    font-family: "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", "Segoe UI", Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.68;
  }
  .doc-cover {
    border-bottom: 1.5px solid #3864b5;
    padding-bottom: 10px;
    margin-bottom: 14px;
  }
  .doc-title {
    margin: 0 0 4px;
    font-size: 15pt;
    font-weight: 700;
    color: #162235;
  }
  .doc-meta {
    font-size: 8.5pt;
    color: #5a6a82;
  }
  .page {
    margin-bottom: 14px;
    page-break-inside: auto;
  }
  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 0;
    margin: 10px 0 8px;
    border-bottom: 1px solid #d9e1ed;
    font-size: 8.5pt;
    color: #5b6b82;
  }
  .block {
    margin: 0 0 8px;
    break-inside: avoid;
  }
  .block--heading .zh {
    font-size: 12pt;
    font-weight: 700;
    color: #162235;
    margin: 10px 0 4px;
    text-align: left;
  }
  .block--caption .zh {
    font-size: 9.2pt;
    color: #3d4d65;
  }
  .zh {
    margin: 0;
    min-width: 0;
    overflow-wrap: break-word;
    white-space: normal;
    text-align: justify;
    text-align-last: left;
  }
  .block.is-bilingual {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    padding: 6px 8px;
    border: 1px solid #e4e9f2;
    border-radius: 4px;
    background: #fcfdff;
  }
  .en {
    font-size: 9pt;
    line-height: 1.52;
    color: #4b5b73;
    min-width: 0;
    overflow-wrap: break-word;
    white-space: pre-wrap;
    text-align: justify;
    text-align-last: left;
  }
  .zh.is-pending {
    color: #8b98ab;
    font-style: italic;
  }
  .empty {
    font-size: 9pt;
    color: #8b98ab;
  }
</style>
</head>
<body>
  <header class="doc-cover">
    <h1 class="doc-title">${cleanTitle}</h1>
    <div class="doc-meta">PaperFlow · ${modeLabel} · 共 ${pages.length} 页</div>
  </header>
  ${sectionsHtml}
</body>
</html>`
}

/**
 * 在隔离沙盒隐藏窗口（禁用 JS）中将排版 HTML 渲染为 A4 PDF Buffer，不依赖任何外部工具或 Python 运行时。
 */
export async function renderTranslationHtmlToPdfBuffer(html: string): Promise<Buffer> {
  const tempDir = mkdtempSync(join(tmpdir(), 'paperflow-pdf-export-'))
  const htmlPath = join(tempDir, 'export.html')
  const allowedUrl = pathToFileURL(htmlPath).href
  const partition = `paperflow-pdf-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const exportSession = session.fromPartition(partition)
  exportSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  exportSession.setPermissionCheckHandler(() => false)
  exportSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.url !== allowedUrl })
  })
  let hiddenWindow: BrowserWindow | null = null

  try {
    writeFileSync(htmlPath, html, 'utf8')
    hiddenWindow = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        webSecurity: true
      }
    })
    hiddenWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    hiddenWindow.webContents.on('will-navigate', event => event.preventDefault())
    hiddenWindow.webContents.on('will-frame-navigate', event => event.preventDefault())
    hiddenWindow.webContents.on('will-attach-webview', event => event.preventDefault())

    await hiddenWindow.loadFile(htmlPath)
    const pdfBuffer = await hiddenWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: {
        top: 0.5,
        bottom: 0.5,
        left: 0.5,
        right: 0.5
      }
    })
    return pdfBuffer
  } finally {
    if (hiddenWindow && !hiddenWindow.isDestroyed()) {
      hiddenWindow.destroy()
    }
    try {
      exportSession.webRequest.onBeforeRequest(null)
    } catch {
      // 忽略清理 webRequest 拦截器错误
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // 忽略清理临时导出目录错误
    }
  }
}
