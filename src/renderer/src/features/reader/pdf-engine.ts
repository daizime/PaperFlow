import { GlobalWorkerOptions, PDFWorker, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
GlobalWorkerOptions.workerSrc = workerUrl
/** 输入始终是业务 IPC 返回的字节；Worker 与字体等资源均来自随包资产。 */
export function loadPdf(bytes: Uint8Array): { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> } {
  const assets = new URL('pdfjs/', document.baseURI)
  // app:// 在标准 URL API 中 origin 为 null；显式提供本地 Worker，避免 PDF.js 的跨源包装降级。
  const port = new Worker(workerUrl, { type: 'module', name: 'paperflow-pdf' })
  const worker = PDFWorker.create({ port })
  const task = getDocument({
    worker,
    data: bytes, cMapUrl: new URL('cmaps/', assets).href, cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', assets).href,
    iccUrl: new URL('iccs/', assets).href,
    wasmUrl: new URL('wasm/', assets).href,
    enableXfa: false, stopAtErrors: true, useSystemFonts: false
  })
  let destroyed = false
  return { promise: task.promise, async destroy() {
    if (destroyed) return
    destroyed = true
    try { await task.destroy() } finally { worker.destroy(); port.terminate() }
  } }
}
export function pdfErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'PasswordException') return '此 PDF 已加密或需要密码，当前版本暂不支持密码文献。'
  return '无法打开 PDF，文件可能已损坏或使用了不受支持的格式。'
}
export { TextLayer } from 'pdfjs-dist'
export type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
export type { PageViewport } from 'pdfjs-dist'
