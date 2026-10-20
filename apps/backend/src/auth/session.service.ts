import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { userBindings } from '@capi-navigator/shared';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { isConflict } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';
import { AuthSettingsService } from './auth-settings.service.js';
import { GroupsService } from './groups.service.js';
import {
  OIDC_FLOW_COOKIE,
  OIDC_FLOW_SECONDS,
  OidcFlowSchema,
  type OidcFlow,
} from './oidc.service.js';
import type { Principal } from './principal.js';
import {
  parseCookies,
  signPayload,
  signSession,
  verifyPayload,
  verifySession,
} from './session-token.js';
import { TokensService } from './tokens.service.js';

export const SESSION_COOKIE = 'capi_navigator_session';
export const SESSION_KEY_SECRET = 'capi-navigator-session-key';

/**
 * Stateless sessions in signed cookies (FP1-F-03, STATE-04). The signing key lives in a Secret in
 * the home cluster, so all replicas share it and sessions survive restarts.
 */
@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger(SessionService.name);
  private key?: Buffer;

  constructor(
    private readonly store: StoreService,
    private readonly tokens: TokensService,
    private readonly groups: GroupsService,
    private readonly authSettings: AuthSettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private oidcActive(): boolean {
    return this.authSettings.active() !== undefined;
  }

  async onModuleInit(): Promise<void> {
    this.key = await this.loadOrCreateKey();
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    const existing = await this.store.secrets.get(SESSION_KEY_SECRET);
    if (existing?.key) return Buffer.from(existing.key, 'hex');
    const key = randomBytes(32);
    try {
      await this.store.secrets.create(SESSION_KEY_SECRET, { key: key.toString('hex') });
      this.logger.log(`Created session signing key in Secret ${SESSION_KEY_SECRET}`);
      return key;
    } catch (err) {
      // Another replica was faster: use its key.
      if (!isConflict(err)) throw err;
      const created = await this.store.secrets.get(SESSION_KEY_SECRET);
      if (!created?.key)
        throw new Error(`Secret ${SESSION_KEY_SECRET} has no "key"`, { cause: err });
      return Buffer.from(created.key, 'hex');
    }
  }

  private get signingKey(): Buffer {
    if (!this.key) throw new Error('Session key not loaded');
    return this.key;
  }

  /** Resolves the session cookie to a principal; the user's current state decides (FP1-F-04). */
  /**
   * The principal of a request: an API token if the request carries `Authorization: Bearer`
   * (FP22-F-04), otherwise the session cookie. With a bearer header the cookie is ignored, so a
   * browser can never combine both (ADR-0017).
   */
  authenticate(req: Request): Principal | undefined {
    const bearer = bearerToken(req);
    if (bearer !== undefined) return this.tokens.authenticate(bearer);
    return this.authenticateSession(req);
  }

  /** Session cookie only, e.g. for the node shell WebSocket, which refuses tokens (FP22-F-05). */
  authenticateSession(req: Pick<Request, 'headers'>): Principal | undefined {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return undefined;
    const payload = verifySession(token, this.signingKey);
    if (!payload) return undefined;
    if (payload.o) {
      // Switching OIDC off ends its sessions at once (ADR-0020).
      if (!this.oidcActive()) return undefined;
      // FP14-F-04: access from the mapped groups, resolved on every request.
      return {
        username: `${payload.u} (oidc)`,
        bindings: this.groups.bindings(payload.o.gr, payload.o.s),
        mustChangePassword: false,
        oidc: { subject: payload.o.s, groups: payload.o.gr },
      };
    }
    const user = this.store.userCache.get(payload.u);
    if (!user || user.spec.disabled || user.spec.sessionGeneration !== payload.g) return undefined;
    return {
      username: payload.u,
      bindings: userBindings(user.spec),
      mustChangePassword: user.spec.mustChangePassword,
    };
  }

  issue(res: Response, username: string, generation: number): void {
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.round(this.config.SESSION_TTL_HOURS * 3600);
    const token = signSession(
      { u: username, g: generation, iat: now, exp: now + ttl },
      this.signingKey,
    );
    res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions, maxAge: ttl * 1000 });
  }

  /** Session of a person signed in with OpenID Connect; holds only the mapped groups (FP14-F-06). */
  issueOidc(res: Response, person: { subject: string; name: string; groups: string[] }): void {
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.round(this.config.SESSION_TTL_HOURS * 3600);
    const token = signSession(
      {
        u: person.name,
        g: 0,
        iat: now,
        exp: now + ttl,
        o: { s: person.subject, gr: person.groups },
      },
      this.signingKey,
    );
    res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions, maxAge: ttl * 1000 });
  }

  clear(res: Response): void {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions);
  }

  /**
   * The checks of a running OpenID Connect sign-in. SameSite=Lax: the provider's redirect back is
   * a cross-site navigation, which does not carry Strict cookies (ADR-0019).
   */
  issueFlow(res: Response, flow: Omit<OidcFlow, 'exp'>): void {
    const exp = Math.floor(Date.now() / 1000) + OIDC_FLOW_SECONDS;
    res.cookie(OIDC_FLOW_COOKIE, signPayload({ ...flow, exp }, this.signingKey), {
      ...this.flowCookieOptions,
      maxAge: OIDC_FLOW_SECONDS * 1000,
    });
  }

  /** The flow of the request, if its cookie is valid; the cookie is single-use. */
  takeFlow(req: Pick<Request, 'headers'>, res: Response): OidcFlow | undefined {
    const token = parseCookies(req.headers.cookie)[OIDC_FLOW_COOKIE];
    res.clearCookie(OIDC_FLOW_COOKIE, this.flowCookieOptions);
    return token ? verifyPayload(token, this.signingKey, OidcFlowSchema) : undefined;
  }

  private get flowCookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'lax' as const,
      path: '/api/auth/oidc',
    };
  }

  private get cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'strict' as const,
      path: '/',
    };
  }
}

/**
 * The bearer token of a request (FP-22): undefined without a Bearer Authorization header, ''
 * for a malformed one. Other schemes (e.g. Basic auth added by an ingress) are ignored, so the
 * session cookie keeps working behind such proxies.
 */
export function bearerToken(req: Pick<Request, 'headers'>): string | undefined {
  const header = req.headers.authorization;
  if (!header || !/^Bearer(\s|$)/i.test(header)) return undefined;
  // A malformed Bearer header must not fall back to the session cookie.
  return /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? '';
}
