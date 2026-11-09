/**
 * Automatic membership renewals.
 *
 * - Each membership has a term (the plan's months) ending on `term_ends_at`.
 * - A member may keep one card with the payment provider and choose automatic renewal. Quintara holds only the
 *   provider's reference to the card, its brand, last four digits and expiry: never the card number.
 * - Reminders go 30 and 7 days before the end. On the day, a member with automatic renewal is charged for the next
 *   term, which starts where the last one ended. A declined charge is tried again after 1, 3 and 7 days.
 * - Access continues for 14 days of grace after the end; then the membership lapses and every member permission
 *   stops (see `loadMembership`). Renewing a lapsed membership starts a new term from that day.
 * - Every charge has an idempotency key per member, term and attempt, so a retried job never charges twice.
 */
import { randomUUID } from 'node:crypto';
import type { MembershipRenewalPayment, MembershipState, MembershipStatus, SavedCard } from '@quintara/domain';
import { autoRenewInputSchema, formatMoney, paymentMethodInputSchema, RENEWAL_GRACE_DAYS, RENEWAL_REMINDER_DAYS, RENEWAL_RETRY_DAYS } from '@quintara/domain';
import { z } from 'zod';
import { audit, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import { conflict, forbidden, HttpError, notFound, unauthenticated, validation } from './errors.ts';
import type { PaymentProvider } from './payments.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

type MemberRow = {
  id: string; user_id: string; member_number: string; status: string; market_id: string; term_ends_at: Date | null; auto_renew: boolean;
  renewal_attempts: number; next_renewal_attempt_at: Date | null; last_renewal_failure: string | null; lapsed_at: Date | null;
  tier_name: string; price_minor: string; currency_code: string; months: number | null; timezone: string;
};
type CardRow = { id: string; provider_token: string; brand: string; last4: string; exp_month: number; exp_year: number };

const MEMBER_SQL = `
  SELECT m.id, m.user_id, m.member_number, m.status, m.home_market_id AS market_id, m.term_ends_at, m.auto_renew, m.renewal_attempts,
         m.next_renewal_attempt_at, m.last_renewal_failure, m.lapsed_at, t.name AS tier_name, t.price_minor, t.currency_code,
         COALESCE(t.term_months, CASE t.billing_period WHEN 'year' THEN 12 WHEN 'month' THEN 1 END) AS months,
         COALESCE((SELECT c.timezone FROM markets k JOIN cities c ON c.id = k.city_id WHERE k.id = m.home_market_id), 'UTC') AS timezone
    FROM members m JOIN membership_tiers t ON t.id = m.tier_id`;

const day = (at: Date, zone: string) => new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: zone }).format(at);
const money = (m: MemberRow) => formatMoney(Number(m.price_minor), m.currency_code.trim());
/** The card is still valid on a date: cards work to the end of their expiry month. */
const cardValidOn = (c: Pick<CardRow, 'exp_month' | 'exp_year'>, at: Date) => new Date(Date.UTC(c.exp_year, c.exp_month, 1)) > at;

async function memberOf(db: Queryable, userId: string): Promise<MemberRow> {
  const m = (await db.query<MemberRow>(`${MEMBER_SQL} WHERE m.user_id = $1`, [userId]))[0];
  if (!m) throw notFound('There is no membership on this account.');
  // A suspended or resigned membership is not renewed by the member: it is a matter for the team.
  if (m.status !== 'active' && m.status !== 'lapsed') throw forbidden('This membership cannot be renewed here. Contact the Quintara desk.');
  return m;
}
const cardOf = async (db: Queryable, userId: string) =>
  (await db.query<CardRow>('SELECT id, provider_token, brand, last4, exp_month, exp_year FROM payment_methods WHERE user_id = $1 AND removed_at IS NULL', [userId]))[0] ?? null;

function stateOf(m: MemberRow, now = new Date()): MembershipState {
  if (m.status === 'lapsed') return 'lapsed';
  if (!m.term_ends_at) return 'active';
  const end = new Date(m.term_ends_at).getTime();
  if (end <= now.getTime()) return 'grace';
  return end - now.getTime() <= RENEWAL_REMINDER_DAYS[0] * DAY ? 'renewal_due' : 'active';
}

/* ---------- The member's own membership ---------- */

