import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorBody } from '@capi-navigator/shared';

/** HTTP status of a Kubernetes API error, or undefined for other errors (network etc.). */
export function kubeStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

export const isNotFound = (err: unknown): boolean => kubeStatus(err) === 404;
export const isConflict = (err: unknown): boolean => kubeStatus(err) === 409;

/** Message of the Kubernetes `Status` object in an API error, if present. */
function kubeMessage(err: unknown): string | undefined {
  const body = (err as { body?: unknown }).body;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === 'string') return parsed.message;
    } catch {
      return undefined;
    }
  }
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}

/**
 * Translates a Kubernetes API error into an understandable HTTP error with a hint (NF-06).
 * The original message stays available in `details`. Never includes request bodies (NF-01).
 */
export function toHttpException(err: unknown, context: string): HttpException {
  const status = kubeStatus(err);
  const details = kubeMessage(err) ?? (err instanceof Error ? err.message : undefined);
  const body = (statusCode: number, message: string, hint?: string): ApiErrorBody => ({
    statusCode,
    message,
    ...(hint ? { hint } : {}),
    ...(details ? { details } : {}),
  });

  switch (status) {
    case 401:
      return new HttpException(
        body(
          HttpStatus.BAD_GATEWAY,
          `${context}: the cluster rejected the credentials`,
          'Check that the token or kubeconfig of the connection is still valid.',
        ),
        HttpStatus.BAD_GATEWAY,
      );
    case 403:
      return new HttpException(
        body(
          HttpStatus.BAD_GATEWAY,
          `${context}: missing permissions in the cluster`,
          'The service account of CAPI Navigator lacks an RBAC permission. Compare its Role/ClusterRole with the one shipped in the Helm chart.',
        ),
        HttpStatus.BAD_GATEWAY,
      );
    case 404:
      return new HttpException(
        body(HttpStatus.NOT_FOUND, `${context}: not found`),
        HttpStatus.NOT_FOUND,
      );
    case 409:
      return new HttpException(
        body(
          HttpStatus.CONFLICT,
          `${context}: already exists or was changed concurrently`,
          'Reload and try again.',
        ),
        HttpStatus.CONFLICT,
      );
    case 422:
      return new HttpException(
        body(
          HttpStatus.UNPROCESSABLE_ENTITY,
          `${context}: rejected by the cluster as invalid`,
          'Check that the CRDs are up to date (pnpm crds:install).',
        ),
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    default:
      return new HttpException(
        body(
          HttpStatus.BAD_GATEWAY,
          `${context}: the cluster is not reachable`,
          'Check the network connection to the cluster API server.',
        ),
        HttpStatus.BAD_GATEWAY,
      );
  }
}
