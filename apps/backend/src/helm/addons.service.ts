import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CustomObjectsApi, type KubeConfig, type KubernetesObject } from '@kubernetes/client-node';
import {
  addonSpecFromHelmChartProxy,
  buildHelmChartProxy,
  buildRepositorySecretCopy,
  HELM_CHART_PROXY_NAME_LABEL,
  buildManifestHelmChartProxy,
  describeManifestObject,
  checkManifests,
  HELM_REPOSITORY_ANNOTATION,
  isManifestAddon,
  MANAGED_BY_LABEL,
  manifestAddonSpecFromHelmChartProxy,
  manifestObjectKey,
  MANAGED_BY_VALUE,
  matchesSelector,
  PRESET_LABEL,
  selectorsCanOverlap,
  stableStringify,
  type AddonDeletePreview,
  type AddonOverview,
  type AddonPreview,
  type AddonSpec,
  type AddonStatus,
  type CaaphStatus,
  type Condition,
  type Drift,
  type HelmReleaseStatus,
  type ManifestAddonSpec,
  type ObjectDiff,
} from '@capi-navigator/shared';
import { stringify } from 'yaml';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import {
  deleteObjects,
  dryRunApply,
  normalizeForDiff,
  readLive,
  serverSideApply,
} from '../kube/apply.js';
import { toHttpException } from '../kube/errors.js';
import { LiveChannels } from '../kube/live-channels.js';
import { listProviders, providerPhase } from '../operator/providers.js';
import { HelmRepositoriesService } from './helm-repositories.service.js';
import { ManifestChartService } from './manifest-chart.service.js';

const ADDONS = { group: 'addons.cluster.x-k8s.io', version: 'v1alpha1' };
const CAPI = { group: 'cluster.x-k8s.io', version: 'v1beta2' };
const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';

interface Obj {
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
    managedFields?: { manager?: string }[];
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

const conditionsOf = (o: Obj): Condition[] =>
  ((o.status?.conditions as Condition[] | undefined) ?? []).map((c) => ({
    type: c.type,
    status: c.status,
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.message ? { message: c.message } : {}),
    ...(c.lastTransitionTime ? { lastTransitionTime: c.lastTransitionTime } : {}),
  }));
const isReady = (o: Obj) => conditionsOf(o).some((c) => c.type === 'Ready' && c.status === 'True');

