/** Helpers for the pure transformation (no I/O). */

/** JSON with sorted keys, so equal objects always give the same string. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 32-bit FNV-1a as 8 hex characters; enough to name template revisions (hard rule 5). */
export function shortHash(value: unknown): string {
  const text = stableStringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Removes undefined values and empty objects/arrays, so manifests stay minimal. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      const c = compact(v);
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      if (Array.isArray(c) && c.length === 0) continue;
      out[k] = c;
    }
    return out as T;
  }
  return value;
}

/**
 * Group and version of an apiVersion such as `infrastructure.cluster.x-k8s.io/v1alpha2`.
 * Infrastructure providers serve different versions (CAPMOX v1alpha2, the others v1beta2), so
 * the backend takes them from the plugin instead of assuming one (FP-31).
 */
export function groupVersion(apiVersion: string): { group: string; version: string } {
  const [group, version] = apiVersion.split('/') as [string, string];
  return { group, version };
}
