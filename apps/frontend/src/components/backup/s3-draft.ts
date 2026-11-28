import type { BackupSettings, BackupSettingsInput } from '@capi-navigator/shared';

/** Edited S3 target and schedule of the backup page (FP38-F-10). */
export interface S3Draft {
  enabled: boolean;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  caCertificate: string;
  insecureSkipTLSVerify: boolean;
  /** Write-only: empty keeps the stored key. */
  accessKeyId: string;
  secretAccessKey: string;
  schedule: { enabled: boolean; cron: string; keep: number };
}

export function s3Draft(s: BackupSettings | null): S3Draft {
  return {
    enabled: !!s?.s3,
    bucket: s?.s3?.bucket ?? '',
    prefix: s?.s3?.prefix ?? 'capi-navigator/',
    region: s?.s3?.region ?? 'us-east-1',
    endpoint: s?.s3?.endpoint ?? '',
    forcePathStyle: s?.s3?.forcePathStyle ?? false,
    caCertificate: s?.s3?.caCertificate ?? '',
    insecureSkipTLSVerify: s?.s3?.insecureSkipTLSVerify ?? false,
    accessKeyId: '',
    secretAccessKey: '',
    schedule: { ...(s?.schedule ?? { enabled: false, cron: '0 3 * * *', keep: 14 }) },
  };
}

/** The S3 part of the PUT body; optional fields left out when empty. */
export function s3Body(d: S3Draft): Pick<BackupSettingsInput, 's3' | 's3Credentials' | 'schedule'> {
  return {
    schedule: { ...d.schedule, cron: d.schedule.cron.trim() },
    ...(d.enabled ? { s3: s3Target(d) } : {}),
    ...(d.enabled && d.accessKeyId && d.secretAccessKey
      ? { s3Credentials: { accessKeyId: d.accessKeyId, secretAccessKey: d.secretAccessKey } }
      : {}),
  };
}

export function s3Target(d: S3Draft) {
  return {
    bucket: d.bucket.trim(),
    prefix: d.prefix.trim(),
    region: d.region.trim(),
    forcePathStyle: d.forcePathStyle,
    insecureSkipTLSVerify: d.insecureSkipTLSVerify,
    ...(d.endpoint.trim() ? { endpoint: d.endpoint.trim() } : {}),
    // The CA is pointless without the check.
    ...(d.caCertificate.trim() && !d.insecureSkipTLSVerify
      ? { caCertificate: d.caCertificate.trim() }
      : {}),
  };
}

/** Whether the draft differs from what is stored; a typed access key counts. */
export function s3Dirty(d: S3Draft, s: BackupSettings | null): boolean {
  const before = s3Draft(s);
  return (
    JSON.stringify({ ...d, accessKeyId: '', secretAccessKey: '' }) !== JSON.stringify(before) ||
    !!d.accessKeyId ||
    !!d.secretAccessKey
  );
}
