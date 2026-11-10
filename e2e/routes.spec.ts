/**
 * Every page of the web app, reached by following its own links, as a visitor and as a member: none may crash, log an
 * error, fail a request with a server error, or link to a page that does not exist. Pages behind an id (an
 * experience, a member, a conversation) are found through the links, so the sample data decides which are visited.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const WEB = 'http://localhost:3000';
const START = ['/', '/experiences', '/lifestyle', '/members', '/concierge', '/qera', '/qera/today', '/qera/calendar', '/qera/memory', '/qera/whatsapp',
  '/bookings', '/boutique', '/business', '/messages', '/notifications', '/profile', '/account', '/search', '/tv', '/apply', '/join', '/sign-in'];
// Pages that act when opened (signing out, a payment's return) are not visited from a link.
const SKIP = [/^\/sign-out/, /^\/payments\/return/, /^\/partner-booking\//];
const LIMIT = 80, PER_KIND = 3;
/** The kind of an id page: /experiences/<id> and /experiences/<other id> are the same kind. */
const kind = (path: string) => path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id');

/** Visits each page once, collecting what went wrong; returns the pages visited and the problems. */
async function crawl(page: Page) {
  const problems: string[] = [];
  let at = '';
  page.on('pageerror', (error) => problems.push(`${at}: uncaught ${error.message}`));
  page.on('console', (message) => {
    // A refused request is logged by the browser as well as answered; refusals are expected for a visitor.
    if (message.type() === 'error' && !/status of 4\d\d/.test(message.text())) problems.push(`${at}: console ${message.text().slice(0, 200)}`);
  });
  page.on('response', (response) => { if (response.status() >= 500) problems.push(`${at}: ${response.status()} from ${response.url()}`); });

  const seen = new Set<string>(), queue = [...START];
  while (queue.length && seen.size < LIMIT) {
    const path = queue.shift()!;
    if (seen.has(path) || SKIP.some((s) => s.test(path))) continue;
    seen.add(path);
    at = path;
    const response = await page.goto(`${WEB}${path}`);
    if (!response || response.status() >= 400) { problems.push(`${path}: page answered ${response?.status()}`); continue; }
    await page.waitForLoadState('networkidle').catch(() => undefined);
    if (await page.getByText(/This page could not be found|Application error|Unhandled Runtime Error/).count()) problems.push(`${path}: error page shown`);
    for (const href of await page.locator('a[href^="/"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')!))) {
      const clean = href.split('#')[0]!.split('?')[0]!;
      const sameKind = [...seen, ...queue].filter((p) => kind(p) === kind(clean)).length;
      if (clean && !seen.has(clean) && !queue.includes(clean) && (kind(clean) === clean || sameKind < PER_KIND)) queue.push(clean);
    }
  }
  test.info().annotations.push({ type: 'visited', description: `${seen.size} pages: ${[...new Set([...seen].map(kind))].join(' ')}` });
  return { visited: [...seen], problems };
}

test('a visitor can open every page linked to without an error', async ({ page }) => {
  const { visited, problems } = await crawl(page);
  expect(visited.length).toBeGreaterThan(10);
  expect(problems).toEqual([]);
});

test('a member can open every page linked to without an error, including pages behind an id', async ({ page }) => {
  await page.goto(`${WEB}/sign-in`);
  await page.locator('input[type=email]').fill('daniel@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
  const { visited, problems } = await crawl(page);
  for (const kind of ['/experiences/', '/members/', '/lifestyle/']) expect(visited.some((p) => p.startsWith(kind)), kind).toBe(true);
  expect(problems).toEqual([]);
});
