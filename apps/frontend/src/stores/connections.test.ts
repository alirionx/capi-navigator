import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionsStore } from './connections.js';

const conn = (name: string, phase: string) => ({ name, authType: 'token', status: { phase } });

function respond(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

describe('connections store (FP2-F-05)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('selects the first reachable connection by default and remembers the choice', async () => {
    respond([conn('a', 'Unreachable'), conn('b', 'Reachable')]);
    const store = useConnectionsStore();
    await store.load();
    expect(store.activeName).toBe('b');
    store.setActive('a');
    expect(localStorage.getItem('capi-navigator.activeConnection')).toBe('a');
  });

  it('keeps a stored selection and replaces it when the connection is gone', async () => {
    localStorage.setItem('capi-navigator.activeConnection', 'gone');
    respond([conn('x', 'Unknown')]);
    const store = useConnectionsStore();
    await store.load();
    expect(store.activeName).toBe('x');
  });
});
