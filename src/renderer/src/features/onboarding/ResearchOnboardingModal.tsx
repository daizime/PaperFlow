import { useEffect, useMemo, useState } from 'react'
import type {
  ResearchOnboardingMode,
  ResearchParadigm,
  ResearchProfile,
  ResearchReadingGoal,
  ResearchStage,
  SaveResearchProfileInput
} from '../../../../shared/contracts'
import {
  RESEARCH_FACULTIES,
  RESEARCH_GOAL_OPTIONS,
  RESEARCH_PARADIGM_OPTIONS,
  RESEARCH_STAGE_OPTIONS,
  collectRecommendedTags,
  collectStarterGlossary,
  getFacultyById,
  getGoalById,
  getParadigmById,
  getTrackById,
  getTracksByFaculty,
  recommendTracksForGuidance
} from '../../../../shared/research-onboarding'
import './onboarding.css'

export interface ResearchOnboardingModalProps {
  open: boolean
  initialProfile: ResearchProfile | null
  isFirstLaunch: boolean
  onClose(): void
  onSaved(profile: ResearchProfile): void
}

const DEFAULT_FACULTY_ID = 'bio-med'
const DEFAULT_PARADIGM: ResearchParadigm = 'exp'

export function ResearchOnboardingModal({
  open,
  initialProfile,
  isFirstLaunch,
  onClose,
  onSaved
}: ResearchOnboardingModalProps): React.JSX.Element | null {
  const [mode, setMode] = useState<Exclude<ResearchOnboardingMode, 'skipped'>>('direct')
  const [stage, setStage] = useState<ResearchStage>('master-1')
  const [facultyId, setFacultyId] = useState<string>(DEFAULT_FACULTY_ID)
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([])
  const [customTopic, setCustomTopic] = useState('')
  const [paradigm, setParadigm] = useState<ResearchParadigm>(DEFAULT_PARADIGM)
  const [readingGoal, setReadingGoal] = useState<ResearchReadingGoal>('survey')
  const [guidedStep, setGuidedStep] = useState<1 | 2 | 3>(1)
  const [applyStarterGlossary, setApplyStarterGlossary] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSaving(false)
    if (!initialProfile || initialProfile.mode === 'skipped') {
      setMode('direct')
      setStage(initialProfile?.stage ?? 'master-1')
      setFacultyId(DEFAULT_FACULTY_ID)
      setSelectedTrackIds([])
      setCustomTopic('')
      setParadigm(DEFAULT_PARADIGM)
      setReadingGoal('survey')
      setGuidedStep(1)
      setApplyStarterGlossary(true)
      return
    }
    const nextMode: Exclude<ResearchOnboardingMode, 'skipped'> =
      initialProfile.mode === 'guided' ? 'guided' : 'direct'
    setMode(nextMode)
    setStage(initialProfile.stage)
    setFacultyId(initialProfile.facultyId || (nextMode === 'direct' ? DEFAULT_FACULTY_ID : ''))
    setSelectedTrackIds(initialProfile.selectedTrackIds)
    setCustomTopic(initialProfile.customTopic)
    setParadigm(initialProfile.paradigm)
    setReadingGoal(initialProfile.readingGoal)
    setGuidedStep(nextMode === 'guided' ? 3 : 1)
    setApplyStarterGlossary(true)
  }, [open, initialProfile])

  const facultyTracks = useMemo(
    () => getTracksByFaculty(facultyId || DEFAULT_FACULTY_ID),
    [facultyId]
  )

  const guidedRecommendations = useMemo(
    () =>
      recommendTracksForGuidance({
        facultyId,
        paradigm,
        readingGoal,
        customTopic
      }),
    [facultyId, paradigm, readingGoal, customTopic]
  )

  const previewTags = useMemo(
    () => collectRecommendedTags(selectedTrackIds, customTopic, readingGoal),
    [selectedTrackIds, customTopic, readingGoal]
  )

  const previewGlossary = useMemo(
    () => collectStarterGlossary(selectedTrackIds),
    [selectedTrackIds]
  )

  const handleSkipOrClose = async (): Promise<void> => {
    if (saving) return
    if (!isFirstLaunch) {
      onClose()
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: SaveResearchProfileInput = {
        completed: true,
        mode: 'skipped',
        stage,
        facultyId: '',
        selectedTrackIds: [],
        customTopic: '',
        paradigm,
        readingGoal,
        recommendedTags: [],
        applyStarterGlossary: false
      }
      const saved = await window.paperflow.saveResearchProfile(payload)
      onSaved(saved)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        void handleSkipOrClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  if (!open) return null

  const toggleTrack = (trackId: string): void => {
    setError(null)
    const track = getTrackById(trackId)
    setSelectedTrackIds(prev => {
      if (prev.includes(trackId)) {
        return prev.filter(id => id !== trackId)
      }
      if (prev.length === 0 && track) {
        setParadigm(track.defaultParadigm)
      }
      if (prev.length >= 3) {
        return [...prev.slice(1), trackId]
      }
      return [...prev, trackId]
    })
  }

  const goToGuidedStep = (targetStep: 1 | 2 | 3): void => {
    setError(null)
    if (targetStep === 3 && selectedTrackIds.length === 0) {
      const topTrack = guidedRecommendations[0]?.track
      if (topTrack) {
        setSelectedTrackIds([topTrack.id])
      }
    }
    setGuidedStep(targetStep)
  }

  const handleSubmit = async (): Promise<void> => {
    if (saving) return
    if (selectedTrackIds.length === 0 && !customTopic.trim()) {
      setError('请至少选择一个细分方向，或输入你的研究课题。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const effectiveFacultyId =
        facultyId ||
        (selectedTrackIds[0] ? getTrackById(selectedTrackIds[0])?.facultyId ?? '' : '')
      const payload: SaveResearchProfileInput = {
        completed: true,
        mode,
        stage,
        facultyId: effectiveFacultyId,
        selectedTrackIds,
        customTopic: customTopic.trim(),
        paradigm,
        readingGoal,
        recommendedTags: previewTags,
        applyStarterGlossary
      }
      const saved = await window.paperflow.saveResearchProfile(payload)
      onSaved(saved)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const activeFaculty = facultyId ? getFacultyById(facultyId) : undefined
  const activeParadigm = getParadigmById(paradigm)
  const activeGoal = getGoalById(readingGoal)

  return (
    <div className="onboarding-modal-backdrop" role="presentation">
      <div
        className="onboarding-modal"
        data-testid="onboarding-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-modal-title"
      >
        <div className="onboarding-modal__header">
          <div>
            <div className="onboarding-modal__eyebrow">Foliopair · 研究生科研向导</div>
            <h3 id="onboarding-modal-title">开启你的科研文献工作区</h3>
          </div>
          <button
            type="button"
            className="onboarding-modal__skip"
            data-testid="onboarding-skip"
            disabled={saving}
            onClick={() => void handleSkipOrClose()}
          >
            {isFirstLaunch ? '先跳过 →' : '关闭'}
          </button>
        </div>

        <div className="onboarding-modal__body">
          {/* 当前培养阶段 */}
          <div className="onboarding-modal__stage-row" role="group" aria-label="当前科研阶段">
            <span className="onboarding-modal__section-label">当前阶段：</span>
            {RESEARCH_STAGE_OPTIONS.map(option => (
              <button
                key={option.id}
                type="button"
                className={`onboarding-modal__pill${stage === option.id ? ' is-active' : ''}`}
                aria-pressed={stage === option.id}
                onClick={() => setStage(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {/* 方案 B 核心双模式分流 */}
          <div className="onboarding-modal__mode-grid" role="group" aria-label="向导模式选择">
            <button
              type="button"
              data-testid="onboarding-mode-direct"
              className={`onboarding-modal__mode-card${mode === 'direct' ? ' is-active' : ''}`}
              aria-pressed={mode === 'direct'}
              onClick={() => {
                setError(null)
                setMode('direct')
                if (!facultyId) setFacultyId(DEFAULT_FACULTY_ID)
              }}
            >
              <strong>A. 我已有明确专业/课题</strong>
              <span>从 8 大学科门类中选定或自定义输入方向</span>
            </button>
            <button
              type="button"
              data-testid="onboarding-mode-guided"
              className={`onboarding-modal__mode-card${mode === 'guided' ? ' is-active' : ''}`}
              aria-pressed={mode === 'guided'}
              onClick={() => {
                setError(null)
                setMode('guided')
              }}
            >
              <strong>B. 帮我从零梳理研究方向</strong>
              <span>通过 3 步确定学科、科研范式与文献阅读目标</span>
            </button>
          </div>

          {mode === 'direct' ? (
            <div className="onboarding-modal__section">
              <div className="onboarding-modal__field">
                <span className="onboarding-modal__label">1. 选择所属学科门类（8 大学科门类平权可选）</span>
                <div className="onboarding-modal__pill-wrap">
                  {RESEARCH_FACULTIES.map(fac => {
                    const active = (facultyId || DEFAULT_FACULTY_ID) === fac.id
                    return (
                      <button
                        key={fac.id}
                        type="button"
                        data-testid={`faculty-pill-${fac.id}`}
                        className={`onboarding-modal__pill${active ? ' is-active' : ''}`}
                        aria-pressed={active}
                        onClick={() => {
                          setError(null)
                          setFacultyId(fac.id)
                        }}
                      >
                        {fac.name}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="onboarding-modal__field">
                <div className="onboarding-modal__label-row">
                  <span className="onboarding-modal__label">
                    2. 选择细分方向（可跨门类多选，最多 3 个）
                  </span>
                  {selectedTrackIds.length > 0 ? (
                    <span className="onboarding-modal__hint">已选 {selectedTrackIds.length}/3</span>
                  ) : null}
                </div>
                <div className="onboarding-modal__track-grid">
                  {facultyTracks.map(track => {
                    const selected = selectedTrackIds.includes(track.id)
                    return (
                      <button
                        key={track.id}
                        type="button"
                        data-testid={`track-card-${track.id}`}
                        className={`onboarding-modal__track-card${selected ? ' is-active' : ''}`}
                        aria-pressed={selected}
                        onClick={() => toggleTrack(track.id)}
                      >
                        <div className="onboarding-modal__track-top">
                          <strong>{track.name}</strong>
                          {selected ? <span className="onboarding-modal__badge">已选</span> : null}
                        </div>
                        <small>{track.venues.slice(0, 4).join(' / ')}</small>
                      </button>
                    )
                  })}
                </div>

                {selectedTrackIds.length > 0 ? (
                  <div className="onboarding-modal__selected-chips">
                    {selectedTrackIds.map(id => {
                      const track = getTrackById(id)
                      if (!track) return null
                      return (
                        <button
                          key={id}
                          type="button"
                          className="onboarding-modal__chip"
                          title="点击移除该方向"
                          onClick={() => toggleTrack(id)}
                        >
                          {track.name} ×
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>

              <label className="onboarding-modal__field">
                <span className="onboarding-modal__label">3. 自定义专业或具体研究课题（未列出时可直接填写）</span>
                <input
                  type="text"
                  data-testid="onboarding-custom-topic"
                  value={customTopic}
                  maxLength={160}
                  onChange={event => {
                    setError(null)
                    setCustomTopic(event.target.value)
                  }}
                  placeholder="输入任意学科或交叉课题（如：钙钛矿太阳能电池、宋代经济史、脑机接口、海洋微塑料…）"
                />
              </label>

              <div className="onboarding-modal__inline-groups">
                <div className="onboarding-modal__inline-group">
                  <span className="onboarding-modal__section-label">科研范式：</span>
                  {RESEARCH_PARADIGM_OPTIONS.map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`onboarding-modal__pill${paradigm === opt.id ? ' is-active' : ''}`}
                      aria-pressed={paradigm === opt.id}
                      onClick={() => setParadigm(opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="onboarding-modal__inline-group">
                  <span className="onboarding-modal__section-label">近期阅读重点：</span>
                  {RESEARCH_GOAL_OPTIONS.map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`onboarding-modal__pill${readingGoal === opt.id ? ' is-active' : ''}`}
                      aria-pressed={readingGoal === opt.id}
                      onClick={() => setReadingGoal(opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="onboarding-modal__section">
              <div className="onboarding-modal__stepper" role="tablist" aria-label="方向梳理步骤">
                {(
                  [
                    { step: 1 as const, label: '1. 选学科门类' },
                    { step: 2 as const, label: '2. 选研究范式与目标' },
                    { step: 3 as const, label: '3. 看定制建议' }
                  ] as const
                ).map(item => (
                  <button
                    key={item.step}
                    type="button"
                    role="tab"
                    data-testid={`onboarding-step-${item.step}`}
                    aria-selected={guidedStep === item.step}
                    className={`onboarding-modal__step-btn${guidedStep === item.step ? ' is-active' : ''}`}
                    onClick={() => goToGuidedStep(item.step)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {guidedStep === 1 ? (
                <div className="onboarding-modal__field">
                  <span className="onboarding-modal__label">你的本科专业背景或目前所在的学科门类？</span>
                  <div className="onboarding-modal__pill-wrap">
                    {RESEARCH_FACULTIES.map(fac => (
                      <button
                        key={fac.id}
                        type="button"
                        data-testid={`faculty-pill-${fac.id}`}
                        className={`onboarding-modal__pill${facultyId === fac.id ? ' is-active' : ''}`}
                        aria-pressed={facultyId === fac.id}
                        onClick={() => {
                          setError(null)
                          setFacultyId(fac.id)
                        }}
                      >
                        {fac.name}
                      </button>
                    ))}
                    <button
                      type="button"
                      data-testid="faculty-pill-exploratory"
                      className={`onboarding-modal__pill${facultyId === '' ? ' is-active' : ''}`}
                      aria-pressed={facultyId === ''}
                      onClick={() => {
                        setError(null)
                        setFacultyId('')
                      }}
                    >
                      还在跨学科探索（不限门类）
                    </button>
                  </div>

                  <label className="onboarding-modal__field onboarding-modal__spaced">
                    <span className="onboarding-modal__label">感兴趣的现象、方法或课程关键词（选填）</span>
                    <input
                      type="text"
                      data-testid="onboarding-guided-topic"
                      value={customTopic}
                      maxLength={160}
                      onChange={event => {
                        setError(null)
                        setCustomTopic(event.target.value)
                      }}
                      placeholder="例如：单细胞测序、催化反应机理、量化金融、量子输运、田野调查…"
                    />
                  </label>
                </div>
              ) : guidedStep === 2 ? (
                <div className="onboarding-modal__section">
                  <div className="onboarding-modal__field">
                    <span className="onboarding-modal__label">你希望自己的科研日常更偏向哪类研究方式？</span>
                    <div className="onboarding-modal__track-grid">
                      {RESEARCH_PARADIGM_OPTIONS.map(opt => (
                        <button
                          key={opt.id}
                          type="button"
                          data-testid={`paradigm-card-${opt.id}`}
                          className={`onboarding-modal__track-card${paradigm === opt.id ? ' is-active' : ''}`}
                          aria-pressed={paradigm === opt.id}
                          onClick={() => setParadigm(opt.id)}
                        >
                          <div className="onboarding-modal__track-top">
                            <strong>{opt.label}</strong>
                          </div>
                          <small>{opt.description}</small>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="onboarding-modal__field">
                    <span className="onboarding-modal__label">现阶段读英文/专业文献最想解决什么问题？</span>
                    <div className="onboarding-modal__goal-grid">
                      {RESEARCH_GOAL_OPTIONS.map(opt => (
                        <button
                          key={opt.id}
                          type="button"
                          data-testid={`goal-card-${opt.id}`}
                          className={`onboarding-modal__track-card${readingGoal === opt.id ? ' is-active' : ''}`}
                          aria-pressed={readingGoal === opt.id}
                          onClick={() => setReadingGoal(opt.id)}
                        >
                          <div className="onboarding-modal__track-top">
                            <strong>{opt.label}</strong>
                          </div>
                          <small>{opt.description}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="onboarding-modal__section">
                  <div className="onboarding-modal__summary-banner">
                    <div>
                      <strong>
                        当前画像：{activeFaculty ? activeFaculty.name : '跨学科探索'} ·{' '}
                        {activeParadigm?.label ?? ''} · {activeGoal?.label ?? ''}
                      </strong>
                      <p>{activeParadigm?.readingTip}</p>
                    </div>
                  </div>
                  <div className="onboarding-modal__field">
                    <span className="onboarding-modal__label">为你匹配的文献起步方向（点击勾选，可多选）：</span>
                    <div className="onboarding-modal__rec-list">
                      {guidedRecommendations.map(rec => {
                        const selected = selectedTrackIds.includes(rec.track.id)
                        return (
                          <button
                            key={rec.track.id}
                            type="button"
                            data-testid={`guided-rec-${rec.track.id}`}
                            className={`onboarding-modal__rec-card${selected ? ' is-active' : ''}`}
                            aria-pressed={selected}
                            onClick={() => toggleTrack(rec.track.id)}
                          >
                            <div className="onboarding-modal__track-top">
                              <strong>{rec.track.name}</strong>
                              <span className="onboarding-modal__badge">
                                {selected ? '已选定' : rec.reasons[0] ?? '推荐'}
                              </span>
                            </div>
                            <p>{rec.track.summary}</p>
                            <small>
                              代表刊物：{rec.track.venues.join(' / ')} · 检索建议：{rec.track.searchTip}
                            </small>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 将写入本地的效果预览 + 术语库导入勾选（仅在已有方向/引导第3步展示，预置词条为 0 时隐藏术语导入项） */}
          {mode === 'direct' || guidedStep === 3 ? (
            <div className="onboarding-modal__preview" data-testid="onboarding-preview">
              <div className="onboarding-modal__preview-row">
                <span className="onboarding-modal__preview-label">将生成文献标签：</span>
                <div className="onboarding-modal__preview-tags">
                  {previewTags.map(tag => (
                    <span key={tag} className="onboarding-modal__preview-tag">
                      #{tag}
                    </span>
                  ))}
                </div>
              </div>
              {previewGlossary.length > 0 ? (
                <div className="onboarding-modal__glossary-option" data-testid="onboarding-glossary-option">
                  <label className="onboarding-modal__checkbox">
                    <input
                      type="checkbox"
                      checked={applyStarterGlossary}
                      onChange={event => setApplyStarterGlossary(event.target.checked)}
                    />
                    <span>
                      自动创建对应学科分类文件夹，并写入 {previewGlossary.length} 条专属中英术语（与其他分类严格隔离）
                    </span>
                  </label>
                  <div className="onboarding-modal__glossary-sample" data-testid="onboarding-glossary-preview">
                    示例：{previewGlossary.slice(0, 3).map(item => `${item.source} → ${item.target}`).join('、')}
                    {previewGlossary.length > 3 ? ' 等' : ''}。仅对该文件夹内论文生效，可在左侧分类树「分类设置」随时增删。
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div className="onboarding-modal__error" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <div className="onboarding-modal__footer">
          {mode === 'guided' && guidedStep > 1 ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => goToGuidedStep(guidedStep === 3 ? 2 : 1)}
            >
              上一步
            </button>
          ) : (
            <span className="onboarding-modal__hint">可在顶部标题栏随时重新打开并调整研究方向</span>
          )}
          <div className="onboarding-modal__footer-right">
            {mode === 'guided' && guidedStep < 3 ? (
              <button
                type="button"
                className="onboarding-modal__primary"
                data-testid="onboarding-next"
                onClick={() => goToGuidedStep(guidedStep === 1 ? 2 : 3)}
              >
                下一步
              </button>
            ) : (
              <button
                type="button"
                className="onboarding-modal__primary"
                data-testid="onboarding-submit"
                disabled={saving}
                onClick={() => void handleSubmit()}
              >
                {saving ? '正在保存…' : '完成并进入 Foliopair'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
