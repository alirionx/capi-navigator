import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCACertificates } from 'node:tls';
import { describeError, FetchError, get, proxyFor, withDefaultCAs } from './fetch.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Local HTTP server; reachable as 127.0.0.1 and localhost, i.e. as two different hosts. */
async function serve(handler: Handler): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

describe('fetch for Helm repositories and registries (FP8-F-04)', () => {
  let server: Server;
  let port: number;
  const seen: { path: string; authorization?: string }[] = [];

  beforeAll(async () => {
    ({ server, port } = await serve((req, res) => {
      seen.push({ path: req.url ?? '', authorization: req.headers.authorization });
      if (req.url === '/redirect-same') {
        res.writeHead(302, { location: '/ok' }).end();
      } else if (req.url === '/redirect-other') {
        res.writeHead(302, { location: `http://localhost:${port}/ok` }).end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' }).end();
      } else if (req.url === '/big') {
        res.writeHead(200).end(Buffer.alloc(4096));
      } else if (req.url === '/slow') {
        setTimeout(() => res.writeHead(200).end('late'), 500);
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(`hello ${req.url}`);
      }
    }));
  });
  afterAll(() => server.close());

  it('returns status, headers and body', async () => {
    const res = await get(`http://127.0.0.1:${port}/ok`, { headers: { accept: 'text/plain' } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.body.toString()).toBe('hello /ok');
  });

  it('follows redirects and keeps credentials on the same host only', async () => {
    seen.length = 0;
    const same = await get(`http://127.0.0.1:${port}/redirect-same`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(same.url).toBe(`http://127.0.0.1:${port}/ok`);
    expect(seen.map((s) => s.authorization)).toEqual(['Bearer t', 'Bearer t']);

    seen.length = 0;
    const other = await get(`http://127.0.0.1:${port}/redirect-other`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(other.url).toBe(`http://localhost:${port}/ok`);
    expect(seen.map((s) => s.authorization)).toEqual(['Bearer t', undefined]);
  });

  it('stops after too many redirects', async () => {
    await expect(get(`http://127.0.0.1:${port}/loop`, { maxRedirects: 2 })).rejects.toThrow(
      /Too many redirects/,
    );
  });

  it('enforces the size limit and the timeout', async () => {
    await expect(get(`http://127.0.0.1:${port}/big`, { maxBytes: 1024 })).rejects.toThrow(
      /larger than 1024 bytes/,
    );
    await expect(get(`http://127.0.0.1:${port}/slow`, { timeoutMs: 50 })).rejects.toThrow(
      /Timeout contacting/,
    );
  });

  it('refuses other protocols and explains connection errors', async () => {
    await expect(get('ftp://example.com/index.yaml')).rejects.toBeInstanceOf(FetchError);
    const closed = await serve(() => undefined);
    await new Promise((resolve) => closed.server.close(resolve));
    await expect(get(`http://127.0.0.1:${closed.port}/`)).rejects.toThrow(/connection refused/);
  });

  it('translates TLS and DNS errors without leaking headers (NF-06)', () => {
    const url = new URL('https://registry.example.com:5000/v2/');
    const err = (code: string) => Object.assign(new Error('raw'), { code });
    expect(describeError(url, err('SELF_SIGNED_CERT_IN_CHAIN'), {})).toMatch(
      /Add the CA certificate of the registry: the root CA and every intermediate CA/,
    );
    expect(describeError(url, err('ERR_TLS_CERT_ALTNAME_INVALID'))).toMatch(
      /not valid for this host/,
    );
    expect(describeError(url, err('CERT_HAS_EXPIRED'))).toMatch(/expired/);
    expect(describeError(url, err('ENOTFOUND'))).toBe('registry.example.com: host name not found');
    expect(describeError(url, err('EOTHER'))).toBe('registry.example.com:5000: raw');
    expect(describeError(url, err('CA_MD_TOO_WEAK'))).toMatch(/SHA-1 or RSA below 2048 bits/);
  });

  it('names the proxy when an untrusted certificate came through it (FP-29)', () => {
    const url = new URL('https://bcr2.internal.company.cloud/v2/');
    const err = Object.assign(new Error('unable to get local issuer certificate'), {
      code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    });
    const env = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://proxy.company.cloud:3128' };
    expect(describeError(url, err, { ...env, NO_PROXY: 'company.cloud' })).toMatch(
      /went through the outbound proxy proxy.company.cloud:3128: if bcr2.internal.company.cloud is internal, add it to NO_PROXY/,
    );
    expect(describeError(url, err, { ...env, NO_PROXY: '.company.cloud' })).toMatch(
      /^bcr2.internal.company.cloud: the server certificate is not trusted \(unable to get local issuer certificate\)\. Add the CA/,
    );
  });

  it('follows the NO_PROXY rules of Node.js, not those of Go (FP-29)', () => {
    const env = (noProxy: string) => ({
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://proxy:3128',
      NO_PROXY: noProxy,
    });
    const via = (host: string, noProxy: string) =>
      proxyFor(new URL(`https://${host}/`), env(noProxy));
    const registry = 'bcr2.internal.company.cloud';
    for (const direct of [
      registry,
      '.company.cloud',
      '*.company.cloud',
      'localhost, .company.cloud',
      `${registry}:443`,
      '*',
    ]) {
      expect(via(registry, direct), direct).toBeUndefined();
    }
    for (const proxied of ['company.cloud', `${registry}:5000`, '.other.cloud', '']) {
      expect(via(registry, proxied), proxied).toBe('http://proxy:3128');
    }
    expect(via('10.20.0.5', '10.20.0.1-10.20.0.9')).toBeUndefined();
    expect(via('10.20.0.50', '10.20.0.1-10.20.0.9')).toBe('http://proxy:3128');
    // Without NODE_USE_ENV_PROXY, Node.js ignores the proxy variables.
    expect(proxyFor(new URL('https://example.com/'), { HTTPS_PROXY: 'http://proxy:3128' })).toBe(
      undefined,
    );
  });

  it('adds a private CA to the default trust store instead of replacing it (FP-29)', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nprivate\n-----END CERTIFICATE-----';
    const store = withDefaultCAs(ca);
    expect(store.at(-1)).toBe(ca);
    expect(store.length).toBe(getCACertificates('default').length + 1);
  });
});
