/**
 * Photographs. Every upload is checked, re-encoded and stored at high quality, with smaller copies for phones.
 *
 * Checks before anything is stored: the declared type must be an allowed image type, the size must be within the
 * limit, the first bytes must really be that kind of image, and the picture may not exceed a pixel limit (so a
 * small file cannot unpack into a huge one). The picture is then decoded and encoded afresh, which also removes
 * everything that is not the picture itself: camera details, GPS location and anything hidden in the file.
 *
 * Staff choose, at upload, how large the stored photograph is (its longest side), how it is framed (a crop),
 * and the quality. From that master, sharper and smaller WebP copies are made at standard widths, and each app
 * asks for the width it needs for the screen in front of it (`?w=`), so a phone gets a crisp picture without
 * downloading the full-size one and a large retina screen gets the full detail.
 *
 * Files are served under an unguessable id with headers that stop a browser treating them as anything but an image.
 */
import sharp from 'sharp';
import { z } from 'zod';
import { audit, requireMember, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Queryable } from './db.ts';
import { HttpError, notFound, validation } from './errors.ts';

/** The largest file staff can upload: a full-resolution camera or phone original. */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
/** A member's profile picture. */
export const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
/** Kept for the JSON upload route, which carries the file as base64. */
export const MAX_IMAGE_BYTES = MAX_AVATAR_BYTES;
/** About 120 megapixels: larger than any camera in common use, small enough that decoding stays safe. */
const MAX_INPUT_PIXELS = 120_000_000;
/** The longest side a stored photograph can have. */
export const MAX_EDGE = 8000;
/** The widths of the copies made for screens of different sizes. */
export const PHOTO_WIDTHS = [480, 960, 1440, 2048, 2880, 3840] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/tiff'] as const;
type UploadType = (typeof UPLOAD_TYPES)[number];
type StoredType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface StoredImage { contentType: StoredType; bytes: Buffer; width: number; height: number }
/** A photograph ready to store: the master and its smaller copies. */
export interface ProcessedPhoto { master: StoredImage; variants: StoredImage[] }

/** Where image bytes live. The database version below is for development; production swaps in object storage. */
export interface MediaStore {
  put(photo: ProcessedPhoto, uploadedBy: string): Promise<string>;
  /** The best file for a screen `width` pixels wide (null: the master). WebP copies only for callers that accept WebP. */
  get(id: string, want?: { width: number | null; webp: boolean }): Promise<{ contentType: string; bytes: Buffer } | null>;
}

export function createDbMediaStore(db: Queryable): MediaStore {
  return {
    async put({ master, variants }, uploadedBy) {
      const id = (await db.query<{ id: string }>('INSERT INTO media (content_type, byte_size, data_base64, uploaded_by, width, height) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [master.contentType, master.bytes.length, master.bytes.toString('base64'), uploadedBy, master.width, master.height]))[0]!.id;
      for (const v of variants) {
        await db.query('INSERT INTO media_variants (media_id, width, height, content_type, byte_size, data_base64) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, v.width, v.height, v.contentType, v.bytes.length, v.bytes.toString('base64')]);
      }
      return id;
    },
    async get(id, want) {
      if (!UUID.test(id)) return null;
      if (want?.webp) {
        // The smallest copy at least as wide as asked for; without a width, the largest copy.
        const rows = await db.query<{ content_type: string; data_base64: string }>(
          `SELECT content_type, data_base64 FROM media_variants WHERE media_id = $1 AND content_type = 'image/webp'
            ORDER BY ${want.width ? '(width < $2), CASE WHEN width >= $2 THEN width ELSE -width END' : 'width DESC'} LIMIT 1`, want.width ? [id, want.width] : [id]);
        if (rows[0]) return { contentType: rows[0].content_type, bytes: Buffer.from(rows[0].data_base64, 'base64') };
      }
      const row = (await db.query<{ content_type: string; data_base64: string }>('SELECT content_type, data_base64 FROM media WHERE id = $1', [id]))[0];
      return row ? { contentType: row.content_type, bytes: Buffer.from(row.data_base64, 'base64') } : null;
    },
  };
}

/** What the file actually is, judged from its first bytes rather than from what the uploader says. */
export function sniff(bytes: Buffer): UploadType | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length > 12 && bytes.toString('latin1', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(bytes.toString('latin1', 8, 12))) return 'image/avif';
  if (bytes.length > 4 && (bytes.toString('latin1', 0, 4) === 'II*\0' || bytes.toString('latin1', 0, 4) === 'MM\0*')) return 'image/tiff';
  return null;
}

/** How staff want the photograph stored. Sent with the upload. */
export const photoOptionsSchema = z.object({
  /** The longest side, in pixels. Never enlarged: a smaller picture is kept at its own size. */
  maxEdge: z.coerce.number().int().min(320).max(MAX_EDGE).default(4096),
  /** 70 to 100. 92 keeps fine detail with no visible loss. */
  quality: z.coerce.number().int().min(70).max(100).default(92),
  /** The part of the picture to keep, as fractions of its width and height (after it is turned upright). */
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) })
    .refine((c) => c.x + c.width <= 1.0001 && c.y + c.height <= 1.0001, 'The crop must sit inside the picture').nullable().optional(),
});
export type PhotoOptions = z.infer<typeof photoOptionsSchema>;

