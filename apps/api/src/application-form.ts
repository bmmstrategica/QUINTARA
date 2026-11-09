/**
 * What the membership application asks: the plans an applicant can apply for, and the questions.
 *
 * Plans are membership tiers with a residency and a term. Questions are the built-in ones, which staff can reword
 * but not remove, and questions staff add. Added questions are retired rather than deleted, so an answer given to
 * a question that has since changed or been retired still shows with its question for the committee.
 */
import { BUILTIN_QUESTION_DEFAULTS, BUILTIN_QUESTION_KEYS, builtinQuestionInputSchema, customQuestionInputSchema, DEFAULT_MEMBERSHIP_PLANS, planName } from '@quintara/domain';
import type { ApplicationQuestions, BuiltinQuestionKey, CustomQuestion, MembershipPlan, QuestionKind, Residency } from '@quintara/domain';
import { z } from 'zod';
import { audit, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Queryable } from './db.ts';
import { notFound, validation } from './errors.ts';

const PERMISSION = 'admin.applications.review';

/* ---------- Plans ---------- */

/** Gives a market the standard plans when its fees are in rand. Other currencies set their own under Tiers. */
export async function addDefaultPlans(db: Queryable, marketId: string, currency: string): Promise<void> {
  if (currency.trim() !== 'ZAR') return;
  for (const p of DEFAULT_MEMBERSHIP_PLANS) {
    await db.query(
      `INSERT INTO membership_tiers (market_id, name, price_minor, currency_code, billing_period, residency, term_months)
       VALUES ($1, $2, $3, $4, 'once', $5, $6) ON CONFLICT (market_id, name) DO NOTHING`,
      [marketId, planName(p.residency, p.termMonths), p.priceMinor, currency, p.residency, p.termMonths]);
  }
}

/** The plans offered in a market, residents first, shortest term first. */
export async function listPlans(db: Queryable, marketId: string): Promise<MembershipPlan[]> {
  const rows = await db.query(
    `SELECT id, name, residency, term_months, price_minor, currency_code FROM membership_tiers
      WHERE market_id = $1 AND is_active AND residency IS NOT NULL AND term_months IS NOT NULL
      ORDER BY residency DESC, term_months`, [marketId]);
  return rows.map((r) => ({ id: r.id as string, name: r.name as string, residency: r.residency as Residency, termMonths: Number(r.term_months), priceMinor: Number(r.price_minor), currency: (r.currency_code as string).trim() }));
}

/* ---------- Questions ---------- */

const toCustom = (r: Record<string, unknown>): CustomQuestion => ({
  id: r.id as string, kind: r.kind as QuestionKind, label: r.label as string, help: r.help as string, options: (r.options as string[]) ?? [],
  required: Boolean(r.required), active: Boolean(r.is_active), position: Number(r.position),
});

/** The questions as applicants see them: every built-in question, and the added questions that are open. */
export async function listQuestions(db: Queryable, includeRetired = false): Promise<ApplicationQuestions> {
  const [copy, custom] = await Promise.all([
    db.query<{ key: BuiltinQuestionKey; label: string; help: string; options: string[] }>('SELECT key, label, help, options FROM application_question_copy'),
    db.query(`SELECT * FROM application_questions ${includeRetired ? '' : 'WHERE is_active'} ORDER BY position, created_at`),
  ]);
  return {
    builtin: BUILTIN_QUESTION_KEYS.map((key) => {
      const row = copy.find((c) => c.key === key), d = BUILTIN_QUESTION_DEFAULTS[key];
      return row ? { key, label: row.label, help: row.help, options: row.options?.length ? row.options : d.options, edited: true } : { key, ...d, edited: false };
    }),
    custom: custom.map(toCustom),
  };
}

export function listQuestionsForStaff(db: Queryable, ctx: RequestContext): Promise<ApplicationQuestions> {
  requireStaff(ctx, PERMISSION);
  return listQuestions(db, true);
}

