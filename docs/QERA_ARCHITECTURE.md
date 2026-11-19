# QÉRA: architecture, gap analysis and risk register

QÉRA is the Quintara Intelligence: each member's Chief of Staff and lifestyle concierge. This document assesses what
was already in the repository against the QÉRA master brief, records what the **Intelligence Core** phase (migration
0040) added, and lists what is still outstanding before launch.

## 1. What already existed (repository audit, November 2026)

The platform is a pnpm/Turborepo monorepo: a Fastify API on PostgreSQL (PGlite in development and tests), Next.js 16
web, admin and Maison Quintara apps, an Expo 57 mobile app, and shared `domain`, `api-client`, `app-core` and
`design-tokens` packages. Every screen talks to the `QuintaraApi` contract, implemented by the real API and by an
in-browser mock that applies the same rules.

QÉRA was already a safe, tool-based agent:

| Brief requirement | State before this phase |
|---|---|
| Agent orchestration (§5.2) | `qeraTurn` in `packages/domain/src/qera.ts`: up to six steps of read tools, then one answer or one proposal. |
| Permission-scoped tools, confirmation checkpoints (§7) | 22 tools, each bound to a member permission. Read tools run at once; action tools become a proposal written from the real record, confirmed by the member, claimed atomically (no double execution), audited. |
| Deterministic transactions (§5.2, §7) | Bookings, cancellations, refunds and payments run through the same module functions as the app's own screens (row locks, capacity, idempotency keys on payments). The model never touches the database or payments. |
| Memory engine (§5.3) | Opt-in memory (dietary, likes, favourites, dates, people, notes); members see, edit and erase it; included in data export and erasure. |
| Chief of Staff (§6) | Weekly brief, daily brief from the member's calendar, reminders, itineraries as branded documents, booking a whole plan in one confirmation, service packages with lead times. |
| Experiences, Lifestyle, Concierge, Boutique (§6.2–6.4) | Experiences and partner/service bookings through QÉRA; escalation to the Lifestyle Curator (Ms. Palesa Makam). Maison Quintara is browsable; QÉRA does not add to a cart (see §6 below). |
| Networking (§6.6) | Suggestions and connection requests, consent on both sides; contact details never shown. |
| Omnichannel (§10) | WhatsApp Cloud API: one conversation across app and WhatsApp, signed webhooks, linked numbers. |
| Guests | Read-only QÉRA for guest accounts, five hours a day. |
| Security (§13) | RBAC, 2FA for staff, hashed session tokens, append-only sealed audit log, POPIA export and erasure. |

**The gaps against the brief** were: no hosted model (only `RuleBasedQeraModel`), no model gateway, fallback, cost
tracking or rate limit per member; no knowledge base or retrieval; no autonomy levels; no prompt versioning; no
QÉRA section in the admin console (dashboard, configuration, knowledge, conversation review); no member feedback; no
attribution of bookings and revenue to QÉRA.

## 2. What the Intelligence Core phase added

```text
member (web / mobile / WhatsApp)
   │  POST /v1/qera/messages
   ▼
qera.sendMessage ── history (last 12) ── Control Centre settings (autonomy, knowledge on/off, escalation amount)
   │
   ▼
qeraTurn (domain) ── tools offered = member permissions ∩ autonomy level ∩ settings
   │       ▲  each step
   ▼       │
GatewayQeraModel ──► provider 1 ─fail─► provider 2 ─fail─► provider 3 ─fail─► RuleBasedQeraModel
   │  (Anthropic / OpenAI / Gemini adapters, no SDKs)          ▲
   │  off · over daily budget · over member's hourly limit ─────┘
   │  reply claiming "booked/confirmed/paid" → refused → rules
   ▼
qera_model_calls (provider, model, latency, tokens, cost; never the member's words)
```

