import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { KubernetesObject, V1Secret } from '@kubernetes/client-node';
import {
  ACCOUNTS_NAMESPACE,
  changedFields,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  MANAGED_NAMESPACE_LABEL,
  managedNamespaceObjects,
  namespaceAccountName,
  namespaceAddonName,
  namespaceKubeconfig,
  namespacesUnsupported,
  selectorsCanOverlap,
  TOKEN_ACCOUNT_ANNOTATION,
  TOKEN_CREATOR_ANNOTATION,
  TOKEN_EXPIRY_ANNOTATION,
  TOKEN_LABEL,
  type AddonPreview,
  type AddonStatus,
  type ManagedNamespaces,
  type ManagedNamespaceSpec,
  type ManagedNamespaceView,
  type NamespaceToken,
  type NamespaceTokenResponse,
} from '@capi-navigator/shared';
import { ClustersService } from '../clusters/clusters.service.js';
import { AddonsService } from '../helm/addons.service.js';
import { toHttpException } from '../kube/errors.js';
import { objectKey, workloadAccess, type WorkloadAccess } from './workload-access.js';

const READ_TIMEOUT_MS = 10_000;

/** A cluster of the management cluster, as the routes name it. */
export interface ClusterRef {
  connection: string;
  namespace: string;
  name: string;
}

/**
 * Managed namespaces of workload clusters (FP-36, ADR-0039): defined as add-ons through CAAPH,
 * read and compared with the kubeconfig that CAPI writes; tokens on request (ADR-0040).
 */
@Injectable()
export class NamespacesService {
  constructor(
    private readonly clusters: ClustersService,
    private readonly addons: AddonsService,
  ) {}

  /** Replaced in tests. */
  access: (kubeconfig: string) => WorkloadAccess = workloadAccess;
  now: () => number = Date.now;

