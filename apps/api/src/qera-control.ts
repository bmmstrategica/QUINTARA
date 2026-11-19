/**
 * The QÉRA Control Centre on the server, and QÉRA's knowledge base.
 *
 * - Everyone on staff with `admin.qera.view` sees the dashboard, the escalations QÉRA made and the knowledge base.
 * - Only administrators (`admin.qera.manage`) change how QÉRA runs, edit its knowledge and prompts, see the model
 *   call log, and read a member's conversation. Reading a conversation needs a stated reason, is written to the
 *   audit log, and shows the text with card numbers, email addresses and phone numbers hidden.
 * - Members never see any of this, and QÉRA itself only ever reads published knowledge meant for its audience.
 */
import { conversationReasonSchema, qeraFeedbackSchema, qeraKnowledgeSchema, qeraPromptSchema, qeraSettingsSchema, redactForStaff } from '@quintara/domain';
import type { QeraConversationSummary, QeraConversationView, QeraDashboard, QeraEscalation, QeraKnowledgeEntry, QeraKnowledgeHit, QeraModelCall, QeraPromptVersion, QeraSettingsView } from '@quintara/domain';
import { audit, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db } from './db.ts';
import { HttpError, notFound, validation } from './errors.ts';
import { loadSettings } from './qera-gateway/model.ts';
import type { GatewayQeraModel } from './qera-gateway/model.ts';

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const usd = (micro: number | string) => Math.round(Number(micro)) / 10_000;
const NAME = `coalesce(p.full_name, g.full_name, 'A former member')`;

/* ---------- Knowledge: what QÉRA reads ---------- */

