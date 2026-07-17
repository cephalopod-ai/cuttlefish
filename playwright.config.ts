import { defineConfig } from '@playwright/test'

const e2ePort = Number(process.env.CUTTLEFISH_E2E_PORT ?? 7779)
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: e2eBaseUrl,
    headless: true,
  },
  webServer: {
    command: 'pnpm build && node scripts/start-e2e-server.mjs',
    url: `${e2eBaseUrl}/api/readyz`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
})
