/**
 * The QÉRA model gateway. It implements the same `QeraModel` interface as the rule-based stand-in, so the rest of
 * QÉRA (tools, permissions, proposals, audit) is unchanged whichever model answers.
 *
 * For each step it:
 *  - reads the Control Centre settings (cached briefly): whether hosted models are on, which providers in which
 *    order, which model at each, the live prompt version, the autonomy level, the daily cost cap and the per-member
 *    hourly limit;
 *  - tries each configured provider in order, skipping any whose circuit is open after repeated failures;
 *  - checks the reply: a claim that something has been booked, confirmed or paid is refused, because no action is
 *    ever taken inside a turn (actions become proposals the member confirms);
 *  - records every call (provider, model, latency, tokens, estimated cost, outcome) without the member's words;
 *  - falls back to the rule-based model when hosted models are off, over budget, over the member's limit, or all
 *    failing, so QÉRA keeps working when every provider is down.
 */
import { z } from 'zod';
import { QERA_ARGS, QERA_TOOLS } from '@quintara/domain';
import type { QeraAudience, QeraHistoryItem, QeraModel, QeraResult, QeraStep, QeraToolName } from '@quintara/domain';
import type { Db } from '../db.ts';
import { costMicro } from './pricing.ts';
import { DEFAULT_QERA_PROMPT, qeraRules } from './prompt.ts';
import { PROVIDERS, ProviderError } from './providers.ts';
import type { LlmMessage, LlmProvider, LlmToolSpec, ProviderName } from './providers.ts';

export interface GatewaySettings {
  providerOrder: ProviderName[]; models: Partial<Record<ProviderName, string>>; llmEnabled: boolean; knowledgeEnabled: boolean; proactiveEnabled: boolean;
  autonomyLevel: number; dailyCostCapCents: number; memberHourlyLimit: number; escalateAboveMinor: number; prompt: { version: number; body: string };
}

