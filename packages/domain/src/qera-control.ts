/**
 * The QÉRA Control Centre: what the admin console shows about QÉRA and what administrators may change.
 * Shared by the API (which validates with these schemas) and the admin app.
 */
import { z } from 'zod';

export const QERA_PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;
export type QeraProviderName = (typeof QERA_PROVIDERS)[number];
export const QERA_PROVIDER_LABEL: Record<QeraProviderName, string> = { anthropic: 'Anthropic Claude', openai: 'OpenAI', gemini: 'Google Gemini' };

export const QERA_AUTONOMY = {
  1: { label: 'Informational', detail: 'QÉRA answers, explains and recommends. The only thing it proposes is handing a request to the Lifestyle Curator.' },
  2: { label: 'Assisted planning', detail: 'QÉRA also prepares plans and documents. Members book themselves, or through the Lifestyle Curator.' },
  3: { label: 'Approval-based execution', detail: 'QÉRA proposes bookings and requests, and carries them out only after the member confirms each one.' },
  4: { label: 'Limited delegated automation', detail: 'Standing instructions within spending limits. Not yet offered: it needs the payment provider and a legal review.' },
} as const;

export const KNOWLEDGE_TOPICS = ['membership', 'experiences', 'lifestyle', 'concierge', 'maison', 'policies', 'cancellations', 'faq', 'partners', 'other'] as const;
export type KnowledgeTopic = (typeof KNOWLEDGE_TOPICS)[number];
export const KNOWLEDGE_AUDIENCES = ['public', 'member', 'staff'] as const;
export type KnowledgeAudience = (typeof KNOWLEDGE_AUDIENCES)[number];
export const KNOWLEDGE_AUDIENCE_LABEL: Record<KnowledgeAudience, string> = { public: 'Guests and members', member: 'Members only', staff: 'Staff only (QÉRA never sees it)' };

export interface QeraSettingsView {
  providerOrder: QeraProviderName[];
  models: Partial<Record<QeraProviderName, string>>;
  /** Providers with a key on the server. Keys themselves are never sent to the console. */
  configured: QeraProviderName[];
  llmEnabled: boolean; knowledgeEnabled: boolean; proactiveEnabled: boolean;
  autonomyLevel: 1 | 2 | 3;
  dailyCostCapCents: number; memberHourlyLimit: number; escalateAboveMinor: number;
  livePromptVersion: number;
  updatedAt: string; updatedBy: string | null;
}

export const qeraSettingsSchema = z.object({
  providerOrder: z.array(z.enum(QERA_PROVIDERS)).min(1).max(3).refine((list) => new Set(list).size === list.length, 'Each provider once'),
  models: z.partialRecord(z.enum(QERA_PROVIDERS), z.string().trim().regex(/^[a-zA-Z0-9._:\-/]{2,80}$/, 'A model name as the provider writes it')),
  llmEnabled: z.boolean(), knowledgeEnabled: z.boolean(), proactiveEnabled: z.boolean(),
  autonomyLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  dailyCostCapCents: z.number().int().min(0).max(10_000_000),
  memberHourlyLimit: z.number().int().min(1).max(1000),
  escalateAboveMinor: z.number().int().min(0).max(1_000_000_000),
});
export type QeraSettingsInput = z.infer<typeof qeraSettingsSchema>;

export interface QeraPromptVersion { id: string; version: number; body: string; note: string; isLive: boolean; createdAt: string; createdBy: string | null }
export const qeraPromptSchema = z.object({ body: z.string().trim().min(50).max(20_000), note: z.string().trim().max(300).default('') });

export interface QeraKnowledgeEntry {
  id: string; topic: KnowledgeTopic; title: string; body: string; audience: KnowledgeAudience; status: 'draft' | 'published' | 'archived';
  version: number; reviewBy: string | null; marketId: string | null; updatedAt: string; updatedBy: string | null;
  /** True once `reviewBy` has passed: someone should check it is still right. */
  dueForReview: boolean;
}
export const qeraKnowledgeSchema = z.object({
  topic: z.enum(KNOWLEDGE_TOPICS), title: z.string().trim().min(3).max(160), body: z.string().trim().min(10).max(20_000),
  audience: z.enum(KNOWLEDGE_AUDIENCES).default('member'), status: z.enum(['draft', 'published', 'archived']).default('draft'),
  reviewBy: z.iso.date().nullable().default(null), allMarkets: z.boolean().default(true),
});
export type QeraKnowledgeInput = z.input<typeof qeraKnowledgeSchema>;

export interface QeraDashboard {
  period: { days: number; from: string; to: string };
  conversations: { activeMembers: number; activeGuests: number; memberMessages: number; replies: number };
  tasks: { proposed: number; confirmed: number; declined: number; failed: number; expired: number; completionRate: number | null };
  bookings: { experienceBookings: number; partnerRequests: number; serviceRequests: number; plansBooked: number; revenueMinor: number; currency: string };
  escalations: { total: number; open: number; byStatus: { status: string; count: number }[] };
  ai: { calls: number; failed: number; failureRate: number | null; fallbacks: number; avgLatencyMs: number | null; costUsd: number; todayCostUsd: number; capUsd: number; byProvider: { provider: string; model: string; calls: number; failed: number; costUsd: number; avgLatencyMs: number | null }[] };
  satisfaction: { helpful: number; notHelpful: number; score: number | null };
  tools: { tool: string; count: number }[];
  /** Answered by the built-in rules (hosted models off, over budget or unavailable) or by a hosted model. */
  answeredBy: { model: string; count: number }[];
  knowledge: { published: number; drafts: number; dueForReview: number };
}

export interface QeraModelCall { id: string; at: string; provider: string; model: string; ok: boolean; error: string | null; latencyMs: number; inputTokens: number; outputTokens: number; costUsd: number; tool: string | null; member: string | null }

/** A conversation as listed for review: who, how much, and nothing of what was said. */
export interface QeraConversationSummary { userId: string; name: string; audience: 'member' | 'guest'; messages: number; lastAt: string; proposals: number; escalations: number; notHelpful: number }
/** One conversation, opened by an administrator with a stated reason (written to the audit log). */
export interface QeraConversationView { userId: string; name: string; messages: { id: string; role: 'member' | 'qera'; text: string; at: string; model: string | null; via: string | null; feedback: boolean | null }[]; proposals: { id: string; tool: string; summary: string; status: string; at: string }[] }
export const conversationReasonSchema = z.object({ reason: z.string().trim().min(10, 'Say why you need to read it (at least 10 characters)').max(300) });

export interface QeraEscalation { id: string; subject: string; category: string; status: string; member: string; createdAt: string; assignedTo: string | null }

export const qeraFeedbackSchema = z.object({ helpful: z.boolean(), comment: z.string().trim().max(500).default('') });

/** Card text and similar personal data patterns are hidden when staff read a conversation. */
export function redactForStaff(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card number hidden]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email hidden]')
    // Nine or more digits in a phone-like run; ISO dates (2026-11-20) are left alone.
    .replace(/\+?\d[\d ()-]{7,}\d/g, (m) => (/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) || m.replace(/\D/g, '').length < 9 ? m : '[phone hidden]'));
}
