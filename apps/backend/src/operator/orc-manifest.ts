import type { KubernetesObject } from '@kubernetes/client-node';
import { ORC } from '@capi-navigator/shared';
import { parseAllDocuments } from 'yaml';

const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MOVE_LABEL = 'clusterctl.cluster.x-k8s.io/move';

export class OrcManifestError extends Error {}

/**
 * Downloads the ORC release manifest (FP3-F-04a). Only the release asset URL of the ORC
 * repository is used; the version is validated by the request schema.
 */
export async function fetchOrcManifest(
  version: string,
  fetchFn: typeof fetch = fetch,
): Promise<KubernetesObject[]> {
  const url = ORC.manifestUrl(version);
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { 'User-Agent': 'capi-navigator' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new OrcManifestError(
      `GitHub is not reachable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (res.status === 404) throw new OrcManifestError(`ORC release ${version} does not exist`);
  if (!res.ok) throw new OrcManifestError(`GitHub answered ${res.status} for ${url}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new OrcManifestError('The ORC manifest is unexpectedly large');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new OrcManifestError('The ORC manifest is unexpectedly large');
  return parseOrcManifest(text);
}

/**
 * Parses the multi-document manifest and adds the clusterctl move label to the ORC CRDs that
 * CAPO's documentation requires for `clusterctl move` (POS-05).
 */
export function parseOrcManifest(text: string): KubernetesObject[] {
  const objects: KubernetesObject[] = [];
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0) throw new OrcManifestError('The ORC manifest is not valid YAML');
    const obj = doc.toJS() as KubernetesObject | null;
    if (!obj || typeof obj !== 'object') continue;
    if (!obj.apiVersion || !obj.kind || !obj.metadata?.name) {
      throw new OrcManifestError(
        'The ORC manifest contains an object without apiVersion/kind/name',
      );
    }
    if (obj.kind === 'CustomResourceDefinition' && ORC.moveLabelCrds.includes(obj.metadata.name)) {
      obj.metadata.labels = { ...obj.metadata.labels, [MOVE_LABEL]: '' };
    }
    objects.push(obj);
  }
  if (!objects.some((o) => o.kind === 'Deployment' && o.metadata?.name === ORC.deploymentName)) {
    throw new OrcManifestError('The downloaded file does not look like an ORC install manifest');
  }
  return objects;
}
