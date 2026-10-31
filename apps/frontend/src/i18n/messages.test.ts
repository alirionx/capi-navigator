import { describe, expect, it } from 'vitest';
import { en } from './en.js';
import { createAppI18n } from './index.js';

/** All keys of the message tree, e.g. "credentials.proxmox.tokenIdHint". */
function keys(tree: unknown, prefix = ''): string[] {
  return Object.entries(tree as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`),
  );
}

describe('UI texts', () => {
  it('every message compiles (e.g. "@" must be written as {\'@\'})', () => {
    const { t } = createAppI18n().global;
    const broken: string[] = [];
    for (const key of keys(en)) {
      try {
        t(key, {});
      } catch {
        broken.push(key);
      }
    }
    expect(broken).toEqual([]);
  });

  it('no message looks like HTML (vue-i18n warns on every render, e.g. "<name>")', () => {
    const { t } = createAppI18n().global;
    const html = keys(en).filter((key) => /<[^<>]+>/.test(t(key, {})));
    expect(html).toEqual([]);
  });
});