/** Pure: overview rows from the listed objects (FP8-F-11). */
export function buildAddonStatuses(hcps: Obj[], hrps: Obj[], clusters: Obj[]): AddonStatus[] {
  return hcps
    .map((h): AddonStatus => {
      const spec = (h.spec ?? {}) as {
        chartName?: string;
        repoURL?: string;
        version?: string;
        releaseName?: string;
        namespace?: string;
        reconcileStrategy?: string;
        clusterSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
      };
      const selector = spec.clusterSelector ?? {};
      const releases = hrps
        .filter(
          (r) =>
            r.metadata.namespace === h.metadata.namespace &&
            r.metadata.labels?.[HELM_CHART_PROXY_NAME_LABEL] === h.metadata.name,
        )
        .map((r): HelmReleaseStatus => {
          const rs = (r.spec ?? {}) as {
            clusterRef?: { name?: string };
            releaseName?: string;
            namespace?: string;
            version?: string;
          };
          return {
            name: r.metadata.name,
            cluster: rs.clusterRef?.name ?? r.metadata.labels?.[CLUSTER_NAME_LABEL] ?? '',
            ...(rs.releaseName ? { releaseName: rs.releaseName } : {}),
            ...(rs.namespace ? { releaseNamespace: rs.namespace } : {}),
            ...(rs.version ? { chartVersion: rs.version } : {}),
            ...(typeof r.status?.revision === 'number' ? { revision: r.status.revision } : {}),
            ...(typeof r.status?.status === 'string' ? { status: r.status.status } : {}),
            ready: isReady(r),
            conditions: conditionsOf(r),
          };
        })
        .sort((a, b) => a.cluster.localeCompare(b.cluster));
      // Matching computed from the cluster labels, so it follows label changes immediately;
      // matchExpressions are left to CAAPH (status.matchingClusters).
      const matching = selector.matchExpressions?.length
        ? ((h.status?.matchingClusters as { name: string }[] | undefined) ?? []).map((c) => c.name)
        : clusters
            .filter(
              (c) =>
                c.metadata.namespace === h.metadata.namespace &&
                matchesSelector(c.metadata.labels ?? {}, selector.matchLabels ?? {}),
            )
            .map((c) => c.metadata.name);
      const manifests = isManifestAddon(h);
      const parsed = manifests ? undefined : addonSpecFromHelmChartProxy(h);
      const manifestSpec = manifests ? manifestAddonSpecFromHelmChartProxy(h) : undefined;
      const presetId = h.metadata.labels?.[PRESET_LABEL];
      const repository = h.metadata.annotations?.[HELM_REPOSITORY_ANNOTATION];
      return {
        name: h.metadata.name,
        namespace: h.metadata.namespace,
        managed: h.metadata.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE,
        type: manifests ? 'manifests' : 'helm',
        ...(presetId ? { presetId } : {}),
        ...(repository ? { repository } : {}),
        ...(parsed && !presetId ? { spec: parsed } : {}),
        ...(manifestSpec ? { manifestSpec } : {}),
        chartName: spec.chartName ?? '',
        repoURL: spec.repoURL ?? '',
        ...(spec.version ? { version: spec.version } : {}),
        ...(spec.releaseName ? { releaseName: spec.releaseName } : {}),
        ...(spec.namespace ? { releaseNamespace: spec.namespace } : {}),
        ...(spec.reconcileStrategy ? { reconcileStrategy: spec.reconcileStrategy } : {}),
        clusterSelector: {
          ...(selector.matchLabels ? { matchLabels: selector.matchLabels } : {}),
          ...(selector.matchExpressions ? { matchExpressions: selector.matchExpressions } : {}),
        },
        matchingClusters: matching.sort(),
        ready: isReady(h),
        conditions: conditionsOf(h),
        releases,
        ...(h.metadata.creationTimestamp ? { createdAt: h.metadata.creationTimestamp } : {}),
      };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

/**
 * Helm add-ons as CAAPH HelmChartProxies (FP-8). The HelmChartProxy is the source of truth;
 * changes go through preview, dry run and server-side apply (hard rule 6); changes made outside
 * the app show up as drift (hard rule 4).
 */
@Injectable()
export class AddonsService implements OnApplicationShutdown {
  readonly live: LiveChannels<AddonOverview>;

  constructor(
    private readonly clients: ManagementClusterClients,
    private readonly repositories: HelmRepositoriesService,
    private readonly manifestChart: ManifestChartService,
  ) {
    this.live = new LiveChannels('addons', {
      kubeConfig: (connection) => clients.forConnection(connection),
      paths: () => [
        `/apis/${ADDONS.group}/${ADDONS.version}/helmchartproxies`,
        `/apis/${ADDONS.group}/${ADDONS.version}/helmreleaseproxies`,
        `/apis/${CAPI.group}/${CAPI.version}/clusters`,
      ],
      compute: (connection) => this.overview(connection),
    });
  }

  onApplicationShutdown(): void {
    this.live.stopAll();
  }

  /** FP8-F-01: CAAPH installed and ready (AddonProvider via FP-3). */
  async caaph(kc: KubeConfig): Promise<CaaphStatus> {
    const providers = await listProviders(kc).catch(() => []);
    const helm = providers.find((p) => p.kind === 'AddonProvider' && p.metadata.name === 'helm');
    if (!helm) {
      return {
        installed: false,
        ready: false,
        message:
          'The Helm add-on provider (CAAPH) is not installed. Install it on the Providers page.',
      };
    }
    const phase = providerPhase(helm);
    return {
      installed: true,
      ready: phase === 'Ready',
      ...(helm.status?.installedVersion ? { version: helm.status.installedVersion } : {}),
      ...(phase !== 'Ready' ? { message: `CAAPH is ${phase.toLowerCase()}` } : {}),
    };
  }

  async overview(connection: string): Promise<AddonOverview> {
    return this.kube('Read Helm add-ons', async () => {
      const kc = await this.clients.forConnection(connection);
      const caaph = await this.caaph(kc);
      if (!caaph.installed) return { caaph, addons: [] };
      const custom = kc.makeApiClient(CustomObjectsApi);
      const list = async (g: typeof ADDONS, plural: string) =>
        ((await custom.listClusterCustomObject({ ...g, plural })) as { items: Obj[] }).items;
      const [hcps, hrps, clusters] = await Promise.all([
        list(ADDONS, 'helmchartproxies'),
        list(ADDONS, 'helmreleaseproxies'),
        list(CAPI, 'clusters').catch(() => []),
      ]);
      return { caaph, addons: buildAddonStatuses(hcps, hrps, clusters) };
    });
  }

  /** FP8-F-07: clusters of a namespace the selector matches. */
  async matching(
    connection: string,
    namespace: string,
    selector: Record<string, string>,
  ): Promise<string[]> {
    return this.kube('Read clusters', async () => {
      const kc = await this.clients.forConnection(connection);
      const res = (await kc.makeApiClient(CustomObjectsApi).listNamespacedCustomObject({
        ...CAPI,
        namespace,
        plural: 'clusters',
      })) as { items: Obj[] };
      return res.items
        .filter((c) => matchesSelector(c.metadata.labels ?? {}, selector))
        .map((c) => c.metadata.name)
        .sort();
    });
  }

  /** FP8-F-10: generated objects, dry run, drift and blockers. */
  async preview(connection: string, spec: AddonSpec): Promise<AddonPreview> {
    return (await this.plan(connection, spec)).preview;
  }

  async apply(connection: string, spec: AddonSpec, takeOver: boolean): Promise<AddonPreview> {
    return this.applyPlan(spec, takeOver, await this.plan(connection, spec));
  }

  /** FP30-F-09: preview of a manifest add-on. */
  async previewManifests(connection: string, spec: ManifestAddonSpec): Promise<AddonPreview> {
    return (await this.planManifests(connection, spec)).preview;
  }

  async applyManifests(
    connection: string,
    spec: ManifestAddonSpec,
    takeOver: boolean,
  ): Promise<AddonPreview> {
    return this.applyPlan(spec, takeOver, await this.planManifests(connection, spec));
  }

  private async applyPlan(
    spec: { name: string },
    takeOver: boolean,
    { preview, kc, changed }: Awaited<ReturnType<AddonsService['compare']>>,
  ): Promise<AddonPreview> {
    if (preview.blockers.length) {
      throw new BadRequestException({
        message: preview.blockers[0],
        hint: preview.blockers.join(' '),
      });
    }
    if (preview.drift.some((d) => d.blocking) && !takeOver) {
      throw new ConflictException({
        message: 'The add-on was changed outside the app',
        hint: 'Review the drift in the preview and confirm taking the fields over.',
      });
    }
    await this.kube(`Apply add-on ${spec.name}`, () =>
      serverSideApply(kc, changed, { force: takeOver }),
    );
    return preview;
  }

  /** FP8-F-13: which releases a deletion uninstalls. */
  async deletePreview(
    connection: string,
    namespace: string,
    name: string,
  ): Promise<AddonDeletePreview> {
    const { hcp, status } = await this.existing(connection, namespace, name);
    const installOnce = status.reconcileStrategy === 'InstallOnce';
    const warnings = installOnce
      ? [
          'Reconcile strategy InstallOnce: CAAPH removes the HelmReleaseProxies but leaves the Helm releases installed on the clusters.',
        ]
      : status.releases.length
        ? [
            status.type === 'manifests'
              ? `The objects of the add-on are deleted from all ${status.releases.length} matching cluster(s) (FP30-F-09).`
              : `The Helm release is uninstalled from all ${status.releases.length} matching cluster(s).`,
          ]
        : [];
    return {
      releases: status.releases.map((r) => ({
        cluster: r.cluster,
        ...(r.releaseName ? { releaseName: r.releaseName } : {}),
      })),
      uninstalls: !installOnce,
      warnings,
      yaml: stringify(normalizeForDiff(hcp as unknown as KubernetesObject), { lineWidth: 0 }),
    };
  }

  async delete(connection: string, namespace: string, name: string): Promise<void> {
    const { kc, status } = await this.existing(connection, namespace, name);
    await this.kube(`Delete add-on ${name}`, async () => {
      await deleteObjects(kc, [
        {
          apiVersion: `${ADDONS.group}/${ADDONS.version}`,
          kind: 'HelmChartProxy',
          metadata: { name, namespace },
        },
      ]);
      // The Secret copy goes when no other add-on of the namespace uses the repository.
      if (status.repository) {
        const others = (await this.overview(connection)).addons.filter(
          (a) => a.namespace === namespace && a.name !== name && a.repository === status.repository,
        );
        if (!others.length) {
          const copy = buildRepositorySecretCopy(status.repository, namespace, {});
          await deleteObjects(kc, [copy as KubernetesObject]);
        }
      }
    });
  }

  private async existing(connection: string, namespace: string, name: string) {
    const kc = await this.clients.forConnection(connection);
    const hcp = (await this.kube('Read add-on', () =>
      readLive(kc, {
        apiVersion: `${ADDONS.group}/${ADDONS.version}`,
        kind: 'HelmChartProxy',
        metadata: { name, namespace },
      }),
    )) as unknown as Obj | undefined;
    if (!hcp) throw new NotFoundException(`Add-on ${namespace}/${name} not found`);
    if (hcp.metadata.labels?.[PRESET_LABEL]) {
      throw new BadRequestException({
        message: `${name} is a CCM/CSI preset`,
        hint: 'Presets are managed on the add-on presets page; removing them breaks the clusters that use them.',
      });
    }
    const status = (await this.overview(connection)).addons.find(
      (a) => a.namespace === namespace && a.name === name,
    )!;
    return { kc, hcp, status };
  }

  private async plan(connection: string, spec: AddonSpec) {
    const kc = await this.clients.forConnection(connection);
    const objects: KubernetesObject[] = [];
    const copyData = await this.repositories.copyData(spec.repository);
    if (copyData) {
      objects.push(
        buildRepositorySecretCopy(spec.repository, spec.namespace, copyData) as KubernetesObject,
      );
    }
    objects.push(buildHelmChartProxy(spec, this.repositories.ref(spec.repository)));
    return this.compare(connection, kc, spec, objects, 'helm', [], []);
  }

  /** FP30-F-02 to F-09: chart source, overlaps with other manifest add-ons, then as above. */
  private async planManifests(connection: string, spec: ManifestAddonSpec) {
    const kc = await this.clients.forConnection(connection);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const { source, status } = await this.manifestChart.source(connection);
    if (!source) {
      const message = status.message ?? 'The manifest chart is not available';
      blockers.push(status.hint ? `${message}. ${status.hint}` : message);
    }
    const objects: KubernetesObject[] = [];
    if (source?.repository) {
      const copyData = await this.repositories.copyData(source.repository.name);
      if (copyData) {
        objects.push(
          buildRepositorySecretCopy(
            source.repository.name,
            spec.namespace,
            copyData,
          ) as KubernetesObject,
        );
      }
    }
    // Without a source the preview still shows the object, with the version left open.
    objects.push(buildManifestHelmChartProxy(spec, source ?? { version: status.version ?? '' }));
    warnings.push(...(await this.overlaps(connection, spec)));
    return this.compare(connection, kc, spec, objects, 'manifests', blockers, warnings);
  }

  /** FP30-F-08: objects that another manifest add-on may already install on the same cluster. */
  private async overlaps(connection: string, spec: ManifestAddonSpec): Promise<string[]> {
    const mine = new Map(
      checkManifests(spec.manifests).objects.map((o) => [manifestObjectKey(o), o]),
    );
    const out: string[] = [];
    for (const other of (await this.overview(connection)).addons) {
      const s = other.manifestSpec;
      if (!s || s.namespace !== spec.namespace || s.name === spec.name) continue;
      if (!selectorsCanOverlap(s.clusterSelector, spec.clusterSelector)) continue;
      const shared = checkManifests(s.manifests)
        .objects.filter((o) => mine.has(manifestObjectKey(o)))
        .map(describeManifestObject);
      if (shared.length) {
        out.push(
          `${shared.join(', ')} ${shared.length > 1 ? 'are' : 'is'} also part of the manifest add-on ${s.name}, whose selector can match the same clusters; Helm refuses to install an object owned by another release.`,
        );
      }
    }
    return out;
  }

  private async compare(
    connection: string,
    kc: KubeConfig,
    spec: Pick<AddonSpec, 'name' | 'namespace' | 'reconcileStrategy' | 'clusterSelector'>,
    objects: KubernetesObject[],
    type: 'helm' | 'manifests',
    blockers: string[],
    warnings: string[],
  ) {
    const caaph = await this.caaph(kc);
    if (!caaph.ready) blockers.unshift(caaph.message ?? 'CAAPH is not ready');
    const hcp = objects[objects.length - 1]!;

    const diffs: ObjectDiff[] = [];
    const drift: Drift[] = [];
    const changed: KubernetesObject[] = [];
    await this.kube('Compare with the cluster (dry run)', async () => {
      const live = (await readLive(kc, hcp)) as unknown as Obj | undefined;
      if (live) {
        if (live.metadata.labels?.[PRESET_LABEL]) {
          blockers.push(`${spec.name} is a CCM/CSI preset; edit it on the add-on presets page`);
        } else if (live.metadata.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) {
          blockers.push(
            `A HelmChartProxy ${spec.namespace}/${spec.name} exists that was not created by the app; choose another name`,
          );
        } else if (isManifestAddon(live) !== (type === 'manifests')) {
          blockers.push(
            `${spec.name} is a ${type === 'manifests' ? 'Helm' : 'manifest'} add-on; choose another name`,
          );
        }
        const liveStrategy = (live.spec?.reconcileStrategy as string | undefined) || 'Continuous';
        if (liveStrategy !== spec.reconcileStrategy) {
          blockers.push(
            `The reconcile strategy cannot be changed (CAAPH: immutable); delete and recreate the add-on instead`,
          );
        }
        if (liveStrategy === 'InstallOnce') {
          warnings.push(
            'InstallOnce: CAAPH does not update releases that are already installed; changes apply to newly matching clusters only.',
          );
        }
      }
      if (blockers.length) return;
      for (const obj of objects) {
        const current = await readLive(kc, obj);
        const { result, conflict } = await dryRunApply(kc, obj);
        const before = current ? normalizeForDiff(current) : undefined;
        const after = normalizeForDiff(result);
        const differs = !before || stableStringify(before) !== stableStringify(after);
        const ref = { kind: obj.kind ?? '', name: obj.metadata?.name ?? '' };
        if (conflict) drift.push({ ...ref, ...conflict, blocking: differs });
        if (!differs) continue;
        changed.push(obj);
        diffs.push({
          ...ref,
          namespace: spec.namespace,
          change: current ? 'update' : 'create',
          before: before ? stringify(before, { lineWidth: 0 }) : '',
          after: stringify(after, { lineWidth: 0 }),
        });
      }
    });
    const matchingClusters = blockers.length
      ? []
      : await this.matching(connection, spec.namespace, spec.clusterSelector);
    if (!blockers.length && !matchingClusters.length) {
      warnings.push(
        `No cluster in namespace ${spec.namespace} has the selected labels yet; the release is installed once a cluster gets them.`,
      );
    }
    return {
      kc,
      changed,
      preview: { diffs, drift, matchingClusters, warnings, blockers } satisfies AddonPreview,
    };
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
