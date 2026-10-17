import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from './health.js';

describe('HealthResponseSchema (FP0-F-03)', () => {
  it('accepts a healthy response', () => {
    const parsed = HealthResponseSchema.parse({
      status: 'ok',
      version: '0.1.0',
      homeCluster: { reachable: true, version: 'v1.34.0' },
    });
    expect(parsed.homeCluster.reachable).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(() =>
      HealthResponseSchema.parse({
        status: 'broken',
        version: '0.1.0',
        homeCluster: { reachable: false },
      }),
    ).toThrow();
  });
});
