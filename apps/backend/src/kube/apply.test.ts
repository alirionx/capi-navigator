import { describe, expect, it } from 'vitest';
import { normalizeForDiff, parseApplyConflict } from './apply.js';

describe('apply helpers (hard rules 4 and 8)', () => {
  it('parses managers and fields of server-side apply conflicts', () => {
    expect(
      parseApplyConflict(
        'Apply failed with 1 conflict: conflict with "kubectl-scale" using cluster.x-k8s.io/v1beta2: .spec.replicas',
      ),
    ).toEqual({ managers: ['kubectl-scale'], fields: ['.spec.replicas'] });
    expect(
      parseApplyConflict(
        'Apply failed with 2 conflicts: conflicts with "kubectl-edit" using v1:\n- .metadata.labels.env\n- .spec.replicas',
      ),
    ).toEqual({ managers: ['kubectl-edit'], fields: ['.metadata.labels.env', '.spec.replicas'] });
    // FP7-F-19: message of a real `kubectl scale` (scale subresource), seen on Infomaniak.
    expect(
      parseApplyConflict(
        'Apply failed with 1 conflict: conflict with "kubectl" with subresource "scale" using cluster.x-k8s.io/v1beta2: .spec.replicas',
      ),
    ).toEqual({ managers: ['kubectl (scale)'], fields: ['.spec.replicas'] });
  });

  it('drops server-managed metadata and masks Secret values', () => {
    const out = normalizeForDiff({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 's', resourceVersion: '7', managedFields: [], uid: 'u' },
      data: { 'cloud.conf': 'c2VjcmV0' },
    } as never);
    expect(out.metadata).toEqual({ name: 's' });
    const masked = (out.data as Record<string, string>)['cloud.conf']!;
    expect(masked).toMatch(/^\*{8} \([0-9a-f]{6}\)$/);
    expect(JSON.stringify(out)).not.toContain('c2VjcmV0');
  });
});
