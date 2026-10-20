import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  bindingProblems,
  displayRole,
  effectiveBindings,
  hasUserManager,
  passwordSecretName,
  userBindings,
  type RoleBinding,
  type CreateUserRequest,
  type Me,
  type NavigatorResource,
  type NavigatorUserSpec,
  type UpdateUserRequest,
  type User,
} from '@capi-navigator/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { isConflict, isNotFound, toHttpException } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';
import { burnVerifyTime, hashPassword, verifyPassword } from './password-hasher.js';
import type { Principal } from './principal.js';
import { TokensService } from './tokens.service.js';

export const INITIAL_ADMIN_USERNAME = 'admin';
export const INITIAL_ADMIN_SECRET = 'capi-navigator-initial-admin';

type UserResource = NavigatorResource<NavigatorUserSpec>;

/** Local user accounts stored as NavigatorUser resources plus password Secrets (FP1-F-01, FP1-F-05). */
@Injectable()
export class UsersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly store: StoreService,
    private readonly tokens: TokensService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureInitialAdmin();
  }

  list(): User[] {
    return this.store.userCache.list().map(toUser);
  }

  get(username: string): User {
    return toUser(this.require(username));
  }

  /** Returns the principal for valid credentials of an enabled user. */
  async verifyCredentials(username: string, password: string): Promise<Principal | undefined> {
    const user = this.store.userCache.get(username);
    // Technical users never sign in (FP22-F-01); same timing as a wrong password.
    const canSignIn = user && !user.spec.disabled && user.spec.apiOnly !== true;
    const hash = canSignIn ? await this.passwordHash(username) : undefined;
    if (!user || !hash) {
      await burnVerifyTime(password);
      return undefined;
    }
    if (!(await verifyPassword(password, hash))) return undefined;
    return {
      username,
      bindings: userBindings(user.spec),
      mustChangePassword: user.spec.mustChangePassword,
    };
  }

  /** The signed-in user with the permissions of each assignment (FP19-F-10). */
  me(principal: Principal): Me {
    return {
      username: principal.username,
      role: displayRole(principal.bindings),
      bindings: effectiveBindings(principal.bindings, this.store.rolePermissions),
      mustChangePassword: principal.mustChangePassword,
      source: principal.oidc ? 'oidc' : 'local',
      ...(principal.oidc ? { groups: principal.oidc.groups, subject: principal.oidc.subject } : {}),
    };
  }

  sessionGeneration(username: string): number {
    return this.require(username).spec.sessionGeneration;
  }

  async create(req: CreateUserRequest): Promise<User> {
    if (this.store.userCache.get(req.username)) {
      throw new ConflictException(`User "${req.username}" already exists`);
    }
    const bindings = req.bindings ?? [{ role: req.role! }];
    this.assertValidBindings(bindings);
    const created = await this.kube(`Create user ${req.username}`, () =>
      this.store.users.create(
        { name: req.username, labels: { 'app.kubernetes.io/part-of': 'capi-navigator' } },
        {
          bindings,
          disabled: false,
          // Technical users have no password and nothing to change (FP22-F-01).
          apiOnly: req.apiOnly === true,
          mustChangePassword: req.apiOnly !== true,
          sessionGeneration: 0,
        },
      ),
    );
    try {
      if (req.password !== undefined) await this.writePassword(req.username, req.password);
    } catch (err) {
      await this.store.users.delete(req.username).catch(() => undefined);
      throw toHttpException(err, `Store password of ${req.username}`);
    }
    this.store.userCache.upsert(created);
    return toUser(created);
  }

  async update(username: string, req: UpdateUserRequest, actor: Principal): Promise<User> {
    const user = this.require(username);
    if (username === actor.username) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'You cannot change your own role assignments or disable yourself',
        hint: 'Ask another user manager to do it.',
      });
    }
    const current = userBindings(user.spec);
    const bindings = req.bindings ?? (req.role !== undefined ? [{ role: req.role }] : undefined);
    if (bindings) this.assertValidBindings(bindings);
    const disabled = req.disabled ?? user.spec.disabled;
    this.assertUserManagerRemains(username, { disabled, bindings: bindings ?? current });

    const bindingsChanged = bindings !== undefined && !sameBindings(bindings, current);
    const disabledChanged = disabled !== user.spec.disabled;
    const patch: Partial<NavigatorUserSpec> = {
      ...(bindingsChanged ? { bindings } : {}),
      ...(disabledChanged ? { disabled } : {}),
      // Changed assignments and disabling end all sessions of the user (as in FP-1).
      ...(bindingsChanged || disabledChanged
        ? { sessionGeneration: user.spec.sessionGeneration + 1 }
        : {}),
    };
    return toUser(await this.patch(user, patch));
  }

  async delete(username: string, actor: Principal): Promise<void> {
    this.require(username);
    if (username === actor.username) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'You cannot delete your own account',
        hint: 'Ask another admin to do it.',
      });
    }
    this.assertUserManagerRemains(username, undefined);
    await this.kube(`Delete user ${username}`, () => this.store.users.delete(username));
    this.store.userCache.remove(username);
    await this.store.secrets.delete(passwordSecretName(username));
    await this.tokens.removeAll(username);
  }

  /** Admin sets a temporary password; the user must change it at next login (FP1-F-05). */
  async resetPassword(username: string, password: string): Promise<User> {
    const user = this.require(username);
    if (user.spec.apiOnly === true) {
      throw new BadRequestException({
        statusCode: 400,
        message: `"${username}" is a technical user without password`,
        hint: 'Technical users authenticate with API tokens.',
      });
    }
    await this.kube(`Store password of ${username}`, () => this.writePassword(username, password));
    return toUser(
      await this.patch(user, {
        mustChangePassword: true,
        sessionGeneration: user.spec.sessionGeneration + 1,
      }),
    );
  }

  /** The user changes their own password; returns the new session generation (FP1-F-02). */
  async changeOwnPassword(username: string, current: string, next: string): Promise<number> {
    const user = this.require(username);
    if (!(await this.verifyCredentials(username, current))) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'The current password is wrong',
        fieldErrors: { currentPassword: ['The current password is wrong'] },
      });
    }
    await this.kube(`Store password of ${username}`, () => this.writePassword(username, next));
    const updated = await this.patch(user, {
      mustChangePassword: false,
      sessionGeneration: user.spec.sessionGeneration + 1,
    });
    return updated.spec.sessionGeneration;
  }

  /**
   * FP1-F-02: on first start (no users at all), create `admin` with the password from
   * INITIAL_ADMIN_PASSWORD or the Secret capi-navigator-initial-admin. If neither exists, a random
   * password is generated and stored in that Secret. The admin must change it on first login.
   */
  async ensureInitialAdmin(): Promise<void> {
    if (this.store.userCache.list().length > 0) return;
    const fromSecret = (await this.store.secrets.get(INITIAL_ADMIN_SECRET))?.password;
    let password = this.config.INITIAL_ADMIN_PASSWORD ?? fromSecret;
    if (!password) {
      password = randomBytes(18).toString('base64url');
      try {
        await this.store.secrets.create(INITIAL_ADMIN_SECRET, { password });
      } catch (err) {
        if (!isConflict(err)) throw err;
        return; // another replica is bootstrapping
      }
      this.logger.warn(
        `Generated a password for the initial admin. Read it with: kubectl -n ${this.store.namespace} get secret ${INITIAL_ADMIN_SECRET} -o jsonpath='{.data.password}' | base64 -d`,
      );
    }
    try {
      const created = await this.store.users.create(
        { name: INITIAL_ADMIN_USERNAME, labels: { 'app.kubernetes.io/part-of': 'capi-navigator' } },
        {
          bindings: [{ role: 'admin' }],
          disabled: false,
          apiOnly: false,
          mustChangePassword: true,
          sessionGeneration: 0,
        },
      );
      await this.writePassword(INITIAL_ADMIN_USERNAME, password);
      this.store.userCache.upsert(created);
      this.logger.log(
        `Created initial admin "${INITIAL_ADMIN_USERNAME}" (password change required)`,
      );
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
  }

  private require(username: string): UserResource {
    const user = this.store.userCache.get(username);
    if (!user) throw new NotFoundException(`User "${username}" not found`);
    return user;
  }

  /** Assignments must name existing roles and fit their limits (FP19-F-03). */
  private assertValidBindings(bindings: readonly RoleBinding[]): void {
    const problems = bindingProblems(bindings, this.store.rolePermissions);
    if (problems.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        message: problems[0],
        hint: problems.slice(1).join(' ') || undefined,
        fieldErrors: { bindings: problems },
      });
    }
  }

  /**
   * FP19-F-08: at least one enabled user keeps an unlimited assignment with users.manage after
   * `username` is changed to `next` (or deleted when `next` is undefined).
   */
  private assertUserManagerRemains(
    username: string,
    next: { disabled: boolean; bindings: RoleBinding[] } | undefined,
  ): void {
    const users = this.store.userCache
      .list()
      .filter((u) => u.metadata.name !== username)
      .map((u) => ({ disabled: u.spec.disabled, bindings: userBindings(u.spec) }));
    if (next) users.push(next);
    if (!hasUserManager(users, this.store.rolePermissions)) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'At least one enabled user must keep an unlimited assignment with users.manage',
        hint: 'Give another user the admin role (or a role with users.manage) without limits first.',
      });
    }
  }

  private async patch(user: UserResource, spec: Partial<NavigatorUserSpec>): Promise<UserResource> {
    const updated = await this.kube(`Update user ${user.metadata.name}`, () =>
      this.store.users.patchSpec(user.metadata.name, spec, user.metadata.resourceVersion),
    );
    this.store.userCache.upsert(updated);
    return updated;
  }

  private async passwordHash(username: string): Promise<string | undefined> {
    return (await this.store.secrets.get(passwordSecretName(username)))?.hash;
  }

  private async writePassword(username: string, password: string): Promise<void> {
    await this.store.secrets.put(
      passwordSecretName(username),
      { hash: await hashPassword(password) },
      { 'capi-navigator.io/user': username },
    );
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

const sameBindings = (a: readonly RoleBinding[], b: readonly RoleBinding[]) =>
  JSON.stringify(a) === JSON.stringify(b);

function toUser(u: UserResource): User {
  const bindings = userBindings(u.spec);
  return {
    username: u.metadata.name,
    role: displayRole(bindings),
    bindings,
    disabled: u.spec.disabled,
    apiOnly: u.spec.apiOnly === true,
    mustChangePassword: u.spec.mustChangePassword,
    ...(u.metadata.creationTimestamp ? { createdAt: String(u.metadata.creationTimestamp) } : {}),
  };
}
