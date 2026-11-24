import { describe, expect, it } from 'vitest';
import { apiFieldNames, objectKey } from './workload-access.js';

describe('workload access (FP-36)', () => {
  it('restores the field names of the API, so a fresh LimitRange is no drift (FP36-F-06)', () => {
    const created = new Date();
    expect(
      apiFieldNames({
        metadata: { creationTimestamp: created },
        spec: { limits: [{ type: 'Container', _default: { cpu: '500m' }, defaultRequest: {} }] },
      }),
    ).toEqual({
      metadata: { creationTimestamp: created },
      spec: { limits: [{ type: 'Container', default: { cpu: '500m' }, defaultRequest: {} }] },
    });
  });

  it('identifies objects by kind, namespace and name', () => {
    expect(objectKey({ kind: 'Tier', metadata: { name: 't' } })).toBe('Tier//t');
    expect(objectKey({ kind: 'Role', metadata: { name: 'r', namespace: 'n' } })).toBe('Role/n/r');
  });
});
