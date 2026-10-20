import { parseAllDocuments } from 'yaml';
import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  renderManifests,
  type ManifestObject,
} from '../operator-manifests.js';
import { VERSIONS } from '../versions.generated.js';
import { shortHash } from './util.js';

/**
 * Add-ons without a Helm chart (FP25-F-08, ADR-0023): an upstream manifest shipped with the
 * backend (apps/backend/assets), verified by its checksum, adapted by a pure function and
 * delivered by an upstream ClusterResourceSet to every cluster of the namespace with the label.
 */
export interface ManifestAddon {
  id: keyof typeof VERSIONS.addonManifests;
  /** Infrastructure provider whose clusters get it (wizard table). */
  provider: string;
  kind: 'ccm' | 'csi';
  displayName: string;
  /** Cluster label that selects the add-on, set by the infrastructure plugin. */
  label: [string, string];
  version: string;
  /** File name under apps/backend/assets/<dir>. */
  dir: string;
  file: string;
  sha256: string;
  /** Adapts the upstream manifest to the app's clusters; fails if an expected object is missing. */
  forCluster(manifest: string): string;
}

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Objects of a multi-document manifest; empty documents are dropped. */
export function parseManifest(manifest: string): Obj[] {
  return parseAllDocuments(manifest)
    .map((d) => d.toJS() as Obj | null)
    .filter((o): o is Obj => !!o && typeof o === 'object');
}

export function findObject(objects: Obj[], kind: string, name: string): Obj {
  const o = objects.find((x) => x.kind === kind && x.metadata?.name === name);
  if (!o) throw new Error(`Manifest: ${kind} ${name} not found`);
  return o;
}

export const renderObjects = (objects: Obj[]) => renderManifests(objects as ManifestObject[]);

/** Name of ConfigMap and ClusterResourceSet: version plus content hash, like Calico. */
export function manifestAddonName(addon: ManifestAddon, content: string): string {
  return `capi-navigator-${addon.id}-${addon.version.replace(/\./g, '-')}-${shortHash(content).slice(0, 6)}`;
}

/**
 * Pure: ConfigMap with the adapted manifest and the ClusterResourceSet that applies it once to
 * every cluster of the namespace with the add-on's label. Shared by the namespace's clusters, so
 * it carries no cluster label and stays when a cluster is deleted.
 */
export function buildManifestAddonResourceSet(
  addon: ManifestAddon,
  namespace: string,
  manifest: string,
): ManifestObject[] {
  const content = addon.forCluster(manifest);
  const name = manifestAddonName(addon, content);
  const labels = { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, 'capi-navigator.io/addon': addon.id };
  return [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, namespace, labels },
      data: { [`${addon.id}.yaml`]: content },
    },
    {
      apiVersion: 'addons.cluster.x-k8s.io/v1beta2',
      kind: 'ClusterResourceSet',
      metadata: { name, namespace, labels },
      spec: {
        clusterSelector: { matchLabels: Object.fromEntries([addon.label]) },
        resources: [{ kind: 'ConfigMap', name }],
        strategy: 'ApplyOnce',
      },
    },
  ];
}
