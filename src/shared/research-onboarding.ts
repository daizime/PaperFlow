import {
  hasControlCharacters,
  type GlossaryEntry,
  type ResearchOnboardingMode,
  type ResearchParadigm,
  type ResearchProfile,
  type ResearchReadingGoal,
  type ResearchStage
} from './contracts'

export interface ResearchFacultyOption {
  id: string
  name: string
  shortName: string
  defaultTrackId: string
  description: string
}

export interface ResearchTrackOption {
  id: string
  facultyId: string
  name: string
  englishName: string
  summary: string
  defaultParadigm: ResearchParadigm
  paradigms: readonly ResearchParadigm[]
  venues: readonly string[]
  searchTip: string
  recommendedTags: readonly string[]
  starterGlossary: readonly GlossaryEntry[]
}

export interface ResearchParadigmOption {
  id: ResearchParadigm
  label: string
  description: string
  readingTip: string
}

export interface ResearchReadingGoalOption {
  id: ResearchReadingGoal
  label: string
  description: string
  tag: string
}

export interface ResearchStageOption {
  id: ResearchStage
  label: string
}

export interface GuidedOnboardingInput {
  facultyId: string
  paradigm: ResearchParadigm
  readingGoal: ResearchReadingGoal
  customTopic: string
}

export interface TrackRecommendation {
  track: ResearchTrackOption
  score: number
  reasons: string[]
}

export const RESEARCH_STAGE_OPTIONS: readonly ResearchStageOption[] = [
  { id: 'undergrad-prep', label: '准研究生 / 推免衔接' },
  { id: 'master-1', label: '研一新生' },
  { id: 'master-senior', label: '研二 / 研三' },
  { id: 'phd', label: '博士生 / 博一新生' },
  { id: 'other', label: '青年学者 / 其他' }
]

export const RESEARCH_PARADIGM_OPTIONS: readonly ResearchParadigmOption[] = [
  {
    id: 'exp',
    label: '实验观测与表征',
    description: '湿实验、合成表征、仪器测试、临床试验或田野调查',
    readingTip: '精读时优先核对实验条件、试剂/设备规格、对照组设计与误差统计学表达'
  },
  {
    id: 'theory',
    label: '理论推导与机制建模',
    description: '数学证明、物理定律、机理假设、经济模型或法理分析',
    readingTip: '精读时严格区分假设条件、变量符号定义、定理引理结构与因果论证链条'
  },
  {
    id: 'comp',
    label: '计算仿真与数据分析',
    description: '数值模拟、分子动力学、生物信息、计量回归或机器学习',
    readingTip: '精读时重点关注边界条件、参数设定、样本量、显著性检验与消融基准'
  },
  {
    id: 'design',
    label: '工程设计与方案落地',
    description: '结构/电路/工艺研发、器件集成、育种选育或政策方案设计',
    readingTip: '精读时关注关键性能指标（效率/良率/稳定性）、工艺参数与工况约束条件'
  }
]

export const RESEARCH_GOAL_OPTIONS: readonly ResearchReadingGoalOption[] = [
  {
    id: 'survey',
    label: '快速建立领域全景',
    description: '梳理权威综述与经典文献，厘清学科核心问题与分支脉络',
    tag: '领域综述'
  },
  {
    id: 'reproduce',
    label: '精读方法与复现',
    description: '拆解实验步骤、试剂/仪器参数、推导过程或数据管线',
    tag: '方法复现'
  },
  {
    id: 'writing',
    label: '开题与论文写作',
    description: '提炼研究空白、对照顶刊结构并积累规范英文学术表达',
    tag: '开题写作'
  }
]

export const RESEARCH_FACULTIES: readonly ResearchFacultyOption[] = [
  {
    id: 'bio-med',
    name: '生命科学与医学',
    shortName: '生医',
    defaultTrackId: 'bio-cell',
    description: '分子细胞、神经脑科学、生物信息与临床药学'
  },
  {
    id: 'chem-mat',
    name: '化学、材料与能源环境',
    shortName: '化材环',
    defaultTrackId: 'chem-synth',
    description: '合成化学、催化电化学、功能材料与双碳环境'
  },
  {
    id: 'math-phys',
    name: '数学、物理与地球天文',
    shortName: '数理地',
    defaultTrackId: 'phys-quantum',
    description: '应用数学统计、凝聚态与光学高能物理、地学气候'
  },
  {
    id: 'info-cs',
    name: '信息、电子与计算机',
    shortName: '信息电子',
    defaultTrackId: 'ee-chip',
    description: '电子通信与芯片、控制机器人、人工智能与软件系统'
  },
  {
    id: 'eng-mech',
    name: '机械、土木与航空电气',
    shortName: '机土航',
    defaultTrackId: 'mech-mfg',
    description: '先进制造力学、航空航天动力与土木智慧交通'
  },
  {
    id: 'agri-eco',
    name: '农学、食品与生态资源',
    shortName: '农食生态',
    defaultTrackId: 'agri-crop',
    description: '作物育种与植物科学、食品科学与生态保护'
  },
  {
    id: 'econ-mgmt',
    name: '经济、管理与金融',
    shortName: '经管金',
    defaultTrackId: 'econ-causal',
    description: '因果推断经济学、金融工程与管理运筹科学'
  },
  {
    id: 'human-soc',
    name: '人文、法政、心理与教育',
    shortName: '人文社科',
    defaultTrackId: 'psych-edu',
    description: '认知心理教育、法学社会学与数字人文研究'
  }
]