/** Also answers for a lapsed member, who is signed in but has no member permissions, so they can renew. */
export async function getMembership(db: Queryable, ctx: RequestContext): Promise<MembershipStatus> {
  if (!ctx.userId) throw unauthenticated();
  const m = await memberOf(db, ctx.userId), card = await cardOf(db, ctx.userId), state = stateOf(m);
  const history = await db.query(
    `SELECT id, created_at, paid_at, amount_minor, currency_code, status, period_end, failure_reason FROM payments
      WHERE user_id = $1 AND purpose IN ('membership', 'membership_renewal') ORDER BY created_at DESC LIMIT 24`, [ctx.userId]);
  const end = m.term_ends_at ? new Date(m.term_ends_at) : null;
  const saved: SavedCard | null = card ? {
    brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year,
    expired: !cardValidOn(card, new Date()), expiresBeforeRenewal: Boolean(end && !cardValidOn(card, end)),
  } : null;
  return {
    memberNumber: m.member_number, tierName: m.tier_name, priceMinor: Number(m.price_minor), currency: m.currency_code.trim(),
    termMonths: m.months, termEndsAt: end?.toISOString() ?? null, state,
    graceEndsAt: end && state === 'grace' ? new Date(end.getTime() + RENEWAL_GRACE_DAYS * DAY).toISOString() : null,
    autoRenew: m.auto_renew, card: saved,
    nextAttemptAt: m.next_renewal_attempt_at ? new Date(m.next_renewal_attempt_at).toISOString() : null,
    lastFailure: m.last_renewal_failure,
    canRenewNow: Boolean(m.months) && Number(m.price_minor) > 0 && state !== 'active',
    history: history.map((p): MembershipRenewalPayment => ({
      id: p.id as string, at: new Date((p.paid_at ?? p.created_at) as string).toISOString(), amountMinor: Number(p.amount_minor), currency: (p.currency_code as string).trim(),
      status: p.status as MembershipRenewalPayment['status'], periodEnd: p.period_end ? new Date(p.period_end as string).toISOString() : null, reason: (p.failure_reason as string | null) ?? null,
    })),
  };
}

/** Saves the card from the provider's secure form (replacing any earlier one). */
export async function savePaymentMethod(db: Db, ctx: RequestContext, provider: PaymentProvider, body: unknown): Promise<MembershipStatus> {
  if (!ctx.userId) throw unauthenticated();
  const userId = ctx.userId;
  await memberOf(db, userId);
  const parsed = paymentMethodInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const result = await provider.saveCard({ setupToken: parsed.data.setupToken, customerReference: userId });
  if (result.status === 'failed') throw new HttpError(422, result.reason, { setupToken: result.reason });
  const old = await cardOf(db, userId);
  await db.tx(async (tx) => {
    await tx.query('UPDATE payment_methods SET removed_at = now() WHERE user_id = $1 AND removed_at IS NULL', [userId]);
    await tx.query('INSERT INTO payment_methods (user_id, provider, provider_token, brand, last4, exp_month, exp_year) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [userId, provider.name, result.token, result.brand, result.last4, result.expMonth, result.expYear]);
    await audit(tx, userId, 'payment_method.saved', 'user', userId, { brand: result.brand, last4: result.last4 });
  });
  if (old) await provider.removeCard(old.provider_token).catch(() => undefined);
  return getMembership(db, ctx);
}

/** Forgets the card, here and at the provider. Automatic renewal stops with it. */
export async function removePaymentMethod(db: Db, ctx: RequestContext, provider: PaymentProvider): Promise<MembershipStatus> {
  if (!ctx.userId) throw unauthenticated();
  const userId = ctx.userId, card = await cardOf(db, userId);
  if (!card) throw notFound('There is no saved card.');
  await db.tx(async (tx) => {
    await tx.query('UPDATE payment_methods SET removed_at = now() WHERE id = $1', [card.id]);
    const was = (await tx.query<{ auto_renew: boolean }>('SELECT auto_renew FROM members WHERE user_id = $1 FOR UPDATE', [userId]))[0];
    await tx.query('UPDATE members SET auto_renew = false WHERE user_id = $1', [userId]);
    if (was?.auto_renew) await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'auto_renew', false)`, [userId]);
    await audit(tx, userId, 'payment_method.removed', 'user', userId);
  });
  await provider.removeCard(card.provider_token).catch(() => undefined);
  return getMembership(db, ctx);
}

/** Turning automatic renewal on needs a card that is still valid; the choice is recorded as a consent. */
export async function setAutoRenew(db: Db, ctx: RequestContext, body: unknown): Promise<MembershipStatus> {
  if (!ctx.userId) throw unauthenticated();
  const userId = ctx.userId;
  const parsed = autoRenewInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const m = await memberOf(db, userId);
  if (parsed.data.autoRenew) {
    if (!m.months || Number(m.price_minor) === 0) throw conflict('This membership has no term to renew.');
    const card = await cardOf(db, userId);
    if (!card) throw new HttpError(409, 'Add a card first.');
    if (!cardValidOn(card, new Date())) throw new HttpError(409, 'Your saved card has expired. Add a new card first.');
  }
  if (m.auto_renew !== parsed.data.autoRenew) {
    await db.tx(async (tx) => {
      await tx.query('UPDATE members SET auto_renew = $2 WHERE id = $1', [m.id, parsed.data.autoRenew]);
      await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'auto_renew', $2)`, [userId, parsed.data.autoRenew]);
      await audit(tx, userId, parsed.data.autoRenew ? 'membership.auto_renew_on' : 'membership.auto_renew_off', 'member', m.id);
    });
  }
  return getMembership(db, ctx);
}

