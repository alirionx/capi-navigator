import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { isTopLevelValues, readFromChartArchive } from './chart-archive.js';
import { compareChartVersions } from './chart-source.js';

/** Minimal tar writer for the test: one header block per entry. */
function tar(entries: { name: string; content: string; type?: string; prefix?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.content);
    const header = Buffer.alloc(512);
    header.write(e.name, 0, 100);
    header.write(data.length.toString(8).padStart(11, '0'), 124, 12);
    header.write(e.type ?? '0', 156, 1);
    header.write('ustar', 257);
    if (e.prefix) header.write(e.prefix, 345, 155);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

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
    expect(describeError(url, err)).toBe(
      'registry.example:5443: the server certificate is not trusted; add the CA certificate of the registry',
    );
  });
});
