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

  test('the member shows the ticket’s QR code; staff check the guest in once', async ({ browser }) => {
    const member = await browser.newPage();
    await webSignIn(member, MEMBER);
    await member.goto(`${WEB}/bookings`);
    const row = member.locator('article.item-row').filter({ hasText: title });
    await row.getByRole('button', { name: 'Show ticket' }).click();
    const qr = row.locator('img.qr');
    await expect(qr).toBeVisible();
    expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    const code = (await row.locator('.facts strong').textContent())!.trim();
    expect(code).toMatch(/^QT-[0-9A-F]+$/);
    await expect(qr).toHaveAttribute('alt', new RegExp(code));

    const desk = await browser.newPage();
    await adminSignIn(desk, 'desk@example.com');
    await desk.goto(`${ADMIN}/check-in`);
    await desk.getByLabel('Ticket code').fill(code);
    await desk.getByRole('button', { name: 'Check in' }).click();
    await expect(desk.getByRole('status')).toHaveText(new RegExp(`Welcome. ${MEMBER_NAME}`));
    await desk.getByLabel('Ticket code').fill(code);
    await desk.getByRole('button', { name: 'Check in' }).click();
    await expect(desk.locator('p.error[role=status]')).toBeVisible();      // a ticket is used once
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
  for (const path of ['/', '/applications', '/members', '/experiences', '/orders', '/staff', '/insights']) {
    await page.goto(`${ADMIN}${path}`);
    await page.waitForLoadState('networkidle');
    expect(await fits(), `admin ${path}`).toBe(true);
  }
  await context.close();
});

test('a paid experience is paid through the checkout: out to the provider’s page and back, confirmed', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await webSignIn(page, 'daniel@example.com');
  await page.goto(`${WEB}/experiences`);
  await page.locator('article.item-row').filter({ hasText: 'The Aura Enclave' }).getByRole('link', { name: 'View details' }).click();
  await page.getByRole('button', { name: /^(RSVP|Reserve)$/ }).click();
  // Seats are held; paying sends the member to the provider's checkout (the test checkout in development).
  await page.getByRole('button', { name: /^Pay R/ }).click();
  await page.waitForURL(/\/v1\/payments\/test-checkout\//);
  await expect(page.getByText('no card is taken')).toBeVisible();
  await page.getByRole('link', { name: 'Pay', exact: true }).click();
  // Back in the app, which shows it as paid only once the API says so.
  await page.waitForURL(/localhost:3000\/payments\/return\?payment=/);
  await expect(page.getByText('Your payment is confirmed')).toBeVisible();
  await page.getByRole('link', { name: 'Your bookings' }).click();
  const row = page.locator('article').filter({ hasText: 'The Aura Enclave' });
  await expect(row.getByText(/confirmed/i).first()).toBeVisible();
});

test('a declined payment says so plainly and keeps the seats held', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await webSignIn(page, 'aisha@example.com');
  await page.goto(`${WEB}/experiences`);
  await page.locator('article.item-row').filter({ hasText: 'The Aura Enclave' }).getByRole('link', { name: 'View details' }).click();
  await page.getByRole('button', { name: /^(RSVP|Reserve)$/ }).click();
  await page.getByRole('button', { name: /^Pay R/ }).click();
  await page.waitForURL(/\/v1\/payments\/test-checkout\//);
  await page.getByRole('link', { name: 'Decline' }).click();
  await expect(page.getByText('The payment did not go through.')).toBeVisible();
  await page.goto(`${WEB}/bookings`);
  await expect(page.getByRole('button', { name: /^Pay R/ })).toBeVisible();
});

test('a message appears for the other member without reloading, with an unread dot in the header', async ({ browser }) => {
  const body = `Shall we meet at the Aura Enclave? ${Date.now().toString(36)}`;
  const aisha = await browser.newPage(), thandi = await browser.newPage();
  await webSignIn(aisha, 'aisha@example.com');
  await webSignIn(thandi, MEMBER);

  // Aisha is reading elsewhere; then she opens her conversation with Thandi.
  await aisha.goto(`${WEB}/experiences`);
  await thandi.goto(`${WEB}/messages`);
  await thandi.locator('main').locator('div, article, li').filter({ hasText: 'Aisha Parker' }).getByRole('link', { name: 'Open' }).last().click();
  await thandi.getByLabel('Write a message').fill(body);
  await thandi.getByRole('button', { name: /^Send/ }).click();
  await expect(thandi.getByText(body)).toBeVisible();

  // The unread dot reaches Aisha's header within the polling interval, without a reload.
  const messagesLink = aisha.locator('nav[aria-label=Main] a[href="/messages"]');
  await expect(messagesLink.locator('.dot')).toBeVisible({ timeout: 40_000 });
  await expect(messagesLink).toContainText('unread');

  // Open on both sides: Thandi's next message arrives on Aisha's screen by itself.
  await messagesLink.click();
  await aisha.locator('main').locator('div, article, li').filter({ hasText: 'Thandi Mokoena' }).getByRole('link', { name: 'Open' }).last().click();
  await expect(aisha.getByText(body)).toBeVisible();
  const reply = `See you there. ${Date.now().toString(36)}`;
  await thandi.getByLabel('Write a message').fill(reply);
  await thandi.getByRole('button', { name: /^Send/ }).click();
  await expect(aisha.getByText(reply)).toBeVisible({ timeout: 15_000 });
});

test('staff cancel a booking from the guest list; the member sees it cancelled, with the reason', async ({ browser }) => {
  const member = await browser.newPage();
  member.on('dialog', (dialog) => void dialog.accept());
  await webSignIn(member, 'chloe@example.com');
  await member.goto(`${WEB}/experiences`);
  await member.locator('article.item-row').filter({ hasText: 'The Executive Yacht Club' }).getByRole('link', { name: 'View details' }).click();
  const book = member.getByRole('button', { name: /^(RSVP|Reserve)$/ });
  await book.click();
  await expect(book).toHaveCount(0);

  const admin = await browser.newPage();
  admin.on('dialog', (dialog) => void dialog.accept());
  await adminSignIn(admin, 'admin@example.com');
  await admin.goto(`${ADMIN}/experiences`);
  await admin.getByRole('row', { name: /The Executive Yacht Club/ }).getByRole('link', { name: 'Open' }).click();
  await admin.getByRole('row', { name: /Chloe van der Merwe/ }).getByRole('button', { name: 'Cancel' }).click();
  await admin.getByLabel('Reason, as the guest will read it').fill('The yacht is in for repairs.');
  await admin.getByLabel('Refund').selectOption('none');        // nothing was paid for this one
  await admin.getByRole('button', { name: 'Cancel booking' }).click();
  // The guest list shows live bookings only, so the cancelled one leaves it.
  await expect(admin.getByRole('row', { name: /Chloe van der Merwe/ })).toHaveCount(0);

  await member.goto(`${WEB}/notifications`);
  await expect(member.getByText(/cancelled by Quintara\. The yacht is in for repairs\./).first()).toBeVisible();
  await member.goto(`${WEB}/bookings`);
  await expect(member.locator('article.item-row').filter({ hasText: 'The Executive Yacht Club' }).getByText(/cancelled/i).first()).toBeVisible();
});
