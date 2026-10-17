/**
 * Fixed-window limiter for failed logins (NF-04), keyed by client IP and by username.
 *
 * Kept in memory per replica: it slows down brute force without a shared store, in line with
 * the stateless backend (STATE-04). With N replicas the effective limit is at most N times higher.
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until the next attempt is allowed, or 0 if allowed now. */
  retryAfter(ip: string, username: string): number {
    const t = this.now();
    let wait = 0;
    for (const key of keys(ip, username)) {
      const entry = this.failures.get(key);
      if (!entry) continue;
      if (entry.resetAt <= t) {
        this.failures.delete(key);
      } else if (entry.count >= this.limit) {
        wait = Math.max(wait, Math.ceil((entry.resetAt - t) / 1000));
      }
    }
    return wait;
  }

  recordFailure(ip: string, username: string): void {
    const t = this.now();
    for (const key of keys(ip, username)) {
      const entry = this.failures.get(key);
      if (!entry || entry.resetAt <= t) {
        this.failures.set(key, { count: 1, resetAt: t + this.windowMs });
      } else {
        entry.count += 1;
      }
    }
    if (this.failures.size > 10_000) this.prune(t);
  }

  recordSuccess(ip: string, username: string): void {
    this.failures.delete(`user:${username.toLowerCase()}`);
    this.failures.delete(`ip:${ip}`);
  }

  private prune(t: number): void {
    for (const [key, entry] of this.failures) if (entry.resetAt <= t) this.failures.delete(key);
  }
}

function keys(ip: string, username: string): string[] {
  return [`ip:${ip}`, `user:${username.toLowerCase()}`];
}
