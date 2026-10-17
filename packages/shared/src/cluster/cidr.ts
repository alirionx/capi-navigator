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