export const RESEARCH_TRACK_OPTIONS: readonly ResearchTrackOption[] = [
  // 1. 生命科学与医学
  {
    id: 'bio-cell',
    facultyId: 'bio-med',
    name: '分子、细胞与发育生物学',
    englishName: 'Molecular & Cell Biology',
    summary: '关注基因调控、细胞信号转导、表观遗传与模式生物发育机制。',
    defaultParadigm: 'exp',
    paradigms: ['exp', 'comp'],
    venues: ['Cell', 'Nature Cell Biology', 'eLife', 'JBC'],
    searchTip: '建议在 PubMed、bioRxiv 与 Web of Science 按“通路 + 表型 + 模式生物”检索高被引综述。',
    recommendedTags: ['分子细胞', '信号通路', '机制研究'],
    starterGlossary: [
      { source: 'signal transduction', target: '信号转导' },
      { source: 'CRISPR-Cas9', target: 'CRISPR-Cas9 基因编辑' },
      { source: 'Western blot', target: '免疫印迹（WB）' },
      { source: 'knockout mouse', target: '基因敲除小鼠' },
      { source: 'transcription factor', target: '转录因子' }
    ]
  },
  {
    id: 'bio-neuro',
    facultyId: 'bio-med',
    name: '神经科学与脑科学',
    englishName: 'Neuroscience & Brain Science',
    summary: '研究神经环路解析、突触可塑性、脑电/钙成像与神经退行性疾病。',
    defaultParadigm: 'exp',
    paradigms: ['exp', 'comp', 'theory'],
    venues: ['Nature Neuroscience', 'Neuron', 'Journal of Neuroscience'],
    searchTip: '在 PubMed 与 SfN 摘要库中按“环路 / 受体 / 行为范式”构建文献树，兼顾电生理与成像方法。',
    recommendedTags: ['神经科学', '突触可塑性', '脑成像'],
    starterGlossary: [
      { source: 'optogenetics', target: '光遗传学' },
      { source: 'synaptic plasticity', target: '突触可塑性' },
      { source: 'patch-clamp', target: '膜片钳记录' },
      { source: 'fMRI', target: '功能磁共振成像' },
      { source: 'action potential', target: '动作电位' }
    ]
  },
  {
    id: 'bio-genomics',
    facultyId: 'bio-med',
    name: '生物信息学与基因组学',
    englishName: 'Bioinformatics & Genomics',
    summary: '聚焦单细胞测序、空间转录组、多组学整合与蛋白结构功能预测。',
    defaultParadigm: 'comp',
    paradigms: ['comp', 'exp'],
    venues: ['Nature Biotechnology', 'Genome Biology', 'Nucleic Acids Research'],
    searchTip: '建议结合 PubMed、bioRxiv 与 GEO/TCGA 公共数据集论文，同步关注生信流程与湿实验验证。',
    recommendedTags: ['生物信息', '单细胞测序', '多组学'],
    starterGlossary: [
      { source: 'scRNA-seq', target: '单细胞转录组测序' },
      { source: 'differential expression', target: '差异表达分析' },
      { source: 'GWAS', target: '全基因组关联分析' },
      { source: 'enrichment analysis', target: '富集分析' },
      { source: 'sequence alignment', target: '序列比对' }
    ]
  },
  {
    id: 'med-clinical',
    facultyId: 'bio-med',
    name: '临床医学与药学转化',
    englishName: 'Clinical Medicine & Translational Pharmacology',
    summary: '面向队列研究、随机对照试验、靶点发现、药代动力学与临床疗效评估。',
    defaultParadigm: 'exp',
    paradigms: ['exp', 'comp', 'design'],
    venues: ['NEJM', 'Lancet', 'Nature Medicine', 'J. Med. Chem.'],
    searchTip: '优先按“人群队列 / 疾病分型 / 终点指标”查 PubMed Clinical Queries、Cochrane 与 ClinicalTrials。',
    recommendedTags: ['临床转化', '随机对照', '靶向药物'],
    starterGlossary: [
      { source: 'randomized controlled trial', target: '随机对照试验（RCT）' },
      { source: 'pharmacokinetics', target: '药代动力学' },
      { source: 'overall survival', target: '总生存期（OS）' },
      { source: 'biomarker', target: '生物标志物' },
      { source: 'hazard ratio', target: '风险比（HR）' }
    ]
  },

  // 2. 化学、材料与能源环境
  {
    id: 'chem-synth',
    facultyId: 'chem-mat',
    name: '有机、无机与分析化学',
    englishName: 'Synthetic & Analytical Chemistry',
    summary: '关注不对称合成、配位化学、反应机理表征与高灵敏谱学/色谱分析。',
    defaultParadigm: 'exp',
    paradigms: ['exp', 'theory'],
    venues: ['JACS', 'Angewandte Chemie', 'Organic Letters', 'Anal. Chem.'],
    searchTip: '按“底物范围 + 配体/催化剂 + 机理验证”在 SciFinder/Reaxys 或 ACS/RSC 数据库追踪前沿方法。',
    recommendedTags: ['合成化学', '反应机理', '结构表征'],
    starterGlossary: [
      { source: 'enantioselectivity', target: '对映选择性' },
      { source: 'turnover number', target: '转化数（TON）' },
      { source: 'NMR spectroscopy', target: '核磁共振波谱' },
      { source: 'reaction mechanism', target: '反应机理' },
      { source: 'coordination complex', target: '配位化合物' }
    ]
  },
  {
    id: 'chem-energy',
    facultyId: 'chem-mat',
    name: '催化科学、电化学与新能源',
    englishName: 'Catalysis, Electrochemistry & New Energy',
    summary: '聚焦电/光催化、二次电池电极电解液、燃料电池与原位表征机制。',
    defaultParadigm: 'exp',
    paradigms: ['exp', 'comp', 'design'],
    venues: ['Nature Energy', 'JACS', 'ACS Catalysis', 'Advanced Energy Materials'],
    searchTip: '重点精读活性位点调控、原位谱学证据（in-situ/operando）与全电池循环稳定性测试标准。',
    recommendedTags: ['电催化', '新能源电池', '原位表征'],
    starterGlossary: [
      { source: 'overpotential', target: '过电位' },
      { source: 'Tafel slope', target: '塔菲尔斜率' },
      { source: 'solid electrolyte interphase', target: '固体电解质界面膜（SEI）' },
      { source: 'Faradaic efficiency', target: '法拉第效率' },
      { source: 'cyclic voltammetry', target: '循环伏安法（CV）' }
    ]
  },
  {
    id: 'mat-polymer',
    facultyId: 'chem-mat',
    name: '高分子、纳米与功能材料',
    englishName: 'Polymers, Nanomaterials & Functional Devices',
    summary: '涵盖高分子可控聚合、晶体微观形貌调控、光电/热电材料与构效关系。',
    defaultParadigm: 'design',
    paradigms: ['design', 'exp', 'comp'],
    venues: ['Nature Materials', 'Advanced Materials', 'Macromolecules'],
    searchTip: '围绕“制备工艺 — 微观形貌（SEM/TEM/XRD）— 力学/光电性能”建立材料结构对比表。',
    recommendedTags: ['高分子材料', '构效关系', '功能器件'],
    starterGlossary: [
      { source: 'crystallinity', target: '结晶度' },
      { source: 'glass transition temperature', target: '玻璃化转变温度（Tg）' },
      { source: 'self-assembly', target: '自组装' },
      { source: 'tensile strength', target: '拉伸强度' },
      { source: 'band gap', target: '带隙' }
    ]
  },
  {
    id: 'env-carbon',
    facultyId: 'chem-mat',
    name: '环境科学与双碳工程',
    englishName: 'Environmental Science & Carbon Neutrality',
    summary: '研究污染控制与修复、碳捕集利用（CCUS）、生命周期评价与环境毒理。',
    defaultParadigm: 'exp',
    paradigms: ['exp', 'comp', 'design'],
    venues: ['Environmental Science & Technology', 'Water Research', 'Nature Climate Change'],
    searchTip: '在 Web of Science 与 ScienceDirect 中结合动力学拟合、生命周期评价（LCA）与实际水/气基质验证检索。',
    recommendedTags: ['环境工程', '碳捕集', '污染治理'],
    starterGlossary: [
      { source: 'life cycle assessment', target: '生命周期评价（LCA）' },
      { source: 'adsorption isotherm', target: '吸附等温线' },
      { source: 'carbon capture', target: '碳捕集' },
      { source: 'biodegradability', target: '生物可降解性' },
      { source: 'remediation', target: '环境修复' }
    ]
  },

  // 3. 数学、物理与地球天文
  {
    id: 'math-applied',
    facultyId: 'math-phys',
    name: '应用数学、统计与运筹优化',
    englishName: 'Applied Mathematics, Statistics & Optimization',
    summary: '研究偏微分方程、数值计算、数理统计推断、随机过程与凸/非凸优化。',
    defaultParadigm: 'theory',
    paradigms: ['theory', 'comp'],
    venues: ['SIAM Review', 'Annals of Statistics', 'Mathematical Programming'],
    searchTip: '优先使用 MathSciNet、zbMATH 与 arXiv (math)，精读主定理前提条件、反例与证明主线。',
    recommendedTags: ['偏微分方程', '统计推断', '凸优化'],
    starterGlossary: [
      { source: 'convergence rate', target: '收敛阶 / 收敛速率' },
      { source: 'well-posedness', target: '适定性' },
      { source: 'asymptotic normality', target: '渐近正态性' },
      { source: 'convex relaxation', target: '凸松弛' },
      { source: 'Lipschitz continuity', target: 'Lipschitz 连续性' }
    ]
  },
  {
    id: 'phys-quantum',
    facultyId: 'math-phys',
    name: '凝聚态物理与量子科学',
    englishName: 'Condensed Matter & Quantum Physics',
    summary: '聚焦关联电子体系、超导与拓扑物态、量子计算纠错与低维材料物性。',
    defaultParadigm: 'theory',
    paradigms: ['theory', 'exp', 'comp'],
    venues: ['Physical Review Letters', 'Physical Review B', 'Nature Physics'],
    searchTip: '追踪 arXiv (cond-mat / quant-ph) 与 APS 期刊，先整理哈密顿量模型再对照低温/输运实验图。',
    recommendedTags: ['凝聚态物理', '量子调控', '能带拓扑'],
    starterGlossary: [
      { source: 'topological insulator', target: '拓扑绝缘体' },
      { source: 'superconductivity', target: '超导电性' },
      { source: 'Hamiltonian', target: '哈密顿量' },
      { source: 'quantum entanglement', target: '量子纠缠' },
      { source: 'density of states', target: '态密度（DOS）' }
    ]
  },
  {
    id: 'phys-astro',
    facultyId: 'math-phys',
    name: '光学、高能物理与天体物理',
    englishName: 'Optics, High-Energy & Astrophysics',
    summary: '覆盖超快非线性光学、量子光学、粒子物理探测与星系演化多波段观测。',
    defaultParadigm: 'exp',
    paradigms: ['exp', 'theory', 'comp'],
    venues: ['Optica', 'Physical Review D', 'Astrophysical Journal'],
    searchTip: '按 APS / OSA / NASA ADS 检索“光源或探测器装置 + 光谱/截面测量 + 系统误差预算”。',
    recommendedTags: ['超快光学', '天体观测', '高能物理'],
    starterGlossary: [
      { source: 'interferometry', target: '干涉测量' },
      { source: 'redshift', target: '红移' },
      { source: 'spectroscopy', target: '光谱学' },
      { source: 'signal-to-noise ratio', target: '信噪比（SNR）' },
      { source: 'photon counting', target: '光子计数' }
    ]
  },
  {
    id: 'earth-climate',
    facultyId: 'math-phys',
    name: '地球科学、大气与海洋科学',
    englishName: 'Earth, Atmospheric & Marine Sciences',
    summary: '关注气候系统模式、大气物理化学、地球动力学与定量遥感反演。',
    defaultParadigm: 'comp',
    paradigms: ['comp', 'exp', 'theory'],
    venues: ['Nature Geoscience', 'JGR', 'Geophysical Research Letters'],
    searchTip: '在 AGU / Web of Science 检索中重点关注观测再分析数据集（ERA5/CMIP6）与数值模式不确定性。',
    recommendedTags: ['气候模式', '地球科学', '遥感观测'],
    starterGlossary: [
      { source: 'paleoclimate', target: '古气候' },
      { source: 'remote sensing', target: '遥感' },
      { source: 'radiative forcing', target: '辐射强迫' },
      { source: 'tectonic plate', target: '构造板块' },
      { source: 'reanalysis dataset', target: '再分析数据集' }
    ]
  },

  // 4. 信息、电子与计算机
  {
    id: 'ee-chip',
    facultyId: 'info-cs',
    name: '电子信息、通信与集成电路',
    englishName: 'Electronics, Communications & VLSI',
    summary: '涵盖无线通信、射频与模拟/数字集成电路、EDA 综合与信号处理。',
    defaultParadigm: 'design',
    paradigms: ['design', 'theory', 'comp'],
    venues: ['IEEE JSSC', 'IEEE TWC', 'ISSCC', 'IEEE TSP'],
    searchTip: '在 IEEE Xplore 围绕指标权衡（功耗-带宽-面积 PPA 或频谱效率）对比工艺节点与架构演进。',
    recommendedTags: ['集成电路', '无线通信', '信号处理'],
    starterGlossary: [
      { source: 'analog-to-digital converter', target: '模数转换器（ADC）' },
      { source: 'MIMO', target: '多输入多输出' },
      { source: 'power efficiency', target: '功率效率' },
      { source: 'bandgap reference', target: '带隙基准源' },
      { source: 'register transfer level', target: '寄存器传输级（RTL）' }
    ]
  },
  {
    id: 'ctrl-robot',
    facultyId: 'info-cs',
    name: '控制科学与智能机器人',
    englishName: 'Control Science & Robotics',
    summary: '专注最优/鲁棒控制、SLAM 状态估计、灵巧操作与多智能体协同规划。',
    defaultParadigm: 'design',
    paradigms: ['design', 'theory', 'comp'],
    venues: ['IEEE TAC', 'Automatica', 'IJRR', 'IEEE TRO'],
    searchTip: '关注系统动力学建模、李雅普诺夫稳定性证明与真机实验中的鲁棒性边界。',
    recommendedTags: ['控制理论', '机器人', '状态估计'],
    starterGlossary: [
      { source: 'model predictive control', target: '模型预测控制（MPC）' },
      { source: 'Lyapunov stability', target: '李雅普诺夫稳定性' },
      { source: 'kinematics', target: '运动学' },
      { source: 'state estimation', target: '状态估计' },
      { source: 'sim-to-real transfer', target: '仿真到现实迁移' }
    ]
  },
  {
    id: 'cs-ai',
    facultyId: 'info-cs',
    name: '人工智能与机器学习',
    englishName: 'Artificial Intelligence & Machine Learning',
    summary: '研究机器学习理论、大语言模型、多模态感知生成与科学智能（AI4Science）。',
    defaultParadigm: 'comp',
    paradigms: ['comp', 'theory'],
    venues: ['NeurIPS', 'ICML', 'ICLR', 'IEEE TPAMI'],
    searchTip: '按任务基准、理论/机制解释与受控消融实验进行分类梳理，避免只追逐榜单分数。',
    recommendedTags: ['机器学习', '泛化理论', '科学智能'],
    starterGlossary: [
      { source: 'attention mechanism', target: '注意力机制' },
      { source: 'generalization bound', target: '泛化界' },
      { source: 'ablation study', target: '消融实验' },
      { source: 'out-of-distribution', target: '分布外（OOD）' },
      { source: 'reinforcement learning', target: '强化学习' }
    ]
  },
  {
    id: 'cs-sys',
    facultyId: 'info-cs',
    name: '计算机系统、数据库与网络',
    englishName: 'Computer Systems, Databases & Networking',
    summary: '研究分布式共识、存储与查询引擎优化、体系结构及高速网络传输。',
    defaultParadigm: 'design',
    paradigms: ['design', 'comp', 'theory'],
    venues: ['SOSP', 'OSDI', 'SIGMOD', 'VLDB'],
    searchTip: '在 DBLP 与 ACM DL 中先抓工作负载假设与瓶颈定位，再拆解系统并发/一致性折中。',
    recommendedTags: ['分布式系统', '数据库', '性能剖析'],
    starterGlossary: [
      { source: 'latency', target: '延迟（Latency）' },
      { source: 'throughput', target: '吞吐量' },
      { source: 'fault tolerance', target: '容错' },
      { source: 'concurrency control', target: '并发控制' },
      { source: 'incremental view maintenance', target: '增量视图维护' }
    ]
  },

  // 5. 机械、土木与航空电气
  {
    id: 'mech-mfg',
    facultyId: 'eng-mech',
    name: '机械工程、先进制造与力学',
    englishName: 'Mechanical Engineering & Mechanics',
    summary: '聚焦精密/增材制造、固体断裂力学、摩擦学、振动控制与有限元仿真。',
    defaultParadigm: 'design',
    paradigms: ['design', 'comp', 'exp'],
    venues: ['Int. J. Mach. Tools Manuf.', 'JMPS', 'Additive Manufacturing'],
    searchTip: '在 ScienceDirect / ASME 关注本构关系、有限元仿真验证与真实样件疲劳/精度测试。',
    recommendedTags: ['精密制造', '固体力学', '有限元'],
    starterGlossary: [
      { source: 'finite element analysis', target: '有限元分析（FEA）' },
      { source: 'constitutive model', target: '本构模型' },
      { source: 'fatigue life', target: '疲劳寿命' },
      { source: 'additive manufacturing', target: '增材制造' },
      { source: 'residual stress', target: '残余应力' }
    ]
  },
  {
    id: 'aero-power',
    facultyId: 'eng-mech',
    name: '航空航天与能源动力工程',
    englishName: 'Aerospace & Power Engineering',
    summary: '研究计算流体力学（CFD）、气动热力学、推进燃烧与能源系统热管理。',
    defaultParadigm: 'comp',
    paradigms: ['comp', 'exp', 'design'],
    venues: ['Journal of Fluid Mechanics', 'AIAA Journal', 'Combustion and Flame'],
    searchTip: '围绕湍流模型、马赫数/雷诺数条件及风洞实验对标，梳理数值格式与物理机理。',
    recommendedTags: ['计算流体', '气动热力', '推进系统'],
    starterGlossary: [
      { source: 'computational fluid dynamics', target: '计算流体力学（CFD）' },
      { source: 'boundary layer', target: '边界层' },
      { source: 'turbulence modeling', target: '湍流建模' },
      { source: 'specific impulse', target: '比冲' },
      { source: 'heat transfer coefficient', target: '传热系数' }
    ]
  },
  {
    id: 'civil-trans',
    facultyId: 'eng-mech',
    name: '土木建筑与智慧交通工程',
    englishName: 'Civil & Transportation Engineering',
    summary: '面向结构抗震韧性、岩土地下工程、新型混凝土材料与交通流网络优化。',
    defaultParadigm: 'design',
    paradigms: ['design', 'exp', 'comp'],
    venues: ['Engineering Structures', 'Transportation Research Part B', 'Cement and Concrete Research'],
    searchTip: '兼顾规范条文、缩尺模型/振动台试验与城市交通多源数据实证分析。',
    recommendedTags: ['结构抗震', '岩土工程', '交通优化'],
    starterGlossary: [
      { source: 'seismic resilience', target: '抗震韧性' },
      { source: 'constitutive relation', target: '应力-应变本构关系' },
      { source: 'traffic assignment', target: '交通分配' },
      { source: 'structural health monitoring', target: '结构健康监测' },
      { source: 'bearing capacity', target: '承载力' }
    ]
  },

  // 6. 农学、食品与生态资源
  {
    id: 'agri-crop',
    facultyId: 'agri-eco',
    name: '作物育种、植物科学与智慧农业',
    englishName: 'Crop Breeding, Plant Science & Smart Agriculture',
    summary: '关注植物抗逆调控、重要农艺性状基因定位（QTL）、种质创新与表型组学。',
    defaultParadigm: 'exp',
    paradigms: ['exp', 'comp', 'design'],
    venues: ['Nature Plants', 'Plant Cell', 'Molecular Plant'],
    searchTip: '按“基因定位（QTL）— 分子机制 — 田间小区产量/抗逆表型”在 PubMed 与 AGRIS 检索对比。',
    recommendedTags: ['植物科学', '分子育种', '表型组学'],
    starterGlossary: [
      { source: 'quantitative trait locus', target: '数量性状基因座（QTL）' },
      { source: 'abiotic stress', target: '非生物胁迫' },
      { source: 'germplasm', target: '种质资源' },
      { source: 'phenotyping', target: '表型组测定' },
      { source: 'yield stability', target: '产量稳定性' }
    ]
  },
  {
    id: 'food-eco',
    facultyId: 'agri-eco',
    name: '食品科学与生态资源保护',
    englishName: 'Food Science & Ecology Conservation',
    summary: '覆盖食品风味营养递送、安全检测以及生物多样性、群落生态与生态修复。',
    defaultParadigm: 'exp',
    paradigms: ['exp', 'comp'],
    venues: ['Food Chemistry', 'Trends in Food Science & Technology', 'Ecology Letters'],
    searchTip: '食品方向注重理化与消化模型，生态方向关注样方尺度、环境协变量与长期观测序列。',
    recommendedTags: ['食品科学', '生态保护', '营养递送'],
    starterGlossary: [
      { source: 'bioavailability', target: '生物利用度' },
      { source: 'emulsion stability', target: '乳液稳定性' },
      { source: 'biodiversity', target: '生物多样性' },
      { source: 'trophic cascade', target: '营养级联' },
      { source: 'ecosystem services', target: '生态系统服务' }
    ]
  },

  // 7. 经济、管理与金融
  {
    id: 'econ-causal',
    facultyId: 'econ-mgmt',
    name: '理论/应用经济学与因果推断',
    englishName: 'Economics & Causal Inference',
    summary: '聚焦微观计量识别（DID/IV/RDD）、宏观经济建模、发展与公共政策评估。',
    defaultParadigm: 'theory',
    paradigms: ['theory', 'comp'],
    venues: ['AER', 'Econometrica', 'QJE', '《经济研究》'],
    searchTip: '优先在 NBER、RePEc 与知网梳理识别策略（DID/IV/RDD），严格核查平行趋势与排他性约束。',
    recommendedTags: ['计量经济', '因果识别', '政策评估'],
    starterGlossary: [
      { source: 'difference-in-differences', target: '双重差分法（DID）' },
      { source: 'instrumental variable', target: '工具变量（IV）' },
      { source: 'endogeneity', target: '内生性' },
      { source: 'general equilibrium', target: '一般均衡' },
      { source: 'heterogeneous treatment effect', target: '异质性处理效应' }
    ]
  },
  {
    id: 'fin-mgmt',
    facultyId: 'econ-mgmt',
    name: '金融工程、公司金融与管理科学',
    englishName: 'Finance, Risk & Management Science',
    summary: '涵盖资产定价、公司治理实证、随机库存与供应链运营优化。',
    defaultParadigm: 'comp',
    paradigms: ['comp', 'theory', 'design'],
    venues: ['Journal of Finance', 'Management Science', 'Operations Research'],
    searchTip: '结合 SSRN 工作论文与顶刊正式版，分别记录理论命题推导、数据结构与稳健性检验。',
    recommendedTags: ['实证金融', '供应链运营', '管理科学'],
    starterGlossary: [
      { source: 'asset pricing', target: '资产定价' },
      { source: 'information asymmetry', target: '信息不对称' },
      { source: 'supply chain coordination', target: '供应链协调' },
      { source: 'robustness check', target: '稳健性检验' },
      { source: 'moral hazard', target: '道德风险' }
    ]
  },

  // 8. 人文、法政、心理与教育
  {
    id: 'psych-edu',
    facultyId: 'human-soc',
    name: '认知心理学与教育科学',
    englishName: 'Cognitive Psychology & Education Science',
    summary: '研究注意记忆神经心理机制、学习科学、心理测量量表及教育干预实验。',
    defaultParadigm: 'exp',
    paradigms: ['exp', 'comp', 'theory'],
    venues: ['Psychological Review', 'J. Educational Psychology', '《心理学报》'],
    searchTip: '在 PsycINFO、ERIC 与知网按“实验范式 / 量表信效度 / 被试群体与效应量”整理文献卡。',
    recommendedTags: ['认知心理', '实验范式', '教育科学'],
    starterGlossary: [
      { source: 'working memory', target: '工作记忆' },
      { source: 'effect size', target: '效应量' },
      { source: 'longitudinal study', target: '纵向研究' },
      { source: 'cognitive load', target: '认知负荷' },
      { source: 'psychometric validity', target: '心理测量效度' }
    ]
  },
  {
    id: 'law-soc',
    facultyId: 'human-soc',
    name: '法学、社会学与数字人文',
    englishName: 'Law, Sociology & Digital Humanities',
    summary: '面向规范法理与比较法、田野社会调查、政治学及语料库数字人文研究。',
    defaultParadigm: 'theory',
    paradigms: ['theory', 'exp', 'comp'],
    venues: ['American Journal of Sociology', 'Harvard Law Review', '《中国社会科学》'],
    searchTip: '兼顾知网、HeinOnline、SSRN 与档案文献库，明确理论对话脉络、田野材料或判例谱系。',
    recommendedTags: ['法学社科', '田野调查', '数字人文'],
    starterGlossary: [
      { source: 'ethnography', target: '民族志 / 田野调查' },
      { source: 'jurisprudence', target: '法理学' },
      { source: 'discourse analysis', target: '话语分析' },
      { source: 'grounded theory', target: '扎根理论' },
      { source: 'empirical legal studies', target: '实证法学研究' }
    ]
  }
]

