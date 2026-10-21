import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tar } from '../testing/chart-tar.js';
import { ChartSource } from './chart-source.js';
import { get, type FetchResult } from './fetch.js';

vi.mock('./fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fetch.js')>()),
  get: vi.fn(),
}));
const getMock = vi.mocked(get);

type Reply = Partial<Omit<FetchResult, 'body'>> & { body?: string | Buffer };
const reply = (r: Reply): FetchResult => ({
  status: r.status ?? 200,
  headers: r.headers ?? {},
  body: Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? ''),
  url: r.url ?? '',
});
/** Routes requests by URL (without query unless given) to canned replies. */
function routes(table: Record<string, Reply | ((headers: Record<string, string>) => Reply)>) {
  getMock.mockImplementation(async (url, opts) => {
    const u = new URL(url);
    const r = table[u.origin + u.pathname + u.search] ?? table[u.origin + u.pathname];
    if (!r) return reply({ status: 404 });
    return reply(typeof r === 'function' ? r(opts?.headers ?? {}) : r);
  });
}

const INDEX = `
apiVersion: v1
entries:
  podinfo:
    - { version: 6.16.0-rc.1, appVersion: 6.16.0 }
    - { version: 6.15.0, appVersion: 6.15.0, description: Podinfo, icon: https://i/p.png, created: '2026-09-01', urls: [podinfo-6.15.0.tgz] }
    - { version: 6.9.0, urls: ['https://cdn.example.com/podinfo-6.9.0.tgz'] }
  old:
    - { version: 1.0.0, deprecated: true }
`;
const CHART = tar([
  { name: 'podinfo/Chart.yaml', content: 'name: podinfo\n' },
  { name: 'podinfo/values.yaml', content: 'replicaCount: 1\n' },
]);
const http = { type: 'http' as const, url: 'https://charts.example.com' };

describe('chart source: HTTP repositories (FP8-F-04)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('lists charts with the newest release, not a prerelease', async () => {
    routes({ 'https://charts.example.com/index.yaml': { body: INDEX } });
    const charts = await new ChartSource().charts(http);
    expect(charts).toEqual([
      { name: 'old', latestVersion: '1.0.0', deprecated: true },
      {
        name: 'podinfo',
        description: 'Podinfo',
        latestVersion: '6.15.0',
        appVersion: '6.15.0',
        icon: 'https://i/p.png',
      },
    ]);
  });

  it('lists versions newest first and caches the index for five minutes', async () => {
    routes({ 'https://charts.example.com/index.yaml': { body: INDEX } });
    let now = 0;
    const source = new ChartSource(() => now);
    expect((await source.versions(http, 'podinfo')).map((v) => v.version)).toEqual([
      '6.16.0-rc.1',
      '6.15.0',
      '6.9.0',
    ]);
    await source.versions(http, 'podinfo');
    expect(getMock).toHaveBeenCalledTimes(1);
    now = 6 * 60_000;
    await source.versions(http, 'podinfo');
    expect(getMock).toHaveBeenCalledTimes(2);
    await expect(source.versions(http, 'missing')).rejects.toThrow(/Chart missing not found/);
  });

  it('reads default values from relative and absolute archive URLs', async () => {
    routes({
      'https://charts.example.com/index.yaml': { body: INDEX },
      'https://charts.example.com/podinfo-6.15.0.tgz': { body: CHART },
      'https://cdn.example.com/podinfo-6.9.0.tgz': { body: CHART },
    });
    const source = new ChartSource();
    expect(await source.values(http, 'podinfo', '6.15.0')).toBe('replicaCount: 1\n');
    expect(await source.values(http, 'podinfo', '6.9.0')).toBe('replicaCount: 1\n');
    await expect(source.values(http, 'podinfo', '0.0.1')).rejects.toThrow(/not found/);
  });

  it('reports broken repositories in the connection test (FP8-F-02)', async () => {
    routes({ 'https://charts.example.com/index.yaml': { body: INDEX } });
    expect(await new ChartSource().test(http)).toEqual({
      ok: true,
      message: '2 chart(s) in the index',
    });
    routes({ 'https://charts.example.com/index.yaml': { body: 'just: text' } });
    expect(await new ChartSource().test(http)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not a Helm repository index/),
      hint: expect.stringMatching(/index.yaml/),
    });
    routes({});
    expect((await new ChartSource().test(http)).message).toBe('index.yaml: HTTP 404');
  });
});

