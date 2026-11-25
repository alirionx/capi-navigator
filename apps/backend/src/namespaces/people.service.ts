import { Injectable } from '@nestjs/common';
import {
  personKey,
  type AssignablePeople,
  type ManagedNamespaceSpec,
  type NamespacePerson,
} from '@capi-navigator/shared';
import { AuthSettingsService } from '../auth/auth-settings.service.js';
import { GroupsService } from '../auth/groups.service.js';
import type { Principal } from '../auth/principal.js';
import { StoreService } from '../store/store.service.js';

/** Who a signed-in person is for the assignments of managed namespaces (FP37-F-02, ADR-0041). */
@Injectable()
export class PeopleService {
  constructor(
    private readonly store: StoreService,
    private readonly groups: GroupsService,
    private readonly settings: AuthSettingsService,
  ) {}

  /** The person itself; undefined for API tokens, and for OIDC sessions of another provider. */
  identity(principal: Principal): string | undefined {
    if (principal.token) return undefined;
    // Without any known role an admin has taken all access away.
    if (!principal.bindings.some((b) => this.store.rolePermissions(b.role))) return undefined;
    if (principal.oidc) {
      const { issuer, subject } = principal.oidc;
      return issuer && issuer === this.settings.active()?.issuerUrl
        ? personKey({ kind: 'person', issuer, subject })
        : undefined;
    }
    return principal.uid
      ? personKey({ kind: 'user', name: principal.username, uid: principal.uid })
      : undefined;
  }

  /** Every assignment that applies to the person: itself and its groups that are still mapped. */
  keys(principal: Principal): string[] {
    const self = this.identity(principal);
    if (!self) return [];
    const issuer = principal.oidc?.issuer;
    return [
      self,
      ...(issuer
        ? this.groups
            .mapped(principal.oidc!.groups)
            .map((group) => personKey({ kind: 'group', issuer, group }))
        : []),
    ];
  }

  /**
   * The reduced list for the owner of a cluster: names only, no roles, no technical or disabled
   * users. OIDC people are those with a mapping and those who signed in recently.
   */
  async assignable(): Promise<AssignablePeople> {
    const users = this.store.userCache
      .list()
      .filter((u) => !u.spec.apiOnly && !u.spec.disabled && u.metadata.uid)
      .map((u): NamespacePerson => ({ kind: 'user', name: u.metadata.name, uid: u.metadata.uid! }));
    const issuer = this.settings.active()?.issuerUrl;
    if (!issuer) return sorted(users);
    const people = new Map<string, NamespacePerson>();
    const add = (p: NamespacePerson) => {
      if (!people.has(personKey(p))) people.set(personKey(p), p);
    };
    for (const m of this.groups.list()) {
      if (m.kind === 'group' && m.group) add({ kind: 'group', issuer, group: m.group });
      if (m.kind === 'person' && m.subject && m.issuer === issuer) {
        add({
          kind: 'person',
          issuer,
          subject: m.subject,
          ...(m.displayName ? { displayName: m.displayName } : {}),
        });
      }
    }
    for (const s of await this.groups.signIns()) {
      if (s.outcome === 'success') {
        add({ kind: 'person', issuer, subject: s.subject, displayName: s.name });
      }
    }
    return sorted([...users, ...people.values()]);
  }

  /** Why newly assigned people cannot be assigned; entries already stored stay as they are. */
  problems(spec: ManagedNamespaceSpec, current: ManagedNamespaceSpec | undefined): string[] {
    const known = new Set(current?.accounts.flatMap((a) => a.people.map(personKey)));
    const issuer = this.settings.active()?.issuerUrl;
    return [
      ...new Set(
        spec.accounts
          .flatMap((a) => a.people)
          .filter((p) => !known.has(personKey(p)))
          .flatMap((p) => {
            if (p.kind === 'user') {
              const user = this.store.userCache.get(p.name);
              return user && !user.spec.apiOnly && user.metadata.uid === p.uid
                ? []
                : [`User ${p.name} does not exist or cannot sign in`];
            }
            if (p.issuer !== issuer) {
              return ['The person or group belongs to another OpenID Connect provider'];
            }
            return p.kind === 'group' && !this.groups.mapped([p.group]).length
              ? [`Group ${p.group} is not mapped in the app`]
              : [];
          }),
      ),
    ];
  }
}

const ORDER = { user: 0, group: 1, person: 2 };
const name = (p: NamespacePerson) =>
  p.kind === 'user' ? p.name : p.kind === 'group' ? p.group : (p.displayName ?? p.subject);
const sorted = (people: NamespacePerson[]) =>
  people.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || name(a).localeCompare(name(b)));
