# ADR-0019: OpenID Connect sign-in with group mapping

- Status: accepted
- Date: 2026-10-20
- Pack: FP-14

## Context

Teams want to sign in to the web UI with their identity provider (Okta, Auth0, Dex, Keycloak,
Rancher and others) instead of local accounts. The app keeps no database (hard rule 1), keeps
credentials out of the browser (hard rule 8) and already resolves permissions on every request
from role assignments with a scope (FP-19). Local accounts must stay: a break-glass admin and the
technical users of FP-22.

Two models were considered for OIDC users:

1. **Pre-created users**: an admin creates each person in the app, and the app matches the
   username or email of the ID token. Every new person needs two steps, access survives a removal
   in the provider until someone remembers the app, and usernames and emails can change or be
   reused.
2. **Group mapping, users created on sign-in**: the provider's groups are mapped to role
   assignments in the app; a person needs no record in the app.

## Decision

- **Groups decide access.** A `NavigatorGroup` resource maps one provider group to role
  assignments (role plus optional scope, the same model as FP-19). A person's access is the union of
  the assignments of their groups. There are no per-person assignments; an exception is a group in
  the provider. People without a mapped group get a configurable default role (default `viewer`),
  or are refused when none is set.
- **The backend runs the flow.** Authorization code flow with PKCE, `state` and `nonce`, as a
  confidential client, with `openid-client` (OpenID certified; discovery, PKCE, ID token
  validation, end-session). The provider's tokens are validated and dropped; the browser only gets
  the app's own signed session cookie. The ID token signature is always checked against the
  provider's JWKS (`enableNonRepudiationChecks`), although OIDC Core allows skipping it for tokens
  from the token endpoint over TLS: a test showed that tokens signed with a foreign key were
  accepted otherwise, and a local Dex may run over plain HTTP.
- **Stateless sessions as before.** The session cookie carries the subject, the display name and
  the mapped groups only (small even with many groups in the token), and the issuer. Assignments
  are resolved from the groups on every request, so a changed mapping applies at once; a changed
  membership applies with the next sign-in, at the latest after `SESSION_TTL_HOURS`.
- **Strictly standard.** Discovery from the issuer URL; the groups claim, scopes and display-name
  claim are configuration, so providers that add groups under a namespaced claim (Auth0) or only
  for an extra scope (Dex) work without code. One provider per installation.
- **Redirect URI from configuration.** `<publicUrl>/api/auth/oidc/callback`; never derived from
  the request's `Host` header, which a client controls.
- **Cookies across the redirect.** The short-lived login cookie (state, nonce, PKCE verifier)
  is `SameSite=Lax`, because the provider's redirect back is a cross-site navigation and
  `SameSite=Strict` cookies are not sent with it. The session cookie stays `Strict`.
- **Local sign-in stays**; the OIDC button sits below the local form. OIDC users have no password
  and no API tokens; they appear as `<name> (oidc)` with their subject in the audit log.
- **Tests** run against Dex in the kind cluster (static users with groups, Dex v2.46) and an
  in-process test provider for the failure cases; no external provider is needed.

## Consequences

- No user administration for people from the provider; leaving a group in the provider removes
  access with the next sign-in.
- Sessions cannot be revoked per OIDC person (there is no record); removing the group mapping
  revokes the access of everyone in it at once, and sessions end after `SESSION_TTL_HOURS`.
- Providers that put group IDs instead of names into the token (e.g. Entra ID) work, but the
  mapping uses the IDs; very large group lists that the provider leaves out of the token (Entra ID
  "overage") are not supported.
- After the provider replaces its signing keys without announcing them first (e.g. a restarted Dex
  with in-memory storage), sign-ins fail for up to a minute: `oauth4webapi` reloads the JWKS on an
  unknown key at most once per minute (and every five minutes anyway), which protects against
  requests with made-up key IDs.
- One new dependency, `openid-client` (with `jose` and `oauth4webapi`).
