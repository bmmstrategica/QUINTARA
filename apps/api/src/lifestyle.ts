/**
 * Lifestyle services that guests and members can ask to book, and the slides in the welcome area of the home page.
 *
 * A booking request is a request, not a payment: the concierge desk arranges it with the provider and replies.
 * A member's name and email are taken from their account; a guest gives theirs, and they are used only to
 * arrange that booking. Requests are visible to the person who made them (members) and to the concierge desk.
 */
import { earliestDate, leadTimeLabel, lifestyleServiceInputSchema, longDay, packagePriceLabel, SERVICE_REQUEST_STATUSES, serviceRequestInputSchema, servicePackageInputSchema } from '@quintara/domain';
import type { HomeSlide, LifestyleService, ServicePackage, ServiceRequest } from '@quintara/domain';
import { marketNow } from './time.ts';
import { z } from 'zod';
import { audit, requireMember, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, HttpError, notFound, validation } from './errors.ts';
import { mediaPath } from './media.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (value: unknown) => (value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : null);
const iso = (value: unknown) => new Date(value as string).toISOString();

/* ---------- Services ---------- */

const toPackage = (row: Row): ServicePackage => ({
  id: row.id as string, name: row.name as string, description: row.description as string, priceMinor: row.price_minor === null ? null : Number(row.price_minor),
  priceBasis: row.price_basis as ServicePackage['priceBasis'], currency: (row.currency_code as string).trim(), leadTimeHours: Number(row.lead_time_hours), duration: row.duration as string,
});
/** `member` decides whether the person to ask for, their email and number are included: members only, as for partners. */
const toService = (row: Row, packages: ServicePackage[] = [], member = true): LifestyleService => ({
  id: row.id as string, name: row.name as string, description: row.description as string, category: row.category as string, packages,
  summary: (row.summary as string) ?? '', area: (row.area as string) ?? '', website: (row.website as string | null) ?? null, offer: (row.offer as string) ?? '', address: (row.address as string) ?? '',
  contactName: member ? (row.contact_name as string) ?? '' : '', contactEmail: member ? (row.contact_email as string) ?? '' : '', contactPhone: member ? (row.contact_phone as string) ?? '' : '',
});

async function packagesFor(db: Queryable, serviceIds: string[], publishedOnly: boolean): Promise<Map<string, (ServicePackage & { status: string; position: number })[]>> {
  const out = new Map<string, (ServicePackage & { status: string; position: number })[]>();
  if (!serviceIds.length) return out;
  const rows = await db.query(`SELECT * FROM service_packages WHERE service_id = ANY($1::uuid[]) ${publishedOnly ? "AND status = 'published'" : ''} ORDER BY position, price_minor NULLS LAST, name`, [serviceIds]);
  for (const row of rows) out.set(row.service_id as string, [...(out.get(row.service_id as string) ?? []), { ...toPackage(row), status: row.status as string, position: Number(row.position) }]);
  return out;
}

/**
 * Open to everyone, signed in or not. Each service comes with its published packages and its directory details;
 * the person to ask for and their contact details are for members only.
 */
export async function listServices(db: Queryable, marketId: string, member = false): Promise<LifestyleService[]> {
  const rows = await db.query(`SELECT * FROM lifestyle_services WHERE status = 'published' AND market_id = $1 ORDER BY position, name`, [marketId]);
  const packages = await packagesFor(db, rows.map((row) => row.id as string), true);
  return rows.map((row) => toService(row, (packages.get(row.id as string) ?? []).map(({ status: _s, position: _p, ...pkg }) => pkg), member));
}

export async function getService(db: Queryable, ctx: RequestContext, id: string): Promise<LifestyleService> {
  const service = UUID.test(id) ? (await listServices(db, ctx.marketId, Boolean(ctx.session))).find((s) => s.id === id) : undefined;
  if (!service) throw notFound('This service is not available.');
  return service;
}

const toRequest = (row: Row): ServiceRequest => ({
  id: row.id as string, serviceName: row.service_name as string, preferredDate: day(row.preferred_date), notes: row.notes as string,
  status: row.status as ServiceRequest['status'], createdAt: iso(row.created_at), packageName: (row.package_name as string | null) ?? null, priceLabel: (row.price_label as string | null) ?? null,
});
const SELECT_REQUEST = `SELECT r.*, s.name AS service_name FROM service_requests r JOIN lifestyle_services s ON s.id = r.service_id`;

