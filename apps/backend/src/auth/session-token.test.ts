import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseCookies, signSession, verifySession } from './session-token.js';

const key = randomBytes(32);
const payload = { u: 'alice', g: 3, iat: 1000, exp: 2000 };

describe('signed session cookies (FP1-F-03)', () => {
  it('round-trips a valid session', () => {
    expect(verifySession(signSession(payload, key), key, 1500)).toEqual(payload);
  });

  it('rejects an expired session', () => {
    expect(verifySession(signSession(payload, key), key, 2000)).toBeUndefined();
  });

  it('rejects a session signed with another key', () => {
    expect(verifySession(signSession(payload, randomBytes(32)), key, 1500)).toBeUndefined();
  });

  it('rejects a tampered payload', () => {
    const [, sig] = signSession(payload, key).split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, u: 'admin' })).toString('base64url');
    expect(verifySession(`${forged}.${sig}`, key, 1500)).toBeUndefined();
  });

  it('rejects garbage', () => {
    expect(verifySession('', key)).toBeUndefined();
    expect(verifySession('a.b.c', key)).toBeUndefined();
    expect(verifySession('abc', key)).toBeUndefined();
  });
});

describe('parseCookies', () => {
  it('parses multiple cookies and keeps the first duplicate', () => {
    expect(parseCookies('a=1; b=hello%20world; a=2')).toEqual({ a: '1', b: 'hello world' });
  });

  it('ignores malformed parts', () => {
    expect(parseCookies('novalue; c=%E0%A4%A; d=4')).toEqual({ d: '4' });
    expect(parseCookies(undefined)).toEqual({});
  });
});
