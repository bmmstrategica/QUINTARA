/**
 * Accessibility: WCAG 2.1 A and AA rules checked by axe on the main screens of the web app, the admin console and the
 * Maison Quintara shop, in both themes, including open dialogs and an open conversation. Fails on any serious or
 * critical violation; minor and moderate ones are listed in the output for review.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const WEB = 'http://localhost:3000', ADMIN = 'http://localhost:3001', SHOP = 'http://localhost:3002';

async function check(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.skeleton')).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  for (const v of violations.filter((x) => !blocking.includes(x))) console.log(`[${where}] ${v.impact}: ${v.id} (${v.nodes.length})`);
  expect(blocking.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('; ')}`), where).toEqual([]);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript((t) => { try { localStorage.setItem('quintara.theme', t); } catch { /* ignore */ } }, theme);
      // Colours are measured once settled: with reduced motion the apps skip their fade-ins (which axe would sample half-way).
      await page.emulateMedia({ reducedMotion: 'reduce' });
    });

    test('web app: visitor and member screens', async ({ page }) => {
      test.setTimeout(240_000);
      for (const path of ['/', '/experiences', '/sign-in', '/apply', '/boutique', '/lifestyle', '/join', '/tv']) { await page.goto(WEB + path); await check(page, `web ${path}`); }
      await page.goto(`${WEB}/sign-in`);
      await page.locator('input[type=email]').fill('thandi@example.com');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
      for (const path of ['/', '/experiences', '/bookings', '/profile', '/messages', '/notifications', '/concierge', '/members', '/qera', '/business', '/search?q=cape']) { await page.goto(WEB + path); await check(page, `web member ${path}`); }
      await page.goto(`${WEB}/experiences`);
      await page.locator('article.item-row').first().getByRole('link', { name: 'View details' }).click();
      await check(page, 'web experience detail');
      await page.goto(`${WEB}/messages`);
      await page.getByRole('link', { name: 'Open' }).first().click();
      await check(page, 'web conversation');
    });

    test('admin console', async ({ page }) => {
      test.setTimeout(240_000);
      await page.goto(ADMIN);
      await check(page, 'admin sign-in');
      await page.locator('input[type=email]').fill('admin@example.com');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('heading', { name: 'Today at Quintara' })).toBeVisible();
      for (const path of ['/', '/applications', '/members', '/experiences', '/concierge', '/services', '/orders', '/boutique', '/check-in', '/staff', '/insights', '/audit', '/tiers', '/payments']) {
        await page.goto(ADMIN + path); await check(page, `admin ${path}`);
      }
    });

    test('Maison Quintara shop, with a piece and the bag open', async ({ page }) => {
      await page.goto(SHOP);
      await check(page, 'shop');
      await page.locator('button.piece').first().click();
      await check(page, 'shop piece');
      await page.keyboard.press('Escape');
      await page.locator('button.bagbtn').click();
      await check(page, 'shop bag');
    });
  });
}
