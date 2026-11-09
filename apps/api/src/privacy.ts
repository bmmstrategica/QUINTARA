/**
 * A person's control over their own data: what they have agreed to, a copy of everything held
 * about them, and closing the account. Every function works only on the caller's own records.
 */
import { privacySettingsSchema } from '@quintara/domain';
import type { PrivacySettings } from '@quintara/domain';
import { audit, requireMember } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import { HttpError } from './errors.ts';
import { cancelBooking } from './experiences.ts';
import type { PaymentProvider } from './payments.ts';

/** Days between closing an account and erasing its personal data. Staff can reinstate within this time. */
export const ERASURE_DELAY_DAYS = 30;

export async function getPrivacy(db: Queryable, ctx: RequestContext): Promise<PrivacySettings> {
  const session = requireMember(ctx, 'profile.edit');
  const rows = await db.query<{ show_in_directory: boolean; marketing_email: boolean | null; suggestions: boolean | null; weekly_brief: boolean | null; daily_brief: boolean | null }>(
    `SELECT p.show_in_directory, s.marketing_email, s.suggestions, s.weekly_brief, s.daily_brief FROM profiles p LEFT JOIN privacy_settings s ON s.user_id = p.user_id WHERE p.user_id = $1`, [session.userId]);
  return { showInDirectory: Boolean(rows[0]?.show_in_directory), marketingEmail: Boolean(rows[0]?.marketing_email), suggestions: rows[0]?.suggestions ?? true, weeklyBrief: rows[0]?.weekly_brief ?? true, dailyBrief: rows[0]?.daily_brief ?? true };
}

