import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  AUTH_SETTINGS_NAME,
  OIDC_CLIENT_SECRET_NAME,
  OidcSettingsSchema,
  type AuthSettings,
  type OidcSettings,
  type OidcTestResult,
  type UpdateOidcSettingsRequest,
} from '@capi-navigator/shared';
import * as oidc from 'openid-client';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';

export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';
const SECRET_KEY = 'clientSecret';

/**
 * Settings of the OpenID Connect provider, edited on the Authentication page (FP14-F-12,
 * ADR-0020): a NavigatorAuthSettings resource plus a Secret with the client secret, which never
 * leaves the backend (FP14-F-14).
 */
@Injectable()
export class AuthSettingsService {
  constructor(
    private readonly store: StoreService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Stored settings, whether enabled or not. */
  stored(): OidcSettings | undefined {
    return this.store.authSettingsCache.get(AUTH_SETTINGS_NAME)?.spec.oidc;
  }

  /** Settings in effect: enabled and a public URL configured (FP14-F-03). */
  active(): OidcSettings | undefined {
    const settings = this.stored();
    return settings?.enabled && this.config.PUBLIC_URL ? settings : undefined;
  }

  get publicUrl(): string | undefined {
    return this.config.PUBLIC_URL;
  }

  get redirectUri(): string | undefined {
    return this.config.PUBLIC_URL
      ? new URL(OIDC_CALLBACK_PATH, this.config.PUBLIC_URL).href
      : undefined;
  }

  async clientSecret(): Promise<string | undefined> {
    return (await this.store.secrets.get(OIDC_CLIENT_SECRET_NAME))?.[SECRET_KEY];
  }

  async get(): Promise<AuthSettings> {
    const settings = this.stored();
    return {
      oidc: settings ? { ...settings, secretSet: !!(await this.clientSecret()) } : null,
      publicUrl: this.config.PUBLIC_URL ?? null,
      redirectUri: this.redirectUri ?? null,
    };
  }

  /** Saves the settings; the secret only when given (write-only, FP14-F-14). */
  async update(req: UpdateOidcSettingsRequest): Promise<AuthSettings> {
    const { clientSecret, ...rest } = req;
    const settings = OidcSettingsSchema.parse(rest);
    if (settings.defaultRole && !this.store.rolePermissions(settings.defaultRole)) {
      throw new BadRequestException({
        statusCode: 400,
        message: `Unknown role: ${settings.defaultRole}`,
        fieldErrors: { defaultRole: ['Choose an existing role or leave it empty'] },
      });
    }
    if (settings.enabled) {
      if (!this.config.PUBLIC_URL) {
        throw new BadRequestException({
          statusCode: 400,
          message: 'OpenID Connect needs the public URL of the app',
          hint: 'Set the Helm value publicUrl (PUBLIC_URL); the redirect URI is built from it.',
        });
      }
      if (!clientSecret && !(await this.clientSecret())) {
        throw new BadRequestException({
          statusCode: 400,
          message: 'Enter the client secret',
          fieldErrors: { clientSecret: ['Required to enable OpenID Connect'] },
        });
      }
    }
    try {
      if (clientSecret) {
        await this.store.secrets.put(OIDC_CLIENT_SECRET_NAME, { [SECRET_KEY]: clientSecret });
      }
      const existing = this.store.authSettingsCache.get(AUTH_SETTINGS_NAME);
      const saved = existing
        ? await this.store.authSettings.patchSpec(
            AUTH_SETTINGS_NAME,
            { oidc: settings },
            existing.metadata.resourceVersion,
          )
        : await this.store.authSettings.create(
            {
              name: AUTH_SETTINGS_NAME,
              labels: { 'app.kubernetes.io/part-of': 'capi-navigator' },
            },
            { oidc: settings },
          );
      this.store.authSettingsCache.upsert(saved);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw toHttpException(err, 'Save the OpenID Connect settings');
    }
    return this.get();
  }

  /** Discovery with the entered issuer, before saving (FP14-F-12). */
  async test(issuerUrl: string): Promise<OidcTestResult> {
    try {
      const config = await oidc.discovery(
        new URL(issuerUrl),
        'capi-navigator-test',
        undefined,
        undefined,
        {
          timeout: 10,
          execute: issuerUrl.startsWith('http:') ? [oidc.allowInsecureRequests] : [],
        },
      );
      const m = config.serverMetadata();
      const scopes = m.scopes_supported;
      const claims = m.claims_supported;
      return {
        ok: true,
        issuer: m.issuer,
        ...(m.authorization_endpoint ? { authorizationEndpoint: m.authorization_endpoint } : {}),
        ...(m.token_endpoint ? { tokenEndpoint: m.token_endpoint } : {}),
        ...(m.userinfo_endpoint ? { userinfoEndpoint: m.userinfo_endpoint } : {}),
        ...(m.end_session_endpoint ? { endSessionEndpoint: m.end_session_endpoint } : {}),
        ...(Array.isArray(scopes) ? { scopesSupported: scopes } : {}),
        ...(Array.isArray(claims) ? { claimsSupported: claims } : {}),
      };
    } catch (err) {
      return { ok: false, message: testMessage(err, issuerUrl) };
    }
  }
}

function testMessage(err: unknown, issuerUrl: string): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/issuer/i.test(text) && /mismatch|unexpected|does not match/i.test(text)) {
    return `The provider names a different issuer than ${issuerUrl}; copy the "issuer" of its discovery document exactly (including a final "/"). (${text})`;
  }
  if (isNotFound(err) || /404/.test(text)) {
    return `No discovery document at ${issuerUrl}/.well-known/openid-configuration. (${text})`;
  }
  return `The provider could not be reached or answered unexpectedly: ${text}`;
}
