import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CALICO_MANIFEST } from '@capi-navigator/shared';

let cached: Promise<string> | undefined;

/**
 * The Calico manifest shipped with the backend (assets/calico, ADR-0014), verified against the
 * pinned checksum so a modified file is never rolled out.
 */
export function calicoManifest(): Promise<string> {
  cached ??= (async () => {
    const url = new URL(`../../assets/calico/${CALICO_MANIFEST.file}`, import.meta.url);
    const text = await readFile(url, 'utf8');
    const sum = createHash('sha256').update(text).digest('hex');
    if (sum !== CALICO_MANIFEST.sha256) {
      throw new Error(`Calico manifest ${CALICO_MANIFEST.file} has an unexpected checksum`);
    }
    return text;
  })().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return cached;
}
