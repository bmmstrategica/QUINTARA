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

test('a concierge request goes from the member to the desk and back: reply, options, the member confirms', async ({ browser }) => {
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
  await desk.getByRole('row', { name: new RegExp(subject) }).getByRole('link', { name: 'Open' }).click();
  await desk.getByLabel('Reply to the member').fill('Two options: a Robinson R44 at 10:00, or an AS350 at 10:30. Both from the V&A heliport.');
  await desk.getByRole('button', { name: 'Send' }).click();
  await desk.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Options provided' }).click();
  await expect(desk.getByRole('button', { name: 'Options provided' })).toHaveAttribute('aria-pressed', 'true');

  // The member reads the reply on the request's own page and confirms.
  await member.goto(`${WEB}/concierge`);
  await member.locator('strong', { hasText: subject }).locator('xpath=../..').getByRole('link', { name: 'Open' }).click();
  await expect(member.getByText('Robinson R44 at 10:00')).toBeVisible();
  await member.getByRole('button', { name: /^Confirm/ }).click();
  await expect(member.getByRole('button', { name: /^Confirm/ })).toHaveCount(0);
  await desk.reload();
  await expect(desk.getByRole('button', { name: 'Confirmed' })).toHaveAttribute('aria-pressed', 'true');
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
  await expect(member.locator('article.item-row').filter({ hasText: 'The Executive Yacht Club' }).getByText('Cancelled by Quintara. The yacht is in for repairs.')).toBeVisible();
});

test('a visitor becomes a member: guest account, application, approval with a discount, payment at the checkout', async ({ browser }) => {
  const stamp = Date.now().toString(36), name = `Lerato Applicant ${stamp}`;
  const visitor = await browser.newPage();
  visitor.on('dialog', (dialog) => void dialog.accept());
  // A guest account first (development: no code is asked for).
  await visitor.goto(`${WEB}/join`);
  await visitor.getByLabel('Full name').fill(name);
  await visitor.getByLabel('Email', { exact: true }).fill(`lerato.${stamp}@example.com`);
  await visitor.getByRole('checkbox').check();
  await visitor.getByRole('button', { name: /Create|Continue/ }).click();
  await visitor.waitForURL(/\/qera/);

  // The application, step by step. Name and email come from the guest account.
  await visitor.goto(`${WEB}/apply`);
  const form = visitor.locator('form');
  const step = (title: string | RegExp) => expect(form.locator('h3')).toHaveText(title);
  const next = (then: string | RegExp) => form.getByRole('button', { name: 'Continue' }).click().then(() => step(then));
  const field = (name: RegExp) => form.getByRole('textbox', { name });
  await step('Create your account');
  await expect(form.locator('input[type=email]')).toHaveValue(`lerato.${stamp}@example.com`);
  await next('About you');
  await field(/^Phone number/).fill('+27 82 555 0199');
  await field(/^Home city/).fill('Cape Town');
  await next('Your work');
  await field(/^Position/).fill('Director');
  await field(/^Industry/).fill('Hospitality');
  await next('Your interests');                             // interests are optional
  await next('Why Quintara');
  await form.locator('textarea').fill('I would like to host supper clubs for members and meet other founders.');
  await next('Referral or invitation');                     // optional
  await next('Where to find you');
  await form.getByRole('radio', { name: 'Instagram' }).check();
  await form.locator('input[placeholder="@yourname"]').fill(`lerato${stamp}`.slice(0, 20));
  await next('Your membership');
  await form.getByRole('radiogroup', { name: /memberships$/ }).locator('label').first().click();
  // Questions staff have added would come next; the sample data has none, so this is the review.
  await next('Review and send');
  await form.getByRole('button', { name: 'Send application' }).click();
  await expect(visitor.getByRole('heading', { name: 'Your application' })).toBeVisible();

  // The committee approves, with a 50% discount granted by finance.
  const admin = await browser.newPage();
  admin.on('dialog', (dialog) => void dialog.accept());
  await adminSignIn(admin, 'admin@example.com');
  await admin.goto(`${ADMIN}/applications`);
  const card = admin.locator('article.panel').filter({ hasText: name });
  await card.getByLabel('Discount', { exact: true }).selectOption('percent');
  await card.getByLabel('Discount percentage').fill('50');
  await card.getByLabel('Reason for the discount').fill('Founding circle');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card.getByText('Payment pending', { exact: false })).toBeVisible();

  // The applicant sees the fee, the discount and what is due, and pays at the checkout.
  await visitor.goto(`${WEB}/apply`);
  await expect(visitor.getByText(/Discount from the committee: .*\(Founding circle\)/)).toBeVisible();
  await expect(visitor.getByText(/To pay:/)).toBeVisible();
  await visitor.getByRole('button', { name: 'Proceed with payment' }).click();
  await visitor.waitForURL(/\/v1\/payments\/test-checkout\//);
  await visitor.getByRole('link', { name: 'Pay', exact: true }).click();
  await visitor.waitForURL(/localhost:3000\/payments\/return\?payment=/);
  await expect(visitor.getByText('Your payment is confirmed')).toBeVisible();
  // A member now.
  await visitor.goto(`${WEB}/apply`);
  await expect(visitor.getByText('Your membership is active. Welcome to Quintara.')).toBeVisible();
  await admin.reload();
  await expect(admin.locator('article.panel').filter({ hasText: name }).locator('.chip')).toHaveText('Active');
});

