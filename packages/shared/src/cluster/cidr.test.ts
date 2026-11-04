import { describe, expect, it } from 'vitest';
import {
  cidrsOverlap,
  freeCidr,
  ipv4RangeInCidr,
  ipv4RangesOverlap,
  parseIpv4Range,
} from './cidr.js';

describe('IPv4 helpers', () => {
  it('finds the next free network (FP5-F-21)', () => {
    expect(freeCidr('10.6.0.0/24', [])).toBe('10.6.0.0/24');
    expect(freeCidr('10.6.0.0/24', ['10.6.0.0/24', '10.6.1.128/25', '192.168.0.0/24'])).toBe(
      '10.6.2.0/24',
    );
    expect(freeCidr('10.6.0.0/24', ['10.6.0.0/23'])).toBe('10.6.2.0/24');
    expect(freeCidr('10.6.0.0/24', ['10.0.0.0/8'])).toBeUndefined();
  });

  it('detects overlapping networks', () => {
    expect(cidrsOverlap('10.42.0.0/16', '10.42.8.0/24')).toBe(true);
    expect(cidrsOverlap('10.42.0.0/16', '10.43.0.0/16')).toBe(false);
  });

  it('parses single addresses, ranges and networks (FP31-F-06)', () => {
    expect(parseIpv4Range('10.20.0.71')).toEqual({ start: 169082951, end: 169082951 });
    expect(parseIpv4Range('10.20.0.71-10.20.0.88')).toEqual({
      start: 169082951,
      end: 169082968,
    });
    expect(parseIpv4Range('10.20.0.64/28')?.end).toBe(169082959);
    expect(parseIpv4Range('10.20.0.88-10.20.0.71')).toBeUndefined();
    expect(parseIpv4Range('10.20.0.300')).toBeUndefined();
  });

  it('checks ranges against a network and each other (FP31-F-08)', () => {
    expect(ipv4RangeInCidr('10.20.0.71-10.20.0.88', '10.20.0.0/24')).toBe(true);
    expect(ipv4RangeInCidr('10.20.0.250-10.20.1.2', '10.20.0.0/24')).toBe(false);
    expect(ipv4RangesOverlap('10.20.0.71-10.20.0.88', '10.20.0.89')).toBe(false);
    expect(ipv4RangesOverlap('10.20.0.71-10.20.0.88', '10.20.0.80')).toBe(true);
  });
});
