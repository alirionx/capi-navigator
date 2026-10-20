import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthOptions } from '@capi-navigator/shared';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

/** Short-lived cookie that carries the checks of one sign-in across the provider (ADR-0019). */
export const OIDC_FLOW_COOKIE = 'capi_navigator_oidc';
export const OIDC_FLOW_SECONDS = 600;
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';

export const OidcFlowSchema = z.object({
  /** state */
  st: z.string(),
  /** nonce */
  n: z.string(),
  /** PKCE code verifier */
  v: z.string(),
  /** app path to return to after sign-in */
  r: z.string(),
  exp: z.int(),
});
export type OidcFlow = z.infer<typeof OidcFlowSchema>;

/** A person as the provider identified them; groups unfiltered. */
export interface OidcIdentity {
  subject: string;
  name: string;
  groups: string[];
}

/**
 * OpenID Connect sign-in (FP-14, ADR-0019) with `openid-client`: discovery, authorization code
 * flow with PKCE, `state` and `nonce`, ID token validation. The provider's tokens never leave
 * this service.
 */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private discovered?: Promise<oidc.Configuration>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return !!this.config.OIDC_ISSUER_URL;
  }

  /** What the sign-in page offers (FP14-F-07). */
  options(): AuthOptions {
    return { oidc: this.enabled ? { label: this.config.OIDC_BUTTON_LABEL } : null };
  }

  /** FP14-F-03: from the configured public URL only. */
  get redirectUri(): string {
    return new URL(OIDC_CALLBACK_PATH, this.publicUrl).href;
  }

  get publicUrl(): string {
    return this.config.PUBLIC_URL ?? '';
  }

  /** Starts a sign-in: the provider URL to redirect to and the checks to keep in the cookie. */
  async begin(returnTo: string): Promise<{ url: string; flow: Omit<OidcFlow, 'exp'> }> {
    const config = await this.configuration();
    const verifier = oidc.randomPKCECodeVerifier();
    const flow = { st: oidc.randomState(), n: oidc.randomNonce(), v: verifier, r: returnTo };
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: this.scopes(),
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: flow.st,
      nonce: flow.n,
    });
    return { url: url.href, flow };
  }

  /**
   * Completes a sign-in from the callback's query string: exchanges the code and validates the
   * ID token (signature, issuer, audience, expiry, nonce) and the state.
   */
  async complete(query: URLSearchParams, flow: OidcFlow): Promise<OidcIdentity> {
    const config = await this.configuration();
    // The callback URL is rebuilt from the redirect URI, so redirect_uri in the token request
    // matches the registered one exactly, whatever Host header the request had.
    const current = new URL(this.redirectUri);
    for (const [key, value] of query) current.searchParams.append(key, value);
    const tokens = await oidc.authorizationCodeGrant(config, current, {
      pkceCodeVerifier: flow.v,
      expectedState: flow.st,
      expectedNonce: flow.n,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('The provider returned no ID token');
    let groups = claimValue(claims, this.config.OIDC_GROUPS_CLAIM);
    // Some providers send groups only from the UserInfo endpoint.
    if (groups === undefined && config.serverMetadata().userinfo_endpoint) {
      const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
      groups = claimValue(info, this.config.OIDC_GROUPS_CLAIM);
    }
    const name = [this.config.OIDC_USERNAME_CLAIM, 'email', 'sub']
      .map((c) => claimValue(claims, c))
      .find((v): v is string => typeof v === 'string' && v.length > 0);
    return { subject: claims.sub, name: name ?? claims.sub, groups: toGroups(groups) };
  }

  /** FP14-F-10: RP-initiated logout at the provider, if it offers it. */
  async endSessionUrl(): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    try {
      const config = await this.configuration();
      if (!config.serverMetadata().end_session_endpoint) return undefined;
      return oidc.buildEndSessionUrl(config, {
        client_id: config.clientMetadata().client_id,
        post_logout_redirect_uri: new URL('/login', this.publicUrl).href,
      }).href;
    } catch (err) {
      this.logger.warn(`No logout at the provider: ${message(err)}`);
      return undefined;
    }
  }

  private scopes(): string {
    const scopes = new Set(this.config.OIDC_SCOPES.split(/\s+/).filter(Boolean));
    scopes.add('openid');
    return [...scopes].join(' ');
  }

  /** Discovery once, retried after a failure (e.g. the provider was down at start-up). */
  private configuration(): Promise<oidc.Configuration> {
    const issuer = this.config.OIDC_ISSUER_URL;
    if (!issuer) return Promise.reject(new Error('OpenID Connect is not configured'));
    this.discovered ??= oidc
      .discovery(
        new URL(issuer),
        this.config.OIDC_CLIENT_ID ?? '',
        undefined,
        oidc.ClientSecretPost(this.config.OIDC_CLIENT_SECRET),
        {
          timeout: 10,
          execute: [
            // Verify the ID token signature against the provider's JWKS although the token comes
            // straight from the token endpoint (optional by OIDC Core 3.1.3.7; ADR-0019).
            oidc.enableNonRepudiationChecks,
            // Plain HTTP only when configured so, e.g. Dex in a local kind cluster.
            ...(issuer.startsWith('http:') ? [oidc.allowInsecureRequests] : []),
          ],
        },
      )
      .then((config) => {
        if (issuer.startsWith('http:')) {
          this.logger.warn(`OpenID Connect provider ${issuer} uses plain HTTP`);
        }
        return config;
      })
      .catch((err: unknown) => {
        this.discovered = undefined;
        throw err;
      });
    return this.discovered;
  }
}

/** A claim by name; names with dots are tried as a nested path too (e.g. "realm_access.roles"). */
function claimValue(claims: Record<string, unknown>, name: string): unknown {
  if (name in claims) return claims[name];
  if (name.includes('://')) return undefined;
  let value: unknown = claims;
  for (const part of name.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function toGroups(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((g): g is string => typeof g === 'string' && g.length > 0);
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
