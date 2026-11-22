# 空白拖拽选区验证

2026-11-22，PFV-QA-004 / 20261028-selection-regression-01。**UI03新包独立基础界面2例预览通过，但整包48门禁为22通过、1失败、25未运行，不能接受交付。** 稳定性12未执行，桌面已停止。首次源码Geom失败及历史revision8编译失败、14包37/3均保留，后续成功不代表根因已修。

## revision9：UI预览通过，整包门禁失败

冻结`PF-UI-20261122-03`与UI02清单仅`tests/e2e/workspace-ui.spec.ts`变化，普通Promise替换不兼容写法；QA未改共享测试/产品/配置。起始/构建后155项及ZIP核验通过，仅本模块获准QA说明文档差异，历史8产物hash不变。`r9-01-typecheck`、`r9-02-lint`、`r9-03-unit`、`r9-04-build`均退出0；单测为本轮实际5文件59/59，不是复用旧结果，209项out的路径/大小/SHA已保存。阶段Node探测仍v24.21.0/<local-node>。

`r9-05-source-ui-2`明确清除PAPERFLOW_EXECUTABLE，使用刚构建的out/main/index.js。实际2/2过，0跳过/重试/flaky、退出0，报告时长7566.1ms。验证空库、忙状态共享、真实导入后的Canvas/TextLayer、取消不丢搜索、导入/去重通知和搜索不切换当前阅读文献。原生文件框返回值注入，原创合成valid.pdf等后续导入/复制/DB/界面真实执行；不是原生文件框全流程自动化，也不表明翻译功能已实现。

真实空屏和阅读PNG原始附件已提取，便于展示的字节一致副本在`r9-05-source-ui-2/ui-screenshots/paperflow-empty-workspace.png`和`paperflow-reading-workspace.png`，大小/SHA在`ui-screenshots.json`及模块信号。已目视检查，空屏入口和阅读内容可见。自有Electron PID29008/26800日志均正常退出0；阶段末另见旧release/win-unpacked用户实例PID21484及子进程，未操作/关闭。

`r9-06-source-selection-26`实际26/26过、0跳过/重试/flaky、退出0，102008.71800000001ms。原20的74手势/230phase及H6独立只读审查见`r9-selection-readonly-audit.md`：采样点目标字符/端点/复制正确，跨页完整预期合法包含OTHER/REMOTE；mouseup/Escape各16样本停止时仍有滚动余量。原20只覆盖段末phase，H约25ms采样且无独立pageerror收集，不覆盖采样间隙。

`r9-07-source-original-20`以`--max-failures=1`实际10通过、1失败、9未执行，0重试/flaky、退出1，53565.280000000006ms。唯一失败为`PFV rotated CropBox/UserUnit layers and selection at simulated DPR 3`原262行，期望包含Geometry marker 13、实际Geom。具体发生于page13、rotation0°、larger60%：此前fit50%选择已通过，随后16步真实鼠标拖动后部分选区不完整。失败时Canvas为750×1050 CSS/2250×3150像素，Canvas/TextLayer四项对齐差均0；此前导航4秒共571样本稳定，runtime failures数组空。这是源码运行后的选区行为失败，不是UI2/测试编译/打包失败，具体内部原因尚未建立。

原测试只保留几何/导航样本和断言错误，没有拖动phase/取消事件/实际起终点记录或失败PNG，不能据Geom直接认定native drag或边缘滚动。原始JSON、日志及附件已提取至r9-07；汇总`r9-source-gate-summary.json`核三组源码48范围为38通过/1失败/9未执行，209项out未漂移，155/ZIP保护输入无差异，仅授权QA文档差异，历史8产物不变，所有自有根进程日志退出0。没有打包、新包48或稳定性9，UI03输出目录不存在。主控仅追加一次同失败DPR3私有被动探针，正在准备，原失败不覆盖。

后续均由主控逐项追加授权，独立证据不覆盖上述初次失败：

- r9-08同原DPR3流程的唯一私有探针实际1/1过、退出0，12个缩放/旋转context完整；page13/60%的1次down、16步move、up期间Top7326/Left0恒定，无drag/cancel、层移除或实际window blur，anchor0/focus逐步至mouseup18，最终完整marker。只读审查见r9-geometry-trace-readonly-audit.md，完整事件3.7MB及minimal-facts在r9-08。context内下一次工具栏点击的事件不能混入前一拖选区间。监听有时序扰动，未读取内部guard/RAF；原案缺同等轨迹，不宣称实际点位完全相同。
- r9-09以原共享reader-verification.spec.ts精确后缀DPR 3匹配、repeat-each3/retries0，无观察器，实际3/3过、0跳过/flaky/重试，退出0、32977.801999999996ms。三份原样附件分别存case-01/02/03独立目录，没有同名覆盖。无观察器亦通过，不能把前后差异唯一归于观察器。
- r9-10按post_repeat_gate同03/out、同原6spec完整20再执行一次，实际20/20过、0跳过/重试/flaky、退出0，68266.80399999999ms。停止参数误沿用max-failures1，任务明确要求0；实际20均执行且无失败，提前停止分支未触发，command-deviation.json和原命令留存，不以补跑盖偏差。155/ZIP、209out及历史8产物再次无漂移，仅QA说明文档差异。

