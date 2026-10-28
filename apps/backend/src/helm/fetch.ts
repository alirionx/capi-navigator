import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { getCACertificates } from 'node:tls';

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
              ...(opts.ca ? { ca: withDefaultCAs(opts.ca) } : {}),
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

/**
 * Trust store of a request with a private CA: the CA is added to the default ones (bundled,
 * NODE_EXTRA_CA_CERTS) instead of replacing them, so a request still works when it goes through
 * a proxy that inspects TLS, or when the server's certificate is public (FP-29).
 */
export function withDefaultCAs(ca: string): string[] {
  return [...getCACertificates('default'), ca];
}

/**
 * The proxy Node.js sends a request through (`NODE_USE_ENV_PROXY=1`), with its NO_PROXY rules:
 * exact host (optionally with port), `.domain` and `*.domain` suffixes, `*`, single IPs and IPv4
 * ranges `a-b`. A domain without a leading dot does not cover its subdomains, unlike in Go or curl.
 */
export function proxyFor(url: URL, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.NODE_USE_ENV_PROXY !== '1') return undefined;
  const https = url.protocol === 'https:';
  const proxy = https ? (env.HTTPS_PROXY ?? env.https_proxy) : (env.HTTP_PROXY ?? env.http_proxy);
  if (!proxy) return undefined;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port || (https ? '443' : '80');
  for (const raw of (env.NO_PROXY ?? env.no_proxy ?? '').split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return undefined;
    const range = /^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/.exec(entry);
    if (range) {
      const n = ipv4(host);
      if (n !== undefined && n >= ipv4(range[1]!)! && n <= ipv4(range[2]!)!) return undefined;
      continue;
    }
    const [name, entryPort] = entry.split(/:(?=\d+$)/) as [string, string | undefined];
    if (entryPort && entryPort !== port) continue;
    const suffix = name.startsWith('*.') ? name.slice(1) : name.startsWith('.') ? name : undefined;
    if (suffix ? host.endsWith(suffix) : host === name) return undefined;
  }
  return proxy;
}

function ipv4(host: string): number | undefined {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return undefined;
  }
  return parts.reduce((n, p) => n * 256 + p, 0);
}

const TLS_TRUST = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
]);

const TLS_WEAK = new Set(['CA_MD_TOO_WEAK', 'CA_KEY_TOO_SMALL', 'EE_KEY_TOO_SMALL']);

/** Understandable messages for the usual network and TLS errors (NF-06). */
export function describeError(
  url: URL,
  err: Error & { code?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Node's hint to start it with --use-system-ca does not apply to the app.
  const reason = err.message.replace(
    /[;,]?\s*(?:if the root CA is installed locally, )?try (?:running Node\.js with )?--use-system-ca\.?$/,
    '',
  );
  if (err.code && TLS_TRUST.has(err.code)) {
    // Through a proxy that inspects TLS, the proxy's certificate is the untrusted one (FP-29).
    const proxy = proxyFor(url, env);
    if (proxy) {
      return `${url.host}: the certificate is not trusted (${reason}). The request went through the outbound proxy ${new URL(proxy).host}: if ${url.hostname} is internal, add it to NO_PROXY of the app (the host or .domain; a domain without leading dot does not cover its subdomains in Node.js); if the proxy inspects TLS, add its CA with NODE_EXTRA_CA_CERTS`;
    }
    return `${url.host}: the server certificate is not trusted (${reason}). Add the CA certificate of the registry: the root CA and every intermediate CA, one PEM block after another`;
  }
  if (err.code && TLS_WEAK.has(err.code)) {
    return `${url.host}: a certificate of the chain uses a signature algorithm or key size that OpenSSL 3 refuses, e.g. SHA-1 or RSA below 2048 bits (${reason})`;
  }
  if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return `${url.host}: the server certificate is not valid for this host name`;
  }
  if (err.code === 'CERT_HAS_EXPIRED') return `${url.host}: the server certificate has expired`;
  if (err.code === 'ENOTFOUND') return `${url.hostname}: host name not found`;
  if (err.code === 'ECONNREFUSED') return `${url.host}: connection refused`;
  return `${url.host}: ${err.message}`;
}
