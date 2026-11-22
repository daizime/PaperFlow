# 最终本地候选与分发物复核

日期：2026-10-28（Asia/Shanghai）。任务 `PFV-RELEASE-002`，run `20261028-final-artifact-01`，实际 QA 冻结基线 `PF-VERIFY-20261028-07`。

**当前新包与 QA002 记录、现存 out 和许可原文一致。它来自含未提交修改的 07 工作树候选，仍未签名、未公开发布，不能称为干净 HEAD 构建或整体许可合规。** [docs/artifacts.json](../artifacts.json) 已由本任务唯一更新，包含安装包、blockmap、解包 EXE 和 ASAR 四项实物元数据。

## 本轮对象与证据保全

QA002 在本任务派发前已由主控接受（任务 accepted_at=`2026-10-28T10:59:26.1666982+08:00`）。本轮只读包内容、现存源码与其原始结果，没有重跑构建、测试、安装、卸载或下载，没有操作 Git 索引/分支/远端。

- 本轮独立审计 JSON（`.cache/release-audit/final/local-evidence.json`）、双向比较摘要（`.cache/release-audit/final/audit-summary.json`）、新 ASAR 成员表（`.cache/release-audit/final/asar-list.txt`）、签名/版本/原生文件摘要（`.cache/release-audit/final/supplemental-evidence.json`）。输出均在 `final/`，没有运行会写旧缓存的 001 脚本。
- 旧 artifacts 原件（`.cache/release-audit/final/artifacts-before-PFV-RELEASE-002.json`）已先复制并核 SHA256=`084b2b7d8ed5bc59b38b64fbd85c81ba75aff1e665d0aa20b534e3313f446e70`；旧 release 报告原件（`.cache/release-audit/final/release-before-PFV-RELEASE-002.md`）也已留存。全部 10 个 001 根缓存原件摘要未变，详见归档记录（`.cache/release-audit/final/archive-record.json`）。001 字体源码档案和 `source-evidence.json` 均未覆盖。
- 07 的 snapshot.zip 本轮实际摘要为 `aa547045adfd07cdbfcd0cc8b79c9ec9975c639d3a3610a926b1770f35f34546`，与 manifest 一致。140 个基线文件中，排除 README 与 docs/ 后的 127 项无差异；这是指定文件集合与快照一致的证据，不证明全工作树无改动。

Git 参考仍为 main / `0779111916f8ab3360619e5302cd83e2dd823168`；产物包含该提交后的未提交修复。package.json、pnpm-lock.yaml、docs/dependency-versions.json 的摘要同时与 001 和 07 一致，因此复用 001 已核定的 24 直接依赖版本、锁格式 9.0 及 529 个带 integrity 条目。未重新下载依赖，也没有声称重新认证 registry 内容。

审计期间主控更新了 README、delivery-report、architecture、implementation-notes 并新增 summary/source-files 等收尾文档；reader/qa 自有报告也已有允许的文档差异，本轮另外更新 artifacts/release。最初辅助脚本把根 README 归入代码范围而退出 1；保留该次差异记录（`.cache/release-audit/final/documentation-delta-detected.json`）后，将 README 如实归为文档。没有放过产品、测试、配置或锁文件差异，没有修改冻结基线。文档后续整理不改变被测二进制；结束完整性记录（`.cache/release-audit/final/final-integrity.json`）记录最终文档摘要与冻结文件/产物复核。

## 新产物本轮实测

| 产物 | 字节 | SHA256 | 签名 |
| --- | ---: | --- | --- |
| release/PaperFlow-0.1.0-win-x64-setup.exe | 122993353 | `d488a699708e93b7da76e598274451f6eaf075ebf731c0f7a8a9573bef1777f7` | NotSigned |
| release/PaperFlow-0.1.0-win-x64-setup.exe.blockmap | 130501 | `d9334b4152e4110bfac04e2030253b98faf34f21c08212c0f92beac19307838e` | 不适用 |
| release/win-unpacked/PaperFlow.exe | 245590016 | `aa290d32926ae9c999fa479f4e8bb90b48737b495dba5c1976e8d93453201498` | NotSigned |
| release/win-unpacked/resources/app.asar | 33280280 | `98ab809a7ff0c07356b77f177c8b56a205c29b14061b0fe7a03d8d5cd9336d9c` | 不适用 |

四项均与 QA002 `r5-08-dist-win/artifacts.json` 一致。ASAR package.version=0.1.0，解包 EXE FileVersion=0.1.0、ProductVersion=0.1.0.0，运行时 version 文件为 Electron 44.7.2。安装包 FileVersion/ProductVersion 均为 0.1.0。

