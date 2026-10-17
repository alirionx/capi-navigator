import { z } from 'zod';

/**
 * A server-sent event stream with typed `state` events that reconnects after drops (NF-11).
 * `error` events with data are server-side errors; without data the connection dropped.
 */
export function liveStream<T>(
  url: string,
  schema: z.ZodType<T>,
  handlers: { state(s: T): void; error(message: string): void; live(on: boolean): void },
): () => void {
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const connect = (attempt: number) => {
    const es = new EventSource(url, { withCredentials: true });
    source = es;
    es.addEventListener('state', (e) => {
      const parsed = z
        .object({ state: schema })
        .safeParse(JSON.parse((e as MessageEvent<string>).data));
      if (parsed.success) {
        handlers.state(parsed.data.state);
        handlers.live(true);
        attempt = 0;
      }
    });
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent<string | undefined>).data;
      if (data) {
        try {
          handlers.error(String((JSON.parse(data) as { message?: unknown }).message));
        } catch {
          handlers.error(data);
        }
        return;
      }
      handlers.live(false);
      es.close();
      if (closed || source !== es) return;
      retry = setTimeout(() => connect(attempt + 1), Math.min(30_000, 1000 * 2 ** (attempt + 1)));
    });
  };
  connect(0);
  return () => {
    closed = true;
    clearTimeout(retry);
    source?.close();
    source = null;
    handlers.live(false);
  };
}