主控明确允许以上述新原20与已有UI2/选区26合为源码48门禁，没有额外再跑全部源码48。r9-11仅用同一out生成独立ui-20261122-03候选，不安装/发布，实际退出0；npmRebuild=false/publish=never，未重建out。r9-11/asar-out-audit.json核209/209逐字一致、无缺失/额外/链接，打包前后209out及历史8产物hash不变。精确grep已只读发现定向稳定性12（200% text/formula/fraction及Geometry DPR3各3），未误抓DPR1.5；因以下新包失败，没有执行稳定性。

### r9-12新包失败与r9-13单独UI预览

r9-12明确新UI03 EXE实际22通过/1失败/25未运行，0重试/flaky，退出1，103562.79199999999ms。失败为page1-200%/DPR2 fraction组第三条whole-fraction：应完整a+b与c+d（规范空白a+bc+d），实际选区和Ctrl+C均a。前两条分子正向、分母反向及复制正常。down为已连接分子Text0/0，move/up仍分子0→1；终点快照命中c+d，但不能把快照当作全部事件已送达的证明。共享原110行精确字符断言失败，原截图/phase/JSON/命令/退出码均保留，最小r9-12/minimal-failure.json。

失败setup与源码对应成功手势逐字一致，源码最终a+b换行c+d；该证据不含原生drag/cancel/私有手势状态，内部原因未定。原桌面20中14过6未运行；原选区20中8过1败11未运行，H6及UI2在此全48中均未运行。报告全局error仅max-failures停止通知，不是第二项产品错误。不能用源码通过补齐包未执行项。

按主控packaged_ui_preview_authorization，随后仅同一未验收03 EXE单独执行workspace-ui.spec.ts：实际stage为r9-13-packaged-ui-preview-2，2/2过、0跳过/重试/flaky、退出0，4484.631ms。任务建议名r9-13-new-package-ui-2对应此实际目录，未改执行内容。新包真实空屏/阅读PNG在该stage/ui-screenshots/，ui-screenshots.json与信号保存绝对路径/大小/SHA；从原JSON解码与副本逐份一致，已目视核对。与源码PNG恰好同hash，但原启动日志、command.executable、各自原JSON均证实独立实际运行。原生文件框仍返回值注入、素材原创合成，后续业务真实。

该追加结果仅限UI预览，不能替代r9-12整包失败。PID26364/26720退出0，所有自有测试根进程日志均退出0，当前无PaperFlow命名进程。最终155项/ZIP保护输入无漂移（仅获准QA说明差异），209out及4新/8历史产物大小/SHA未变，r9-final-summary.json汇总。没有继续诊断、重建、打包、稳定性12、安装/卸载、Git或发布；主控需后续明确派工。

本轮新候选准确绝对路径、大小、SHA与签名状态在`r9-11-package-ui03/artifacts.json`；安装包与EXE均NotSigned，未安装卸载：

| UI03独立产物 | 字节 | SHA256 |
| --- | ---: | --- |
| release/selection-fix/ui-20261122-03/PaperFlow-0.1.0-win-x64-setup.exe | 123000057 | fbab597edd0a5a576c9fd6eb06e8fa8ce242a38488821d951da94db16ab5154b |
| 同目录setup.exe.blockmap | 130415 | 35be9d8e654a7705d81be9c75ea9c0f1cf3c737d383d7face23bf21f1bf1c108 |
| ui-20261122-03/win-unpacked/PaperFlow.exe | 245590016 | 1ebf6e6b333633439a30a148905d2f611e466d7da1e5abee0c38a38d1afdd66c |
| 同解包目录resources/app.asar | 33311309 | 8af318e40b1d4ca61c23e993af38d51146d1b773fe641702474220f3b46bc312 |

包安全例固定旧preload路径的静态疑点已补做字节核对：旧基础包、14包及当前构建的preload/index.js均875字节、SHA256=fea025e3a611c57ead8e832ab229769fe5b0c3bb523c5948529bbea7f8add0f3，详`r9-preload-path-equivalence.json`。固定路径事实仍在，当前无payload内容差异证据；新包尚未生成。DPR仍是进程模拟，未做物理跨屏补验。