test('QÉRA plans a weekend as a document, and books a seat once the member says yes', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await webSignIn(page, 'sipho@example.com');
  await page.goto(`${WEB}/qera`);
  const ask = async (text: string) => {
    await page.getByLabel('Message QÉRA').fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByLabel('Message QÉRA')).toHaveValue('');
  };

  // A plan becomes a document the member can open, print and delete.
  await ask('Plan a weekend for me');
  const documents = page.getByRole('region', { name: 'Documents' });
  await documents.getByRole('link', { name: 'Open' }).first().click();
  await page.waitForURL(/\/qera\/documents\//);
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(/\/qera$/);

  // A booking is only made once the member agrees.
  await ask('Please book two seats at The Executive Yacht Club');
  const waiting = page.getByRole('group', { name: 'Waiting for your answer' });
  await expect(waiting).toContainText('The Executive Yacht Club');
  await page.goto(`${WEB}/bookings`);
  await expect(page.locator('article.item-row').filter({ hasText: 'The Executive Yacht Club' })).toHaveCount(0);
  await page.goto(`${WEB}/qera`);
  await page.getByRole('group', { name: 'Waiting for your answer' }).getByRole('button', { name: 'Yes, go ahead' }).click();
  await expect(page.getByRole('group', { name: 'Waiting for your answer' })).toHaveCount(0);
  await page.goto(`${WEB}/bookings`);
  await expect(page.locator('article.item-row').filter({ hasText: 'The Executive Yacht Club' })).toContainText('2 seats');
});

