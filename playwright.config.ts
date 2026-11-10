/**
 * End-to-end journeys across the web app, the admin console and the API, in a real browser.
 * Run:  pnpm e2e        (starts all three on an in-memory database with sample data)
 *       E2E_TARGET=production pnpm e2e   (the same tests against `next build` + `next start` of each app, as deployed:
 *       production builds behave differently in places, and only they show what the build bakes in)
 */
import { defineConfig, devices } from '@playwright/test';

const api = 'http://localhost:4000';
const production = process.env.E2E_TARGET === 'production';
/** How each web app is served: its development server, or a production build of it. */
const serve = (pkg: string) => (production ? `pnpm --filter ${pkg} build && pnpm --filter ${pkg} start` : `pnpm --filter ${pkg} dev`);
const webTimeout = production ? 420_000 : 180_000;
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
    // The API without --watch: an edit during a run must not restart it on an empty database.
    { command: 'pnpm --filter @quintara/api start', url: `${api}/ready`, reuseExistingServer: !process.env.CI, timeout: 120_000, env: { PUSH: 'off', SIGN_IN_LIMIT: '200', STAFF_SEATS: '10' } },
    { command: serve('@quintara/web'), url: 'http://localhost:3000', reuseExistingServer: !process.env.CI, timeout: webTimeout, env: { NEXT_PUBLIC_API_URL: api } },
    { command: serve('@quintara/admin'), url: 'http://localhost:3001', reuseExistingServer: !process.env.CI, timeout: webTimeout, env: { NEXT_PUBLIC_API_URL: api } },
    { command: serve('@quintara/maison'), url: 'http://localhost:3002', reuseExistingServer: !process.env.CI, timeout: webTimeout, env: { NEXT_PUBLIC_API_URL: api, NEXT_PUBLIC_APP_URL: 'http://localhost:3000' } },
  ],
});