export async function updatePrivacy(db: Db, ctx: RequestContext, body: unknown): Promise<PrivacySettings> {
  const session = requireMember(ctx, 'profile.edit');
  const parsed = privacySettingsSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(422, 'Those settings could not be read.');
  const before = await getPrivacy(db, ctx), next = parsed.data;
  await db.tx(async (tx) => {
    await tx.query('UPDATE profiles SET show_in_directory = $2, updated_at = now() WHERE user_id = $1', [session.userId, next.showInDirectory]);
    await tx.query(`INSERT INTO privacy_settings (user_id, marketing_email, suggestions, weekly_brief, daily_brief) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id) DO UPDATE SET marketing_email = $2, suggestions = $3, weekly_brief = $4, daily_brief = $5, updated_at = now()`, [session.userId, next.marketingEmail, next.suggestions, next.weeklyBrief, next.dailyBrief]);
    if (before.suggestions !== next.suggestions) await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'suggestions', $2)`, [session.userId, next.suggestions]);
    // Only real changes are recorded, so the history reads as a list of decisions.
    if (before.showInDirectory !== next.showInDirectory) await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'directory_listing', $2)`, [session.userId, next.showInDirectory]);
    if (before.marketingEmail !== next.marketingEmail) await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'marketing_email', $2)`, [session.userId, next.marketingEmail]);
  });
  return getPrivacy(db, ctx);
}

/** Everything held about the caller, in one readable file. Other people's details are limited to their names. */
export async function exportMyData(db: Queryable, ctx: RequestContext): Promise<Record<string, unknown>> {
  const session = requireMember(ctx, 'profile.edit');
  const u = session.userId, m = session.memberId;
  const all = (sql: string, params: unknown[]) => db.query(sql, params);
  const [profile, membership, applications, bookings, payments, requests, deskMessages, connections, messages, notifications, consents, blocks, reports, orders, assistant, enquiries, services, partnerBookings, documents, memory, reminders, calendar, calendarEvents, whatsapp] = await Promise.all([
    all('SELECT full_name, position, company, industry, city, biography, interests, looking_for, can_offer, show_in_directory, updated_at FROM profiles WHERE user_id = $1', [u]),
    all(`SELECT mb.member_number, mb.status, mb.joined_at, t.name AS tier, ARRAY(SELECT role_key FROM user_roles WHERE user_id = mb.user_id) AS roles FROM members mb JOIN membership_tiers t ON t.id = mb.tier_id WHERE mb.user_id = $1`, [u]),
    all('SELECT status, data, submitted_at, decided_at FROM membership_applications WHERE user_id = $1 ORDER BY created_at', [u]),
    all(`SELECT e.title AS experience, e.starts_at, b.seats, b.status, b.ticket_code, b.created_at, b.checked_in_at FROM experience_bookings b JOIN experiences e ON e.id = b.experience_id WHERE b.member_id = $1 ORDER BY b.created_at`, [m]),
    all('SELECT purpose, amount_minor, refunded_minor, currency_code, status, created_at, paid_at, refunded_at FROM payments WHERE user_id = $1 ORDER BY created_at', [u]),
    all('SELECT id, category, subject, details, needed_by, status, created_at FROM concierge_requests WHERE member_id = $1 ORDER BY created_at', [m]),
    all(`SELECT cm.request_id, cm.from_desk, cm.body, cm.created_at FROM concierge_messages cm JOIN concierge_requests r ON r.id = cm.request_id WHERE r.member_id = $1 ORDER BY cm.created_at`, [m]),
    all(`SELECT p.full_name AS member, c.status, (c.requester_id = $1) AS requested_by_me, c.updated_at FROM connections c JOIN members o ON o.id = CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END JOIN profiles p ON p.user_id = o.user_id WHERE $1 IN (c.requester_id, c.addressee_id)`, [m]),
    // Only what the caller wrote: the other member's words are theirs.
    all(`SELECT p.full_name AS sent_to, ms.body, ms.created_at FROM messages ms JOIN conversations c ON c.id = ms.conversation_id JOIN members o ON o.id = CASE WHEN c.member_low = $1 THEN c.member_high ELSE c.member_low END JOIN profiles p ON p.user_id = o.user_id WHERE ms.sender_member_id = $1 ORDER BY ms.created_at`, [m]),
    all('SELECT category, title, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at', [u]),
    all('SELECT consent_key, granted, occurred_at FROM consent_events WHERE user_id = $1 ORDER BY occurred_at', [u]),
    all('SELECT p.full_name AS member, b.created_at FROM member_blocks b JOIN members o ON o.id = b.blocked_id JOIN profiles p ON p.user_id = o.user_id WHERE b.blocker_id = $1', [m]),
    all('SELECT p.full_name AS about, r.reason, r.detail, r.status, r.created_at FROM member_reports r JOIN members o ON o.id = r.reported_id JOIN profiles p ON p.user_id = o.user_id WHERE r.reporter_id = $1', [m]),
    all(`SELECT o.order_number, o.status, o.total_minor, o.currency_code, o.delivery_name, o.delivery_address, o.created_at, (SELECT json_agg(json_build_object('title', i.title, 'option', i.option, 'quantity', i.quantity)) FROM order_items i WHERE i.order_id = o.id) AS items FROM orders o WHERE o.member_id = $1 ORDER BY o.created_at`, [m]),
    all('SELECT role, body, created_at FROM qera_messages WHERE user_id = $1 ORDER BY created_at', [u]),
    all(`SELECT e.topic, e.subject, e.status, e.created_at, (SELECT json_agg(json_build_object('from', CASE WHEN x.from_manager THEN 'manager' ELSE 'me' END, 'body', x.body, 'at', x.created_at) ORDER BY x.created_at) FROM rm_messages x WHERE x.enquiry_id = e.id) AS messages FROM rm_enquiries e WHERE e.member_id = $1 ORDER BY e.created_at`, [m]),
    all('SELECT s.name AS service, r.package_name, r.price_label, r.preferred_date, r.notes, r.status, r.created_at FROM service_requests r JOIN lifestyle_services s ON s.id = r.service_id WHERE r.member_id = $1 ORDER BY r.created_at', [m]),
    all('SELECT p.name AS partner, b.booking_date, b.booking_time, b.party_size, b.notes, b.status, b.created_at FROM partner_bookings b JOIN partners p ON p.id = b.partner_id WHERE b.member_id = $1 ORDER BY b.created_at', [m]),
    all('SELECT kind, title, content, booked, created_at FROM qera_documents WHERE user_id = $1 ORDER BY created_at', [u]),
    all('SELECT kind, label, detail, on_date, source, created_at, updated_at FROM qera_memory WHERE user_id = $1 ORDER BY kind, created_at', [u]),
    all('SELECT text, remind_at, status, source, created_at FROM qera_reminders WHERE user_id = $1 ORDER BY remind_at', [u]),
    // The calendar address itself is a secret and is never exported, only that a calendar is connected.
    all('SELECT provider, label, show_titles, connected_at, synced_at FROM calendar_connections WHERE user_id = $1', [u]),
    all('SELECT title, location, starts_at, ends_at, all_day FROM calendar_events WHERE user_id = $1 ORDER BY starts_at', [u]),
    // The WhatsApp number is held encrypted; the export shows the number it ends with and when it was linked.
    all(`SELECT number_last4 AS number_ends_with, linked_at FROM whatsapp_links WHERE user_id = $1 AND status = 'linked'`, [u]),
  ]);
  // Phones registered for push (never the push token), what is pushed, the saved card (brand, last four, expiry) and the renewal choice.
  const [pushDevices, pushSettings, savedCard, renewal] = await Promise.all([
    all('SELECT platform, device_name, created_at, last_seen_at FROM push_devices WHERE user_id = $1 AND disabled_at IS NULL ORDER BY created_at', [u]),
    all('SELECT muted AS not_pushed, show_details AS details_on_lock_screen FROM push_settings WHERE user_id = $1', [u]),
    all('SELECT brand, last4, exp_month, exp_year, created_at FROM payment_methods WHERE user_id = $1 AND removed_at IS NULL', [u]),
    all('SELECT term_ends_at, auto_renew FROM members WHERE user_id = $1', [u]),
  ]);
  await audit(db, u, 'privacy.data_exported', 'user', u);
  return {
    exportedAt: new Date().toISOString(), email: session.email, profile: profile[0] ?? null, membership: membership[0] ?? null, privacy: await getPrivacy(db, ctx),
    applications, bookings, payments, conciergeRequests: requests, conciergeMessages: deskMessages, connections, messagesSent: messages, notifications,
    consentHistory: consents, blockedMembers: blocks, reportsMade: reports, boutiqueOrders: orders, qeraConversation: assistant, relationshipManagerEnquiries: enquiries, serviceRequests: services, partnerBookings, qeraDocuments: documents, qeraMemory: memory, qeraReminders: reminders, calendar: calendar[0] ?? null, calendarEvents, whatsapp: whatsapp[0] ?? null,
    pushNotifications: { phones: pushDevices, settings: pushSettings[0] ?? null }, membershipRenewal: renewal[0] ?? null, savedCard: savedCard[0] ?? null,
  };
}

/**
 * Closes the caller's account now: bookings are cancelled (and refunded where the rules allow), the membership
 * ends, every session is revoked, and erasure of personal data is scheduled.
 */
export async function closeMyAccount(db: Db, ctx: RequestContext, payments: PaymentProvider, body: unknown): Promise<{ eraseAfter: string }> {
  const session = requireMember(ctx, 'profile.edit');
  if ((body as { confirm?: unknown } | null)?.confirm !== 'CLOSE') throw new HttpError(422, 'Type CLOSE to confirm.', { confirm: 'Type CLOSE to confirm' });
  const live = await db.query<{ id: string }>(`SELECT id FROM experience_bookings WHERE member_id = $1 AND status IN ('applied', 'waitlisted', 'awaiting_payment', 'confirmed')`, [session.memberId]);
  for (const booking of live) await cancelBooking(db, ctx, payments, booking.id);
  return db.tx(async (tx) => {
    await tx.query(`UPDATE members SET status = 'resigned' WHERE id = $1`, [session.memberId]);
    await tx.query('UPDATE profiles SET show_in_directory = false WHERE user_id = $1', [session.userId]);
    await tx.query(`UPDATE concierge_requests SET status = 'cancelled', updated_at = now() WHERE member_id = $1 AND status NOT IN ('completed', 'cancelled')`, [session.memberId]);
    await tx.query(`UPDATE rm_enquiries SET status = 'closed', updated_at = now() WHERE member_id = $1 AND status = 'open'`, [session.memberId]);
    // QÉRA stops reading the member's calendar, and stops answering their WhatsApp, at once.
    await tx.query('DELETE FROM whatsapp_links WHERE user_id = $1', [session.userId]);
    await tx.query('DELETE FROM calendar_events WHERE user_id = $1', [session.userId]);
    await tx.query('DELETE FROM calendar_connections WHERE user_id = $1', [session.userId]);
    // Nothing more is pushed to their phones, and no renewal is charged: the card is forgotten here and at the provider.
    await tx.query('DELETE FROM push_devices WHERE user_id = $1', [session.userId]);
    await tx.query('UPDATE members SET auto_renew = false WHERE id = $1', [session.memberId]);
    const cards = await tx.query<{ provider_token: string }>('UPDATE payment_methods SET removed_at = now() WHERE user_id = $1 AND removed_at IS NULL RETURNING provider_token', [session.userId]);
    for (const c of cards) await payments.removeCard(c.provider_token).catch(() => undefined);
    const closure = await tx.query<{ erase_after: Date }>(
      `INSERT INTO account_closures (user_id, erase_after) VALUES ($1, now() + make_interval(days => $2))
       ON CONFLICT (user_id) DO UPDATE SET requested_at = now(), erase_after = now() + make_interval(days => $2), erased_at = NULL RETURNING erase_after`, [session.userId, ERASURE_DELAY_DAYS]);
    const eraseAfter = new Date(closure[0]!.erase_after).toISOString();
    await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'membership_update', $2)`, [session.userId, `Your Quintara account is closed. Your personal data will be erased on ${eraseAfter.slice(0, 10)}. Reply to this message before then if this was a mistake.`]);
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [session.userId]);
    await audit(tx, session.userId, 'account.closed', 'user', session.userId, { cancelledBookings: live.length });
    return { eraseAfter };
  });
}