const FACULTY_MAP = new Map(RESEARCH_FACULTIES.map(f => [f.id, f]))
const TRACK_MAP = new Map(RESEARCH_TRACK_OPTIONS.map(t => [t.id, t]))
const PARADIGM_MAP = new Map(RESEARCH_PARADIGM_OPTIONS.map(p => [p.id, p]))
const GOAL_MAP = new Map(RESEARCH_GOAL_OPTIONS.map(g => [g.id, g]))

export function getFacultyById(facultyId: string): ResearchFacultyOption | undefined {
  return FACULTY_MAP.get(facultyId)
}

export function getTrackById(trackId: string): ResearchTrackOption | undefined {
  return TRACK_MAP.get(trackId)
}

export function getTracksByFaculty(facultyId: string): readonly ResearchTrackOption[] {
  if (!facultyId) return RESEARCH_TRACK_OPTIONS
  return RESEARCH_TRACK_OPTIONS.filter(track => track.facultyId === facultyId)
}

export function getParadigmById(paradigm: ResearchParadigm): ResearchParadigmOption | undefined {
  return PARADIGM_MAP.get(paradigm)
}

export function getGoalById(goal: ResearchReadingGoal): ResearchReadingGoalOption | undefined {
  return GOAL_MAP.get(goal)
}