## revision8：冻结UI02，类型检查门禁失败

`PF-UI-20261122-02`起始及失败后155项/ZIP均无差异。两套历史setup/blockmap移入各自`安装包/`，两套旧EXE/ASAR未移动，8产物大小/SHA均匹配历史及迁移记录。

`r8-01-typecheck`实际运行`pnpm typecheck`，退出2：`tests/e2e/workspace-ui.spec.ts(12,42): TS2550: Property 'withResolvers' does not exist on type 'PromiseConstructor'`。新增UI测试调用`Promise.withResolvers<OpenDialogReturnValue>()`，`tsconfig.test.json`的lib为ES2022、DOM、DOM.Iterable，TypeScript5.9.3；这是**测试源码编译问题**，未启动应用，非桌面产品或宿主权限失败。阶段Node探测v24.21.0/<local-node>。准确命令、输出、退出码、运行时及失败输入快照在`r8-01-typecheck/`，独立归档`r8-typecheck-failure-report.md`。

按门禁在此停止，lint/unit/build/UI2/选区26/原20/打包/新包48/稳定性9均未执行，无UI PNG、无旧通过结论复用，新输出UI02不存在，无PaperFlow命名进程。没有改共享源码/spec/配置/断言。主控随后仅修正测试Promise写法并冻结UI03；继续使用r9-*独立证据，原失败不覆盖。

只读审计另发现`tests/e2e/security.spec.ts:18`在包模式创建额外窗口时，其preload固定取旧`release/win-unpacked/resources/app.asar/out/preload/index.js`，不会跟随新EXE路径。该例未运行，后续包安全证据需主控核对。UI2+选区原20/r8交互6+原桌面20共48例为静态核定数量，不是已执行结果。

## revision7：源码40通过，新包37过3败

`PF-SELECTION-20261028-14`，153项/ZIP起始及打包前后核验无差异；r7-01type/r7-02lint/r7-03build均退出0。`r7-unit-evidence-reuse.json`的43项输入哈希不变，明确复用冻结10的07-unit实际59/59，不称本轮重跑。

- r7-04-source-selection-20：20/20、0跳过/重试/flaky，退出0，93108.257ms。74手势/230个采样phase原始附件已保留，独立只读复核未发现采样点异处字符夹带，详`r7-readonly-phase-audit.md`；不覆盖段内每步或样本间瞬态。
- r7-05-source-original-20：仅原6个spec实际20/20，0跳过/重试/flaky，退出0，79836.026ms；与新20合计源码40，未额外重跑源码全40。
- r7-06-package：只执行指定electron-builder，不重建out、npmRebuild=false、publish=never，退出0；输出独立selection-fix。ASAR内209项out与已测构建完全一致，旧安装包/EXE/ASAR关键hash不变。
- r7-07-new-package-40：明确使用`release/selection-fix/win-unpacked/PaperFlow.exe`，实际37通过/3失败/0跳过/重试/flaky，退出1，187053.64800000002ms。文件测试后大小和SHA全部未变，不能接受新包交付。

3败均第1页200%/DPR2，原始`minimal-three-failures.json`包含源码通过与新包失败逐phase对照。3案完整setup逐字节相同（阅读客户区718×506及Canvas/scroll/点位），因此没有证据将差异归于这些几何设置不同：

| 失败手势 | 应选 | 实选及实际复制 | 已知phase |
| --- | --- | --- | --- |
| text-to-reader-gray | DOUBLECHECK | K | mousedown文字Text11/11；move/up为11/10，灰底命中pdf-pages |
| formula-to-blank | E=mc2+a1 | E=mc | 初始Text0/0；移至下标1命中该span，但focus停E=mc offset4，至空白/up仍然如此 |
| numerator-to-blank | a+b | a+b、c+d、REMOTE_FRACTION_7、FRACTION_BELOW_OTHER | 初始a+b Text0/0；move/up focus变成TextLayer DIV37，已出现真实异处夹带 |

该原40只保存阶段选区，没有足够drag/pointercancel/blur/层移除事件，内部原因尚未证实。以下诊断成功不能替代原37/3门禁失败；没有修改产品/点/阈值/原断言或覆盖r7-07，没有重建包或重跑完整40。

### r7追加打包差异被动诊断：未复现原3败