| 独立重新核对的项目 | 结果 |
| --- | --- |
| out ↔ ASAR | 本机 out 与包内 out 均为 209 个文件；双向无缺失、额外、链接或字节差异。这是本轮重算，恰好与 001 数目相同 |
| Worker | `out/renderer/assets/pdf.worker.min-CjEcRF4W.mjs` 存在并参与字节比较 |
| 不必要资源 | 没有 QuickJS 资源；Node Canvas 运行包数为 0。resources/licenses 中保留了 Canvas wrapper 许可存档，不能把这份通知误认成运行包 |
| 许可证原文 | 重新核对 41 份：manifest 摘要与 ASAR 字节一致；40 份还与现存安装来源相同，模板许可仅核对已保存摘要 |
| 根声明/通知 | AGPL 根 LICENSE、THIRD-PARTY-NOTICES、manifest、third-party-licenses.md 与工作区一致；Electron 两份发行通知也一致 |
| 字体/原生范围 | 四个字体摘要与 001 相同，仍是同版 1.07.4；FFmpeg DLL 摘要未变，better-sqlite3 仍有 8 个跨平台 .node，本轮仅记录摘要，没有逐个平台执行或重建 |

本轮确认新包通知已包含“1.07.4 源码已保存于本机证据”的修订表述，旧包的“尚未下载”历史事实不再作为当前描述；字体来源/许可没有改为 2.x/OFL。41 份许可计数没有因为通知文字更新而变化。

## 已接受的 QA002 证据与边界

本节是读取 QA 原始日志/JSON 后核实的结果，执行者为 QA，本模块未重跑。原始根为 `.cache/qa/20261028-regression-01/`，[QA 详细记录](qa.md)保留所有历史失败。

| QA002 最新阶段 | 原始结果 |
| --- | --- |
| typecheck / lint / build / dist | r5 各 status.json 退出 0；dist 使用 publish never |
| 单测 | r5-03-unit/vitest.json：59/59，0 failed/pending |
| DPR 3 定向 | r5-06-dpr3-targeted：2/2，退出 0 |
| 源码完整 E2E | r5-07-source-e2e：20/20，0 skipped/unexpected/flaky，退出 0 |
| 新解包完整 E2E | r5-09-unpacked-e2e：20/20，0 skipped/unexpected/flaky，退出 0 |
| 新安装版原关闭恢复单例 | r5-11-installed-e2e：1/1，退出 0；安装负载 141 个物理文件与被测解包目录一致 |
| native | 依任务复用 05-native 成功证据；没有 r5 重跑 |
| 卸载及数据 | 卸载器退出 0；首次验证脚本退出 1（快捷方式尚在）；之后只读复查自行消失，最终目录/注册项/快捷方式/进程无残留，未手工清理；124 默认文件及 1 个隔离数据库哈希差异 0 |

209 是 ASAR 内构建文件口径，141 是安装后物理负载口径，124 是既有默认数据保护口径，不混作同一文件集合。早期 lint 31 错、测试器 14 过/5 败、DPR3 原回归 18 过/1 败及探针错误仍在 QA 历史中，不能概括为所有命令首次成功。

原生文件框完整选文件、真实物理 DPI/跨屏、其他机器与交互安装向导仍未验证。五档 DPR 为进程模拟，600 页/加密文件为原创合成素材；真实执行自动化不等于真实样本或物理硬件覆盖。有限时序、Canvas 采样不能证明任意长文档内存有界。

## 当前许可与交付限制

001 保存的 1.07.4 原始源码与构建脚本继续有效，本轮没有下载、执行或重建字体。缓存及主控本机保全不等于已向受领者提供对应源码。PGP 未验签、字体源→TTF 重建、PaperFlow 本版完整对应源码的交付渠道、FFmpeg 精确源码/补丁/实际配置证据仍未闭合，具体方案沿用 [license-source-plan.md](license-source-plan.md)。FFmpeg 综合通知中的可选 GPL 内容不能证明本包实际启用这些选项；MIT 原生依赖来源追溯缺口也不直接等于 GPL 义务。

安装包仍未签名，完整程序目录必须一并保留资源。没有生成提交、推送、Release 或远程发布；本轮通过的是指定本机候选与材料核对，不是公开分发许可的总体认可。

---

# 历史：PFV-RELEASE-001 审计原文（2026-10-27）

