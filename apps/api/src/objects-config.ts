/** Reads the object storage settings from the environment. */
import { S3ObjectStore } from './objects.ts';
import type { ObjectStore } from './objects.ts';

/** The bucket for photographs: MEDIA_S3_BUCKET (and region, endpoint and keys). Null when not set. */
export function mediaObjectStore(env: (key: string) => string): ObjectStore | null {
  return bucketFrom(env, 'MEDIA_S3');
}

/** The write-once bucket for audit log copies: AUDIT_S3_BUCKET (and the rest). Null when not set. */
export function auditObjectStore(env: (key: string) => string): ObjectStore | null {
  return bucketFrom(env, 'AUDIT_S3');
}

function bucketFrom(env: (key: string) => string, prefix: string): ObjectStore | null {
  const bucket = env(`${prefix}_BUCKET`);
  if (!bucket) return null;
  return new S3ObjectStore({
    bucket,
    region: env(`${prefix}_REGION`) || 'auto',
    endpoint: env(`${prefix}_ENDPOINT`) || undefined,
    accessKeyId: env(`${prefix}_ACCESS_KEY_ID`) || undefined,
    secretAccessKey: env(`${prefix}_SECRET_ACCESS_KEY`) || undefined,
    forcePathStyle: env(`${prefix}_PATH_STYLE`) === 'true',
  });
}
