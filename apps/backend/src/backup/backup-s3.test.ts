import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { BackupS3Target } from '@capi-navigator/shared';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backupsToDelete,
  explainS3,
  sdkS3,
  testTarget,
  uploadBackup,
  type S3Calls,
} from './backup-s3.js';

const target = {
  bucket: 'backups',
  prefix: 'capi-navigator/',
  region: 'us-east-1',
  forcePathStyle: true,
  insecureSkipTLSVerify: false,
};
const name = (d: string) => `capi-navigator/capi-navigator-home-${d}T030000Z.tar.gz.gpg`;

/** In-memory bucket; records the commands it gets. */
function fakeS3(objects: string[] = [], fail?: { command: string; name: string }) {
  const keys = new Set(objects);
  const calls: string[] = [];
  const s3: S3Calls = {
    send: async (cmd: unknown) => {
      const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
      calls.push(c.constructor.name);
      if (fail?.command === c.constructor.name)
        throw Object.assign(new Error(fail.name), { name: fail.name });
      const key = c.input.Key as string;
      switch (c.constructor.name) {
        case 'PutObjectCommand':
          keys.add(key);
          return {};
        case 'GetObjectCommand':
          return { Body: { transformToString: async () => String(store.get(key) ?? '') } };
        case 'DeleteObjectCommand':
          keys.delete(key);
          return {};
        case 'ListObjectsV2Command': {
          const all = [...keys].filter((k) => k.startsWith(c.input.Prefix as string)).sort();
          // Two pages, to cover paging.
          const first = !c.input.ContinuationToken;
          const page = first ? all.slice(0, 2) : all.slice(2);
          return {
            Contents: page.map((Key) => ({ Key })),
            ...(first && all.length > 2 ? { NextContinuationToken: 'next' } : {}),
          };
        }
        default:
          throw new Error(`unexpected ${c.constructor.name}`);
      }
    },
  };
  const store = new Map<string, unknown>();
  const put = s3.send;
  s3.send = async (cmd: unknown) => {
    const c = cmd as { constructor: { name: string }; input: { Key?: string; Body?: unknown } };
    if (c.constructor.name === 'PutObjectCommand' && c.input.Key)
      store.set(c.input.Key, c.input.Body);
    return put(cmd);
  };
  return { s3, keys, calls };
}

describe('backups on S3 (FP38-F-10 to F-14)', () => {
  it('keeps the newest backups and never touches other objects (FP38-F-12)', () => {
    const keys = [
      name('20261120'),
      name('20261122'),
      name('20261121'),
      'capi-navigator/notes.txt',
      'capi-navigator/capi-navigator-home-latest.tar.gz.gpg',
      'other/capi-navigator-home-20261101T030000Z.tar.gz.gpg',
      'capi-navigator/sub/capi-navigator-home-20261101T030000Z.tar.gz.gpg',
    ];
    expect(backupsToDelete(keys, 'capi-navigator/', 2)).toEqual([name('20261120')]);
    expect(backupsToDelete(keys, 'capi-navigator/', 5)).toEqual([]);
    expect(backupsToDelete([name('20261120')], '', 1)).toEqual([]);
  });

  it('uploads, lists all pages and deletes beyond the retention', async () => {
    const { s3, keys } = fakeS3([name('20261120'), name('20261121'), 'capi-navigator/keep.txt']);
    const result = await uploadBackup(
      s3,
      target,
      'capi-navigator-home-20261122T030000Z.tar.gz.gpg',
      new Uint8Array([1, 2, 3]),
      2,
    );
    expect(result).toEqual({ key: name('20261122'), deleted: [name('20261120')] });
    expect([...keys].sort()).toEqual(
      [name('20261121'), name('20261122'), 'capi-navigator/keep.txt'].sort(),
    );
  });

  it('tests a target by writing, reading, listing and deleting a test object (FP38-F-14)', async () => {
    const ok = fakeS3();
    expect(await testTarget(ok.s3, target)).toMatchObject({ ok: true });
    expect(ok.calls).toEqual([
      'PutObjectCommand',
      'GetObjectCommand',
      'ListObjectsV2Command',
      'DeleteObjectCommand',
    ]);
    expect(ok.keys.size).toBe(0);
    const denied = fakeS3([], { command: 'DeleteObjectCommand', name: 'AccessDenied' });
    expect(await testTarget(denied.s3, target)).toMatchObject({
      ok: false,
      message: 'S3 delete failed: access denied',
      hint: expect.stringContaining('s3:DeleteObject'),
    });
  });

  it('explains S3 errors without secrets (NF-06)', () => {
    const e = (name: string, message = name) => Object.assign(new Error(message), { name });
    expect(explainS3(e('NoSuchBucket'), 'upload').hint).toMatch(/does not create buckets/);
    expect(explainS3(e('InvalidAccessKeyId'), 'upload').message).toMatch(/access key was rejected/);
    expect(explainS3(e('Error', 'getaddrinfo ENOTFOUND minio'), 'write').message).toMatch(
      /not reachable/,
    );
    expect(explainS3(e('Error', 'self-signed certificate'), 'write').hint).toMatch(
      /CA certificate/,
    );
  });
});

describe('TLS of the S3 endpoint (FP38-F-10)', () => {
  // A local HTTPS endpoint with a self-signed certificate, made by openssl for this run.
  let dir: string;
  let cert: string;
  let server: Server;
  let endpoint: string;
  const list = (t: Partial<BackupS3Target>) =>
    sdkS3(
      { ...target, ...t, endpoint },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-secret' },
      {},
    ).send(new ListObjectsV2Command({ Bucket: 'backups' }));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 's3-tls-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (_req, res) => {
      res.setHeader('content-type', 'application/xml');
      res.end('<?xml version="1.0"?><ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a self-signed certificate by default and explains it', async () => {
    const err = await list({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(explainS3(err, 'test').hint).toMatch(/CA certificate.*skip the TLS verification/);
  });

  it('accepts it with its CA certificate', async () => {
    await expect(list({ caCertificate: cert })).resolves.toMatchObject({ KeyCount: 0 });
  });

  it('accepts it without the check when insecureSkipTLSVerify is set', async () => {
    await expect(list({ insecureSkipTLSVerify: true })).resolves.toMatchObject({ KeyCount: 0 });
  });
});
