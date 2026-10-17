import { describe, expect, it } from 'vitest';
import { formatAge } from './age.js';

describe('formatAge (FP6-F-01)', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  it('formats like kubectl', () => {
    expect(formatAge(ago(42), now)).toBe('42s');
    expect(formatAge(ago(12 * 60), now)).toBe('12m');
    expect(formatAge(ago(2 * 3600 + 15 * 60), now)).toBe('2h15m');
    expect(formatAge(ago(14 * 3600), now)).toBe('14h');
    expect(formatAge(ago(3 * 86_400 + 4 * 3600), now)).toBe('3d4h');
    expect(formatAge(ago(40 * 86_400), now)).toBe('40d');
    expect(formatAge(undefined, now)).toBe('–');
  });
});
