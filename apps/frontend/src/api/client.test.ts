import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, ApiError, onUnauthorized } from './client.js';

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe('API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the CSRF header on mutating requests only (NF-04)', async () => {
    respond(200, {});
    await api('POST', '/api/x', z.object({}), { a: 1 });
    await api('GET', '/api/x', z.object({}));
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect((calls[0]![1].headers as Record<string, string>)['x-capi-navigator']).toBe('1');
    expect((calls[1]![1].headers as Record<string, string>)['x-capi-navigator']).toBeUndefined();
  });

  it('turns error bodies into ApiErrors with hint and details (NF-06)', async () => {
    respond(502, { statusCode: 502, message: 'Cluster down', hint: 'Check it', details: 'raw' });
    const err = await api('GET', '/api/x', z.object({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 502,
      message: 'Cluster down',
      hint: 'Check it',
      details: 'raw',
    });
  });

  it('reports an expired session, but not failed logins', async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    respond(401, { statusCode: 401, message: 'expired' });
    await api('GET', '/api/users', z.object({})).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    respond(401, { statusCode: 401, message: 'wrong' });
    await api('POST', '/api/auth/login', z.object({}), {}).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