按主控追加授权，`r7-08-packaged-gap-diagnostic`只运行同新EXE的3个200%/DPR2原失败案，灰底保留原前5手势，配置exact testMatch以排除归档副本。3例实际均成功、退出0：灰底选中并复制DOUBLECHECK；公式为E=mc2 +a1；分子为a+b。`diagnostic-vs-failure-geometry.json`核对三案setup与原失败完全相同，Canvas及滚动坐标未漂移。

- 灰底案观测到1次真实dragstart，目标仍是已连接的DOUBLECHECK Text，DOM归属仍在原reader/layer内；捕获及queued microtask均defaultPrevented=true，dataTransfer纯文本为K，后续鼠标流最终完成DOUBLECHECK。没有观测到该次dragstart重定向至layer/root，也没有pointercancel。**这只说明本次成功诊断中的拖放被取消，不能倒推原失败时也如此。**
- 公式/分子成功案均无dragstart或pointercancel，没有初始文本层移除。记录的工具栏＋按钮blur、阅读区focus是元素焦点切换，document.hasFocus仍为true，不能当作窗口失焦。原始事件、选区和节点身份在各案JSON，压缩关键事实在`*-critical-events.json`。
- 观察器读取caret、选区、节点及几何，可能影响时序；ready时DOM集合仅为外部观察到的候选，不证明产品私有注册状态。内部guard未插桩，layer/root重定向假设尚未证实。

为降低干扰，`r7-09-minimal-fraction-trace`仅再运行原分子案，保留原PDF点、24步鼠标拖拽及端点选区/真实复制断言。没有mousemove监听、caret查询或逐字符扫描；只记录dragstart/dragend/pointercancel/lostpointercapture、真实window blur和初始TextLayer移除。实际1成功、退出0，选区和剪贴板均a+b，退出事件列表为空。其CSS Canvas/阅读区/scroll/点与原失败一致，但仍是附加观测，不能建立原失败时事件过程。

独立只读复核发现私有脚本“截图/剪贴板顺序相同”注释不准确：私有版先截图后写剪贴板，原版先写剪贴板后截图；增加监听也改变时序，是否影响复现未证实。原执行脚本保留并附`r7-minimal-fraction-equivalence-audit.md`更正，未据此重跑。极简版未收集原版pageerror；空事件不覆盖move配对、选区变化、内部控制器状态。MutationObserver限root子树childList，不能排除属性/文本替换或root从外部父节点移除。

两次诊断自有PID33200/48712/49628/52048均正常退出0，当前无PaperFlow命名进程。`r7-packaged-diagnostics-summary.json`核209项out及新4产物大小/SHA全部未变；`r7-baseline-14-after-packaged-diagnostics.json`核153项/ZIP，只有授权的QA与总体验证说明文档差异，保护源码/测试/配置无漂移、旧包不变。当前停止桌面执行，提交失败门禁与未复现诊断供主控处理；不据未经证实的重定向假设扩张drag guard。

新产物仅为**未接受的本机测试候选**，安装包和EXE均NotSigned，本轮未重复安装/卸载：

| 独立产物 | 字节 | SHA256 |
| --- | ---: | --- |
| release/selection-fix/PaperFlow-0.1.0-win-x64-setup.exe | 122998965 | 165aacbef09f7d6bfdc7c18d95754416ca8de6dce5c83bd16d14c2bf9be96f49 |
| 同目录setup.exe.blockmap | 130464 | 24cfd7c2550ea6754d85226c2f7a259d9188d0674898247897cef9ad78e885c8 |
| release/selection-fix/win-unpacked/PaperFlow.exe | 245590016 | 7bb2bdaf343d0488f5c44d6fb5f21439d94df1659795898a221f461cc421a1fd |
| release/selection-fix/win-unpacked/resources/app.asar | 33294912 | cff2dfff58b711fbdf7c718e48c7dc7def9bf5b2bced25a9eba65bbd00360a93 |

准确绝对路径/签名/大小/hash在`r7-06-package/artifacts.json`，源码与包测试原始附件各在对应stage。自动导入仍注入文件框返回值；用户2026-10-28手动导入仅按用户报告、素材及安装形态未知单独记录。DPR仍为进程模拟，非物理DPI/跨屏；QA003真实100MiB/崩溃窗口等补验仍未执行。没有Git提交、发布、进入T04–T08或关闭用户实例。

## revision6：冻结13实际19过1败

任务revision6、`PF-SELECTION-20261028-13`，153项及ZIP前后核验均无差异。r6-01type/r6-02lint/r6-03build均退出0，43项输入hash不变，继续明确复用冻结10的07-unit实际59/59，未重跑单测。新helper/PdfPage/选区控制器不在该59例的导入链。

