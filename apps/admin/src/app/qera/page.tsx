'use client';

/**
 * The QÉRA Control Centre: how QÉRA, the members' Chief of Staff, is doing and how it runs.
 *
 * Everyone with access sees the dashboard, the requests QÉRA handed to the Lifestyle Curator, and the knowledge it
 * answers from. Administrators also change its settings and prompt, edit its knowledge, review the hosted-model call
 * log, and (with a stated reason, written to the audit log) read a member's conversation with private details hidden.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { QeraConversationView, QeraDashboard, QeraKnowledgeEntry, QeraKnowledgeInput, QeraPromptVersion, QeraSettingsInput, QeraSettingsView } from '@quintara/domain';
import { KNOWLEDGE_AUDIENCE_LABEL, KNOWLEDGE_AUDIENCES, KNOWLEDGE_TOPICS, QERA_AUTONOMY, QERA_PROVIDER_LABEL, QERA_PROVIDERS } from '@quintara/domain';
import { toApiError } from '@quintara/api-client';
import { fmtDate, fmtMoney, Loaded, useAdmin, useCan, useLoad, useRun } from '@/lib/admin';

type Tab = 'overview' | 'escalations' | 'knowledge' | 'configuration' | 'calls' | 'conversations';
const pct = (x: number | null) => (x === null ? 'Not yet' : `${Math.round(x * 100)}%`);
const dollars = (x: number) => `US$${x < 10 ? x.toFixed(2) : Math.round(x).toLocaleString('en-ZA')}`;
const words = (key: string) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export default function QeraControlCentre() {
  const manage = useCan('admin.qera.manage');
  const [tab, setTab] = useState<Tab>('overview');
  const tabs: [Tab, string][] = [['overview', 'Overview'], ['escalations', 'Referred to the Curator'], ['knowledge', 'Knowledge'],
    ...(manage ? [['configuration', 'Configuration'], ['calls', 'Model calls'], ['conversations', 'Conversations']] as [Tab, string][] : [])];
  return (
    <>
      <div>
        <h1>QÉRA Control Centre</h1>
        <p className="lede">QÉRA is each member&rsquo;s Chief of Staff. Here you can see what it is doing for members, what it hands to people, what it costs, and how it is set up. It never acts for a member without their confirmation.</p>
      </div>
      <div className="periods" role="tablist" aria-label="Sections">
        <div className="seg">{tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
      </div>
      {tab === 'overview' ? <Overview /> : null}
      {tab === 'escalations' ? <Escalations /> : null}
      {tab === 'knowledge' ? <Knowledge editable={manage} /> : null}
      {tab === 'configuration' && manage ? <Configuration /> : null}
      {tab === 'calls' && manage ? <ModelCalls /> : null}
      {tab === 'conversations' && manage ? <Conversations /> : null}
    </>
  );
}

/* ---------- Overview ---------- */

function Overview() {
  const [days, setDays] = useState(30);
  const state = useLoad((api) => api.getQeraDashboard(days), [days]);
  return (
    <>
      <div className="periods" role="group" aria-label="Period">
        <div className="seg">{[7, 30, 90, 365].map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d === 365 ? '12 months' : `${d} days`}</button>)}</div>
      </div>
      <Loaded state={state}>{(d) => <DashboardView d={d} />}</Loaded>
    </>
  );
}

function Tile({ k, v, d }: { k: string; v: string | number; d?: string }) {
  return <div className="tile"><span className="k">{k}</span><span className="v">{v}</span>{d ? <span className="d">{d}</span> : null}</div>;
}