| Area | Where |
|---|---|
| Provider adapters (Anthropic Messages, OpenAI Chat Completions, Gemini generateContent), tool calling, timeouts | `apps/api/src/qera-gateway/providers.ts` |
| Gateway: settings cache, provider order, circuit breaker, fallback, cost cap, per-member hourly limit, unsupported-claim guard, call log | `apps/api/src/qera-gateway/model.ts` |
| Estimated prices (to verify before production) | `apps/api/src/qera-gateway/pricing.ts` |
| Built-in prompt and the non-editable safety rules appended to every prompt | `apps/api/src/qera-gateway/prompt.ts` |
| Knowledge base with full-text retrieval, audiences (public, members, staff-only), drafts, versions, review dates | `apps/api/src/qera-control.ts`, tool `search_knowledge` |
| Autonomy levels 1–3 (level 4 shown, not offered) and an escalation amount | `qera.ts` `toolbox()` policy; `QERA_AUTONOMY` in domain |
| Member feedback on replies (web and mobile) | `POST /v1/qera/messages/:id/feedback`; `rateQeraReply` |
| Bookings attributed to QÉRA (`experience_bookings.source`), referrals marked `source = 'qera'` | migration 0040, `qera.ts`, `chief.ts`, `concierge.ts` |
| QÉRA Control Centre (admin console): Overview, Referred to the Curator, Knowledge, Configuration (models, order, autonomy, budget, limits, prompt versions with rollback), Model calls, Conversations (reason required, audited, redacted) | `apps/admin/src/app/qera/page.tsx`, `/admin/v1/qera/*` |
| Staff permissions `admin.qera.view` (admin and desk) and `admin.qera.manage` (admin only) | `packages/domain/src/index.ts` |
| Tests: 20 scenarios, scripted providers, no network | `apps/api/test/qera-intelligence.test.ts` |

Hosted models are **off by default**. With no keys, or with the switch off, QÉRA behaves exactly as before.

### Why no LangGraph

The brief asks to evaluate LangGraph or similar. QÉRA's loop is small (≤ 6 steps, one proposal) and already lives in
shared TypeScript used by both the API and the offline mock; its state is the database (messages, proposals,
memory, documents). A Python graph runtime would split that logic across two languages and lose the mock. Revisit
when QÉRA needs long-running multi-day tasks with waits on partners, at which point a durable workflow engine
(Temporal or a Postgres job queue) fits better than a graph library.

## 3. Safety model

1. **The model has no powers.** It can only ask for a tool that the member's permissions, the autonomy level and the
   settings allow; arguments are checked against zod schemas; actions become proposals written by the tool from the
   real record; the member confirms; the action runs again through every normal check. A proposal made before the
   autonomy level was lowered is not carried out.
2. **Untrusted content is fenced.** Tool results and knowledge passages reach the model inside `<data>` tags, cut
   to 12 000 characters, and the non-editable rules tell it never to follow instructions found there.
3. **No false confirmations.** Inside a turn nothing is ever executed, so a hosted-model reply claiming something was
   booked, confirmed, cancelled or paid is refused and the built-in rules answer instead (logged as
   `unsupported_claim`).
4. **Least data.** The model sees the member's message, the last 12 messages of their own thread and what tools return
   for that member. Card data never exists in Quintara. Call logs keep no message text.
5. **Staff access.** Conversations are listed by counts only. Reading one needs `admin.qera.manage`, a reason of at
   least 10 characters, writes `qera.conversation_read` to the sealed audit log, and hides card numbers, email
   addresses and phone numbers.
6. **Availability.** Provider failures open a circuit for 60 seconds after three failures; the next provider or the
   rules answer. The daily budget and the per-member hourly limit also fall back to the rules, so QÉRA never stops.

## 4. Risk register