test('finance refund part of a payment from the ledger; the member is told, and the booking stands', async ({ browser }) => {
  const member = await browser.newPage();
  member.on('dialog', (dialog) => void dialog.accept());
  await webSignIn(member, 'chloe@example.com');
  await member.goto(`${WEB}/experiences`);
  await member.locator('article.item-row').filter({ hasText: 'The Aura Enclave' }).getByRole('link', { name: 'View details' }).click();
  await member.getByRole('button', { name: /^(RSVP|Reserve)$/ }).click();
  await member.getByRole('button', { name: /^Pay R/ }).click();
  await member.waitForURL(/\/v1\/payments\/test-checkout\//);
  await member.getByRole('link', { name: 'Pay', exact: true }).click();
  await expect(member.getByText('Your payment is confirmed')).toBeVisible();

  const finance = await browser.newPage();
  finance.on('dialog', (dialog) => void dialog.accept());
  await adminSignIn(finance, 'admin@example.com');
  await finance.goto(`${ADMIN}/payments`);
  const row = finance.getByRole('row').filter({ hasText: 'Chloe van der Merwe' }).filter({ hasText: 'The Aura Enclave' }).first();
  await row.getByRole('button', { name: 'Refund' }).click();
  await finance.getByRole('combobox', { name: /^Refund/ }).selectOption('part');
  await finance.getByLabel(/^Amount, in/).fill('100');
  await finance.getByLabel('Reason, kept in the audit log').fill('The view was blocked by scaffolding.');
  await finance.getByRole('button', { name: /^Refund R/ }).click();
  await expect(row.getByText(/returned/)).toBeVisible();

  await member.goto(`${WEB}/notifications`);
  await expect(member.getByText(/We have refunded R\s?100/).first()).toBeVisible();
  await member.goto(`${WEB}/bookings`);
  await expect(member.locator('article.item-row').filter({ hasText: 'The Aura Enclave' }).getByText(/confirmed/i).first()).toBeVisible();
});

test('a guest buys in the Maison Quintara shop; staff move the order along in the console; the buyer follows each step', async ({ browser }) => {
  const SHOP = 'http://localhost:3002', stamp = Date.now().toString(36), name = `Naledi Buyer ${stamp}`;
  const buyer = await browser.newPage();
  buyer.on('dialog', (dialog) => void dialog.accept());
  await buyer.goto(SHOP);
  // The first piece that can be bought.
  const pieces = buyer.locator('button.piece');
  await expect(pieces.first()).toBeVisible();
  for (let i = 0; i < await pieces.count(); i++) {
    await pieces.nth(i).click();
    const add = buyer.getByRole('button', { name: 'Add to bag' });
    if (await add.count()) { await add.click(); break; }
    await buyer.getByRole('button', { name: 'Close' }).first().click();
  }
  // Adding a piece opens the bag.
  await expect(buyer.getByRole('dialog', { name: 'Your bag' })).toBeVisible();
  await buyer.getByLabel('Your name').fill(name);
  await buyer.getByLabel(/^Email address, for your confirmation/).fill(`naledi.${stamp}@example.com`);
  await buyer.getByLabel('Delivery address').fill('12 Kloof Street, Gardens, Cape Town, 8001');
  await buyer.getByRole('button', { name: /^Order and pay R/ }).click();
  // Out to the provider's checkout and back to the shop, which shows the order once the API has the payment.
  await buyer.waitForURL(/\/v1\/payments\/test-checkout\//);
  await buyer.getByRole('link', { name: 'Pay', exact: true }).click();
  await buyer.waitForURL(/localhost:3002\/\?payment=/);
  await expect(buyer.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  const orderNumber = (await buyer.getByText(/^Order Q-\d+/).textContent())!.match(/Q-\d+/)![0];

  // Staff in the console: prepare, dispatch with tracking, confirm received.
  const staff = await browser.newPage();
  staff.on('dialog', (dialog) => void dialog.accept());       // each step is confirmed: the buyer is told at once
  await adminSignIn(staff, 'admin@example.com');
  await staff.goto(`${ADMIN}/orders`);
  const card = staff.getByRole('article', { name: `Order ${orderNumber}` });
  await expect(card).toContainText(name);
  await card.getByRole('button', { name: 'Start processing' }).click();
  await card.locator('form').getByRole('button', { name: /Start processing|Save|Record/ }).first().click();
  await card.getByRole('button', { name: 'Dispatch for delivery' }).click();
  await card.getByLabel('Courier').fill('The Courier Guy');
  await card.getByLabel('Tracking number').fill(`TCG${stamp}`);
  await card.locator('form').getByRole('button', { name: /Dispatch|Save|Record/ }).first().click();
  await expect(card.getByText(`The Courier Guy, TCG${stamp}`)).toBeVisible();

  // The buyer sees the same steps, with the tracking number, in the shop.
  await buyer.goto(SHOP);
  await buyer.getByRole('button', { name: 'Your orders' }).click();
  const progress = buyer.getByRole('dialog').getByRole('list', { name: 'Progress' }).first();
  await expect(progress).toContainText(`TCG${stamp}`);
  await expect(progress.locator('li[aria-current="step"]')).toContainText(/Delivered|Received/);
});
