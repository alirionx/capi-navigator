/** Minimal IPv4 CIDR helpers for spec validation (pure, no dependencies). */

export interface Ipv4Cidr {
  start: number;
  end: number;
  prefix: number;
}

export function parseIpv4Cidr(cidr: string): Ipv4Cidr | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return undefined;
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return undefined;
  const ip = octets.reduce((acc, o) => acc * 256 + o, 0);
  const size = 2 ** (32 - prefix);
  const start = ip - (ip % size);
  // The address must be the network address (no host bits set), as Kubernetes and clouds expect.
  if (start !== ip) return undefined;
  return { start, end: start + size - 1, prefix };
}

export function cidrsOverlap(a: string, b: string): boolean {
  const x = parseIpv4Cidr(a);
  const y = parseIpv4Cidr(b);
  if (!x || !y) return false;
  return x.start <= y.end && y.start <= x.end;
}

/** An IPv4 address as number, or undefined. */
export function parseIpv4(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return undefined;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return undefined;
  return octets.reduce((acc, o) => acc * 256 + o, 0);
}

/**
 * An address range as CAPMOX and the in-cluster IPAM provider accept it (FP31-F-06): a single
 * address "10.0.0.5", a range "10.0.0.5-10.0.0.9" or a network "10.0.0.0/28".
 */
export function parseIpv4Range(range: string): { start: number; end: number } | undefined {
  const r = range.trim();
  if (r.includes('/')) {
    const c = parseIpv4Cidr(r);
    return c ? { start: c.start, end: c.end } : undefined;
  }
  const [a, b] = r.split('-');
  const start = parseIpv4(a ?? '');
  const end = b === undefined ? start : parseIpv4(b);
  if (start === undefined || end === undefined || end < start) return undefined;
  return { start, end };
}

/** Whether a range lies inside a network (both as parsed above). */
export function ipv4RangeInCidr(range: string, cidr: string): boolean {
  const r = parseIpv4Range(range);
  const c = parseIpv4Cidr(cidr);
  return !!r && !!c && r.start >= c.start && r.end <= c.end;
}

/** Whether two ranges share an address. */
export function ipv4RangesOverlap(a: string, b: string): boolean {
  const x = parseIpv4Range(a);
  const y = parseIpv4Range(b);
  return !!x && !!y && x.start <= y.end && y.start <= x.end;
}
