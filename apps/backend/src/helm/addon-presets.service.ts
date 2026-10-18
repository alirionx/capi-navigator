import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { CustomObjectsApi, type KubernetesObject } from '@kubernetes/client-node';
import {
  ADDON_PRESETS,
  AddonPresetOverrideSchema,
  buildAddonPreset,
  effectivePreset,
  PRESET_LABEL,
  type AddonPresetOverride,
  type AddonPresetView,
  type AddonPreview,
  type ObjectDiff,
} from '@capi-navigator/shared';
import { stringify } from 'yaml';
import { onlyManagedByApp, presetUpToDate } from '../clusters/clusters.service.js';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { dryRunApply, normalizeForDiff, serverSideApply } from '../kube/apply.js';
import { toHttpException } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';

interface PresetObj {
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    managedFields?: { manager?: string; fieldsV1?: Record<string, unknown> }[];
  };
  spec?: unknown;
  status?: { matchingClusters?: unknown[] };
}

/**
 * CCM/CSI presets (FP8-F-14): defaults from the code, admin overrides (version, values) in a
 * ConfigMap of the home cluster. Overrides reach new namespaces on the next cluster creation;
 * existing namespaces are updated explicitly with a preview (hard rule 6).
 */
@Injectable()
export class AddonPresetsService {
  constructor(
    private readonly store: StoreService,
    private readonly clients: ManagementClusterClients,
  ) {}

  async list(connection: string): Promise<AddonPresetView[]> {
    const overrides = await this.store.addonPresetOverrides();
    const live = await this.livePresets(connection);
    return ADDON_PRESETS.map((p) => {
      const effective = effectivePreset(p, overrides);
      const desired = (ns: string) =>
        buildAddonPreset(effective, ns) as unknown as { spec: unknown };
      return {
        id: p.id,
        provider: p.provider,
        kind: p.kind,
        displayName: p.displayName,
        repoURL: p.repoURL,
        chartName: p.chartName,
        releaseNamespace: p.releaseNamespace,
        defaults: { version: p.version, valuesTemplate: p.valuesTemplate },
        ...(overrides[p.id] ? { override: overrides[p.id] } : {}),
        effective: { version: effective.version, valuesTemplate: effective.valuesTemplate },
        namespaces: live
          .filter((o) => o.metadata.labels?.[PRESET_LABEL] === p.id)
          .map((o) => ({
            namespace: o.metadata.namespace,
            upToDate: presetUpToDate(o, desired(o.metadata.namespace)),
            managedByApp: onlyManagedByApp(o),
            clusters: o.status?.matchingClusters?.length ?? 0,
          }))
          .sort((a, b) => a.namespace.localeCompare(b.namespace)),
      };
    });
  }

  /** Stores (or with `null` removes) the override of one preset. */
  async update(id: string, override: AddonPresetOverride | null): Promise<void> {
    this.preset(id);
    const overrides = await this.store.addonPresetOverrides();
    if (override === null || (!override.version && override.valuesTemplate === undefined)) {
      delete overrides[id];
    } else {
      overrides[id] = AddonPresetOverrideSchema.parse(override);
    }
    await this.store.putAddonPresetOverrides(overrides);
  }

  /** Preview of bringing all namespaces with an older preset up to date. */
  async rolloutPreview(connection: string, id: string): Promise<AddonPreview> {
    return (await this.rolloutPlan(connection, id)).preview;
  }

  async rollout(connection: string, id: string): Promise<AddonPreview> {
    const { preview, objects } = await this.rolloutPlan(connection, id);
    if (objects.length) {
      const kc = await this.clients.forConnection(connection);
      await this.kube('Update presets', () => serverSideApply(kc, objects));
    }
    return preview;
  }

  private async rolloutPlan(connection: string, id: string) {
    const preset = effectivePreset(this.preset(id), await this.store.addonPresetOverrides());
    const kc = await this.clients.forConnection(connection);
    const diffs: ObjectDiff[] = [];
    const warnings: string[] = [];
    const objects: KubernetesObject[] = [];
    for (const live of (await this.livePresets(connection)).filter(
      (o) => o.metadata.labels?.[PRESET_LABEL] === id,
    )) {
      const desired = buildAddonPreset(
        preset,
        live.metadata.namespace,
      ) as unknown as KubernetesObject & { spec: unknown };
      if (presetUpToDate(live, desired)) continue;
      if (!onlyManagedByApp(live)) {
        warnings.push(
          `${live.metadata.namespace}/${live.metadata.name} was changed outside the app and is left as is.`,
        );
        continue;
      }
      const { result } = await this.kube('Compare with the cluster (dry run)', () =>
        dryRunApply(kc, desired),
      );
      objects.push(desired);
      diffs.push({
        kind: 'HelmChartProxy',
        name: live.metadata.name,
        namespace: live.metadata.namespace,
        change: 'update',
        before: stringify(normalizeForDiff(live as unknown as KubernetesObject), { lineWidth: 0 }),
        after: stringify(normalizeForDiff(result), { lineWidth: 0 }),
      });
    }
    if (objects.length) {
      warnings.push('CAAPH upgrades the release on every cluster that uses the preset.');
    }
    return {
      objects,
      preview: { diffs, drift: [], matchingClusters: [], warnings, blockers: [] } as AddonPreview,
    };
  }

  private preset(id: string) {
    const p = ADDON_PRESETS.find((x) => x.id === id);
    if (!p) throw new NotFoundException(`Preset ${id} not found`);
    return p;
  }

  private async livePresets(connection: string): Promise<PresetObj[]> {
    return this.kube('Read presets', async () => {
      const kc = await this.clients.forConnection(connection);
      const res = (await kc.makeApiClient(CustomObjectsApi).listClusterCustomObject({
        group: 'addons.cluster.x-k8s.io',
        version: 'v1alpha1',
        plural: 'helmchartproxies',
        labelSelector: PRESET_LABEL,
      })) as { items: PresetObj[] };
      return res.items;
    });
  }

  private async kube<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException || err instanceof BadRequestException) throw err;
      throw toHttpException(err, context);
    }
  }
}
