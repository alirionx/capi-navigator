import { request } from 'node:https';

const TIMEOUT_MS = 15_000;
const MAX_BODY = 20 * 1024 * 1024;

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Minimal HTTPS JSON client; supports a custom CA (OpenStack `cacert`, Proxmox CA), unlike fetch. */
export type HttpFn = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; ca?: string },
) => Promise<HttpResponse>;

export const httpsRequest: HttpFn = (url, init) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...init.headers,
          // Some API gateways reject chunked request bodies.
          ...(init.body ? { 'Content-Length': String(Buffer.byteLength(init.body)) } : {}),
        },
        ...(init.ca ? { ca: init.ca } : {}),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) req.destroy(new Error('Response too large'));
          else chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('timeout', () =>
      req.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })),
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
