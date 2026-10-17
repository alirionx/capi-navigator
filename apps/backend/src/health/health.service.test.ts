import { describe, expect, it } from 'vitest';
import type { KubeClientFactory } from '../kube/kube-client.factory.js';
import { HealthService } from './health.service.js';

function factoryWith(getCode: () => Promise<{ gitVersion: string }>): KubeClientFactory {
  return {
    homeCluster: () => ({ makeApiClient: () => ({ getCode }) }),
  } as unknown as KubeClientFactory;
}

describe('HealthService (FP0-F-03)', () => {
  it('reports the home cluster as reachable with its version', async () => {
    const svc = new HealthService(factoryWith(() => Promise.resolve({ gitVersion: 'v1.34.0' })));
    expect(await svc.homeCluster()).toEqual({ reachable: true, version: 'v1.34.0' });
  });

  it('reports an unreachable home cluster without leaking details (NF-01)', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6443'), {
      code: 'ECONNREFUSED',
    });
    const svc = new HealthService(factoryWith(() => Promise.reject(err)));
    expect(await svc.homeCluster()).toEqual({ reachable: false, message: 'Connection refused' });
  });

  it('still returns status ok when the home cluster is down', async () => {
    const svc = new HealthService(factoryWith(() => Promise.reject(new Error('boom'))));
    const health = await svc.health();
    expect(health.status).toBe('ok');
    expect(health.homeCluster.reachable).toBe(false);
  });
});
