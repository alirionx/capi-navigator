import { describe, expect, it } from 'vitest';
import { NAMESPACE_PEOPLE_ANNOTATION } from '@capi-navigator/shared';
import { sanitize } from './resources.service.js';

describe('YAML view sanitizing (FP7-F-03, FP7-F-04)', () => {
  it('hides managed fields unless asked', () => {
    const obj = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'c', managedFields: [{ manager: 'x' }] },
    };
    expect(
      (sanitize(obj, false).obj.metadata as Record<string, unknown>).managedFields,
    ).toBeUndefined();
    expect(
      (sanitize(obj, true).obj.metadata as Record<string, unknown>).managedFields,
    ).toHaveLength(1);
  });

  it('never returns Secret values, also not from the last-applied annotation', () => {
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 's',
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"value":"c2VjcmV0"}}',
        },
      },
      data: { value: 'c2VjcmV0' },
      stringData: { token: 'plain' },
    };
    const { obj, masked } = sanitize(secret, true);
    expect(masked).toBe(true);
    expect(obj.data).toEqual({ value: '<hidden>' });
    expect(obj.stringData).toEqual({ token: '<hidden>' });
    expect(JSON.stringify(obj)).not.toMatch(/c2VjcmV0|plain/);
  });

  it('never shows who is assigned to a managed namespace (FP37-F-02, ADR-0041)', () => {
    const hcp = {
      apiVersion: 'addons.cluster.x-k8s.io/v1alpha1',
      kind: 'HelmChartProxy',
      metadata: {
        name: 'ns-team-a',
        annotations: {
          'capi-navigator.io/managed-namespace': '{"name":"team-a"}',
          [NAMESPACE_PEOPLE_ANNOTATION]: '{"ci":[{"kind":"user","name":"max","uid":"u"}]}',
        },
      },
    };
    const { obj, masked } = sanitize(hcp, false);
    expect(masked).toBe(true);
    expect(JSON.stringify(obj)).not.toContain('max');
    expect(JSON.stringify(obj)).toContain('team-a');
  });
});
