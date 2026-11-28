import { ConflictException, Injectable } from '@nestjs/common';
import {
  ApiextensionsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  type KubeConfig,
} from '@kubernetes/client-node';
import {
  FLAVOR_PLUGINS,
  managementBackupFileName,
  type ManagementBackupPreview,
} from '@capi-navigator/shared';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { isNotFound, kubeMessage, kubeStatus, toHttpException } from '../kube/errors.js';
import { detectPrerequisites } from '../operator/prerequisites.js';
import { listProviders } from '../operator/providers.js';
import { APP_VERSION } from '../version.js';
import { packArchive } from './backup-archive.js';
import { encryptTo } from './backup-keys.js';
import { BackupService, type Backup } from './backup.service.js';
import {
  backupCrds,
  buildManagementEntries,
  countByKind,
  selectManagementBackup,
  workloadNamespaces,
  type KubeObject,
  type ManagementBackupInput,
  type ManagementBackupSelection,
  type RawCrd,
} from './management-backup.js';

const MANAGED_BY = 'capi-navigator.io/managed-by=capi-navigator';
const PAGE = 500;

/** A kind the connection may not read (FP39-F-10). */
interface Unreadable {
  kind: string;
  resource: string;
  message: string;
}

interface Collected {
  input: ManagementBackupInput;
  unreadable: Unreadable[];
  versions: { name: string; version: string }[];
}

/**
 * Backup of a management cluster (FP-39, ADR-0047): reads with the connection's permissions,
 * changes nothing there, and builds the archive with the pure functions of management-backup.ts.
 */
@Injectable()
export class ManagementBackupService {
  constructor(
    private readonly clients: ManagementClusterClients,
    private readonly backup: BackupService,
  ) {}

  /** FP39-F-09, F-10: what a backup of this connection would contain now. */
  async preview(connection: string): Promise<ManagementBackupPreview> {
    const [collected, recipients] = await Promise.all([
      this.collect(connection),
      this.backup.storedSpec().then((s) => s.recipients.length),
    ]);
    const s = selectManagementBackup(collected.input);
    const capi = countByKind(s.capi);
    const providers = countByKind([
      ...s.providers.namespaces,
      ...s.providers.secrets,
      ...s.providers.providers,
      ...s.identities,
    ]);
    return {
      connection,
      capi,
      providers,
      total: [...capi, ...providers].reduce((n, i) => n + i.count, 0),
      namespaces: s.namespaces,
      excluded: s.excluded,
      warnings: s.warnings,
      unreadable: collected.unreadable,
      versions: collected.versions,
      recipients,
    };
  }

  /** FP39-F-01, F-05: the encrypted archive of one management cluster. */
  async create(connection: string, createdBy: string, now = new Date()): Promise<Backup> {
    const keys = await this.backup.recipientKeys();
    const collected = await this.collect(connection);
    if (collected.unreadable.length) {
      throw new ConflictException({
        statusCode: 409,
        message: `The connection cannot read ${collected.unreadable.map((u) => u.kind).join(', ')}`,
        hint: 'A backup without these objects could lose parts of the clusters on restore. Allow the connection to read them (the minimal ClusterRole of the access manifests does), then try again.',
        details: collected.unreadable.map((u) => `${u.resource}: ${u.message}`).join('\n'),
      });
    }
    const selection = selectManagementBackup(collected.input);
    const fingerprints = keys.map((k) => k.getFingerprint().toUpperCase());
    const entries = buildManagementEntries(selection, {
      connection,
      createdAt: now,
      createdBy,
      appVersion: APP_VERSION,
      recipients: fingerprints,
      versions: collected.versions,
    });
    const data = await encryptTo(await packArchive(entries, now), keys);
    return {
      fileName: managementBackupFileName(connection, now),
      data,
      summary: summaryOf(connection, selection, fingerprints),
    };
  }

  /** Reads everything the selection needs; a kind it may not read is recorded, not fatal. */
  private async collect(connection: string): Promise<Collected> {
    const kc = await this.clients.forConnection(connection);
    try {
      return await this.read(kc);
    } catch (err) {
      throw toHttpException(err, `Read the management cluster "${connection}" for the backup`);
    }
  }

