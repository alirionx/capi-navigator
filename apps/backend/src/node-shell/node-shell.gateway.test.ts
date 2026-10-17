import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { checkUpgrade, parseShellRoute } from './node-shell.gateway.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
const user = (role: 'viewer' | 'operator' | 'admin', mustChangePassword = false) => ({
  username: 'u',
  role,
  mustChangePassword,
});

describe('node shell upgrade (FP-17, ADR-0008)', () => {
  it('parses workload and management routes with their minimum roles', () => {
    expect(
      parseShellRoute('/api/connections/home/clusters/team-a/demo/nodes/ip-10-0-1-2/shell'),
    ).toEqual({
      target: {
        kind: 'workload',
        connection: 'home',
        namespace: 'team-a',
        cluster: 'demo',
        node: 'ip-10-0-1-2',
      },
      minRole: 'operator',
    });
    expect(parseShellRoute('/api/connections/home/nodes/kind-cp/shell')).toEqual({
      target: { kind: 'management', connection: 'home', node: 'kind-cp' },
      minRole: 'admin',
    });
    expect(parseShellRoute('/api/connections/home/nodes')).toBeUndefined();
  });

  it('requires the same origin, a session and the role', () => {
    const workload = parseShellRoute('/api/connections/h/clusters/n/c/nodes/x/shell')!;
    const mgmt = parseShellRoute('/api/connections/h/nodes/x/shell')!;
    const same = req({ origin: 'http://app:3000', host: 'app:3000' });
    expect(checkUpgrade(same, user('operator'), workload)).toBeUndefined();
    expect(checkUpgrade(req({ host: 'app:3000' }), user('admin'), workload)).toBe(403);
    expect(
      checkUpgrade(req({ origin: 'http://evil', host: 'app:3000' }), user('admin'), workload),
    ).toBe(403);
    expect(checkUpgrade(same, undefined, workload)).toBe(401);
    expect(checkUpgrade(same, user('viewer'), workload)).toBe(403);
    expect(checkUpgrade(same, user('operator'), mgmt)).toBe(403);
    expect(checkUpgrade(same, user('admin'), mgmt)).toBeUndefined();
    expect(checkUpgrade(same, user('admin', true), mgmt)).toBe(403);
  });
});
