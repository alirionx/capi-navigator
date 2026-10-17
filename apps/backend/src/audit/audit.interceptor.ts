import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { catchError, from, mergeMap, type Observable, throwError } from 'rxjs';
import { AUDIT_KEY, type AuditMetadata } from '../auth/decorators.js';
import type { AuthenticatedRequest } from '../auth/principal.js';
import { AuditService } from './audit.service.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Records every mutating request as an AuditEvent, successful or not (FP1-F-06, hard rule 9).
 * Endpoints name their action with `@Audit`; others are recorded by method and route.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    if (ctx.getType() !== 'http' || !MUTATING.has(req.method)) return next.handle();

    const meta = this.reflector.get<AuditMetadata | undefined>(AUDIT_KEY, ctx.getHandler());
    const write = (outcome: 'success' | 'failure', message?: string) => {
      const param = meta?.targetParam ? req.params[meta.targetParam] : undefined;
      const targetName = typeof param === 'string' ? param : undefined;
      const bodyName = meta?.targetParam ? bodyField(req.body, meta.targetParam) : undefined;
      const name = targetName ?? bodyName;
      return this.audit.record({
        actor: req.principal?.username ?? req.auditActor ?? 'anonymous',
        action: meta?.action ?? `${req.method} ${routePath(req)}`,
        outcome,
        request: { method: req.method, path: req.path },
        ...(meta?.targetKind && name ? { target: { kind: meta.targetKind, name } } : {}),
        ...(message ? { message } : {}),
      });
    };

    return next.handle().pipe(
      mergeMap((result) => from(write('success').then(() => result))),
      catchError((err: unknown) =>
        from(write('failure', failureMessage(err))).pipe(mergeMap(() => throwError(() => err))),
      ),
    );
  }
}

function routePath(req: Request): string {
  const route = (req as { route?: { path?: string } }).route;
  return route?.path ?? req.path;
}

function bodyField(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/** Status and short message only; never request bodies (NF-01). */
function failureMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const res = err.getResponse();
    const message =
      typeof res === 'object' && res !== null && 'message' in res
        ? String((res as { message: unknown }).message)
        : err.message;
    return `${err.getStatus()}: ${message}`.slice(0, 500);
  }
  return 'Internal error';
}
