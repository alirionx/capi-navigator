import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@capi-navigator/shared';
import type { Principal } from './principal.js';

export const PUBLIC_KEY = 'capi-navigator:public';
export const ROLES_KEY = 'capi-navigator:min-role';
export const PASSWORD_CHANGE_PENDING_KEY = 'capi-navigator:password-change-pending';
export const AUDIT_KEY = 'capi-navigator:audit';

/** Endpoint is reachable without a session (health, login). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Minimum role for an endpoint (FP1-F-04). Every endpoint must carry either `@Roles` or `@Public`;
 * the guard denies endpoints without one (fail closed).
 */
export const Roles = (minRole: Role) => SetMetadata(ROLES_KEY, minRole);

/** Endpoint stays usable while the user still has to change the password (FP1-F-02). */
export const AllowPendingPasswordChange = () => SetMetadata(PASSWORD_CHANGE_PENDING_KEY, true);

export interface AuditMetadata {
  /** Action identifier, e.g. "user.create". */
  action: string;
  /** Kind of the target object; the name is taken from the route parameter or body field `targetParam`. */
  targetKind?: string;
  targetParam?: string;
  /** Route parameter or body field naming the management cluster the action runs against. */
  managementClusterParam?: string;
  /** For POST endpoints that do not change anything (e.g. parsing input): no AuditEvent. */
  skip?: boolean;
  /** GET endpoints that reveal secrets (e.g. a workload kubeconfig, ADR-0005) are recorded too. */
  sensitiveRead?: boolean;
}

/** Names the audit action of a mutating endpoint (FP1-F-06). */
export const Audit = (meta: AuditMetadata) => SetMetadata(AUDIT_KEY, meta);

/** Injects the authenticated principal. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | undefined =>
    ctx.switchToHttp().getRequest<{ principal?: Principal }>().principal,
);
