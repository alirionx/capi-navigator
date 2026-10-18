import {
  KubernetesObjectApi,
  PatchStrategy,
  type KubeConfig,
  type KubernetesObject,
} from '@kubernetes/client-node';
import { FIELD_MANAGER } from '../store/custom-resource.client.js';
import { kubeMessage, kubeStatus } from './errors.js';

/**
 * Server-side apply with the fixed field manager `capi-navigator` (hard rule 6, NF-13).
 * Objects are applied in the given order; `dryRun` validates without persisting.
 */
export async function serverSideApply(
  kc: KubeConfig,
  objects: KubernetesObject[],
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<KubernetesObject[]> {
  const api = KubernetesObjectApi.makeApiClient(kc);
  const results: KubernetesObject[] = [];
  for (const obj of objects) {
    results.push(
      await api.patch(
        obj,
        undefined,
        opts.dryRun ? 'All' : undefined,
        FIELD_MANAGER,
        // Take over fields from kubectl/helm managers only when explicitly forced; otherwise
        // conflicts surface as 409 with an understandable message.
        opts.force ?? false,
        PatchStrategy.ServerSideApply,
      ),
    );
  }
  return results;
}

/** "Kind name (namespace)" for error messages. */
export function describeObject(obj: KubernetesObject): string {
  const ns = obj.metadata?.namespace ? ` in ${obj.metadata.namespace}` : '';
  return `${obj.kind} ${obj.metadata?.name ?? ''}${ns}`;
}

/** The live object, or undefined if it does not exist. */
export async function readLive(
  kc: KubeConfig,
  obj: KubernetesObject,
): Promise<KubernetesObject | undefined> {
  try {
    return await KubernetesObjectApi.makeApiClient(kc).read({
      apiVersion: obj.apiVersion!,
      kind: obj.kind!,
      metadata: { name: obj.metadata!.name!, namespace: obj.metadata?.namespace },
    });
  } catch (err) {
    if (kubeStatus(err) === 404) return undefined;
    throw err;
  }
}

/** Field managers and fields of a server-side apply conflict (409). */
export interface ApplyConflict {
  managers: string[];
  fields: string[];
}

/**
 * Parses "Apply failed with 2 conflicts: conflict with "kubectl-scale" using
 * cluster.x-k8s.io/v1beta2: .spec.replicas" into managers and fields.
 */
export function parseApplyConflict(message: string): ApplyConflict {
  const managers = new Set<string>();
  const fields = new Set<string>();
  for (const m of message.matchAll(
    /conflicts? with "([^"]+)"(?: with subresource "([^"]+)")?(?: using [^:\n]+)?: ?(\.[^\n]+)?/g,
  )) {
    // e.g. `kubectl scale` writes through the scale subresource.
    managers.add(m[2] ? `${m[1]} (${m[2]})` : m[1]!);
    if (m[3]) fields.add(m[3].trim());
  }
  // Several conflicts are listed as "- conflict with ...: .field" lines.
  for (const m of message.matchAll(
    /^- (?:conflicts? with "[^"]+"(?: with subresource "[^"]+")?(?: using [^:\n]+)?: )?(\.\S+)/gm,
  )) {
    fields.add(m[1]!);
  }
  return { managers: [...managers], fields: [...fields] };
}

/**
 * Dry-run apply of one object: the object as it would be after the apply, and the conflict with
 * other field managers if the apply without `force` was refused (drift, hard rule 4).
 */
export async function dryRunApply(
  kc: KubeConfig,
  obj: KubernetesObject,
): Promise<{ result: KubernetesObject; conflict?: ApplyConflict }> {
  try {
    const [result] = await serverSideApply(kc, [obj], { dryRun: true });
    return { result: result! };
  } catch (err) {
    if (kubeStatus(err) !== 409) throw err;
    const conflict = parseApplyConflict(kubeMessage(err) ?? '');
    const [result] = await serverSideApply(kc, [obj], { dryRun: true, force: true });
    return { result: result!, conflict };
  }
}

/** Strips server-managed metadata and status for comparisons and diffs. */
export function normalizeForDiff(obj: KubernetesObject): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  delete out.status;
  const metadata: Record<string, unknown> = { ...(obj.metadata ?? {}) };
  for (const key of [
    'managedFields',
    'resourceVersion',
    'generation',
    'uid',
    'creationTimestamp',
    'selfLink',
  ]) {
    delete metadata[key];
  }
  out.metadata = metadata;
  // Secrets: never show values (NF-01); mark changed values via a short hash.
  if (obj.kind === 'Secret') {
    for (const key of ['data', 'stringData'] as const) {
      const values = out[key] as Record<string, string> | undefined;
      if (values) {
        out[key] = Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, `******** (${fingerprint(v)})`]),
        );
      }
    }
  }
  return out;
}

/** Short, non-reversible fingerprint to show that a masked value changed. */
function fingerprint(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}

/** Deletes objects; missing ones are fine (FP7-F-06 removed pools). */
export async function deleteObjects(kc: KubeConfig, objects: KubernetesObject[]): Promise<void> {
  const api = KubernetesObjectApi.makeApiClient(kc);
  for (const obj of objects) {
    try {
      await api.delete(obj);
    } catch (err) {
      if (kubeStatus(err) !== 404) throw err;
    }
  }
}
