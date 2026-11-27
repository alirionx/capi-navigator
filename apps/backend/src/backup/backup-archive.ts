import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { stringify } from 'yaml';

/** Format of the archive's manifest.json; a restore tool can check it (FP38-F-04). */
export const BACKUP_FORMAT = 'capi-navigator-home-backup/v1';

/** A Kubernetes object as read from the API; only the fields the backup keeps are typed. */
export interface StoredObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: unknown;
  type?: string;
  data?: Record<string, string>;
  binaryData?: Record<string, string>;
}

/** One file of resources: all objects of a kind, applied in the order of `order`. */
export interface BackupGroup {
  kind: string;
  /** File name stem, e.g. "managementclusters". */
  file: string;
  objects: StoredObject[];
}

export interface BackupInput {
  createdAt: Date;
  createdBy: string;
  appVersion: string;
  namespace: string;
  includesAuditEvents: boolean;
  /** Fingerprints of the recipient keys. */
  recipients: string[];
  /** In restore order: Secrets and ConfigMaps first, then the app's resources. */
  groups: BackupGroup[];
}

export interface BackupEntry {
  name: string;
  content: Buffer;
}

/** Annotations that belong to a client, not to the object (kubectl's copy can hold Secret data). */
const DROPPED_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration'];

/**
 * FP38-F-04: an object as `kubectl apply` takes it. Server-set metadata (uid, resourceVersion,
 * creationTimestamp, managedFields, generation), the namespace and the status are left out, so it
 * can be restored into another namespace; the app rebuilds status itself.
 */
export function cleanObject(obj: StoredObject, apiVersion: string, kind: string): StoredObject {
  const annotations = Object.fromEntries(
    Object.entries(obj.metadata?.annotations ?? {}).filter(
      ([k]) => !DROPPED_ANNOTATIONS.includes(k),
    ),
  );
  const labels = obj.metadata?.labels ?? {};
  const out: StoredObject = {
    apiVersion,
    kind,
    metadata: {
      name: obj.metadata?.name ?? '',
      ...(Object.keys(labels).length ? { labels: sortKeys(labels) } : {}),
      ...(Object.keys(annotations).length ? { annotations: sortKeys(annotations) } : {}),
    },
  };
  if (obj.type !== undefined) out.type = obj.type;
  if (obj.data !== undefined) out.data = sortKeys(obj.data);
  if (obj.binaryData !== undefined) out.binaryData = sortKeys(obj.binaryData);
  if (obj.spec !== undefined) out.spec = obj.spec;
  return out;
}

/**
 * The files of a backup (FP38-F-04), a pure function: `resources/NN-<kind>.yaml` in restore order,
 * `manifest.json` with counts and SHA-256 of every resource file, and `RESTORE.md`.
 */
export function buildBackupEntries(input: BackupInput): BackupEntry[] {
  const files: (BackupEntry & { kind: string; objects: number })[] = [];
  input.groups.forEach((group, i) => {
    if (group.objects.length === 0) return;
    const objects = [...group.objects].sort((a, b) =>
      (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''),
    );
    const yaml = objects
      .map((o) => stringify(o, { lineWidth: 0, sortMapEntries: false }))
      .join('---\n');
    files.push({
      name: `resources/${String(10 + i).padStart(2, '0')}-${group.file}.yaml`,
      content: Buffer.from(yaml, 'utf8'),
      kind: group.kind,
      objects: objects.length,
    });
  });
  const manifest = {
    format: BACKUP_FORMAT,
    appVersion: input.appVersion,
    namespace: input.namespace,
    createdAt: input.createdAt.toISOString(),
    createdBy: input.createdBy,
    includesAuditEvents: input.includesAuditEvents,
    recipients: input.recipients,
    files: files.map((f) => ({
      name: f.name,
      kind: f.kind,
      objects: f.objects,
      sha256: createHash('sha256').update(f.content).digest('hex'),
    })),
  };
  return [
    { name: 'manifest.json', content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'RESTORE.md', content: Buffer.from(restoreGuide(input)) },
    ...files.map(({ name, content }) => ({ name, content })),
  ];
}

/** Packs the entries as tar.gz in memory; nothing touches the disk (FP38-F-05). */
export async function packArchive(entries: BackupEntry[], mtime: Date): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    tar.on('data', (c: unknown) => chunks.push(c as Buffer));
    tar.on('end', resolve);
    tar.on('error', reject);
  });
  for (const e of entries) {
    tar.entry({ name: e.name, size: e.content.length, mode: 0o600, mtime }, e.content);
  }
  tar.finalize();
  await done;
  // zlib writes no time into the gzip header, so the same input gives the same bytes.
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** FP38-F-08: how to restore without the app. */
function restoreGuide(input: BackupInput): string {
  const ns = input.namespace;
  return `# Restore a CAPI Navigator backup

Backup of namespace \`${ns}\`, app version ${input.appVersion}, created
${input.createdAt.toISOString()} by ${input.createdBy}. The files in \`resources/\` contain Secrets
in plain text (base64): keep the decrypted copy only as long as you need it.

1. Install the chart of the same app version (or a newer one with the same CRD version
   \`v1alpha1\`) into an empty home cluster, with the backend scaled to zero so it does not
   create an initial admin first:

   \`\`\`sh
   helm install capi-navigator oci://ghcr.io/alirionx/charts/capi-navigator \\
     --version <version> -n ${ns} --create-namespace -f <your values> --set replicaCount=0
   \`\`\`

2. Apply the resources, in the order of their file names. Server-side apply keeps no copy of the
   Secrets in an annotation:

   \`\`\`sh
   kubectl apply --server-side -n ${ns} -f resources/
   \`\`\`

   Another namespace works too: the files name none.

3. Scale the backend up again:

   \`\`\`sh
   helm upgrade capi-navigator oci://ghcr.io/alirionx/charts/capi-navigator \\
     --version <version> -n ${ns} --reuse-values --set replicaCount=1
   \`\`\`

4. Open the Connections page and test each connection once: their status is not part of the
   backup and shows "Unknown" until then.

Users, passwords, roles, API tokens, connections, Helm repositories, blueprints and settings work
as before. Not restored: the status of resources (rebuilt by the app), creation dates (they show the
time of the restore) and the initial admin password. Management clusters are reached with the
stored credentials; their own objects (providers, clusters) are not part of this backup.
`;
}
