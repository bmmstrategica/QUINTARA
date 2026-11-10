/**
 * Visual regression: key web app screens compared with the approved screenshots in e2e/visual.spec.ts-snapshots/.
 * The app runs on its offline mock (fixed sample data) with the browser clock frozen, so a difference is a real change.
 *   pnpm visual                       compare
 *   pnpm visual --update-snapshots    approve the current look (review the images before committing them)
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'visual.spec.ts',
  timeout: 90_000,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-visual-report' }]] : 'list',
  // Runs draw identical pixels, so the comparison is strict: a faint colour change in small text must fail.
  expect: { toHaveScreenshot: { threshold: 0.05, maxDiffPixels: 150, animations: 'disabled', caret: 'hide', stylePath: './e2e/visual.css' } },
  use: { trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    // No API address: the web app uses its offline mock, whose data is fixed.
    { command: 'pnpm --filter @quintara/web exec next dev -p 3100', url: 'http://localhost:3100', reuseExistingServer: !process.env.CI, timeout: 180_000, env: { NEXT_PUBLIC_API_URL: '' } },
  ],
});
