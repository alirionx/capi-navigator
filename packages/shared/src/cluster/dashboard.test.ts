import { describe, expect, it } from 'vitest';
import { cpuMilli, parseQuantity } from './dashboard.js';

describe('Kubernetes quantities (FP-18)', () => {
  it('parses CPU and memory notations', () => {
    expect(cpuMilli('250m')).toBe(250);
    expect(cpuMilli('2')).toBe(2000);
    expect(cpuMilli('1.5')).toBe(1500);
    expect(cpuMilli('156334117n')).toBe(156);
    expect(parseQuantity('128Mi')).toBe(128 * 1024 ** 2);
    expect(parseQuantity('1Gi')).toBe(1024 ** 3);
    expect(parseQuantity('1G')).toBe(1e9);
    expect(parseQuantity('2650Ki')).toBe(2650 * 1024);
    expect(parseQuantity('129e6')).toBe(129e6);
    expect(parseQuantity('4044024Ki')).toBe(4044024 * 1024);
    expect(parseQuantity(undefined)).toBe(0);
    expect(parseQuantity('garbage')).toBe(0);
  });
});
