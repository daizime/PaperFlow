import type { AiChatContextDocument, AiResearchSkillId } from '../../shared/contracts'

export interface AcademicSkillPromptSpec {
  id: AiResearchSkillId
  displayTitle: string
  userLabel: string
  systemPrompt: string
  userPrompt: string
}

function formatContextsBlock(contexts: readonly AiChatContextDocument[]): string {
  if (contexts.length === 0) return '(未附带特定文献正文，请根据用户指令给出学术结构模板与方法论建议。)'
  return contexts
    .map((ctx, idx) => {
      const label = ctx.paneLabel ? `[${ctx.paneLabel}] ` : contexts.length > 1 ? `[文献 ${idx + 1}] ` : ''
      const pagePart = ctx.pageNumber ? ` (P.${ctx.pageNumber})` : ''
      const excerpt = ctx.excerpt?.trim() ? `\n正文与批注摘录：\n${ctx.excerpt.trim()}` : ''
      return `${label}${ctx.title}${pagePart}${excerpt}`
    })
    .join('\n\n====================\n\n')
}

/**
 * 结合高星开源科研 Skill（stephenturner/skill-focus FOCUS 精读法、anthropics/skills pptx 规范与 Imbad0202/academic-research-skills 审稿对照流）
 * 构建确定性、结构化的科研任务提示词。
 */