export async function requestService(db: Db, ctx: RequestContext, marketId: string, serviceId: string, body: unknown): Promise<ServiceRequest> {
  const parsed = serviceRequestInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data, session = ctx.session;
  const service = UUID.test(serviceId) ? (await db.query(`SELECT id FROM lifestyle_services WHERE id = $1 AND status = 'published' AND market_id = $2`, [serviceId, marketId]))[0] : undefined;
  if (!service) throw notFound('This service is not available.');
  if (!session && !d.guest) throw new HttpError(422, 'Enter your name and email address.', { fullName: 'Enter your name', email: 'Enter your email address' });
  const { today } = await marketNow(db, marketId);
  if (d.preferredDate && d.preferredDate < today) throw new HttpError(422, 'Choose a date from today onwards.', { preferredDate: 'Choose a date from today onwards' });
  // A package, if one is chosen, must belong to this service; its notice period sets the earliest date.
  const pkg = d.packageId ? (UUID.test(d.packageId) ? (await db.query(`SELECT * FROM service_packages WHERE id = $1 AND service_id = $2 AND status = 'published'`, [d.packageId, serviceId]))[0] : undefined) : undefined;
  if (d.packageId && !pkg) throw new HttpError(422, 'Choose one of the packages offered.', { packageId: 'Choose one of the packages offered' });
  const chosen = pkg ? toPackage(pkg) : null;
  if (chosen && d.preferredDate && d.preferredDate < earliestDate(chosen.leadTimeHours, today)) {
    const first = earliestDate(chosen.leadTimeHours, today);
    throw new HttpError(422, `${chosen.name} needs ${chosen.leadTimeHours <= 0 ? 'no notice' : leadTimeLabel(chosen.leadTimeHours)}. The earliest date is ${longDay(first)}.`, { preferredDate: `The earliest date is ${longDay(first)}` });
  }
  if (session) {
    const open = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM service_requests WHERE member_id = $1 AND status IN ('requested', 'in_progress')`, [session.memberId]))[0]!.n);
    if (open >= 20) throw conflict('You have twenty open requests. Please wait for the desk to reply.');
  }
  const id = (await db.query<{ id: string }>(
    'INSERT INTO service_requests (market_id, service_id, member_id, contact_name, contact_email, preferred_date, notes, package_id, package_name, price_label) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
    [marketId, serviceId, session?.memberId ?? null, session ? session.fullName : d.guest!.fullName, session ? session.email : d.guest!.email.toLowerCase(), d.preferredDate ?? null, d.notes, chosen?.id ?? null, chosen?.name ?? null, chosen ? packagePriceLabel(chosen) : null]))[0]!.id;
  await audit(db, session?.userId ?? null, 'service.requested', 'service_request', id, { guest: !session });
  return toRequest((await db.query(`${SELECT_REQUEST} WHERE r.id = $1`, [id]))[0]!);
}

/** A member's own requests. A guest has no list: the desk replies to them by email. */
export async function listMyServiceRequests(db: Queryable, ctx: RequestContext): Promise<ServiceRequest[]> {
  const session = requireMember(ctx, 'concierge.request');
  return (await db.query(`${SELECT_REQUEST} WHERE r.member_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [session.memberId])).map(toRequest);
}

export async function cancelMyServiceRequest(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const session = requireMember(ctx, 'concierge.request');
  const rows = UUID.test(id) ? await db.query(`UPDATE service_requests SET status = 'cancelled', updated_at = now() WHERE id = $1 AND member_id = $2 AND status IN ('requested', 'in_progress', 'confirmed') RETURNING id`, [id, session.memberId]) : [];
  if (!rows[0]) throw notFound('This request is not available.');
  await audit(db, session.userId, 'service.cancelled', 'service_request', id);
}

/* ---------- Services: staff ---------- */

export async function listServicesForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.content.manage');
  const rows = await db.query(`SELECT s.*, (SELECT count(*) FROM service_requests r WHERE r.service_id = s.id) AS requests FROM lifestyle_services s WHERE s.market_id = $1 ORDER BY (s.status = 'archived'), s.position, s.name`, [ctx.marketId]);
  const packages = await packagesFor(db, rows.map((row) => row.id as string), false);
  return rows.map((row) => ({ ...toService(row, packages.get(row.id as string) ?? []), status: row.status as string, position: Number(row.position), requests: Number(row.requests) }));
}

/* ---------- Packages: staff ---------- */

const PACKAGE_COLUMNS: Record<string, string> = { name: 'name', description: 'description', priceMinor: 'price_minor', priceBasis: 'price_basis', leadTimeHours: 'lead_time_hours', duration: 'duration', position: 'position', status: 'status' };

