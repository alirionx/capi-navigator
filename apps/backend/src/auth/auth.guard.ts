import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { allows, type PermissionScope } from '@capi-navigator/shared';
import type { Request } from 'express';
import { StoreService } from '../store/store.service.js';
import {
  PASSWORD_CHANGE_PENDING_KEY,
  PERMISSION_KEY,
  PUBLIC_KEY,
  type PermissionRule,
} from './decorators.js';
import type { AuthenticatedRequest } from './principal.js';
import { SessionService } from './session.service.js';

/** Value at a dotted path of the request body; '' if it is not a string (never "somewhere"). */
function bodyField(body: unknown, path: string): string {
  let value: unknown = body;
  for (const key of path.split('.')) {
    value =
      value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  }
  return typeof value === 'string' ? value : '';
}

/** Scope of a request: connection and namespace from the route or the body (FP19-F-05). */
export function requestScope(
  req: Pick<Request, 'params' | 'body'>,
  rule: PermissionRule,
): PermissionScope {
  const params = req.params as Record<string, string | undefined>;
  const namespace = rule.namespaceFromBody
    ? bodyField(req.body, rule.namespaceFromBody)
    : params.namespace;
  return {
    ...(params.connection !== undefined ? { connection: params.connection } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

/**
 * Global guard enforcing authentication and permissions on every endpoint (FP1-F-04,
 * FP19-F-05). Permissions are resolved per request from the cached users and roles
 * (FP19-F-06). Endpoints without `@Public()`, `@SignedIn()` or `@Requires()` are denied
 * (fail closed).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly store: StoreService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return false;
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) ?? false;
    const rule = this.reflector.getAllAndOverride<PermissionRule | undefined>(
      PERMISSION_KEY,
      targets,
    );
    const allowPending =
      this.reflector.getAllAndOverride<boolean>(PASSWORD_CHANGE_PENDING_KEY, targets) ?? false;

    const req = ctx.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const principal = this.sessions.authenticate(req);
    if (principal) req.principal = principal;

    if (isPublic) return true;
    if (!rule) {
      this.logger.error(`Endpoint ${req.method} ${req.path} has no access rule; denying`);
      throw new ForbiddenException('Access denied');
    }
    if (!principal) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Not signed in or session expired',
        hint: 'Sign in again.',
      });
    }
    if (principal.mustChangePassword && !allowPending) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Password change required',
        hint: 'Change your password before using the app.',
      });
    }
    if (rule.signedIn) return true;
    const scope = requestScope(req, rule);
    if (!rule.anyOf.some((p) => allows(principal.bindings, this.store.rolePermissions, p, scope))) {
      const where = scope.namespace ? ` in namespace ${scope.namespace}` : '';
      throw new ForbiddenException({
        statusCode: 403,
        message: `This action requires the permission ${rule.anyOf.join(' or ')}${where}`,
        hint: 'Ask an admin for a role assignment with this permission.',
      });
    }
    return true;
  }
}