const isBuiltin = (key: string): key is BuiltinQuestionKey => (BUILTIN_QUESTION_KEYS as readonly string[]).includes(key);

/** Rewords a built-in question. Only the interests question has choices staff can change. */
export async function updateBuiltinQuestion(db: Queryable, ctx: RequestContext, key: string, body: unknown): Promise<ApplicationQuestions> {
  const staffId = requireStaff(ctx, PERMISSION);
  if (!isBuiltin(key)) throw notFound('There is no such question.');
  const parsed = builtinQuestionInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const options = key === 'interests' ? [...new Set(parsed.data.options ?? BUILTIN_QUESTION_DEFAULTS.interests.options)] : [];
  if (key === 'interests' && options.length < 2) throw validation([{ path: ['options'], message: 'Give at least two interests' }]);
  const id = (await db.query<{ id: string }>(
    `INSERT INTO application_question_copy (key, label, help, options, updated_by) VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, help = EXCLUDED.help, options = EXCLUDED.options, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING id`,
    [key, parsed.data.label, parsed.data.help, JSON.stringify(options), staffId]))[0]!.id;
  await audit(db, staffId, 'application_question.reworded', 'application_question_copy', id, { key });
  return listQuestions(db, true);
}

export async function resetBuiltinQuestion(db: Queryable, ctx: RequestContext, key: string): Promise<ApplicationQuestions> {
  const staffId = requireStaff(ctx, PERMISSION);
  if (!isBuiltin(key)) throw notFound('There is no such question.');
  const rows = await db.query<{ id: string }>('DELETE FROM application_question_copy WHERE key = $1 RETURNING id', [key]);
  if (rows[0]) await audit(db, staffId, 'application_question.restored', 'application_question_copy', rows[0].id, { key });
  return listQuestions(db, true);
}

export async function createQuestion(db: Queryable, ctx: RequestContext, body: unknown): Promise<ApplicationQuestions> {
  const staffId = requireStaff(ctx, PERMISSION);
  const parsed = customQuestionInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const q = parsed.data, options = q.kind === 'choice' || q.kind === 'multi_choice' ? [...new Set(q.options)] : [];
  const id = (await db.query<{ id: string }>(
    `INSERT INTO application_questions (kind, label, help, options, required, is_active, position, created_by, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $8) RETURNING id`,
    [q.kind, q.label, q.help, JSON.stringify(options), q.required, q.active, q.position, staffId]))[0]!.id;
  await audit(db, staffId, 'application_question.created', 'application_question', id, { kind: q.kind });
  return listQuestions(db, true);
}

const uuid = z.uuid();

/** Changes an added question. Its kind is fixed once it exists, so answers already given still fit it. */
export async function updateQuestion(db: Queryable, ctx: RequestContext, id: string, body: unknown): Promise<ApplicationQuestions> {
  const staffId = requireStaff(ctx, PERMISSION);
  const existing = uuid.safeParse(id).success ? (await db.query('SELECT * FROM application_questions WHERE id = $1', [id]))[0] : undefined;
  if (!existing) throw notFound('There is no such question.');
  const merged = { ...toCustom(existing), ...((body ?? {}) as object), kind: existing.kind };
  const parsed = customQuestionInputSchema.safeParse(merged);
  if (!parsed.success) throw validation(parsed.error.issues);
  const q = parsed.data, options = q.kind === 'choice' || q.kind === 'multi_choice' ? [...new Set(q.options)] : [];
  await db.query(
    `UPDATE application_questions SET label = $2, help = $3, options = $4::jsonb, required = $5, is_active = $6, position = $7, updated_by = $8, updated_at = now() WHERE id = $1`,
    [id, q.label, q.help, JSON.stringify(options), q.required, q.active, q.position, staffId]);
  await audit(db, staffId, existing.is_active && !q.active ? 'application_question.retired' : 'application_question.updated', 'application_question', id);
  return listQuestions(db, true);
}
