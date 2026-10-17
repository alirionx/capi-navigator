import {
  KubernetesObjectApi,
  PatchStrategy,
  type KubeConfig,
  type KubernetesObject,
} from '@kubernetes/client-node';
import { FIELD_MANAGER } from '../store/custom-resource.client.js';

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
