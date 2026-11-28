import { createHash } from 'node:crypto';
import type { ManagementBackupNotice } from '@capi-navigator/shared';
import { stringify } from 'yaml';
import type { BackupEntry } from './backup-archive.js';

/**
 * Backup of a management cluster (FP-39, ADR-0047). Pure functions: the backend reads the objects,
 * these decide what goes into the archive and in which form. The CAPI part is restored with
 * `clusterctl move --from-directory`, the provider and identity parts with `kubectl apply` first.
 */

export const MANAGEMENT_BACKUP_FORMAT = 'capi-navigator-management-backup/v1';

/** The CRD label clusterctl selects by, and its two refinements (clusterctl v1.14 objectgraph). */
export const CLUSTERCTL_LABEL = 'clusterctl.cluster.x-k8s.io';
export const MOVE_HIERARCHY_LABEL = 'clusterctl.cluster.x-k8s.io/move-hierarchy';
export const MOVE_LABEL = 'clusterctl.cluster.x-k8s.io/move';
const PAUSED_ANNOTATION = 'cluster.x-k8s.io/paused';
const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';
const MANAGED_BY_LABEL = 'capi-navigator.io/managed-by';
const HOSTED_ON_LABEL = 'capi-navigator.io/hosted-on';
const CREDENTIAL_LABEL = 'capi-navigator.io/credential';

/** cert-manager's CRDs carry the clusterctl label after `clusterctl init`; never backed up. */
const SKIPPED_GROUPS = ['cert-manager.io', 'acme.cert-manager.io'];
/** Secrets CAPI and the control plane providers name after the cluster (clusterctl soft owners). */
const CLUSTER_SECRET_SUFFIXES = [
  'kubeconfig',
  'ca',
  'etcd',
  'sa',
  'proxy',
  'apiserver-etcd-client',
];
/** Kinds that root a clusterctl move hierarchy in a namespace, besides move-hierarchy CRDs. */
const ROOT_KINDS = [
  'cluster.x-k8s.io/Cluster',
  'cluster.x-k8s.io/ClusterClass',
  'addons.cluster.x-k8s.io/ClusterResourceSet',
];
/** Restore order of the CAPI Operator providers: core first. */
const PROVIDER_ORDER = [
  'CoreProvider',
  'BootstrapProvider',
  'ControlPlaneProvider',
  'InfrastructureProvider',
  'IPAMProvider',
  'AddonProvider',
  'RuntimeExtensionProvider',
];

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

/** A Kubernetes object as the API returns it. */
export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: OwnerReference[];
    deletionTimestamp?: string;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A CRD as the backup needs it: its storage version and the clusterctl labels. */
export interface BackupCrd {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  moveHierarchy: boolean;
}

/** The raw CRD fields read by `backupCrds`. */
export interface RawCrd {
  metadata: { name: string; labels?: Record<string, string> };
  spec: {
    group: string;
    scope: string;
    names: { kind: string; plural: string };
    versions: { name: string; storage: boolean }[];
  };
}

/**
 * FP39-F-02: the CRDs whose objects can belong to the backup: labelled for clusterctl, in their
 * storage version. The CAPI Operator's own CRDs carry only `…/core` and are not among them.
 */
export function backupCrds(crds: RawCrd[]): BackupCrd[] {
  return crds
    .filter((c) => c.metadata.labels?.[CLUSTERCTL_LABEL] !== undefined)
    .filter((c) => !SKIPPED_GROUPS.includes(c.spec.group))
    .flatMap((c) => {
      const storage = c.spec.versions.find((v) => v.storage);
      if (!storage) return [];
      return [
        {
          group: c.spec.group,
          version: storage.name,
          kind: c.spec.names.kind,
          plural: c.spec.names.plural,
          namespaced: c.spec.scope === 'Namespaced',
          moveHierarchy: c.metadata.labels?.[MOVE_HIERARCHY_LABEL] !== undefined,
        },
      ];
    })
    .sort((a, b) => cmp(`${a.group}/${a.kind}`, `${b.group}/${b.kind}`));
}

/** Code-point order, the same in every locale (byte-identical output, hard rule 3). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const groupOf = (apiVersion: string) => (apiVersion.includes('/') ? apiVersion.split('/')[0]! : '');
const typeOf = (o: KubeObject) => `${groupOf(o.apiVersion)}/${o.kind}`;

/**
 * FP39-F-02: the workload namespaces: those holding a Cluster, ClusterClass, ClusterResourceSet or
 * an object of a move-hierarchy CRD. Provider namespaces hold none of these.
 */
