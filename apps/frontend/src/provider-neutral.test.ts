import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FP25-F-05: the frontend renders the forms the infrastructure plugins describe and contains no
 * checks for a specific provider. Provider names may only appear in the i18n texts and in the
 * registry of credential field components.
 */
const ROOT = __dirname;
const ALLOWED = ['i18n/', 'components/credentials/'];
const PROVIDER_LITERAL = /['"`](openstack|aws|gcp)['"`]/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('provider-neutral frontend (FP25-F-05)', () => {
  it('names no infrastructure provider outside i18n and the credential field registry', () => {
    const offending = files(ROOT)
      .map((path) => relative(ROOT, path).replaceAll('\\', '/'))
      .filter((path) => !ALLOWED.some((a) => path.startsWith(a)))
      .flatMap((path) =>
        readFileSync(join(ROOT, path), 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${path}:${i + 1}` }))
          .filter(({ line }) => PROVIDER_LITERAL.test(line))
          .map(({ at, line }) => `${at}: ${line.trim()}`),
      );
    expect(offending).toEqual([]);
  });
});
