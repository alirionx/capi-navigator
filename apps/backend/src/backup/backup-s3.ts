import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  BACKUP_OBJECT_PATTERN,
  type BackupS3Credentials,
  type BackupS3Target,
  type BackupS3TestResult,
} from '@capi-navigator/shared';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { randomBytes } from 'node:crypto';
import { rootCertificates } from 'node:tls';

/** The S3 calls of the backup; replaceable in tests. */
export interface S3Calls {
  send(cmd: unknown): Promise<unknown>;
}
export type S3Factory = (target: BackupS3Target, credentials: BackupS3Credentials) => S3Calls;

const TIMEOUT_MS = 30_000;

/**
 * S3 client for a backup target (FP38-F-10): AWS or S3-compatible storage (endpoint, path-style),
 * an optional CA or no certificate check at all, and the app's outbound proxy (FP29-F-01, as for
 * the AWS calls).
 */
export const sdkS3 = (
  target: BackupS3Target,
  credentials: BackupS3Credentials,
  env: NodeJS.ProcessEnv = process.env,
): S3Client => {
  const proxy = env.NODE_USE_ENV_PROXY === '1' ? { proxyEnv: env } : {};
  const ca = target.insecureSkipTLSVerify
    ? { rejectUnauthorized: false }
    : target.caCertificate
      ? { ca: [...rootCertificates, target.caCertificate] }
      : {};
  return new S3Client({
    region: target.region,
    ...(target.endpoint ? { endpoint: target.endpoint } : {}),
    forcePathStyle: target.forcePathStyle,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    maxAttempts: 2,
    requestHandler: {
      requestTimeout: TIMEOUT_MS,
      connectionTimeout: TIMEOUT_MS,
      httpAgent: new HttpAgent({ keepAlive: true, ...proxy }),
      httpsAgent: new HttpsAgent({ keepAlive: true, ...proxy, ...ca }),
    },
  });
};

/**
 * FP38-F-12: the backups beyond the newest `keep`, by key. Only names the app writes count; other
 * objects under the prefix (and anything outside it) are never touched. The UTC time in the name
 * sorts like the time itself.
 */
export function backupsToDelete(
  keys: string[],
  prefix: string,
  keep: number,
  pattern: RegExp = BACKUP_OBJECT_PATTERN,
): string[] {
  const ours = keys
    .filter((k) => k.startsWith(prefix) && pattern.test(k.slice(prefix.length)))
    .sort()
    .reverse();
  return ours.slice(keep);
}

/** Uploads a backup and applies the retention; returns the deleted keys. */
export async function uploadBackup(
  s3: S3Calls,
  target: BackupS3Target,
  fileName: string,
  data: Uint8Array,
  keep: number,
  /** FP39-F-12: a management cluster's folder and names; default: the home backups. */
  folder: { prefix: string; pattern: RegExp } = {
    prefix: target.prefix,
    pattern: BACKUP_OBJECT_PATTERN,
  },
): Promise<{ key: string; deleted: string[] }> {
  const key = `${folder.prefix}${fileName}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: target.bucket,
      Key: key,
      Body: data,
      ContentType: 'application/pgp-encrypted',
    }),
  );
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = (await s3.send(
      new ListObjectsV2Command({
        Bucket: target.bucket,
        Prefix: folder.prefix,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    )) as { Contents?: { Key?: string }[]; NextContinuationToken?: string };
    keys.push(...(page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : [])));
    token = page.NextContinuationToken;
  } while (token);
  const deleted = backupsToDelete(keys, folder.prefix, keep, folder.pattern);
  for (const k of deleted) {
    await s3.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: k }));
  }
  return { key, deleted };
}

/**
 * FP38-F-14: writes, reads back and deletes a small test object under the prefix, so a test
 * proves exactly the permissions a backup needs (plus reading).
 */
export async function testTarget(s3: S3Calls, target: BackupS3Target): Promise<BackupS3TestResult> {
  const key = `${target.prefix}.capi-navigator-test-${randomBytes(6).toString('hex')}`;
  const body = `CAPI Navigator connection test ${new Date().toISOString()}`;
  let step = 'write';
  try {
    await s3.send(new PutObjectCommand({ Bucket: target.bucket, Key: key, Body: body }));
    step = 'read';
    const got = (await s3.send(new GetObjectCommand({ Bucket: target.bucket, Key: key }))) as {
      Body?: { transformToString(): Promise<string> };
    };
    if ((await got.Body?.transformToString()) !== body) throw new Error('Read back other content');
    step = 'list';
    await s3.send(
      new ListObjectsV2Command({ Bucket: target.bucket, Prefix: target.prefix, MaxKeys: 1 }),
    );
    step = 'delete';
    await s3.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key }));
    return {
      ok: true,
      message: `Wrote, read, listed and deleted a test object in ${target.bucket}/${target.prefix}`,
    };
  } catch (err) {
    return { ok: false, ...explainS3(err, step) };
  }
}

/** Understandable S3 errors (NF-06); never includes the secret key. */
export function explainS3(
  err: unknown,
  step: string,
): { message: string; hint?: string; details?: string } {
  const name = (err as { name?: string }).name ?? '';
  const details = err instanceof Error ? err.message.slice(0, 500) : String(err);
  const at = `S3 ${step} failed`;
  if (['InvalidAccessKeyId', 'SignatureDoesNotMatch'].includes(name))
    return {
      message: `${at}: the access key was rejected`,
      hint: 'Check the access key ID and secret access key.',
      details,
    };
  if (name === 'AccessDenied' || name === 'Forbidden')
    return {
      message: `${at}: access denied`,
      hint: 'Allow s3:PutObject, s3:GetObject, s3:ListBucket and s3:DeleteObject on the bucket and prefix for this key.',
      details,
    };
  if (name === 'NoSuchBucket')
    return {
      message: `${at}: the bucket does not exist`,
      hint: 'Create the bucket first; the app does not create buckets.',
      details,
    };
  if (
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|TimeoutError|socket hang up/i.test(
      `${name} ${details}`,
    )
  )
    return {
      message: `${at}: the endpoint is not reachable`,
      hint: 'Check the endpoint URL and region, and the outbound proxy of the app (NO_PROXY for an internal endpoint).',
      details,
    };
  if (/certificate|self.signed|unable to verify/i.test(details))
    return {
      message: `${at}: the TLS certificate of the endpoint is not trusted`,
      hint: 'Paste the CA certificate of the endpoint into the S3 settings (or, for a test setup only, skip the TLS verification).',
      details,
    };
  return { message: `${at}`, hint: 'See the details.', details };
}