export function workloadNamespaces(crds: BackupCrd[], objects: KubeObject[]): string[] {
  const roots = new Set([
    ...ROOT_KINDS,
    ...crds.filter((c) => c.moveHierarchy && c.namespaced).map((c) => `${c.group}/${c.kind}`),
  ]);
  return [
    ...new Set(
      objects
        .filter((o) => o.metadata.namespace && roots.has(typeOf(o)))
        .map((o) => o.metadata.namespace!),
    ),
  ].sort();
}

export interface ManagementBackupInput {
  crds: BackupCrd[];
  /** All objects of `crds`, from all namespaces. */
  objects: KubeObject[];
  /** Secrets and ConfigMaps of the workload namespaces. */
  secrets: KubeObject[];
  configMaps: KubeObject[];
  /** The CAPI Operator's provider resources, all kinds. */
  providers: KubeObject[];
  /** The namespaces of the providers. */
  providerNamespaces: KubeObject[];
  /** Secrets of the provider namespaces: the app's and those the providers' configSecret names. */
  providerSecrets: KubeObject[];
  /** Control plane kinds that run hosted (FP39-F-06), from the bootstrap flavor plugins. */
  hostedControlPlaneKinds: string[];
  /** Bootstrap config kinds whose data Secrets are written again after a restore (FP39-F-03). */
  regeneratedBootstrapData?: string[];
}

export interface ManagementBackupSelection {
  namespaces: string[];
  /** CAPI part, cleaned for clusterctl (uid and owner references kept). */
  capi: KubeObject[];
  /** Provider part, cleaned for kubectl: namespaces, Secrets, provider resources. */
  providers: { namespaces: KubeObject[]; secrets: KubeObject[]; providers: KubeObject[] };
  /** Identities the app created (cluster-scoped), cleaned for kubectl. */
  identities: KubeObject[];
  excluded: ManagementBackupNotice[];
  warnings: ManagementBackupNotice[];
}