以下保留旧包与旧工作区记录，包含当时未做安装验收、通知尚未同步等旧状态；新包的实际结果和当前限制以上文 002 为准，旧数字不作为新包重验的替代证据。原件另存 final/release-before-PFV-RELEASE-002.md。

日期：2026-10-27（Asia/Shanghai）。任务 `PFV-RELEASE-001`，run `20261027-verification-01`，基线 `PF-VERIFY-20261027-01`。

**结论：现存 0.1.0 产物与记录一致，许可原文确实随包；公开分发的源码提供证据仍未闭合。** 本轮已保存 Liberation 1.07.4 原始源码及构建脚本，但缓存不是交付渠道，没有执行字体构建或证明 TTF 可逐字节重建。本报告不作整体法律合规结论。

## 本轮检查与历史记录

本轮只读取源码、锁文件、现存安装包、ASAR 和许可证；以 SHA-256、包元数据、TTF name 表及档案成员核对。没有运行公共测试、构建、安装器或应用，没有修改产品、Git 索引/分支/远端。交付报告中的 21 个单测、源码/Windows 包各 5 个 E2E、滚轮补测和 HMR 均为历史证据，本轮没有重新认证。

证据为 `.cache/release-audit/local-evidence.json`、ASAR 成员表（`.cache/release-audit/asar-list.txt`）、`.cache/release-audit/source-evidence.json` 和签名/版本/网络记录（`.cache/release-audit/supplemental-evidence.json`）。这些缓存被 Git 忽略，须由主控另行保全，不能只提交本文后丢弃原始证据。

## 版本、基线和实物

| 核对项 | 本轮结果与限制 |
| --- | --- |
| Git | `main` / `0779111916f8ab3360619e5302cd83e2dd823168`，与任务基线一致；未操作索引 |
| 基线文件 | 审计脚本核对基线中排除 tests 与 docs/verification 后的 109 个文件，差异 0；不是全工作区无变化证明 |
| 直接依赖 | 24 项的 package.json 范围、锁文件 importer、版本记录和已安装元数据一致；不是 registry 包内容重验 |
| 锁文件 | 格式 9.0；529 个 package 条目均有 integrity；没有重新下载 529 个包核算 SHA512 |
| 版本文件 | ASAR package.json 为 0.1.0；PaperFlow.exe FileVersion=0.1.0、ProductVersion=0.1.0.0；解包目录 version 为 Electron 44.7.2 |
| 构建内容 | 现存 out 的 209 个文件与 ASAR 对应成员逐字节一致；不能据此证明源码可重建为同一产物 |
| 通知材料 | 根 AGPL 正文、第三方通知、第三方清单和 manifest 均与工作区字节一致 |
| 许可原文 | 41 份记录均与 manifest SHA256 及 ASAR 内容一致；其中 40 份也与现存安装来源一致，模板原文仅与保存的摘要核对 |
| Electron 通知 | 解包根目录的 LICENSE.electron.txt 和 LICENSES.chromium.html 与保存原文一致 |
| 排除项 | ASAR 中未发现 quickjs-eval 或 @napi-rs/canvas 文件名；不是对所有二进制的功能或漏洞审计 |

审计开始时已存在的 AGENTS.md、项目管理/README.md 变更及管理规则/脚本目录由主控维护，未覆盖。模块协作期间其他测试/报告可继续增加。

| 产物 | 字节 | 本轮 SHA-256 |
| --- | ---: | --- |
| release/PaperFlow-0.1.0-win-x64-setup.exe | 122992594 | `c2a582f7b40ca350d7e4570ab1a7009b6ed4cd2484045f691fb9b0282d64109e` |
| release/win-unpacked/PaperFlow.exe | 245590016 | `58ab630b77e02bb234150f386eadd0349dd960f4a405b98c4361db7e92553e65` |
| release/win-unpacked/resources/app.asar | 33274920 | `7ba1b0bdaab3f575d769e0c1dc3260b01fedc47fc9f9a5d5abdd04fdb8b3ed3c` |

前两项与 docs/artifacts.json 一致；安装包 Authenticode 为 `NotSigned`。本轮未从 NSIS 内部重新提取 ASAR，也未复验安装/卸载，因此只能确认安装包本身未变，以及当前 win-unpacked 内容，不能把两者关系扩展成新一轮安装验收。

## 字体与源码

