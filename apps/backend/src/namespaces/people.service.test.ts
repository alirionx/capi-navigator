import {
  ManagedNamespaceSpecSchema,
  NAMESPACE_PROFILE_QUOTAS,
  NAMESPACE_USER_ROLE,
  type NamespacePerson,
} from '@capi-navigator/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthSettingsService } from '../auth/auth-settings.service.js';
import type { GroupsService } from '../auth/groups.service.js';
import type { Principal } from '../auth/principal.js';
import type { StoreService } from '../store/store.service.js';
import { PeopleService } from './people.service.js';

const ISSUER = 'https://idp';
const local = (over: Partial<Principal> = {}): Principal => ({
  username: 'max',
  uid: 'uid-1',
  bindings: [{ role: NAMESPACE_USER_ROLE }],
  mustChangePassword: false,
  ...over,
});
const oidc = (over: Partial<NonNullable<Principal['oidc']>> = {}): Principal => ({
  username: 'Eva (oidc)',
  bindings: [{ role: NAMESPACE_USER_ROLE }],
  mustChangePassword: false,
  oidc: { subject: 's-1', groups: ['devs', 'unmapped'], issuer: ISSUER, ...over },
});
const spec = (people: NamespacePerson[]) =>
  ManagedNamespaceSpecSchema.parse({
    name: 'team-a',
    namespace: 'team',
    clusterSelector: { a: 'b' },
    quota: NAMESPACE_PROFILE_QUOTAS.small,
    accounts: [{ name: 'ci', people }],
  });

describe('people of managed namespaces (FP37-F-02, ADR-0041)', () => {
  let issuer: string | undefined;
  let users: Record<string, { uid?: string; apiOnly?: boolean; disabled?: boolean }>;
  const userObject = ([name, u]: [string, (typeof users)[string]]) => ({
    metadata: { name, ...(u.uid ? { uid: u.uid } : {}) },
    spec: { apiOnly: !!u.apiOnly, disabled: !!u.disabled },
  });
  const service = new PeopleService(
    {
      rolePermissions: (r: string) => (r === NAMESPACE_USER_ROLE ? [] : undefined),
      userCache: {
        get: (n: string) => (users[n] ? userObject([n, users[n]]) : undefined),
        list: () => Object.entries(users).map(userObject),
      },
    } as unknown as StoreService,
    {
      mapped: (g: string[]) => g.filter((x) => x === 'devs'),
      list: () => [
        { kind: 'group', group: 'devs' },
        { kind: 'person', subject: 's-1', issuer: ISSUER, displayName: 'Eva' },
        { kind: 'person', subject: 'old', issuer: 'https://other' },
      ],
      signIns: async () => [
        { subject: 's-1', name: 'Eva from the sign-in', outcome: 'success' },
        { subject: 's-2', name: 'Tom', outcome: 'success' },
        { subject: 's-3', name: 'Refused', outcome: 'failure' },
      ],
    } as unknown as GroupsService,
    {
      active: () => (issuer ? { issuerUrl: issuer } : undefined),
    } as unknown as AuthSettingsService,
  );

  beforeEach(() => {
    issuer = ISSUER;
    users = {
      max: { uid: 'uid-1' },
      robot: { uid: 'uid-2', apiOnly: true },
      gone: { uid: 'uid-3', disabled: true },
    };
  });

  it('identifies local users by UID and OIDC people by issuer, subject and mapped groups', () => {
    expect(service.keys(local())).toEqual(['user:uid-1']);
    expect(service.keys(oidc())).toEqual([`person:${ISSUER}#s-1`, `group:${ISSUER}#devs`]);
  });

  it('is nobody for API tokens, other providers, old sessions and people without a role', () => {
    const nobody: Principal[] = [
      local({ token: { id: 't', name: 't' } }),
      { ...local(), bindings: [] },
      local({ bindings: [{ role: 'deleted-role' }] }),
      { username: 'max', bindings: [{ role: NAMESPACE_USER_ROLE }], mustChangePassword: false },
      oidc({ issuer: 'https://other' }),
      { ...oidc(), oidc: { subject: 's-1', groups: ['devs'] } },
    ];
    for (const p of nobody) expect(service.keys(p)).toEqual([]);
    issuer = undefined;
    expect(service.keys(oidc())).toEqual([]);
  });

  it('never matches a local user with the name of an OIDC person', () => {
    const impostor = local({ username: 'Eva (oidc)' });
    expect(service.keys(impostor)).toEqual(['user:uid-1']);
  });

  it('offers names only, without technical, disabled and refused people', async () => {
    expect(await service.assignable()).toEqual([
      { kind: 'user', name: 'max', uid: 'uid-1' },
      { kind: 'group', issuer: ISSUER, group: 'devs' },
      { kind: 'person', issuer: ISSUER, subject: 's-1', displayName: 'Eva' },
      { kind: 'person', issuer: ISSUER, subject: 's-2', displayName: 'Tom' },
    ]);
    issuer = undefined;
    expect(await service.assignable()).toEqual([{ kind: 'user', name: 'max', uid: 'uid-1' }]);
  });

  it('refuses new people that do not exist, but keeps stored ones', () => {
    const wrong: NamespacePerson[] = [
      { kind: 'user', name: 'max', uid: 'of-a-deleted-max' },
      { kind: 'user', name: 'robot', uid: 'uid-2' },
      { kind: 'person', issuer: 'https://other', subject: 's-1' },
      { kind: 'group', issuer: ISSUER, group: 'unmapped' },
    ];
    expect(service.problems(spec(wrong), undefined)).toEqual([
      'User max does not exist or cannot sign in',
      'User robot does not exist or cannot sign in',
      'The person or group belongs to another OpenID Connect provider',
      'Group unmapped is not mapped in the app',
    ]);
    expect(service.problems(spec(wrong), spec(wrong))).toEqual([]);
    expect(
      service.problems(
        spec([
          { kind: 'user', name: 'max', uid: 'uid-1' },
          { kind: 'group', issuer: ISSUER, group: 'devs' },
        ]),
        undefined,
      ),
    ).toEqual([]);
  });
});