`r6-04-source-selection-20`：19通过、1失败、0跳过/重试/flaky，退出1，98967.076ms。唯一失败为`PFV selection formula page1-100pct-dpr1`中的formula-reverse，应规范空白后`E=mc2+a1`，实际为空；该组正向及单步快速正向已通过，其他19组亦通过。不能以19/20进入原20回归或打包。完整原JSON/日志/命令、PNG/JSON附件与`minimal-formula-reverse-phases.json`保留。73个已记录手势的phase未检出完整干扰标签，仍不等于目标字符全部正确，也不覆盖失败后未执行手势。

按“可附观察单字advance”授权，r6-05仅沿原前置正向/单步手势运行100%反向公式被动诊断，实际1失败/退出1。起点仍547.3/432.5，下标`1`框540.46875–547.6687622070312，Range宽7.20001220703125，`--scale-x=1.2`和matrix(1.2,0,0,1,0,0)正确；点位于该Range内。浏览器却只命中空格，完整命中栈未列出`1`；caret为空格Text0，Pointer兼容配对matched，实际有效点547.2999878/432.5，mousedown被阻止后anchor/focus为空。没有改变坐标、0.25阈值或有效目标断言。

主控追加相同font Canvas测量要求后，r6-06新目录仅补同案，实际1失败/退出1；原始`formula-reverse-100.json`和`font-measure-facts.json`含全部真实Rect、命中栈及空格前一DOM节点。Canvas请求font=`normal 400 12px monospace`，实际font=`12px monospace`，measureText('1').width=6，baselineVectorLength=1.2，transformedAdvance约7.2，与字符Range一致。空格前一DOM节点确为`1`；空格框547.671875–553.671875，二者仅约0.003113px间隙。**单字符advance已修正，残留失败不能再归因于仍宽6px；可确认浏览器命中栈遗漏该Range内节点，内部具体拒绝路径仍为观测结合源码推导。** 未扩大事件诊断或重跑其他19组。

两私有实例PID45688/50000均正常退出0；209项out在r6-05/06后hash均保持13构建，完整基线/旧release hash不变。诊断仅为附加观测，不替代r6-04失败，不计作回归通过。当前停止原20/打包/新包40，等待主控/reader新基线。

## revision4：冻结12实际11过9败

任务revision4、`PF-SELECTION-20261028-12`，152项及ZIP核验通过；开始无差异，结束仅reader授权selection说明文档差异。选区spec、manifest、PDF和生成器的11/12/当前SHA相同。r4-01type/r4-02lint/r4-03build均退出0；`r4-unit-evidence-reuse.json`核43项哈希未变，继续明确复用冻结10实际59/59，不是本轮重跑。

`r4-04-source-selection-20`：11通过、9失败、0跳过/重试/flaky，退出1，原JSON时长85055.10699999999ms。所有空白组、恢复组通过，分数组除90°DPR3的反向分母外通过。100%及90°DPR1正文正向已完整，但下一条text-reverse-margin空；四个公式组的正向和真实单步快速拖拽均通过，formula-reverse仍空；200%及90°DPR3正文正向仅`L`；90°DPR3分母反向为空。各失败组后续手势未执行，不推断其通过。

最小原phase在`r4-04-…/minimal-failure-phases.json`。100%正文反向起点仍是原PDF(266,705)对应CSS(648.5,245.5)，快照`elementFromPoint`竟为内容仅空格的SPAN，mousedown后anchor/focus为null；拖动/松手仍空。这是本轮观测，不能沿用r3“anchor漂移”作为同案原因。200%正文/公式/90°分母对应记录亦已归档，未改目标点或共享断言、没有额外GUI诊断。

原始Playwright JSON、命令、runtime、截图/JSON附件、前后基线核验均保留；记录phase未检出完整干扰标签，不代表目标文字完整。结束无PaperFlow命名进程，旧安装包/EXE/ASAR hash不变。原20回归、打包、新包40仍未启动；等待主控/reader处理新失败。

### r4追加被动几何与拖放诊断

`r4-05-passive-geometry-diagnostic`保留原前置手势、目标坐标和精确字符断言，三案均实际失败：100%正文反向空、100%公式反向空、200%正文仅L。原始每案JSON含完整elementsFromPoint栈、两caret API、所有span CSS/逐字符Range/27个折叠offset与事件，PNG、Playwright JSON及命令保留。诊断布局读取会影响时序，不能替代r4原20门禁；没有程序修选区或更改产品。

