import { z } from 'zod';
import type { CrdDefinition } from './types.js';

/** The only NavigatorAuthSettings resource; the client secret is in OIDC_CLIENT_SECRET_NAME. */
export const AUTH_SETTINGS_NAME = 'oidc';
export const OIDC_CLIENT_SECRET_NAME = 'capi-navigator-oidc-client';

/**
 * Settings of the OpenID Connect provider (FP14-F-01, ADR-0020), edited in the web UI. The client
 * secret is not part of it.
 */
export const OidcSettingsSchema = z.object({
  /** FP14-F-12: off keeps the settings but hides the sign-in button. */
  enabled: z.boolean().default(false),
  issuerUrl: z.url({
    protocol: /^https?$/,
    error: 'Enter the issuer URL, e.g. https://idp.example.com',
  }),
  clientId: z.string().trim().min(1, 'Enter the client ID').max(256),
  /** Space-separated; `openid` is always added. */
  scopes: z.string().trim().max(500).default('openid profile email'),
  groupsClaim: z.string().trim().min(1).max(256).default('groups'),
  usernameClaim: z.string().trim().min(1).max(256).default('preferred_username'),
  buttonLabel: z.string().trim().min(1).max(60).default('Sign in with OIDC'),
  /** FP14-F-05: role for people without a mapped group; empty refuses them. */
  defaultRole: z.string().trim().max(63).default('viewer'),
});
export type OidcSettings = z.infer<typeof OidcSettingsSchema>;

export const NavigatorAuthSettingsSpecSchema = z.object({ oidc: OidcSettingsSchema });
export type NavigatorAuthSettingsSpec = z.infer<typeof NavigatorAuthSettingsSpecSchema>;

export const NavigatorAuthSettingsCrd: CrdDefinition<typeof NavigatorAuthSettingsSpecSchema> = {
  kind: 'NavigatorAuthSettings',
  plural: 'navigatorauthsettings',
  singular: 'navigatorauthsetting',
  shortNames: ['navauth'],
  scope: 'Namespaced',
  spec: NavigatorAuthSettingsSpecSchema,
  printerColumns: [
    { name: 'OIDC', type: 'boolean', jsonPath: '.spec.oidc.enabled' },
    { name: 'Issuer', type: 'string', jsonPath: '.spec.oidc.issuerUrl' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  ],
};
