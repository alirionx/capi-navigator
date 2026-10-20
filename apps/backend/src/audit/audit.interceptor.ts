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
 * Records every mutating request, and reads of secrets marked `sensitiveRead`, as an AuditEvent,
 * successful or not (FP1-F-06, hard rule 9).
 * Endpoints name their action with `@Audit`; others are recorded by method and route.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const meta = this.reflector.get<AuditMetadata | undefined>(AUDIT_KEY, ctx.getHandler());
    if (!MUTATING.has(req.method) && !meta?.sensitiveRead) return next.handle();
    if (meta?.skip) return next.handle();
    const write = (outcome: 'success' | 'failure', message?: string) => {
      const name = meta?.targetParam ? lookup(req, meta.targetParam) : undefined;
      const managementCluster = meta?.managementClusterParam
        ? lookup(req, meta.managementClusterParam)
        : undefined;
      return this.audit.record({
        actor: req.principal?.username ?? req.auditActor ?? 'anonymous',
        action: actionOf(meta, req),
        outcome,
        request: { method: req.method, path: req.path },
        ...(meta?.targetKind && name ? { target: { kind: meta.targetKind, name } } : {}),
        ...(managementCluster ? { managementCluster } : {}),
        ...(req.principal?.token ? { token: req.principal.token.name } : {}),
        ...(req.principal?.oidc ? { subject: req.principal.oidc.subject } : {}),
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

/** Value of a route parameter, or else of a top-level body field. */
function lookup(req: Request, key: string): string | undefined {
  const param = req.params[key];
  if (typeof param === 'string') return param;
  return bodyField(req.body, key);
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

function actionOf(meta: AuditMetadata | undefined, req: Request): string {
  if (!meta) return `${req.method} ${routePath(req)}`;
  if (!meta.actionSuffixFromBody) return meta.action;
  let v: unknown = req.body;
  for (const key of meta.actionSuffixFromBody.split('.')) {
    v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined;
  }
  return typeof v === 'string' && /^[a-zA-Z0-9-]+$/.test(v) ? `${meta.action}.${v}` : meta.action;
}