- 正文最后字符Range为640.5–648.9000244140625，空格框为648.890625–655.890625，实际只重叠0.0093994140625px。请求648.5/245.5，命中栈却空格在上、真实文字在下，caret也为空格Text0。**这是命中抢先，不是整枚末字被空格覆盖。** 请求点甚至位于空格bbox左侧约0.390625px，不能把bbox简单等同于浏览器命中判定。
- 公式下标`1` DOM框540.46875–546.46875，宽6px、`--scale-x=1`；原PDF advance7.2px（映射540.5–547.7）。请求547.3已超DOM框0.83125px，命中其后空格。上标`2`同样宽6px；多字符公式scale-x=1.2。这是实际DOM与已知PDF advance差异，advance cell不宣称等于像素墨迹范围。
- 200%目标框368–804.800048828125，终点836/320.5的全部折叠矩形独立推导nearest=26，距离平方973.4369531273842；offset25为2304。现存3个兼容Mouse事件全匹配Pointer，首个拖动后pointercancel，之后没有终点mousemove/up。不能把命令结束后的snapshot当作对应终点事件已经送达，也不能归因于nearest选错。

为核取消来源，`r4-07-passive-drag-diagnostic`仅对200%案加被动原生拖放监听，仍实际1失败/退出1，最终L。可信dragstart在3032.60000000149ms发出，目标为该文字Text，默认未阻止，dataTransfer为text/html和text/plain，选区anchor0/focus1；3038.1999999955297ms出现pointercancel（相差约5.6ms），之后是drag/dragover流至终点836/320及dragend。**本案已直接观测进入原生文字拖放，不能再把target匹配失败或错误nearest当作本次截断原因。** 最小事实`r4-07-…/minimal-drag-facts.json`，全流`text-forward-200.json`与`drag-events-summary.json`均保留。

`r4-06-passive-drag-diagnostic`在启动应用前因递归发现05目录归档spec的相对导入路径失败，退出1、无GUI；原日志/JSON/命令保留。私有配置随后限定原诊断文件，07发现日志核仅1例再执行。首个PowerShell摘要括号解析错误也单独保留，改私有CJS读取成功，无原始数据覆盖或因此重跑GUI。

05三实例PID23028/6612/26320及07实例46088均正常退出0。`r4-runtime-integrity-after-diagnostics.json`核209项out与原spec/helpers/生成器/manifest/PDF五项hash全无差异；主控同时授权reader修改下一候选src，明确不重建/写out，本次运行时仍冻结12。当前等待新基线，停止原20与打包。

## revision3：冻结11实际10过10败

任务revision3、基线`PF-SELECTION-20261028-11`，152项及ZIP SHA核验通过；前后源码/测试/生成器/配置/锁/生产通知均匹配11，仅授权architecture/selection说明文档差异。任务documentation_policy中的“匹配10”仍是旧文字，本轮按任务baseline_id及主控明确冻结11执行。`r3-baseline-11-start.json`和`r3-baseline-11-after-selection.json`保存核验。

`r3-01-typecheck`、`r3-02-lint`、`r3-03-build`均退出0。**59项单测复用07-unit在冻结10实际执行的59/59结果，不称11重新运行。** `r3-unit-evidence-reuse.json`核对43项依赖/素材/脚本/配置superset哈希均未变；5个单测不导入PdfPage或text-selection，运行时均Node24.21.0 / <local-node>。独立只读复核37条精确依赖链亦无差异，未重装/重建依赖。此复用不能证明新DOM控制器正确，DOM结果以下列真实E2E为准。

`r3-04-source-selection-20`：10通过/10失败/0跳过/0flaky/0重试，退出1，85548.888ms。100%及90°DPR1的text-to-gutter只选`8`（应完整目标词），formula-to-blank只选`1`（应E=mc2+a1），numerator-to-blank仍为空（应a+b），normal-after-mouseup只选`K`（应DOUBLECHECK）；200%及90°DPR3的formula-reverse为空。实际复制与这些短选区一致或空选保持哨兵，不能冒称有效选择通过。其余通过组见原JSON，不推断失败组首个硬断言后的未执行手势。

最小原始phase提取在`r3-04-…/minimal-text-phases.json`：请求点仍`(430.9,245.5)→(664.5,245.5)`，mousedown时anchor/focus为目标Text offset0；到空白mousemove和mouseup时却变为anchor25/focus26，仅剩`8`。**这次起点不再被当空白清除，但锚点在拖动期间改变；内部原因未由此采样直接证实。** 没有更换坐标、有效字符断言或程序修选区。全部记录phase未检出完整禁止标签，只是被动采样结果，非最终正确证明。

原始日志/命令/PlaywrightJSON/提取的PNG和JSON附件均在r3-04目录，结束后无PaperFlow命名进程。按照门禁停止：原20回归未执行、没有源码40全部通过结论、没有打包或新包40；旧release根包/EXE/ASAR前后hash保持原值。等待主控/reader处理新失败。