export function buildAcademicSkillPrompt(options: {
  skill: AiResearchSkillId
  targetLanguage: string
  researchContext?: string
  glossaryText?: string
  customInstruction?: string
  customSkillName?: string
  customPrompt?: string
  contexts: readonly AiChatContextDocument[]
}): AcademicSkillPromptSpec {
  const {
    skill,
    targetLanguage,
    researchContext,
    glossaryText,
    customInstruction,
    customSkillName,
    customPrompt,
    contexts
  } = options
  const contextBlock = formatContextsBlock(contexts)
  const domainHint = researchContext?.trim() ? `\nResearch domain context: ${researchContext.trim()}` : ''
  const glossaryHint = glossaryText?.trim() ? `\nPreferred terminology:\n${glossaryText.trim()}` : ''
  const pageCiteHint = '\nWhen citing paper findings or sections, include clickable page references like P.3 or P.12 when known.'
  const extra = customInstruction?.trim() ? `\n\n用户补充要求：${customInstruction.trim()}` : ''

  if (skill === 'custom') {
    const labelName = customSkillName?.trim() || '自定义科研技能'
    const tpl = customPrompt?.trim() || '请对所附文献材料进行结构化分析。'
    return {
      id: 'custom',
      displayTitle: labelName,
      userLabel: customInstruction?.trim()
        ? `【自定义技能 · ${labelName}】${customInstruction.trim()}`
        : `【自定义技能 · ${labelName}】${tpl.slice(0, 80)}${tpl.length > 80 ? '…' : ''}`,
      systemPrompt: [
        `You are Foliopair's rigorous scholarly reading assistant executing the user's custom workflow template "${labelName}".`,
        `Reply in ${targetLanguage} using clean, well-structured Markdown.`,
        'Be concrete, preserve quantitative metrics and exact claims, and clearly separate observed paper facts from general inference.',
        pageCiteHint.trim(),
        domainHint,
        glossaryHint
      ]
        .filter(Boolean)
        .join('\n'),
      userPrompt: `${tpl}${extra}\n\n文献上下文：\n${contextBlock}`
    }
  }

  if (skill === 'summary-focus') {
    return {
      id: skill,
      displayTitle: 'FOCUS 深度文献总结',
      userLabel: customInstruction?.trim()
        ? `【一键技能 · FOCUS 深度总结】${customInstruction.trim()}`
        : '【一键技能 · FOCUS 深度总结】请基于当前文献生成保留具体指标与方法细节的结构化精读总结。',
      systemPrompt: [
        `You are an elite scientific paper analyst following the FOCUS exhaustive summarization methodology (preserve exact numbers, datasets, baselines, hyperparameters, effect sizes, and author claims; never use vague filler).`,
        `Reply in ${targetLanguage} using clean Markdown headings.`,
        'Clearly distinguish facts explicitly observed in the provided excerpts from inferred context; if a detail is not in the excerpt, explicitly mark it as "原文摘录未提及".',
        domainHint,
        glossaryHint
      ]
        .filter(Boolean)
        .join('\n'),
      userPrompt: `请对以下文献内容生成「FOCUS 深度精读总结」，严格包含以下分节：
1. **核心问题与研究动机**（解决什么痛点、现有基线局限）
2. **核心贡献与关键定量结论**（保留原文具体数字、提升幅度、p 值或对比指标）
3. **方法架构与实验设置**（模型/算法流程、数据集、关键超参或实验条件）
4. **局限性、边界条件与复现关键点**
5. **与相关工作的关系及后续可读/可复现建议**${extra}

文献上下文：
${contextBlock}`
    }
  }

  if (skill === 'ppt-deck') {
    return {
      id: skill,
      displayTitle: '学术汇报 PPT 生成',
      userLabel: customInstruction?.trim()
        ? `【一键技能 · 生成 PPT】${customInstruction.trim()}`
        : '【一键技能 · 生成 PPT】请为当前文献生成结构化组会/学术汇报 PPT（含版式布局与每页演讲备注）。',
      systemPrompt: [
        'You are an academic presentation designer following Anthropic pptx skill principles: structured visual cards/two-column/metrics layouts instead of plain bullet walls, clear visual hierarchy, high information density without crowding, and concise speaker notes.',
        `Write all titles, bullets, metrics, takeaways, and speakerNotes in ${targetLanguage}.`,
        'Output STRICT JSON only (no prose outside JSON), matching this exact TypeScript shape:',
        '{"deckTitle":"string","subtitle":"string","authors":"string","slides":[{"title":"string","subtitle":"string","layout":"cover|metrics|two-column|cards|closing","bullets":["string"],"metrics":[{"value":"string","label":"string","detail":"string"}],"columns":[{"heading":"string","points":["string"]}],"takeaway":"string","speakerNotes":"string"}]}',
        'Generate 7 to 9 slides: Slide 1 must use layout "cover"; middle slides must mix "cards", "two-column", and "metrics" (whenever numbers exist); the final slide must use layout "closing". Keep each bullet under 28 words so text never overflows.',
        domainHint,
        glossaryHint
      ]
        .filter(Boolean)
        .join('\n'),
      userPrompt: `请根据以下文献上下文生成一份适合组会汇报的 7-9 页 PPT 结构 JSON（包含研究背景/动机、核心创新点、方法流程、关键实验指标、对比与消融/局限、总结与 Q&A）：${extra}

文献上下文：
${contextBlock}`
    }
  }

  if (skill === 'peer-review') {
    return {
      id: skill,
      displayTitle: '模拟同行评审与批判分析',
      userLabel: customInstruction?.trim()
        ? `【一键技能 · 审稿批判】${customInstruction.trim()}`
        : '【一键技能 · 审稿批判】请以顶会/顶刊审稿人视角拆解该论文的优点、潜在漏洞与复现风险。',
      systemPrompt: [
        'You are a rigorous top-venue peer reviewer (NeurIPS / Nature / IEEE style). Evaluate evidence strength, experimental fairness, statistical validity, ablation completeness, and reproducibility risks.',
        `Reply in ${targetLanguage} using structured Markdown.`,
        'Only cite concrete details present in the provided text; mark missing details as needing clarification.',
        domainHint,
        glossaryHint
      ]
        .filter(Boolean)
        .join('\n'),
      userPrompt: `请对以下文献撰写「同行评审批判报告」：
1. **一句话工作概括与总体评价**
2. **主要优势 (Strengths)**（至少 3 条，结合证据）
3. **关键漏洞与质疑 (Weaknesses & Threats to Validity)**（指出实验对比、假设或统计缺陷）
4. **给作者的核实问题 (Questions for Authors)**
5. **复现检查清单 (Reproducibility Audit)**${extra}

文献上下文：
${contextBlock}`
    }
  }

  return {
    id: 'compare-matrix',
    displayTitle: '多文献横向对比矩阵',
    userLabel: customInstruction?.trim()
      ? `【一键技能 · 多篇对比】${customInstruction.trim()}`
      : '【一键技能 · 多篇对比】请生成同屏多篇文献的研究问题、方法、数据指标与优劣对比表。',
    systemPrompt: [
      'You are a systematic literature review synthesizer. Produce a clear Markdown comparison matrix followed by concise synthesis insights.',
      `Reply in ${targetLanguage}.`,
      domainHint,
      glossaryHint
    ]
      .filter(Boolean)
      .join('\n'),
    userPrompt: `请对以下多篇文献进行横向比较：
1. **横向对比总表（Markdown 表格）**：列包括「文献」「核心问题」「方法路径」「主要数据/结果」「适用边界与不足」
2. **共性趋势与关键分歧**
3. **融合改进或研究切入点建议**${extra}

文献上下文：
${contextBlock}`
  }
}
