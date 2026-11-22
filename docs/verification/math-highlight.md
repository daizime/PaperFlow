# 公式与相邻行蓝框连续性：原创合成验证

任务 `PFV-READER-006 / 20261122-math-highlight-reader-01`，基线 `PF-OVERLAP-20261122-03`。以用户最新澄清为准：目标是连接选中范围内的蓝框断白，包含公式内小横空档和两条已选行共有水平范围内的竖缝。**不再把裁掉运算符上凸或收紧字形外框作为通过条件。** 澄清前仅拟案，未执行旧方向的CSS探针，无旧运行结果需要转作新结论。

## 素材与独立内容校验

生成器为 `scripts/verification/generate-math-highlight-fixture.ts`，产物在 `tests/fixtures/verification/math-highlight/`。素材全部原创合成，不读取用户文献库、不搜索原论文、不转录用户截图文字。标准正文、放大的Symbol运算符和真实上下标共同组成第一行，第二行为同一选区内的原创正文；另设未选标题与远哨兵。数学字串仅是测试素材，不表达科学事实，也不承诺复制为LaTeX。

PDF、manifest与实际Node PDF.js提取审计分别记录原始绘制顺序、字体、advance、固定PDF点、完整期望字符及安全连接候选窗口。已提交100%一个固定案例；150%或旋转尚未补测，需沿用同一PDF点和同一内容断言，不能在失败后移动点。

`math-selection-continuity.pdf` 为2801字节，SHA256 `b7fdd3ab14a9d315e138b9f44a8642bc4944c2b576a2834f1d39dc8917b94b31`；固定跨两行点为 `(64.4,516) → (422.034,486)`。实际提取目标为 `pi ⊕q2 = r` 与 `Selected lower row keeps these symbols together.` 两行，只允许忽略空白，不删除、替换或重排其他字符。

```powershell
pnpm exec tsx scripts/verification/generate-math-highlight-fixture.ts
```

## 连续性与安全范围

真实鼠标点只由固定PDF坐标和Canvas CSS页面框生成。TextLayer节点与Range仅用于手势完成后的只读测量，不反过来瞄准，也不编程建立测试选区。Selection及真实Ctrl+C都必须精确匹配已选两行，标题、哨兵和未选字符不得夹入；内容错误先单独标识，不能称作单纯高亮外形问题。

横向连接窗只位于两个已选部分之间的小空档，并取两侧共同的纵向带。竖缝窗位于上行普通正文尾部与下行正文共有的x范围，避开大运算符已经覆盖的局部。不能用整行最大高度判断白缝，因为大符号可掩盖另一列仍然断开的接缝。

选前PNG只用来确认原背景和排除实际墨迹、抗锯齿及矢量线。上下标即使字号较小也是真实字符，不得作为空白裁掉。选后PNG的连接窗应与同帧、单覆盖正文中的实际蓝色一致；参考色从截图测得，不固定套用用户截图的RGB。QA需对照同一素材和固定点的旧/新PNG，分别记录旧版仍白与新版着蓝的实际像素，不能凭CSS类名或矩形存在宣称连续。

负向区域包括选区末尾之外、标题、未选哨兵、宽栏缝、段落间隔及页间背景。只允许连接有明确选中来源的局部接缝，不能把两行整体包围盒或整页填蓝。本例未覆盖的跨页、强制配色及失焦行为须保留为未验证。

所有前后截图保持相同CSS像素尺寸、页面框、滚动、缩放及焦点状态；`scale: 'css'` 后按CSS坐标取样，不乘DPR。4个固定连接窗含最小4×3 PDF单位小窗，初版预设每窗至少4个白底像素、2列/2行；参考正文至少64样本、较大守卫窗至少32样本。参考蓝色使用实际选后普通正文的中位RGB，最大通道差14内算同蓝；连接窗同蓝比例至少95%，各行/列至少90%，守卫留白至少95%。这些均为预设测试判据，不是实测结果。

脚本分别记录 `selection-content`、`script-precondition`、`product-selection-shape` 失败类别。完整选文和真实复制先于形状断言；样本不足或几何前提不成立要明确报告，不能当产品外形已经失败或通过。无论成功或失败，finally都保存原样PNG、Selection/Range与原始RGB。

## 执行边界与旧问题

本任务只新增素材和用例，不改产品源码或既有选择/重叠用例。reader仅运行生成器、静态PDF预览及自己的局部TS/lint；Electron、GUI、构建、公共检查和包测由QA独占。

公开DrawLayer的原Range矩形union可消除叠深，但不会填补彼此分离的间隙。本任务只提供连续性证据，产品算法由主控决定。reader005的叠色证据和r9分子仅复制 `a` 的内容故障继续独立保留，不能用本例的视觉通过抵销。

实际已执行：生成、Node PDF.js非空白字符/顺序及页几何审计，四输出重复生成hash一致；前导空格拆item使首轮严格审计失败，原日志保留。Poppler退出0却缺失Symbol运算符，其预览不能证明公式完整。随后使用现有Node PDF.js及@napi-rs/canvas、随包标准字体静态渲染，`⊕`、上下标及两行完整可辨；该预览没有浏览器Selection。

局部strict及零警告lint均实际退出0，日志在本任务cache：

```powershell
pnpm exec tsc --noEmit -p .cache/reader/20261122-math-highlight-reader-01/tsconfig.tests.json
pnpm exec eslint scripts/verification/generate-math-highlight-fixture.ts tests/e2e/math-highlight.spec.ts --max-warnings=0
```

当前可跑一个100%/DPR1案例，由QA在冻结旧/新候选及隔离目录执行：

```powershell
pnpm exec playwright test tests/e2e/math-highlight.spec.ts --workers=1 --retries=0
```

文件hash和生成/预览审计见 `.cache/reader/20261122-math-highlight-reader-01/`。reader未运行Electron、GUI、build或E2E；真实断白、守卫安全及修复效果在QA运行前均为未验证。

## 2026-11-22 实测结果（Worktree: `init_paperflow_desktop`）

1. **已真实通过**：
   - `tests/unit/selection-bridges.test.ts`：**6/6 通过**。
   - `tests/e2e/math-highlight.spec.ts`（`--workers=1 --retries=0`）：
     - 源码构建 `out/main/index.js`：**3/3 通过**（跨两行公式+正文连续蓝 100% DPR1、仅选公式 100% DPR1、仅选公式 150% DPR1）。
     - Windows 打包程序 `release/win-unpacked/PaperFlow.exe`：**3/3 通过**。
   - 同步关联回归：`tests/e2e/selection-overlap.spec.ts` **6/6 通过**，[selection-verification.spec.ts](../../tests/e2e/selection-verification.spec.ts) **26/26 通过**（源码与打包 `.exe` 均全过）。
2. **仍未验证的边界**：150% 及直角旋转下的跨两行公式连续选区、Windows 高对比度（forced-colors）、跨页公式选区、失焦选区颜色及非合成真实科研论文样本仍未覆盖，不据此宣称全场景通过。
