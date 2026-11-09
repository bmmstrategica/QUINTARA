'use client';

/**
 * The audit log: everything each member of staff has done in the admin console (actions) and everything they
 * opened or sent (requests), newest first. Administrators see everyone, export the log and check that nothing in it
 * has been changed or removed; everyone else sees their own activity.
 */
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AuditEntry, AuditFilters } from '@quintara/api-client';
import { fmtDate, Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

export default function AuditPage() {
  return <Suspense fallback={<p className="muted" role="status">Loading</p>}><Audit /></Suspense>;
}

function Audit() {
  const { api } = useAdmin();
  const params = useSearchParams();
  const [filters, setFilters] = useState<AuditFilters>({ staff: params.get('staff') ?? undefined, kind: 'all', limit: 200 });
  const [draft, setDraft] = useState(filters);
  const log = useLoad((client) => client.listAudit(filters), [JSON.stringify(filters)]);
  const check = useRun();
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.verifyAudit>> | null>(null);
  return (
    <>
      <div>
        <h1>Audit log</h1>
        <p className="lede">Every action by each member of staff, and every page and record they opened, with the time, their address and their device. Entries can be added but never changed or removed, and each is sealed to the one before it, so any tampering shows.</p>
      </div>
      <Loaded state={log}>
        {({ entries, all, staff }) => (
          <>
            <form className="panel filters" aria-label="Filter the log" onSubmit={(event) => { event.preventDefault(); setFilters({ ...draft, q: draft.q?.trim() || undefined }); }}>
              {all ? (
                <label>Member of staff<select value={draft.staff ?? ''} onChange={(event) => setDraft({ ...draft, staff: event.target.value || undefined })}>
                  <option value="">Everyone</option>{staff.map((s) => <option key={s.userId} value={s.userId}>{s.fullName}</option>)}
                </select></label>
              ) : <p className="muted">Your own activity.</p>}
              <label>Show<select value={draft.kind ?? 'all'} onChange={(event) => setDraft({ ...draft, kind: event.target.value as AuditFilters['kind'] })}>
                <option value="all">Actions and pages opened</option><option value="action">Actions only</option><option value="request">Pages and requests only</option>
              </select></label>
              <label>From<input type="date" value={draft.from ?? ''} onChange={(event) => setDraft({ ...draft, from: event.target.value || undefined })} /></label>
              <label>To<input type="date" value={draft.to ?? ''} onChange={(event) => setDraft({ ...draft, to: event.target.value || undefined })} /></label>
              <label>Containing<input value={draft.q ?? ''} maxLength={80} placeholder="order, staff, refund" onChange={(event) => setDraft({ ...draft, q: event.target.value })} /></label>
              <div className="row"><button className="btn">Show</button></div>
            </form>
            {all ? (
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="row">
                  <a className="btn ghost" href={api.auditExportUrl(filters)}>Export as CSV</a>
                  <button className="btn ghost" disabled={check.pending} onClick={() => check.run(async () => setResult(await api.verifyAudit()))}>{check.pending ? 'Checking' : 'Check the log is intact'}</button>
                </div>
                {result ? <p className={result.actions.intact && result.requests.intact ? 'note' : 'error'} role="status">
                  {result.actions.intact && result.requests.intact
                    ? `Intact: ${result.actions.entries.toLocaleString('en-ZA')} actions and ${result.requests.entries.toLocaleString('en-ZA')} requests checked, ${fmtDate(result.checkedAt)}.`
                    : `Not intact. ${!result.actions.intact ? `Actions changed or removed at entry ${result.actions.firstBrokenAt}. ` : ''}${!result.requests.intact ? `Requests changed or removed at entry ${result.requests.firstBrokenAt}.` : ''} Tell the data protection officer.`}
                </p> : null}
                {check.error ? <p className="error" role="alert">{check.error}</p> : null}
              </div>
            ) : null}
            {entries.length === 0 ? <p className="note">Nothing matches.</p> : (
              <div className="log" aria-label="Entries">
                {entries.map((e) => <Row key={`${e.kind}${e.seq}`} entry={e} />)}
              </div>
            )}
            {entries.length >= (filters.limit ?? 200) ? <p className="muted">Showing the latest {entries.length}. Narrow the dates to see earlier entries, or export them.</p> : null}
          </>
        )}
      </Loaded>
    </>
  );
}

function Row({ entry: e }: { entry: AuditEntry }) {
  const record = e.entityId ? `${e.entityType ? `${e.entityType} ` : ''}${e.entityId}` : null;
  return (
    <div className="log-row">
      <time dateTime={e.at}>{fmtDate(e.at)}</time>
      <span>{e.staffName}</span>
      <span className="what">{e.summary}{e.kind === 'request' ? <small>{e.action}{e.status ? `, answered ${e.status}` : ''}{record ? `, ${record}` : ''}</small> : <small>{e.action}{record ? `, ${record}` : ''}</small>}</span>
      <span className="meta" title={e.device ?? undefined}>{e.ip ?? ''}</span>
      {e.kind === 'action' && e.details && JSON.stringify(e.details) !== 'null' ? <details><summary>Details</summary><pre>{JSON.stringify(e.details, null, 2)}</pre>{e.device ? <p>{e.device}</p> : null}</details> : null}
    </div>
  );
}
