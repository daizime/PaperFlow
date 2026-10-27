import { loadPdf, pdfErrorMessage } from './src/features/reader/pdf-engine'
window.pdfValidation.onBytes(async bytes => {
  const loading = loadPdf(bytes)
  try {
    const pdf = await loading.promise
    if (pdf.numPages < 1) throw new Error('Empty document')
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      await page.getOperatorList()
      page.cleanup()
    }
    window.pdfValidation.report({ pageCount: pdf.numPages, error: null })
  } catch (error: unknown) {
    window.pdfValidation.report({ pageCount: null, error: pdfErrorMessage(error) })
  } finally { await loading.destroy() }
})
