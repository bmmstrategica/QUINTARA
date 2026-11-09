/**
 * The journeys that cross applications: what staff do in the admin console reaches members on the web, and what
 * members do on the web reaches the admin console. Development sign-in (an address alone) is used throughout.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const WEB = 'http://localhost:3000', ADMIN = 'http://localhost:3001';
const MEMBER = 'thandi@example.com', MEMBER_NAME = 'Thandi Mokoena';
const title = `Sundowner Salon ${Date.now().toString(36)}`;

async function webSignIn(page: Page, email: string) {
  await page.goto(`${WEB}/sign-in`);
  await page.locator('input[type=email]').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}
async function adminSignIn(page: Page, email: string) {
  await page.goto(ADMIN);
  await page.locator('input[type=email]').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today at Quintara' })).toBeVisible();
}
const inThreeWeeks = () => new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);

test.describe.serial('staff publish, members book, staff see it', () => {
  test('an experience created and published in the admin console appears for members on the web', async ({ browser }) => {
    const admin = await browser.newPage();
    await adminSignIn(admin, 'admin@example.com');
    await admin.goto(`${ADMIN}/experiences`);
    const form = admin.locator('form').filter({ has: admin.getByRole('button', { name: 'Create draft' }) });
    await form.locator('input[name=title]').fill(title);
    await form.locator('input[name=date]').fill(inThreeWeeks());
    await form.locator('input[name=venue]').fill('A private terrace');
    await form.locator('input[name=area]').fill('Camps Bay');
    await form.locator('select[name=admission]').selectOption('open');
    await form.getByRole('button', { name: 'Create draft' }).click();
    await admin.waitForURL(/\/experiences\/[0-9a-f-]{36}$/);

    // A draft is not shown to members.
    const member = await browser.newPage();
    await webSignIn(member, MEMBER);
    await member.goto(`${WEB}/experiences`);
    await expect(member.getByText('Costa Convivio').first()).toBeVisible();
    await expect(member.getByText(title)).toHaveCount(0);

    await admin.getByRole('button', { name: 'Publish' }).click();
    await expect(admin.getByRole('button', { name: 'Unpublish' })).toBeVisible();
    await member.reload();
    await expect(member.getByText(title).first()).toBeVisible();
  });

  test('a member books on the web; it is in their bookings and on the admin guest list', async ({ browser }) => {
    const member = await browser.newPage();
    await webSignIn(member, MEMBER);
    await member.goto(`${WEB}/experiences`);
    await member.locator('article.item-row').filter({ hasText: title }).getByRole('link', { name: 'View details' }).click();
    await expect(member.getByRole('heading', { name: title })).toBeVisible();
    // Complimentary experiences offer RSVP; paid ones, Reserve.
    const book = member.getByRole('button', { name: /^(RSVP|Reserve)$/ });
    await book.click();
    // The form gives way to the booking once the API has confirmed it.
    await expect(book).toHaveCount(0);
    await member.goto(`${WEB}/bookings`);
    await expect(member.getByRole('heading', { name: title })).toBeVisible();

    const admin = await browser.newPage();
    await adminSignIn(admin, 'admin@example.com');
    await admin.goto(`${ADMIN}/experiences`);
    await admin.getByRole('row', { name: new RegExp(title) }).getByRole('link', { name: 'Open' }).click();
    await expect(admin.getByText(MEMBER_NAME).first()).toBeVisible();
  });
});

test('a concierge request sent on the web reaches the desk in the admin console', async ({ browser }) => {
  const subject = `Helicopter transfer ${Date.now().toString(36)}`;
  const member = await browser.newPage();
  await webSignIn(member, MEMBER);
  await member.goto(`${WEB}/concierge`);
  await member.getByLabel('In a few words').fill(subject);
  await member.getByLabel('The details').fill('Two passengers from the V&A Waterfront to Franschhoek, Saturday at 10:00.');
  await member.getByRole('button', { name: 'Send to the desk' }).click();
  await expect(member.getByText(subject).first()).toBeVisible();

  const desk = await browser.newPage();
  await adminSignIn(desk, 'desk@example.com');
  await desk.goto(`${ADMIN}/concierge`);
  await expect(desk.getByText(subject).first()).toBeVisible();
});

test('each staff role sees its own menu and the server refuses the rest', async ({ page }) => {
  await adminSignIn(page, 'content@example.com');
  await expect(page.getByText('Signed in as Content Manager')).toBeVisible();
  const nav = page.locator('aside nav');
  await expect(nav.getByRole('link', { name: 'Maison Quintara' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Members' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Payments' })).toHaveCount(0);
  await page.goto(`${ADMIN}/members`);
  await expect(page.getByText('Your staff role does not include this.').first()).toBeVisible();
});

test('the web app and the admin console fit a phone screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await webSignIn(page, MEMBER);
  for (const path of ['/', '/experiences', '/bookings', '/concierge', '/profile']) {
    await page.goto(`${WEB}${path}`);
    await page.waitForLoadState('networkidle');
    expect(await fits(), `web ${path}`).toBe(true);
  }
  await adminSignIn(page, 'admin@example.com');
  for (const path of ['/', '/applications', '/members', '/experiences', '/orders', '/staff']) {
    await page.goto(`${ADMIN}${path}`);
    await page.waitForLoadState('networkidle');
    expect(await fits(), `admin ${path}`).toBe(true);
  }
  await context.close();
});