/** 根据新生 3 步引导选择（门类/研究范式/阅读目标/关键词）推荐最匹配的 3 个方向。 */
export function recommendTracksForGuidance(input: GuidedOnboardingInput): TrackRecommendation[] {
  const customLower = input.customTopic.trim().toLowerCase()
  const tokens = customLower
    .split(/[\s,，、/；;|+]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2)

  const paradigmOption = getParadigmById(input.paradigm)
  const goalOption = getGoalById(input.readingGoal)

  const scored = RESEARCH_TRACK_OPTIONS.map((track, index) => {
    let score = 0
    const reasons: string[] = []
    const faculty = getFacultyById(track.facultyId)

    if (input.facultyId && track.facultyId === input.facultyId) {
      score += 6
      if (faculty) reasons.push(`契合「${faculty.name}」`)
    }

    if (track.defaultParadigm === input.paradigm) {
      score += 4
      if (paradigmOption) reasons.push(`主研究范式匹配「${paradigmOption.label}」`)
    } else if (track.paradigms.includes(input.paradigm)) {
      score += 2
      if (paradigmOption) reasons.push(`兼顾「${paradigmOption.label}」`)
    }

    if (customLower.length >= 2) {
      const keywords = [
        track.name,
        track.englishName,
        ...track.recommendedTags,
        ...track.venues,
        ...track.starterGlossary.flatMap(g => [g.source, g.target])
      ]
      const searchable = `${keywords.join(' ')} ${track.summary}`.toLowerCase()
      let matchedCount = 0
      for (const token of tokens) {
        if (searchable.includes(token)) matchedCount += 1
      }
      // 兼容连续中文词组（如「电催化过电位」未加空格时仍能命中标签或术语词条）
      const seenReverse = new Set<string>()
      for (const kw of keywords) {
        const cleanKw = kw.replace(/（.*?）|\(.*?\)/g, '').trim().toLowerCase()
        if (cleanKw.length >= 2 && !seenReverse.has(cleanKw) && customLower.includes(cleanKw)) {
          seenReverse.add(cleanKw)
          matchedCount += 1
        }
      }
      if (matchedCount > 0) {
        score += matchedCount * 5
        reasons.push('与你的研究关键词高度相关')
      }
    }

    if (reasons.length === 0 && goalOption) {
      reasons.push(`适配「${goalOption.label}」阅读路径`)
    }

    return { track, score, reasons, index }
  })

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.index - b.index
  })

  return scored.slice(0, 3).map(({ track, score, reasons }) => ({ track, score, reasons }))
}

