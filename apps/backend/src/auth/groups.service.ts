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
  RoleBinding,
  UpdateGroupMappingRequest,
} from '@capi-navigator/shared';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';
import { AuthSettingsService } from './auth-settings.service.js';

type GroupResource = NavigatorResource<NavigatorGroupSpec>;

/** Resource name of the mapping of a provider group: any group text gives a valid, stable name. */
export function groupResourceName(group: string): string {
  return `group-${createHash('sha256').update(group, 'utf8').digest('hex').slice(0, 24)}`;
}

/**
 * Mappings of OpenID Connect groups to role assignments (FP14-F-04) as NavigatorGroup resources,
 * and the access of a person from their groups (FP14-F-05).
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
      .sort((a, b) => a.group.localeCompare(b.group));
  }

  /** The groups of `groups` that have a mapping; only these go into the session (FP14-F-06). */
  mapped(groups: readonly string[]): string[] {
    return [...new Set(groups)].filter((g) => this.store.groupCache.get(groupResourceName(g)));
  }

  /**
   * Role assignments of a person, resolved on every request: the union of the mappings of their
   * groups, or the default role if none of them is mapped (anymore). Empty: no access.
   */
  bindings(groups: readonly string[]): RoleBinding[] {
    const mapped = groups.flatMap(
      (g) => this.store.groupCache.get(groupResourceName(g))?.spec.bindings ?? [],
    );
    if (mapped.length > 0) return mapped;
    return this.defaultBindings();
  }

  /** FP14-F-05: the configured default role without limits; none if unset or unknown. */
  defaultBindings(): RoleBinding[] {
    const role = this.settings.active()?.defaultRole.trim() ?? '';
    return role && this.store.rolePermissions(role) ? [{ role }] : [];
  }

  async create(req: CreateGroupMappingRequest): Promise<GroupMapping> {
    const group = req.group.trim();
    const name = groupResourceName(group);
    if (this.store.groupCache.get(name)) {
      throw new ConflictException(`Group "${group}" already has a mapping`);
    }
    this.checkRoles(req.bindings);
    const created = await this.kube(`Create mapping of group ${group}`, () =>
      this.store.groups.create(
        { name, labels: { 'app.kubernetes.io/part-of': 'capi-navigator' } },
        spec({ ...req, group }),
      ),
    );
    this.store.groupCache.upsert(created);
    return toMapping(created);
  }

  /** Applies on the next request of everyone in the group (FP14-F-04). */
  async update(name: string, req: UpdateGroupMappingRequest): Promise<GroupMapping> {
    const current = this.require(name);
    this.checkRoles(req.bindings);
    const updated = await this.kube(`Update mapping ${name}`, () =>
      this.store.groups.patchSpec(
        name,
        spec({ ...req, group: current.spec.group }),
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

  /** Groups whose mapping uses `role`, for the role management (FP19-F-08). */
  groupsWithRole(role: string): string[] {
    return this.list()
      .filter((m) => m.bindings.some((b) => b.role === role))
      .map((m) => m.group);
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

function spec(req: CreateGroupMappingRequest): NavigatorGroupSpec {
  return {
    group: req.group,
    ...(req.description ? { description: req.description } : {}),
    bindings: req.bindings,
  };
}

function toMapping(g: GroupResource): GroupMapping {
  return {
    name: g.metadata.name,
    group: g.spec.group,
    ...(g.spec.description ? { description: g.spec.description } : {}),
    bindings: g.spec.bindings,
    ...(g.metadata.creationTimestamp ? { createdAt: g.metadata.creationTimestamp } : {}),
  };
}