| # | Risk | Likelihood | Impact | Mitigation in place | Still to do |
|---|---|---|---|---|---|
| R1 | Hosted model invents availability, prices or confirmations | Medium | High | Answers only from tools; unsupported-claim guard; proposals worded by tools | Run the evaluation set (§7) per model before enabling; review "Not helpful" replies weekly |
| R2 | Prompt injection via knowledge entries, partner text, member profiles or WhatsApp | Medium | High | Data fencing; rules not editable; actions need confirmation; tests | Red-team set in the evaluation; restrict who edits partner text |
| R3 | Cross-member data exposure | Low | Critical | Tools bound to the signed-in member; isolation tests | Penetration test (RELEASE item 21) |
| R4 | Cross-border transfer of personal information to model providers (POPIA s72, GDPR) | High once enabled | High | Off by default; minimal data; no call text stored | **Legal review**; DPAs; choose regions; update privacy policy to name processors |
| R5 | Runaway cost | Medium | Medium | Daily cap; per-member hourly limit; cost per call logged | Confirm prices; alerting when 80% of the cap is used |
| R6 | Provider outage or deprecation of a model name | Medium | Low | Fallback chain; model names editable without code | Monitor deprecation notices |
| R7 | Wrong or stale knowledge | Medium | Medium | Drafts, versions, review dates, "due for review" count | Assign owners per topic |
| R8 | Staff misuse of conversation access | Low | High | Reason + audit + redaction; admin only | Quarterly audit review by the Information Officer |
| R9 | Duplicate bookings from double confirmation | Low | Medium | Atomic claim of proposals; one live booking per member per experience | Idempotency keys on bookings (README) |
| R10 | In-process limits and circuit state with several API servers | Medium | Low | Works per process | Move limits and circuit state to Redis (RELEASE item 16) |

## 5. Compliance notes (for professional review)

Technical controls are not legal compliance. Before hosted models are turned on, Quintara's legal adviser should
review: lawful basis and notice for processing members' messages with each provider; cross-border transfer
safeguards (POPIA section 72; GDPR Chapter V for European members); the processors list in the privacy policy;
retention of QÉRA messages (currently kept until the member clears the conversation or erases their account) and of
model call logs; and the wording members see about automated assistance.

## 6. Outstanding against the brief

| Brief item | Status | Blocker |
|---|---|---|
| Hosted models in production | Ready to switch on | Provider keys, DPAs, legal review, evaluation run |
| Vector (semantic) retrieval | Full-text retrieval in place | Add `pgvector` and an embeddings provider when the knowledge base passes a few hundred entries |
| Document upload into the knowledge base (PDF, Word) | Entries are typed or pasted | Add extraction (the admin already uploads images through `MediaStore`) |
| Maison Quintara via QÉRA (cart, checkout) | Not started | Payment provider (RELEASE item 4); QÉRA will only ever prepare a cart and hand over to the provider's hosted checkout |
| Level 4 delegated automation | Shown, disabled | Payment provider with saved tokens, spending limits, legal review |
| Voice (speech-to-text, text-to-speech) | Not started | Provider choice; explicit microphone permission; no always-on recording |
| Languages beyond English | Hosted models can answer in the member's language; UI is English | Translation of the apps |
| Proactive recommendations beyond the weekly brief | Weekly/daily briefs and reminders exist | Opt-in notification preferences and frequency limits per category |
| Meta Muse connector | Not started | Meta has not published a general connector programme; QÉRA's tools are the natural connector surface once one exists |
| Real-time streaming of replies | Not started | Server-sent events on `/v1/qera/messages` |

## 7. Before turning hosted models on

1. Set one provider key and the model name in the Control Centre; leave hosted models off.
2. Add the knowledge entries: membership policy, cancellation and refund rules, guest policy, dress codes, FAQ.
3. Build an evaluation set of 200–300 real requests (bookings, plans, policy questions, out-of-scope requests,
   injection attempts, guests asking to book) with the expected tool or answer, and run it against the provider with
   the scripted harness in `apps/api/test/qera-intelligence.test.ts` as the pattern. Acceptance: ≥ 95% correct tool
   choice, 0 false confirmations, 0 data leaks, 100% injection resistance, median response under 4 s.
4. Turn hosted models on for staff test accounts, then for all members, watching the Overview and Model calls.

## 8. Deployment readiness

Ready: the gateway, knowledge base, Control Centre, feedback and attribution, with tests. Not ready for hosted models
in production until §5 and §7 are done. QÉRA on the built-in rules remains production-ready as before, subject to
the platform's own pending items in docs/RELEASE.md.
