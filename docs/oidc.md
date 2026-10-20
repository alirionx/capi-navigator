# Sign-in with an OpenID Connect provider

CAPI Navigator can let people sign in with your organisation's identity provider, in addition to the
local users (FP-14, [ADR-0019](adr/0019-oidc-sign-in-with-group-mapping.md)). Any provider that
implements OpenID Connect Discovery works; this page has examples for Okta and Auth0, Dex and
Keycloak, and Rancher.

## How it works

- The sign-in page shows the local form and, below it, a button such as "Sign in with Okta".
- The backend runs the authorization code flow with PKCE. The provider's tokens never reach the
  browser; the app issues its own session cookie, with the same lifetime as for local users.
- **Groups decide access.** In **Users → OpenID Connect groups** an admin maps a provider group to
  role assignments, e.g. `platform-team` → admin, `team-a` → operator in namespace `team-a`. Nobody
  has to be created in the app. A person's access is the union of their groups' assignments.
- People without a mapped group get the **default role** (`viewer`), or are refused if you set
  `oidc.defaultRole: ''`. With a provider where anyone can register, set it empty.
- Changing or removing a mapping applies on the next request; a new mapping and a changed group
  membership apply with the next sign-in.
- The local `admin` stays as break-glass access. API tokens remain for local technical users only.

## Settings

Register CAPI Navigator as a **confidential client** (client ID and secret) with the redirect URI

```text
https://<your capi-navigator host>/api/auth/oidc/callback
```

Store the client secret in a Secret and set the Helm values:

```sh
kubectl -n capi-navigator-system create secret generic capi-navigator-oidc \
  --from-literal=clientSecret='<client secret>'
```

```yaml
publicUrl: https://capi-navigator.example.com # the redirect URI is built from it
oidc:
  issuerUrl: https://idp.example.com # exactly as in the provider's discovery document
  clientId: capi-navigator
  existingSecret: capi-navigator-oidc # key clientSecret (oidc.existingSecretKey)
  scopes: openid profile email # plus what your provider needs for groups
  groupsClaim: groups # claim with the groups
  usernameClaim: preferred_username # display name; falls back to email, then the subject
  buttonLabel: Sign in with Okta
  defaultRole: viewer # '' refuses people without a mapped group
```

| Value                 | Environment variable  | Default                | Notes                                                                    |
| --------------------- | --------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `publicUrl`           | `PUBLIC_URL`          | –                      | Required with OIDC. The app never derives URLs from request headers.     |
| `oidc.issuerUrl`      | `OIDC_ISSUER_URL`     | – (OIDC off)           | Must match the `issuer` of the discovery document, including a final `/` |
| `oidc.clientId`       | `OIDC_CLIENT_ID`      | –                      |                                                                          |
| `oidc.existingSecret` | `OIDC_CLIENT_SECRET`  | `capi-navigator-oidc`  | Secret name; the key is `oidc.existingSecretKey` (`clientSecret`)        |
| `oidc.scopes`         | `OIDC_SCOPES`         | `openid profile email` | Space-separated; `openid` is always added                                |
| `oidc.groupsClaim`    | `OIDC_GROUPS_CLAIM`   | `groups`               | Also URL-like names (Auth0) and dotted paths (`realm_access.roles`)      |
| `oidc.usernameClaim`  | `OIDC_USERNAME_CLAIM` | `preferred_username`   | Shown in the app and the audit log as `<name> (oidc)`                    |
| `oidc.buttonLabel`    | `OIDC_BUTTON_LABEL`   | `Sign in with OIDC`    |                                                                          |
| `oidc.defaultRole`    | `OIDC_DEFAULT_ROLE`   | `viewer`               | Any built-in or custom role; empty refuses                               |

If the groups are missing from the ID token, the app asks the provider's UserInfo endpoint. Group
names are compared exactly; map them as the provider sends them.

Sign-out ends the app session and, if the provider offers an `end_session_endpoint`, also the
session at the provider, which then returns to `<publicUrl>/login`. Register that URL as allowed
post-logout redirect if your provider asks for it.

## Example 1: Okta and Auth0

### Okta

1. **Applications → Create App Integration**: OIDC, **Web Application**. Sign-in redirect URI:
   `https://<host>/api/auth/oidc/callback`; sign-out redirect URI: `https://<host>/login`. Assign the
   groups or people who may use it.
2. **Groups claim**, with a custom authorization server (e.g. `default`): **Security → API →
   Authorization Servers → default → Claims → Add Claim**: name `groups`, include in **ID Token**,
   value type **Groups**, filter e.g. _Matches regex_ `^capi-.*`. With the org authorization server,
   set the groups claim filter in the app's **Sign On** settings instead.
