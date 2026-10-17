import type { Role } from '@capi-navigator/shared';

/** The authenticated user of a request. */
export interface Principal {
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

/** Fields the auth guard attaches to the Express request. */
export interface AuthenticatedRequest {
  principal?: Principal;
  /** Username of a login attempt, for the audit log of failed logins. */
  auditActor?: string;
}
