'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import { CONCIERGE_CATEGORIES, CONCIERGE_CATEGORY_LABEL, CONCIERGE_STATUS_LABEL, conciergeRequestSchema } from '@quintara/domain';
import type { ConciergeCategory, ConciergeRequestInput, ConciergeStatus } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

const TONE: Record<ConciergeStatus, string> = { requested: 'accent', reviewing: 'accent', options_provided: 'accent', confirmed: 'positive', completed: 'positive', cancelled: '' };

export default function ConciergePage() {
  const desk = useSection('concierge');
  const router = useRouter();
  const requests = useResource((api) => api.listConciergeRequests());
  const create = useAction((api, input: ConciergeRequestInput) => api.createConciergeRequest(input));
  const [form, setForm] = useState({ category: 'hospitality' as ConciergeCategory, subject: '', details: '', neededBy: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = conciergeRequestSchema.safeParse({ ...form, neededBy: form.neededBy || null });
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= issue.message;
      setErrors(found);
      return;
    }
    setErrors({});
    const created = await create.run(parsed.data);
    if (created) router.push(`/concierge/${created.id}`);
  }

  return (
    <div className="split">
      <div>
        <h2>Concierge</h2>
        <p className="lede" style={{ marginTop: '1rem' }}>{desk.description}</p>
        <p><Link className="btn quiet small" href="/qera">Ask QÉRA first</Link></p>
        <form className="stack" onSubmit={submit} noValidate style={{ marginTop: '1.5rem' }}>
          <div className="field-row">
            <label>Area
              <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as ConciergeCategory })}>
                {CONCIERGE_CATEGORIES.map((c) => <option key={c} value={c}>{CONCIERGE_CATEGORY_LABEL[c]}</option>)}
              </select>
            </label>
            <label>Needed by (optional)<input type="date" value={form.neededBy} onChange={(event) => setForm({ ...form, neededBy: event.target.value })} /></label>
          </div>
          <label>In a few words
            <input value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} placeholder="A table for six on Saturday" aria-invalid={errors.subject ? true : undefined} />
            {errors.subject ? <span className="field-error" role="alert">{errors.subject}</span> : null}
          </label>
          <label>The details
            <textarea value={form.details} onChange={(event) => setForm({ ...form, details: event.target.value })} placeholder="Dates, number of people, preferences, anything we should know" aria-invalid={errors.details ? true : undefined} />
            {errors.details ? <span className="field-error" role="alert">{errors.details}</span> : null}
          </label>
          <ActionError error={create.error} />
          <div><button className="btn" disabled={create.pending}>{create.pending ? 'Sending' : 'Send to the desk'}</button></div>
        </form>
      </div>
      <section className="panel">
        <h3>Your requests</h3>
        <ResourceView resource={requests} isEmpty={(list) => list.length === 0} empty={<p className="muted" style={{ paddingTop: '0.8rem' }}>Nothing yet. Your requests and the desk&rsquo;s replies appear here.</p>}>
          {(list) => list.map((r) => (
            <div className="panel-item" key={r.id}>
              <div><strong style={{ fontWeight: 500 }}>{r.subject}</strong><small>{CONCIERGE_CATEGORY_LABEL[r.category]}. {r.messages.length} message{r.messages.length === 1 ? '' : 's'}.</small></div>
              <div className="row"><span className={`tag ${TONE[r.status]}`}>{CONCIERGE_STATUS_LABEL[r.status]}</span><Link className="btn quiet small" href={`/concierge/${r.id}`}>Open</Link></div>
            </div>
          ))}
        </ResourceView>
      </section>
    </div>
  );
}
