/**
 * The look of the web app, screen by screen, in both themes, at desktop and phone widths. Data comes from the offline
 * mock and the clock is frozen at 9 November 2026 10:00 (Cape Town), so every run draws the same pixels.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const WEB = 'http://localhost:3100';
const NOW = new Date('2026-11-09T08:00:00Z');
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } } as const;
const VISITOR = ['/', '/experiences', '/sign-in', '/apply', '/boutique'];
const MEMBER = ['/', '/experiences', '/bookings', '/profile', '/concierge'];

async function prepare(page: Page, theme: 'dark' | 'light') {
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(new Date(NOW.getTime() + 1000));
  await page.addInitScript((t) => { try { window.localStorage.setItem('quintara.theme', t); } catch { /* ignore */ } }, theme);
}
/** Moves the frozen clock on in small steps (the mock answers after a short timer) until `done` holds. */
async function advanceUntil(page: Page, done: () => Promise<boolean>) {
  for (let i = 0; i < 40 && !(await done()); i++) await page.clock.runFor(300);
}
async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  // Loading shows grey skeleton bars; wait until every one has given way to content.
  await advanceUntil(page, async () => (await page.locator('.skeleton').count()) === 0);
  await expect(page.locator('.skeleton')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}
const slug = (path: string) => (path === '/' ? 'home' : path.slice(1).replace(/\//g, '-'));

for (const theme of ['dark', 'light'] as const) {
  for (const [size, viewport] of Object.entries(VIEWPORTS)) {
    test(`visitor screens, ${theme}, ${size}`, async ({ browser }) => {
      const page = await browser.newPage({ viewport });
      await prepare(page, theme);
      for (const path of VISITOR) {
        await page.goto(WEB + path);
        await settle(page);
        await expect(page).toHaveScreenshot(`visitor-${slug(path)}-${theme}-${size}.png`, { fullPage: true });
      }
      await page.close();
    });

    test(`member screens, ${theme}, ${size}`, async ({ browser }) => {
      const page = await browser.newPage({ viewport });
      await prepare(page, theme);
      await page.goto(`${WEB}/sign-in`);
      await page.locator('input[type=email]').fill('thandi@example.com');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await advanceUntil(page, async () => !new URL(page.url()).pathname.startsWith('/sign-in'));
      await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
      for (const path of MEMBER) {
        await page.goto(WEB + path);
        await settle(page);
        await expect(page).toHaveScreenshot(`member-${slug(path)}-${theme}-${size}.png`, { fullPage: true });
      }
      await page.close();
    });
  }
}