/**
 * Removes the personal data of one closed account. Payment and audit records stay, as the law requires,
 * but no longer point at a name or an address.
 */
export async function eraseAccount(db: Db, userId: string, actorUserId: string | null): Promise<boolean> {
  return db.tx(async (tx) => {
    const due = await tx.query('SELECT 1 FROM account_closures WHERE user_id = $1 AND erased_at IS NULL FOR UPDATE', [userId]);
    if (!due[0]) return false;
    const member = (await tx.query<{ id: string }>('SELECT id FROM members WHERE user_id = $1', [userId]))[0]?.id ?? null;
    await tx.query(`UPDATE profiles SET full_name = 'Former member', position = '', company = '', industry = '', city = '', biography = '', interests = '{}', looking_for = '', can_offer = '', avatar_media_id = NULL, show_in_directory = false, updated_at = now() WHERE user_id = $1`, [userId]);
    await tx.query('DELETE FROM media m WHERE m.uploaded_by = $1 AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.avatar_media_id = m.id) AND NOT EXISTS (SELECT 1 FROM products p WHERE p.image_id = m.id) AND NOT EXISTS (SELECT 1 FROM home_slides h WHERE h.media_id = m.id)', [userId]);   // their profile pictures
    await tx.query(`UPDATE membership_applications SET data = '{}'::jsonb, decision_note = NULL, updated_at = now() WHERE user_id = $1`, [userId]);
    await tx.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM email_outbox WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM privacy_settings WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM qera_messages WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM whatsapp_links WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM calendar_events WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM calendar_connections WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM push_devices WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM push_settings WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM payment_methods WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM qera_proposals WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM qera_documents WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM qera_memory WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM qera_reminders WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM qera_nudges WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    // Two-factor secrets and recovery codes go with the account.
    for (const table of ['user_mfa', 'user_mfa_pending', 'mfa_recovery_codes']) await tx.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    if (member) {
      await tx.query(`UPDATE concierge_requests SET subject = 'Removed', details = 'Removed at the member''s request.', needed_by = NULL WHERE member_id = $1`, [member]);
      await tx.query(`UPDATE concierge_messages SET body = '[removed]' WHERE request_id IN (SELECT id FROM concierge_requests WHERE member_id = $1)`, [member]);
      await tx.query(`UPDATE messages SET body = '[removed]' WHERE sender_member_id = $1`, [member]);
      await tx.query('DELETE FROM connections WHERE $1 IN (requester_id, addressee_id)', [member]);
      await tx.query('DELETE FROM member_blocks WHERE $1 IN (blocker_id, blocked_id)', [member]);
      await tx.query(`UPDATE member_reports SET detail = '' WHERE reporter_id = $1`, [member]);
      await tx.query('DELETE FROM experience_invitations WHERE member_id = $1', [member]);
      await tx.query(`UPDATE orders SET delivery_name = 'Former member', delivery_address = 'Removed' WHERE member_id = $1`, [member]);
      await tx.query('DELETE FROM wishlist_items WHERE member_id = $1', [member]);
      await tx.query('DELETE FROM rm_enquiries WHERE member_id = $1', [member]);
      await tx.query(`UPDATE partner_bookings SET notes = '', status = CASE WHEN status IN ('requested', 'confirmed') THEN 'cancelled' ELSE status END WHERE member_id = $1`, [member]);
      await tx.query(`UPDATE service_requests SET contact_name = 'Removed', contact_email = 'removed@invalid', notes = '', status = CASE WHEN status IN ('requested', 'in_progress', 'confirmed') THEN 'cancelled' ELSE status END WHERE member_id = $1`, [member]);
      await tx.query(`UPDATE business_listings SET status = 'closed', title = 'Removed', summary = 'Removed at the member''s request.', sector = '' WHERE member_id = $1`, [member]);
      await tx.query(`UPDATE introductions SET note = 'Removed at the member''s request.', status = CASE WHEN status IN ('requested', 'offered') THEN 'withdrawn' ELSE status END WHERE requester_id = $1`, [member]);
    }
    await tx.query(`UPDATE users SET email = NULL, status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1`, [userId]);
    await tx.query('UPDATE account_closures SET erased_at = now() WHERE user_id = $1', [userId]);
    await audit(tx, actorUserId, 'account.erased', 'user', userId);
    return true;
  });
}

/** Erases every closed account whose cooling-off period has ended. Run on a schedule. */
export async function eraseDueAccounts(db: Db): Promise<number> {
  const due = await db.query<{ user_id: string }>('SELECT user_id FROM account_closures WHERE erased_at IS NULL AND erase_after <= now()');
  let erased = 0;
  for (const row of due) if (await eraseAccount(db, row.user_id, null)) erased++;
  return erased;
}