[Mozilla 对应版本说明](https://raw.githubusercontent.com/mozilla/pdf.js/v6.4.299/external/standard_fonts/README.md) 指定未改动的 Liberation Sans 1.07.4，并说明字形顺序与宽度/缩放表有关。实际四个 TTF name 表均为 `Version 1.07.4`，且与已安装 pdfjs-dist 文件逐字节一致；这比单独读取文档多一层实物证据，但仍不等于字体来源构建证明。

| ASAR standard_fonts/ 中的字体 | 字节 | SHA-256 |
| --- | ---: | --- |
| LiberationSans-Bold.ttf | 137052 | `361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc` |
| LiberationSans-BoldItalic.ttf | 135124 | `a224075ac17495ad0a3af3bc0a419ac0704a8b3fd1095456201fb9b095fc281d` |
| LiberationSans-Italic.ttf | 162036 | `832b4406dbef23628800d3aaad21048534ac84d7e3ad955be83b8172ed8ef512` |
| LiberationSans-Regular.ttf | 139512 | `f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f` |

本轮从 [Debian 官方发行池](https://deb.debian.org/debian/pool/main/f/fonts-liberation/)取得 `fonts-liberation_1.07.4.orig.tar.gz`（2937949 字节，SHA256 `ad98b7498dc2992f7f0868f79b65ce4a720a3acdb63ab3f1f1cb6881117a5406`）和 `fonts-liberation_1.07.4-11.dsc`（2176 字节，SHA256 `c9cb6abc8b8ab1887d78f5fc1aef1fc06a220efbfa3424ca7e8bc379242654ba`）。压缩包大小和 SHA256 与 .dsc 内容相符，也与 [Ubuntu 官方索引](https://launchpad.net/ubuntu/focal/+source/fonts-liberation)所列一致；没有验证 .dsc 的 PGP 签名。

安全解包仅写审计缓存。档案根 `liberation-fonts-1.07.4/` 包含 16 份 SFD、Makefile、README、License.txt、COPYING 和三份 FontForge 脚本；四份 Sans SFD 与 Makefile 都标 1.07.4。许可是 GPL v2 加 Liberation 例外；规范化空白后，License.txt 与 COPYING 的全部文字均包含于随包 LICENSE_LIBERATION。各成员摘要见 source-evidence.json，具体后续动作见 [license-source-plan.md](license-source-plan.md)。

## 尚未闭合的分发证据

1. **字体源码提供**：ASAR 内无 SFD；当前仅有本机缓存，未给受领者提供固定的对应源码副本/同渠道下载，亦未核实其他合适的提供方式。源码档案虽是同版，尚未执行字体重建、比对字形/宽度/提示信息或确认上游精确构建环境。不能因已下载就标为义务完成。
2. **PaperFlow 对应源码**：ASAR 无应用 src/、pnpm-lock.yaml 或应用构建配置。工作区有源码，但本轮未发现与此二进制绑定的、可交付给受领者的完整源码归档或已落实的提供渠道；编译 JS 与许可证声明不足以代替该证据。
3. **运行时来源**：ffmpeg.dll 随包，Chromium HTML 的 ffmpeg 条目含 LGPL 与可选 GPL 等说明。本轮未固定此 DLL 的精确源 revision、补丁与实际配置；不能从综合通知里的可选条款判断它实际启用 GPL。需要继续补足实际运行时的对应源码/重链接材料证据，不能只以完整 HTML 宣称审计结束。
4. **原生依赖范围**：better-sqlite3 随包有 8 个跨平台 .node，保留 MIT、C++ 和 SQLite 源文件；这不证明每个预编译二进制都由该源码重建。MIT 本身不要求提供源码，不能把来源追溯缺口误写为 GPL 义务。当前 Windows x64 候选的摘要见缓存。
5. **安装与交付限制**：未签名；NSIS 安装/卸载、其他机器、完整许可展示/源码获取流程未在本轮操作验证，归 QA/主控安排。未提交、推送或发布任何内容。

## 失败与核查边界

普通权限下载三份 Debian 文件因 DNS 失败；切换获准的网络执行后 .dsc 和 orig.tar.gz 成功，Debian 打包补丁 .debian.tar.xz 出现 TLS 失败，未将其记为已取得。原始源码档案本身已有构建脚本；未应用 Debian 补丁。上游 README 的历史 Pagure 源码链接仍返回 404。GNU 官网正文多次读取超时，条款核对使用包内原文及上游原文副本，不把超时当成正文证据。

本地审计辅助脚本第一次扩展版本核对时假定存在 yaml 包而失败，改用已安装 js-yaml 后通过；失败没有修改产品，也不是公共测试失败。辅助脚本、最终 JSON 和档案均位于 .cache/release-audit/；不执行任何下载的构建脚本。
