# ADR-0017: API tokens for technical users

- Status: accepted
- Date: 2026-10-19
- Pack: FP-22

## Context

Scripts, CI pipelines and GitOps tools need the REST API without a browser session. Sessions
expire after hours, end on every password or role change, need a user's password in the script and
tie automation to a person. FP-19 already provides role assignments limited to connections and
namespaces, so the question is mainly how a machine authenticates.

## Decision

- **Technical users instead of a new account type.** A `NavigatorUser` gets `apiOnly: true`: no
  password, sign-in refused, marked as technical. Its access comes from role assignments like for
  every user, so "CI may change clusters in `team-a`" is an ordinary FP-19 assignment.
- **Only users with `users.manage` create tokens, and only for technical users.** Generating a
  token for a human would let an admin act in that person's name with the person's name in the
  audit log. Tokens for humans (self-service) may follow; the first version keeps one place where
  tokens come from.
- **Tokens act with the rights of their user**, resolved per request (FP19-F-06). A token has no
  scope of its own; less access means another technical user. Disabling or deleting the user stops
  its tokens at once.
- **Format and storage.** `capin_` followed by 32 random bytes (base64url); the prefix lets secret
  scanners recognise leaked tokens. A `NavigatorToken` resource in the app namespace holds name,
  owner, expiry, creator, last use and the **SHA-256 hash** of the token, never the token. The
  hash lives in the resource, not in a Secret, because the backend must find the token on every
  request: resources are read from the informer cache, Secrets are not cached (NF-01). With 256
  bits of randomness the hash cannot be reversed or guessed, which is the established way to store
  API tokens (as GitHub and others do); hard rule 8 is about values that grant access, and the hash
  does not. The token is shown exactly once.
- **Bearer authentication without CSRF.** `Authorization: Bearer <token>` is authenticated only by
  the token: a session cookie in the same request is ignored, so a browser cannot be tricked into
  combining both. Browsers never add an `Authorization` header to cross-site requests on their own,
  so CSRF does not apply and the `x-capi-navigator` header is not required for bearer requests.
- **Limits.** Token requests to endpoints that need `users.manage` (users, roles, tokens) are
  refused, so a stolen token can never extend its access; the node shell WebSocket accepts only
  sessions. Expiry is mandatory (default 90 days, at most 365).
- **Throttling failed attempts.** Failed token attempts are counted per client and answered with
  429 once over the login limit (NF-04). Unlike the login, a valid token always passes: a client's
  own mistakes (e.g. an expired token in one job) or a neighbour behind the same NAT must not lock
  out working automation. Guessing gains nothing from this, because a token carries 256 bits of
  randomness; the throttle reduces noise and makes failures visible.
- **Audit.** Mutating token requests record the technical user as actor and the token name in a new
  `token` field; generating and revoking tokens are audited actions.
- **Last use** is written at most once per hour per token, to avoid a write to the home cluster on
  every API call.

## Consequences

- Automation does not depend on people, and every token is visible and revocable in one place.
- Rotating a token means generating a new one and revoking the old one; there is no renewal.
- Narrower access per token, tokens for human users and Kubernetes ServiceAccount tokens
  (`TokenReview`) for in-cluster automation remain possible extensions.
