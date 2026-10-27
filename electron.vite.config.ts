import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
  main: {},
  preload: { build: { externalizeDeps: false, isolatedEntries: true, rollupOptions: {
    input: { index: resolve('src/preload/index.ts'), validation: resolve('src/preload/validation.ts') },
    output: { format: 'cjs', entryFileNames: '[name].js', codeSplitting: false }
  } } },
  renderer: {
    html: { cspNonce: 'paperflow-dev' },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), validation: resolve('src/renderer/validation.html') } } },
    resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    plugins: [react(), tailwindcss()]
  }
})
