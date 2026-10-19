import { Injectable, type NestMiddleware } from '@nestjs/common';
import { CSRF_HEADER, CSRF_HEADER_VALUE, type ApiErrorBody } from '@capi-navigator/shared';
import type { NextFunction, Request, Response } from 'express';

/** NF-04: content security policy. Vuetify injects theme styles, hence 'unsafe-inline' for styles. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Security headers and CSRF protection (NF-04).
 *
 * CSRF: session cookies are SameSite=Strict. In addition, every mutating API request must carry
 * the custom header `x-capi-navigator: 1` (cross-site forms cannot set headers, and cross-origin
 * scripts would need a CORS preflight, which the backend never allows), and a present `Origin`
 * header must match the host the request was sent to.
 */
@Injectable()
export class SecurityMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

    if (SAFE_METHODS.has(req.method) || !req.path.startsWith('/api/')) return next();
    // Bearer requests are authenticated by the token only, never by the cookie (ADR-0017), and
    // browsers do not add Authorization headers to cross-site requests: CSRF does not apply.
    if (/^Bearer(\s|$)/i.test(req.get('authorization') ?? '')) return next();

    if (req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) return reject(res, 'Missing CSRF header');
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
      return reject(res, 'Cross-origin request rejected');
    }
    next();
  }
}

function reject(res: Response, message: string): void {
  const body: ApiErrorBody = {
    statusCode: 403,
    message,
    hint: 'Use the CAPI Navigator UI or send the x-capi-navigator: 1 header from the same origin.',
  };
  res.status(403).json(body);
}
