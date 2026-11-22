# 第三方依赖与许可证

核验日期：2026-10-27。PaperFlow 自有代码按根目录 `LICENSE` 与 `package.json` 声明为 **AGPL-3.0-only**；第三方组件保留各自条款，不统一改标为 AGPL。

## 核验依据与范围

本清单读取当前 `package.json`、`pnpm-lock.yaml`、已安装包的 `package.json` 和实际 LICENSE/NOTICE。主要许可证原文已逐字节复制至 `resources/licenses/`；[manifest.json](../resources/licenses/manifest.json) 保存相对来源、实际版本、字节数和 SHA-256。覆盖范围是直接依赖、产品使用的 npm 间接依赖与 PDF.js/Electron 通知；没有声称已逐项审阅全部开发工具的间接依赖。

`pnpm licenses list --prod --json` 本机返回 `ERR_PNPM_MISSING_PACKAGE_INDEX_FILE`（pnpm 缓存索引缺失）；未将此命令记为通过，改用上述磁盘证据逐包核验。以下是本次安装版本，不是建议版本。

## 主进程外部运行依赖

工程初始化来自官方 `@quick-start/create-electron@1.0.31` 的 `base/react-ts` 模板；其 MIT 许可证与 `Copyright (c) 2022, Alex Wei` 原样保留在 [scaffold/LICENSE](../resources/licenses/scaffold/LICENSE)，来源包及 SHA-256 记录于 manifest 的 scaffold 项。这是初始化来源，不是产品运行依赖。

| 组件 | 实际版本 | 许可证 | 保留的上游原文 |
| --- | --- | --- | --- |
| `better-sqlite3` | 13.0.3 | MIT | [LICENSE](../resources/licenses/npm/better-sqlite3-13.0.3/LICENSE) |
| `zod` | 4.6.7 | MIT | [LICENSE](../resources/licenses/npm/zod-4.6.7/LICENSE) |

## 前端运行代码与 PDF 引擎

这些组件列在 `devDependencies`，由 Vite 将所用 JavaScript/CSS/Worker 打包进 `out/renderer`；它们仍是产品使用的第三方软件。PDF.js 的 CMaps、字体与图像解码资源由准备脚本单独复制，见后文。

| 组件 | 实际版本 | 许可证 | 保留的上游原文 |
| --- | --- | --- | --- |
| `pdfjs-dist` | 6.4.299 | Apache-2.0 | [LICENSE](../resources/licenses/npm/pdfjs-dist-6.4.299/LICENSE) |
| `react` | 19.3.0 | MIT | [LICENSE](../resources/licenses/npm/react-19.3.0/LICENSE) |
| `react-dom` | 19.3.0 | MIT | [LICENSE](../resources/licenses/npm/react-dom-19.3.0/LICENSE) |

## 使用的 npm 间接依赖

| 组件 | 实际版本 | 许可证 | 保留的上游原文 |
| --- | --- | --- | --- |
| `node-addon-api` | 8.9.2 | MIT | [LICENSE.md](../resources/licenses/npm/node-addon-api-8.9.2/LICENSE.md) |
| `scheduler` | 0.28.0 | MIT | [LICENSE](../resources/licenses/npm/scheduler-0.28.0/LICENSE) |

`node-addon-api` 是 better-sqlite3 的构建接口，`scheduler` 由 React DOM 使用。SQLite 3.53.4 的实际版本可由已安装 `better-sqlite3/deps/sqlite3/sqlite3.c` 首部核定；该文件版权声明放弃版权并附 blessing，不能把 SQLite 核心的许可证误写为 better-sqlite3 的 MIT。

## 开发、测试与打包依赖

下表按用途区分。Electron 虽放在 `devDependencies`，其运行时二进制仍随桌面安装包分发。构建工具通常不作为产品运行依赖，但其输出包含的安装器资源或代码仍须保留相应通知。

