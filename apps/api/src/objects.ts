/**
 * Object storage: files kept outside the database, in an S3-compatible bucket (Amazon S3, Cloudflare R2, MinIO,
 * DigitalOcean Spaces and others). Used for photographs (media.ts) and the write-once copies of the audit log (audit-export.ts).
 *
 * The bucket stays private: the API reads from it and serves files under its own addresses, so nothing about the bucket
 * reaches the apps, and the API's cache headers let a CDN in front of /v1/media do the rest.
 */
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ObjectStore {
  readonly name: string;
  put(key: string, bytes: Buffer, contentType: string, options?: { retainUntil?: Date }): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Removes every object whose key starts with `prefix`. Returns how many. */
  deletePrefix(prefix: string): Promise<number>;
}

export interface S3Settings {
  bucket: string;
  region: string;
  /** For S3-compatible services: their address (for example https://<account>.r2.cloudflarestorage.com). */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Path-style addresses (bucket in the path), which MinIO and some others need. */
  forcePathStyle?: boolean;
}

export class S3ObjectStore implements ObjectStore {
  readonly name = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(settings: S3Settings) {
    this.bucket = settings.bucket;
    this.client = new S3Client({
      region: settings.region,
      endpoint: settings.endpoint,
      forcePathStyle: settings.forcePathStyle,
      // Without keys the SDK's own chain is used (an IAM role on AWS, for example).
      credentials: settings.accessKeyId && settings.secretAccessKey ? { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey } : undefined,
    });
  }
  async put(key: string, bytes: Buffer, contentType: string, options: { retainUntil?: Date } = {}) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType,
      // Write-once: in a bucket with Object Lock, nobody can change or delete the object before this date.
      ...(options.retainUntil ? { ObjectLockMode: 'COMPLIANCE' as const, ObjectLockRetainUntilDate: options.retainUntil } : {}),
    }));
  }
  async get(key: string) {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : null;
    } catch (error) {
      if (error instanceof NoSuchKey || (error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }
  async deletePrefix(prefix: string) {
    let removed = 0, token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        removed += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return removed;
  }
}

/** Keeps objects in memory: for tests. */
export class MemoryObjectStore implements ObjectStore {
  readonly name = 'memory';
  readonly objects = new Map<string, { bytes: Buffer; contentType: string; retainUntil?: Date }>();
  async put(key: string, bytes: Buffer, contentType: string, options: { retainUntil?: Date } = {}) { this.objects.set(key, { bytes, contentType, retainUntil: options.retainUntil }); }
  async get(key: string) { return this.objects.get(key)?.bytes ?? null; }
  async deletePrefix(prefix: string) {
    let n = 0;
    for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) { this.objects.delete(key); n++; }
    return n;
  }
}