/** 合并所选研究方向的初始中英术语表（按原文大小写不敏感去重，最多 60 条）。 */
export function collectStarterGlossary(trackIds: readonly string[]): GlossaryEntry[] {
  const seen = new Set<string>()
  const entries: GlossaryEntry[] = []
  for (const id of trackIds) {
    const track = TRACK_MAP.get(id)
    if (!track) continue
    for (const item of track.starterGlossary) {
      const key = item.source.trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      entries.push({ source: item.source, target: item.target })
      if (entries.length >= 60) return entries
    }
  }
  return entries
}

/** 清洗并生成文献库预设标签（严格不含前导 `#`，适配 LibraryPanel 统一加 `#` 展示）。 */
export function collectRecommendedTags(
  trackIds: readonly string[],
  customTopic: string,
  readingGoal: ResearchReadingGoal
): string[] {
  const seen = new Set<string>()
  const tags: string[] = []

  const pushTag = (raw: string): void => {
    if (tags.length >= 8) return
    const stripped = raw.replace(/^#+/, '').trim()
    if (!stripped || hasControlCharacters(stripped)) return
    const clean = stripped.slice(0, 32).trim()
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) return
    seen.add(key)
    tags.push(clean)
  }

  const trimmedCustom = customTopic.trim()
  if (trimmedCustom) {
    const firstSegment = trimmedCustom.split(/[,，、;；\n]/)[0]?.trim() ?? trimmedCustom
    pushTag(firstSegment.slice(0, 16))
  }

  for (const id of trackIds) {
    const track = TRACK_MAP.get(id)
    if (!track) continue
    for (const tag of track.recommendedTags) {
      pushTag(tag)
    }
  }

  const goalOpt = getGoalById(readingGoal)
  if (goalOpt) pushTag(goalOpt.tag)

  return tags
}

