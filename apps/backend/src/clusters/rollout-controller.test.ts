import { describe, expect, it } from 'vitest';
import { controlPlaneAt, sameVersion, unusedTemplates } from './rollout-controller.service.js';

describe('rollout controller (FP7-F-08, FP7-F-15)', () => {
  const cp = (status: Record<string, unknown>, replicas = 3) => ({
    metadata: { name: 'demo-control-plane' },
    spec: { replicas },
    status,
  });

  it('lets workers follow only when every control plane node runs the new version', () => {
    const v = 'v1.35.9+rke2r1';
    expect(controlPlaneAt(cp({ version: v, upToDateReplicas: 3, readyReplicas: 3 }), v)).toBe(true);
    expect(
      controlPlaneAt(cp({ version: 'v1.34.12+rke2r1', upToDateReplicas: 3, readyReplicas: 3 }), v),
    ).toBe(false);
    expect(controlPlaneAt(cp({ version: v, upToDateReplicas: 2, readyReplicas: 3 }), v)).toBe(
      false,
    );
    expect(controlPlaneAt(cp({ version: v, upToDateReplicas: 3, readyReplicas: 2 }), v)).toBe(
      false,
    );
    expect(controlPlaneAt(undefined, v)).toBe(false);
  });

  it('deletes only old templates that nothing references', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    const t = (name: string, minutesAgo: number) => ({
      metadata: { name, creationTimestamp: new Date(now - minutesAgo * 60_000).toISOString() },
    });
    const templates = [
      t('demo-cp-aaaa1111', 60),
      t('demo-cp-bbbb2222', 60),
      t('demo-default-cccc3333', 60),
      t('demo-default-dddd4444', 2),
    ];
    const referencing = [
      { machineTemplate: { spec: { infrastructureRef: { name: 'demo-cp-bbbb2222' } } } },
      { template: { spec: { infrastructureRef: { name: 'demo-default-cccc3333' } } } },
    ];
    expect(unusedTemplates(templates, referencing, now).map((x) => x.metadata.name)).toEqual([
      'demo-cp-aaaa1111',
    ]);
  });
});

describe('version comparison for k0s (FP9-F-05)', () => {
  it('accepts a reported version without the distribution suffix', () => {
    expect(sameVersion('v1.35.8', 'v1.35.8+k0s.1')).toBe(true);
    expect(sameVersion('v1.35.8+k0s.1', 'v1.35.8+k0s.1')).toBe(true);
    expect(sameVersion('v1.34.11', 'v1.35.8+k0s.1')).toBe(false);
    expect(sameVersion('v1.35.8+k0s.0', 'v1.35.8+k0s.1')).toBe(false);
    expect(sameVersion(undefined, 'v1.35.8+k0s.1')).toBe(false);
  });
});

describe('control plane done (FP7-F-08)', () => {
  it('waits until the old control plane machines are gone', () => {
    const v = 'v1.35.8+k0s.1';
    const cp = (status: Record<string, unknown>) =>
      ({ metadata: { name: 'cp' }, spec: { replicas: 1 }, status }) as never;
    expect(
      controlPlaneAt(cp({ version: v, replicas: 2, upToDateReplicas: 1, readyReplicas: 1 }), v),
    ).toBe(false);
    expect(
      controlPlaneAt(cp({ version: v, replicas: 1, upToDateReplicas: 1, readyReplicas: 1 }), v),
    ).toBe(true);
  });
});
