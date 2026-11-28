import { describe, expect, it } from 'vitest';
import { auditText, decide, MISSED_AFTER_MS } from './backup-scheduler.service.js';

const s3 = {
  bucket: 'b',
  prefix: 'p/',
  region: 'us-east-1',
  forcePathStyle: false,
  insecureSkipTLSVerify: false,
};
const on = {
  schedule: { enabled: true, cron: '0 3 * * *', keep: 14 },
  s3,
  recipients: [{ publicKey: 'k' }],
};
const at = (iso: string) => new Date(iso);

describe('backup schedule (FP38-F-11)', () => {
  it('runs a due time once', () => {
    expect(decide(on, undefined, at('2026-11-27T03:00:20Z'))).toEqual({
      action: 'run',
      due: at('2026-11-27T03:00:00Z'),
    });
    expect(decide(on, '2026-11-27T03:00:00.000Z', at('2026-11-27T03:00:50Z'))).toEqual({
      action: 'none',
    });
    expect(decide(on, '2026-11-27T03:00:00.000Z', at('2026-11-28T03:00:10Z'))).toMatchObject({
      action: 'run',
      due: at('2026-11-28T03:00:00Z'),
    });
  });

  it('skips a due time noticed too late instead of catching up', () => {
    const late = new Date(at('2026-11-27T03:00:00Z').getTime() + MISSED_AFTER_MS + 1000);
    expect(decide(on, '2026-11-26T03:00:00.000Z', late)).toEqual({
      action: 'skip',
      due: at('2026-11-27T03:00:00Z'),
    });
  });

  it('does nothing while switched off or without target or key', () => {
    const now = at('2026-11-27T03:00:20Z');
    expect(decide({ ...on, schedule: { ...on.schedule, enabled: false } }, undefined, now)).toEqual(
      {
        action: 'none',
      },
    );
    expect(decide({ ...on, s3: undefined }, undefined, now)).toEqual({ action: 'none' });
    expect(decide({ ...on, recipients: [] }, undefined, now)).toEqual({ action: 'none' });
  });
});

describe('two replicas (FP38-F-11)', () => {
  /** One Lease object shared by both replicas, as in the API server. */
  function sharedLeases() {
    let lease: { metadata: { name: string; resourceVersion: string }; spec: object } | undefined;
    let rv = 1;
    const notFound = () => Object.assign(new Error('HTTP 404'), { code: 404 });
    return {
      readNamespacedLease: async () => {
        if (!lease) throw notFound();
        return structuredClone(lease);
      },
      createNamespacedLease: async ({
        body,
      }: {
        body: { metadata: { name: string }; spec: object };
      }) => {
        if (lease) throw Object.assign(new Error('HTTP 409'), { code: 409 });
        lease = { metadata: { ...body.metadata, resourceVersion: String(rv++) }, spec: body.spec };
        return lease;
      },
      replaceNamespacedLease: async ({ body }: { body: typeof lease }) => {
        if (body!.metadata.resourceVersion !== lease!.metadata.resourceVersion)
          throw Object.assign(new Error('HTTP 409'), { code: 409 });
        lease = { ...body!, metadata: { ...body!.metadata, resourceVersion: String(rv++) } };
        return lease;
      },
    };
  }

  it('runs each due time on exactly one replica, also after a takeover', async () => {
    const { BackupSchedulerService } = await import('./backup-scheduler.service.js');
    const leases = sharedLeases();
    let lastScheduledAt: string | undefined;
    const runs: string[] = [];
    const backup = {
      storedSpec: async () => on,
      lastScheduledAt: async () => lastScheduledAt,
      setLastScheduledAt: async (at: string) => {
        lastScheduledAt = at;
      },
      runToS3: async () => {
        runs.push(lastScheduledAt!);
        return { run: { outcome: 'success' as const }, summary: 'ok' };
      },
    };
    const audit = { record: async () => undefined };
    const replica = (pod: string) =>
      new BackupSchedulerService(
        { homeCluster: () => ({ makeApiClient: () => leases }) } as never,
        { namespace: 'ns' } as never,
        backup as never,
        audit as never,
        { POD_NAME: pod } as never,
      );
    const a = replica('pod-a');
    const b = replica('pod-b');
    const t1 = at('2026-11-27T03:00:10Z');
    expect(await Promise.all([a.tick(t1), b.tick(t1)])).toEqual(['run', 'not-leader']);
    expect(await a.tick(at('2026-11-27T03:00:40Z'))).toBe('none');
    // pod-a is gone; its Lease (5 minutes) has expired by the next due time.
    const t2 = at('2026-11-28T03:00:10Z');
    expect(await b.tick(t2)).toBe('run');
    expect(await b.tick(at('2026-11-28T03:00:40Z'))).toBe('none');
    expect(runs).toEqual(['2026-11-27T03:00:00.000Z', '2026-11-28T03:00:00.000Z']);
  });
});

describe('audit message of a scheduled run (FP39-F-13)', () => {
  const base = { startedAt: 'a', finishedAt: 'b', trigger: 'schedule' as const };
  it('names what was uploaded and every failed management cluster', () => {
    expect(
      auditText(
        {
          ...base,
          outcome: 'failure',
          objectKey: 'nav/home.gpg',
          message: '1 of 2 management clusters failed: gone',
          targets: [
            { connection: 'prod', outcome: 'success', objectKey: 'nav/mgmt/prod/x.gpg' },
            { connection: 'gone', outcome: 'failure', message: 'not reachable' },
          ],
        },
        'home: 29 objects | prod: 40 objects',
      ),
    ).toBe('home: 29 objects | prod: 40 objects | gone: not reachable');
  });

  it('keeps the reason of a failed home backup', () => {
    expect(auditText({ ...base, outcome: 'failure', message: 'S3 upload failed' })).toBe(
      'S3 upload failed',
    );
    expect(auditText({ ...base, outcome: 'success', objectKey: 'k' })).toBeUndefined();
  });
});