  private async read(kc: KubeConfig): Promise<Collected> {
    const ext = kc.makeApiClient(ApiextensionsV1Api);
    const custom = kc.makeApiClient(CustomObjectsApi);
    const core = kc.makeApiClient(CoreV1Api);
    const unreadable: Unreadable[] = [];
    const guarded = async <T>(
      kind: string,
      resource: string,
      fn: () => Promise<T[]>,
    ): Promise<T[]> => {
      try {
        return await fn();
      } catch (err) {
        if (isNotFound(err)) return [];
        if (kubeStatus(err) !== 403) throw err;
        unreadable.push({ kind, resource, message: kubeMessage(err) ?? 'forbidden' });
        return [];
      }
    };

    const crds = backupCrds(
      await paged<RawCrd>((cont) =>
        ext.listCustomResourceDefinition({ limit: PAGE, ...(cont ? { _continue: cont } : {}) }),
      ),
    );
    const objects = (
      await Promise.all(
        crds.map((c) =>
          guarded(c.kind, `${c.plural}.${c.group}`, () =>
            paged<KubeObject>((cont) =>
              custom.listClusterCustomObject({
                group: c.group,
                version: c.version,
                plural: c.plural,
                limit: PAGE,
                ...(cont ? { _continue: cont } : {}),
              }),
            ).then((items) =>
              // The list response names the kind only once; every object gets it back.
              items.map((i) => ({ ...i, apiVersion: `${c.group}/${c.version}`, kind: c.kind })),
            ),
          ),
        ),
      )
    ).flat();
    const namespaces = workloadNamespaces(crds, objects);
    const perNamespace = async (kind: 'Secret' | 'ConfigMap') =>
      (
        await Promise.all(
          namespaces.map((namespace) =>
            guarded(kind, `${kind === 'Secret' ? 'secrets' : 'configmaps'} in ${namespace}`, () =>
              paged<KubeObject>((cont) => {
                const args = { namespace, limit: PAGE, ...(cont ? { _continue: cont } : {}) };
                return kind === 'Secret'
                  ? core.listNamespacedSecret(args)
                  : core.listNamespacedConfigMap(args);
              }).then((items) => items.map((i) => ({ ...i, apiVersion: 'v1', kind }))),
            ),
          ),
        )
      ).flat();
    const [secrets, configMaps] = await Promise.all([
      perNamespace('Secret'),
      perNamespace('ConfigMap'),
    ]);

    const providers = await guarded('Provider', 'providers.operator.cluster.x-k8s.io', () =>
      listProviders(kc),
    );
    const providerNs = [...new Set(providers.map((p) => p.metadata.namespace))].sort();
    const providerNamespaces = (
      await Promise.all(
        providerNs.map((name) =>
          guarded('Namespace', `namespaces/${name}`, async () => [
            { ...(await core.readNamespace({ name })), apiVersion: 'v1', kind: 'Namespace' },
          ]),
        ),
      )
    ).flat() as KubeObject[];
    const appSecrets = (
      await Promise.all(
        providerNs.map((namespace) =>
          guarded('Secret', `secrets in ${namespace}`, () =>
            paged<KubeObject>((cont) =>
              core.listNamespacedSecret({
                namespace,
                labelSelector: MANAGED_BY,
                limit: PAGE,
                ...(cont ? { _continue: cont } : {}),
              }),
            ),
          ),
        ),
      )
    ).flat();
    // Configuration Secrets the providers name, also those the app did not create.
    const refs = providers.flatMap((p) =>
      p.spec?.configSecret
        ? [
            {
              namespace: p.spec.configSecret.namespace ?? p.metadata.namespace,
              name: p.spec.configSecret.name,
            },
          ]
        : [],
    );
    const configSecrets = (
      await Promise.all(
        refs.map((r) =>
          guarded('Secret', `secrets/${r.name} in ${r.namespace}`, async () => [
            (await core.readNamespacedSecret(r)) as unknown as KubeObject,
          ]),
        ),
      )
    ).flat();
    const providerSecrets = dedupe(
      [...appSecrets, ...configSecrets].map((s) => ({ ...s, apiVersion: 'v1', kind: 'Secret' })),
    );

    const prerequisites = await detectPrerequisites(kc).catch(() => undefined);
    const versions = [
      ...providers.map((p) => ({
        name:
          p.kind === 'CoreProvider'
            ? p.metadata.name
            : `${p.metadata.name} (${p.kind.replace(/Provider$/, '')})`,
        version: p.spec?.version ?? '',
      })),
      ...(
        [
          ['cert-manager', prerequisites?.certManager],
          ['cluster-api-operator', prerequisites?.operator],
          ['orc', prerequisites?.orc],
        ] as const
      ).flatMap(([name, status]) =>
        status?.installed && status.version ? [{ name, version: status.version }] : [],
      ),
    ].filter((v) => v.version);

    return {
      input: {
        crds,
        objects,
        secrets,
        configMaps,
        providers: providers.map((p) => ({
          ...(p as unknown as KubeObject),
          apiVersion: p.apiVersion ?? 'operator.cluster.x-k8s.io/v1alpha2',
        })),
        providerNamespaces,
        providerSecrets,
        hostedControlPlaneKinds: hostedControlPlaneKinds(),
      },
      unreadable,
      versions,
    };
  }
}

/** FP39-F-06: control plane kinds that run hosted, named by the bootstrap flavor plugins. */
export function hostedControlPlaneKinds(): string[] {
  return Object.values(FLAVOR_PLUGINS).flatMap((p) =>
    p?.hosted ? [p.hosted.controlPlaneResource.kind] : [],
  );
}

function summaryOf(
  connection: string,
  s: ManagementBackupSelection,
  fingerprints: string[],
): string {
  const objects =
    s.capi.length +
    s.providers.namespaces.length +
    s.providers.secrets.length +
    s.providers.providers.length +
    s.identities.length;
  const n = s.excluded.length;
  const excluded = n ? `, ${n} hosted ${n === 1 ? 'cluster' : 'clusters'} left out` : '';
  return `Management cluster ${connection}: ${objects} objects${excluded}, encrypted to ${fingerprints.join(', ')}`;
}

function dedupe(objects: KubeObject[]): KubeObject[] {
  const seen = new Map<string, KubeObject>();
  for (const o of objects) seen.set(`${o.metadata.namespace}/${o.metadata.name}`, o);
  return [...seen.values()];
}

/** All items of a list call, page by page. */
async function paged<T>(call: (cont?: string) => Promise<unknown>): Promise<T[]> {
  const out: T[] = [];
  let cont: string | undefined;
  do {
    const res = (await call(cont)) as { items?: T[]; metadata?: { _continue?: string } };
    out.push(...(res.items ?? []));
    cont = res.metadata?._continue || undefined;
  } while (cont);
  return out;
}
