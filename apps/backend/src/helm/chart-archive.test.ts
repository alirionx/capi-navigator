import { describe, expect, it } from 'vitest';
import { tar } from '../testing/chart-tar.js';
import { isTopLevelValues, readFromChartArchive } from './chart-archive.js';
import { compareChartVersions } from './chart-source.js';

describe('chart archive (FP8-F-04)', () => {
  it('reads the top-level values.yaml, not the one of a subchart', () => {
    const tgz = tar([
      { name: 'podinfo/Chart.yaml', content: 'name: podinfo\n' },
      { name: 'podinfo/charts/redis/values.yaml', content: 'sub: true\n' },
      { name: 'podinfo/values.yaml', content: 'replicaCount: 1\n' },
    ]);
    expect(readFromChartArchive(tgz, isTopLevelValues)).toBe('replicaCount: 1\n');
  });

  it('understands PAX path records and ustar prefixes', () => {
    const long = `${'a'.repeat(120)}/values.yaml`;
    const record = `${long.length + 7 + String(long.length).length} path=${long}\n`;
    const tgz = tar([
      { name: 'PaxHeader', content: record, type: 'x' },
      { name: 'ignored', content: 'pax: true\n' },
      { name: 'values.yaml', prefix: 'chart', content: 'prefixed: true\n' },
    ]);
    expect(readFromChartArchive(tgz, (p) => p === long)).toBe('pax: true\n');
    expect(readFromChartArchive(tgz, (p) => p === 'chart/values.yaml')).toBe('prefixed: true\n');
  });

  it('returns undefined when the file is missing', () => {
    expect(
      readFromChartArchive(tar([{ name: 'x/Chart.yaml', content: '' }]), isTopLevelValues),
    ).toBe(undefined);
  });

  it('sorts chart versions newest first, prereleases after releases', () => {
    expect(
      ['1.2.0', '1.10.0', '1.10.0-rc.1', 'v1.9.3', '2.0.0'].sort(compareChartVersions),
    ).toEqual(['2.0.0', '1.10.0', '1.10.0-rc.1', 'v1.9.3', '1.2.0']);
  });
});

describe('fetch errors (NF-06)', () => {
  it('translates TLS trust errors', async () => {
    const { describeError } = await import('./fetch.js');
    const url = new URL('https://registry.example:5443/v2/');
    const err = Object.assign(
      new Error('unable to verify the first certificate; try --use-system-ca'),
      {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      },
    );
    // Node's own hint (--use-system-ca) does not apply to the app and is dropped.
    expect(describeError(url, err, {})).toBe(
      'registry.example:5443: the server certificate is not trusted (unable to verify the first certificate). Add the CA certificate of the registry: the root CA and every intermediate CA, one PEM block after another',
    );
  });

  it('names the CA of a TLS-inspecting outbound proxy when one is set (FP-29)', async () => {
    const { describeError } = await import('./fetch.js');
    const url = new URL('https://kube-vip.github.io/helm-charts/index.yaml');
    const err = Object.assign(new Error('unable to verify'), {
      code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    });
    const env = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://proxy.example:3128' };
    expect(describeError(url, err, env)).toBe(
      'kube-vip.github.io: the certificate is not trusted (unable to verify). The request went through the outbound proxy proxy.example:3128: if kube-vip.github.io is internal, add it to NO_PROXY of the app (the host or .domain; a domain without leading dot does not cover its subdomains in Node.js); if the proxy inspects TLS, add its CA with NODE_EXTRA_CA_CERTS',
    );
  });
});
