'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import { longDay } from '@quintara/domain';
import type { PartnerBookingView } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';

/** Where a partner answers a booking Quintara sent them. Reached only with the link from the email; no sign-in. */
export default function PartnerBookingPage() {
  const { token } = useParams<{ token: string }>();
  const loaded = useResource((api) => api.getPartnerBookingByToken(token), [token]);
  return (
    <div style={{ maxWidth: '36rem' }}>
      <h2>A booking from Quintara</h2>
      <ResourceView resource={loaded}>{(view) => <Answer token={token} initial={view} />}</ResourceView>
    </div>
  );
}

function Answer({ token, initial }: { token: string; initial: PartnerBookingView }) {
  const [view, setView] = useState(initial);
  const [note, setNote] = useState('');
  const respond = useAction((api, answer: 'confirm' | 'decline') => api.respondToPartnerBooking(token, answer, note));
  const answer = async (choice: 'confirm' | 'decline') => { const next = await respond.run(choice); if (next) setView(next); };
  return (
    <>
      <p className="lede" style={{ marginTop: '1rem' }}>Quintara would like to make this booking at {view.partnerName} for one of its members.</p>
      <dl style={{ marginTop: '1.5rem' }}>
        <dt>Name</dt><dd>{view.memberName}</dd>
        <dt>Date</dt><dd>{longDay(view.date)}{view.time ? ` at ${view.time}` : ''}</dd>
        <dt>Guests</dt><dd>{view.partySize}</dd>
        {view.notes ? <><dt>Note</dt><dd>{view.notes}</dd></> : null}
      </dl>
      {view.status === 'requested' ? (
        <div className="stack">
          <label>A note for the member (optional)<input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="For example, the table or the time you can offer" /></label>
          <ActionError error={respond.error} />
          <div className="row">
            <button className="btn" disabled={respond.pending} onClick={() => answer('confirm')}>Confirm the booking</button>
            <button className="btn quiet" disabled={respond.pending} onClick={() => answer('decline')}>We cannot take it</button>
          </div>
          <p className="muted" style={{ fontSize: '0.9rem' }}>The member should receive their Quintara privilege. Questions go to the Quintara concierge desk by replying to the email.</p>
        </div>
      ) : (
        <p className="notice" role="status">{view.status === 'confirmed' ? 'Thank you. This booking is confirmed and the member has been told.' : view.status === 'declined' ? 'Thank you. The member has been told, and Quintara will find them an alternative.' : 'The member has cancelled this booking. There is nothing to do.'}</p>
      )}
    </>
  );
}