| 组件 | 实际版本 | 许可证 | 保留的上游原文 |
| --- | --- | --- | --- |
| `@playwright/test` | 1.64.1 | Apache-2.0 | [LICENSE](../resources/licenses/npm/playwright--test-1.64.1/LICENSE)、[NOTICE](../resources/licenses/npm/playwright--test-1.64.1/NOTICE) |
| `@tailwindcss/vite` | 4.3.3 | MIT | [LICENSE](../resources/licenses/npm/tailwindcss--vite-4.3.3/LICENSE) |
| `@types/better-sqlite3` | 7.6.13 | MIT | [LICENSE](../resources/licenses/npm/types--better-sqlite3-7.6.13/LICENSE) |
| `@types/node` | 24.19.2 | MIT | [LICENSE](../resources/licenses/npm/types--node-24.19.2/LICENSE) |
| `@types/react` | 19.3.0 | MIT | [LICENSE](../resources/licenses/npm/types--react-19.3.0/LICENSE) |
| `@types/react-dom` | 19.3.0 | MIT | [LICENSE](../resources/licenses/npm/types--react-dom-19.3.0/LICENSE) |
| `@vitejs/plugin-react` | 6.1.2 | MIT | [LICENSE](../resources/licenses/npm/vitejs--plugin-react-6.1.2/LICENSE) |
| `electron` | 44.7.2 | MIT | [LICENSE](../resources/licenses/npm/electron-44.7.2/LICENSE) |
| `electron-builder` | 26.15.3 | MIT | [LICENSE](../resources/licenses/npm/electron-builder-26.15.3/LICENSE) |
| `electron-vite` | 6.0.0 | MIT | [LICENSE](../resources/licenses/npm/electron-vite-6.0.0/LICENSE) |
| `eslint` | 10.13.0 | MIT | [LICENSE](../resources/licenses/npm/eslint-10.13.0/LICENSE) |
| `eslint-plugin-react-hooks` | 7.1.1 | MIT | [LICENSE](../resources/licenses/npm/eslint-plugin-react-hooks-7.1.1/LICENSE) |
| `pdf-lib` | 1.17.1 | MIT | [LICENSE.md](../resources/licenses/npm/pdf-lib-1.17.1/LICENSE.md) |
| `tailwindcss` | 4.3.3 | MIT | [LICENSE](../resources/licenses/npm/tailwindcss-4.3.3/LICENSE) |
| `tsx` | 4.23.15 | MIT | [LICENSE](../resources/licenses/npm/tsx-4.23.15/LICENSE) |
| `typescript` | 5.9.3 | Apache-2.0 | [LICENSE.txt](../resources/licenses/npm/typescript-5.9.3/LICENSE.txt) |
| `typescript-eslint` | 8.72.0 | MIT | [LICENSE](../resources/licenses/npm/typescript-eslint-8.72.0/LICENSE) |
| `vite` | 8.3.4 | MIT | [LICENSE.md](../resources/licenses/npm/vite-8.3.4/LICENSE.md) |
| `vitest` | 5.0.5 | MIT | [LICENSE.md](../resources/licenses/npm/vitest-5.0.5/LICENSE.md) |

## PDF.js 随附资源

这些资源须与 Worker 一起离线可用，不能只保留 PDF.js 顶层 Apache 许可证。原文按已安装 `pdfjs-dist@6.4.299` 核定并保留于 [resources/licenses/pdfjs](../resources/licenses/pdfjs)。准备脚本同时保留资源目录自带的 LICENSE 文件。

| 随附内容 | 实际许可证/声明 | 对应原文 |
| --- | --- | --- |
| Adobe CMaps `cmaps/*.bcmap` | 三条件 BSD 式许可；Adobe Systems 1990–2009 版权声明 | [cmaps/LICENSE](../resources/licenses/pdfjs/cmaps/LICENSE) |
| Foxit/PDFium 标准字体 `Foxit*.pfb` | BSD 三条件式许可；PDFium Authors 2014 | [LICENSE_FOXIT](../resources/licenses/pdfjs/standard_fonts/LICENSE_FOXIT) |
| Liberation Sans 四个 TTF | **GPL v2 + Liberation 字体例外**；Red Hat 2007–2011，不能写成 OFL 1.1 | [LICENSE_LIBERATION](../resources/licenses/pdfjs/standard_fonts/LICENSE_LIBERATION) |
| JBIG2 WASM 与 JS fallback | PDFium BSD 三条件条款及所附 Apache-2.0 原文；PDF.js wrapper 为 Apache-2.0 | [LICENSE_JBIG2](../resources/licenses/pdfjs/wasm/LICENSE_JBIG2)、[LICENSE_PDFJS_JBIG2](../resources/licenses/pdfjs/wasm/LICENSE_PDFJS_JBIG2) |
| OpenJPEG WASM 与 JS fallback | BSD 二条件；PDF.js wrapper 同为 BSD 二条件 | [LICENSE_OPENJPEG](../resources/licenses/pdfjs/wasm/LICENSE_OPENJPEG)、[LICENSE_PDFJS_OPENJPEG](../resources/licenses/pdfjs/wasm/LICENSE_PDFJS_OPENJPEG) |
| QCMS WASM | MIT；PDF.js wrapper 为 MIT | [LICENSE_QCMS](../resources/licenses/pdfjs/wasm/LICENSE_QCMS)、[LICENSE_PDFJS_QCMS](../resources/licenses/pdfjs/wasm/LICENSE_PDFJS_QCMS) |
| ICC profile `CGATS001Compat-v2-micro.icc` | CC0 1.0；以本地 `iccUrl` 提供 | [iccs/LICENSE](../resources/licenses/pdfjs/iccs/LICENSE) |

