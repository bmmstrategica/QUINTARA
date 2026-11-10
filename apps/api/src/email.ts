/**
 * Email sits behind an interface, like payments, so the sending service can be chosen later.
 * Messages are queued in `email_outbox` by a database trigger on notifications and delivered here,
 * so a slow or failing mail service never slows or fails the action that caused the message.
 */
import type { Db } from './db.ts';

export interface EmailMessage {
  to: string; subject: string; text: string;
  /** The same for every attempt at one message, so a retry after a lost answer is not delivered twice. */
  idempotencyKey?: string;
}
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** Stands in for a real service in development and tests: keeps what would have been sent. */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';
  readonly sent: EmailMessage[] = [];
  failNext = false;
  async send(message: EmailMessage): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error('The mail service is unavailable.'); }
    this.sent.push(message);
  }
}

/**
 * Sends through Resend (resend.com), a transactional email service with a plain HTTPS API. Another service needs
 * only its own small adapter with the same `send`. The sending domain must be verified with the service first.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly apiKey: string;
  private readonly from: string;
  private readonly baseUrl: string;
  constructor(options: { apiKey: string; from: string; baseUrl?: string }) {
    this.apiKey = options.apiKey; this.from = options.from; this.baseUrl = (options.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '');
  }
  async send(message: EmailMessage): Promise<void> {
    const response = await fetch(`${this.baseUrl}/emails`, {
      method: 'POST',
      // Resend keeps an idempotency key for a day: a retry after a timed-out answer returns the first result.
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', ...(message.idempotencyKey ? { 'idempotency-key': message.idempotencyKey } : {}) },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`The mail service refused the message (${response.status}).`);
  }
}

type Link = { type: string; id: string } | null;
const PATHS: Record<string, (id: string) => string> = {
  experience: (id) => `/experiences/${id}`, booking: () => '/bookings', member: (id) => `/members/${id}`,
  request: (id) => `/concierge/${id}`, conversation: (id) => `/messages/${id}`, order: () => '/boutique',
};
const MAX_ATTEMPTS = 5;

/** Sends what is waiting. Safe to run from several servers at once: each row is claimed under a lock. */
export async function deliverEmails(db: Db, provider: EmailProvider, webUrl: string, batch = 25): Promise<number> {
  const claimed = await db.tx((tx) => tx.query<{ id: string; subject: string; link: Link; email: string | null; full_name: string | null }>(
    `UPDATE email_outbox o SET attempts = attempts + 1
       FROM (SELECT id FROM email_outbox WHERE status = 'pending' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) due
      WHERE o.id = due.id
  RETURNING o.id, o.subject, o.link,
            -- A guest has no account email: their latest order says where to write.
            COALESCE((SELECT u.email FROM users u WHERE u.id = o.user_id AND u.deleted_at IS NULL),
                     (SELECT d.contact_email FROM orders d WHERE d.user_id = o.user_id AND d.contact_email IS NOT NULL ORDER BY d.created_at DESC LIMIT 1)) AS email,
            COALESCE((SELECT p.full_name FROM profiles p WHERE p.user_id = o.user_id),
                     (SELECT d.delivery_name FROM orders d WHERE d.user_id = o.user_id AND d.contact_email IS NOT NULL ORDER BY d.created_at DESC LIMIT 1)) AS full_name`, [batch]));
  let sent = 0;
  for (const row of claimed) {
    if (!row.email) { await db.query(`UPDATE email_outbox SET status = 'skipped' WHERE id = $1`, [row.id]); continue; }
    const path = row.link && PATHS[row.link.type] ? PATHS[row.link.type]!(row.link.id) : '/';
    const text = `${row.full_name ? `Dear ${row.full_name.split(' ')[0]},` : 'Hello,'}\n\n${row.subject}\n\nOpen Quintara: ${webUrl.replace(/\/$/, '')}${path}\n\nQuintara`;
    try {
      await provider.send({ to: row.email, subject: row.subject, text, idempotencyKey: `email/${row.id}` });
      await db.query(`UPDATE email_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`, [row.id]);
      sent++;
    } catch (error) {
      // Left pending for the next run; given up on after a few attempts so one bad address cannot loop for ever.
      await db.query(`UPDATE email_outbox SET last_error = $2, status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END WHERE id = $1`, [row.id, String((error as Error).message).slice(0, 300), MAX_ATTEMPTS]);
    }
  }
  return sent;
}
