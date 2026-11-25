import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PAPERFLOW_E2E_RUN_ROOT ??= join(tmpdir(), `paperflow-e2e-run-${process.pid}-${Date.now()}`)

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90000,
  workers: 1,
  reporter: 'list',
  globalTeardown: './tests/e2e/global-teardown.ts'
})