/** Reads the options from a query string: maxEdge, quality and crop as "x,y,width,height". */
export function photoOptionsFromQuery(query: Record<string, string | undefined>): PhotoOptions {
  const crop = query.crop ? query.crop.split(',').map(Number) : null;
  const parsed = photoOptionsSchema.safeParse({
    maxEdge: query.maxEdge, quality: query.quality,
    crop: crop && crop.length === 4 && crop.every(Number.isFinite) ? { x: crop[0], y: crop[1], width: crop[2], height: crop[3] } : crop ? { x: -1, y: -1, width: 0, height: 0 } : null,
  });
  if (!parsed.success) throw validation(parsed.error.issues);
  return parsed.data;
}

const tooLarge = (limit: number) => new HttpError(413, `Photographs can be up to ${Math.round(limit / 1024 / 1024)} MB.`, { file: 'Too large' });

/** Checks a photograph, turns it upright, crops and resizes it as asked, and makes the screen copies. */
export async function processPhoto(bytes: Buffer, declared: string, options: PhotoOptions, limit = MAX_UPLOAD_BYTES): Promise<ProcessedPhoto> {
  if (bytes.length > limit) throw tooLarge(limit);
  if (!(UPLOAD_TYPES as readonly string[]).includes(declared) || sniff(bytes) !== declared) throw new HttpError(422, 'That file is not a JPEG, PNG, WebP, AVIF or TIFF image.', { file: 'Not an image' });
  const open = () => sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', sequentialRead: true });
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try { meta = await open().metadata(); } catch { throw new HttpError(422, 'That photograph could not be read. It may be damaged, or too large.', { file: 'Unreadable' }); }
  if (!meta.width || !meta.height) throw new HttpError(422, 'That photograph could not be read.', { file: 'Unreadable' });
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new HttpError(422, 'That photograph has too many pixels. Up to 120 megapixels can be uploaded.', { file: 'Too many pixels' });
  // Upright size: phones often store a portrait photograph sideways with a note to turn it.
  const upright = meta.autoOrient ?? { width: meta.width, height: meta.height };

  let pipeline = open().rotate();
  if (options.crop) {
    const left = Math.min(upright.width - 1, Math.round(options.crop.x * upright.width)), top = Math.min(upright.height - 1, Math.round(options.crop.y * upright.height));
    const width = Math.max(1, Math.min(upright.width - left, Math.round(options.crop.width * upright.width))), height = Math.max(1, Math.min(upright.height - top, Math.round(options.crop.height * upright.height)));
    if (width < 64 || height < 64) throw new HttpError(422, 'That crop is too small. Keep at least 64 pixels each way.', { crop: 'Too small' });
    pipeline = pipeline.extract({ left, top, width, height });
  }
  // The master: the longest side at most maxEdge, never enlarged, Lanczos resampling, converted to sRGB for screens.
  pipeline = pipeline.resize({ width: options.maxEdge, height: options.maxEdge, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' }).toColourspace('srgb');
  const alpha = Boolean(meta.hasAlpha);
  const encoded = alpha
    ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true })
    // High quality keeps full colour detail (no chroma subsampling) so fabrics, type and edges stay clean.
    : await pipeline.jpeg({ quality: options.quality, mozjpeg: true, chromaSubsampling: options.quality >= 90 ? '4:4:4' : '4:2:0' }).toBuffer({ resolveWithObject: true });
  const master: StoredImage = { contentType: alpha ? 'image/png' : 'image/jpeg', bytes: encoded.data, width: encoded.info.width, height: encoded.info.height };

  // WebP copies: every standard width smaller than the master, and one at the master's own size.
  const widths = [...PHOTO_WIDTHS.filter((w) => w < master.width), master.width];
  const webpQuality = Math.min(options.quality, 95);
  const variants = await Promise.all(widths.map(async (width) => {
    const out = await sharp(master.bytes).resize({ width, kernel: 'lanczos3' }).webp({ quality: webpQuality, alphaQuality: 100, smartSubsample: true, effort: 5 }).toBuffer({ resolveWithObject: true });
    return { contentType: 'image/webp' as const, bytes: out.data, width: out.info.width, height: out.info.height };
  }));
  return { master, variants };
}

