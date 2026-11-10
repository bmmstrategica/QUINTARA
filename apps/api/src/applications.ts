import { APPLICATION_WAITING_LIST_MESSAGE, applicationSchema, checkAnswers, EMPTY_APPLICATION } from '@quintara/domain';
import { listQuestions } from './application-form.ts';
import type { Application, ApplicationData } from '@quintara/domain';
import { audit, createSession } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, HttpError, validation } from './errors.ts';

function toApplication(row: Row): Application {
  return {
    id: row.id as string,
    status: row.status as Application['status'],
    data: { ...EMPTY_APPLICATION, ...(row.data as Partial<ApplicationData>) },
    offeredTierName: (row.tier_name as string | null) ?? null,
    fee: row.tier_name ? {
      priceMinor: Number(row.price_minor), discountMinor: Number(row.discount_minor), dueMinor: Math.max(0, Number(row.price_minor) - Number(row.discount_minor)),
      currency: String(row.currency_code).trim(), discountReason: (row.discount_reason as string | null) ?? null,
    } : null,
    submittedAt: row.submitted_at ? new Date(row.submitted_at as string).toISOString() : null,
  };
}

const SELECT_APPLICATION = `
  SELECT a.id, a.status, a.data, a.submitted_at, a.discount_minor, a.discount_reason, t.name AS tier_name, t.price_minor, t.currency_code
    FROM membership_applications a LEFT JOIN membership_tiers t ON t.id = a.offered_tier_id`;

async function findOpen(db: Queryable, userId: string): Promise<Row | undefined> {
  const rows = await db.query(`${SELECT_APPLICATION} WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 1`, [userId]);
  return rows[0];
}

export async function getApplication(db: Queryable, ctx: RequestContext): Promise<Application | null> {
  if (!ctx.userId) return null;
  const row = await findOpen(db, ctx.userId);
  return row ? toApplication(row) : null;
}

export interface ApplicationResult {
  application: Application;
  /** Set when this request created the applicant's account, so the route can set the session cookie. */
  newSessionToken: string | null;
}

/** The data is accepted as it stands for a draft (only its shape is checked) and validated in full on submission. */
function draftData(body: unknown): ApplicationData {
  const parsed = applicationSchema.partial().safeParse(body);
  const loose = (parsed.success ? parsed.data : {}) as Partial<ApplicationData>;
  const source = (body ?? {}) as Record<string, unknown>;
  // Keep anything the applicant has typed so far, even if it would not yet pass validation.
  const text = (key: keyof ApplicationData) => (typeof source[key] === 'string' ? (source[key] as string).slice(0, 1200) : '');
  return {
    ...EMPTY_APPLICATION,
    ...loose,
    email: text('email'), fullName: text('fullName'), city: text('city'), position: text('position'), company: text('company'),
    industry: text('industry'), motivation: text('motivation'), referral: text('referral'), links: text('links'), socialHandle: text('socialHandle').slice(0, 31),
    socialPlatform: source.socialPlatform === 'tiktok' || source.socialPlatform === 'x' ? source.socialPlatform : 'instagram',
    phone: text('phone').slice(0, 24), planId: text('planId').slice(0, 64),
    residency: source.residency === 'international' ? 'international' : 'resident',
    answers: draftAnswers(source.answers),
    asFounder: source.asFounder === true, asInvestor: source.asInvestor === true,
    interests: Array.isArray(source.interests) ? source.interests.filter((item): item is string => typeof item === 'string').slice(0, 12) : [],
  };
}

/** Answers kept as typed while drafting: strings and short lists of strings only, and not too many of them. */
function draftAnswers(value: unknown): Record<string, string | string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string | string[]> = {};
  for (const [key, answer] of Object.entries(value).slice(0, 60)) {
    if (key.length > 64) continue;
    if (typeof answer === 'string') out[key] = answer.slice(0, 1200);
    else if (Array.isArray(answer)) out[key] = answer.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 120)).slice(0, 24);
  }
  return out;
}

async function upsert(db: Db, ctx: RequestContext, marketId: string, data: ApplicationData, submit: boolean): Promise<ApplicationResult> {
  if (ctx.session) throw conflict('You are already a member.');
  return db.tx(async (tx) => {
    let requestedTierId: string | null = null;
    if (submit) {
      // The plan must be one offered in this city, for the residency chosen.
      const plan = /^[0-9a-f-]{36}$/i.test(data.planId)
        ? (await tx.query<{ id: string }>('SELECT id FROM membership_tiers WHERE id = $1 AND market_id = $2 AND is_active AND residency = $3 AND term_months IS NOT NULL', [data.planId, marketId, data.residency]))[0]
        : undefined;
      if (!plan) throw new HttpError(422, 'Choose the membership you are applying for.', { planId: 'Choose the membership you are applying for' });
      requestedTierId = plan.id;
      const checked = checkAnswers((await listQuestions(tx)).custom, data.answers);
      const wrong = Object.entries(checked.errors);
      if (wrong.length) throw new HttpError(422, 'Some answers need attention.', Object.fromEntries(wrong.map(([id, message]) => [`q:${id}`, message])));
      data = { ...data, answers: checked.answers };
    }
    let userId = ctx.userId;
    let newSessionToken: string | null = null;
    if (!userId) {
      // First save by a visitor: create a pending account so the draft follows them between visits.
      userId = (await tx.query<{ id: string }>(`INSERT INTO users (status) VALUES ('pending') RETURNING id`))[0]!.id;
      newSessionToken = await createSession(tx, userId);
    }
    const existing = await findOpen(tx, userId);
    if (existing && existing.status !== 'draft') throw conflict('This application has already been sent.');

    if (submit) {
      const taken = await tx.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2 AND deleted_at IS NULL', [data.email, userId]);
      if (taken[0]) throw new HttpError(409, 'An account already uses this email address. Sign in instead.', { email: 'This email address is already in use' });
      await tx.query('UPDATE users SET email = $2, updated_at = now() WHERE id = $1', [userId, data.email]);
    }
    const status = submit ? 'submitted' : 'draft';
    let id: string;
    if (existing) {
      id = existing.id as string;
      await tx.query(`UPDATE membership_applications SET data = $2::jsonb, status = $3, submitted_at = CASE WHEN $3 = 'submitted' THEN now() ELSE NULL END, requested_tier_id = $4, updated_at = now() WHERE id = $1`, [id, JSON.stringify(data), status, requestedTierId]);
    } else {
      id = (await tx.query<{ id: string }>(
        `INSERT INTO membership_applications (user_id, market_id, data, status, submitted_at, requested_tier_id) VALUES ($1, $2, $3::jsonb, $4, CASE WHEN $4 = 'submitted' THEN now() ELSE NULL END, $5) RETURNING id`,
        [userId, marketId, JSON.stringify(data), status, requestedTierId],
      ))[0]!.id;
    }
    if (submit) {
      await audit(tx, userId, 'application.submitted', 'membership_application', id);
      // Also sent by email, through the notification outbox.
      await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'membership_update', $2)`, [userId, APPLICATION_WAITING_LIST_MESSAGE]);
    }
    const row = (await tx.query(`${SELECT_APPLICATION} WHERE a.id = $1`, [id]))[0]!;
    return { application: toApplication(row), newSessionToken };
  });
}

export function saveApplicationDraft(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<ApplicationResult> {
  return upsert(db, ctx, marketId, draftData(body), false);
}

export function submitApplication(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<ApplicationResult> {
  const parsed = applicationSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  return upsert(db, ctx, marketId, parsed.data, true);
}
