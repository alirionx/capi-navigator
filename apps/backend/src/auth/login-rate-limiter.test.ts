import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from './login-rate-limiter.js';

describe('LoginRateLimiter (NF-04)', () => {
  it('blocks after the limit and releases after the window', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.2.3.4', 'alice');
    expect(limiter.retryAfter('1.2.3.4', 'alice')).toBe(60);
    now = 30_000;
    expect(limiter.retryAfter('1.2.3.4', 'alice')).toBe(30);
    now = 60_000;
    expect(limiter.retryAfter('1.2.3.4', 'alice')).toBe(0);
  });

  it('limits by username across IPs and by IP across usernames', () => {
    const limiter = new LoginRateLimiter(2, 60_000, () => 0);
    limiter.recordFailure('ip-a', 'Alice');
    limiter.recordFailure('ip-b', 'alice');
    expect(limiter.retryAfter('ip-c', 'alice')).toBeGreaterThan(0);

    limiter.recordFailure('ip-x', 'u1');
    limiter.recordFailure('ip-x', 'u2');
    expect(limiter.retryAfter('ip-x', 'u3')).toBeGreaterThan(0);
  });

  it('resets the counters on success', () => {
    const limiter = new LoginRateLimiter(2, 60_000, () => 0);
    limiter.recordFailure('ip', 'bob');
    limiter.recordSuccess('ip', 'bob');
    limiter.recordFailure('ip', 'bob');
    expect(limiter.retryAfter('ip', 'bob')).toBe(0);
  });
});