/** 生成注入 AI 翻译与选区解读提示词的简明全学科背景摘要；跳过或未配置时返回空串。 */
export function buildResearchContextSummary(profile: ResearchProfile | null): string {
  if (!profile || profile.mode === ('skipped' satisfies ResearchOnboardingMode)) return ''
  const trackNames = profile.selectedTrackIds
    .map(id => TRACK_MAP.get(id)?.name)
    .filter((name): name is string => Boolean(name))
  const custom = profile.customTopic.trim()
  if (trackNames.length === 0 && !custom) return ''

  const faculty = profile.facultyId ? FACULTY_MAP.get(profile.facultyId) : undefined
  const paradigm = getParadigmById(profile.paradigm)
  const goal = getGoalById(profile.readingGoal)

  const fieldParts: string[] = []
  if (faculty) fieldParts.push(`所属学科门类为「${faculty.name}」`)
  if (trackNames.length > 0) fieldParts.push(`细分方向涉及 ${trackNames.join('、')}`)
  if (custom) fieldParts.push(`具体研究课题聚焦「${custom}」`)

  const focusParts: string[] = []
  if (paradigm) focusParts.push(`科研范式偏重「${paradigm.label}」（${paradigm.readingTip}）`)
  if (goal) focusParts.push(`当前阅读目标为「${goal.label}」`)

  return `${fieldParts.join('，')}。${focusParts.join('；')}。请按该学科规范中文术语精准表达。`
}

/** 生成顶部标题栏研究方向按钮的简洁文案；未设置或跳过时返回 null。 */
export function formatResearchProfileBadge(profile: ResearchProfile | null): string | null {
  if (!profile || profile.mode === 'skipped') return null
  const custom = profile.customTopic.trim()
  const firstTrack = profile.selectedTrackIds.map(id => TRACK_MAP.get(id)).find(Boolean)
  if (!custom && !firstTrack) return null

  const faculty = (profile.facultyId ? FACULTY_MAP.get(profile.facultyId) : undefined) ?? (firstTrack ? FACULTY_MAP.get(firstTrack.facultyId) : undefined)
  const label = custom || firstTrack?.name || ''
  const raw = faculty ? `${faculty.shortName} · ${label}` : label
  return raw.length > 22 ? `${raw.slice(0, 21)}…` : raw
}
