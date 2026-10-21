import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface FetchOptions {
  headers?: Record<string, string>;
  /** PEM CA certificate for private registries (FP8-F-03). */
  ca?: string;
  insecureSkipTLSVerify?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  /** Redirects to follow; credentials are only sent to the original host. */
  maxRedirects?: number;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  url: string;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** What the user can do about it, shown with the error. */
    readonly hint?: string,
  ) {
    super(message);
  }
}

const DEFAULT_MAX = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT = 20_000;

/**
 * Minimal GET for Helm repositories and OCI registries (FP8-F-04): size limit, timeout and
 * redirects. Node core only, so a custom CA can be passed per request. Error messages never
 * contain request headers (credentials).
 */
export async function get(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  let current = new URL(url);
  const origin = current.host;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    const sameHost = current.host === origin;
    const res = await once(current, {
      ...opts,
      // Never forward credentials to another host (e.g. a registry's blob CDN).
      headers: sameHost
        ? opts.headers
        : Object.fromEntries(
            Object.entries(opts.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'authorization'),
          ),
    });
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && typeof location === 'string') {
      current = new URL(location, current);
      continue;
    }
    return { ...res, url: current.toString() };
  }
  throw new FetchError(`Too many redirects for ${url}`);
}

function once(url: URL, opts: FetchOptions): Promise<Omit<FetchResult, 'url'>> {
  const max = opts.maxBytes ?? DEFAULT_MAX;
  const https = url.protocol === 'https:';
  if (!https && url.protocol !== 'http:') {
    return Promise.reject(new FetchError(`Unsupported protocol ${url.protocol}`));
  }
  return new Promise((resolve, reject) => {
    const req = (https ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        headers: { 'user-agent': 'capi-navigator', ...opts.headers },
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT,
        ...(https
          ? {
              ...(opts.ca ? { ca: opts.ca } : {}),
              rejectUnauthorized: !opts.insecureSkipTLSVerify,
            }
          : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > max) {
            // Reject directly: destroying the request with an error once the response has
            // started raises it on the response stream, where it would crash the process.
            res.destroy();
            reject(new FetchError(`Response from ${url.host} is larger than ${max} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new FetchError(`Timeout contacting ${url.host}`)));
    req.on('error', (err) =>
      reject(err instanceof FetchError ? err : new FetchError(describeError(url, err))),
    );
    req.end();
  });
}

const TLS_TRUST = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

/** Understandable messages for the usual network and TLS errors (NF-06). */
export function describeError(url: URL, err: Error & { code?: string }): string {
  if (err.code && TLS_TRUST.has(err.code)) {
    return `${url.host}: the server certificate is not trusted; add the CA certificate of the registry`;
  }
  if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return `${url.host}: the server certificate is not valid for this host name`;
  }
  if (err.code === 'CERT_HAS_EXPIRED') return `${url.host}: the server certificate has expired`;
  if (err.code === 'ENOTFOUND') return `${url.hostname}: host name not found`;
  if (err.code === 'ECONNREFUSED') return `${url.host}: connection refused`;
  return `${url.host}: ${err.message}`;
}
