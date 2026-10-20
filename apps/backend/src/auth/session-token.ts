import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Content of a session cookie (FP1-F-03). Holds no role: the role is read fresh on every request. */
const SessionPayloadSchema = z.object({
  /** username */
  u: z.string(),
  /** session generation of the user at issue time */
  g: z.int(),
  /** issued at, epoch seconds */
  iat: z.int(),
  /** expires at, epoch seconds */
  exp: z.int(),
  /**
   * OpenID Connect sessions (FP14-F-06): subject and the person's groups that were mapped at
   * sign-in. `u` then holds the display name and `g` is 0.
   */
  o: z.object({ s: z.string(), gr: z.array(z.string()) }).optional(),
});
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

/** Signs a payload as `<base64url(json)>.<base64url(hmac-sha256)>`. */
export function signPayload(payload: object, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${mac(body, key)}`;
}

/** Returns the payload if the signature is valid, it matches the schema and `exp` lies ahead. */
export function verifyPayload<T extends { exp: number }>(
  token: string,
  key: Buffer,
  schema: z.ZodType<T>,
  nowSeconds = Math.floor(Date.now() / 1000),
): T | undefined {
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const [body, signature] = parts as [string, string];
  const expected = Buffer.from(mac(body, key), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  try {
    const payload = schema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return payload.exp > nowSeconds ? payload : undefined;
  } catch {
    return undefined;
  }
}

export function signSession(payload: SessionPayload, key: Buffer): string {
  return signPayload(payload, key);
}

/** Returns the payload if the signature is valid and the session has not expired. */
export function verifySession(
  token: string,
  key: Buffer,
  nowSeconds = Math.floor(Date.now() / 1000),
): SessionPayload | undefined {
  return verifyPayload(token, key, SessionPayloadSchema, nowSeconds);
}

function mac(body: string, key: Buffer): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

/** Minimal Cookie header parser; avoids an extra dependency. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // ignore malformed values
    }
  }
  return out;
}
