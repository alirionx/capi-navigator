import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  API_TOKEN_PREFIX,
  userBindings,
  type CreateTokenRequest,
  type CreatedToken,
  type NavigatorResource,
  type NavigatorTokenSpec,
  type NavigatorTokenStatus,
  type TokenInfo,
} from '@capi-navigator/shared';
import { CreateTokenRequestSchema } from '@capi-navigator/shared';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';
import type { Principal } from './principal.js';

type TokenResource = NavigatorResource<NavigatorTokenSpec, NavigatorTokenStatus>;

/** "Last used" is written at most this often per token (FP22-F-09). */
const LAST_USED_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * API tokens of technical users (FP-22, ADR-0017): generated and revoked by users with
 * users.manage, stored as SHA-256 hash in a NavigatorToken resource, accepted as bearer token.
 */
@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);
  /** Last "last used" write per token id, to write at most hourly across requests. */
  private readonly touched = new Map<string, number>();

  /** Clock; replaced in tests. */
  now: () => number = Date.now;

  constructor(private readonly store: StoreService) {}

  list(username: string): TokenInfo[] {
    this.requireTechnicalUser(username);
    return this.tokensOf(username)
      .map((t) => this.toInfo(t))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Generates a token; the response is the only place the token value ever appears. */
  async create(
    username: string,
    input: CreateTokenRequest,
    actor: Principal,
  ): Promise<CreatedToken> {
    const req = CreateTokenRequestSchema.parse(input);
    this.requireTechnicalUser(username);
    if (this.tokensOf(username).some((t) => t.spec.name === req.name)) {
      throw new ConflictException(`User "${username}" already has a token "${req.name}"`);
    }
    const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = `token-${randomBytes(6).toString('hex')}`;
    const created = await this.kube(`Create token ${req.name}`, () =>
      this.store.tokens.create(
        {
          name: id,
          labels: {
            'app.kubernetes.io/part-of': 'capi-navigator',
            'capi-navigator.io/user': username,
          },
        },
        {
          user: username,
          name: req.name,
          ...(req.description ? { description: req.description } : {}),
          sha256: sha256(token),
          expiresAt: new Date(this.now() + req.expiresInDays * DAY_MS).toISOString(),
          createdBy: actor.username,
        },
      ),
    );
    this.store.tokenCache.upsert(created);
    return { ...this.toInfo(created as TokenResource), token };
  }

  /** Revoking takes effect on the next request (FP22-F-04). */
  async revoke(username: string, id: string): Promise<void> {
    const token = this.store.tokenCache.get(id) as TokenResource | undefined;
    if (!token || token.spec.user !== username) {
      throw new NotFoundException(`Token "${id}" of user "${username}" not found`);
    }
    await this.kube(`Revoke token ${token.spec.name}`, () => this.store.tokens.delete(id));
    this.store.tokenCache.remove(id);
    this.touched.delete(id);
  }

  /** Removes all tokens of a user, e.g. when the user is deleted. */
  async removeAll(username: string): Promise<void> {
    for (const t of this.tokensOf(username)) {
      await this.store.tokens.delete(t.metadata.name).catch((err: unknown) => {
        if (!isNotFound(err)) throw err;
      });
      this.store.tokenCache.remove(t.metadata.name);
    }
  }

  /**
   * The principal of a bearer token, or undefined for unknown, expired or revoked tokens and for
   * tokens of disabled, deleted or non-technical users (FP22-F-04).
   */
  authenticate(bearer: string): Principal | undefined {
    if (!bearer.startsWith(API_TOKEN_PREFIX)) return undefined;
    const hash = sha256(bearer);
    const token = this.all().find((t) => t.spec.sha256 === hash);
    if (!token || Date.parse(token.spec.expiresAt) <= this.now()) return undefined;
    const user = this.store.userCache.get(token.spec.user);
    if (!user || user.spec.disabled || !user.spec.apiOnly) return undefined;
    this.touch(token);
    return {
      username: user.metadata.name,
      bindings: userBindings(user.spec),
      mustChangePassword: false,
      token: { id: token.metadata.name, name: token.spec.name },
    };
  }

  /** Writes "last used" at most hourly; failures only cost the timestamp (FP22-F-09). */
  private touch(token: TokenResource): void {
    const now = this.now();
    const last = Math.max(
      this.touched.get(token.metadata.name) ?? 0,
      Date.parse(token.status?.lastUsedAt ?? '') || 0,
    );
    if (now - last < LAST_USED_INTERVAL_MS) return;
    this.touched.set(token.metadata.name, now);
    this.store.tokens
      .patchStatus(token.metadata.name, { lastUsedAt: new Date(now).toISOString() })
      .then((updated) => this.store.tokenCache.upsert(updated))
      .catch((err: unknown) =>
        this.logger.warn(`Cannot record last use of a token: ${String(err)}`),
      );
  }

  private requireTechnicalUser(username: string): void {
    const user = this.store.userCache.get(username);
    if (!user) throw new NotFoundException(`User "${username}" not found`);
    if (!user.spec.apiOnly) {
      throw new BadRequestException({
        statusCode: 400,
        message: `"${username}" is not a technical user; tokens are only for technical users`,
        hint: 'Create a user with "API only" for scripts and pipelines.',
      });
    }
  }

  private tokensOf(username: string): TokenResource[] {
    return this.all().filter((t) => t.spec.user === username);
  }

  /** Cached tokens; the cache is typed by spec only, the status shape is FP22-F-09's. */
  private all(): TokenResource[] {
    return this.store.tokenCache.list() as TokenResource[];
  }

  private toInfo(t: TokenResource): TokenInfo {
    return {
      id: t.metadata.name,
      name: t.spec.name,
      ...(t.spec.description ? { description: t.spec.description } : {}),
      createdAt: t.metadata.creationTimestamp ?? new Date(this.now()).toISOString(),
      createdBy: t.spec.createdBy,
      expiresAt: t.spec.expiresAt,
      ...(t.status?.lastUsedAt ? { lastUsedAt: t.status.lastUsedAt } : {}),
      expired: Date.parse(t.spec.expiresAt) <= this.now(),
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