const SETTINGS_TTL_MS = 15_000;
const CIRCUIT_FAILURES = 3, CIRCUIT_OPEN_MS = 60_000;
const UNSUPPORTED_CLAIM = /\b(i have|i've|i just|has been|have been|is now|are now|successfully)\s+(booked|reserved|confirmed|cancell?ed|paid|charged|purchased|ordered)\b|\byour (booking|reservation|table|order) is (confirmed|booked)\b/i;

/** Settings as stored, with the live prompt. */
export async function loadSettings(db: Db): Promise<GatewaySettings> {
  const row = (await db.query(`SELECT provider_order, models, llm_enabled, knowledge_enabled, proactive_enabled, autonomy_level, daily_cost_cap_cents, member_hourly_limit, escalate_above_minor FROM qera_settings`))[0]!;
  const live = (await db.query<{ version: number; body: string }>(`SELECT version, body FROM qera_prompt_versions WHERE is_live`))[0];
  return {
    providerOrder: (row.provider_order as string[]).filter((p): p is ProviderName => (PROVIDERS as readonly string[]).includes(p)),
    models: row.models as Partial<Record<ProviderName, string>>, llmEnabled: Boolean(row.llm_enabled), knowledgeEnabled: Boolean(row.knowledge_enabled), proactiveEnabled: Boolean(row.proactive_enabled),
    autonomyLevel: Number(row.autonomy_level), dailyCostCapCents: Number(row.daily_cost_cap_cents), memberHourlyLimit: Number(row.member_hourly_limit), escalateAboveMinor: Number(row.escalate_above_minor),
    prompt: live ? { version: Number(live.version), body: live.body } : { version: 0, body: DEFAULT_QERA_PROMPT },
  };
}

/** Tool descriptions and argument schemas as JSON Schema, from the same zod schemas that check every call. */
function toolSpecs(tools: QeraToolName[]): LlmToolSpec[] {
  return tools.map((name) => {
    const schema = z.toJSONSchema(QERA_ARGS[name], { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name, description: `${QERA_TOOLS[name].kind === 'action' ? '[Needs the member’s confirmation] ' : ''}${QERA_TOOLS[name].description}`, parameters: schema };
  });
}

/** What a tool returned, fenced as data. Long results are cut so one tool cannot flood the context. */
const asData = (name: string, data: unknown) => `<data tool="${name}">${JSON.stringify(data ?? null).replace(/<\/?data/gi, '‹data').slice(0, 12_000)}</data>`;

export interface GatewayOptions { now?: () => Date; timeoutMs?: number; maxTokens?: number }

export class GatewayQeraModel implements QeraModel {
  readonly name = 'gateway';
  private cached: { at: number; value: GatewaySettings } | null = null;
  private readonly failures = new Map<ProviderName, { count: number; openUntil: number }>();
  private readonly db: Db;
  private readonly providers: Partial<Record<ProviderName, LlmProvider>>;
  private readonly fallback: QeraModel;
  private readonly options: GatewayOptions;
  constructor(db: Db, providers: Partial<Record<ProviderName, LlmProvider>>, fallback: QeraModel, options: GatewayOptions = {}) { this.db = db; this.providers = providers; this.fallback = fallback; this.options = options; }

  /** Clears the settings cache: called when the Control Centre saves. */
  invalidate() { this.cached = null; }
  hasProviders() { return Object.keys(this.providers).length > 0; }
  configured(): ProviderName[] { return PROVIDERS.filter((p) => this.providers[p]); }

  async settings(): Promise<GatewaySettings> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > SETTINGS_TTL_MS) this.cached = { at: now, value: await loadSettings(this.db) };
    return this.cached.value;
  }

  /** The same model, bound to the person QÉRA is speaking with, so calls are recorded and limited per member. */
  forUser(userId: string): QeraModel & { lastModel: string } {
    const self = this;
    // Which model answered this member's most recent step, for the record on QÉRA's reply.
    // Once the rules have taken over in a turn (a provider failed, a reply was refused, the budget ran out), they finish it.
    const bound = { name: this.name, lastModel: '', async next(input: Parameters<QeraModel['next']>[0]) {
      if (bound.lastModel === 'rules') return self.fallback.next(input);
      const [step, model] = await self.step(userId, input);
      bound.lastModel = model;
      return step;
    } };
    return bound;
  }

  async next(input: Parameters<QeraModel['next']>[0]): Promise<QeraStep> { return (await this.step(null, input))[0]; }

  private async useFallback(input: Parameters<QeraModel['next']>[0]): Promise<[QeraStep, string]> { return [await this.fallback.next(input), 'rules']; }

  private async step(userId: string | null, input: { message: string; results: QeraResult[]; tools: QeraToolName[]; audience?: QeraAudience; history?: QeraHistoryItem[] }): Promise<[QeraStep, string]> {
    if (!this.hasProviders()) return this.useFallback(input);
    const s = await this.settings();
    if (!s.llmEnabled) return this.useFallback(input);
    if (await this.overBudget(s, userId)) return this.useFallback(input);

    const now = (this.options.now ?? (() => new Date()))();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).format(now);
    const system = `${s.prompt.body}\n${qeraRules(input.audience ?? 'member', today, s.autonomyLevel)}`;
    const messages: LlmMessage[] = [];
    for (const h of (input.history ?? []).slice(-12)) messages.push(h.role === 'member' ? { role: 'user', text: h.text } : { role: 'assistant', text: h.text });
    messages.push({ role: 'user', text: input.message });
    input.results.forEach((r, i) => {
      messages.push({ role: 'assistant', toolCall: { id: `call_${i + 1}`, name: r.name, args: r.args } });
      messages.push({ role: 'tool', id: `call_${i + 1}`, name: r.name, result: asData(r.name, r.data) });
    });
    // Providers want the conversation to alternate and to start with the member.
    while (messages.length && messages[0]!.role !== 'user') messages.shift();
    const tools = toolSpecs(input.tools);

    for (const provider of s.providerOrder) {
      const adapter = this.providers[provider];
      const model = s.models[provider];
      if (!adapter || !model || this.circuitOpen(provider)) continue;
      const started = Date.now();
      try {
        const out = await adapter.complete({ model, system, messages, tools, maxTokens: this.options.maxTokens ?? 800, timeoutMs: this.options.timeoutMs ?? 20_000 });
        const cost = costMicro(provider, model, out.inputTokens, out.outputTokens);
        const toolCall = out.toolCall && (out.toolCall.name in QERA_TOOLS) ? { name: out.toolCall.name as QeraToolName, args: out.toolCall.args } : undefined;
        // A reply claiming something was done, when nothing is ever done inside a turn, is not passed on.
        if (!toolCall && out.text && UNSUPPORTED_CLAIM.test(out.text)) {
          await this.record(userId, provider, model, false, 'unsupported_claim', Date.now() - started, out, cost, null);
          return this.useFallback(input);
        }
        await this.record(userId, provider, model, true, null, Date.now() - started, out, cost, toolCall?.name ?? null);
        this.failures.delete(provider);
        const used = `${provider}:${model}`;
        if (toolCall) return [{ toolCall }, used];
        if (out.toolCall) return [{ reply: 'That is not something I can do for you.' }, used];
        return [{ reply: out.text || 'Forgive me, I did not catch that. Could you say it another way?' }, used];
      } catch (error) {
        const f = this.failures.get(provider) ?? { count: 0, openUntil: 0 };
        f.count += 1;
        if (f.count >= CIRCUIT_FAILURES) f.openUntil = Date.now() + CIRCUIT_OPEN_MS;
        this.failures.set(provider, f);
        await this.record(userId, provider, model, false, error instanceof ProviderError ? error.message : 'unexpected error', Date.now() - started, null, 0, null);
      }
    }
    return this.useFallback(input);
  }

  private circuitOpen(provider: ProviderName) {
    const f = this.failures.get(provider);
    if (!f || f.openUntil === 0) return false;
    if (Date.now() < f.openUntil) return true;
    this.failures.set(provider, { count: CIRCUIT_FAILURES - 1, openUntil: 0 });   // half-open: one more failure re-opens it
    return false;
  }

  private async overBudget(s: GatewaySettings, userId: string | null): Promise<boolean> {
    const spent = (await this.db.query<{ total: string }>(`SELECT coalesce(sum(cost_micro), 0)::text AS total FROM qera_model_calls WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg'`))[0]!.total;
    if (Number(spent) >= s.dailyCostCapCents * 100) return true;
    if (!userId) return false;
    const calls = (await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM qera_model_calls WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [userId]))[0]!.n;
    return calls >= s.memberHourlyLimit;
  }

  private async record(userId: string | null, provider: ProviderName, model: string, ok: boolean, error: string | null, latencyMs: number, out: { inputTokens: number; outputTokens: number } | null, cost: number, tool: string | null) {
    await this.db.query(`INSERT INTO qera_model_calls (user_id, provider, model, ok, error, latency_ms, input_tokens, output_tokens, cost_micro, tool) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [userId, provider, model, ok, error, latencyMs, out?.inputTokens ?? 0, out?.outputTokens ?? 0, cost, tool]).catch(() => undefined);
  }
}