/** Renews now with the saved card: from 30 days before the end, in the grace period, or after lapsing. */
export async function renewNow(db: Db, ctx: RequestContext, provider: PaymentProvider, idempotencyKey?: string): Promise<MembershipStatus> {
  if (!ctx.userId) throw unauthenticated();
  const m = await memberOf(db, ctx.userId);
  if (!m.months || Number(m.price_minor) === 0) throw conflict('This membership has no term to renew.');
  if (stateOf(m) === 'active') throw conflict('Your membership can be renewed from 30 days before it ends.');
  const card = await cardOf(db, ctx.userId);
  if (!card) throw new HttpError(409, 'Add a card first.');
  const result = await chargeRenewal(db, provider, m, card, ctx.userId, idempotencyKey ? `renew-now:${idempotencyKey.slice(0, 120)}` : undefined);
  if (!result.paid) throw new HttpError(402, `The payment did not go through. ${result.reason}`);
  return getMembership(db, ctx);
}

/**
 * Charges the next term to the saved card. On success the term moves on (from the old end, or from today for a
 * lapsed membership) and the member is told; on failure the next attempt is scheduled and the member is told.
 */
async function chargeRenewal(db: Db, provider: PaymentProvider, m: MemberRow, card: CardRow, actor: string | null, key?: string): Promise<{ paid: true } | { paid: false; reason: string }> {
  const lapsed = m.status === 'lapsed' || !m.term_ends_at;
  const from = lapsed ? new Date() : new Date(m.term_ends_at!);
  const newEnd = (await db.query<{ e: Date }>('SELECT $1::timestamptz + make_interval(months => $2) AS e', [from.toISOString(), m.months]))[0]!.e;
  const amount = Number(m.price_minor), currency = m.currency_code.trim();
  const idempotencyKey = key ?? `renewal:${m.id}:${from.toISOString()}:${m.renewal_attempts}`;
  const payment = (await db.query<{ id: string; status: string }>(
    `INSERT INTO payments (user_id, market_id, purpose, member_id, amount_minor, currency_code, provider, idempotency_key, period_end)
     VALUES ($1, $2, 'membership_renewal', $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now() RETURNING id, status`,
    [m.user_id, m.market_id, m.id, amount, currency, provider.name, idempotencyKey, newEnd]))[0]!;
  if (payment.status === 'paid') return { paid: true };

  const result = cardValidOn(card, new Date())
    ? await provider.charge({ amountMinor: amount, currency, description: `${m.tier_name} membership renewal`, idempotencyKey, customerReference: m.user_id, paymentMethodToken: card.provider_token })
    : { status: 'failed' as const, reason: 'The saved card has expired.' };

  if (result.status === 'failed') {
    const attempts = m.renewal_attempts + 1, wait = RENEWAL_RETRY_DAYS[attempts - 1];
    await db.tx(async (tx) => {
      await tx.query(`UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`, [payment.id, result.reason]);
      await tx.query(`UPDATE members SET renewal_attempts = $2, next_renewal_attempt_at = $3, last_renewal_failure = $4 WHERE id = $1`,
        [m.id, attempts, wait ? new Date(Date.now() + wait * DAY) : null, result.reason]);
      await audit(tx, actor, 'membership.renewal_failed', 'member', m.id, { attempt: attempts, reason: result.reason });
      if (!actor || actor !== m.user_id) {
        const until = m.term_ends_at ? day(new Date(new Date(m.term_ends_at).getTime() + RENEWAL_GRACE_DAYS * DAY), m.timezone) : null;
        await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'membership_update', $2)`, [m.user_id,
          `We could not renew your membership: ${result.reason.replace(/\.$/, '')}. ${wait ? `We will try again in ${wait} day${wait === 1 ? '' : 's'}. ` : ''}Update your card under Membership${until && m.status === 'active' ? ` before ${until} to keep your membership` : ''}.`]);
      }
    });
    return { paid: false, reason: result.reason };
  }
  await db.tx(async (tx) => {
    // Two servers renewing at once share the payment row (and the provider de-duplicates the charge): only the first
    // to mark it paid moves the term on and tells the member.
    const first = await tx.query(`UPDATE payments SET status = 'paid', provider_payment_id = $2, paid_at = now(), updated_at = now() WHERE id = $1 AND status <> 'paid' RETURNING id`, [payment.id, result.providerPaymentId]);
    if (!first[0]) return;
    await tx.query(`UPDATE members SET term_ends_at = $2, status = 'active', lapsed_at = NULL, renewal_attempts = 0, next_renewal_attempt_at = NULL, last_renewal_failure = NULL WHERE id = $1`, [m.id, newEnd]);
    await audit(tx, actor, 'membership.renewed', 'member', m.id, { amountMinor: amount, currency, termEndsAt: newEnd, reinstated: m.status === 'lapsed' });
    await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'membership_update', $2)`, [m.user_id,
      `${m.status === 'lapsed' ? 'Welcome back. ' : ''}Your ${m.tier_name} membership is renewed until ${day(newEnd, m.timezone)}. ${money(m)} was charged to your ${card.brand} ending ${card.last4}.`]);
  });
  return { paid: true };
}

