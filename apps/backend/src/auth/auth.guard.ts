import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasRole, type Role } from '@capi-navigator/shared';
import type { Request } from 'express';
import { PASSWORD_CHANGE_PENDING_KEY, PUBLIC_KEY, ROLES_KEY } from './decorators.js';
import type { AuthenticatedRequest } from './principal.js';
import { SessionService } from './session.service.js';

/**
 * Global guard enforcing authentication and the viewer/operator/admin roles on every endpoint
 * (FP1-F-04). Endpoints without `@Public()` or `@Roles()` are denied (fail closed).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return false;
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) ?? false;
    const minRole = this.reflector.getAllAndOverride<Role | undefined>(ROLES_KEY, targets);
    const allowPending =
      this.reflector.getAllAndOverride<boolean>(PASSWORD_CHANGE_PENDING_KEY, targets) ?? false;

    const req = ctx.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const principal = this.sessions.authenticate(req);
    if (principal) req.principal = principal;

    if (isPublic) return true;
    if (!minRole) {
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
    if (!hasRole(principal.role, minRole)) {
      throw new ForbiddenException({
        statusCode: 403,
        message: `This action requires the ${minRole} role`,
        hint: 'Ask an admin for a role with more permissions.',
      });
    }
    return true;
  }
}