/** FP39-F-02 to F-07: what the archive contains, in which form, and what it leaves out. */
export function selectManagementBackup(input: ManagementBackupInput): ManagementBackupSelection {
  const namespaces = workloadNamespaces(input.crds, input.objects);
  const inScope = new Set(namespaces);
  const hierarchy = new Set(
    input.crds.filter((c) => c.moveHierarchy && !c.namespaced).map((c) => `${c.group}/${c.kind}`),
  );
  const capiObjects = input.objects.filter((o) =>
    o.metadata.namespace ? inScope.has(o.metadata.namespace) : hierarchy.has(typeOf(o)),
  );
  const isCluster = (o: KubeObject) => typeOf(o) === 'cluster.x-k8s.io/Cluster';

  // FP39-F-06: hosted clusters and everything that hangs on them.
  const hosted = capiObjects.filter(
    (o) =>
      isCluster(o) &&
      (input.hostedControlPlaneKinds.includes(
        String((o.spec?.controlPlaneRef as { kind?: string } | undefined)?.kind ?? ''),
      ) ||
        o.metadata.labels?.[HOSTED_ON_LABEL] !== undefined),
  );
  const excludedUids = new Set(hosted.map((o) => o.metadata.uid).filter((u) => u !== undefined));
  const hostedNames = new Set(hosted.map((o) => `${o.metadata.namespace}/${o.metadata.name}`));
  const candidates = [
    ...capiObjects,
    ...input.secrets.filter((o) => inScope.has(o.metadata.namespace ?? '')),
    ...input.configMaps.filter((o) => inScope.has(o.metadata.namespace ?? '')),
  ];
  const belongsToHosted = (o: KubeObject) => {
    const ns = o.metadata.namespace;
    const cluster = o.metadata.labels?.[CLUSTER_NAME_LABEL];
    if (ns && cluster && hostedNames.has(`${ns}/${cluster}`)) return true;
    return [...hostedNames].some((h) => {
      const [hns, hname] = h.split('/');
      return (
        ns === hns &&
        o.kind === 'Secret' &&
        CLUSTER_SECRET_SUFFIXES.some((s) => o.metadata.name === `${hname}-${s}`)
      );
    });
  };
  // Owner chains, to a fixpoint: a child of an excluded object is excluded too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const o of candidates) {
      const uid = o.metadata.uid;
      if (!uid || excludedUids.has(uid)) continue;
      if (
        belongsToHosted(o) ||
        (o.metadata.ownerReferences ?? []).some((r) => excludedUids.has(r.uid))
      ) {
        excludedUids.add(uid);
        changed = true;
      }
    }
  }
  const kept = (o: KubeObject) => !o.metadata.uid || !excludedUids.has(o.metadata.uid);
  const capi = capiObjects.filter(kept);

  // FP39-F-03: Secrets and ConfigMaps that belong to the CAPI part.
  const uids = new Set(capi.map((o) => o.metadata.uid).filter((u) => u !== undefined));
  const clusters = capi.filter(isCluster);
  const capiName = (o: KubeObject) =>
    o.kind === 'Secret' &&
    clusters.some(
      (c) =>
        c.metadata.namespace === o.metadata.namespace &&
        CLUSTER_SECRET_SUFFIXES.some((s) => o.metadata.name === `${c.metadata.name}-${s}`),
    );
  const extras: KubeObject[] = [];
  const regenerated = new Set(input.regeneratedBootstrapData ?? []);
  for (const o of [...input.secrets, ...input.configMaps]) {
    if (!inScope.has(o.metadata.namespace ?? '') || !kept(o)) continue;
    if (
      o.kind === 'Secret' &&
      (o.metadata.ownerReferences ?? []).some((r) => regenerated.has(r.kind))
    )
      continue;
    const owned = (o.metadata.ownerReferences ?? []).some((r) => uids.has(r.uid));
    const app = o.metadata.labels?.[MANAGED_BY_LABEL] === 'capi-navigator';
    // A provider that labels a cluster's Secret but sets no owner (none seen so far).
    const labelled = clusters.some(
      (c) =>
        c.metadata.namespace === o.metadata.namespace &&
        o.metadata.labels?.[CLUSTER_NAME_LABEL] === c.metadata.name,
    );
    if (owned || capiName(o)) extras.push(o);
    else if (app || (o.kind === 'Secret' && labelled)) {
      // Nothing owns it, so clusterctl restores it only with the move label.
      extras.push({
        ...o,
        metadata: { ...o.metadata, labels: { ...o.metadata.labels, [MOVE_LABEL]: '' } },
      });
    }
  }

  const identities = input.objects
    .filter((o) => !o.metadata.namespace && o.metadata.labels?.[CREDENTIAL_LABEL] !== undefined)
    .map(cleanForKubectl);

  // A namespace that held only hosted clusters has nothing left to restore.
  const keptObjects = [...capi, ...extras];
  return {
    namespaces: namespaces.filter((ns) => keptObjects.some((o) => o.metadata.namespace === ns)),
    capi: sortObjects(keptObjects.map(cleanForClusterctl)),
    providers: {
      namespaces: sortObjects(
        input.providerNamespaces.map((n) => ({
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: n.metadata.name,
            ...(n.metadata.labels ? { labels: n.metadata.labels } : {}),
          },
        })),
      ),
      secrets: sortObjects(input.providerSecrets.map(cleanForKubectl)),
      providers: [...input.providers]
        .map(cleanForKubectl)
        .sort(
          (a, b) =>
            PROVIDER_ORDER.indexOf(a.kind) - PROVIDER_ORDER.indexOf(b.kind) ||
            cmp(a.metadata.namespace ?? '', b.metadata.namespace ?? '') ||
            cmp(a.metadata.name, b.metadata.name),
        ),
    },
    identities: sortObjects(identities),
    excluded: hosted
      .map((o) => ({
        kind: o.kind,
        namespace: o.metadata.namespace,
        name: o.metadata.name,
        message:
          'Hosted control plane: its etcd is not part of the backup, so the cluster is left out.',
      }))
      .sort(byNotice),
    warnings: changeWarnings(capi).sort(byNotice),
  };
}

/** FP39-F-07: clusters in the middle of a change; backed up as they are. */
function changeWarnings(objects: KubeObject[]): ManagementBackupNotice[] {
  const out: ManagementBackupNotice[] = [];
  for (const o of objects) {
    const at = { kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name };
    if (o.metadata.deletionTimestamp) {
      out.push({ ...at, message: 'Being deleted; the backup holds it as it was.' });
      continue;
    }
    const type = typeOf(o);
    if (type === 'cluster.x-k8s.io/Cluster') {
      const init = (o.status?.initialization ?? {}) as Record<string, unknown>;
      if (init.infrastructureProvisioned !== true || init.controlPlaneInitialized !== true)
        out.push({ ...at, message: 'Not provisioned yet; a restore continues where it stands.' });
      if (o.spec?.paused === true)
        out.push({
          ...at,
          message: 'Paused in the source; clusterctl unpauses it at the end of a restore.',
        });
    }
    if (type === 'cluster.x-k8s.io/Machine' && !(o.status as { nodeRef?: unknown })?.nodeRef)
      out.push({ ...at, message: 'Machine without a node yet.' });
  }
  return out;
}

