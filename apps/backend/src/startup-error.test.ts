import type { KubeConfig } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config/config.js';
import type { KubeClientFactory } from './kube/kube-client.factory.js';
import { StartupError, isKnownStartupProblem, startupMessage } from './startup-error.js';
import { StoreService } from './store/store.service.js';

const apiError = (code: number, message: string) =>
  Object.assign(new Error(`HTTP-Code: ${code}`), {
    code,
    body: JSON.stringify({ kind: 'Status', code, message }),
  });

const storeWith = (readNamespace: () => Promise<unknown>) => {
  const kc = { makeApiClient: () => ({ readNamespace }) } as unknown as KubeConfig;
  const kube = { homeCluster: () => kc } as unknown as KubeClientFactory;
  const config = loadConfig({ NAVIGATOR_NAMESPACE: 'capi-navigator-system', LOG_JSON: 'false' });
  return new StoreService(kube, config) as unknown as { checkNamespace(): Promise<void> };
};

describe('startup problems', () => {
  it('names a missing namespace with the command that fixes it', async () => {
    const store = storeWith(async () => {
      throw apiError(404, 'namespaces "capi-navigator-system" not found');
    });
    const err = await store.checkNamespace().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartupError);
    expect(startupMessage(err)).toMatch(
      /Namespace capi-navigator-system does not exist\. Create it with "kubectl create namespace capi-navigator-system"/,
    );
  });

  it('skips the check without permission to read namespaces (Helm chart)', async () => {
    const forbidden = vi.fn(async () => {
      throw apiError(403, 'namespaces is forbidden');
    });
    await expect(storeWith(forbidden).checkNamespace()).resolves.toBeUndefined();
    await expect(storeWith(async () => ({})).checkNamespace()).resolves.toBeUndefined();
  });

  it('shortens Kubernetes API errors to their message instead of the whole response', () => {
    const err = apiError(404, 'the server could not find the requested resource');
    expect(startupMessage(err)).toBe(
      'Kubernetes API (404): the server could not find the requested resource',
    );
    expect(isKnownStartupProblem(err)).toBe(true);
    expect(isKnownStartupProblem(new Error('boom'))).toBe(false);
    expect(startupMessage(new Error('boom'))).toBe('boom');
  });
});
