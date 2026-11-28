import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { createTestData, importFixture, launchApp } from './helpers'

test('Zotero 风格分类文件夹：多级创建、定向导入、归类移动、筛选过滤、专属词库配置与删除不删文献', async () => {
  const dataDir = await createTestData()
  let running = await launchApp(dataDir)
  try {
    const { app, page } = running

    // 1. 新建一级分类文件夹（化材模板预填词库）
    await page.getByTestId('folder-create-root-btn').click()
    await page.getByTestId('folder-create-name').fill('电催化与新能源')
    await page.getByTestId('folder-create-template').selectOption('chem-energy')
    await page.getByTestId('folder-create-submit').click()

    const foldersAfterRoot = await page.evaluate(() => window.paperflow.listFolders())
    expect(foldersAfterRoot).toHaveLength(1)
    const rootFolder = foldersAfterRoot[0]
    expect(rootFolder.name).toBe('电催化与新能源')
    await expect(page.getByTestId(`folder-select-${rootFolder.id}`)).toBeVisible()

    // 2. 在该一级分类下新建二级子分类
    await page.getByTestId(`folder-add-child-${rootFolder.id}`).click()
    await page.getByTestId('folder-create-name').fill('析氧反应子课题')
    await page.getByTestId('folder-create-submit').click()

    const foldersAfterChild = await page.evaluate(() => window.paperflow.listFolders())
    const childFolder = foldersAfterChild.find(f => f.parentId === rootFolder.id)!
    expect(childFolder).toBeTruthy()
    await expect(page.getByTestId(`folder-select-${childFolder.id}`)).toBeVisible()

    // 3. 当前选中二级子分类时导入 PDF，文献应自动归属该子分类；在树中可直接看到所属 PDF，下方仅显示当前查看的 1 篇
    await importFixture(app, page, 'same-name-a/paper.pdf')
    await expect(page.locator('.library-tree-doc')).toHaveCount(1)
    await expect(page.locator('[data-testid="current-viewing-section"] .document-entry')).toHaveCount(1)
    const docsAfterFirst = await page.evaluate(() => window.paperflow.listDocuments())
    expect(docsAfterFirst[0].folderId).toBe(childFolder.id)

    await page.getByTestId(`folder-select-${rootFolder.id}`).click()
    await expect(page.locator(`.library-folder-branch:has([data-testid="folder-select-${childFolder.id}"]) .library-tree-doc`)).toHaveCount(1)

    // 4. 在父/子分类的词库弹窗中添加专属一词多义术语并持久化
    await page.getByTestId('active-folder-edit-glossary').click()
    await expect(page.getByTestId('folder-settings-modal')).toBeVisible()
    await page.getByTestId('folder-settings-glossary').fill('ablation => 激光烧蚀\noverpotential => 过电位')
    await page.getByTestId('folder-settings-save').click()
    await expect(page.getByTestId('folder-settings-modal')).toBeHidden()

    // 5. 验证将分类文件夹按真实本地目录树导出（资源管理器中可见对应嵌套文件夹与 PDF）
    const exportBaseDir = await mkdtemp(join(tmpdir(), 'paperflow-e2e-folder-export-'))
    try {
      await app.evaluate(({ dialog }, targetDir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [targetDir] })
      }, exportBaseDir)
      await page.getByTestId('active-folder-export-pdfs').click()
      const exportedPdfPath = join(exportBaseDir, '电催化与新能源', '析氧反应子课题', 'paper.pdf')
      await expect.poll(async () => {
        try {
          const buf = await readFile(exportedPdfPath)
          return buf.subarray(0, 5).toString('utf8')
        } catch {
          return ''
        }
      }).toBe('%PDF-')
      await expect(page.getByText(/已按分类目录导出 1 篇 PDF/)).toBeVisible()
    } finally {
      await rm(exportBaseDir, { recursive: true, force: true })
    }

    // 6. 再创建另一个跨学科分类并导入第 2 篇文献，验证分类隔离过滤
    await page.getByTestId('folder-create-root-btn').click()
    await page.getByTestId('folder-create-name').fill('神经临床医学')
    await page.getByTestId('folder-create-submit').click()
    const bioFolder = (await page.evaluate(() => window.paperflow.listFolders())).find(f => f.name === '神经临床医学')!
    await importFixture(app, page, 'same-name-b/paper.pdf')

    // 切到「神经临床医学」仅在对应分类树节点下见第 2 篇；「全部文献」下树内 2 篇，下方「当前查看」始终只显示 1 篇
    await expect(page.locator('.library-tree-doc')).toHaveCount(2)
    await expect(page.locator('[data-testid="current-viewing-section"] .document-entry')).toHaveCount(1)
    await page.getByTestId('folder-filter-all').click()
    await expect(page.locator('.library-tree-doc')).toHaveCount(2)

    // 6. 使用卡片上的移动按钮将第 1 篇移至「未分类」
    const firstDocId = docsAfterFirst[0].id
    await page.getByTestId(`tree-doc-${firstDocId}`).locator('.library-tree-doc-btn').click()
    await page.locator(`[data-testid="current-viewing-section"] .document-entry:has([data-document-id="${firstDocId}"])`).hover()
    await page.getByTestId(`doc-move-folder-${firstDocId}`).click()
    await page.getByTestId(`move-to-unassigned-${firstDocId}`).click()

    await expect(
      page.locator(`.library-folder-branch:has([data-testid="folder-filter-unassigned"]) .library-tree-doc`)
    ).toHaveCount(1)

    // 7. 删除「神经临床医学」分类：分类移除但其中的第 2 篇 PDF 安全保留并进入「未分类」
    await page.getByTestId(`folder-settings-${bioFolder.id}`).click()
    await page.getByTestId('folder-settings-delete').click()
    await page.getByTestId('folder-settings-confirm-delete').click()
    await expect(page.getByTestId('folder-settings-modal')).toBeHidden()

    await expect(
      page.locator(`.library-folder-branch:has([data-testid="folder-filter-unassigned"]) .library-tree-doc`)
    ).toHaveCount(2)

    // 8. 重启应用后，文件夹树、专属词库和文献归属均保留
    await app.close()
    running = await launchApp(dataDir)
    const persistedFolders = await running.page.evaluate(() => window.paperflow.listFolders())
    const persistedRoot = persistedFolders.find(f => f.id === rootFolder.id)!
    expect(persistedRoot.glossary).toEqual([
      { source: 'ablation', target: '激光烧蚀' },
      { source: 'overpotential', target: '过电位' }
    ])
    await expect(running.page.locator('.library-tree-doc')).toHaveCount(2)
    await expect(running.page.locator('[data-testid="current-viewing-section"] .document-entry')).toHaveCount(1)
  } finally {
    await running.app.close()
  }
})