describe('chart source: OCI registries (FP8-F-03, FP8-F-04)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });
  const R = 'https://ghcr.io';
  const oci = { type: 'oci' as const, url: 'oci://ghcr.io/stefanprodan/charts' };
  const manifest = JSON.stringify({
    layers: [
      { mediaType: 'application/vnd.cncf.helm.config.v1+json', digest: 'sha256:c' },
      { mediaType: 'application/vnd.cncf.helm.chart.content.v1.tar+gzip', digest: 'sha256:l' },
    ],
  });
  const challenge = {
    status: 401,
    headers: {
      'www-authenticate':
        'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"',
    },
  };

  it('cannot list charts', async () => {
    await expect(new ChartSource().charts(oci)).rejects.toThrow(/enter the chart name/);
  });

  it('pages through tags with an anonymous bearer token', async () => {
    routes({
      [`${R}/v2/stefanprodan/charts/podinfo/tags/list?n=1000`]: (h) =>
        h.authorization === 'Bearer anon'
          ? {
              body: JSON.stringify({ tags: ['6.9.0', '6.15.0_build.1'] }),
              headers: {
                link: '</v2/stefanprodan/charts/podinfo/tags/list?last=b&n=1000>; rel="next"',
              },
            }
          : challenge,
      [`${R}/v2/stefanprodan/charts/podinfo/tags/list?last=b&n=1000`]: (h) =>
        h.authorization === 'Bearer anon'
          ? { body: JSON.stringify({ tags: ['6.16.0'] }) }
          : challenge,
      [`${R}/token`]: (h) => {
        expect(h.authorization).toBeUndefined();
        return { body: JSON.stringify({ token: 'anon' }) };
      },
    });
    const versions = await new ChartSource().versions(oci, 'podinfo');
    expect(versions.map((v) => v.version)).toEqual(['6.16.0', '6.15.0+build.1', '6.9.0']);
  });

  it('reads values through manifest and blob with basic auth', async () => {
    const repo = { ...oci, url: 'oci://registry.example.com', username: 'u', password: 'p' };
    const basic = `Basic ${Buffer.from('u:p').toString('base64')}`;
    const guarded = (r: Reply) => (h: Record<string, string>) =>
      h.authorization === basic
        ? r
        : { status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } };
    routes({
      'https://registry.example.com/v2/podinfo/manifests/6.15.0_1': guarded({ body: manifest }),
      'https://registry.example.com/v2/podinfo/blobs/sha256:l': guarded({ body: CHART }),
      'https://registry.example.com/v2/': guarded({}),
    });
    const source = new ChartSource();
    expect(await source.values(repo, 'podinfo', '6.15.0+1')).toBe('replicaCount: 1\n');
    expect(await source.test(repo)).toEqual({
      ok: true,
      message: 'Registry registry.example.com answered and accepted the credentials',
    });
  });

  it('explains refused credentials, missing charts and non-chart artifacts', async () => {
    const repo = { ...oci, username: 'u', password: 'wrong' };
    routes({ [`${R}/v2/`]: challenge, [`${R}/token`]: { status: 401 } });
    expect(await new ChartSource().test(repo)).toMatchObject({
      ok: false,
      message: 'The registry refused the credentials',
      hint: expect.stringMatching(/oci:\/\/host\/path/),
    });

    routes({ [`${R}/v2/stefanprodan/charts/podinfo/manifests/1.0.0`]: { status: 404 } });
    await expect(new ChartSource().values(oci, 'podinfo', '1.0.0')).rejects.toThrow(
      /Not found in the registry/,
    );

    routes({
      [`${R}/v2/stefanprodan/charts/image/manifests/1.0.0`]: {
        body: JSON.stringify({
          layers: [{ mediaType: 'application/vnd.oci.image.layer', digest: 'x' }],
        }),
      },
    });
    await expect(new ChartSource().values(oci, 'image', '1.0.0')).rejects.toThrow(
      /is not a Helm chart/,
    );

    routes({ [`${R}/v2/`]: { status: 401 } });
    expect((await new ChartSource().test({ ...oci, username: 'u' })).message).toBe(
      'The registry needs credentials',
    );
  });

  it('explains refused access to a chart: missing, private or the chart name in the URL', async () => {
    // ghcr.io answers 403 instead of 404 for a package that does not exist (seen with the chart
    // name in the repository URL: oci://ghcr.io/alirionx/charts/capi-navigator).
    const doubled = { ...oci, url: 'oci://ghcr.io/alirionx/charts/capi-navigator' };
    routes({
      [`${R}/v2/alirionx/charts/capi-navigator/capi-navigator/manifests/0.8.0`]: challenge,
      [`${R}/token`]: { status: 403 },
    });
    const err = await new ChartSource()
      .values(doubled, 'capi-navigator', '0.8.0')
      .catch((e: unknown) => e as { message: string; hint?: string; status?: number });
    expect(err).toMatchObject({
      message:
        'ghcr.io/alirionx/charts/capi-navigator/capi-navigator cannot be read anonymously: the chart does not exist there, or it is private',
      hint: 'The repository URL already ends with the chart name "capi-navigator"; use oci://ghcr.io/alirionx/charts as repository URL.',
      status: 403,
    });

    routes({
      [`${R}/v2/stefanprodan/charts/podinfo/tags/list?n=1000`]: (h) =>
        h.authorization ? { status: 403 } : challenge,
      [`${R}/token`]: { body: JSON.stringify({ token: 't' }) },
    });
    await expect(
      new ChartSource().versions({ ...oci, username: 'u', password: 'p' }, 'podinfo'),
    ).rejects.toMatchObject({
      message:
        'The registry refused access to ghcr.io/stefanprodan/charts/podinfo: the credentials lack access, or the chart does not exist there',
      hint: expect.stringMatching(/without the chart name/),
    });
  });

  it('tests anonymous access to a registry', async () => {
    routes({ [`${R}/v2/`]: challenge });
    expect(await new ChartSource().test(oci)).toEqual({
      ok: true,
      message: 'Registry ghcr.io answered (anonymous)',
    });
    routes({ [`${R}/v2/`]: { status: 200 } });
    expect((await new ChartSource().test(oci)).ok).toBe(true);
    routes({});
    expect(await new ChartSource().test(oci)).toMatchObject({
      ok: false,
      message: 'Not an OCI registry (HTTP 404 for /v2/)',
    });
  });
});
