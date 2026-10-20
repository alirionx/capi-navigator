import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CALICO_MANIFEST } from '@capi-navigator/shared';

const cache = new Map<string, Promise<string>>();

/**
 * A manifest shipped with the backend (assets/<dir>), verified against its pinned checksum so a
 * modified file is never rolled out (Calico: ADR-0014; manifest add-ons: ADR-0023).
 */
export function shippedManifest(dir: string, file: string, sha256: string): Promise<string> {
  const path = `${dir}/${file}`;
  // The checksum is part of the key: a cached file is only served for the checksum it matched.
  const key = `${path}@${sha256}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const text = await readFile(new URL(`../../assets/${path}`, import.meta.url), 'utf8');
      const sum = createHash('sha256').update(text).digest('hex');
      if (sum !== sha256) throw new Error(`Manifest ${path} has an unexpected checksum`);
      return text;
    })().catch((err: unknown) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, pending);
  }
  return pending;
}

/** The Calico manifest (assets/calico, ADR-0014). */
export function calicoManifest(): Promise<string> {
  return shippedManifest('calico', CALICO_MANIFEST.file, CALICO_MANIFEST.sha256);
}