  /** FP36-F-11: add-ons of the cluster plus what is left over in it. */
  async list(ref: ClusterRef): Promise<ManagedNamespaces> {
    const unsupported = await this.unsupported(ref.connection, ref.namespace, ref.name);
    const defined = (await this.addons.namespaceAddons(ref.connection, ref.namespace)).filter((a) =>
      a.status.matchingClusters.includes(ref.name),
    );
    const base = unsupported ? { unsupported } : {};
    let cluster: ClusterState;
    try {
      cluster = await withTimeout(
        this.read(
          ref,
          defined.map((d) => d.spec),
        ),
        READ_TIMEOUT_MS,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        unreachable: message,
        namespaces: defined.map(({ spec, status }) => emptyView(ref, spec, status)),
      };
    }
    const names = new Set(defined.map((d) => d.spec.name));
    return {
      ...base,
      namespaces: [
        ...defined.map(({ spec, status }) => this.view(ref, spec, status, cluster)),
        ...cluster.managed
          .filter((n) => !names.has(n.name))
          .map(({ name, terminating }): ManagedNamespaceView => ({
            name,
            exists: true,
            leftOver: true,
            terminating,
            drift: [],
            quota: [],
            accounts: [],
            tokens: this.tokensOf(name, cluster.secrets),
          })),
      ].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async preview(connection: string, spec: ManagedNamespaceSpec): Promise<AddonPreview> {
    const { blockers, warnings } = await this.check(connection, spec);
    return (await this.addons.planNamespace(connection, spec, blockers, warnings)).preview;
  }

  async apply(
    connection: string,
    spec: ManagedNamespaceSpec,
    takeOver: boolean,
  ): Promise<AddonPreview> {
    const { blockers, warnings } = await this.check(connection, spec);
    return this.addons.applyNamespace(connection, spec, takeOver, blockers, warnings);
  }

  /** FP36-F-04: ends the access; the namespace with its data, quota and isolation stays. */
  async remove(ref: ClusterRef, namespace: string): Promise<void> {
    const { status } = await this.defined(ref, namespace);
    await this.addons.delete(ref.connection, ref.namespace, status.name);
  }

  /** FP36-F-05: only a namespace that no add-on of this cluster defines any more. */
  async deleteNamespace(ref: ClusterRef, namespace: string, confirmName: string): Promise<void> {
    if (confirmName !== namespace) {
      throw new BadRequestException('Type the name of the namespace to confirm the deletion');
    }
    const defined = await this.addons.namespaceAddons(ref.connection, ref.namespace);
    const blocking = defined.find(
      (d) =>
        d.spec.name === namespace &&
        (d.status.matchingClusters.includes(ref.name) ||
          d.status.releases.some((r) => r.cluster === ref.name)),
    );
    if (blocking) {
      throw new ConflictException({
        message: `Namespace ${namespace} is still defined by the add-on ${blocking.status.name}`,
        hint: 'End the access first (remove the add-on) and wait until its release is gone.',
      });
    }
    await this.kube(`Delete namespace ${namespace}`, async () => {
      const access = await this.open(ref);
      if (!(await access.managedNamespaces()).some((n) => n.name === namespace)) {
        throw new NotFoundException(
          `Namespace ${namespace} does not exist in ${ref.name} or is not managed by the app`,
        );
      }
      for (const t of this.tokensOf(namespace, await access.tokenSecrets())) {
        await access.deleteTokenSecret(t.id);
      }
      await access.deleteNamespace(namespace);
      // Cluster-scoped, so it does not go with the namespace.
      await access.deleteTier(`capi-navigator-${namespace}`);
    });
  }

  /** FP36-F-08 to F-10: one token, bound to its own Secret; returned here and never again. */
  async issueToken(
    ref: ClusterRef,
    namespace: string,
    account: string,
    req: { lifetimeSeconds: number; format: 'token' | 'kubeconfig' },
    creator: string,
  ): Promise<NamespaceTokenResponse> {
    const { spec } = await this.defined(ref, namespace);
    if (!spec.accounts.some((a) => a.name === account)) {
      throw new NotFoundException(`Account ${account} of namespace ${namespace} not found`);
    }
    const serviceAccount = namespaceAccountName(namespace, account);
    return this.kube(`Issue a token for ${serviceAccount}`, async () => {
      const access = await this.open(ref);
      for (const t of this.tokensOf(namespace, await access.tokenSecrets())) {
        if (t.expired) await access.deleteTokenSecret(t.id);
      }
      const secret = await access.createTokenSecret({
        metadata: {
          name: `token-${randomBytes(6).toString('hex')}`,
          namespace: ACCOUNTS_NAMESPACE,
          labels: {
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
            [MANAGED_NAMESPACE_LABEL]: namespace,
            [TOKEN_LABEL]: 'true',
          },
          annotations: {
            [TOKEN_ACCOUNT_ANNOTATION]: account,
            [TOKEN_CREATOR_ANNOTATION]: creator,
            [TOKEN_EXPIRY_ANNOTATION]: new Date(
              this.now() + req.lifetimeSeconds * 1000,
            ).toISOString(),
          },
        },
        type: 'Opaque',
      });
      const id = secret.metadata!.name!;
      try {
        const { token, expiresAt } = await access.issueToken(
          serviceAccount,
          { name: id, uid: secret.metadata!.uid! },
          req.lifetimeSeconds,
        );
        const kubeconfig = req.format === 'kubeconfig';
        return {
          id,
          format: req.format,
          content: kubeconfig
            ? namespaceKubeconfig({
                cluster: ref.name,
                server: access.server,
                ...(access.caData ? { caData: access.caData } : {}),
                namespace,
                account: serviceAccount,
                token,
              })
            : token,
          expiresAt,
          fileName: `${ref.name}-${namespace}-${account}.${kubeconfig ? 'kubeconfig' : 'token'}`,
        };
      } catch (err) {
        await access.deleteTokenSecret(id).catch(() => undefined);
        throw err;
      }
    });
  }

  /** FP36-F-09: the API server refuses the token within seconds. */
  async revokeToken(ref: ClusterRef, namespace: string, id: string): Promise<void> {
    await this.kube(`Revoke token ${id}`, async () => {
      const access = await this.open(ref);
      // Only Secrets the app created for tokens of this namespace.
      if (!this.tokensOf(namespace, await access.tokenSecrets()).some((t) => t.id === id)) {
        throw new NotFoundException(`Token ${id} of namespace ${namespace} not found`);
      }
      await access.deleteTokenSecret(id);
    });
  }

  /** FP36-F-03a, F-13, F-14 and overlapping definitions, for every matching cluster. */
  private async check(
    connection: string,
    spec: ManagedNamespaceSpec,
  ): Promise<{ blockers: string[]; warnings: string[] }> {
    const blockers: string[] = [];
    const warnings: string[] = [];
    for (const other of await this.addons.namespaceAddons(connection, spec.namespace)) {
      if (
        other.spec.name === spec.name &&
        other.status.name !== namespaceAddonName(spec) &&
        selectorsCanOverlap(other.spec.clusterSelector, spec.clusterSelector)
      ) {
        blockers.push(
          `Namespace ${spec.name} is already defined by ${other.status.name}, whose selector can match the same clusters`,
        );
      }
    }
    const clusters = await this.addons.matching(connection, spec.namespace, spec.clusterSelector);
    await Promise.all(
      clusters.map(async (name) => {
        const unsupported = await this.unsupported(connection, spec.namespace, name);
        if (unsupported) {
          blockers.push(`Cluster ${name}: ${unsupported}`);
          return;
        }
        try {
          const ref = { connection, namespace: spec.namespace, name };
          await withTimeout(
            (async () => {
              const access = await this.open(ref);
              const existing = await access.namespace(spec.name);
              if (existing?.terminating) {
                blockers.push(
                  `Cluster ${name}: namespace ${spec.name} is being deleted; wait until it is gone`,
                );
              } else if (existing && existing.labels[MANAGED_NAMESPACE_LABEL] !== spec.name) {
                blockers.push(
                  `Cluster ${name}: namespace ${spec.name} already exists and is not managed by the app`,
                );
              }
              if (!(await access.hasCalico())) {
                blockers.push(
                  `Cluster ${name}: the Calico resources for the network isolation are missing`,
                );
              }
            })(),
            READ_TIMEOUT_MS,
          );
        } catch (err) {
          warnings.push(
            `Cluster ${name} could not be checked (${err instanceof Error ? err.message : String(err)}); the release waits until it can be reached.`,
          );
        }
      }),
    );
    return { blockers: blockers.sort(), warnings: warnings.sort() };
  }

  /** Why a cluster cannot have managed namespaces, if so. */
  private async unsupported(
    connection: string,
    namespace: string,
    name: string,
  ): Promise<string | undefined> {
    let spec;
    try {
      spec = await this.clusters.storedSpec(connection, namespace, name);
    } catch (err) {
      // Not created by the app: its CNI is unknown.
      if (err instanceof ConflictException) return err.message;
      throw err;
    }
    if (spec.blueprint) {
      return `The cluster was created from the blueprint ${spec.blueprint} and stays bound to it`;
    }
    return namespacesUnsupported(spec.kubernetes);
  }

  private async defined(ref: ClusterRef, namespace: string) {
    const found = (await this.addons.namespaceAddons(ref.connection, ref.namespace)).find(
      (d) => d.spec.name === namespace && d.status.matchingClusters.includes(ref.name),
    );
    if (!found) {
      throw new NotFoundException(`Managed namespace ${namespace} of ${ref.name} not found`);
    }
    return found;
  }

  private async open(ref: ClusterRef): Promise<WorkloadAccess> {
    return this.access(await this.clusters.kubeconfig(ref.connection, ref.namespace, ref.name));
  }

  private async read(ref: ClusterRef, specs: ManagedNamespaceSpec[]): Promise<ClusterState> {
    const access = await this.open(ref);
    const [live, managed, secrets] = await Promise.all([
      access.live(specs.flatMap(managedNamespaceObjects)),
      access.managedNamespaces(),
      access.tokenSecrets(),
    ]);
    return { live, managed, secrets };
  }

  private view(
    ref: ClusterRef,
    spec: ManagedNamespaceSpec,
    status: AddonStatus,
    cluster: ClusterState,
  ): ManagedNamespaceView {
    const expected = managedNamespaceObjects(spec);
    const managed = cluster.managed.find((n) => n.name === spec.name);
    const addon = addonOf(ref, status);
    const quota = cluster.live.get(`ResourceQuota/${spec.name}/capi-navigator`) as
      { status?: { hard?: Record<string, string>; used?: Record<string, string> } } | undefined;
    return {
      name: spec.name,
      spec,
      addon,
      exists: !!managed,
      leftOver: false,
      terminating: !!managed?.terminating,
      // While the release is being installed, missing objects are no drift.
      drift: addon.ready
        ? expected.flatMap((o) => {
            const live = cluster.live.get(objectKey(o));
            const fields = live ? changedFields(o, live) : [];
            return live && !fields.length
              ? []
              : [{ kind: o.kind, name: o.metadata.name, missing: !live, fields }];
          })
        : [],
      quota: Object.entries(quota?.status?.hard ?? {})
        .map(([resource, hard]) => ({
          resource,
          hard,
          used: quota?.status?.used?.[resource] ?? '0',
        }))
        .sort((a, b) => a.resource.localeCompare(b.resource)),
      accounts: spec.accounts.map((a) => ({
        ...a,
        exists: cluster.live.has(
          `ServiceAccount/${ACCOUNTS_NAMESPACE}/${namespaceAccountName(spec.name, a.name)}`,
        ),
      })),
      tokens: this.tokensOf(spec.name, cluster.secrets),
    };
  }

  private tokensOf(namespace: string, secrets: V1Secret[]): NamespaceToken[] {
    return secrets
      .filter(
        (s) =>
          s.metadata?.labels?.[TOKEN_LABEL] === 'true' &&
          s.metadata.labels[MANAGED_NAMESPACE_LABEL] === namespace,
      )
      .map((s): NamespaceToken => {
        const a = s.metadata?.annotations ?? {};
        const expiresAt = a[TOKEN_EXPIRY_ANNOTATION];
        const created = s.metadata?.creationTimestamp;
        return {
          id: s.metadata!.name!,
          account: a[TOKEN_ACCOUNT_ANNOTATION] ?? '',
          ...(a[TOKEN_CREATOR_ANNOTATION] ? { createdBy: a[TOKEN_CREATOR_ANNOTATION] } : {}),
          ...(created ? { createdAt: new Date(created).toISOString() } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          expired: !!expiresAt && Date.parse(expiresAt) <= this.now(),
        };
      })
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  private async kube<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw toHttpException(err, context);
    }
  }
}

interface ClusterState {
  live: Map<string, KubernetesObject>;
  managed: { name: string; terminating: boolean }[];
  secrets: V1Secret[];
}

function addonOf(ref: ClusterRef, status: AddonStatus) {
  const release = status.releases.find((r) => r.cluster === ref.name);
  const message = release?.ready
    ? undefined
    : (release?.conditions.find((c) => c.status !== 'True' && c.message)?.message ??
      (release ? release.status : 'Waiting for CAAPH to install the release'));
  return { name: status.name, ready: !!release?.ready, ...(message ? { message } : {}) };
}

function emptyView(
  ref: ClusterRef,
  spec: ManagedNamespaceSpec,
  status: AddonStatus,
): ManagedNamespaceView {
  return {
    name: spec.name,
    spec,
    addon: addonOf(ref, status),
    exists: false,
    leftOver: false,
    terminating: false,
    drift: [],
    quota: [],
    accounts: spec.accounts.map((a) => ({ ...a, exists: false })),
    tokens: [],
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the cluster does not answer')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