/* ---------- The renewal job ---------- */

/** Sends reminders, charges renewals that are due and lapses memberships whose grace has ended. Safe to run often. */
export async function runRenewals(db: Db, provider: PaymentProvider): Promise<{ reminded: number; renewed: number; failed: number; lapsed: number }> {
  const out = { reminded: 0, renewed: 0, failed: 0, lapsed: 0 };
  // Reminders, 30 and 7 days before. Each is sent once per term: the notice row is the lock.
  for (const days of RENEWAL_REMINDER_DAYS) {
    const due = await db.query<MemberRow>(`${MEMBER_SQL}
      WHERE m.status = 'active' AND m.term_ends_at > now() AND m.term_ends_at <= now() + make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM membership_notices n WHERE n.member_id = m.id AND n.term_ends_at = m.term_ends_at AND n.kind = $2)
        AND (t.term_months IS NOT NULL OR t.billing_period IN ('month', 'year')) AND t.price_minor > 0`, [days, `reminder_${days}`]);
    for (const m of due) {
      // A reminder for 30 days is pointless when the 7-day one is due at the same time.
      if (days === 30 && new Date(m.term_ends_at!).getTime() - Date.now() <= 7 * DAY) { await db.query('INSERT INTO membership_notices (member_id, term_ends_at, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [m.id, m.term_ends_at, 'reminder_30']); continue; }
      const card = await cardOf(db, m.user_id), end = day(new Date(m.term_ends_at!), m.timezone);
      const title = m.auto_renew && card
        ? !cardValidOn(card, new Date(m.term_ends_at!))
          ? `Your membership renews on ${end}, but your ${card.brand} ending ${card.last4} will have expired by then. Add a new card under Membership.`
          : `Your ${m.tier_name} membership renews automatically on ${end}. ${money(m)} will be charged to your ${card.brand} ending ${card.last4}. You can change this under Membership.`
        : `Your ${m.tier_name} membership ends on ${end}. Renew it under Membership, or turn on automatic renewal.`;
      await db.tx(async (tx) => {
        const fresh = await tx.query('INSERT INTO membership_notices (member_id, term_ends_at, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING member_id', [m.id, m.term_ends_at, `reminder_${days}`]);
        if (fresh[0]) { await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'membership_update', $2)`, [m.user_id, title]); out.reminded++; }
      });
    }
  }
  // Charges: the term has ended (or the next try is due), automatic renewal is on, and the tries are not used up.
  const charge = await db.query<MemberRow>(`${MEMBER_SQL}
    WHERE m.status = 'active' AND m.auto_renew AND m.term_ends_at <= now() AND m.renewal_attempts <= $1
      AND (m.next_renewal_attempt_at IS NULL OR m.next_renewal_attempt_at <= now()) AND (m.renewal_attempts = 0 OR m.next_renewal_attempt_at IS NOT NULL)
      AND t.price_minor > 0 ORDER BY m.term_ends_at LIMIT 100`, [RENEWAL_RETRY_DAYS.length]);
  for (const m of charge) {
    const card = await cardOf(db, m.user_id);
    if (!card) continue;
    const r = await chargeRenewal(db, provider, m, card, null);
    if (r.paid) out.renewed++; else out.failed++;
  }
  // Lapsing: the grace period is over. Member permissions stop at once (they are read from `members.status`).
  const lapse = await db.query<MemberRow>(`${MEMBER_SQL} WHERE m.status = 'active' AND m.term_ends_at <= now() - make_interval(days => $1)`, [RENEWAL_GRACE_DAYS]);
  for (const m of lapse) {
    await db.tx(async (tx) => {
      const done = await tx.query(`UPDATE members SET status = 'lapsed', lapsed_at = now(), next_renewal_attempt_at = NULL WHERE id = $1 AND status = 'active' RETURNING id`, [m.id]);
      if (!done[0]) return;
      await tx.query('INSERT INTO membership_notices (member_id, term_ends_at, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [m.id, m.term_ends_at, 'lapsed']);
      await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'membership_update', $2)`, [m.user_id,
        `Your ${m.tier_name} membership has ended. Your profile, bookings and messages are kept: renew under Membership whenever you are ready and everything is as you left it.`]);
      await audit(tx, null, 'membership.lapsed', 'member', m.id, { termEndedAt: m.term_ends_at });
      out.lapsed++;
    });
  }
  return out;
}

/* ---------- Staff ---------- */

export interface StaffRenewal {
  memberId: string; memberName: string; memberNumber: string; tierName: string; termEndsAt: string | null; autoRenew: boolean; cardOnFile: boolean;
  cardExpiresBeforeRenewal: boolean; attempts: number; nextAttemptAt: string | null; lastFailure: string | null; status: string; lapsedAt: string | null; amountMinor: number; currency: string;
}

/** Renewals coming up, those failing and recent lapses, in the city being viewed. Card details are never shown. */
export async function listRenewals(db: Queryable, ctx: RequestContext): Promise<{ upcoming: StaffRenewal[]; failing: StaffRenewal[]; lapsed: StaffRenewal[] }> {
  requireStaff(ctx, 'admin.finance.manage');
  const rows = await db.query(
    `SELECT m.id, p.full_name, m.member_number, t.name AS tier_name, m.term_ends_at, m.auto_renew, m.renewal_attempts, m.next_renewal_attempt_at, m.last_renewal_failure,
            m.status, m.lapsed_at, t.price_minor, t.currency_code, pm.id AS card, pm.exp_month, pm.exp_year
       FROM members m JOIN membership_tiers t ON t.id = m.tier_id JOIN profiles p ON p.user_id = m.user_id
       LEFT JOIN payment_methods pm ON pm.user_id = m.user_id AND pm.removed_at IS NULL
      WHERE m.home_market_id = $1 AND (
            (m.status = 'active' AND m.term_ends_at <= now() + interval '60 days')
         OR (m.status = 'lapsed' AND m.lapsed_at > now() - interval '90 days'))
      ORDER BY m.term_ends_at`, [ctx.marketId]);
  const all = rows.map((r): StaffRenewal => ({
    memberId: r.id as string, memberName: r.full_name as string, memberNumber: r.member_number as string, tierName: r.tier_name as string,
    termEndsAt: r.term_ends_at ? new Date(r.term_ends_at as string).toISOString() : null, autoRenew: Boolean(r.auto_renew), cardOnFile: Boolean(r.card),
    cardExpiresBeforeRenewal: Boolean(r.card && r.term_ends_at && !cardValidOn({ exp_month: Number(r.exp_month), exp_year: Number(r.exp_year) }, new Date(r.term_ends_at as string))),
    attempts: Number(r.renewal_attempts), nextAttemptAt: r.next_renewal_attempt_at ? new Date(r.next_renewal_attempt_at as string).toISOString() : null,
    lastFailure: (r.last_renewal_failure as string | null) ?? null, status: r.status as string, lapsedAt: r.lapsed_at ? new Date(r.lapsed_at as string).toISOString() : null,
    amountMinor: Number(r.price_minor), currency: (r.currency_code as string).trim(),
  }));
  return {
    upcoming: all.filter((r) => r.status === 'active' && r.attempts === 0 && r.termEndsAt && new Date(r.termEndsAt) > new Date()),
    failing: all.filter((r) => r.status === 'active' && (r.attempts > 0 || (r.termEndsAt && new Date(r.termEndsAt) <= new Date()))),
    lapsed: all.filter((r) => r.status === 'lapsed'),
  };
}

/** Staff try the saved card again now, after the member has sorted out the card with their bank. */
export async function retryRenewal(db: Db, ctx: RequestContext, provider: PaymentProvider, memberId: string): Promise<{ paid: boolean; reason?: string }> {
  const staffId = requireStaff(ctx, 'admin.finance.manage');
  const m = UUID.test(memberId) ? (await db.query<MemberRow>(`${MEMBER_SQL} WHERE m.id = $1`, [memberId]))[0] : undefined;
  if (!m) throw notFound('This member does not exist.');
  if (m.status !== 'active' && m.status !== 'lapsed') throw conflict('Only an active or lapsed membership can be renewed.');
  if (!m.months || Number(m.price_minor) === 0) throw conflict('This membership has no term to renew.');
  if (stateOf(m) === 'active') throw conflict('This membership is not due for renewal yet.');
  const card = await cardOf(db, m.user_id);
  if (!card) throw new HttpError(409, 'The member has no saved card. Ask them to add one under Membership.');
  const r = await chargeRenewal(db, provider, m, card, staffId, `staff-retry:${m.id}:${randomUUID()}`);
  return r.paid ? { paid: true } : { paid: false, reason: r.reason };
}

const extendSchema = z.object({ days: z.number().int().min(1).max(365), reason: z.string().trim().min(5).max(300) });

/** Staff extend a term without charging (a goodwill gesture, a bank delay). The reason is kept in the audit log. */
export async function extendTerm(db: Db, ctx: RequestContext, memberId: string, body: unknown): Promise<{ termEndsAt: string }> {
  const staffId = requireStaff(ctx, 'admin.finance.manage');
  const parsed = extendSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const m = UUID.test(memberId) ? (await db.query<MemberRow>(`${MEMBER_SQL} WHERE m.id = $1`, [memberId]))[0] : undefined;
  if (!m) throw notFound('This member does not exist.');
  if (m.status !== 'active' && m.status !== 'lapsed') throw conflict('Only an active or lapsed membership can be extended.');
  return db.tx(async (tx) => {
    const end = (await tx.query<{ e: Date }>(
      `UPDATE members SET term_ends_at = GREATEST(COALESCE(term_ends_at, now()), CASE WHEN status = 'lapsed' THEN now() ELSE COALESCE(term_ends_at, now()) END) + make_interval(days => $2),
              status = 'active', lapsed_at = NULL, renewal_attempts = 0, next_renewal_attempt_at = NULL, last_renewal_failure = NULL
        WHERE id = $1 RETURNING term_ends_at AS e`, [m.id, parsed.data.days]))[0]!.e;
    await audit(tx, staffId, 'membership.extended', 'member', m.id, { days: parsed.data.days, reason: parsed.data.reason, termEndsAt: end });
    await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'membership_update', $2)`, [m.user_id, `The Quintara team has extended your membership until ${day(new Date(end), m.timezone)}.`]);
    return { termEndsAt: new Date(end).toISOString() };
  });
}
