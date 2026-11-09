import Link from 'next/link';
import { ADMISSION_LABEL, BOOKING_STATUS_LABEL, formatDateTime } from '@quintara/domain';
import type { BookingStatus, Experience } from '@quintara/domain';

/** The date as a block. Guests and visitors are not sent dates, so they see that it is shared with members. */
export function DateBlock({ iso, timezone }: { iso: string | null; timezone: string }) {
  if (!iso) return <div aria-label="Date shared with members"><div className="date-month">Date</div><div className="date-month" style={{ opacity: 0.7 }}>members</div></div>;
  const { day, month } = formatDateTime(iso, timezone);
  return (
    <div>
      <div className="date-day">{day}</div>
      <div className="date-month">{month}</div>
    </div>
  );
}

const STATUS_TONE: Record<BookingStatus, string> = {
  confirmed: 'positive', attended: 'positive', applied: 'accent', waitlisted: 'accent', awaiting_payment: 'accent', cancelled: 'critical', declined: 'critical',
};

export function BookingStatusTag({ status }: { status: BookingStatus }) {
  return <span className={`tag ${STATUS_TONE[status]}`}>{BOOKING_STATUS_LABEL[status]}</span>;
}

export function ExperienceRow({ experience, status }: { experience: Experience; status?: BookingStatus }) {
  const seatsLeft = experience.capacity === null ? null : experience.capacity - (experience.seatsTaken ?? 0);
  const time = experience.startsAt ? formatDateTime(experience.startsAt, experience.timezone).time : null;
  return (
    <article className="item-row">
      <DateBlock iso={experience.startsAt} timezone={experience.timezone} />
      <div>
        <h3>{experience.title}</h3>
        <p>{experience.summary}</p>
        <div className="facts row">
          <span className="tag">{experience.category}</span>
          {experience.admission !== 'open' ? <span className="tag accent">{ADMISSION_LABEL[experience.admission]}</span> : null}
          <span>{experience.area}{time ? `, ${time}` : ''}.{seatsLeft === null ? ' Date and seats for members.' : seatsLeft > 0 ? ` ${seatsLeft} seats left.` : ' Waitlist open.'}</span>
        </div>
      </div>
      <div className="actions">
        {status ? <BookingStatusTag status={status} /> : null}
        <Link className="btn quiet small" href={`/experiences/${experience.id}`}>View details</Link>
      </div>
    </article>
  );
}
