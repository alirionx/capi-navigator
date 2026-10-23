import { describe, expect, it } from 'vitest';
import { cidrsOverlap, ipv4RangeInCidr, ipv4RangesOverlap, parseIpv4Range } from './cidr.js';

describe('IPv4 helpers', () => {
  it('detects overlapping networks', () => {
    expect(cidrsOverlap('10.42.0.0/16', '10.42.8.0/24')).toBe(true);
    expect(cidrsOverlap('10.42.0.0/16', '10.43.0.0/16')).toBe(false);
  });

  it('parses single addresses, ranges and networks (FP31-F-06)', () => {
    expect(parseIpv4Range('192.168.10.71')).toEqual({ start: 3232238151, end: 3232238151 });
    expect(parseIpv4Range('192.168.10.71-192.168.10.88')).toEqual({
      start: 3232238151,
      end: 3232238168,
    });
    expect(parseIpv4Range('192.168.10.64/28')?.end).toBe(3232238159);
    expect(parseIpv4Range('192.168.10.88-192.168.10.71')).toBeUndefined();
    expect(parseIpv4Range('192.168.10.300')).toBeUndefined();
  });

  it('checks ranges against a network and each other (FP31-F-08)', () => {
    expect(ipv4RangeInCidr('192.168.10.71-192.168.10.88', '192.168.10.0/24')).toBe(true);
    expect(ipv4RangeInCidr('192.168.10.250-192.168.11.2', '192.168.10.0/24')).toBe(false);
    expect(ipv4RangesOverlap('192.168.10.71-192.168.10.88', '192.168.10.89')).toBe(false);
    expect(ipv4RangesOverlap('192.168.10.71-192.168.10.88', '192.168.10.80')).toBe(true);
  });
});