/** A member's own profile picture: checked and cleaned like a staff upload, kept at 1200 pixels. Returns the stored image's id. */
export async function storeMemberImage(store: MediaStore, ctx: RequestContext, body: unknown): Promise<string> {
  const session = requireMember(ctx, 'profile.edit');
  const { contentType, bytes } = decodeJson(body, MAX_AVATAR_BYTES);
  return store.put(await processPhoto(bytes, contentType, { maxEdge: 1200, quality: 90, crop: null }, MAX_AVATAR_BYTES), session.userId);
}

export interface UploadedPhoto { id: string; path: string; width: number; height: number; bytes: number }

/** Staff upload with the file sent as base64 JSON (small files, and older clients). */
export async function uploadImage(db: Queryable, store: MediaStore, ctx: RequestContext, body: unknown): Promise<UploadedPhoto> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const { contentType, bytes, options } = decodeJson(body, MAX_IMAGE_BYTES);
  return save(db, store, staffId, await processPhoto(bytes, contentType, options, MAX_IMAGE_BYTES));
}

/** Staff upload with the file sent as it is (the body is the image), and the options in the query string. Up to 40 MB. */
export async function uploadPhoto(db: Queryable, store: MediaStore, ctx: RequestContext, contentType: string | undefined, body: unknown, query: Record<string, string | undefined>): Promise<UploadedPhoto> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(422, 'Choose a photograph.', { file: 'Missing' });
  const options = photoOptionsFromQuery(query);
  return save(db, store, staffId, await processPhoto(body, (contentType ?? '').split(';')[0]!.trim().toLowerCase(), options));
}

async function save(db: Queryable, store: MediaStore, staffId: string, photo: ProcessedPhoto): Promise<UploadedPhoto> {
  const id = await store.put(photo, staffId);
  await audit(db, staffId, 'media.uploaded', 'media', id, { width: photo.master.width, height: photo.master.height, bytes: photo.master.bytes.length });
  return { id, path: mediaPath(id), width: photo.master.width, height: photo.master.height, bytes: photo.master.bytes.length };
}

function decodeJson(body: unknown, limit: number) {
  const parsed = z.object({
    contentType: z.enum(UPLOAD_TYPES), dataBase64: z.string().min(16).max(Math.ceil(limit / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]+=*$/),
    options: photoOptionsSchema.optional(),
  }).safeParse(body);
  if (!parsed.success) {
    if (parsed.error.issues.some((i) => i.path[0] === 'dataBase64' && i.code === 'too_big')) throw tooLarge(limit);
    throw validation(parsed.error.issues);
  }
  return { contentType: parsed.data.contentType, bytes: Buffer.from(parsed.data.dataBase64, 'base64'), options: parsed.data.options ?? photoOptionsSchema.parse({}) };
}

export const mediaPath = (id: string) => `/v1/media/${id}`;

export async function readImage(store: MediaStore, id: string, width?: string, accept?: string) {
  const w = width && /^\d{2,4}$/.test(width) ? Math.min(Number(width), MAX_EDGE) : null;
  const found = await store.get(id, { width: w, webp: /image\/webp|\*\/\*/.test(accept ?? '') });
  if (!found) throw notFound('This image is not available.');
  return found;
}