const STOP = new Set(['the', 'and', 'for', 'are', 'can', 'what', 'when', 'where', 'which', 'who', 'how', 'does', 'with', 'your', 'you', 'quintara', 'please', 'tell', 'about', 'there', 'this', 'that', 'have', 'from', 'will', 'would', 'could', 'should', 'into', 'any', 'our', 'my', 'me']);
const terms = (text: string) => [...new Set(text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 12);

/**
 * Published passages for a question, best first. Guests are given public entries only; staff-only entries are never
 * returned. A passage must share enough of the question's words to count, so a loose match is not passed off as an
 * answer.
 */
export async function searchKnowledge(db: Db, audience: 'member' | 'guest', marketId: string, query: string, limit = 3): Promise<QeraKnowledgeHit[]> {
  const words = terms(query);
  if (!words.length) return [];
  const rows = await db.query(
    `SELECT id, title, topic, body, updated_at, ts_rank(search, q) AS rank
       FROM qera_knowledge, to_tsquery('english', $1) q
      WHERE status = 'published' AND audience = ANY($2) AND (market_id IS NULL OR market_id = $3) AND search @@ q
      ORDER BY rank DESC, updated_at DESC LIMIT 8`,
    [words.join(' | '), audience === 'guest' ? ['public'] : ['public', 'member'], marketId]);
  const need = words.length >= 3 ? Math.ceil(words.length * 0.4) : 1;
  const stem = (w: string) => w.slice(0, Math.max(4, w.length - 2));
  return rows
    .filter((r) => { const text = `${r.title} ${r.body}`.toLowerCase(); return words.filter((w) => text.includes(stem(w))).length >= need; })
    .slice(0, limit)
    .map((r) => ({ id: r.id as string, title: r.title as string, topic: r.topic as string, text: (r.body as string).slice(0, 1500), updatedAt: iso(r.updated_at)! }));
}

/* ---------- Members: feedback on a reply ---------- */

export async function giveFeedback(db: Db, ctx: RequestContext, messageId: string, body: unknown): Promise<void> {
  const userId = ctx.userId;
  if (!userId || (!ctx.session && !ctx.guest)) throw new HttpError(401, 'Sign in to continue.');
  const parsed = qeraFeedbackSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const ok = /^[0-9a-f-]{36}$/i.test(messageId) && (await db.query(`SELECT 1 FROM qera_messages WHERE id = $1 AND user_id = $2 AND role = 'qera'`, [messageId, userId])).length > 0;
  if (!ok) throw notFound('That reply could not be found.');
  await db.query(`INSERT INTO qera_feedback (message_id, user_id, helpful, comment) VALUES ($1, $2, $3, $4)
    ON CONFLICT (message_id) DO UPDATE SET helpful = EXCLUDED.helpful, comment = EXCLUDED.comment, created_at = now()`, [messageId, userId, parsed.data.helpful, parsed.data.comment]);
}

/* ---------- Staff: settings and prompts ---------- */

export async function getSettings(db: Db, ctx: RequestContext, gateway: GatewayQeraModel | null): Promise<QeraSettingsView> {
  requireStaff(ctx, 'admin.qera.view');
  const s = await loadSettings(db);
  const row = (await db.query(`SELECT s.updated_at, coalesce(p.full_name, u.email) AS by FROM qera_settings s LEFT JOIN users u ON u.id = s.updated_by LEFT JOIN profiles p ON p.user_id = s.updated_by`))[0]!;
  return {
    providerOrder: s.providerOrder, models: s.models, configured: gateway?.configured() ?? [], llmEnabled: s.llmEnabled, knowledgeEnabled: s.knowledgeEnabled, proactiveEnabled: s.proactiveEnabled,
    autonomyLevel: s.autonomyLevel as 1 | 2 | 3, dailyCostCapCents: s.dailyCostCapCents, memberHourlyLimit: s.memberHourlyLimit, escalateAboveMinor: s.escalateAboveMinor,
    livePromptVersion: s.prompt.version, updatedAt: iso(row.updated_at)!, updatedBy: (row.by as string) ?? null,
  };
}

export async function updateSettings(db: Db, ctx: RequestContext, gateway: GatewayQeraModel | null, body: unknown): Promise<QeraSettingsView> {
  const me = requireStaff(ctx, 'admin.qera.manage');
  const parsed = qeraSettingsSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const before = await loadSettings(db);
  const v = parsed.data;
  await db.query(`UPDATE qera_settings SET provider_order = $1, models = $2::jsonb, llm_enabled = $3, knowledge_enabled = $4, proactive_enabled = $5, autonomy_level = $6,
    daily_cost_cap_cents = $7, member_hourly_limit = $8, escalate_above_minor = $9, updated_by = $10, updated_at = now()`,
    [v.providerOrder, JSON.stringify(v.models), v.llmEnabled, v.knowledgeEnabled, v.proactiveEnabled, v.autonomyLevel, v.dailyCostCapCents, v.memberHourlyLimit, v.escalateAboveMinor, me]);
  const { prompt: _p, ...was } = before;
  await audit(db, me, 'qera.settings_changed', 'qera_settings', me, { before: was, after: v });
  gateway?.invalidate();
  return getSettings(db, ctx, gateway);
}

const promptRow = (r: Record<string, unknown>): QeraPromptVersion => ({ id: r.id as string, version: Number(r.version), body: r.body as string, note: r.note as string, isLive: Boolean(r.is_live), createdAt: iso(r.created_at)!, createdBy: (r.by as string) ?? null });

export async function listPrompts(db: Db, ctx: RequestContext): Promise<QeraPromptVersion[]> {
  requireStaff(ctx, 'admin.qera.manage');
  return (await db.query(`SELECT v.*, coalesce(p.full_name, u.email) AS by FROM qera_prompt_versions v LEFT JOIN users u ON u.id = v.created_by LEFT JOIN profiles p ON p.user_id = v.created_by ORDER BY version DESC`)).map(promptRow);
}

/** A new version is saved as a draft; publishing it is a separate step. Version 1 is the built-in prompt. */
export async function createPrompt(db: Db, ctx: RequestContext, body: unknown): Promise<QeraPromptVersion> {
  const me = requireStaff(ctx, 'admin.qera.manage');
  const parsed = qeraPromptSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const row = (await db.query(`INSERT INTO qera_prompt_versions (version, body, note, created_by) VALUES ((SELECT greatest(coalesce(max(version), 0), 1) + 1 FROM qera_prompt_versions), $1, $2, $3) RETURNING *`, [parsed.data.body, parsed.data.note, me]))[0]!;
  await audit(db, me, 'qera.prompt_created', 'qera_prompt_version', row.id as string, { version: row.version });
  return promptRow(row);
}

/** Makes a version live, or with `null` goes back to the built-in prompt. Also how a change is rolled back. */
export async function publishPrompt(db: Db, ctx: RequestContext, gateway: GatewayQeraModel | null, id: string | null): Promise<void> {
  const me = requireStaff(ctx, 'admin.qera.manage');
  await db.tx(async (tx) => {
    if (id !== null && !(/^[0-9a-f-]{36}$/i.test(id) && (await tx.query(`SELECT 1 FROM qera_prompt_versions WHERE id = $1`, [id])).length)) throw notFound('That prompt version could not be found.');
    await tx.query(`UPDATE qera_prompt_versions SET is_live = FALSE WHERE is_live`);
    if (id) await tx.query(`UPDATE qera_prompt_versions SET is_live = TRUE WHERE id = $1`, [id]);
    await audit(tx, me, 'qera.prompt_published', 'qera_prompt_version', id ?? me, { builtIn: id === null });
  });
  gateway?.invalidate();
}

/* ---------- Staff: knowledge base ---------- */

const knowledgeRow = (r: Record<string, unknown>): QeraKnowledgeEntry => ({
  id: r.id as string, topic: r.topic as QeraKnowledgeEntry['topic'], title: r.title as string, body: r.body as string, audience: r.audience as QeraKnowledgeEntry['audience'],
  status: r.status as QeraKnowledgeEntry['status'], version: Number(r.version), reviewBy: r.review_by ? String(r.review_by instanceof Date ? r.review_by.toISOString() : r.review_by).slice(0, 10) : null,
  marketId: (r.market_id as string) ?? null, updatedAt: iso(r.updated_at)!, updatedBy: (r.by as string) ?? null, dueForReview: Boolean(r.due),
});
const KNOWLEDGE_SELECT = `SELECT k.*, coalesce(p.full_name, u.email) AS by, (k.review_by IS NOT NULL AND k.review_by <= current_date) AS due FROM qera_knowledge k LEFT JOIN users u ON u.id = k.updated_by LEFT JOIN profiles p ON p.user_id = k.updated_by`;

export async function listKnowledge(db: Db, ctx: RequestContext): Promise<QeraKnowledgeEntry[]> {
  requireStaff(ctx, 'admin.qera.view');
  return (await db.query(`${KNOWLEDGE_SELECT} WHERE k.market_id IS NULL OR k.market_id = $1 ORDER BY (k.status = 'archived'), k.topic, k.title`, [ctx.marketId])).map(knowledgeRow);
}

export async function createKnowledge(db: Db, ctx: RequestContext, body: unknown): Promise<QeraKnowledgeEntry> {
  const me = requireStaff(ctx, 'admin.qera.manage');
  const parsed = qeraKnowledgeSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const v = parsed.data;
  const id = (await db.query<{ id: string }>(`INSERT INTO qera_knowledge (market_id, topic, title, body, audience, status, review_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [v.allMarkets ? null : ctx.marketId, v.topic, v.title, v.body, v.audience, v.status, v.reviewBy, me]))[0]!.id;
  await audit(db, me, 'qera.knowledge_created', 'qera_knowledge', id, { title: v.title, status: v.status, audience: v.audience });
  return knowledgeRow((await db.query(`${KNOWLEDGE_SELECT} WHERE k.id = $1`, [id]))[0]!);
}

export async function updateKnowledge(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<QeraKnowledgeEntry> {
  const me = requireStaff(ctx, 'admin.qera.manage');
  const parsed = qeraKnowledgeSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const v = parsed.data;
  const updated = /^[0-9a-f-]{36}$/i.test(id) ? await db.query(`UPDATE qera_knowledge SET market_id = $2, topic = $3, title = $4, body = $5, audience = $6, status = $7, review_by = $8, updated_by = $9, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING id`,
    [id, v.allMarkets ? null : ctx.marketId, v.topic, v.title, v.body, v.audience, v.status, v.reviewBy, me]) : [];
  if (!updated.length) throw notFound('That entry could not be found.');
  await audit(db, me, 'qera.knowledge_updated', 'qera_knowledge', id, { title: v.title, status: v.status, audience: v.audience });
  return knowledgeRow((await db.query(`${KNOWLEDGE_SELECT} WHERE k.id = $1`, [id]))[0]!);
}

export async function deleteKnowledge(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const me = requireStaff(ctx, 'admin.qera.manage');
  const gone = /^[0-9a-f-]{36}$/i.test(id) ? await db.query(`DELETE FROM qera_knowledge WHERE id = $1 RETURNING title`, [id]) : [];
  if (!gone.length) throw notFound('That entry could not be found.');
  await audit(db, me, 'qera.knowledge_deleted', 'qera_knowledge', id, { title: gone[0]!.title });
}

/* ---------- Staff: dashboard, model calls, escalations, conversations ---------- */

export async function getDashboard(db: Db, ctx: RequestContext, daysParam?: string): Promise<QeraDashboard> {
  requireStaff(ctx, 'admin.qera.view');
  const days = [7, 30, 90, 365].includes(Number(daysParam)) ? Number(daysParam) : 30;
  const since = `now() - make_interval(days => ${days})`;
  const [conv, tasks, bookings, partner, service, plans, esc, escStatus, calls, fallbacks, byProvider, feedback, tools, answeredBy, knowledge, settings, today] = await Promise.all([
    db.query(`SELECT count(DISTINCT m.user_id) FILTER (WHERE g.user_id IS NULL)::int AS members, count(DISTINCT m.user_id) FILTER (WHERE g.user_id IS NOT NULL)::int AS guests,
      count(*) FILTER (WHERE m.role = 'member')::int AS asked, count(*) FILTER (WHERE m.role = 'qera')::int AS replies
      FROM qera_messages m LEFT JOIN guest_accounts g ON g.user_id = m.user_id WHERE m.created_at > ${since}`),
    db.query(`SELECT status, count(*)::int AS n FROM qera_proposals WHERE created_at > ${since} GROUP BY status`),
    db.query(`SELECT count(*)::int AS n, coalesce(sum(amount_due_minor) FILTER (WHERE status IN ('confirmed', 'attended')), 0)::text AS revenue FROM experience_bookings WHERE source = 'qera' AND created_at > ${since}`),
    db.query(`SELECT count(*)::int AS n FROM qera_proposals WHERE tool = 'book_partner' AND status = 'confirmed' AND created_at > ${since}`),
    db.query(`SELECT count(*)::int AS n FROM qera_proposals WHERE tool = 'request_service' AND status = 'confirmed' AND created_at > ${since}`),
    db.query(`SELECT count(*)::int AS n FROM qera_proposals WHERE tool = 'book_plan' AND status = 'confirmed' AND created_at > ${since}`),
    db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status NOT IN ('completed', 'cancelled'))::int AS open FROM concierge_requests WHERE source = 'qera' AND created_at > ${since}`),
    db.query(`SELECT status, count(*)::int AS n FROM concierge_requests WHERE source = 'qera' AND created_at > ${since} GROUP BY status ORDER BY n DESC`),
    db.query(`SELECT count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed, avg(latency_ms) FILTER (WHERE ok) AS latency, coalesce(sum(cost_micro), 0)::text AS cost FROM qera_model_calls WHERE created_at > ${since}`),
    db.query(`SELECT count(*)::int AS n FROM qera_messages WHERE role = 'qera' AND model = 'rules' AND created_at > ${since}`),
    db.query(`SELECT provider, model, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed, coalesce(sum(cost_micro), 0)::text AS cost, avg(latency_ms) FILTER (WHERE ok) AS latency FROM qera_model_calls WHERE created_at > ${since} GROUP BY provider, model ORDER BY calls DESC`),
    db.query(`SELECT count(*) FILTER (WHERE helpful)::int AS yes, count(*) FILTER (WHERE NOT helpful)::int AS no FROM qera_feedback WHERE created_at > ${since}`),
    db.query(`SELECT changes->>'tool' AS tool, count(*)::int AS n FROM audit_logs WHERE action = 'qera.tool_used' AND occurred_at > ${since} GROUP BY 1 ORDER BY n DESC LIMIT 12`),
    db.query(`SELECT coalesce(model, 'rules') AS model, count(*)::int AS n FROM qera_messages WHERE role = 'qera' AND created_at > ${since} GROUP BY 1 ORDER BY n DESC`),
    db.query(`SELECT count(*) FILTER (WHERE status = 'published')::int AS published, count(*) FILTER (WHERE status = 'draft')::int AS drafts, count(*) FILTER (WHERE status = 'published' AND review_by <= current_date)::int AS due FROM qera_knowledge`),
    loadSettings(db),
    db.query(`SELECT coalesce(sum(cost_micro), 0)::text AS cost FROM qera_model_calls WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg'`),
  ]);
  const t = Object.fromEntries(tasks.map((r) => [r.status as string, Number(r.n)])) as Record<string, number>;
  const proposed = Object.values(t).reduce((a, b) => a + b, 0);
  const decided = (t.confirmed ?? 0) + (t.cancelled ?? 0) + (t.failed ?? 0);
  const c = calls[0]!, f = feedback[0]!;
  const period = (await db.query(`SELECT (current_date - ${days})::text AS from, current_date::text AS to`))[0]!;
  return {
    period: { days, from: period.from as string, to: period.to as string },
    conversations: { activeMembers: conv[0]!.members as number, activeGuests: conv[0]!.guests as number, memberMessages: conv[0]!.asked as number, replies: conv[0]!.replies as number },
    tasks: { proposed, confirmed: t.confirmed ?? 0, declined: t.cancelled ?? 0, failed: t.failed ?? 0, expired: t.superseded ?? 0, completionRate: decided ? (t.confirmed ?? 0) / decided : null },
    bookings: { experienceBookings: bookings[0]!.n as number, partnerRequests: partner[0]!.n as number, serviceRequests: service[0]!.n as number, plansBooked: plans[0]!.n as number, revenueMinor: Number(bookings[0]!.revenue), currency: 'ZAR' },
    escalations: { total: esc[0]!.total as number, open: esc[0]!.open as number, byStatus: escStatus.map((r) => ({ status: r.status as string, count: r.n as number })) },
    ai: {
      calls: c.calls as number, failed: c.failed as number, failureRate: (c.calls as number) ? (c.failed as number) / (c.calls as number) : null, fallbacks: fallbacks[0]!.n as number,
      avgLatencyMs: c.latency === null ? null : Math.round(Number(c.latency)), costUsd: usd(c.cost as string), todayCostUsd: usd(today[0]!.cost as string), capUsd: settings.dailyCostCapCents / 100,
      byProvider: byProvider.map((r) => ({ provider: r.provider as string, model: r.model as string, calls: r.calls as number, failed: r.failed as number, costUsd: usd(r.cost as string), avgLatencyMs: r.latency === null ? null : Math.round(Number(r.latency)) })),
    },
    satisfaction: { helpful: f.yes as number, notHelpful: f.no as number, score: (f.yes as number) + (f.no as number) ? (f.yes as number) / ((f.yes as number) + (f.no as number)) : null },
    tools: tools.filter((r) => r.tool).map((r) => ({ tool: r.tool as string, count: r.n as number })),
    answeredBy: answeredBy.map((r) => ({ model: r.model as string, count: r.n as number })),
    knowledge: { published: knowledge[0]!.published as number, drafts: knowledge[0]!.drafts as number, dueForReview: knowledge[0]!.due as number },
  };
}

