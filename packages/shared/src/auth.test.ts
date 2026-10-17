import { describe, expect, it } from 'vitest';
import { hasRole, PasswordSchema } from './auth.js';

describe('PasswordSchema', () => {
  it('accepts passwords with at least 8 characters', () => {
    expect(PasswordSchema.safeParse('12345678').success).toBe(true);
    expect(PasswordSchema.safeParse('1234567').success).toBe(false);
  });
});

describe('hasRole (FP1-F-04)', () => {
  it('orders viewer < operator < admin', () => {
    expect(hasRole('admin', 'operator')).toBe(true);
    expect(hasRole('operator', 'operator')).toBe(true);
    expect(hasRole('viewer', 'operator')).toBe(false);
  });
});
