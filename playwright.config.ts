/**
 * End-to-end journeys across the web app, the admin console and the API, in a real browser.
 * Run:  pnpm e2e        (starts all three on an in-memory database with sample data)
 */
import { defineConfig, devices } from '@playwright/test';

const api = 'http://localhost:4000';
export default defineConfig({
  testDir: 'e2e',
  // The visual comparison has its own config and server (playwright.visual.config.ts).
  testIgnore: 'visual.spec.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'off', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'pnpm --filter @quintara/api dev', url: `${api}/ready`, reuseExistingServer: !process.env.CI, timeout: 120_000, env: { PUSH: 'off', SIGN_IN_LIMIT: '200', STAFF_SEATS: '10' } },
    { command: 'pnpm --filter @quintara/web dev', url: 'http://localhost:3000', reuseExistingServer: !process.env.CI, timeout: 180_000, env: { NEXT_PUBLIC_API_URL: api } },
    { command: 'pnpm --filter @quintara/admin dev', url: 'http://localhost:3001', reuseExistingServer: !process.env.CI, timeout: 180_000, env: { NEXT_PUBLIC_API_URL: api } },
    { command: 'pnpm --filter @quintara/maison dev', url: 'http://localhost:3002', reuseExistingServer: !process.env.CI, timeout: 180_000, env: { NEXT_PUBLIC_API_URL: api, NEXT_PUBLIC_APP_URL: 'http://localhost:3000' } },
  ],
});