export async function listModelCalls(db: Db, ctx: RequestContext, failedOnly: boolean): Promise<QeraModelCall[]> {
  requireStaff(ctx, 'admin.qera.manage');
  const rows = await db.query(`SELECT c.*, ${NAME} AS name FROM qera_model_calls c LEFT JOIN profiles p ON p.user_id = c.user_id LEFT JOIN guest_accounts g ON g.user_id = c.user_id
    ${failedOnly ? 'WHERE NOT c.ok' : ''} ORDER BY c.created_at DESC LIMIT 200`);
  return rows.map((r) => ({ id: r.id as string, at: iso(r.created_at)!, provider: r.provider as string, model: r.model as string, ok: Boolean(r.ok), error: (r.error as string) ?? null, latencyMs: Number(r.latency_ms), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), costUsd: usd(r.cost_micro as string), tool: (r.tool as string) ?? null, member: r.user_id ? (r.name as string) : null }));
}

export async function listEscalations(db: Db, ctx: RequestContext): Promise<QeraEscalation[]> {
  requireStaff(ctx, 'admin.qera.view');
  const rows = await db.query(`SELECT r.id, r.subject, r.category, r.status, r.created_at, ${NAME} AS member, coalesce(ap.full_name, au.email) AS assigned
    FROM concierge_requests r JOIN members mb ON mb.id = r.member_id LEFT JOIN profiles p ON p.user_id = mb.user_id LEFT JOIN guest_accounts g ON g.user_id = mb.user_id
    LEFT JOIN users au ON au.id = r.assigned_to LEFT JOIN profiles ap ON ap.user_id = r.assigned_to
    WHERE r.source = 'qera' AND r.market_id = $1 ORDER BY (r.status IN ('completed', 'cancelled')), r.created_at DESC LIMIT 200`, [ctx.marketId]);
  return rows.map((r) => ({ id: r.id as string, subject: r.subject as string, category: r.category as string, status: r.status as string, member: r.member as string, createdAt: iso(r.created_at)!, assignedTo: (r.assigned as string) ?? null }));
}

