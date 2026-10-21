/** A problem the operator must fix before the app can start; logged without a stack trace. */
export class StartupError extends Error {}

/**
 * One understandable line for a failed start: the message of a StartupError, the message of a
 * Kubernetes API error (instead of its whole response), else the error's own message.
 */
export function startupMessage(err: unknown): string {
  if (err instanceof StartupError) return err.message;
  const body = (err as { body?: unknown })?.body;
  if (typeof body === 'string') {
    try {
      const status = JSON.parse(body) as { message?: string; code?: number };
      if (status.message) return `Kubernetes API (${status.code ?? '?'}): ${status.message}`;
    } catch {
      // not JSON: fall through
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** A StartupError or a Kubernetes API error: the message says it all, no stack needed. */
export function isKnownStartupProblem(err: unknown): boolean {
  return err instanceof StartupError || typeof (err as { body?: unknown })?.body === 'string';
}
