import { rm } from 'node:fs/promises'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export default async function globalTeardown(): Promise<void> {
  const runRoot = process.env.PAPERFLOW_E2E_RUN_ROOT
  if (!runRoot) return
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(runRoot, { recursive: true, force: true })
      return
    } catch {
      await sleep(300)
    }
  }
}
