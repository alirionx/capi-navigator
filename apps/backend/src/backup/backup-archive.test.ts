import { describe, expect, it } from 'vitest';
import { readFromChartArchive } from '../helm/chart-archive.js';
import {
  BACKUP_FORMAT,
  buildBackupEntries,
  cleanObject,
  packArchive,
  type BackupInput,
} from './backup-archive.js';

const API = 'navigator.capi-navigator.io/v1alpha1';

const input: BackupInput = {
  createdAt: new Date('2026-11-27T10:15:00.000Z'),
  createdBy: 'admin',
  appVersion: '0.22.0',
  namespace: 'capi-navigator-system',
  includesAuditEvents: true,
  recipients: ['0123456789ABCDEF0123456789ABCDEF01234567'],
  groups: [
    {
      kind: 'Secret',
      file: 'secrets',
      objects: [
        cleanObject(
          {
            metadata: {
              name: 'navigator-user-admin-password',
              labels: {
                'capi-navigator.io/user': 'admin',
                'app.kubernetes.io/part-of': 'capi-navigator',
              },
            },
            type: 'Opaque',
            data: { hash: 'c2NyeXB0JC4uLg==' },
          },
          'v1',
          'Secret',
        ),
      ],
    },
    { kind: 'ConfigMap', file: 'configmaps', objects: [] },
    {
      kind: 'NavigatorUser',
      file: 'navigatorusers',
      objects: [
        cleanObject(
          {
            apiVersion: API,
            kind: 'NavigatorUser',
            metadata: { name: 'zoe' },
            spec: { bindings: [{ role: 'viewer' }] },
          },
          API,
          'NavigatorUser',
        ),
        cleanObject(
          {
            apiVersion: API,
            kind: 'NavigatorUser',
            metadata: { name: 'admin' },
            spec: { bindings: [{ role: 'admin' }] },
          },
          API,
          'NavigatorUser',
        ),
      ],
    },
  ],
};

describe('backup archive (FP38-F-04)', () => {
  it('strips server-set metadata, the namespace and the status', () => {
    const cleaned = cleanObject(
      {
        apiVersion: API,
        kind: 'NavigatorToken',
        metadata: {
          name: 't1',
          labels: { b: '2', a: '1' },
          annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}', keep: 'x' },
          ...({
            namespace: 'old',
            uid: 'u',
            resourceVersion: '7',
            creationTimestamp: '2026-01-01T00:00:00Z',
            managedFields: [{}],
            generation: 3,
          } as object),
        },
        spec: { user: 'ci' },
        ...({ status: { lastUsedAt: '2026-11-01T00:00:00Z' } } as object),
      },
      API,
      'NavigatorToken',
    );
    expect(cleaned).toEqual({
      apiVersion: API,
      kind: 'NavigatorToken',
      metadata: { name: 't1', labels: { a: '1', b: '2' }, annotations: { keep: 'x' } },
      spec: { user: 'ci' },
    });
  });

  it('writes resource files in restore order with a manifest and a restore guide', () => {
    const entries = buildBackupEntries(input);
    expect(entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'RESTORE.md',
      'resources/10-secrets.yaml',
      // The empty ConfigMap group (11) gets no file.
      'resources/12-navigatorusers.yaml',
    ]);
    const manifest = JSON.parse(entries[0]!.content.toString());
    expect(manifest).toMatchObject({ format: BACKUP_FORMAT, namespace: 'capi-navigator-system' });
    expect(
      Object.fromEntries(entries.map((e) => [e.name, e.content.toString()])),
    ).toMatchSnapshot();
  });

  it('packs a tar.gz that gives the same bytes for the same input', async () => {
    const entries = buildBackupEntries(input);
    const a = await packArchive(entries, input.createdAt);
    const b = await packArchive(entries, input.createdAt);
    expect(a.equals(b)).toBe(true);
    expect(readFromChartArchive(a, (p) => p === 'resources/12-navigatorusers.yaml')).toContain(
      'name: admin',
    );
  });
});
