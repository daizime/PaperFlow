# 1.07.4 字体与公开分发源码补证方案

## PFV-RELEASE-003 本地交付补证（2026-10-28）

本轮已将09不可变快照的142项应用材料制作成本地源码ZIP及附件（本机忽略路径 `release/source/20261028-source-delivery-01/获取与构建说明.md`），逐项回读大小/SHA256一致，并绑定旧07实测的安装包、EXE和ASAR；详见[source-delivery.md](source-delivery.md)。**这些材料是历史09/旧07，不含随后启动的文字/公式选区修复或新补验测试；不称干净HEAD、最新源码或公开交付。**

| 项目 | 本轮新增证据 | 仍保留的边界 |
| --- | --- | --- |
| 应用源码材料 | 142项从09快照读取；打包时127非文档项与07及当时工作区一致；排除状态/聊天ID、缓存、用户数据、依赖安装目录和二进制产物；独立清单与中文构建说明已提供 | 构建依赖和全运行时源码未全部装入；没有重建此ZIP；新选区修复不在其中 |
| 字体来源 | 001原始1.07.4档案/.dsc及许可/脚本已复制为单独附件，摘要未变 | 字体未重建，未证明源到TTF逐字节重现 |
| 字体.dsc签名 | 现有GPG使用[Debian官方钥匙库公钥](https://keyring.debian.org/pks/lookup?op=get&search=0xB8BF54137B09D35CF026FE9D091AB856069AAA1C)，指纹B8BF54137B09D35CF026FE9D091AB856069AAA1C；隔离目录verify退出0、GOODSIG/VALIDSIG，追加验签记录（`release/source/20261028-source-delivery-01/Liberation-1.07.4-source/signature-verification.json`） | GPG未设ownertrust，TRUST_UNDEFINED仍保留；只核定签名，不作超出的身份/字体重建保证。001/002“未验签”是当时历史状态，没有覆盖原件 |
| FFmpeg二进制来源 | 既有完整Electron44.7.2缓存ZIP摘要匹配本轮官方SHASUMS；其中ffmpeg.dll摘要与旧程序53fdd1…873f一致，已建立字节绑定 | 没有执行或重建DLL，不将此等同全部构建条件已知 |
| FFmpeg精确基准源码 | Electron commit774d5d0a051374923758372a4ee4bf04f473151d→Chromium152.0.7977.149→FFmpeg fork2b68d2babae73714846961fb0ee47e3b3d2e39a9；官方源归档及关键配置/许可已保存，见来源说明（`release/source/20261028-source-delivery-01/runtime-provenance/来源说明.md`） | README的上游版本字段N/A，不猜发行版本；完整Electron/Chromium及全部外部依赖源、工具链/SDK/PGO和最终GN参数仍未核定 |
| FFmpeg配置及补丁 | 正常Electron默认Chrome branding/共享FFmpeg；基准Win x64 config.h标LGPL2.1+且GPL/NONFREE/VERSION3为0；列表仅含的ElectronFFmpeg补丁原文已保存 | 独立ffmpeg ZIP使用不同branding，不能替代现存DLL来源；未执行补丁或复现最终发行构建 |

本机没有找到FontForge，不安装新编译器/翻译依赖。GPG的受限启动错误、首次路径/缺公钥失败与后续成功分开保留；官方GitHub API403限流和Chromium历史补丁README404也有记录。本轮只把可用材料落实到本地，没有修改生产通知、总产物索引、应用负载或公开发布。实际向受领者提供源码、适用的重链接/安装材料、公开渠道及未签名问题仍需主控安排，不能作整体法律合规结论。

---

## 以下为001补证方案原文（保留当时状态）

任务 `PFV-RELEASE-001` / `20261027-verification-01`，2026-10-27。本文是基于具体条文和产物的交付准备清单，不是整体法律意见，也不授权修改打包配置或发布。

## 已保存的证据

[上游 PDF.js 6.4.299 说明](https://raw.githubusercontent.com/mozilla/pdf.js/v6.4.299/external/standard_fonts/README.md)将当前四个字体指定为 Liberation Sans 1.07.4。TTF 元数据和 SHA256 见 [release.md](release.md)。[上游旧版仓库](https://github.com/liberationfonts/liberation-1.7-fonts)的默认分支名为 liberation-fonts-1_07_3，不能只克隆默认分支就宣称取得 1.07.4；其历史 Pagure 源码 URL 本轮仍为 404。

可用的同版档案来自 [Debian 官方发行池](https://deb.debian.org/debian/pool/main/f/fonts-liberation/)；[发行源码目录](https://sources.debian.org/src/fonts-liberation/1:1.07.4-11/)可在线交叉查看内容。本轮已下载到 `.cache/release-audit/`，没有修改生产资源：

| 文件 | 字节 | SHA256 | 状态 |
| --- | ---: | --- | --- |
| fonts-liberation_1.07.4.orig.tar.gz | 2937949 | `ad98b7498dc2992f7f0868f79b65ce4a720a3acdb63ab3f1f1cb6881117a5406` | 已下载并核对 .dsc 摘要 |
| fonts-liberation_1.07.4-11.dsc | 2176 | `c9cb6abc8b8ab1887d78f5fc1aef1fc06a220efbfa3424ca7e8bc379242654ba` | 已下载；PGP 未验签 |
| fonts-liberation_1.07.4-11.debian.tar.xz | 17248 | `45ea32aab7eed82061493edbf5ef621d6fd7f074cb79ae45206014913ca5f313` | 仅 .dsc 和官方索引所列预期值；本机 TLS 下载失败，未取得或应用 |

原始档案已解包到 `.cache/release-audit/source/liberation-fonts-1.07.4/`，包含 16 个 SFD 和三份 FontForge 脚本。四份 Sans 字形源文件均写 `Version: 1.07.4`。README 指定 FontForge，Makefile 的默认 all/build → ttf-dir 通过 scripts/fontexport.pe 导出，实际输出目录为 `liberation-fonts-ttf-1.07.4`；不要只照 README 的旧 build 目录措辞判断产物。此处只读过脚本，没有执行。

| 关键构建/许可材料 | SHA256 |
| --- | --- |
| Makefile | `78f5441712f066d30a9bd525515cd40f0e956616133b89763c3a4156dc5e6af6` |
| scripts/fontexport.pe | `cc3d3bf735b45aa5f1fdd983de140a7d54c4508281b19fc589afb5d9446f7ad5` |
| scripts/sfd2ttf.pe | `cad5e8e6ef87a3a80271ede667f07d901aa23cc760ea30a8b8dc46712aac9aaf` |
| scripts/ttf2sfd.pe | `ac63c7445ea7e9a0f8312ed4f027e71a31af021380beb07829567053dc65b731` |
| License.txt | `c40dd6adebad817defd68c7edad151d9c13d2ac3b4e1790ce2b727b024438b6d` |
| COPYING | `ab15fd526bd8dd18a9e77ebc139656bf4d33e97fc7238cd11bf60e2b9b8666c6` |

全部成员、SFD 摘要和检查布尔值见本机忽略缓存 `.cache/release-audit/source-evidence.json`。同版及脚本存在已证实；源→TTF 对应性仍须更强证据，字节重现未验证。

## 条款与当前差距

以下依据实际随包 [LICENSE_LIBERATION](../../resources/licenses/pdfjs/standard_fonts/LICENSE_LIBERATION)、档案 License.txt/COPYING 及项目根 [AGPL 正文](../../LICENSE)。[Debian 在线原文](https://sources.debian.org/src/fonts-liberation/1:1.07.4-11/License.txt)可交叉核对 Liberation 例外。1.07.4 不适用 2.x 的 OFL，不应替换条文。

| 对象/条文 | 当前已确认 | 公开分发前所需动作 |
| --- | --- | --- |
| 字体 GPLv2 §§1–3 | 完整许可和版权文本随 ASAR/通知保存；源码候选已固定摘要 | 确定此二进制的完整对应源码、编译/安装脚本，并落实 §3 适用的提供方式。数字下载可采用同一指定地点提供等同源码获取的方式；不是必须将源码塞进 ASAR |
| 字体例外 §1(a) | 对文档嵌入的特别条款已原样保留 | 不能将文档嵌入例外扩展为独立 TTF 随应用分发免除源码条件 |
| 字体例外 §1(b) | 原文明确涉及随 physical product 分发时的源码修改及重装权利 | 若以后随实体产品交付，单独核对该条件和实际重装方法；本轮没有做实体产品交付适用性结论 |
| 字体商标条款 §2 | 当前保持原文件名，没有改字体 | 若改动字体，须核查移除 Red Hat 商标引用的文件名及宣传限制，并保留/处理例外声明；本轮不改字体 |
| PaperFlow AGPL §§1、4–6 | 源码在工作区，AGPL 正文和声明随包 | 将本版首选修改形式源码、锁文件、资源、接口定义、构建/安装脚本和必要依赖来源固定成对应源码包，按选用渠道提供；声明和编译 JS 不构成完整证明 |
| Electron/FFmpeg 等运行时 | Electron MIT、Chromium 综合通知实际随包 | 固定该 Electron 发行的源 revision、第三方依赖/补丁和实际编译配置；针对实际采用的许可落实源码/重链接材料。综合 HTML 中可选 GPL 条目不能证明已启用该功能 |
| MIT/BSD/Apache 等材料 | 已审计的 41 份原文和通知逐字节保留 | 后续打包变更再次核对实际进入二进制/资源的组件；不能用开发依赖标签排除前端捆绑代码 |

对 GPLv2 与 AGPL 在此分发组合中的适用关系，本轮没有作整体兼容性结论；保留字体为独立资源的事实、具体版本和条款，供正式分发审核。未发现远程交互服务，不因 AGPL 名称自行引入网络服务；如果未来产品行为变化再重新核对 §13 等条款。

## 建议主控另派的具体补证工作

1. 保存现有审计缓存的档案、描述、JSON 和成员摘要到可长期保全的位置；将同一发行版本的字体源码附件和应用对应源码附件纳入最终交付清单。`.cache` 被忽略，本文链接在单独源码提交后可能不可用。
2. 在隔离环境审阅 FontForge 导出流程，固定 FontForge/构建环境、命令和产物摘要；对四份 TTF 检查字形顺序、宽度、name 和 hinting 数据。若无法逐字节重现，记录差异与原因，不篡改现有结果。字节相同是强来源证据，不在本报告中被错误列为所有许可的普遍法定条件。
3. 固定应用 0.1.0 对应源码归档、锁文件和构建材料，记录归档→源 commit→ASAR/安装包的映射；不把当前 out/ASAR 比对替代干净环境构建证据。按实际交付方式提供源码与通知，验证受领者能取得，保存可用性记录。
4. 为 Electron 44.7.2 / ffmpeg.dll 建立确切上游来源、配置及适用许可证据；8 个 better-sqlite3 跨平台预编译文件也应列入来源范围，或由主控另派打包裁减评估。不能把 MIT 来源追溯问题直接认定为 GPL 违规。
5. 主控更新正式 third-party-licenses、THIRD-PARTY-NOTICES 与交付说明中“尚未下载源码”的历史表述，并绑定新的发行材料；此类共享/生产文件不在本模块当前写权限内。本轮缓存更新不会自动修复旧包里的说明。
6. 需要时增加易于发现的许可和源码入口，再由 QA 验证安装后流程；按主控另派的窗口操作。本轮不重打包、不签名、不上传。

不可将“换成 OFL 2.x”当成无风险文字替换。[Mozilla 同版说明](https://raw.githubusercontent.com/mozilla/pdf.js/v6.4.299/external/standard_fonts/README.md)指出字形顺序与其 widths/factors 数据绑定；字体更换需要另行实现、坐标/排版与回归验收。
