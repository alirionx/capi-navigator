import type { RoleBinding } from '@capi-navigator/shared';

/** The authenticated user of a request. Holds no permissions: they are resolved per request. */
export interface Principal {
  username: string;
  /** Role assignments (FP19-F-03), read fresh from the user cache on every request. */
  bindings: RoleBinding[];
  mustChangePassword: boolean;
  /** Local users: UID of the `NavigatorUser`; a name can be used again (ADR-0041). */
  uid?: string;
  /** Set when the request authenticated with an API token (FP-22). */
  token?: { id: string; name: string };
  /** Set for people signed in with the OpenID Connect provider (FP-14). */
  oidc?: {
    subject: string;
    groups: string[];
    /** Provider that signed the person in; missing in sessions from before FP-37. */
    issuer?: string;
  };
}

/** Fields the auth guard attaches to the Express request. */
export interface AuthenticatedRequest {
  principal?: Principal;
  /** Username of a login attempt, for the audit log of failed logins. */
  auditActor?: string;
  /** Summary a handler adds to its AuditEvent on success (FP38-F-07); never secrets. */
  auditMessage?: string;
}
