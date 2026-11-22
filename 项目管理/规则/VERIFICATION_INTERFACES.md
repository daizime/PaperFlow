# 本轮测试接口约定

`tests/e2e/helpers.ts` 唯一写入者为 qa。为 reader 的 DPI 模拟用例增加兼容的可选参数：

```ts
launchApp(dataDir: string, options?: { deviceScaleFactor?: number })
```

原有单参数调用保持原样。qa 根据已核实的 Electron 参数把指定倍率传入独立进程，必须读取实际 `window.devicePixelRatio` 验证生效，不能只检查传入参数。reader 可按此签名准备独立 E2E，但不修改公共 helper、不执行 Electron；公共执行仍由 qa 统一完成。

DPI 参数只用于测试，不修改 Windows 显示设置；测试报告标为进程模拟，不能宣称多种物理显示器已实测。倍率测试建议 1、1.25、1.5、2、3；实际执行集合和未执行项如实记录。

如需更改这一约定，由主控先更新任务和本文件，再通知受影响模块。