const SERVER_FIELDS = [
  'managedFields',
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'deletionTimestamp',
  'deletionGracePeriodSeconds',
  'selfLink',
];
const DROPPED_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration'];

function baseClean(o: KubeObject, dropIdentity: boolean): KubeObject {
  const metadata: KubeObject['metadata'] = { ...o.metadata };
  for (const f of SERVER_FIELDS) delete metadata[f];
  if (dropIdentity) {
    delete metadata.uid;
    delete metadata.ownerReferences;
  }
  const annotations = Object.fromEntries(
    Object.entries(metadata.annotations ?? {}).filter(([k]) => !DROPPED_ANNOTATIONS.includes(k)),
  );
  if (Object.keys(annotations).length) metadata.annotations = annotations;
  else delete metadata.annotations;
  const out: KubeObject = { ...o, metadata };
  delete out.status;
  return out;
}

/**
 * FP39-F-05: as `clusterctl move --from-directory` needs it: uid and owner references stay (it
 * builds the object graph from them), server fields and status go, and every Cluster and
 * ClusterClass is paused, so nothing reconciles before the restore is complete.
 */
export function cleanForClusterctl(o: KubeObject): KubeObject {
  const out = baseClean(o, false);
  const type = typeOf(out);
  if (type === 'cluster.x-k8s.io/Cluster') out.spec = { ...out.spec, paused: true };
  if (type === 'cluster.x-k8s.io/ClusterClass')
    out.metadata = {
      ...out.metadata,
      annotations: { ...out.metadata.annotations, [PAUSED_ANNOTATION]: '' },
    };
  return out;
}

/** FP39-F-04: as `kubectl apply` takes it: no uid, owner references, server fields or status. */
export function cleanForKubectl(o: KubeObject): KubeObject {
  return baseClean(o, true);
}

function sortObjects(objects: KubeObject[]): KubeObject[] {
  return [...objects].sort(
    (a, b) =>
      cmp(a.metadata.namespace ?? '', b.metadata.namespace ?? '') ||
      cmp(typeOf(a), typeOf(b)) ||
      cmp(a.metadata.name, b.metadata.name),
  );
}

function byNotice(a: ManagementBackupNotice, b: ManagementBackupNotice): number {
  return (
    cmp(a.namespace ?? '', b.namespace ?? '') ||
    cmp(a.kind, b.kind) ||
    cmp(a.name, b.name) ||
    cmp(a.message, b.message)
  );
}

/** Objects per kind, for the preview and the manifest. */
export function countByKind(objects: KubeObject[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const o of objects) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => cmp(a.kind, b.kind));
}

export interface ManagementBackupMeta {
  connection: string;
  createdAt: Date;
  createdBy: string;
  appVersion: string;
  /** Fingerprints of the recipient keys. */
  recipients: string[];
  /** CAPI, providers, cert-manager, CAPI Operator, ORC (FP39-F-05). */
  versions: { name: string; version: string }[];
}

const yamlOf = (objects: KubeObject[]) =>
  objects.map((o) => stringify(o, { lineWidth: 0, sortMapEntries: true })).join('---\n');

/** Name of the CAPI file of cluster-scoped objects; `_` cannot start a namespace name. */
const CLUSTER_SCOPED_FILE = 'capi/_cluster-scoped.yaml';

/**
 * FP39-F-05, F-08: the files of the archive, a pure function. `capi/` holds nothing but the
 * manifests clusterctl reads (one file per namespace); `providers/` and `identities/` are applied
 * with kubectl before it; `manifest.json` and `RESTORE.md` sit at the top.
 */
