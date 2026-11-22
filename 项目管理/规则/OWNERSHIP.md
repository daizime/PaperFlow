# 本轮文件和执行归属
根目录与源码根均为<repo-root>。实际身份以状态/registry.json为准。主控唯一维护登记/任务/总表/验收及共享产品文件；模块不得越界写入。

|角色|本轮独占文件|允许执行|
|---|---|---|
|reader|scripts/verification/generate-reader-fixtures.ts；tests/fixtures/verification/reader/；tests/unit/pdf-geometry.test.ts；tests/e2e/reader-verification.spec.ts；docs/verification/reader.md；自己的报告/信号/临时目录|自己的素材生成与定向单测；不启动Electron或全套测试|
|library|tests/unit/library-robustness.test.ts；scripts/verification/library-faults.ps1；docs/verification/library.md；自己的报告/信号/临时目录|自己的定向业务测试；不构建、不启动Electron|
|qa|tests/e2e/verification.spec.ts；tests/e2e/helpers.ts；scripts/verification/qa.ts；docs/verification/qa.md；自己的报告/信号/临时目录|原生桌面与安装卸载；收到后续门禁任务后统一全套测试、构建、打包|
|release|docs/verification/release.md；docs/verification/license-source-plan.md；自己的报告/信号/临时目录|只读Git/产物/许可证审计；可获取来源证据，不提交/推送/发布|

src/、shared/、package.json、pnpm-lock.yaml、构建与TS配置由主控独占。本轮产品缺陷先提交可复现证据，由主控安排修复，不在验证中悄悄改实现或削弱断言。

追加授权：PFV-LIBRARY-001 revision 2 中，library 唯一写入 `src/main/services/document-service.ts` 的 `friendlyFileError`，修复已复现的 SQLITE_FULL 中文提示；主控与其他模块在此期间不修改该文件。其余共享源码/配置仍按上文归属。
长日志写各自.cache目录，报告仅保留路径、结果和限制。全套公共检查只由qa运行，避免多个Electron、剪贴板和release目录互相争用。身份/路径约定不构成操作系统隔离。

追加授权：PFV-READER-002期间，reader唯一写入PdfViewer.tsx与reader.css修复已复现fit-width；不可改测试断言，qa统一桌面回归。
PFV-QA-002为候选修复验收门禁：qa唯一写入公共out/release、PDF生成资源及测试生成目录；src/配置/锁文件/测试源码冻结只读。reader002保持awaiting_review，桌面通过后才完成验收。
QA002公共unit期间qa唯一写入现有测试固定结果.cache/reader/geometry-metrics.json、.cache/library/fault-observations.json及library/cases/**；原两JSON已保存pre-unit-evidence，reader/library不并发执行。
PFV-RELEASE-002排队等待QA002完成并由主控派发；届时release唯一更新docs/artifacts.json新包元数据，主控不并发写。
PFV-READER-003唯一授权reader修改PdfViewer/PdfPage/reader.css及原reader-verification.spec，修复已实测的导航重排；qa暂停公共测试待新基线，不通过放大缓冲/超时或测试纠正滚动掩盖。

2026-10-28新增授权：PFV-QA-003唯一写tests/e2e/remaining-verification.spec.ts、docs/verification/qa-remaining.md及自己的remaining缓存，执行已测解包EXE的隔离定向边界测试；不重复公共构建。PFV-RELEASE-003唯一写release/source/、source-delivery.md、license-source-plan.md与自己的remaining缓存，基于不可变09快照离线交付源码材料；release生产包只读，禁止上传/签名替代/修改负载。主控独占summary/README/总状态，双方不修改原验收历史。
PFV-READER-004：reader先准备选择素材/测试，不改产品，qa复现后由主控放行最小修复；允许路径见该正式任务。
PFV-QA-004分阶段运行：先旧包复现，再主控放行新候选；唯一写out和release/selection-fix，旧release根/解包保留只读，细则见正式任务。
主控冻结10：reader产品/素材/测试/生成器暂停写入；qa004修复门禁唯一构建/桌面。reader自己的报告/信号/选择说明可完成，任何产品修正需另获新基线。
PFV-READER-004revision3解除10产品冻结：按QA11真实小数指针/整数兼容Mouse事件证据最小修坐标；不扩大容差/改目标点。无选区Ctrl+C仅准哨兵或空，原有效文本/公式精确断言保留。QA暂停后继至新候选。
11冻结：reader revision3产品/测试/素材/生成器只读，QA004按新唯一路径执行，10的5/15失败及诊断保留不覆盖。
READER004revision5可修改允许src（含text-layer-layout.ts），QA仅已冻结12 out作被动诊断，禁止并发重建，保留原12/11/10结果。新源码不能当正在测的12。