Mozilla 对应版本的 [标准字体说明](https://raw.githubusercontent.com/mozilla/pdf.js/v6.4.299/external/standard_fonts/README.md) 明确将 Liberation Sans 标为 **1.07.4**。该版本使用 GPL v2 与字体例外；后续 2.x 字体的 OFL 条款不能替代本版文件。字体例外主要针对文档嵌入，不能据此免除字体文件本身的分发条件。完整原文已保留。

字体源码获取入口为 [上游 Liberation 1.7 仓库](https://github.com/liberationfonts/liberation-1.7-fonts)；其 README 所列 1.07.4 的 Pagure 源码压缩包链接核查返回 404。后续多会话验证已从 [Debian 官方发行池](https://deb.debian.org/debian/pool/main/f/fonts-liberation/)保存 `fonts-liberation_1.07.4.orig.tar.gz` 与 `.dsc`，源码档案 SHA256 为 `ad98b7498dc2992f7f0868f79b65ce4a720a3acdb63ab3f1f1cb6881117a5406`，与 `.dsc` 摘要一致；PGP 未验签。该档案包含 16 份 SFD、Makefile、许可正文与 FontForge 导出脚本，当前仅保存在本机审计证据中，详见 [源码补证方案](verification/license-source-plan.md)。没有执行字体编译或证明与随包 TTF 逐字节重现；正式公开分发前，仍需落实对应源码与构建材料的实际提供方式。**已保存源码及许可证不等于已完成全部分发义务。**

本阶段不启用 PDF 脚本执行。`quickjs-eval.js` 与 `quickjs-eval.wasm` 已在准备脚本中排除；不将未使用的脚本引擎混入发布资源。

## Electron、Chromium 和原生二进制

Electron 44.7.2 的 [运行时 MIT 许可证](../resources/licenses/electron/LICENSE) 与 [完整 Chromium 第三方声明](../resources/licenses/electron/LICENSES.chromium.html) 从本机 Electron distribution 原样复制。后者包含 Chromium、Node.js 及其所附第三方组件的具体条目，不能用一句“Electron 为 MIT”覆盖整个运行时。打包核验还应确认安装目录保留 Electron 自带 `LICENSE.electron.txt`/`LICENSES.chromium.html` 等发行材料，以及应用内本目录的通知。

PDF.js npm 安装图还包含可选 `@napi-rs/canvas@1.0.13` 与 `@napi-rs/canvas-win32-x64-msvc@1.0.13`。前者实际 LICENSE 为 MIT，平台包仅有 MIT 元数据、无独立 LICENSE。当前 PDF.js 为前端构建依赖，Chromium Canvas 渲染路径不调用它，生产 npm 依赖图不再包含该可选二进制。相关 wrapper 许可证仅作来源存档；如将来启用或分发该原生库，须另核其二进制内嵌组件，不能据 npm 元数据宣称审查完成。

## 发布与后续核查

当前提供本地测试工程与测试安装包，不自动发布 GitHub Release，也不作整体分发合规保证。公开发布时，应按实际产物复核通知是否随包、源码提供方式、AGPL-3.0-only 对应源码与构建脚本，并落实上述字体源码事项。AGPL 正文及项目声明应与产品一起可获取。

**未安装或集成 pdf2zh-next、BabelDOC、PyMuPDF、Python 翻译运行时、OCR 或任何 LLM 服务。** 后续引入它们前，需按具体版本、链接方式、进程调用和二进制分发内容重新审查整体许可义务；当前清单不预先替未来组合背书。
