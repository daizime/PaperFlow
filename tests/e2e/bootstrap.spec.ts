import { test, expect } from '@playwright/test'
import { createTestData, launchApp } from './helpers'
test('T01 真实桌面启动、安全隔离与导航阻止', async () => {
  const { app, page } = await launchApp(await createTestData())
  try {
    await expect(page.getByText('Foliopair', { exact: true })).toBeVisible()
    await expect(page.getByText('尚未翻译', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => typeof (globalThis as Record<string, unknown>).require)).toBe('undefined')
    expect(await page.evaluate(() => Object.keys(window.paperflow).sort())).toEqual([
      'cancelAiChat',
      'cancelTranslation',
      'clearChatMessages',
      'clearDocumentTranslations',
      'copyImageDataUrl',
      'copyText',
      'createAnnotation',
      'createFolder',
      'deleteAnnotation',
      'deleteCustomAiSkill',
      'deleteDocument',
      'deleteFolder',
      'detectLocalAiClients',
      'enrichCitationMetadata',
      'explainSelection',
      'exportAnnotationsMarkdown',
      'exportBackup',
      'exportFolderBibtex',
      'exportFolderPdfs',
      'exportMarkdownContent',
      'exportSlideDeckPptx',
      'exportTranslationDocument',
      'getDocumentTranslationScope',
      'getPageTranslations',
      'getProviderBalance',
      'getReaderState',
      'getResearchProfile',
      'getTranslationSettings',
      'getUsageSummary',
      'importBackup',
      'importFolder',
      'importLiteraturePdf',
      'importPdf',
      'importPdfBytes',
      'listAnnotations',
      'listChatMessages',
      'listCustomAiSkills',
      'listDocumentTranslations',
      'listDocuments',
      'listFolders',
      'listReaderProgress',
      'onAiChatStream',
      'onTranslationProgress',
      'openExternalUrl',
      'pickCliExecutable',
      'readPdfBytes',
      'renameDocument',
      'resetLibrary',
      'resetUsageStats',
      'runAiSkill',
      'saveCustomAiSkill',
      'saveReaderState',
      'saveResearchProfile',
      'saveTranslationSettings',
      'saveUsagePreferences',
      'searchLibrary',
      'searchLiterature',
      'sendChatMessage',
      'summarizeLiteratureAbstract',
      'testTranslationConnection',
      'translatePage',
      'updateAnnotation',
      'updateBlockTranslation',
      'updateDocumentMeta',
      'updateFolder',
      'updatePageCount'
    ])
    const preferences = await app.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0].webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences())
    expect(preferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true })
    await page.evaluate(() => { window.open('https://example.com'); window.location.href = 'https://example.com' })
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe('app://bundle/index.html')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('document.body.innerText'))).toContain('尚未翻译')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  } finally { await app.close() }
})