function DashboardView({ d }: { d: QeraDashboard }) {
  const hosted = d.answeredBy.filter((a) => a.model !== 'rules').reduce((n, a) => n + a.count, 0);
  const total = d.answeredBy.reduce((n, a) => n + a.count, 0);
  return (
    <div style={{ display: 'grid', gap: 26 }}>
      <p className="muted" style={{ margin: 0 }}>{d.period.from} to {d.period.to}.</p>
      <section>
        <h2>Members and requests</h2>
        <div className="tiles" style={{ marginTop: 12 }}>
          <Tile k="Members" v={d.conversations.activeMembers} d={`and ${d.conversations.activeGuests} guest${d.conversations.activeGuests === 1 ? '' : 's'}`} />
          <Tile k="Requests" v={d.conversations.memberMessages} d={`${d.conversations.replies} replies`} />
          <Tile k="Actions proposed" v={d.tasks.proposed} d={`${d.tasks.confirmed} confirmed, ${d.tasks.declined} declined`} />
          <Tile k="Completion" v={pct(d.tasks.completionRate)} d="Confirmed, of those decided" />
          <Tile k="Failed actions" v={d.tasks.failed} d="Confirmed but could not be done" />
          <Tile k="Satisfaction" v={pct(d.satisfaction.score)} d={`${d.satisfaction.helpful} helpful, ${d.satisfaction.notHelpful} not`} />
        </div>
      </section>
      <section>
        <h2>Bookings and handovers</h2>
        <div className="tiles" style={{ marginTop: 12 }}>
          <Tile k="Experience bookings" v={d.bookings.experienceBookings} d="Made by QÉRA after confirmation" />
          <Tile k="Revenue" v={d.bookings.revenueMinor ? fmtMoney(d.bookings.revenueMinor, d.bookings.currency) : 'R0'} d="Confirmed experience bookings" />
          <Tile k="Partner bookings" v={d.bookings.partnerRequests} d="Sent to partners" />
          <Tile k="Service requests" v={d.bookings.serviceRequests} />
          <Tile k="Whole plans booked" v={d.bookings.plansBooked} />
          <Tile k="Referred to the Curator" v={d.escalations.total} d={`${d.escalations.open} still open`} />
        </div>
      </section>
      <section>
        <h2>Intelligence and cost</h2>
        <div className="tiles" style={{ marginTop: 12 }}>
          <Tile k="Hosted model answers" v={total ? pct(hosted / total) : 'Not yet'} d={`${total - hosted} by QÉRA's built-in rules`} />
          <Tile k="Model calls" v={d.ai.calls} d={`${d.ai.failed} failed (${pct(d.ai.failureRate)})`} />
          <Tile k="Response time" v={d.ai.avgLatencyMs === null ? 'Not yet' : `${(d.ai.avgLatencyMs / 1000).toFixed(1)} s`} d="Average per model call" />
          <Tile k="Model cost" v={dollars(d.ai.costUsd)} d="Estimated, this period" />
          <Tile k="Today" v={dollars(d.ai.todayCostUsd)} d={`Daily cap ${dollars(d.ai.capUsd)}`} />
          <Tile k="Knowledge" v={d.knowledge.published} d={`${d.knowledge.drafts} drafts, ${d.knowledge.dueForReview} due for review`} />
        </div>
      </section>
      <section className="two">
        <div><h2>What QÉRA was asked to do</h2><Bars rows={d.tools.map((t) => [words(t.tool), t.count])} empty="No requests in this period." /></div>
        <div>
          <h2>By model</h2>
          {d.ai.byProvider.length ? (
            <div className="panel scroll"><table style={{ minWidth: 0 }}>
              <thead><tr><th>Model</th><th>Calls</th><th>Failed</th><th>Avg</th><th>Cost</th></tr></thead>
              <tbody>{d.ai.byProvider.map((p) => <tr key={p.provider + p.model}><td>{p.model}<small>{QERA_PROVIDER_LABEL[p.provider as keyof typeof QERA_PROVIDER_LABEL] ?? p.provider}</small></td><td>{p.calls}</td><td>{p.failed}</td><td>{p.avgLatencyMs === null ? '–' : `${(p.avgLatencyMs / 1000).toFixed(1)} s`}</td><td>{dollars(p.costUsd)}</td></tr>)}</tbody>
            </table></div>
          ) : <p className="muted">No hosted model has been called in this period. QÉRA answered from its built-in rules.</p>}
        </div>
      </section>
    </div>
  );
}

