import { ApiErrorBodySchema, CSRF_HEADER, CSRF_HEADER_VALUE } from '@capi-navigator/shared';
import type { z } from 'zod';

/** Error of a failed API call with an understandable message and hint (NF-06). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
    readonly details?: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

let unauthorizedHandler: (() => void) | undefined;

/** Called when the backend answers 401 on a non-auth endpoint (session expired). */
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

async function call(method: Method, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = CSRF_HEADER_VALUE;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(
      0,
      'The backend is not reachable',
      'Check that the backend is running and the network connection works.',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (res.ok) return res;
  if (res.status === 401 && !path.startsWith('/api/auth/')) unauthorizedHandler?.();
  throw await toApiError(res);
}

async function toApiError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  try {
    const body = ApiErrorBodySchema.parse(JSON.parse(text));
    return new ApiError(res.status, body.message, body.hint, body.details, body.fieldErrors);
  } catch {
    return new ApiError(
      res.status,
      `${res.status} ${res.statusText}`.trim(),
      undefined,
      text || undefined,
    );
  }
}

/** Request a JSON endpoint and validate the response with the shared Zod schema. */
export async function api<T extends z.ZodType>(
  method: Method,
  path: string,
  schema: T,
  body?: unknown,
): Promise<z.infer<T>> {
  const res = await call(method, path, body);
  return schema.parse(await res.json());
}

/** Request a plain-text endpoint (e.g. a kubeconfig, ADR-0005); never cached by the browser. */
export async function apiText(path: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { Accept: 'text/plain' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (err) {
    throw new ApiError(
      0,
      'The backend is not reachable',
      'Check that the backend is running and the network connection works.',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    throw await toApiError(res);
  }
  return res.text();
}

/** Request an endpoint without a response body (204). */
export async function apiVoid(method: Method, path: string, body?: unknown): Promise<void> {
  await call(method, path, body);
}

export function getJson<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  return api('GET', path, schema);
}
