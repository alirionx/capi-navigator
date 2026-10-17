import { describe, expect, it, vi } from 'vitest';
import { ImageNameCache } from './image-names.js';

describe('image name cache (FP6-F-02)', () => {
  it('looks up only missing IDs, remembers unknown ones and survives failures', async () => {
    const cache = new ImageNameCache({ found: 60_000, missing: 60_000 }, 1000);
    const lookup = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.filter((i) => i !== 'gone').map((i) => [i, `name-${i}`])),
    );
    const first = await cache.resolve('s', ['a', 'gone'], lookup);
    expect([...first]).toEqual([
      ['a', 'name-a'],
      ['gone', null],
    ]);
    await cache.resolve('s', ['a', 'b'], lookup);
    expect(lookup).toHaveBeenLastCalledWith(['b']);
    expect(lookup).toHaveBeenCalledTimes(2);

    const failing = new ImageNameCache(undefined, 1000);
    const res = await failing.resolve('s', ['x'], async () => {
      throw new Error('cloud down');
    });
    expect(res.size).toBe(0);
  });

  it('does not let a slow cloud block the status', async () => {
    const cache = new ImageNameCache(undefined, 20);
    let release!: () => void;
    const slow = () =>
      new Promise<Record<string, string>>((r) => {
        release = () => r({ a: 'late' });
      });
    expect((await cache.resolve('s', ['a'], slow)).size).toBe(0);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect((await cache.resolve('s', ['a'], slow)).get('a')).toBe('late');
  });
});
