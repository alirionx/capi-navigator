import { describe, expect, it } from 'vitest';
import { imageNameMatchesVersion } from './capi-image.js';

describe('Cluster API image names (ADR-0032)', () => {
  it('finds the version in the usual spellings', () => {
    expect(imageNameMatchesVersion('ubuntu-2404-kube-v1.36.5', 'v1.36.5')).toBe(true);
    expect(imageNameMatchesVersion('debian-13-kube-v1-36-5', 'v1.36.5')).toBe(true);
    expect(imageNameMatchesVersion('rockylinux-9-kube_1_36_5 (7212)', 'v1.36.5')).toBe(true);
  });

  it('does not take another patch version or a longer number for it', () => {
    expect(imageNameMatchesVersion('ubuntu-2404-kube-v1.36.6', 'v1.36.5')).toBe(false);
    expect(imageNameMatchesVersion('ubuntu-2404-kube-v1.36.51', 'v1.36.5')).toBe(false);
    expect(imageNameMatchesVersion('ubuntu-2404-kube-v11.36.5', 'v1.36.5')).toBe(false);
    expect(imageNameMatchesVersion('ubuntu-24.04-server-cloudimg', 'v1.36.5')).toBe(false);
  });
});
