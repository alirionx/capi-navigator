import { describe, expect, it, vi } from 'vitest';
import type { StoreService } from '../store/store.service.js';
import { FetchError } from './fetch.js';
import type { HelmRepositoriesService } from './helm-repositories.service.js';
import { ManifestChartService } from './manifest-chart.service.js';

const MIRROR_URL = 'oci://registry.example.com/charts';

function setup(opts: { versions?: string[]; error?: Error; source?: string; app?: string }) {
  const chartVersions = vi.fn(async () => {
    if (opts.error) throw opts.error;
    return opts.versions ?? [];
  });
  const store = {
    connectionCache: {
      get: () => ({ spec: opts.source ? { manifestChartRepository: opts.source } : {} }),
    },
  } as unknown as StoreService;
  const repositories = {
    chartVersions,
    ref: (name: string) => ({
      name,
      type: 'oci',
      url: MIRROR_URL,
      insecureSkipTLSVerify: false,
      hasCredentials: true,
      hasCaCertificate: false,
    }),
  } as unknown as HelmRepositoriesService;
  const service = new ManifestChartService(store, repositories);
  service.appVersion = opts.app ?? '0.9.0';
  let now = 0;
  service.now = () => now;
  return { service, chartVersions, advance: (ms: number) => (now += ms) };
}

describe('manifest chart source (FP30-F-02, FP30-F-03)', () => {
  it('uses the chart of the app version on ghcr.io', async () => {
    const { service, chartVersions } = setup({ versions: ['0.10.0', '0.9.0'] });
    const { source, status } = await service.source('home');
    expect(chartVersions).toHaveBeenCalledWith(
      undefined,
      'oci://ghcr.io/alirionx/charts',
      'capi-navigator-manifests',
    );
    expect(status).toMatchObject({ available: true, version: '0.9.0' });
    expect(source).toEqual({ version: '0.9.0' });
  });

  it('reports a missing version with the mirror commands', async () => {
    const { service } = setup({ versions: ['0.8.2'], source: 'mirror' });
    const { source, status } = await service.source('home');
    expect(source).toBeUndefined();
    expect(status).toMatchObject({
      repository: 'mirror',
      repositoryUrl: MIRROR_URL,
      available: false,
      message: `Version 0.9.0 of capi-navigator-manifests is missing at ${MIRROR_URL}`,
    });
    expect(status.mirrorCommands).toBe(
      'helm pull oci://ghcr.io/alirionx/charts/capi-navigator-manifests --version 0.9.0\n' +
        `helm push capi-navigator-manifests-0.9.0.tgz ${MIRROR_URL}`,
    );
  });

  it('uses the newest release for development builds', async () => {
    const { service } = setup({ versions: ['1.0.0-rc.1', '0.9.1', '0.9.0'], app: '0.0.0-dev' });
    expect((await service.source('home')).source).toEqual({ version: '0.9.1' });
    const none = setup({ versions: [], app: '0.0.0-dev' });
    expect((await none.service.status('home')).message).toBe(
      'No released version of capi-navigator-manifests at oci://ghcr.io/alirionx/charts',
    );
  });

  it('explains when the source cannot be read', async () => {
    const { service } = setup({
      error: new FetchError('ghcr.io/x cannot be read anonymously', 401, 'Make it public'),
    });
    expect(await service.status('home')).toMatchObject({
      available: false,
      version: '0.9.0',
      hint: 'Make it public',
    });
  });

  it('caches the result for a minute', async () => {
    const { service, chartVersions, advance } = setup({ versions: ['0.9.0'] });
    await service.status('home');
    await service.status('home');
    expect(chartVersions).toHaveBeenCalledTimes(1);
    advance(61_000);
    await service.status('home');
    expect(chartVersions).toHaveBeenCalledTimes(2);
  });
});
