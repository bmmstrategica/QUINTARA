'use client';

import Link from 'next/link';
import type { BriefItem, BriefLink, DailyBrief, DailyItem } from '@quintara/domain';

/** Where a line of the brief leads in the web app. */
export const briefLinkHref = (link: BriefLink | null): string | null => {
  if (!link) return null;
  switch (link.kind) {
    case 'experience': return `/experiences/${link.id}`;
    case 'service': return '/lifestyle';
    case 'bookings': return '/bookings';
    case 'business': return '/business';
    case 'boutique': return '/boutique';
    case 'memory': return '/qera/memory';
    case 'calendar': return '/qera/calendar';
    case 'brief': return '/qera/today';
    case 'document': return link.id ? `/qera/documents/${link.id}` : '/qera';
    default: return '/qera';
  }
};

const SOURCE: Record<DailyItem['source'], string> = { calendar: 'Your calendar', quintara: 'Quintara', reminder: 'Reminder' };

function Line({ item }: { item: BriefItem }) {
  const href = briefLinkHref(item.link);
  return (
    <li>
      {href ? <Link href={href}>{item.title}</Link> : <span>{item.title}</span>}
      <small>{item.detail}</small>
    </li>
  );
}

/**
 * QÉRA's daily brief: the member's day in order, from their own calendar and from Quintara, what lies ahead,
 * what is waiting on them, and one suggestion. Read in the morning, like a note from a chief of staff.
 */
export function DailyBriefView({ brief, compact = false }: { brief: DailyBrief; compact?: boolean }) {
  const synced = brief.calendar.syncedAt ? new Date(brief.calendar.syncedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <article className={`brief${compact ? ' compact' : ''}`} aria-label="Your daily brief">
      <header className="brief-head">
        <img src="/quintara-emblem.png" alt="" className="brief-mark" />
        <span className="brief-eyebrow">QÉRA <span aria-hidden="true">·</span> Daily brief</span>
        <span className="brief-date">{brief.dateLabel}{brief.city ? <><span aria-hidden="true"> · </span>{brief.city}</> : null}</span>
      </header>
      <h2 className="brief-greeting">{brief.greeting}</h2>
      <p className="brief-summary">{brief.summary}</p>

      <div className="brief-body">
        <section aria-label="Today">
          <h3 className="brief-label">Today</h3>
          {brief.agenda.length ? (
            <ol className="timeline">
              {brief.agenda.map((item, k) => {
                const href = briefLinkHref(item.link);
                return (
                  <li key={k} className={`src-${item.source}`}>
                    <time>{item.time ?? 'All day'}{item.endTime ? <small>{item.endTime}</small> : null}</time>
                    <span className="dot" aria-hidden="true" />
                    <div>
                      <strong>{href ? <Link href={href}>{item.title}</Link> : item.title}</strong>
                      {item.detail ? <span>{item.detail}</span> : null}
                      <em>{SOURCE[item.source]}</em>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : <p className="brief-quiet">Nothing is planned. A good day to keep open, or to let me arrange something.</p>}
        </section>

        <div className="brief-side">
          {brief.suggestion ? (
            <section className="brief-note" aria-label="QÉRA suggests">
              <h3 className="brief-label">QÉRA suggests</h3>
              <p className="brief-note-title">{brief.suggestion.title}</p>
              <p>{brief.suggestion.detail}</p>
              <Link className="btn small" href={briefLinkHref(brief.suggestion.link) ?? '/qera'}>{brief.suggestion.link?.kind === 'experience' ? 'View' : 'Ask QÉRA'}</Link>
            </section>
          ) : null}
          {brief.waiting.length ? <section aria-label="Waiting on you"><h3 className="brief-label">Waiting on you</h3><ul className="brief-list">{brief.waiting.map((i, k) => <Line key={k} item={i} />)}</ul></section> : null}
          {!compact && brief.ahead.length ? <section aria-label="Ahead this week"><h3 className="brief-label">Ahead this week</h3><ul className="brief-list">{brief.ahead.map((i, k) => <Line key={k} item={i} />)}</ul></section> : null}
        </div>
      </div>

      <div className="brief-foot">
        {brief.calendar.connected
          ? <span>From your {brief.calendar.label}{synced ? `, updated ${synced}` : ''}{brief.calendar.showTitles ? '' : ', busy times only'}. <Link href="/qera/calendar">Manage</Link></span>
          : <span>Connect your calendar and your own meetings appear here beside Quintara’s. <Link href="/qera/calendar">Connect a calendar</Link></span>}
        {compact ? <Link href="/qera/today">Open the full brief</Link> : <Link href="/qera">Talk to QÉRA</Link>}
      </div>
    </article>
  );
}
