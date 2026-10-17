import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password-hasher.js';

// Low-cost parameters keep the tests fast; production uses the OWASP defaults.
const FAST = { memory: 1024, passes: 1, parallelism: 1 };

describe('password hashing with Argon2id (FP1-F-01)', () => {
  it('produces a PHC string and verifies the right password', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
  });

  it('uses a random salt per hash', async () => {
    expect(await hashPassword('same', FAST)).not.toBe(await hashPassword('same', FAST));
  });

  it('rejects malformed hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', '$2b$10$bcrypt-style')).toBe(false);
  });

  it('uses the OWASP defaults when no parameters are given', async () => {
    expect(await hashPassword('x')).toContain('$m=19456,t=2,p=1$');
  });
});
