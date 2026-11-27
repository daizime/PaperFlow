import { test, expect } from '@playwright/test'
import { createTestData, launchApp } from './helpers'

test('首次启动直选全学科向导（化学/材料 + 自定义课题），持久化、词库合并与重启后不重复弹窗', async () => {
  const dataDir = await createTestData()

  // 1. 首次启动应自动弹出方案 B 居中引导弹窗
  const firstRun = await launchApp(dataDir, { keepOnboardingOpen: true })
  try {
    const { page } = firstRun
    const modal = page.getByTestId('onboarding-modal')
    await expect(modal).toBeVisible()

    // 未选细分方向前（预置词条为 0），不应显示术语导入选项
    await expect(page.getByTestId('onboarding-glossary-option')).toBeHidden()

    // 切换到「化学、材料与能源环境」并选择「催化科学、电化学与新能源」+ 输入自定义课题
    await page.getByTestId('faculty-pill-chem-mat').click()
    await page.getByTestId('track-card-chem-energy').click()
    await expect(page.getByTestId('onboarding-glossary-option')).toBeVisible()
    await expect(page.getByTestId('onboarding-glossary-preview')).toContainText('overpotential → 过电位')
    await page.getByTestId('onboarding-custom-topic').fill('钙钛矿太阳能电池')

    await page.getByTestId('onboarding-submit').click()
    await expect(modal).toBeHidden()

    // 顶部按钮显示当前方向，空文献库展示预设标签
    await expect(page.getByTestId('open-onboarding-btn')).toContainText('化材环 · 钙钛矿太阳能电池')
    const tagBox = page.getByTestId('library-recommended-tags')
    await expect(tagBox).toBeVisible()
    await expect(tagBox).toContainText('#钙钛矿太阳能电池')
    await expect(tagBox).toContainText('#电催化')

    // 验证 IPC 持久化的科研画像、自动创建的学科分类文件夹，以及不污染全局术语表
    const storedProfile = await page.evaluate(() => window.paperflow.getResearchProfile())
    expect(storedProfile).toMatchObject({
      completed: true,
      mode: 'direct',
      facultyId: 'chem-mat',
      selectedTrackIds: ['chem-energy'],
      customTopic: '钙钛矿太阳能电池'
    })
    const folders = await page.evaluate(() => window.paperflow.listFolders())
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toBe('钙钛矿太阳能电池')
    expect(folders[0].glossary.some(item => item.source === 'overpotential')).toBe(true)

    // 侧边栏 Zotero 分类树立即出现刚创建的学科分类文件夹
    await expect(page.getByTestId(`folder-select-${folders[0].id}`)).toContainText('钙钛矿太阳能电池')

    const settings = await page.evaluate(() => window.paperflow.getTranslationSettings())
    expect(settings.glossary).toEqual([])
  } finally {
    await firstRun.app.close()
  }

  // 2. 使用同一数据目录二次启动：不应再次弹出向导，点击顶部按钮可重新编辑
  const secondRun = await launchApp(dataDir, { keepOnboardingOpen: true })
  try {
    const { page } = secondRun
    await expect(page.getByTestId('onboarding-modal')).toBeHidden()
    await expect(page.getByTestId('open-onboarding-btn')).toContainText('化材环 · 钙钛矿太阳能电池')

    await page.getByTestId('open-onboarding-btn').click()
    await expect(page.getByTestId('onboarding-modal')).toBeVisible()
    await expect(page.getByTestId('onboarding-custom-topic')).toHaveValue('钙钛矿太阳能电池')
  } finally {
    await secondRun.app.close()
  }
})

test('研一新生 3 步引导梳理模式（生命科学与医学 + 实验观测 + 方法复现）', async () => {
  const { app, page } = await launchApp(await createTestData(), { keepOnboardingOpen: true })
  try {
    const modal = page.getByTestId('onboarding-modal')
    await expect(modal).toBeVisible()

    // 切换到 B. 帮我从零梳理研究方向
    await page.getByTestId('onboarding-mode-guided').click()

    // 第 1 步和第 2 步期间不展示术语导入干扰项
    await expect(page.getByTestId('onboarding-glossary-option')).toBeHidden()
    await page.getByTestId('faculty-pill-bio-med').click()
    await page.getByTestId('onboarding-guided-topic').fill('CRISPR 调控')
    await page.getByTestId('onboarding-next').click()

    // 第 2 步：选通用科研范式「实验观测与表征」与阅读目标「精读方法与复现」
    await expect(page.getByTestId('onboarding-glossary-option')).toBeHidden()
    await page.getByTestId('paradigm-card-exp').click()
    await page.getByTestId('goal-card-reproduce').click()
    await page.getByTestId('onboarding-next').click()

    // 第 3 步：应展示生命科学方向建议卡片并预览具体中英术语示例
    await expect(page.getByTestId('guided-rec-bio-cell')).toBeVisible()
    await expect(page.getByTestId('onboarding-glossary-option')).toBeVisible()
    await expect(page.getByTestId('onboarding-glossary-preview')).toContainText('signal transduction → 信号转导')
    await page.getByTestId('onboarding-submit').click()
    await expect(modal).toBeHidden()

    const profile = await page.evaluate(() => window.paperflow.getResearchProfile())
    expect(profile).toMatchObject({
      completed: true,
      mode: 'guided',
      facultyId: 'bio-med',
      paradigm: 'exp',
      readingGoal: 'reproduce'
    })
  } finally {
    await app.close()
  }
})
