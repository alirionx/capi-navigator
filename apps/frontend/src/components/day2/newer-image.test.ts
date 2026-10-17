import { describe, expect, it } from 'vitest';
import { newerImage } from './newer-image.js';

const img = (value: string, distro: string, version: string, created: string) => ({
  value,
  label: value,
  details: { os_distro: distro, os_version: version, created_at: created },
});

describe('newer image suggestion (FP7-F-12)', () => {
  const images = [
    img('u1', 'ubuntu', '24.04', '2026-01-01T00:00:00Z'),
    img('u2', 'ubuntu', '24.04', '2026-09-01T00:00:00Z'),
    img('u3', 'ubuntu', '24.04', '2026-06-01T00:00:00Z'),
    img('u22', 'ubuntu', '22.04', '2026-10-01T00:00:00Z'),
    img('r1', 'rocky', '10', '2026-10-01T00:00:00Z'),
  ];
  it('suggests the newest image of the same OS and version', () => {
    expect(newerImage('u1', images)?.value).toBe('u2');
    expect(newerImage('u2', images)).toBeUndefined();
    expect(newerImage('unknown', images)).toBeUndefined();
    expect(newerImage(undefined, images)).toBeUndefined();
  });
});
