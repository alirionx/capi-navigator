import { describe, expect, it } from 'vitest';
import { isViewable } from './resource-view.js';

describe('YAML view allowlist (FP7-F-01)', () => {
  it('allows the app world in the management cluster', () => {
    expect(isViewable({ apiVersion: 'cluster.x-k8s.io/v1beta2', kind: 'Machine', name: 'm' })).toBe(
      true,
    );
    expect(
      isViewable({
        apiVersion: 'operator.cluster.x-k8s.io/v1alpha2',
        kind: 'CoreProvider',
        name: 'c',
      }),
    ).toBe(true);
    expect(isViewable({ apiVersion: 'v1', kind: 'Secret', name: 's' })).toBe(true);
    expect(isViewable({ apiVersion: 'apps/v1', kind: 'Deployment', name: 'd' })).toBe(false);
    expect(
      isViewable({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', name: 'r' }),
    ).toBe(false);
  });
  it('allows dashboard objects in workload clusters, never Secrets', () => {
    const cluster = { namespace: 'default', name: 'c1' };
    expect(isViewable({ apiVersion: 'v1', kind: 'Pod', name: 'p', cluster })).toBe(true);
    expect(
      isViewable({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', name: 'i', cluster }),
    ).toBe(true);
    expect(isViewable({ apiVersion: 'v1', kind: 'Secret', name: 's', cluster })).toBe(false);
    expect(isViewable({ apiVersion: 'v1', kind: 'ConfigMap', name: 'c', cluster })).toBe(false);
  });
});
