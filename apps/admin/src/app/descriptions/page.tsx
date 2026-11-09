'use client';

import { useState } from 'react';
import { SECTION_DEFAULTS } from '@quintara/domain';
import type { SectionCopy, SectionKey } from '@quintara/domain';
import { Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

/** Where each description is shown, so staff know what they are editing. */
const SHOWN_ON: Record<SectionKey, string> = {
  qera: 'Top of QÉRA', club: 'Top of The Club', concierge: 'Top of Concierge', lifestyle: 'Top of Lifestyle', privileges: 'Lifestyle, with the partner directory',
  boutique: 'Top of Maison Quintara', bookings: 'Top of Bookings', messaging: 'Top of Messages', curator: 'Lifestyle, Your Lifestyle Curator',
  experiences: 'Top of Experiences, for members', business: 'Top of Business', relationship: 'Business, Your relationship manager', matching: 'The Club, People to meet',
  services: 'Lifestyle, each service’s page', partners: 'Lifestyle, Partners and services directory', tv: 'Top of Quintara TV', membership: 'The membership application',
  guest: 'Create a guest account', notifications: 'Top of Notifications',
};
const MAIN: readonly SectionKey[] = ['qera', 'club', 'concierge', 'lifestyle', 'privileges', 'boutique', 'bookings', 'messaging', 'curator'];

/** The introductions members and guests read on each part of the apps, written by staff. */
export default function DescriptionsPage() {
  const sections = useLoad((client) => client.listSectionCopy());
  return (
    <>
      <div><h1>Descriptions</h1><p className="lede">The words that introduce each part of Quintara. The short line appears in menus and lists; the description at the top of the page. Changes show in the web and mobile apps at once.</p></div>
      <Loaded state={sections}>{(list) => (
        <>
          <h2>Main sections</h2>
          <div className="grid">{list.filter((c) => MAIN.includes(c.key)).map((c) => <SectionEditor key={c.key} copy={c} onChanged={sections.reload} />)}</div>
          <h2>Other sections and pages</h2>
          <div className="grid">{list.filter((c) => !MAIN.includes(c.key)).map((c) => <SectionEditor key={c.key} copy={c} onChanged={sections.reload} />)}</div>
        </>
      )}</Loaded>
    </>
  );
}

function SectionEditor({ copy, onChanged }: { copy: SectionCopy; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [summary, setSummary] = useState(copy.summary);
  const [description, setDescription] = useState(copy.description);
  const [saved, setSaved] = useState(false);
  const changed = summary.trim() !== copy.summary || description.trim() !== copy.description;
  const isDefault = copy.updatedAt === null;
  return (
    <form className="panel" aria-label={`Edit ${copy.title}`} onSubmit={(event) => { event.preventDefault(); setSaved(false); void run(() => api.updateSectionCopy(copy.key, { summary, description }), () => { setSaved(true); onChanged(); }); }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong style={{ fontWeight: 500 }}>{copy.title}</strong>
        <small className="muted" style={{ flexBasis: '100%', order: 3 }}>Shown on: {SHOWN_ON[copy.key]}</small>
        <span className={`chip ${isDefault ? '' : 'gold'}`}>{isDefault ? 'Quintara default' : `Edited ${new Date(copy.updatedAt!).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })}`}</span>
      </div>
      <label>Short line<input value={summary} maxLength={160} onChange={(event) => { setSaved(false); setSummary(event.target.value); }} /></label>
      <label>Description<textarea value={description} maxLength={1200} rows={4} onChange={(event) => { setSaved(false); setDescription(event.target.value); }} /></label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {saved ? <p className="muted" role="status" style={{ margin: 0, fontSize: 13 }}>Saved. Members and guests see it now.</p> : null}
      <div className="row">
        <button className="btn" disabled={pending || !changed}>{pending ? 'Saving' : 'Save'}</button>
        {isDefault ? null : <button type="button" className="btn ghost" disabled={pending} onClick={() => { if (window.confirm(`Go back to the original wording for ${copy.title}?`)) void run(() => api.resetSectionCopy(copy.key), () => { setSummary(SECTION_DEFAULTS[copy.key].summary); setDescription(SECTION_DEFAULTS[copy.key].description); onChanged(); }); }}>Restore the original</button>}
      </div>
    </form>
  );
}
