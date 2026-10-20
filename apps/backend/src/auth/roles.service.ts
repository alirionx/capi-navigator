import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BUILTIN_ROLES,
  hasUserManager,
  isBuiltinRole,
  ROLES,
  userBindings,
  type CreateRoleRequest,
  type NavigatorResource,
  type NavigatorRoleSpec,
  type Permission,
  type RoleInfo,
  type UpdateRoleRequest,
} from '@capi-navigator/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';
import { GroupsService } from './groups.service.js';

type RoleResource = NavigatorResource<NavigatorRoleSpec>;

/** Custom roles as NavigatorRole resources; built-in roles are fixed in code (FP19-F-01/02/08). */
@Injectable()
export class RolesService {
  constructor(
    private readonly store: StoreService,
    private readonly groups: GroupsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  list(): RoleInfo[] {
    const builtin = ROLES.map((name) => ({
      name,
      ...BUILTIN_ROLES[name],
      permissions: [...BUILTIN_ROLES[name].permissions],
      builtin: true,
      users: this.usersOf(name),
    }));
    const custom = this.store.roleCache
      .list()
      .map((r) => this.toInfo(r))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...builtin, ...custom];
  }

  async create(req: CreateRoleRequest): Promise<RoleInfo> {
    if (isBuiltinRole(req.name) || this.store.roleCache.get(req.name)) {
      throw new ConflictException(`Role "${req.name}" already exists`);
    }
    const created = await this.kube(`Create role ${req.name}`, () =>
      this.store.roles.create(
        { name: req.name, labels: { 'app.kubernetes.io/part-of': 'capi-navigator' } },
        spec(req),
      ),
    );
    this.store.roleCache.upsert(created);
    return this.toInfo(created);
  }

  /** Changes apply on the next request of every user with this role (FP19-F-06). */
  async update(name: string, req: UpdateRoleRequest): Promise<RoleInfo> {
    const role = this.requireCustom(name);
    const next = spec(req);
    const permissions = (r: string): readonly Permission[] | undefined =>
      r === name ? ['view', ...next.permissions] : this.store.rolePermissions(r);
    if (!hasUserManager(this.users(), permissions)) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Without users.manage in this role, no user could manage users anymore',
        hint: 'Give another user the admin role without limits first.',
      });
    }
    const updated = await this.kube(`Update role ${name}`, () =>
      this.store.roles.patchSpec(name, next, role.metadata.resourceVersion),
    );
    this.store.roleCache.upsert(updated);
    return this.toInfo(updated);
  }

  async delete(name: string): Promise<void> {
    this.requireCustom(name);
    const users = this.usersOf(name);
    if (users.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: `Role "${name}" is still assigned to ${users.join(', ')}`,
        hint: 'Remove the assignments in the user management first.',
      });
    }
    const groups = this.groups.groupsWithRole(name);
    if (groups.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: `Role "${name}" is still mapped to the OIDC groups ${groups.join(', ')}`,
        hint: 'Change the group mappings in the user management first.',
      });
    }
    if (this.config.OIDC_ISSUER_URL && this.config.OIDC_DEFAULT_ROLE.trim() === name) {
      throw new ConflictException({
        statusCode: 409,
        message: `Role "${name}" is the default role for OpenID Connect sign-in`,
        hint: 'Change OIDC_DEFAULT_ROLE (Helm value oidc.defaultRole) first.',
      });
    }
    await this.kube(`Delete role ${name}`, () => this.store.roles.delete(name));
    this.store.roleCache.remove(name);
  }

  private requireCustom(name: string): RoleResource {
    if (isBuiltinRole(name)) {
      throw new BadRequestException({
        statusCode: 400,
        message: `The built-in role "${name}" cannot be changed or deleted`,
        hint: 'Create a copy of it instead.',
      });
    }
    const role = this.store.roleCache.get(name);
    if (!role) throw new NotFoundException(`Role "${name}" not found`);
    return role;
  }

  private users() {
    return this.store.userCache.list().map((u) => ({
      name: u.metadata.name,
      disabled: u.spec.disabled,
      bindings: userBindings(u.spec),
    }));
  }

  private usersOf(role: string): string[] {
    return this.users()
      .filter((u) => u.bindings.some((b) => b.role === role))
      .map((u) => u.name)
      .sort();
  }

  private toInfo(r: RoleResource): RoleInfo {
    return {
      name: r.metadata.name,
      displayName: r.spec.displayName,
      ...(r.spec.description ? { description: r.spec.description } : {}),
      permissions: [...(this.store.rolePermissions(r.metadata.name) ?? [])],
      builtin: false,
      users: this.usersOf(r.metadata.name),
    };
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

/** Stored spec: `view` is implicit, the list is sorted in catalog order. */
function spec(req: UpdateRoleRequest): NavigatorRoleSpec {
  const permissions = [...new Set(req.permissions)].filter((p) => p !== 'view');
  return {
    displayName: req.displayName,
    ...(req.description ? { description: req.description } : {}),
    permissions,
  };
}
