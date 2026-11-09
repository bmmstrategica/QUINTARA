'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAction, useResource, useSession } from '@quintara/app-core';
import { ActionError, ResourceView } from '@/components/states';
import { TwoFactorSettings } from '@/components/two-factor';

const hours = (seconds: number) => { const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };

/** A guest's own account: name, QÉRA time today, the way to membership, and their data. */
export default function AccountPage() {
  const router = useRouter();
  const { guest, session, status, refresh, deleteGuestAccount, signOut } = useSession();
  const [fullName, setFullName] = useState(guest?.fullName ?? '');
  const [confirm, setConfirm] = useState('');
  const usage = useResource((api) => (guest ? api.getQeraThread().then((t) => t.usage ?? null) : Promise.resolve(null)), [guest?.userId]);
  const rename = useAction(async (api, name: string) => { await api.updateGuestAccount({ fullName: name }); await refresh(); return true; });
  const exportData = useAction(async (api) => {
    const data = await api.exportGuestData();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'quintara-guest-account.json'; a.click(); URL.revokeObjectURL(url);
    return true;
  });
  const remove = useAction(async () => { await deleteGuestAccount(); return true; });

  if (status === 'loading') return null;
  if (session) return <div className="state"><h2>You are a member</h2><Link className="btn" href="/profile">Your profile</Link></div>;
  if (!guest) return <div className="state"><h2>Your account</h2><p className="lede">Sign in, or create a free guest account.</p><div className="row"><Link className="btn" href="/join">Create a guest account</Link><Link className="btn quiet" href="/sign-in">Sign in</Link></div></div>;

  return (
    <div className="split">
      <div>
        <h2>Your account</h2>
        <p className="lede" style={{ marginTop: '1rem' }}>{guest.fullName}, guest of Quintara since {new Date(guest.createdAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>
        <p className="muted">{guest.email}</p>
        <section className="panel" aria-label="QÉRA today">
          <h3>QÉRA today</h3>
          <ResourceView resource={usage}>
            {(u) => (u ? <p>{u.exhausted ? 'You have used today’s five hours.' : `${hours(u.usedSeconds)} used, ${hours(u.limitSeconds - u.usedSeconds)} left.`} <Link href="/qera">Open QÉRA</Link></p> : null)}
          </ResourceView>
        </section>
        <section className="panel" aria-label="Membership">
          <h3>Membership</h3>
          <p>Members book signature experiences, meet one another through Quintara, use partner privileges, and talk to QÉRA without a daily limit.</p>
          <Link className="btn" href="/apply">Apply for membership</Link>
        </section>
      </div>
      <div className="stack">
        <form className="stack" onSubmit={async (event) => { event.preventDefault(); await rename.run(fullName); }}>
          <label>Full name<input value={fullName} autoComplete="name" onChange={(event) => setFullName(event.target.value)} /></label>
          <ActionError error={rename.error} />
          <div className="row"><button className="btn quiet" disabled={rename.pending || fullName.trim() === guest.fullName}>{rename.pending ? 'Saving' : 'Save name'}</button></div>
        </form>
        <TwoFactorSettings />
        <h3>Your data</h3>
        <p className="muted">Download everything Quintara holds about your guest account, or delete it. Deleting is immediate and cannot be undone.</p>
        <ActionError error={exportData.error ?? remove.error} />
        <div className="row"><button className="btn quiet" disabled={exportData.pending} onClick={() => exportData.run()}>Download my data</button><button className="btn quiet" onClick={async () => { await signOut(); router.push('/'); }}>Sign out</button></div>
        <label>Type DELETE to delete your guest account<input value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
        <div className="row"><button className="btn quiet" disabled={confirm !== 'DELETE' || remove.pending} onClick={async () => { if (await remove.run()) router.push('/'); }}>{remove.pending ? 'Deleting' : 'Delete guest account'}</button></div>
      </div>
    </div>
  );
}