## 冻结10候选与诊断（历史）

任务revision2，基线`PF-SELECTION-20261028-10`；152项清单及ZIP SHA核验通过，源码/测试/生成器/配置/锁未漂移，仅授权`docs/architecture.md`说明变更。原20回归相关7个E2E文件含helpers相对已验收07哈希相同。`baseline-10-start.json`、`baseline-10-after09.json`保留真实结果。

| 阶段 | 实际结果 |
| --- | --- |
| 05-typecheck、06-lint | 各退出0 |
| 07-unit | 5文件59/59，退出0；精确100MiB单测仍有页数解析替身，不冒称本轮真实100MiB补验 |
| 08-build | 退出0，209项out hash保存 |
| 09-source-selection-20 | 5通过/15失败/0跳过/0flaky/0重试，退出1，108839.185ms |
| 10-passive-hit-diagnostic、11-passive-event-coordinate | 各单例目标断言失败/退出1，诊断证据，不算回归通过 |

09中100%正文、公式、分子、普通恢复选择及90°变体多为最终空选；200%正文仅`LEFT_ALPHA_TA`，公式正向/单步在反向失败前通过。200%灰底空选区本身为空，但Ctrl+C把哨兵变为空：这是原剪贴板断言失败，不声称选中了远处正文。5个通过组为100%空白、200%分数与恢复、90°DPR1/DPR3空白。各组在首个硬断言失败处结束，不推断后续未执行手势。`09-…/summary.json`、原始PlaywrightJSON及按用例提取PNG/JSON附件包含精确结果；记录中的全部phase未发现完整禁止干扰标签，但这只覆盖采样点，不证明事件间隙或最终正确。原断言仅检查mouseup，规范空白后字符一致不能表述为原始空白完全一致。

诊断未改变目标坐标、共享断言或程序修选区：沿同一`text-to-gutter`从PDF(48.4,705)到(282,705)，Canvas `(382.5,170.5,600,780)`。请求CSS起点`(430.9,245.5)`时`elementFromPoint`为目标SPAN，`caretPositionFromPoint`为其Text offset0；`caretRangeFromPoint`却为TextLayer DIV offset17。首字`L`的Range左边界430.5，上下238.359375–252.359375。实际mousedown仍以目标SPAN为event.target，但`clientX=430/clientY=245`，该整数点的elementFromPoint及两种caret API均为TextLayer DIV offset17，`defaultPrevented=true`，anchor/focus为空。所有按键拖动及mouseup后仍空选，复制哨兵未变；滚动位置0。**推断：整数事件坐标丢失小数边缘命中，textHit收到非Text caret即提前拒绝；0.25px逐字容差也小于0.5px边缘差，但原路径先在类型检查退回，不能称已证实走到容差分支。**未对私有guard变量插桩。

最小事实见`11-passive-event-coordinate/minimal-facts-r2.json`及原`diagnostic.json`；首版私有摘要解析器因整数点无span而索引null报错，`minimal-facts.json`的null与错误摘录均保留，r2仅修摘要解析，没有重跑GUI。10/11自有PID11536/47764均退出0，所有命名PaperFlow进程为空。`out-integrity-after-diagnostic.json`核对209项构建hash无差异。未创建`release/selection-fix`包、未覆盖旧release、不改共享实现，等待主控/reader修复后新基线。

## 已确认的问题

使用旧 `release/win-unpacked/PaperFlow.exe`（SHA256 `aa290d32926ae9c999fa479f4e8bb90b48737b495dba5c1976e8d93453201498`）、旧 ASAR（`98ab809a7ff0c07356b77f177c8b56a205c29b14061b0fe7a03d8d5cd9336d9c`）和原创合成 `tests/fixtures/valid.pdf`。导入只注入文件框返回值，后续沙盒校验、复制、数据库、Canvas、TextLayer及鼠标/剪贴板实际执行。

素材来源为 `scripts/generate-fixtures.ts`：MediaBox 612×792，正文左栏 x=48，公式 x=64，左页边 x=20 路径不经过任何文字。探针以 Canvas 可见边界和已知 PDF 坐标换算鼠标位置，没有使用 TextLayer 的文字框取点。

100%缩放时 Canvas CSS 边界约为 `(378.6000,146.5,612.0000,792)`。左页边 PDF `(20,550)→(20,450)→(20,300)` 对应 CSS `(398.6000,388.5)→(398.6000,488.5)→(398.6000,638.5)`，采样命中均是空白 TextLayer 容器，却在拖动中选中正文，松手后选中588字符，包含多行正文、`E = mc2`、`f(x) = x + 1`及图注。反向同样588字符；右页边空白反向选中457字符。Ctrl+C复制内容与选区按Windows换行标准化后相同。这三案为明确产品复现。

