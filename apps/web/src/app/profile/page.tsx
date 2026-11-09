'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAction, useResource, useSession } from '@quintara/app-core';
import { profileUpdateSchema } from '@quintara/domain';
import type { MemberProfile, PrivacySettings, ProfileUpdate } from '@quintara/domain';
import { Avatar } from '@/components/media';
import { ActionError, ResourceView } from '@/components/states';
import { TwoFactorSettings } from '@/components/two-factor';
import { MembershipPanel } from '@/components/membership';

export default function ProfilePage() {
  const profile = useResource((api) => api.getMyProfile());
  return <ResourceView resource={profile}>{(data) => <><ProfilePicture profile={data} onChanged={profile.reload} /><ProfileEditor profile={data} /><Privacy /></>}</ResourceView>;
}

function ProfilePicture({ profile, onChanged }: { profile: MemberProfile; onChanged: () => void }) {
  const [problem, setProblem] = useState('');
  const upload = useAction((api, file: { type: string; data: string }) => api.setMyAvatar(file.type, file.data));
  const remove = useAction((api) => api.removeMyAvatar());
  function choose(file: File | undefined) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setProblem('Choose a JPEG, PNG or WebP image.'); return; }
    if (file.size > 2 * 1024 * 1024) { setProblem('Pictures can be up to 2 MB.'); return; }
    setProblem('');
    const reader = new FileReader();
    reader.onload = async () => { if (await upload.run({ type: file.type, data: String(reader.result).split(',')[1] ?? '' })) onChanged(); };
    reader.onerror = () => setProblem('That file could not be read.');
    reader.readAsDataURL(file);
  }
  return (
    <section className="row" style={{ gap: '1.2rem', marginBottom: '2rem' }} aria-label="Profile picture">
      <Avatar name={profile.fullName} path={profile.avatarPath} size={88} />
      <div className="stack" style={{ gap: '0.4rem' }}>
        <strong style={{ fontWeight: 500 }}>Profile picture</strong>
        <span className="muted" style={{ fontSize: '0.9rem' }}>Other members see it beside your name. JPEG, PNG or WebP, up to 2 MB.</span>
        <div className="row">
          <label className="btn quiet small" style={{ cursor: 'pointer' }}>{upload.pending ? 'Uploading' : profile.avatarPath ? 'Change picture' : 'Add a picture'}<input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} disabled={upload.pending} onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ''; }} /></label>
          {profile.avatarPath ? <button className="link" disabled={remove.pending} onClick={async () => { if (await remove.run()) onChanged(); }}>Remove</button> : null}
        </div>
        {problem ? <span className="field-error" role="alert">{problem}</span> : null}
        <ActionError error={upload.error ?? remove.error} />
      </div>
    </section>
  );
}

function ProfileEditor({ profile }: { profile: MemberProfile }) {
  const router = useRouter();
  const { session, signOut } = useSession();
  const [form, setForm] = useState({
    position: profile.position, company: profile.company, industry: profile.industry, city: profile.city,
    biography: profile.biography, interests: profile.interests.join(', '), lookingFor: profile.lookingFor, canOffer: profile.canOffer,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const save = useAction((api, update: ProfileUpdate) => api.updateMyProfile(update));

  const field = (key: keyof typeof form, label: string) => (
    <label>
      {label}
      <input value={form[key]} onChange={(event) => { setSaved(false); setForm({ ...form, [key]: event.target.value }); }} aria-invalid={errors[key] ? true : undefined} />
      {errors[key] ? <span className="field-error" role="alert">{errors[key]}</span> : null}
    </label>
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = profileUpdateSchema.safeParse({ ...form, interests: form.interests.split(',').map((item) => item.trim()).filter(Boolean) });
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= issue.message;
      setErrors(found);
      return;
    }
    setErrors({});
    if (await save.run(parsed.data)) setSaved(true);
  }

  return (
    <div className="split">
      <div className="stack">
        {session ? (
          <div className="card" aria-label="Membership card">
            <div className="row" style={{ justifyContent: 'space-between' }}><img src="/quintara-wordmark.png" alt="Quintara" height={11} /><span>{session.tierName}</span></div>
            <div>
              <h2>{session.fullName}</h2>
              <div>{session.memberNumber}</div>
              <div>Member since {new Date(session.memberSince).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })}</div>
            </div>
          </div>
        ) : null}
        <p className="muted">This is what other members see. Your email address is never shown.</p>
        <div><button className="btn quiet" onClick={async () => { await signOut(); router.push('/'); }}>Sign out</button></div>
      </div>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="field-row">{field('position', 'Position')}{field('company', 'Company')}</div>
        <div className="field-row">{field('industry', 'Industry')}{field('city', 'Location')}</div>
        <label>
          Short biography
          <textarea value={form.biography} onChange={(event) => { setSaved(false); setForm({ ...form, biography: event.target.value }); }} aria-invalid={errors.biography ? true : undefined} />
          {errors.biography ? <span className="field-error" role="alert">{errors.biography}</span> : null}
        </label>
        {field('interests', 'Interests, separated by commas')}
        {field('lookingFor', 'What you are looking for')}
        {field('canOffer', 'What you can offer')}
        <ActionError error={save.error} />
        {saved ? <p className="notice" role="status">Profile saved.</p> : null}
        <div><button className="btn" disabled={save.pending}>{save.pending ? 'Saving' : 'Save profile'}</button></div>
      </form>
    </div>
  );
}