3. Values: `issuerUrl: https://<your-okta-domain>/oauth2/default` (custom server) or
   `https://<your-okta-domain>` (org server), `groupsClaim: groups`.

Okta leaves the claim out for people without a matching group; they get the default role.

### Auth0

Auth0 has roles, not groups; a Post-Login Action puts them into the ID token. Auth0 reserves the
claim names `groups` and `roles`, so the claim needs a namespace.

1. **Applications → Create Application → Regular Web Application**. Allowed callback URL:
   `https://<host>/api/auth/oidc/callback`; allowed logout URL: `https://<host>/login`.
2. **Actions → Library → Create Action** (trigger _Login / Post Login_), deploy it and add it to the
   Login flow:

   ```js
   exports.onExecutePostLogin = async (event, api) => {
     api.idToken.setCustomClaim('https://capi-navigator/groups', event.authorization?.roles ?? []);
   };
   ```

3. Values: `issuerUrl: https://<tenant>.<region>.auth0.com/` (with the final `/`, as in the
   discovery document), `groupsClaim: https://capi-navigator/groups`, `usernameClaim: email` or
   `nickname`.
4. For sign-out at Auth0, enable **Settings → Advanced → RP-Initiated Logout End Session Endpoint
   Discovery** in the tenant.

## Example 2: Dex and Keycloak

### Dex

```yaml
staticClients:
  - id: capi-navigator
    name: CAPI Navigator
    secret: <client secret>
    redirectURIs:
      - https://<host>/api/auth/oidc/callback
```

Dex adds the groups of its connectors (LDAP, GitHub teams, …) to the ID token when the scope
`groups` is requested: `scopes: openid profile email groups`, `groupsClaim: groups`. The issuer is
the `issuer` of the Dex configuration. For local tests, `pnpm dex:up` installs a Dex with test users
in the kind cluster (see the README).

### Keycloak

1. **Clients → Create client**: OpenID Connect, client authentication **on**. Valid redirect URI:
   `https://<host>/api/auth/oidc/callback`; valid post-logout redirect URI: `https://<host>/login`.
2. **Client scopes → `<client>-dedicated` → Add mapper → By configuration → Group Membership**:
   token claim name `groups`, **Full group path** off (`team-a`; on gives `/team-a`), add to ID token.
3. Values: `issuerUrl: https://<keycloak>/realms/<realm>`, `groupsClaim: groups`. Realm roles
   work too: `groupsClaim: realm_access.roles`.

## Example 3: Rancher

Rancher Manager can itself act as an OpenID Connect provider (from v2.12, feature flag
`oidc-provider`). People then sign in with their Rancher account, and their Rancher groups, e.g.
from GitHub or Active Directory behind Rancher, become the groups in CAPI Navigator. This is
independent of Rancher managing clusters; CAPI Navigator only uses it for sign-in.

1. **☰ → Global Settings → Feature Flags**: activate `oidc-provider`.
2. **☰ → Users & Authentication → OIDC Apps → Add Application**, or as resource:

   ```yaml
   apiVersion: management.cattle.io/v3
   kind: OIDCClient
   metadata:
     name: capi-navigator
   spec:
     description: CAPI Navigator
     redirectURIs:
       - https://<host>/api/auth/oidc/callback
     scopes: [openid, profile, groups]
     tokenExpirationSeconds: 600
     refreshTokenExpirationSeconds: 3600
   ```

   `groups` must be in `scopes`; without it Rancher allows only `openid profile offline_access`.
   Rancher shows the client ID in the resource status and stores the secret in a Secret named
   after the client ID in `cattle-oidc-client-secrets` (key `client-secret-1`).

3. Values: `issuerUrl: https://<rancher>/oidc`, `scopes: openid profile groups`,
   `groupsClaim: groups`, `usernameClaim: name` (Rancher sends no `preferred_username`).

Rancher sends groups as principal names of its auth provider, e.g. `github_team://1234567`, and local
Rancher groups without prefix. Map them exactly like that; the group list of a signed-in person is
shown in their user menu in CAPI Navigator.

## Troubleshooting

- **"Sign-in with your identity provider failed"**: the audit log (`AuditEvent` with action
  `auth.oidc.login`) and the backend log name the reason, e.g. a wrong client secret, issuer or
  redirect URI.
- **"None of your groups has access"**: the default role is empty and no group of the person is
  mapped. Check the groups claim name and the group names; the user menu shows the mapped groups.
- **Groups are empty**: the provider adds groups only for an extra scope (Dex, Rancher), a mapper
  (Keycloak), a claim definition (Okta) or an Action (Auth0).
- **Right after the provider changed its signing keys**, sign-ins can fail for up to a minute.