正文拖入左页边选中233字符，含其他行；正文拖至栏间中途也包含其他行，回到正文后恢复本行38字符。公式向右空白最终仅换行；向左选中`E = `。后两案保留原始记录，不能据此称公式完整选择通过。九组路径均保留拖动中、mouseup、anchor/focus、range rect、鼠标坐标、命中、截图和剪贴板。

## 实际执行与测试器限制

证据根：`.cache/qa/20261028-selection-regression-01`。

- `01-old-valid-probe`：受限宿主中应用启动即退出2147483651，Playwright退出1，未触发选区；原日志、JSON、trace保留。
- `02-old-valid-probe-host-permission`：正常宿主权限实际运行，测试1失败，退出1，未重试。未添加任何禁sandbox等开关。所有真实手势已完成，pageerror为空。部分额外断言把Windows剪贴板CRLF与选区LF直接比较产生测试器失败，另在`app.close()`后读取`app.process()`产生TypeError；这些均不作为产品缺陷。明确空白路径非空断言及原始附件独立成立。
- 关闭后只读复核自有PID35404已不存在，PaperFlow命名进程为空；关闭后退出码未可靠捕获，不声称退出0。未强杀/关闭用户实例。
- `preflight.json`：核对142项基线，只有`docs/verification/summary.md`差异；旧EXE/ASAR、素材和生成器hash已保存。未重建，未改src、config或共享spec。
- `02-…/host-environment.json`与`summary-and-process-recheck.json`：本次正常宿主及受限命令实际均为Node v24.21.0、pnpm11.25.0，正常宿主Node路径`<local-node>`。主控发现其他上下文compile-cache有24.22.1，不能把它当作本次实际运行版本。

阶段1补充不覆盖历史QA001/002结果。尚未执行reader新素材原断言、修复源码门禁、新包或物理DPI/跨屏验证。QA003只读准备后安全停止，未执行remaining测试。

## 03：reader单例发现失败（未启动桌面）

主控后续仅放行`PFV selection blank page1-100pct-dpr1`。`03-old-selection-spec`保留实际命令、前后相同的测试/素材/旧包hash、Playwright JSON、退出1原日志。私有runner的grep为`^PFV selection blank page1-100pct-dpr1$`，而Playwright匹配包含文件的完整标题，因此返回`No tests found`，未启动应用。随后只读`--list`去掉起始`^`，准确发现1例、退出0；诊断在`discovery-suffix-only.log`和`discovery-diagnosis.json`。没有修改reader测试，也未将发现成功计作执行通过。按主控“harness初始化失败先报原因不自改”边界，报告后等待续作指示；新执行须用新的唯一路径，不覆盖03。

## 04：reader原断言旧包单例实际失败

主控明确允许私有CLI常规修正后，在独立`04-old-selection-spec`使用后缀grep，实际只运行`PFV selection blank page1-100pct-dpr1`。测试1失败、跳过0、重试0、退出1；总报告时长5771.638ms。原始JSON、日志、命令、runtime、输入前后hash、测试/manifest快照及提取的原始附件均保留，见该目录`summary.json`和`extracted-attachments/`。没有修改reader共享测试或断言。

原创合成`blank-drag-columns-formulas.pdf` SHA256 `c557bc4712ccc28c2213039a080319835449c24f9d33ad9e718632dae33e5419`，第1页Canvas CSS边界`(382.5,170.5,600,780)`、实际像素600×780；100%倍率/DPR1初始化成功。`blank-gutter`和`blank-far`松手后为空，复制哨兵保持不变；第三条`blank-reader-gray`从CSS`(256,226.5)`拖至`(256,336.5)`，全程在Canvas左边界382.5之外，终点命中`pdf-pages`灰底。选区和实际复制却包含`DOUBLECHECK RESETWORD`、`ABOVE_FORMULA_OTHER`、`E=mc2 +a1 REMOTE_FORMULA_9`、`BELOW_FORMULA_OTHER`及`a+b`。原断言第110行准确失败；pageerror为空。这是指定旧包单例的产品失败，不是初始化失败。由于硬断言在第三条停止，本次不推断其他组或变体结果。

DEBUG原始日志记录自有PID31856退出0，后续命名进程为空；运行前后测试、helpers、manifest、PDF、旧EXE/ASAR全部hash一致。没有重建，也没有覆盖旧release或触碰用户实例。后续需冻结新基线后执行候选门禁，尚未运行修复源码/新包。上一节“尚未执行reader原断言”仅表示04之前的历史状态。