/** The member's control over their own data: what is shared, a copy of everything held, and closing the account. */
function Privacy() {
  const router = useRouter();
  const { refresh } = useSession();
  const settings = useResource((api) => api.getPrivacySettings());
  const update = useAction((api, next: PrivacySettings) => api.updatePrivacySettings(next));
  const download = useAction((api) => api.exportMyData());
  const [confirm, setConfirm] = useState('');
  const close = useAction((api) => api.closeMyAccount(confirm));

  const toggle = async (current: PrivacySettings, key: keyof PrivacySettings, value: boolean) => { if (await update.run({ ...current, [key]: value })) settings.reload(); };
  const save = async () => {
    const data = await download.run();
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'my-quintara-data.json' });
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="panels" aria-label="Privacy">
      <div className="panel stack">
        <h3>Privacy</h3>
        <ResourceView resource={settings}>
          {(current) => (
            <>
              <label className="check"><input type="checkbox" checked={current.showInDirectory} disabled={update.pending} onChange={(event) => toggle(current, 'showInDirectory', event.target.checked)} /> Show my profile in the members directory</label>
              <label className="check"><input type="checkbox" checked={current.marketingEmail} disabled={update.pending} onChange={(event) => toggle(current, 'marketingEmail', event.target.checked)} /> Email me recommendations and partner offers</label>
              <label className="check"><input type="checkbox" checked={current.suggestions} disabled={update.pending} onChange={(event) => toggle(current, 'suggestions', event.target.checked)} /> Include me in People to meet, and show me suggestions</label>
              <label className="check"><input type="checkbox" checked={current.dailyBrief ?? true} disabled={update.pending} onChange={(event) => toggle(current, 'dailyBrief', event.target.checked)} /> QÉRA&rsquo;s daily brief, each morning</label>
              <label className="check"><input type="checkbox" checked={current.weeklyBrief} disabled={update.pending} onChange={(event) => toggle(current, 'weeklyBrief', event.target.checked)} /> QÉRA&rsquo;s Monday brief, and its reminders of dates and bookings</label>
              <p className="muted" style={{ fontSize: '0.9rem' }}>Emails about your own bookings, requests and membership are always sent.</p>
            </>
          )}
        </ResourceView>
        <ActionError error={update.error} />
      </div>
      <MembershipPanel />
      <TwoFactorSettings />
      <div className="panel stack">
        <h3>Your data</h3>
        <p className="muted">Download a copy of everything Quintara holds about you.</p>
        <ActionError error={download.error} />
        <div><button className="btn quiet" disabled={download.pending} onClick={save}>{download.pending ? 'Preparing' : 'Download my data'}</button></div>
        <details>
          <summary>Close my account</summary>
          <p className="muted" style={{ marginTop: '0.75rem' }}>This ends your membership and signs you out everywhere. Your bookings are cancelled, with refunds where the experience allows. Your personal data is erased after 30 days; until then the team can reinstate you.</p>
          <label>Type CLOSE to confirm<input value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="off" /></label>
          <ActionError error={close.error} />
          <p style={{ marginTop: '0.75rem' }}><button className="btn quiet" disabled={close.pending || confirm !== 'CLOSE'} onClick={async () => { if (await close.run()) { await refresh(); router.push('/'); } }}>{close.pending ? 'Closing' : 'Close my account'}</button></p>
        </details>
      </div>
    </section>
  );
}
