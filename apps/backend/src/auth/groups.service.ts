import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateGroupMappingRequest,
  GroupMapping,
  NavigatorGroupSpec,
  NavigatorResource,
  OidcSignIn,
  RoleBinding,
  UpdateGroupMappingRequest,
} from '@capi-navigator/shared';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';
import { AuthSettingsService } from './auth-settings.service.js';

type GroupResource = NavigatorResource<NavigatorGroupSpec>;

/** At most this many sign-in events are read for the list (FP14-F-15). */
const SIGN_IN_EVENT_LIMIT = 1000;

const hash = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);

/** Resource name of the mapping of a provider group: any group text gives a valid, stable name. */
export function groupResourceName(group: string): string {
  return `group-${hash(group)}`;
}

/** Resource name of the mapping of one person: subject per issuer (ADR-0019). */
export function personResourceName(issuer: string, subject: string): string {
  return `person-${hash(`${issuer}\n${subject}`)}`;
}

/**
 * Mappings of OpenID Connect groups and people to role assignments (FP14-F-04) as NavigatorGroup
 * resources, and the access of a person from them (FP14-F-05).
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly store: StoreService,
    private readonly settings: AuthSettingsService,
  ) {}

  list(): GroupMapping[] {
    return this.store.groupCache
      .list()
      .map((g) => toMapping(g))
      .sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          (a.group ?? a.displayName ?? a.subject ?? '').localeCompare(
            b.group ?? b.displayName ?? b.subject ?? '',
          ),
      );
  }

  /** The groups of `groups` that have a mapping; only these go into the session (FP14-F-06). */
  mapped(groups: readonly string[]): string[] {
    return [...new Set(groups)].filter((g) => this.store.groupCache.get(groupResourceName(g)));
  }

  /**
   * Role assignments of a person, resolved on every request: the union of the mappings of their
   * groups and of their person mapping, or the default role if there is none (anymore).
   * Empty: no access.
   */
  bindings(groups: readonly string[], subject?: string): RoleBinding[] {
    const mapped = [
      ...groups.flatMap(
        (g) => this.store.groupCache.get(groupResourceName(g))?.spec.bindings ?? [],
      ),
      ...(subject ? this.personBindings(subject) : []),
    ];
    if (mapped.length > 0) return mapped;
    return this.defaultBindings();
  }

  /** Mapping of the person for the current provider only (FP14-F-04). */
  private personBindings(subject: string): RoleBinding[] {
    const issuer = this.settings.active()?.issuerUrl;
    if (!issuer) return [];
    const person = this.store.groupCache.get(personResourceName(issuer, subject));
    return person?.spec.issuer === issuer && person.spec.subject === subject
      ? person.spec.bindings
      : [];
  }

  /** FP14-F-05: the configured default role without limits; none if unset or unknown. */
  defaultBindings(): RoleBinding[] {
    const role = this.settings.active()?.defaultRole.trim() ?? '';
    return role && this.store.rolePermissions(role) ? [{ role }] : [];
  }

  async create(req: CreateGroupMappingRequest): Promise<GroupMapping> {
    this.checkRoles(req.bindings);
    let name: string;
    let target: string;
    let next: NavigatorGroupSpec;
    if ('group' in req) {
      const group = req.group.trim();
      name = groupResourceName(group);
      target = `group "${group}"`;
      next = { group, ...common(req) };
    } else {
      // A person mapping belongs to the configured provider (ADR-0019).
      const issuer = this.settings.stored()?.issuerUrl;
      if (!issuer) {
        throw new BadRequestException({
          statusCode: 400,
          message: 'Set up the OpenID Connect provider first',
          hint: 'A person is mapped for the issuer on the Authentication page.',
        });
      }
      const subject = req.subject.trim();
      name = personResourceName(issuer, subject);
      target = `person "${subject}"`;
      next = {
        subject,
        issuer,
        ...(req.displayName?.trim() ? { displayName: req.displayName.trim() } : {}),
        ...common(req),
      };
    }
    if (this.store.groupCache.get(name)) {
      throw new ConflictException(`The ${target} already has a mapping`);
    }
    const created = await this.kube(`Create mapping of ${target}`, () =>
      this.store.groups.create(
        { name, labels: { 'app.kubernetes.io/part-of': 'capi-navigator' } },
        next,
      ),
    );
    this.store.groupCache.upsert(created);
    return toMapping(created);
  }

  /** Applies on the next request of everyone in the group, or of the person (FP14-F-04). */
  async update(name: string, req: UpdateGroupMappingRequest): Promise<GroupMapping> {
    const current = this.require(name);
    this.checkRoles(req.bindings);
    // The identity (group, or subject and issuer) never changes.
    const { group, subject, issuer } = current.spec;
    const next: NavigatorGroupSpec = {
      ...(group ? { group } : {}),
      ...(subject ? { subject, issuer } : {}),
      ...(subject && req.displayName?.trim() ? { displayName: req.displayName.trim() } : {}),
      ...common(req),
    };
    const updated = await this.kube(`Update mapping ${name}`, () =>
      // Merge patch: null removes a cleared description or display name.
      this.store.groups.patchSpec(
        name,
        { description: null, displayName: null, ...next } as unknown as NavigatorGroupSpec,
        current.metadata.resourceVersion,
      ),
    );
    this.store.groupCache.upsert(updated);
    return toMapping(updated);
  }

  async delete(name: string): Promise<void> {
    this.require(name);
    await this.kube(`Delete mapping ${name}`, () => this.store.groups.delete(name));
    this.store.groupCache.remove(name);
  }

  /**
   * Recent sign-ins with the configured provider (FP14-F-15), from the audit log: one row per
   * person with the latest sign-in and where their access comes from now. Events without issuer
   * (before this list existed) or of another provider are left out.
   */
  async signIns(): Promise<OidcSignIn[]> {
    const issuer = this.settings.stored()?.issuerUrl;
    if (!issuer) return [];
    const latest = new Map<string, OidcSignIn & { groups: string[] }>();
    let token: string | undefined;
    let read = 0;
    do {
      const page = await this.kube('Read the sign-ins from the audit log', () =>
        this.store.auditEvents.list({
          labelSelector: 'capi-navigator.io/action=auth.oidc.login',
          limit: 500,
          ...(token ? { _continue: token } : {}),
        }),
      );
      for (const { spec: e } of page.items) {
        if (e.issuer !== issuer || !e.subject) continue;
        const known = latest.get(e.subject);
        if (known && known.lastSignIn >= e.timestamp) continue;
        latest.set(e.subject, {
          subject: e.subject,
          name: e.actor.replace(/ \(oidc\)$/, ''),
          lastSignIn: e.timestamp,
          outcome: e.outcome,
          access: { kind: 'none', detail: [] },
          groups: e.groups ?? [],
        });
      }
      read += page.items.length;
      token = page.continue;
    } while (token && read < SIGN_IN_EVENT_LIMIT);

    return [...latest.values()]
      .map(({ groups, ...row }) => ({ ...row, ...this.access(issuer, row.subject, groups) }))
      .sort((a, b) => b.lastSignIn.localeCompare(a.lastSignIn));
  }

  /** Where a person's access comes from now: person mapping, groups, default role or none. */
  private access(
    issuer: string,
    subject: string,
    groups: string[],
  ): Pick<OidcSignIn, 'access' | 'mapping'> {
    const mappedGroups = groups.filter((g) => this.store.groupCache.get(groupResourceName(g)));
    const person = this.store.groupCache.get(personResourceName(issuer, subject));
    if (person?.spec.issuer === issuer && person.spec.subject === subject) {
      return { access: { kind: 'person', detail: mappedGroups }, mapping: person.metadata.name };
    }
    if (mappedGroups.length) return { access: { kind: 'groups', detail: mappedGroups } };
    const fallback = this.defaultBindings();
    return fallback.length
      ? { access: { kind: 'default', detail: fallback.map((b) => b.role) } }
      : { access: { kind: 'none', detail: [] } };
  }

  /** Groups and people whose mapping uses `role`, for the role management (FP19-F-08). */
  groupsWithRole(role: string): string[] {
    return this.list()
      .filter((m) => m.bindings.some((b) => b.role === role))
      .map((m) => m.group ?? `${m.displayName ?? m.subject} (person)`);
  }

  private require(name: string): GroupResource {
    const group = this.store.groupCache.get(name);
    if (!group) throw new NotFoundException(`Group mapping "${name}" not found`);
    return group;
  }

  private checkRoles(bindings: readonly RoleBinding[]): void {
    const unknown = bindings.filter((b) => !this.store.rolePermissions(b.role)).map((b) => b.role);
    if (unknown.length) {
      throw new BadRequestException({
        statusCode: 400,
        message: `Unknown role: ${[...new Set(unknown)].join(', ')}`,
      });
    }
  }

  private async kube<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isNotFound(err)) throw new NotFoundException(`${context}: not found`);
      throw toHttpException(err, context);
    }
  }
}

function common(req: { description?: string; bindings: RoleBinding[] }) {
  return {
    ...(req.description?.trim() ? { description: req.description.trim() } : {}),
    bindings: req.bindings,
  };
}

function toMapping(g: GroupResource): GroupMapping {
  const { group, subject, issuer, displayName, description } = g.spec;
  return {
    name: g.metadata.name,
    kind: subject ? 'person' : 'group',
    ...(group ? { group } : {}),
    ...(subject ? { subject } : {}),
    ...(issuer ? { issuer } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    bindings: g.spec.bindings,
    ...(g.metadata.creationTimestamp ? { createdAt: g.metadata.creationTimestamp } : {}),
  };
}