function Bars({ rows, empty }: { rows: [string, number][]; empty: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  const top = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div className="panel" style={{ display: 'grid', gap: 12 }}>
      {rows.map(([name, value]) => (
        <div key={name}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{name}</span><span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span></div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--q-track)', marginTop: 6 }}><div style={{ height: 6, borderRadius: 3, background: 'var(--q-accent)', width: `${Math.round((value / top) * 100)}%`, minWidth: 4 }} /></div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Escalations ---------- */

function Escalations() {
  const state = useLoad((api) => api.listQeraEscalations());
  return (
    <Loaded state={state}>
      {(list) => list.length ? (
        <div className="scroll"><table>
          <thead><tr><th>Request</th><th>Member</th><th>Status</th><th>Assigned</th><th>Received</th></tr></thead>
          <tbody>{list.map((e) => (
            <tr key={e.id}>
              <td><Link href={`/concierge/${e.id}`}>{e.subject}</Link><small>{words(e.category)}</small></td>
              <td>{e.member}</td>
              <td><span className={`chip ${['completed', 'confirmed'].includes(e.status) ? 'ok' : e.status === 'requested' ? 'gold' : ''}`}>{words(e.status)}</span></td>
              <td>{e.assignedTo ?? <span className="muted">Not yet</span>}</td>
              <td>{fmtDate(e.createdAt)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p className="muted">QÉRA has not referred anything to the Lifestyle Curator in this city.</p>}
    </Loaded>
  );
}

/* ---------- Knowledge ---------- */

const EMPTY_ENTRY: QeraKnowledgeInput = { topic: 'faq', title: '', body: '', audience: 'member', status: 'draft', reviewBy: null, allMarkets: true };

function Knowledge({ editable }: { editable: boolean }) {
  const state = useLoad((api) => api.listQeraKnowledge());
  const [editing, setEditing] = useState<{ id: string | null; input: QeraKnowledgeInput } | null>(null);
  const [filter, setFilter] = useState<'all' | 'published' | 'draft' | 'archived' | 'due'>('all');
  return (
    <>
      <p className="note">QÉRA answers questions about policies and services from the published entries here. Entries for &ldquo;Guests and members&rdquo; can be told to guests; &ldquo;Members only&rdquo; are not. Staff-only entries are kept for the team and QÉRA never reads them. Text in an entry is treated as information: instructions written into it are not followed.</p>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <select className="small" value={filter} aria-label="Show" onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">Everything</option><option value="published">Published</option><option value="draft">Drafts</option><option value="archived">Archived</option><option value="due">Due for review</option>
        </select>
        {editable ? <button className="btn" onClick={() => setEditing({ id: null, input: EMPTY_ENTRY })}>Add an entry</button> : null}
      </div>
      {editing ? <KnowledgeEditor key={editing.id ?? 'new'} id={editing.id} initial={editing.input} onDone={() => { setEditing(null); state.reload(); }} onCancel={() => setEditing(null)} /> : null}
      <Loaded state={state}>
        {(list) => {
          const shown = list.filter((k) => filter === 'all' || (filter === 'due' ? k.dueForReview : k.status === filter));
          return shown.length ? (
            <div className="scroll"><table>
              <thead><tr><th>Entry</th><th>Topic</th><th>Who may be told</th><th>Status</th><th>Updated</th>{editable ? <th /> : null}</tr></thead>
              <tbody>{shown.map((k) => (
                <tr key={k.id}>
                  <td>{k.title}<small>{k.body.slice(0, 110)}{k.body.length > 110 ? '…' : ''}</small></td>
                  <td>{words(k.topic)}</td>
                  <td>{KNOWLEDGE_AUDIENCE_LABEL[k.audience]}</td>
                  <td><span className={`chip ${k.status === 'published' ? 'ok' : ''}`}>{words(k.status)}</span>{k.dueForReview ? <> <span className="chip gold">Review</span></> : null}</td>
                  <td>{fmtDate(k.updatedAt)}<small>Version {k.version}{k.updatedBy ? `, ${k.updatedBy}` : ''}</small></td>
                  {editable ? <td><button className="link" onClick={() => setEditing({ id: k.id, input: entryInput(k) })}>Edit</button></td> : null}
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p className="muted">{list.length ? 'Nothing matches.' : 'No entries yet. Add the membership policy, the cancellation and refund rules and the questions members ask most.'}</p>;
        }}
      </Loaded>
    </>
  );
}

const entryInput = (k: QeraKnowledgeEntry): QeraKnowledgeInput => ({ topic: k.topic, title: k.title, body: k.body, audience: k.audience, status: k.status, reviewBy: k.reviewBy, allMarkets: k.marketId === null });

function KnowledgeEditor({ id, initial, onDone, onCancel }: { id: string | null; initial: QeraKnowledgeInput; onDone: () => void; onCancel: () => void }) {
  const { api } = useAdmin();
  const [v, setV] = useState(initial);
  const { run, pending, error } = useRun();
  const save = (event: FormEvent) => { event.preventDefault(); void run(() => (id ? api.updateQeraKnowledge(id, v) : api.createQeraKnowledge(v)), onDone); };
  return (
    <form className="panel" onSubmit={save} aria-label={id ? 'Edit entry' : 'New entry'}>
      <h2>{id ? 'Edit entry' : 'New entry'}</h2>
      <label>Title<input required minLength={3} maxLength={160} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></label>
      <label>Text QÉRA may use<textarea required minLength={10} maxLength={20000} rows={8} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} /></label>
      <div className="row">
        <label>Topic<select value={v.topic} onChange={(e) => setV({ ...v, topic: e.target.value as QeraKnowledgeInput['topic'] })}>{KNOWLEDGE_TOPICS.map((t) => <option key={t} value={t}>{words(t)}</option>)}</select></label>
        <label>Who may be told<select value={v.audience} onChange={(e) => setV({ ...v, audience: e.target.value as QeraKnowledgeInput['audience'] })}>{KNOWLEDGE_AUDIENCES.map((a) => <option key={a} value={a}>{KNOWLEDGE_AUDIENCE_LABEL[a]}</option>)}</select></label>
        <label>Status<select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value as QeraKnowledgeInput['status'] })}><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label>
        <label>Check again by<input type="date" value={v.reviewBy ?? ''} onChange={(e) => setV({ ...v, reviewBy: e.target.value || null })} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={v.allMarkets ?? true} onChange={(e) => setV({ ...v, allMarkets: e.target.checked })} />Applies in every city (otherwise only the city you are working in)</label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row">
        <button className="btn" disabled={pending}>{pending ? 'Saving' : 'Save'}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        {id ? <button type="button" className="link" disabled={pending} onClick={() => { if (window.confirm('Delete this entry? QÉRA will stop using it at once.')) void run(() => api.deleteQeraKnowledge(id), onDone); }}>Delete</button> : null}
      </div>
    </form>
  );
}

/* ---------- Configuration ---------- */

function Configuration() {
  const settings = useLoad((api) => api.getQeraSettings());
  const prompts = useLoad((api) => api.listQeraPrompts());
  return (
    <>
      <Loaded state={settings}>{(s) => <SettingsForm initial={s} onSaved={() => { settings.reload(); prompts.reload(); }} />}</Loaded>
      <Loaded state={prompts}>{(list) => <Prompts list={list} onChanged={() => { prompts.reload(); settings.reload(); }} />}</Loaded>
    </>
  );
}

function SettingsForm({ initial, onSaved }: { initial: QeraSettingsView; onSaved: () => void }) {
  const { api } = useAdmin();
  const [v, setV] = useState<QeraSettingsInput>({ providerOrder: initial.providerOrder, models: initial.models, llmEnabled: initial.llmEnabled, knowledgeEnabled: initial.knowledgeEnabled, proactiveEnabled: initial.proactiveEnabled, autonomyLevel: initial.autonomyLevel, dailyCostCapCents: initial.dailyCostCapCents, memberHourlyLimit: initial.memberHourlyLimit, escalateAboveMinor: initial.escalateAboveMinor });
  const { run, pending, error } = useRun();
  const [saved, setSaved] = useState(false);
  useEffect(() => { setSaved(false); }, [v]);
  const move = (i: number, by: number) => { const order = [...v.providerOrder]; const [p] = order.splice(i, 1); order.splice(i + by, 0, p!); setV({ ...v, providerOrder: order }); };
  const missing = QERA_PROVIDERS.filter((p) => !v.providerOrder.includes(p));
  return (
    <form className="panel" aria-label="How QÉRA runs" onSubmit={(e) => { e.preventDefault(); void run(() => api.updateQeraSettings(v), () => { setSaved(true); onSaved(); }); }}>
      <h2>How QÉRA runs</h2>
      <p className="muted" style={{ margin: 0 }}>Last changed {fmtDate(initial.updatedAt)}{initial.updatedBy ? ` by ${initial.updatedBy}` : ''}. Every change is written to the audit log.</p>

      <label className="check"><input type="checkbox" checked={v.llmEnabled} onChange={(e) => setV({ ...v, llmEnabled: e.target.checked })} />Use hosted AI models</label>
      <p className="note" style={{ margin: 0 }}>{v.llmEnabled ? 'Members’ messages are sent to the providers below to be understood, with Quintara’s records that QÉRA looks up. Card details and passwords are never sent. Check each provider’s data processing terms and where it stores data before turning this on (POPIA, cross-border transfer).' : 'Off: QÉRA answers from its built-in rules alone and no member text leaves Quintara’s servers. It still books, plans and refers as usual.'}</p>
      {initial.configured.length === 0 ? <p className="error" style={{ margin: 0 }}>No provider has a key on the server yet, so QÉRA will keep to its built-in rules. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY on the API server.</p> : null}

      <div style={{ display: 'grid', gap: 10 }}>
        <span className="muted" style={{ fontSize: 13 }}>Providers, tried in this order. If one fails or is slow, the next answers; if all fail, the built-in rules do.</span>
        {v.providerOrder.map((p, i) => (
          <div key={p} className="row">
            <span style={{ minWidth: 150 }}>{i + 1}. {QERA_PROVIDER_LABEL[p]}</span>
            <span className={`chip ${initial.configured.includes(p) ? 'ok' : ''}`}>{initial.configured.includes(p) ? 'Key set' : 'No key'}</span>
            <input aria-label={`${QERA_PROVIDER_LABEL[p]} model`} value={v.models[p] ?? ''} onChange={(e) => setV({ ...v, models: { ...v.models, [p]: e.target.value } })} style={{ minWidth: 220 }} />
            <button type="button" className="link" disabled={i === 0} onClick={() => move(i, -1)}>Up</button>
            <button type="button" className="link" disabled={i === v.providerOrder.length - 1} onClick={() => move(i, 1)}>Down</button>
            {v.providerOrder.length > 1 ? <button type="button" className="link" onClick={() => setV({ ...v, providerOrder: v.providerOrder.filter((x) => x !== p) })}>Remove</button> : null}
          </div>
        ))}
        {missing.length ? <div className="row">{missing.map((p) => <button key={p} type="button" className="btn ghost" onClick={() => setV({ ...v, providerOrder: [...v.providerOrder, p] })}>Add {QERA_PROVIDER_LABEL[p]}</button>)}</div> : null}
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend className="muted" style={{ fontSize: 13, marginBottom: 6 }}>What QÉRA may do</legend>
        {([1, 2, 3, 4] as const).map((level) => (
          <label key={level} className="check" style={{ alignItems: 'flex-start', opacity: level === 4 ? 0.55 : 1 }}>
            <input type="radio" name="autonomy" disabled={level === 4} checked={v.autonomyLevel === level} onChange={() => level !== 4 && setV({ ...v, autonomyLevel: level })} />
            <span><b style={{ fontWeight: 500 }}>Level {level}: {QERA_AUTONOMY[level].label}.</b> <span className="muted">{QERA_AUTONOMY[level].detail}</span></span>
          </label>
        ))}
      </fieldset>

      <div className="row">
        <label>Daily model budget (US$)<input type="number" min={0} step={1} value={v.dailyCostCapCents / 100} onChange={(e) => setV({ ...v, dailyCostCapCents: Math.round(Number(e.target.value) * 100) })} /></label>
        <label>Model calls per member per hour<input type="number" min={1} max={1000} value={v.memberHourlyLimit} onChange={(e) => setV({ ...v, memberHourlyLimit: Number(e.target.value) })} /></label>
        <label>Refer to the Curator above (R)<input type="number" min={0} step={100} value={v.escalateAboveMinor / 100} onChange={(e) => setV({ ...v, escalateAboveMinor: Math.round(Number(e.target.value) * 100) })} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={v.knowledgeEnabled} onChange={(e) => setV({ ...v, knowledgeEnabled: e.target.checked })} />Answer from the knowledge base</label>
      <label className="check"><input type="checkbox" checked={v.proactiveEnabled} onChange={(e) => setV({ ...v, proactiveEnabled: e.target.checked })} />Weekly brief, reminders and suggestions members have opted into</label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row"><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Save'}</button>{saved ? <span className="muted" role="status">Saved. QÉRA uses it within a few seconds.</span> : null}</div>
    </form>
  );
}

function Prompts({ list, onChanged }: { list: QeraPromptVersion[]; onChanged: () => void }) {
  const { api } = useAdmin();
  const live = list.find((p) => p.isLive) ?? null;
  const [draft, setDraft] = useState({ body: live?.body ?? '', note: '' });
  const { run, pending, error } = useRun();
  return (
    <section className="panel" aria-label="QÉRA's voice">
      <h2>QÉRA&rsquo;s voice</h2>
      <p className="muted" style={{ margin: 0 }}>The words that tell a hosted model who QÉRA is and how it speaks. Quintara&rsquo;s safety rules are always added after them and cannot be changed here. {live ? `Version ${live.version} is live.` : 'The built-in version is live.'}</p>
      <label>New version<textarea rows={8} maxLength={20000} value={draft.body} placeholder="You are QÉRA, the Quintara Intelligence…" onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label>
      <label>What changed<input maxLength={300} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row">
        <button className="btn ghost" disabled={pending || draft.body.trim().length < 50} onClick={() => void run(() => api.createQeraPrompt(draft), () => { setDraft({ body: '', note: '' }); onChanged(); })}>Save as a new version</button>
        {live ? <button className="link" disabled={pending} onClick={() => void run(() => api.publishQeraPrompt(null), onChanged)}>Go back to the built-in version</button> : null}
      </div>
      {list.length ? (
        <div className="scroll"><table style={{ minWidth: 0 }}>
          <thead><tr><th>Version</th><th>Note</th><th>Saved</th><th /></tr></thead>
          <tbody>{list.map((p) => (
            <tr key={p.id}>
              <td>{p.version}{p.isLive ? <> <span className="chip ok">Live</span></> : null}</td>
              <td>{p.note || <span className="muted">No note</span>}</td>
              <td>{fmtDate(p.createdAt)}<small>{p.createdBy ?? ''}</small></td>
              <td>{p.isLive ? null : <button className="link" disabled={pending} onClick={() => void run(() => api.publishQeraPrompt(p.id), onChanged)}>Make live</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : null}
    </section>
  );
}

/* ---------- Model calls ---------- */

function ModelCalls() {
  const [failed, setFailed] = useState(false);
  const state = useLoad((api) => api.listQeraModelCalls(failed), [failed]);
  return (
    <>
      <p className="note">Each call QÉRA made to a hosted model: how long it took, its size and estimated cost, and any error. What members wrote is not kept here.</p>
      <label className="check"><input type="checkbox" checked={failed} onChange={(e) => setFailed(e.target.checked)} />Failures only</label>
      <Loaded state={state}>
        {(calls) => calls.length ? (
          <div className="scroll"><table>
            <thead><tr><th>When</th><th>Model</th><th>Result</th><th>Time</th><th>Tokens in / out</th><th>Cost</th><th>For</th></tr></thead>
            <tbody>{calls.map((c) => (
              <tr key={c.id}>
                <td>{fmtDate(c.at)}</td>
                <td>{c.model}<small>{QERA_PROVIDER_LABEL[c.provider as keyof typeof QERA_PROVIDER_LABEL] ?? c.provider}</small></td>
                <td>{c.ok ? <span className="chip ok">{c.tool ? `Asked for ${words(c.tool).toLowerCase()}` : 'Answered'}</span> : <><span className="chip">Failed</span><small>{c.error === 'unsupported_claim' ? 'Claimed something was done; the built-in rules answered instead' : c.error}</small></>}</td>
                <td>{(c.latencyMs / 1000).toFixed(1)} s</td>
                <td>{c.inputTokens.toLocaleString('en-ZA')} / {c.outputTokens.toLocaleString('en-ZA')}</td>
                <td>{dollars(c.costUsd)}</td>
                <td>{c.member ?? <span className="muted">Not recorded</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p className="muted">{failed ? 'No failed calls.' : 'No hosted model has been called yet.'}</p>}
      </Loaded>
    </>
  );
}

/* ---------- Conversations ---------- */

function Conversations() {
  const { api } = useAdmin();
  const state = useLoad((client) => client.listQeraConversations());
  const [open, setOpen] = useState<QeraConversationView | null>(null);
  const [asking, setAsking] = useState<{ userId: string; name: string } | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const read = async (event: FormEvent) => {
    event.preventDefault();
    if (!asking) return;
    try { setOpen(await api.readQeraConversation(asking.userId, reason)); setAsking(null); setReason(''); setError(null); } catch (caught) { setError(toApiError(caught).message); }
  };
  return (
    <>
      <p className="note">Conversations are private to each member. Open one only to investigate a problem: you will be asked why, and that is written to the audit log with your name. Card numbers, email addresses and phone numbers are hidden.</p>
      {asking ? (
        <form className="panel" onSubmit={read} aria-label="Why are you opening this conversation?">
          <label>Why do you need to read {asking.name}&rsquo;s conversation?<input autoFocus required minLength={10} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The member reported a wrong answer about refunds" /></label>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="row"><button className="btn">Open</button><button type="button" className="btn ghost" onClick={() => setAsking(null)}>Cancel</button></div>
        </form>
      ) : null}
      {open ? (
        <section className="panel" aria-label={`Conversation with ${open.name}`}>
          <div className="row" style={{ justifyContent: 'space-between' }}><h2>{open.name}</h2><button className="link" onClick={() => setOpen(null)}>Close</button></div>
          <div className="thread">
            {open.messages.map((m) => (
              <div key={m.id} className={`bubble ${m.role === 'member' ? 'mine' : ''}`}>
                {m.text}
                <small className="muted" style={{ display: 'block', marginTop: 4, fontSize: 11.5 }}>{m.role === 'member' ? 'Member' : `QÉRA${m.model ? `, ${m.model === 'rules' ? 'built-in rules' : m.model}` : ''}`}, {fmtDate(m.at)}{m.via === 'whatsapp' ? ', WhatsApp' : ''}{m.feedback === true ? ', rated helpful' : m.feedback === false ? ', rated not helpful' : ''}</small>
              </div>
            ))}
          </div>
          {open.proposals.length ? <>
            <h2 style={{ fontSize: '1.1rem' }}>Actions proposed</h2>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{open.proposals.map((p) => <li key={p.id}><span className="chip">{words(p.status)}</span> {p.summary} <span className="muted">{fmtDate(p.at)}</span></li>)}</ul>
          </> : null}
        </section>
      ) : null}
      <Loaded state={state}>
        {(list) => list.length ? (
          <div className="scroll"><table>
            <thead><tr><th>Who</th><th>Messages</th><th>Actions proposed</th><th>Referred</th><th>Not helpful</th><th>Last</th><th /></tr></thead>
            <tbody>{list.map((c) => (
              <tr key={c.userId}>
                <td>{c.name}<small>{c.audience === 'guest' ? 'Guest' : 'Member'}</small></td>
                <td>{c.messages}</td><td>{c.proposals}</td><td>{c.escalations}</td>
                <td>{c.notHelpful ? <span className="chip gold">{c.notHelpful}</span> : 0}</td>
                <td>{fmtDate(c.lastAt)}</td>
                <td><button className="link" onClick={() => { setAsking({ userId: c.userId, name: c.name }); setOpen(null); }}>Open</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p className="muted">Nobody has spoken with QÉRA yet.</p>}
      </Loaded>
    </>
  );
}
