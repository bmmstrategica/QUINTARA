/**
 * The admin console as each of the eight staff roles: every page a role can reach through the console's own links
 * opens without an error, and none of them is refused by the API. A refusal on a page the menu offers would mean a
 * link the role should not see, or a permission the page needs and the role lacks.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ADMIN = 'http://localhost:3001', API = 'http://localhost:4000';
const ROLES: [role: string, email: string][] = [
  ['admin', 'admin@example.com'], ['concierge', 'desk@example.com'], ['content', 'content@example.com'],
  ['executive_admin', 'exec.crawl@example.com'], ['membership', 'membership.crawl@example.com'], ['experiences', 'experiences.crawl@example.com'],
  ['finance', 'finance.crawl@example.com'], ['support', 'support.crawl@example.com'],
];
const LIMIT = 60, PER_KIND = 2;
const kind = (path: string) => path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id');

test.beforeAll(async ({ playwright }) => {
  // The roles the sample data has no account for are added by an administrator, as in the console.
  const api = await playwright.request.newContext({ baseURL: API, extraHTTPHeaders: { origin: ADMIN } });
  expect((await api.post('/admin/v1/session', { data: { email: 'admin@example.com' } })).ok()).toBe(true);
  const existing = await (await api.get('/admin/v1/staff')).json();
  const emails = new Set<string>((Array.isArray(existing) ? existing : existing.staff ?? []).map((s: { email: string }) => s.email));
  for (const [role, email] of ROLES) {
    if (emails.has(email)) continue;
    const r = await api.post('/admin/v1/staff', { data: { fullName: `Crawl ${role}`, email, role } });
    expect(r.ok(), `${role}: ${await r.text()}`).toBe(true);
  }
  await api.dispose();
});

async function crawl(page: Page) {
  const problems: string[] = [];
  let at = '';
  page.on('pageerror', (error) => problems.push(`${at}: uncaught ${error.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(`${at}: console ${m.text().slice(0, 200)}`); });
  page.on('response', (r) => {
    if (r.url().startsWith(API) && r.status() >= 400 && !r.url().endsWith('/admin/v1/session')) problems.push(`${at}: ${r.status()} from ${r.request().method()} ${r.url().slice(API.length)}`);
  });
  const seen = new Set<string>(), queue = ['/'];
  while (queue.length && seen.size < LIMIT) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    at = path;
    const response = await page.goto(`${ADMIN}${path}`);
    if (!response || response.status() >= 400) { problems.push(`${path}: page answered ${response?.status()}`); continue; }
    await page.waitForLoadState('networkidle').catch(() => undefined);
    if (await page.getByText(/Your staff role does not include this|This page could not be found|Application error/).count()) problems.push(`${path}: refused or error page`);
    for (const href of await page.locator('a[href^="/"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')!))) {
      const clean = href.split('#')[0]!.split('?')[0]!;
      const same = [...seen, ...queue].filter((p) => kind(p) === kind(clean)).length;
      if (clean && !seen.has(clean) && !queue.includes(clean) && (kind(clean) === clean || same < PER_KIND)) queue.push(clean);
    }
  }
  return { visited: [...seen], problems };
}

for (const [role, email] of ROLES) {
  test(`${role}: every page the console offers opens, and the API refuses none of it`, async ({ page }) => {
    await page.goto(ADMIN);
    await page.locator('input[type=email]').fill(email);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Today at Quintara' })).toBeVisible();
    const { visited, problems } = await crawl(page);
    test.info().annotations.push({ type: 'visited', description: `${visited.length} pages: ${[...new Set(visited.map(kind))].join(' ')}` });
    expect(problems).toEqual([]);
  });
}
