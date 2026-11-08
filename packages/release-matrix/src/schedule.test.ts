import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { Case } from './cases.js';
import { MatrixConfigSchema } from './config.js';
import { runAll } from './schedule.js';

const platform = (parallel: number, slots: number) => ({
  infrastructure: {},
  sizes: { allInOne: 'm', controlPlane: 's', worker: 'm' },
  parallel,
  slots: Array.from({ length: slots }, (_, i) => ({ slot: i })),
});
const config = MatrixConfigSchema.parse({
  app: { connection: 'c', namespace: 'n' },
  platforms: { proxmox: platform(3, 2), aws: platform(2, 0) },
});
const cases = (platformName: 'proxmox' | 'aws', n: number, hcp = false): Case[] => [
  ...Array.from({ length: n }, (_, i) => ({
    id: `${platformName}-${i}`,
    platform: platformName,
    flavor: 'rke2' as const,
    mode: 'aio' as const,
    airGapped: false,
  })),
  ...(hcp
    ? [
        {
          id: `${platformName}-hcp`,
          platform: platformName,
          flavor: 'k0s' as const,
          mode: 'hcp' as const,
          airGapped: false,
        },
      ]
    : []),
];

describe('runAll', () => {
  it('never runs two cases on the same slot and runs hosted control planes alone', async () => {
    const running = new Map<string, number>();
    const held = new Set<unknown>();
    let maxProxmox = 0;
    let hcpAlone = true;
    await runAll(config, [...cases('proxmox', 5, true), ...cases('aws', 4)], async (c, slot) => {
      const n = (running.get(c.platform) ?? 0) + 1;
      running.set(c.platform, n);
      if (c.platform === 'proxmox') {
        maxProxmox = Math.max(maxProxmox, n);
        if (c.mode === 'hcp') {
          hcpAlone &&= n === 1;
          expect(slot).toBeUndefined();
        } else {
          expect(held.has(slot)).toBe(false);
          held.add(slot);
        }
      }
      await sleep(5 + (c.id.length % 3));
      held.delete(slot);
      running.set(c.platform, running.get(c.platform)! - 1);
    });
    // Two slots limit Proxmox below its parallel setting of 3.
    expect(maxProxmox).toBe(2);
    expect(hcpAlone).toBe(true);
  });

  it('limits platforms without slots by parallel only, side by side with others', async () => {
    let now = 0;
    let max = 0;
    const seen: string[] = [];
    await runAll(config, cases('aws', 5), async (c, slot) => {
      expect(slot).toBeUndefined();
      max = Math.max(max, ++now);
      await sleep(5);
      now--;
      seen.push(c.id);
    });
    expect(max).toBe(2);
    expect(seen.sort()).toEqual(['aws-0', 'aws-1', 'aws-2', 'aws-3', 'aws-4']);
  });
});