test('导入本地文件夹、批注同步导出、乱码标题识别、排序与批量整理、阅读器词库闭环与过期重译提示', async () => {
  const dataDir = await createTestData()
  const diskDir = await mkdtemp(join(tmpdir(), 'paperflow-e2e-dir-import-'))
  const exportDir = await mkdtemp(join(tmpdir(), 'paperflow-e2e-notes-export-'))
  const requests: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += String(chunk)
    })
    req.on('end', () => {
      requests.push(body)
      const round = requests.length
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role: string; content: string }>
      }
      const userPrompt = parsed.messages?.[parsed.messages.length - 1]?.content ?? ''
      const arrStart = userPrompt.lastIndexOf('[')
      const blocks = JSON.parse(userPrompt.slice(arrStart)) as Array<{ id: string; text: string }>
      const translations = blocks.map(item => ({
        id: item.id,
        text: `第${round}次译文：${item.text.slice(0, 18)}`
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const running = await launchApp(dataDir)
  try {
    const { app, page } = running

    // 准备一个带目录层级与乱码文件名（带真实 PDF 标题元数据）的本地文件夹
    const messyDoc = await PDFDocument.create()
    messyDoc.setTitle('Efficient Catalysis for Oxygen Evolution')
    const p1 = messyDoc.addPage()
    p1.drawText('Overpotential behavior on catalyst surfaces.', { x: 48, y: 720, size: 12 })
    const messyBytes = new Uint8Array(await messyDoc.save())

    const cleanDoc = await PDFDocument.create()
    const cp1 = cleanDoc.addPage()
    cp1.drawText('Overpotential analysis in acidic electrolyte.', { x: 48, y: 720, size: 12 })
    const cleanBytes = new Uint8Array(await cleanDoc.save())

    await mkdir(join(diskDir, 'CatalysisLab', 'OER'), { recursive: true })
    await mkdir(join(diskDir, 'CatalysisLab', '.hidden'), { recursive: true })
    await writeFile(join(diskDir, 'CatalysisLab', 'OER', '2405.12345.pdf'), messyBytes)
    await writeFile(join(diskDir, 'CatalysisLab', 'alpha-study.pdf'), cleanBytes)
    await writeFile(join(diskDir, 'CatalysisLab', 'broken.pdf'), Buffer.from('not-a-pdf'))
    await writeFile(join(diskDir, 'CatalysisLab', '.hidden', 'ignored.pdf'), cleanBytes)

    // 1. 点击「导入目录」导入 CatalysisLab
    await app.evaluate(({ dialog }, targetDir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [targetDir] })
    }, join(diskDir, 'CatalysisLab'))
    await page.getByTestId('folder-import-dir-btn').click()

    await expect(page.locator('.library-tree-doc')).toHaveCount(2)
    await expect(page.locator('[data-testid="current-viewing-section"] .document-entry')).toHaveCount(1)
    await expect(page.getByTestId('library-floating-toast')).toContainText(/已导入文件夹：新增 2 篇/)

    // 验证「分类文件夹」标题单行展示，浮动提示关闭不改变树高度，且双篇对照时树列表仍保持充足高度 (>=180px)
    const beforeCloseMetrics = await page.evaluate(() => {
      const toggle = document.querySelector('.library-folder-tree__toggle')?.getBoundingClientRect()
      const treeList = document.querySelector('.library-folder-tree__list')?.getBoundingClientRect()
      const tree = document.querySelector('.library-folder-tree')?.getBoundingClientRect()
      const current = document.querySelector('[data-testid="current-viewing-section"]')?.getBoundingClientRect()
      return {
        toggleHeight: toggle?.height ?? 999,
        treeListHeight: treeList?.height ?? 0,
        treeHeight: tree?.height ?? 0,
        currentHeight: current?.height ?? 999
      }
    })
    expect(beforeCloseMetrics.toggleHeight).toBeLessThanOrEqual(28)
    expect(beforeCloseMetrics.treeHeight).toBeGreaterThan(beforeCloseMetrics.currentHeight)
    expect(beforeCloseMetrics.treeListHeight).toBeGreaterThanOrEqual(180)

    await page.getByTestId('library-toast-close').click()
    await expect(page.getByTestId('library-floating-toast')).toHaveCount(0)
    const afterCloseTreeHeight = await page.evaluate(
      () => document.querySelector('.library-folder-tree')?.getBoundingClientRect().height ?? 0
    )
    expect(Math.abs(afterCloseTreeHeight - beforeCloseMetrics.treeHeight)).toBeLessThanOrEqual(1.5)

    // 通过浮层筛选选择标题排序并打开 2405.12345.pdf，验证自动识别标题
    await page.getByTestId('library-filter-toggle').click()
    await page.getByTestId('library-sort-select').selectOption('title-asc')
    await page.getByTestId('library-filter-toggle').click()
    const messyItem = page.locator('[data-tree-document-id]', { hasText: /2405\.12345|Efficient Catalysis/ }).first()
    const messyDocId = (await messyItem.getAttribute('data-tree-document-id'))!
    const alphaItem = page.locator('[data-tree-document-id]', { hasText: /alpha-study/ }).first()
    const alphaDocId = (await alphaItem.getAttribute('data-tree-document-id'))!
    await messyItem.locator('.library-tree-doc-btn').click()
    await expect.poll(async () => {
      const docs = await page.evaluate(() => window.paperflow.listDocuments())
      return docs.find(d => d.id === messyDocId)?.displayTitle
    }).toBe('Efficient Catalysis for Oxygen Evolution')

    // 验证多开标签页与两篇 PDF 同屏并排对照，且文件夹列表仍保持充足高度；折叠底部「当前查看」后树高进一步增大
    await page.getByTestId('pdf-tab-strip').waitFor({ state: 'visible' })
    await page.getByTestId(`tree-doc-${alphaDocId}`).hover()

    // 校验激活行与悬停行内各控件水平零重叠且保留清晰标题宽度
    const treeRowGeometry = await page.evaluate(
      ({ activeId, hoveredId }) => {
        const measureRow = (id: string) => {
          const row = document.querySelector<HTMLElement>(`[data-testid="tree-doc-${id}"]`)!
          const btn = row.querySelector<HTMLElement>('.library-tree-doc-btn')!
          const title = row.querySelector<HTMLElement>('.library-tree-doc-title')!
          const meta = row.querySelector<HTMLElement>('.library-tree-doc-meta')
          const actions = row.querySelector<HTMLElement>('.library-tree-doc-actions')!
          const status = row.querySelector<HTMLElement>('.library-status-pill')!
          return {
            titleWidth: title.getBoundingClientRect().width,
            btnRect: btn.getBoundingClientRect(),
            metaDisplay: meta ? getComputedStyle(meta).display : null,
            metaRect: meta ? meta.getBoundingClientRect() : null,
            actionsDisplay: getComputedStyle(actions).display,
            actionsRect: actions.getBoundingClientRect(),
            statusRect: status.getBoundingClientRect()
          }
        }
        return {
          active: measureRow(activeId),
          hovered: measureRow(hoveredId)
        }
      },
      { activeId: messyDocId, hoveredId: alphaDocId }
    )
    expect(treeRowGeometry.active.titleWidth).toBeGreaterThan(20)
    expect(treeRowGeometry.active.metaDisplay).not.toBe('none')
    expect(treeRowGeometry.active.metaRect!.width).toBeGreaterThan(0)
    expect(treeRowGeometry.active.actionsDisplay).toBe('none')
    expect(treeRowGeometry.active.btnRect.right).toBeLessThanOrEqual(treeRowGeometry.active.metaRect!.left + 0.5)
    expect(treeRowGeometry.active.metaRect!.right).toBeLessThanOrEqual(treeRowGeometry.active.statusRect.left + 0.5)

    expect(treeRowGeometry.hovered.titleWidth).toBeGreaterThan(20)
    expect(treeRowGeometry.hovered.actionsDisplay).not.toBe('none')
    expect(treeRowGeometry.hovered.actionsRect.width).toBeGreaterThan(0)
    expect(treeRowGeometry.hovered.btnRect.right).toBeLessThanOrEqual(treeRowGeometry.hovered.actionsRect.left + 0.5)
    expect(treeRowGeometry.hovered.actionsRect.right).toBeLessThanOrEqual(treeRowGeometry.hovered.statusRect.left + 0.5)

    await page.getByTestId(`tree-doc-split-${alphaDocId}`).click()
    await expect(page.getByTestId('split-pane-primary')).toBeVisible()
    await expect(page.getByTestId('split-pane-secondary')).toBeVisible()
    await expect(page.getByTestId('split-pane-primary').locator('.pdf-page[data-page-number="1"]')).toHaveAttribute(
      'data-rendered',
      'true',
      { timeout: 30000 }
    )
    await expect(page.getByTestId('split-pane-secondary').locator('.pdf-page[data-page-number="1"]')).toHaveAttribute(
      'data-rendered',
      'true',
      { timeout: 30000 }
    )
    await expect(page.locator('[data-testid="current-viewing-section"] .document-entry')).toHaveCount(2)
    await expect(page.getByTestId('current-viewing-section')).toContainText('左栏')
    await expect(page.getByTestId('current-viewing-section')).toContainText('右栏')

    const compareTreeListHeight = await page.evaluate(
      () => document.querySelector('.library-folder-tree__list')?.getBoundingClientRect().height ?? 0
    )
    expect(compareTreeListHeight).toBeGreaterThanOrEqual(180)

    await page.getByTestId('current-viewing-toggle').click()
    const collapsedTreeListHeight = await page.evaluate(
      () => document.querySelector('.library-folder-tree__list')?.getBoundingClientRect().height ?? 0
    )
    expect(collapsedTreeListHeight).toBeGreaterThan(compareTreeListHeight)
    await page.getByTestId('current-viewing-toggle').click()

    // 退出双篇对照，恢复「当前查看」仅 1 篇并继续验证词库闭环
    await page.getByTestId('close-secondary-pane-btn').click()
    await expect(page.getByTestId('split-pane-secondary')).toHaveCount(0)
    await expect(page.locator('[data-testid="current-viewing-section"] .document-entry')).toHaveCount(1)

    // 2. 批量整理（从筛选浮层开启 -> 自动展开树内批量操作 bar）：多选全部文献，统一打上 #精选 标签
    await page.getByTestId('library-filter-toggle').click()
    await page.getByTestId('library-batch-toggle').click()
    await expect(page.getByTestId('library-batch-bar')).toBeVisible()
    await page.getByTestId('library-batch-select-all').click()
    await page.getByTestId('library-batch-tag-input').fill('精选')
    await page.getByTestId('library-batch-tag-btn').click()
    await expect.poll(async () => {
      const docs = await page.evaluate(() => window.paperflow.listDocuments())
      return docs.every(d => d.tags.includes('精选'))
    }).toBe(true)
    await page.getByTestId('library-batch-bar').getByRole('button', { name: '退出', exact: true }).click()

    // 3. 阅读器顶部活跃词库胶囊可见，点击可直达所属分类词库弹窗
    const scopePill = page.getByTestId('reader-glossary-scope-btn')
    await expect(scopePill).toBeVisible()
    await expect(scopePill).toContainText('词库：OER')
    await scopePill.click()
    await expect(page.getByTestId('folder-settings-modal')).toBeVisible()
    await page.getByRole('button', { name: '关闭分类设置' }).click()
    await expect(page.getByTestId('folder-settings-modal')).toBeHidden()

    // 4. 创建一条批注后通过「⋯」菜单导出全部分类目录（默认附带批注 .md）
    await page.evaluate(async docId => {
      await window.paperflow.createAnnotation({
        documentId: docId,
        pageNumber: 1,
        color: 'yellow',
        quoteText: 'Overpotential behavior on catalyst surfaces.',
        note: '测试导出同步生成 Markdown 批注',
        rects: [{ x: 48, y: 700, width: 180, height: 14 }],
        sentenceIds: ['s1']
      })
    }, messyDocId)

    await app.evaluate(({ dialog }, targetDir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [targetDir] })
    }, exportDir)
    await page.getByTestId('library-more-menu-btn').click()
    await page.getByTestId('folder-export-all-btn').click()
    await expect(page.getByTestId('library-floating-toast')).toContainText(/1 份批注 \(\.md\)/)
    const dateTag = new Date().toISOString().slice(0, 10)
    const exportedNoteFile = join(
      exportDir,
      `Foliopair-分类文献-${dateTag}`,
      'CatalysisLab',
      'OER',
      'Efficient Catalysis for Oxygen Evolution-批注.md'
    )
    const exportedNoteMd = await readFile(exportedNoteFile, 'utf8')
    expect(exportedNoteMd).toContain('测试导出同步生成 Markdown 批注')
    await expect(page.getByTestId('library-floating-toast')).toHaveCount(0, { timeout: 6500 })

    // 5. 配置本地测试翻译服务，先译第 1 页；再选中句块触发「+ 记术语」写入分类词库，验证「过期重译」横幅并一键重译
    await page.evaluate(async serverPort => {
      await window.paperflow.saveTranslationSettings({
        provider: 'openai-compatible',
        targetLanguage: 'zh-CN',
        glossary: [],
        openai: {
          baseUrl: `http://127.0.0.1:${serverPort}/v1`,
          model: 'mock-model',
          apiKey: 'sk-test-1234'
        },
        cli: { preset: 'codex', command: 'codex', model: '', extraArgs: [], timeoutSec: 30 }
      })
    }, port)

    // 先对文档页块执行一次基于当前作用域的缓存翻译
    await page.getByRole('group', { name: '视图模式', exact: true }).getByRole('button', { name: '双栏', exact: true }).click()
    await expect(page.locator('.pdf-page[data-page-number="1"]')).toHaveAttribute('data-rendered', 'true', {
      timeout: 30000
    })
    await expect(page.locator('.translation-page[data-page-number="1"]')).toHaveAttribute(
      'data-analyzed',
      'true',
      { timeout: 30000 }
    )
    await page.getByRole('button', { name: '翻译本页', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)

    // 通过页面句子点击弹出浮动选区伴侣栏，点击「+ 记术语」保存新词到 OER 分类词库
    const firstSpan = page.locator('.pdf-page[data-page-number="1"] .textLayer span', {
      hasText: /Overpotential/
    }).first()
    await expect(firstSpan).toBeVisible()
    const box = (await firstSpan.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.getByTestId('companion-add-term-btn')).toBeVisible()
    await page.getByTestId('companion-add-term-btn').click()
    await page.getByTestId('companion-term-source').fill('Overpotential')
    await page.getByTestId('companion-term-target').fill('过电位')
    await page.getByTestId('companion-term-save').click()

    // 作用域变更后译文面板应立刻提示过期缓存横幅，点击「按新词库重译本页」发起新翻译请求并携带新词条
    await expect(page.getByTestId('translation-stale-scope-banner')).toBeVisible()
    await page.getByTestId('translation-stale-refresh-btn').click()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1]).toContain('Overpotential => 过电位')
    await expect(page.getByTestId('translation-stale-scope-banner')).toBeHidden()

    // 6. 验证「⋯」菜单中的「重置库」：确认后清空所有文献与分类，但保留已保存的翻译服务设置
    await page.getByTestId('library-more-menu-btn').click()
    await page.getByTestId('library-reset-btn').click()
    await expect(page.getByTestId('library-reset-confirm-bar')).toBeVisible()
    await page.getByTestId('library-reset-confirm').click()
    await expect(page.locator('.library-tree-doc')).toHaveCount(0)
    await expect(page.getByText('文献库为空', { exact: true })).toBeVisible()
    const keptSettings = await page.evaluate(() => window.paperflow.getTranslationSettings())
    expect(keptSettings.openai.model).toBe('mock-model')
  } finally {
    await running.app.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(diskDir, { recursive: true, force: true })
    await rm(exportDir, { recursive: true, force: true })
  }
})
