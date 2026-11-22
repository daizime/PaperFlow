# 本地源码材料交付准备

任务 `PFV-RELEASE-003`，run `20261028-source-delivery-01`，2026-10-28。本轮只准备本地材料和补足来源证据，没有构建、测试、安装、提交或公开发布。

**这份源码包仅对应历史 `PF-CONTINUE-20261028-09` 与旧 `PF-VERIFY-20261028-07` 实测程序，不含随后启动的文字/公式拖选修复和新补验测试。** 09 是含未提交内容的工作树快照，不称干净 HEAD。主控在本轮中要求修复选区后，已冻结旧包摘要，不再读取变化中的 out 作新结论。

## 可取得的本地材料

唯一新建目录（本机忽略路径）：`release/source/20261028-source-delivery-01/`。

| 材料 | 作用 |
| --- | --- |
| 应用源码 ZIP（`release/source/20261028-source-delivery-01/PaperFlow-0.1.0-source-PF-CONTINUE-20261028-09.zip`） | 由09不可变快照读取的142项应用源码、锁文件、构建/资源脚本与当时验证材料 |
| `release/source/20261028-source-delivery-01/source-manifest.json` | 全部ZIP成员大小/SHA256及回读结果 |
| `release/source/20261028-source-delivery-01/binary-source-map.json` | 与旧安装包、blockmap、EXE、ASAR四项摘要的映射 |
| `release/source/20261028-source-delivery-01/获取与构建说明.md` | 中文获取、隔离解包、依赖安装和后续构建说明；本轮未执行这些命令 |
| 字体来源附件（`release/source/20261028-source-delivery-01/Liberation-1.07.4-source/source-materials.json`） | 现存官方1.07.4原档/.dsc、许可、Makefile及三份脚本摘要 |
| 追加验签结果（`release/source/20261028-source-delivery-01/Liberation-1.07.4-source/signature-verification.json`） | 官方钥匙库取得的公钥及GPG密码学验签；不回写001历史 |
| 运行时来源（`release/source/20261028-source-delivery-01/runtime-provenance/来源说明.md`） | Electron/Chromium/FFmpeg固定版本、配置、源码归档、许可、补丁与实际错误 |

结束时已生成 `release/source/20261028-source-delivery-01/delivery-manifest.json` 与 `release/source/20261028-source-delivery-01/SHA256SUMS.txt`。清单覆盖38个材料文件、25811137字节（不含清单自身及校验表），清单SHA256为 `d39f2e54be8b45cf10da082b634a4d5b83a6cf7609d148bb71183637c871d69d`；校验表另含清单自身摘要。清单排除本机GPG工作目录和历史私有缓存。

ZIP 为3248926字节，SHA256 `137762c1cb5f3098093f640231912c814a33146f504c0d90b9817d91d725078d`；09 snapshot.zip 为 `c98fed27bdba4440e8103a24edf38eafb55d02c9f7417f9cb2efc29da6e7b736`。142项均从快照读取，生成后逐项回读hash/size一致。路径安全、重复/大小写冲突、链接、明确排除目录和已知聊天ID/私钥/令牌标记均检查过；未把真实文献、状态目录、node_modules或应用产物带进源码ZIP。

2026-10-28 21:21:43 +08:00 打包捕获时，127项非文档文件与旧07及当时工作区一致。之后 reader/qa 获准开展新修复，因此不再以当前工作区是否相同评价这份历史包。包内旧文档中的缓存链接及 source-files.txt 不替代交付ZIP清单。

## 旧实测二进制对应关系

| 对象 | 字节 | SHA256 |
| --- | ---: | --- |
| NSIS安装包 | 122993353 | `d488a699708e93b7da76e598274451f6eaf075ebf731c0f7a8a9573bef1777f7` |
| blockmap | 130501 | `d9334b4152e4110bfac04e2030253b98faf34f21c08212c0f92beac19307838e` |
| PaperFlow.exe | 245590016 | `aa290d32926ae9c999fa479f4e8bb90b48737b495dba5c1976e8d93453201498` |
| app.asar | 33280280 | `98ab809a7ff0c07356b77f177c8b56a205c29b14061b0fe7a03d8d5cd9336d9c` |

