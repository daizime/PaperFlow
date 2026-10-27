/// <reference types="vite/client" />
import type { PaperFlowAPI } from '../../shared/contracts'
declare global {
  interface Window {
    paperflow: PaperFlowAPI
    pdfValidation: {
      onBytes(callback: (bytes: Uint8Array) => void): void
      report(result: { pageCount: number | null; error: string | null }): void
    }
  }
}