/** Who has spoken with QÉRA lately, with counts only. Nothing they said is shown here. */
export async function listConversations(db: Db, ctx: RequestContext): Promise<QeraConversationSummary[]> {
  requireStaff(ctx, 'admin.qera.manage');
  const rows = await db.query(`SELECT m.user_id, ${NAME} AS name, (g.user_id IS NOT NULL) AS guest, count(*)::int AS messages, max(m.created_at) AS last,
      (SELECT count(*)::int FROM qera_proposals q WHERE q.user_id = m.user_id) AS proposals,
      (SELECT count(*)::int FROM concierge_requests r JOIN members mb ON mb.id = r.member_id WHERE mb.user_id = m.user_id AND r.source = 'qera') AS escalations,
      (SELECT count(*)::int FROM qera_feedback f WHERE f.user_id = m.user_id AND NOT f.helpful) AS unhelpful
    FROM qera_messages m LEFT JOIN profiles p ON p.user_id = m.user_id LEFT JOIN guest_accounts g ON g.user_id = m.user_id
    GROUP BY m.user_id, p.full_name, g.full_name, g.user_id ORDER BY last DESC LIMIT 200`);
  return rows.map((r) => ({ userId: r.user_id as string, name: r.name as string, audience: r.guest ? 'guest' : 'member', messages: r.messages as number, lastAt: iso(r.last)!, proposals: r.proposals as number, escalations: r.escalations as number, notHelpful: r.unhelpful as number }));
}

