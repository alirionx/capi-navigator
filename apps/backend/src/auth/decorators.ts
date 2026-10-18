import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@capi-navigator/shared';
import type { Principal } from './principal.js';

export const PUBLIC_KEY = 'capi-navigator:public';
export const PASSWORD_CHANGE_PENDING_KEY = 'capi-navigator:password-change-pending';
export const AUDIT_KEY = 'capi-navigator:audit';

/** Endpoint is reachable without a session (health, login). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const PERMISSION_KEY = 'capi-navigator:permission';

/** Access rule of an endpoint (FP19-F-05). */
export interface PermissionRule {
  /** One of these permissions is required. */
  anyOf: Permission[];
  /** Any signed-in user (own session and password), no permission needed. */
  signedIn?: boolean;
  /**
   * Dotted path of the body field naming the namespace, for endpoints that create something
   * (e.g. "spec.namespace"); otherwise the route parameter `namespace` is used.
   */
  namespaceFromBody?: string;
}

/**
 * Permission an endpoint requires (FP19-F-05); the scope (connection, namespace) comes from the
 * route or the body. Every endpoint must carry `@Requires`, `@SignedIn` or `@Public`; the guard
 * denies endpoints without one (fail closed).
 */
export const Requires = (
  permission: Permission | Permission[],
  opts: { namespaceFromBody?: string } = {},
) =>
  SetMetadata(PERMISSION_KEY, {
    anyOf: Array.isArray(permission) ? permission : [permission],
    ...opts,
  } satisfies PermissionRule);

/** Endpoint for every signed-in user, e.g. the own profile and password (FP19-F-05). */
export const SignedIn = () =>
  SetMetadata(PERMISSION_KEY, { anyOf: [], signedIn: true } satisfies PermissionRule);

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
  /** Dotted path of a body field appended to the action, e.g. "change.type" (FP7-F-20). */
  actionSuffixFromBody?: string;
}

/** Names the audit action of a mutating endpoint (FP1-F-06). */
export const Audit = (meta: AuditMetadata) => SetMetadata(AUDIT_KEY, meta);

/** Injects the authenticated principal. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | undefined =>
    ctx.switchToHttp().getRequest<{ principal?: Principal }>().principal,
);
