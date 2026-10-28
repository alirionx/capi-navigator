import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FETCH_ARTIFACT_SCRIPT } from './fetch-artifact.generated.js';

const sha = (data: string) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const BINARY = 'k0s binary';
const OTHER = 'install script';
const PINNED = 'content at pin time';

/** Registry like Harbor: anonymous bearer token, blobs redirected to a storage host. */
function fakeRegistry() {
  const requests: { url: string; auth?: string }[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    requests.push({ url, auth: req.headers.authorization });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (url.startsWith('/service/token')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'anon' }));
    } else if (url.startsWith('/v2/')) {
      if (req.headers.authorization !== 'Bearer anon') {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer realm="${base}/service/token",service="harbor-registry",scope="repository:library/k0s-amd64:pull"`,
        );
        res.end();
      } else if (url.endsWith(sha(BINARY))) {
        res.end(BINARY);
      } else if (url.endsWith(sha(PINNED))) {
        res.end('changed content');
      } else if (url.endsWith(sha(OTHER))) {
        // Redirect to "object storage" on another host name.
        res.statusCode = 307;
        res.setHeader(
          'location',
          `http://localhost:${(server.address() as AddressInfo).port}/storage`,
        );
        res.end();
      } else {
        res.statusCode = 404;
        res.end();
      }
    } else if (url === '/storage') {
      res.end(OTHER);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return { server, requests };
}

describe('fetch-artifact script (FP29-F-13)', () => {
  let dir: string;
  let script: string;
  let registry: ReturnType<typeof fakeRegistry>;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fetch-artifact-'));
    script = join(dir, 'fetch.py');
    writeFileSync(script, FETCH_ARTIFACT_SCRIPT);
    registry = fakeRegistry();
    await new Promise<void>((r) => registry.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(registry.server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    registry.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]) =>
    new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile('python3', [script, base, 'library/k0s-amd64', ...args], (err, _out, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr }),
      );
    });

  it('has no Jinja delimiters: RKE2 renders its user data as cloud-init Jinja (ADR-0004)', () => {
    expect(FETCH_ARTIFACT_SCRIPT).not.toMatch(/\{\{|\{%|\{#/);
  });

  it('downloads by digest with the anonymous token and sets the mode', async () => {
    const target = join(dir, 'bin', 'k0s');
    const res = await run(sha(BINARY), target, '0755');
    expect(res.code).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(BINARY);
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(registry.requests.some((r) => r.url.startsWith('/service/token?'))).toBe(true);
  });

  it('drops the token when a blob is redirected to another host', async () => {
    const target = join(dir, 'install.sh');
    expect((await run(sha(OTHER), target, '0644')).code).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(OTHER);
    expect(registry.requests.find((r) => r.url === '/storage')?.auth).toBeUndefined();
  });

  it('stops on a missing artifact and on a changed file, leaving no file behind', async () => {
    const missing = await run(sha('nothing'), join(dir, 'missing'), '0644');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('not found');

    // The registry serves other content than the pinned digest (a changed artifact).
    const changed = join(dir, 'changed');
    const res = await run(sha(PINNED), changed, '0644');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('does not match the pinned');
    expect(() => statSync(changed)).toThrow();
    expect(() => statSync(`${changed}.part`)).toThrow();
  });
});