/** One conversation, for an administrator investigating a problem. The reason is recorded before anything is shown. */
export async function readConversation(db: Db, ctx: RequestContext, userId: string, body: unknown): Promise<QeraConversationView> {
  const me = requireStaff(ctx, 'admin.qera.manage');
  const parsed = conversationReasonSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw notFound('That conversation could not be found.');
  const who = (await db.query(`SELECT ${NAME} AS name FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN guest_accounts g ON g.user_id = u.id WHERE u.id = $1`, [userId]))[0];
  if (!who) throw notFound('That conversation could not be found.');
  await audit(db, me, 'qera.conversation_read', 'user', userId, { reason: parsed.data.reason });
  const [messages, proposals] = await Promise.all([
    db.query(`SELECT m.id, m.role, m.body, m.created_at, m.model, m.channel, f.helpful FROM qera_messages m LEFT JOIN qera_feedback f ON f.message_id = m.id WHERE m.user_id = $1 ORDER BY m.created_at DESC, (m.role = 'member') ASC LIMIT 200`, [userId]),
    db.query(`SELECT id, tool, summary, status, created_at FROM qera_proposals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [userId]),
  ]);
  return {
    userId, name: who.name as string,
    messages: messages.reverse().map((m) => ({ id: m.id as string, role: m.role as 'member' | 'qera', text: redactForStaff(m.body as string), at: iso(m.created_at)!, model: (m.model as string) ?? null, via: (m.channel as string) ?? null, feedback: m.helpful === null || m.helpful === undefined ? null : Boolean(m.helpful) })),
    proposals: proposals.map((p) => ({ id: p.id as string, tool: p.tool as string, summary: redactForStaff(p.summary as string), status: p.status as string, at: iso(p.created_at)! })),
  };
}