export function buildManagementEntries(
  selection: ManagementBackupSelection,
  meta: ManagementBackupMeta,
): BackupEntry[] {
  const files: (BackupEntry & { objects: KubeObject[] })[] = [];
  const add = (name: string, objects: KubeObject[]) => {
    if (objects.length)
      files.push({ name, content: Buffer.from(yamlOf(objects), 'utf8'), objects });
  };
  add('providers/10-namespaces.yaml', selection.providers.namespaces);
  add('providers/20-secrets.yaml', selection.providers.secrets);
  add('providers/30-providers.yaml', selection.providers.providers);
  add('identities/identities.yaml', selection.identities);
  add(
    CLUSTER_SCOPED_FILE,
    selection.capi.filter((o) => !o.metadata.namespace),
  );
  for (const ns of selection.namespaces)
    add(
      `capi/${ns}.yaml`,
      selection.capi.filter((o) => o.metadata.namespace === ns),
    );
  const manifest = {
    format: MANAGEMENT_BACKUP_FORMAT,
    appVersion: meta.appVersion,
    connection: meta.connection,
    createdAt: meta.createdAt.toISOString(),
    createdBy: meta.createdBy,
    recipients: meta.recipients,
    versions: meta.versions,
    namespaces: selection.namespaces,
    excluded: selection.excluded,
    warnings: selection.warnings,
    files: files.map((f) => ({
      name: f.name,
      objects: countByKind(f.objects),
      sha256: createHash('sha256').update(f.content).digest('hex'),
    })),
  };
  return [
    { name: 'manifest.json', content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'RESTORE.md', content: Buffer.from(managementRestoreGuide(selection, meta)) },
    ...files.map(({ name, content }) => ({ name, content })),
  ];
}

/** FP39-F-08: how to restore without the app. */
export function managementRestoreGuide(
  selection: ManagementBackupSelection,
  meta: ManagementBackupMeta,
): string {
  const version = (name: string) => meta.versions.find((v) => v.name === name)?.version;
  const capi = version('cluster-api');
  const clusterctl = capi
    ? `clusterctl ${capi.replace(/^v?(\d+\.\d+).*$/, 'v$1')}.x (the CAPI version of the backup is ${capi})`
    : 'clusterctl of the CAPI minor version of the old management cluster';
  const versions = meta.versions.map((v) => `- ${v.name}: ${v.version}`).join('\n');
  const excluded = selection.excluded.length
    ? `\n**Not in this backup** (hosted control planes, their etcd cannot be restored):\n\n${selection.excluded
        .map((e) => `- ${e.namespace}/${e.name}`)
        .join('\n')}\n`
    : '';
  const warnings = selection.warnings.length
    ? `\n**Backed up in the middle of a change** (restored as they were):\n\n${selection.warnings
        .map((w) => `- ${w.kind} ${w.namespace ? `${w.namespace}/` : ''}${w.name}: ${w.message}`)
        .join('\n')}\n`
    : '';
  return `# Restore a management cluster backup

Backup of the management cluster of connection \`${meta.connection}\`, CAPI Navigator
${meta.appVersion}, created ${meta.createdAt.toISOString()} by ${meta.createdBy}. The files contain
Secrets in plain text (base64), among them the CAs of the workload clusters and cloud credentials:
keep the decrypted copy only as long as you need it.

Versions in the old management cluster:

${versions || '- (none found)'}
${excluded}${warnings}
## Before you start

- **The old management cluster must be gone**, or its Clusters paused
  (\`kubectl patch cluster <name> --type merge -p '{"spec":{"paused":true}}'\`). Two management
  clusters must never manage the same machines.
- **The new management cluster must not contain these objects yet.** clusterctl skips objects that
  exist instead of updating them.
- You need \`kubectl\` and ${clusterctl}. \`--dry-run\` does nothing with \`--from-directory\`: the
  command really restores.

## Steps

1. Install cert-manager and the Cluster API Operator in the new management cluster, in the versions
   listed above (or the ones CAPI Navigator installs). If ORC is listed, install it too, e.g. on
   the Providers page of CAPI Navigator once its connection points to the new cluster (step 5).

2. Apply the provider part and wait until every provider is ready:

   \`\`\`sh
   kubectl apply --server-side -f providers/
   kubectl get coreproviders,bootstrapproviders,controlplaneproviders,infrastructureproviders,addonproviders,ipamproviders -A -w
   \`\`\`

3. Apply the identities (cloud credentials of the clusters), if the folder exists:

   \`\`\`sh
   kubectl apply --server-side -f identities/
   \`\`\`

4. Restore the Cluster API objects. clusterctl creates the namespaces, restores the objects in the
   right order with new owner references and unpauses the clusters at the end:

   \`\`\`sh
   clusterctl move --from-directory capi/ --to-kubeconfig <kubeconfig of the new management cluster>
   \`\`\`

   The controllers take the running machines over: no machine is replaced, the CAs stay the same.
   Status is rebuilt by the controllers within a few minutes.

5. Point the connection \`${meta.connection}\` in CAPI Navigator to the new management cluster (new
   kubeconfig or token on the Connections page) and test it. An in-cluster connection of an
   all-in-one installation needs nothing.

Not restored: status (rebuilt by the controllers), creation dates, Events, and the access objects of
CAPI Navigator (\`capi-navigator-access\`), which a new management cluster gets when it is connected.
`;
}
