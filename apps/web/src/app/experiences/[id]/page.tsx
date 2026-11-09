'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useAction, usePermission, useResource, useSession } from '@quintara/app-core';
import { ADMISSION_LABEL, bookingOffer, formatDateTime, formatMoney } from '@quintara/domain';
import type { Booking, BookingOffer, Experience } from '@quintara/domain';
import { BookingStatusTag } from '@/components/experience';
import { PayBooking } from '@/components/pay';
import { ActionError, ResourceView } from '@/components/states';

const OFFER_LABEL: Partial<Record<BookingOffer, string>> = { reserve: 'Reserve', rsvp: 'RSVP', apply: 'Apply to attend', waitlist: 'Join waitlist' };

export default function ExperiencePage() {
  const { id } = useParams<{ id: string }>();
  const canBook = usePermission('experiences.book');
  const resource = useResource(async (api) => {
    const [experience, bookings] = await Promise.all([api.getExperience(id), canBook ? api.listBookings() : Promise.resolve([])]);
    const booking = bookings.find((b) => b.experienceId === id && b.status !== 'cancelled' && b.status !== 'declined') ?? null;
    return { experience, booking };
  }, [id, canBook]);

  return (
    <>
      <p><Link href="/experiences" className="muted">All experiences</Link></p>
      <ResourceView resource={resource}>
        {({ experience, booking }) => <ExperienceDetail experience={experience} booking={booking} onChanged={resource.reload} />}
      </ResourceView>
    </>
  );
}

function ExperienceDetail({ experience, booking, onChanged }: { experience: Experience; booking: Booking | null; onChanged: () => void }) {
  const { session } = useSession();
  // Guests and visitors are not sent the date or the seat counts.
  const when = experience.startsAt ? formatDateTime(experience.startsAt, experience.timezone) : null;
  const seatsLeft = experience.capacity === null ? null : experience.capacity - (experience.seatsTaken ?? 0);
  const memberPriceDiffers = experience.memberPriceMinor !== experience.priceMinor;

  return (
    <>
      <div className="cover">
        <div className="row"><span className="tag">{experience.category}</span><span className="tag">{ADMISSION_LABEL[experience.admission]}</span></div>
        <h1>{experience.title}</h1>
        <div>{when ? `${when.long}, ${when.time}. ` : ''}{experience.venueName}, {experience.area}.</div>
      </div>
      <div className="detail">
        <div>
          <p className="lede">{experience.summary}</p>
          <p>{experience.description}</p>
          {experience.programme.length > 0 ? (
            <>
              <h3>Programme</h3>
              <ol className="programme">{experience.programme.map((item) => <li key={item.time + item.title}><span className="muted">{item.time}</span><span>{item.title}</span></li>)}</ol>
            </>
          ) : null}
          {experience.included.length > 0 ? (
            <>
              <h3>Included</h3>
              <ul className="plain-list">{experience.included.map((item) => <li key={item}>{item}</li>)}</ul>
            </>
          ) : null}
        </div>
        <aside className="aside">
          <dl>
            <dt>Price</dt><dd>{formatMoney(experience.priceMinor, experience.currency)}{experience.priceMinor ? ' per seat' : ''}</dd>
            {memberPriceDiffers ? <><dt>Members</dt><dd>{formatMoney(experience.memberPriceMinor, experience.currency)} per seat</dd></> : null}
            {seatsLeft === null
              ? <><dt>Date and seats</dt><dd>Shared with members</dd></>
              : <><dt>Availability</dt><dd>{seatsLeft > 0 ? `${seatsLeft} of ${experience.capacity} seats` : 'Full, waitlist open'}</dd></>}
            <dt>Dress</dt><dd>{experience.dressCode}</dd>
            <dt>Host</dt><dd>{experience.host}</dd>
            <dt>Guests</dt><dd>{experience.guestPolicy}</dd>
          </dl>
          {booking ? <ExistingBooking booking={booking} onChanged={onChanged} /> : <BookingForm experience={experience} offer={bookingOffer(experience, session)} onBooked={onChanged} />}
        </aside>
      </div>
    </>
  );
}

function ExistingBooking({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  const cancel = useAction((api) => api.cancelBooking(booking.id));
  return (
    <div className="stack">
      <div className="row"><BookingStatusTag status={booking.status} /><span>{booking.seats} seat{booking.seats > 1 ? 's' : ''}</span></div>
      {booking.status === 'confirmed' ? <p className="notice">Your ticket code is <strong>{booking.ticketCode}</strong>. It is also under Bookings.</p> : null}
      <PayBooking booking={booking} onPaid={onChanged} />
      <ActionError error={cancel.error} />
      <div className="row">
        <Link className="btn" href="/bookings">View bookings</Link>
        <button className="btn quiet" disabled={cancel.pending} onClick={async () => { if (await cancel.run()) onChanged(); }}>
          {cancel.pending ? 'Cancelling' : 'Cancel booking'}
        </button>
      </div>
    </div>
  );
}

function BookingForm({ experience, offer, onBooked }: { experience: Experience; offer: BookingOffer; onBooked: () => void }) {
  const [seats, setSeats] = useState(1);
  const book = useAction((api, count: number) => api.bookExperience(experience.id, count));

  if (offer === 'membership_needed') {
    return (
      <div className="stack">
        <p className="muted">Booking is for members.</p>
        <div className="row"><Link className="btn" href="/apply">Apply for membership</Link><Link className="btn quiet" href="/sign-in">Sign in</Link></div>
      </div>
    );
  }
  if (offer === 'invitation_needed') return <p className="muted">This experience is by invitation.</p>;

  return (
    <form className="stack" onSubmit={async (event) => { event.preventDefault(); if (await book.run(seats)) onBooked(); }}>
      {experience.maxSeatsPerBooking > 1 ? (
        <label>
          Seats
          <select value={seats} onChange={(event) => setSeats(Number(event.target.value))}>
            {Array.from({ length: experience.maxSeatsPerBooking }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
          </select>
        </label>
      ) : null}
      <ActionError error={book.error} />
      <div><button className="btn" disabled={book.pending}>{book.pending ? 'Sending' : OFFER_LABEL[offer]}</button></div>
    </form>
  );
}