以上与本轮开始的 docs/artifacts.json 一致，副本与摘要保存在 `.cache/release-audit/remaining/{artifacts-frozen09,binary-freeze}.json`。没有修改总产物索引。其执行证据仍是QA002，不冒充本轮重跑；用户后来手动完成系统框导入的确认来自主控派发消息，并非本模块独立操作，未改写包内历史记录。

## 字体签名与源码

1.07.4原始源档2937949字节，SHA256 `ad98b7498dc2992f7f0868f79b65ce4a720a3acdb63ab3f1f1cb6881117a5406`，匹配保存的 .dsc 摘要。沿用001取得的原件，不重新下载或覆盖；独立来源附件保留同样字节和许可/脚本。

本轮使用现有 Git 自带GPG，公钥从[Debian官方钥匙库](https://keyring.debian.org/pks/lookup?op=get&search=0xB8BF54137B09D35CF026FE9D091AB856069AAA1C)取得，指纹 `B8BF54137B09D35CF026FE9D091AB856069AAA1C`。2026-10-28 21:26:13 +08:00，隔离GPG目录验证退出0，并报告 GOODSIG/VALIDSIG；未设ownertrust，TRUST_UNDEFINED警告保留，不能据此作超出该公钥与签名的身份保证。附件 source-materials.json 是制作时“未验签”的历史摘要，signature-verification.json 追加之后的有效签名结果。

本机没有找到FontForge，没有编译字体或证明TTF逐字节重现。首次受限GPG启动报NtCreateDirectoryObject权限错误，随后首次正常执行又因MSYS路径解释和缺公钥退出2；原错误保存在审计缓存。改用隔离POSIX路径并导入官方公钥后才通过，未安装工具或更改全局信任。

## 运行时来源已补足的环节

已保存[Electron v44.7.2官方release](https://github.com/electron/electron/releases/tag/v44.7.2)与精确commit `774d5d0a051374923758372a4ee4bf04f473151d` 的依赖/配置证据；Chromium为152.0.7977.149，FFmpeg fork为 `2b68d2babae73714846961fb0ee47e3b3d2e39a9`。完整Electron ZIP摘要与官方SHASUMS一致，其ffmpeg.dll成员也与旧程序的 `53fdd1a47262180499a1897d99dc36234be6ef6fb36bfd22a754ef1ac68d873f` 相同。

[官方固定revision源归档](https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/2b68d2babae73714846961fb0ee47e3b3d2e39a9.tar.gz)已保存，18821714字节，SHA256 `c562fee79f5d4bf8f51cf97d4aa7366187ed175ebd537fd25c75aa61f1f4b3b0`；只读核对11015个常规成员及TAR头，6份关键原文与同revision独立取回内容相同。Electron FFmpeg补丁列表和唯一补丁、默认Chrome branding/共享FFmpeg参数、Windows x64基准config.h及LGPL原文均已固定URL/取回时间/hash。独立FFmpeg ZIP的Chromium branding配置与正常Electron发行不同，没有混用。

详细依据和实际失败见附件provenance.json与 `.cache/release-audit/remaining/`。GitHub tag API返回403限流；基准README指向的chromium/patches/README返回404，均未猜测或以其他版本替代。

## 仍未闭合

这是一份可离线读取的应用源码材料及部分第三方来源附件，构建依赖未全部装入，完整Electron/Chromium依赖源码、最终工具链/GN参数/PGO日志与DLL重建仍未验证。它不保证完全离线或字节可复现构建。字体重建、适用的重链接/安装材料、公开获取渠道与签名发布仍待安排；不能把本地缓存转成附件就宣称所有许可义务完成。

本轮保留应用安全配置、旧二进制、001/002历史和原失败，未发布或进入T04–T08。新文字选区修复须以另任务的源码、构建与验收结果重新绑定材料。
