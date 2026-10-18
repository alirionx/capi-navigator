import type { RoleBinding } from '@capi-navigator/shared';

/** The authenticated user of a request. Holds no permissions: they are resolved per request. */
export interface Principal {
  username: string;
  /** Role assignments (FP19-F-03), read fresh from the user cache on every request. */
  bindings: RoleBinding[];
  mustChangePassword: boolean;
}

/** Fields the auth guard attaches to the Express request. */
export interface AuthenticatedRequest {
  principal?: Principal;
  /** Username of a login attempt, for the audit log of failed logins. */
  auditActor?: string;
}
