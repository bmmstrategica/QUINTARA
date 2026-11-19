'use client';

import { Avatar } from '@/components/media';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import { ROLES } from '@quintara/domain';
import type { Role } from '@quintara/domain';
import { ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';
import { FilterChips, useQueryFilter } from '@/components/filter-chips';

const ROLE_LABEL: Record<Role, string> = { member: 'Members', founder: 'Founders', investor: 'Investors', creative: 'Creatives', executive: 'Executives' };

const ROLE_FILTERS = ROLES.filter((name): name is Exclude<Role, 'member'> => name !== 'member');

export default function MembersPage() {
  return <Suspense><Members /></Suspense>;
}

/** The directory, filtered by role (?role=investor). The filter is applied by the server. */
function Members() {
  const club = useSection('club');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [role, setRole] = useQueryFilter('role', ROLE_FILTERS);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const members = useResource((api) => api.listMembers({ search: debounced, role: role || undefined }), [debounced, role]);

  return (
    <>
      <div className="head">
        <div>
          <h2>Members</h2>
          <p className="lede">{club.description}</p>
        </div>
      </div>
      <FilterChips label="Type of member" value={role} onChange={setRole} options={[['', 'Everyone'], ...ROLE_FILTERS.map((name) => [name, ROLE_LABEL[name]] as const)]} />
      <div style={{ maxWidth: '36rem', marginBottom: '1rem' }}>
        <label>Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, company, industry or interest" /></label>
      </div>
      <Suggestions onChanged={members.reload} />
      <ResourceView resource={members} isEmpty={(list) => list.length === 0} empty={<p className="muted">No members match. Try fewer filters.</p>}>
        {(list) =>
          list.map((member) => (
            <article className="item-row plain" key={member.id}>
              <div>
                <div className="row" style={{ gap: '0.8rem' }}><Avatar name={member.fullName} path={member.avatarPath} size={44} /><h3>{member.fullName}</h3></div>
                <div className="facts" style={{ margin: '0.3rem 0' }}>{member.position}, {member.company}. {member.industry}, {member.city}.</div>
                <div className="muted">Looking for: {member.lookingFor || 'Not said'}</div>
              </div>
              <div className="actions">
                {member.connection === 'connected' ? <span className="tag positive">Connected</span> : null}
                <Link className="btn quiet small" href={`/members/${member.id}`}>View profile</Link>
              </div>
            </article>
          ))
        }
      </ResourceView>
      <Blocked onChanged={members.reload} />
    </>
  );
}

/** The members this person has blocked, with a way to undo it. Shown only when there are any. */
function Blocked({ onChanged }: { onChanged: () => void }) {
  const blocked = useResource((api) => api.listBlockedMembers(), []);
  const unblock = useAction(async (api, id: string) => { await api.unblockMember(id); return true; });
  if (!blocked.data?.length) return null;
  return (
    <section style={{ marginTop: '2rem' }}>
      <h3>Blocked</h3>
      {blocked.data.map((member) => (
        <article className="item-row plain" key={member.id}>
          <div><strong>{member.fullName}</strong><div className="muted">Cannot see your profile or contact you.</div></div>
          <div className="actions"><button className="btn quiet small" disabled={unblock.pending} onClick={async () => { if (await unblock.run(member.id)) { blocked.reload(); onChanged(); } }}>Unblock</button></div>
        </article>
      ))}
    </section>
  );
}

/** People to meet: a few members with the reasons, drawn only from what both profiles show. */
function Suggestions({ onChanged }: { onChanged: () => void }) {
  const suggestions = useResource((api) => api.listSuggestions(), []);
  const connect = useAction((api, id: string) => api.requestConnection(id));
  const matching = useSection('matching');
  if (!suggestions.data?.length) return null;
  return (
    <section id="people-to-meet" className="panel" style={{ marginBottom: '2rem', scrollMarginTop: '9rem' }}>
      <h3>People to meet</h3>
      <p className="muted" style={{ margin: '0.6rem 0 0', fontSize: '0.9rem' }}>{matching.description}</p>
      {suggestions.data.map(({ member, reasons }) => (
        <div className="panel-item" key={member.id} style={{ alignItems: 'flex-start' }}>
          <div><strong style={{ fontWeight: 500 }}>{member.fullName}</strong><small>{member.position}, {member.company}. {member.city}.</small>{reasons.map((reason) => <small key={reason}>{reason}.</small>)}</div>
          <div className="row"><Link className="btn quiet small" href={`/members/${member.id}`}>View profile</Link><button className="btn small" disabled={connect.pending} onClick={async () => { if (await connect.run(member.id)) { suggestions.reload(); onChanged(); } }}>Connect</button></div>
        </div>
      ))}
    </section>
  );
}
