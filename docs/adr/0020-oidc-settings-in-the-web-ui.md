# ADR-0020: OpenID Connect settings in the web UI

- Status: accepted
- Date: 2026-10-20
- Pack: FP-14
- Refines: [ADR-0019](0019-oidc-sign-in-with-group-mapping.md)

## Context

ADR-0019 configured the OpenID Connect provider through environment variables (Helm values
`oidc.*`). Changing the provider then needs a Helm upgrade and a restart, and admins who already
manage users and group mappings in the UI have to switch tools. The local sign-in always stays
available, so the provider can be configured from inside the app without a chicken-and-egg problem.

Three options were weighed: Helm wins over the UI, the UI wins over Helm, or the UI only.

## Decision

- **UI only.** The provider is configured on the page Administration → Authentication by users with
  `users.manage`; the Helm values and environment variables `oidc.*` / `OIDC_*` are removed (FP-14
  was not released with them). Only the public URL stays a deployment setting (`publicUrl` /
  `PUBLIC_URL`), because the redirect URI must never come from a request (FP14-F-03).
- **Stored in the home cluster.** One `NavigatorAuthSettings` resource named `oidc` holds the
  settings; the client secret lives in the Secret `capi-navigator-oidc-client`. It is write-only
  in the API: responses only say whether it is set.
- **Applied without restart.** The backend watches the resource like its other CRDs; the OIDC
  service rebuilds its discovery when the settings or the secret change, on every replica.
- **Test before saving.** The page runs the discovery with the entered values and shows what the
  provider offers; saving shows a preview and is audited. A switch turns OIDC off without losing
  the settings.
- **Protection: `users.manage` only**, like the user management and group mappings.

## Consequences

- Admins set up sign-in in one place, with immediate feedback; no Helm upgrade or restart.
- GitOps covers the public URL only; the provider settings live in the home cluster and are not in
  Git. They can still be applied as a `NavigatorAuthSettings` resource plus Secret by tooling.
- Whoever has `users.manage` can point sign-in to another provider and map its groups to admin. A
  stolen admin session can therefore create a lasting backdoor that survives password changes.
  This was accepted deliberately: admins can already do everything, the local sign-in cannot be
  turned off, and every change is in the audit log (actor, time; never the secret). Review
  `auth-settings.update` events like user changes.
