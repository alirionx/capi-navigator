import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from './api.js';
import type { Case } from './cases.js';
import { MatrixConfigSchema } from './config.js';
import { protocolLine, runCase } from './runner.js';

const dir = mkdtempSync(join(tmpdir(), 'matrix-test-'));
afterEach(() => rmSync(join(dir, 'p.md'), { force: true }));

const config = MatrixConfigSchema.parse({
  app: { connection: 'c', namespace: 'acc' },
  protocol: join(dir, 'p.md'),
  availableMinutes: 0.001,
  platforms: {
    aws: {
      infrastructure: {
        provider: 'aws',
        credentialRef: 'aws',
        region: 'eu-central-1',
        image: 'ami-0123456789abcdef0',
      },
      sizes: { allInOne: 't3.large', controlPlane: 't3.medium', worker: 't3.large' },
      hcp: {},
    },
  },
});
const aio: Case = {
  id: 'mt-aw-r-aio',
  platform: 'aws',
  flavor: 'rke2',
  mode: 'aio',
  airGapped: false,
};
const fakeApi = (over: Partial<Record<keyof AppApi, unknown>> = {}) =>
  ({
    preview: vi.fn().mockResolvedValue({ blockers: [], warnings: ['a warning'] }),
    create: vi.fn().mockResolvedValue(undefined),
    conditions: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    kubeconfig: vi.fn(),
    ...over,
  }) as unknown as AppApi;
const protocol = () => readFileSync(config.protocol, 'utf8');

describe('runCase', () => {
  it('with --preview creates nothing and records the warnings', async () => {
    const api = fakeApi();
    expect(await runCase(aio, undefined, { config, api, previewOnly: true })).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
    expect(protocol()).toContain('- [x] **mt-aw-r-aio** (mt-aw-r-aio, v');
    expect(protocol()).toContain('⚠️ a warning');
  });

  it('records a blocked preview as failed without creating', async () => {
    const api = fakeApi({
      preview: vi.fn().mockResolvedValue({ blockers: ['no provider'], warnings: [] }),
    });
    expect(await runCase(aio, undefined, { config, api })).toBe(false);
    expect(api.create).not.toHaveBeenCalled();
    expect(protocol()).toContain('❌ preview blocked: no provider');
  });

  it('records a cluster that never becomes Available and still deletes it', async () => {
    const api = fakeApi({
      conditions: vi
        .fn()
        .mockResolvedValueOnce([{ type: 'Available', status: 'False', message: 'waiting' }])
        .mockResolvedValue(undefined),
    });
    expect(await runCase(aio, undefined, { config, api, pollMs: 1 })).toBe(false);
    expect(api.delete).toHaveBeenCalledWith('acc', 'mt-aw-r-aio');
    expect(protocol()).toMatch(/❌ not Available after .* · deleted after \d+ s/);
  });

  it('previews only the host of a hosted control plane', async () => {
    const api = fakeApi();
    const hcp: Case = {
      id: 'mt-aw-hcp',
      platform: 'aws',
      flavor: 'k0s',
      mode: 'hcp',
      airGapped: false,
    };
    await runCase(hcp, undefined, { config, api, previewOnly: true });
    expect(api.preview).toHaveBeenCalledTimes(1);
    expect(protocol()).toContain('mt-aw-hcp-ten: preview needs the host');
  });

  it('formats a protocol line', () => {
    expect(protocolLine('c', { name: 'n', version: 'v1', ok: false, notes: ['a', 'b'] })).toBe(
      '- [ ] **c** (n, v1) – a · b',
    );
  });
});