export async function createServicePackage(db: Db, ctx: RequestContext, serviceId: string, body: unknown): Promise<{ id: string }> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const parsed = servicePackageInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  if (!UUID.test(serviceId) || !(await db.query('SELECT 1 FROM lifestyle_services WHERE id = $1', [serviceId]))[0]) throw notFound('This service does not exist.');
  const d = parsed.data;
  const id = (await db.query<{ id: string }>('INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
    [serviceId, d.name, d.description, d.priceMinor, d.priceBasis, d.leadTimeHours, d.duration, d.position, d.status]))[0]!.id;
  await audit(db, staffId, 'service_package.created', 'service_package', id, { serviceId, name: d.name, priceMinor: d.priceMinor });
  return { id };
}

export async function updateServicePackage(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const parsed = servicePackageInputSchema.partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const data = parsed.data as Record<string, unknown>, sent = Object.keys(PACKAGE_COLUMNS).filter((key) => key in ((body ?? {}) as object) && data[key] !== undefined);
  if (!UUID.test(id) || !(await db.query('SELECT 1 FROM service_packages WHERE id = $1', [id]))[0]) throw notFound('This package does not exist.');
  if (!sent.length) return;
  await db.query(`UPDATE service_packages SET ${sent.map((k, i) => `${PACKAGE_COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...sent.map((k) => data[k])]);
  await audit(db, staffId, 'service_package.updated', 'service_package', id, { fields: sent });
}

/** Requests keep the package's name and price as they were, so removing a package changes no record. */
export async function deleteServicePackage(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const rows = UUID.test(id) ? await db.query('DELETE FROM service_packages WHERE id = $1 RETURNING id', [id]) : [];
  if (!rows[0]) throw notFound('This package does not exist.');
  await audit(db, staffId, 'service_package.deleted', 'service_package', id);
}

