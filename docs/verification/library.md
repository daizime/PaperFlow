# 本地文献服务故障验证

任务：`PFV-LIBRARY-001` / `20261027-verification-01`；日期：2026-10-27（Asia/Shanghai）。

**revision 2已修复SQLite `SQLITE_FULL`直接返回英文提示的缺陷；原错误提示断言不变，16项定向测试全部通过。锁助手已实际使用Windows自带PowerShell 5.1.26100.9711（Desktop），无需另装PowerShell 7。初轮15通过/1失败的JSON和日志保留。**

基线为 `PF-VERIFY-20261027-01`、Git `0779111916f8ab3360619e5302cd83e2dd823168`。初轮核对文件服务、数据库、原单测、PDF素材、package、锁文件和Vitest配置共7项SHA256，均与基线一致，详见 `.cache/library/20261027-baseline-check.json`。revision 2追加唯一授权后，仅将`document-service.ts`中`friendlyFileError`的`ENOSPC`判断扩展为`ENOSPC || SQLITE_FULL`，复用原中文空间不足提示。其余产品源码、共享配置、旧测试及Git索引未修改；未执行构建、打包、Electron和公共全套。

## 结果与证据性质

| 范围 | 本轮操作与结果 | 证据限制 |
|---|---|---|
| Windows真实独占锁 | Windows PowerShell 5.1用`FileStream`的`FileShare.None`持有测试PDF；Node实际读取返回`EBUSY`；服务显示“文件可能被占用”，无记录/副本；释放后同一服务可重试 | 真实操作系统文件锁；仅使用自建缓存文件 |
| 精确大小 | 实际构造104857600字节文件，经完整快照、哈希、临时写入、同步、重命名与入库；源、数据库及副本SHA256一致；加1字节在校验器调用前拒绝 | 精确边界项用返回3页的校验器替身，构造文件含零填充；不证明PDF.js能解析100MiB真实论文 |
| 读取中变化 | 在真实句柄首次读取时编排截短、追加和同尺寸改写（明确改变mtime）；均报告文件变化、关闭句柄、清理并可重试 | 注入时序，实际文件操作；不声称覆盖全部并发时序 |
| 快照完成后变化 | 在页数校验回调中修改源文件；存储内容与哈希仍匹配原快照 | 使用pdf-lib校验原创测试PDF，未运行Electron沙盒校验器 |
| 写入故障 | 部分写入后`ENOSPC`、`sync`时`EIO`、重命名时`EPERM`、创建临时文件前`EACCES`；均给出中文错误、无记录/副本，解除后同服务重试通过 | 均为明确注入；未填满实际磁盘 |
| 清理失败 | 部分写入错误叠加`unlink EPERM`，报告“无法清理”；观察到8字节临时副本；测试显式人工清除后才重试成功 | 不把残留自动恢复记为通过；残留名称、大小在观察记录中 |
| SQLite拒绝插入 | 在测试数据库建立`BEFORE INSERT`触发器`RAISE(ABORT)`；真实SQLite拒绝后已重命名副本被清理；移除触发器后可重试 | 人工触发器制造错误，非物理磁盘故障 |
| SQLite空间提示 | 对`insertDocument`注入`SQLITE_FULL`；初轮英文提示导致断言失败；revision 2映射中文空间不足，原断言、清理/重试均通过 | 接口故障注入，不能宣称真实磁盘满；未验证桌面显示 |
| 正常关闭再开 | 文献、2页/1.75倍率阅读状态、读回哈希保留；`integrity_check=ok`、`user_version=1` | 正常关闭恢复，不代表崩溃或物理断电恢复 |
| 孤立副本 | 人工放置UUID PDF与`.tmp`后关闭再开；两文件保留且未入库 | 确认当前没有自动清理；非断电实验 |

## 缺陷定位、原始复现与修复

初轮`src/main/services/document-service.ts`的`friendlyFileError`只转换文件系统`ENOSPC`，未识别`SQLITE_FULL`。`importSnapshot`将数据库错误传入该方法，原英文消息因而直接返回。

新增测试中“SQLite 插入注入 SQLITE_FULL 时应给出可理解的磁盘空间提示”先验证数据库无记录、库目录为空，再解除注入并成功重试，最后核对用户错误；初轮实际为`database or disk is full`，期望中文空间不足提示。主控确认后通过任务revision 2及OWNERSHIP追加唯一修改授权。产品修复只有上述一行错误映射；原失败断言保留，修复后实际返回“磁盘空间不足，无法保存文献。请释放空间后重试。”，16项全部通过。修复前源码、观察记录及报告快照见`.cache/library/20261027-before-revision2-*`。

## 重跑与原始输出

从项目根运行：

```powershell
pnpm exec vitest run tests/unit/library-robustness.test.ts --configLoader runner --cache=false --fsModuleCache=false --attachmentsDir=.cache/library/attachments --reporter=verbose --reporter=json --outputFile=.cache/library/20261027-r2-results.json --testTimeout=30000 --hookTimeout=15000
```

真实锁辅助脚本为 `scripts/verification/library-faults.ps1`，仅允许操作本项目`.cache/library/`内的文件，子进程隐藏窗口并以就绪/释放文件同步。测试从`SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe`启动自带PowerShell；脚本记录实际版本和edition，UTF-8就绪文件读取兼容PowerShell 5.1的BOM。

- 修复后逐项输出：`.cache/library/20261027-r2-vitest.log`；结构结果：`.cache/library/20261027-r2-results.json`（16/16）；退出码：`.cache/library/20261027-r2-exit.json`（0）。
- 修复后Windows锁机制/版本/实际错误码、精确字节数/哈希、清理残留和中文SQLite提示：`.cache/library/20261027-r2-fault-observations.json`。修复前对应观察记录独立保存在`20261027-before-revision2-fault-observations.json`。
- 修复后的产品文件及新增测试ESLint、独立范围TypeScript检查通过；日志为`.cache/library/20261027-r2-eslint.log`与`20261027-r2-typecheck.log`，各自的`-exit.json`为0。
- 修复前逐项输出：`.cache/library/20261027-vitest.log`；结构结果：`.cache/library/20261027-results.json`（15/16）；退出码：`.cache/library/20261027-exit.json`（1），均未覆盖。
- 首轮16项同为15通过/1失败。初次静态检查的`prefer-const`和可选`open`参数类型问题仅修正在新增测试；原输出保留在`.cache/library/20261027-initial-{eslint,typecheck,vitest}.log`，首轮结构结果为`20261027-initial-results.json`。

未实测真实磁盘满、物理断电、进程中断后的自动恢复或真实大文件PDF.js解析；不得据本报告将这些项目标为通过。