export async function createService(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<{ id: string }> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const parsed = lifestyleServiceInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  if ((await db.query('SELECT 1 FROM lifestyle_services WHERE market_id = $1 AND lower(name) = lower($2)', [marketId, d.name]))[0]) throw conflict('A service with that name already exists.');
  const id = (await db.query<{ id: string }>(
    `INSERT INTO lifestyle_services (market_id, name, description, category, status, position, summary, area, website, offer, contact_name, contact_email, contact_phone, address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [marketId, d.name, d.description, d.category, d.status, d.position, d.summary, d.area, d.website ?? null, d.offer, d.contactName, d.contactEmail, d.contactPhone, d.address]))[0]!.id;
  await audit(db, staffId, 'service.created', 'lifestyle_service', id, { name: d.name });
  return { id };
}

const SERVICE_COLUMNS: Record<string, string> = {
  name: 'name', description: 'description', category: 'category', status: 'status', position: 'position',
  summary: 'summary', area: 'area', website: 'website', offer: 'offer', contactName: 'contact_name', contactEmail: 'contact_email', contactPhone: 'contact_phone', address: 'address',
};

export async function updateService(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const parsed = lifestyleServiceInputSchema.partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const data = parsed.data as Record<string, unknown>, sent = Object.keys(SERVICE_COLUMNS).filter((key) => key in ((body ?? {}) as object) && data[key] !== undefined);
  if (!UUID.test(id) || !(await db.query('SELECT 1 FROM lifestyle_services WHERE id = $1', [id]))[0]) throw notFound('This service does not exist.');
  if (!sent.length) return;
  await db.query(`UPDATE lifestyle_services SET ${sent.map((k, i) => `${SERVICE_COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...sent.map((k) => data[k] ?? null)]);
  await audit(db, staffId, 'service.updated', 'lifestyle_service', id, { fields: sent });
}

export async function listServiceRequestsForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.concierge.manage');
  const rows = await db.query(`${SELECT_REQUEST} WHERE r.market_id = $1 ORDER BY (r.status IN ('completed', 'cancelled')), r.created_at LIMIT 300`, [ctx.marketId]);
  return rows.map((row) => ({ ...toRequest(row), contactName: row.contact_name as string, contactEmail: row.contact_email as string, isMember: row.member_id !== null }));
}

export async function setServiceRequestStatus(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.concierge.manage');
  const parsed = z.object({ status: z.enum(SERVICE_REQUEST_STATUSES) }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const rows = UUID.test(id) ? await db.query<{ member_user: string | null; service_name: string }>(
    `UPDATE service_requests r SET status = $2, handled_by = $3, updated_at = now() FROM lifestyle_services s
      WHERE r.id = $1 AND s.id = r.service_id AND r.status NOT IN ('completed', 'cancelled') AND r.status <> $2
      RETURNING (SELECT m.user_id FROM members m WHERE m.id = r.member_id) AS member_user, s.name AS service_name`, [id, parsed.data.status, staffId]) : [];
  if (!rows[0]) throw conflict('This request cannot be changed in that way.');
  const note: Record<string, string> = { in_progress: 'is being arranged', confirmed: 'is confirmed', completed: 'is complete', cancelled: 'was cancelled', requested: 'was received' };
  if (rows[0].member_user) await db.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'concierge_update', $2, NULL)`, [rows[0].member_user, `Your request for ${rows[0].service_name} ${note[parsed.data.status]}.`]);
  await audit(db, staffId, 'service.' + parsed.data.status, 'service_request', id);
}

/* ---------- Home page slides ---------- */

const toSlide = (row: Row): HomeSlide => ({ id: row.id as string, kind: row.kind as HomeSlide['kind'], src: row.kind === 'image' ? mediaPath(row.media_id as string) : (row.video_url as string), caption: row.caption as string });

export async function listHomeSlides(db: Queryable, marketId: string): Promise<HomeSlide[]> {
  return (await db.query('SELECT * FROM home_slides WHERE is_active AND market_id = $1 ORDER BY position, created_at LIMIT 12', [marketId])).map(toSlide);
}

export async function listHomeSlidesForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.content.manage');
  return (await db.query('SELECT * FROM home_slides WHERE market_id = $1 ORDER BY position, created_at', [ctx.marketId])).map((row) => ({ ...toSlide(row), isActive: Boolean(row.is_active), position: Number(row.position) }));
}

// A film is a link to where it is hosted (https only), exactly as for Quintara TV. Files are not uploaded here.
const slideSchema = z.union([
  z.object({ kind: z.literal('image'), imageId: z.uuid(), caption: z.string().trim().max(160).default(''), position: z.number().int().min(0).max(10000).default(0) }),
  z.object({ kind: z.literal('video'), videoUrl: z.url({ protocol: /^https$/ }).max(500), caption: z.string().trim().max(160).default(''), position: z.number().int().min(0).max(10000).default(0) }),
]);

export async function createHomeSlide(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<{ id: string }> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const parsed = slideSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  if (d.kind === 'image' && !(await db.query('SELECT 1 FROM media WHERE id = $1', [d.imageId]))[0]) throw new HttpError(422, 'That photograph was not found.', { imageId: 'Not found' });
  if (Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM home_slides WHERE market_id = $1', [marketId]))[0]!.n) >= 12) throw conflict('The home page holds up to twelve slides. Remove one first.');
  const id = (await db.query<{ id: string }>('INSERT INTO home_slides (market_id, kind, media_id, video_url, caption, position) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [marketId, d.kind, d.kind === 'image' ? d.imageId : null, d.kind === 'video' ? d.videoUrl : null, d.caption, d.position]))[0]!.id;
  await audit(db, staffId, 'home_slide.created', 'home_slide', id, { kind: d.kind });
  return { id };
}

export async function updateHomeSlide(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  // `imageId`: a recropped or replaced photograph, for a photograph slide only.
  const parsed = z.object({ caption: z.string().trim().max(160), position: z.number().int().min(0).max(10000), isActive: z.boolean(), imageId: z.uuid() }).partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  const slide = UUID.test(id) ? (await db.query<{ kind: string }>('SELECT kind FROM home_slides WHERE id = $1', [id]))[0] : undefined;
  if (!slide) throw notFound('This slide does not exist.');
  if (d.imageId && slide.kind !== 'image') throw new HttpError(422, 'Only a photograph slide can take a photograph.', { imageId: 'Not a photograph slide' });
  if (d.imageId && !(await db.query('SELECT 1 FROM media WHERE id = $1', [d.imageId]))[0]) throw new HttpError(422, 'That photograph was not found.', { imageId: 'Not found' });
  await db.query('UPDATE home_slides SET caption = COALESCE($2, caption), position = COALESCE($3, position), is_active = COALESCE($4, is_active), media_id = COALESCE($5, media_id) WHERE id = $1',
    [id, d.caption ?? null, d.position ?? null, d.isActive ?? null, d.imageId ?? null]);
  await audit(db, staffId, 'home_slide.updated', 'home_slide', id, d.imageId ? { imageId: d.imageId } : undefined);
}

export async function deleteHomeSlide(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const rows = UUID.test(id) ? await db.query('DELETE FROM home_slides WHERE id = $1 RETURNING id', [id]) : [];
  if (!rows[0]) throw notFound('This slide does not exist.');
  await audit(db, staffId, 'home_slide.deleted', 'home_slide', id);
}
