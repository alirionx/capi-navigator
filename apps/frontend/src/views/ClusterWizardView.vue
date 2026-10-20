<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import {
  ADDON_PRESETS,
  ClusterSpecSchema,
  distributionCatalog,
  FLAVOR_PLUGINS,
  INFRA_PLUGINS,
  infraFromValues,
  MANIFEST_ADDONS,
  initialInfraValues,
  type ClusterPreview,
  type ClusterSpecInput,
  type Credential,
  type Infrastructure,
  type InfraValues,
  type KubernetesFlavor,
  type LookupOption,
} from '@capi-navigator/shared';
import ErrorAlert from '../components/ErrorAlert.vue';
import { stepIssues, visibleIssues } from '../forms/wizard-issues.js';
import YamlViewer from '../components/YamlViewer.vue';
import CustomizationEditor from '../components/wizard/CustomizationEditor.vue';
import MachineGroupEditor from '../components/wizard/MachineGroupEditor.vue';
import InfraFields from '../components/wizard/InfraFields.vue';
import BastionEditor from '../components/BastionEditor.vue';
import { useAuthStore } from '../stores/auth.js';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';
import { useCredentialsStore } from '../stores/credentials.js';

/** Cluster wizard (FP-5): eight steps, validated with the shared schema (FP5-F-02). */
const { t } = useI18n();
const router = useRouter();
const connections = useConnectionsStore();
const credentialsStore = useCredentialsStore();
const clusters = useClustersStore();
const auth = useAuthStore();

const step = ref(1);
const defaultVersion = (flavor: KubernetesFlavor) =>
  distributionCatalog(flavor)!.versions.find((v) => v.default)!.version;
const emptyCustomization = () => ({
  files: [],
  preCommands: [] as string[],
  postCommands: [] as string[],
});
type Custom = {
  files: {
    path: string;
    content?: string;
    contentFromSecret?: { name: string; key: string };
    permissions?: string;
  }[];
  preCommands: string[];
  postCommands: string[];
};
type Group = {
  machineSize: string;
  image?: string;
  rootVolumeSizeGB?: number;
  rootVolumeType?: string;
  customization: Custom;
};

const draft = reactive({
  name: '',
  namespace: 'default',
  labels: [] as string[],
  /** FP9-F-06: RKE2 or k0s, RKE2 by default. */
  flavor: 'rke2' as KubernetesFlavor,
  version: defaultVersion('rke2'),
  /** The first provider of the plugins (OpenStack). */
  provider: Object.keys(INFRA_PLUGINS)[0] as Infrastructure['provider'],
  credential: '',
  mode: 'standard' as 'standard' | 'all-in-one',
  /** FP5-F-19: mirror the control plane root disk to all worker pools. */
  sameRootDisk: false,
  cp: {
    replicas: 1 as 1 | 3 | 5,
    machineSize: '',
    customization: emptyCustomization(),
  } as Group & { replicas: 1 | 3 | 5 },
  pools: [
    {
      name: 'default',
      replicas: 2,
      machineSize: '',
      customization: emptyCustomization(),
      nodeLabels: [] as string[],
    },
  ] as (Group & {
    name: string;
    replicas: number;
    nodeLabels: string[];
  })[],
  /** Infrastructure step per provider, from the plugins' form descriptions (FP25-F-05). */
  infra: Object.fromEntries(
    Object.entries(INFRA_PLUGINS).map(([p, plugin]) => [p, initialInfraValues(plugin.form)]),
  ) as Record<Infrastructure['provider'], InfraValues>,
  /** FP5-F-20: bastion host. */
  bastion: { enabled: false, machineSize: '', allowedCidrs: [] as string[] },
  addons: { ccm: true, csi: true, reboot: false },
  /** FP10-F-04: CNI preset for distributions without one; FP10-F-09: mirrors. */
  cni: true,
  packageRepository: '',
  binaryDownloads: '',
  podCidr: '10.42.0.0/16',
  serviceCidr: '10.43.0.0/16',
  sshKeys: '',
  maxSurge: 1,
  maxUnavailable: 0,
  grantNamespace: false,
});
/** FP19-F-10: users limited to namespaces may only create clusters there. */
const allowedNamespaces = computed(() =>
  connections.activeName ? auth.namespacesFor('clusters.create', connections.activeName) : 'all',
);
watch(
  allowedNamespaces,
  (ns) => {
    if (ns !== 'all' && !ns.includes(draft.namespace)) draft.namespace = ns[0] ?? '';
  },
  { immediate: true },
);

/** Control plane kind of the chosen distribution, for help texts (POS-04). */
const flavorPlugin = computed(() => FLAVOR_PLUGINS[draft.flavor]);
const cpKind = computed(() => FLAVOR_PLUGINS[draft.flavor]?.controlPlaneResource.kind ?? '');
/** ADR-0013: the distribution cannot replace control plane machines later, or only one node. */
const cpReplacementWarning = computed(() => {
  const updates = FLAVOR_PLUGINS[draft.flavor]?.controlPlaneUpdates;
  if (!updates?.replacementBlocked) return '';
  const fixed = updates.replacementFixedIn;
  const reason =
    fixed?.maxReplicas !== undefined && draft.cp.replicas > fixed.maxReplicas
      ? (fixed.multiNodeReason ?? updates.replacementBlocked)
      : updates.replacementBlocked;
  return t('wizard.cpReplacementWarning', { reason });
});
watch(
  () => draft.flavor,
  (f) => (draft.version = defaultVersion(f)),
);

// ---- credentials and selection lists (FP4-F-05, FP4-F-10) ----
const providers = Object.entries(INFRA_PLUGINS).map(([id, p]) => ({
  id: id as Infrastructure['provider'],
  name: p.form.displayName,
}));
const form = computed(() => INFRA_PLUGINS[draft.provider].form);
const infraValues = computed(() => draft.infra[draft.provider]);
const isEmpty = (v: unknown) => v === '' || v === null || v === undefined;
const credentials = computed(() =>
  credentialsStore.credentials.filter((c) => c.provider === draft.provider),
);
const credential = computed<Credential | undefined>(() =>
  credentials.value.find((c) => c.name === draft.credential),
);
const lists = reactive<Record<string, LookupOption[]>>({});
const listLoading = ref(false);
const listError = ref<unknown>(null);

// Load once the active connection is known (also after a direct page load).
watch(
  () => connections.activeName,
  (name) => {
    if (name) void credentialsStore.load(name).catch(() => undefined);
  },
  { immediate: true },
);

/** Only the latest request may fill the lists: answers for another credential are dropped. */
let listRequest = 0;
async function loadLists(): Promise<void> {
  const c = credential.value;
  if (!c) return;
  const request = ++listRequest;
  listLoading.value = true;
  listError.value = null;
  const f = form.value;
  const region = f.regionField
    ? String(infraValues.value[f.regionField] || c.summary.region || '') || undefined
    : undefined;
  try {
    const loaded = await Promise.all(
      f.lookups.map(async ({ kind, optional }) => {
        const options = credentialsStore.lookup(c, kind, region).then((r) => r.options);
        return [kind, optional ? await options.catch(() => []) : await options] as const;
      }),
    );
    if (request !== listRequest) return;
    for (const [kind, options] of loaded) lists[kind] = options;
    applyDefaults();
  } catch (err) {
    if (request === listRequest) listError.value = err;
  } finally {
    if (request === listRequest) listLoading.value = false;
  }
}

/** Defaults from the credential and the lists (e.g. its region, Ubuntu 24.04), as the plugin says. */
function applyDefaults(): void {
  const values = infraValues.value;
  for (const f of form.value.fields) {
    if (!isEmpty(values[f.path])) continue;
    const value =
      (credential.value && f.fromCredential?.(credential.value.summary)) ||
      (f.lookup && f.preselect?.(lists[f.lookup] ?? []));
    if (value) values[f.path] = value;
  }
}

/** Values that come from the credential or its lists start over with another credential. */
function resetCredentialFields(): void {
  for (const f of form.value.fields) {
    if (f.lookup || f.fromCredential) infraValues.value[f.path] = f.default ?? '';
  }
}
watch(
  () => draft.credential,
  () => {
    for (const k of Object.keys(lists)) delete lists[k];
    resetCredentialFields();
    void loadLists();
  },
);
watch(
  () => draft.provider,
  () => (draft.credential = credentials.value[0]?.name ?? ''),
);
// Preselect the first credential once the list has loaded.
watch(credentials, (list) => {
  if (!list.some((c) => c.name === draft.credential)) draft.credential = list[0]?.name ?? '';
});
// A changed region (or similar) empties dependent fields and reloads the lists.
watch(
  () =>
    [
      draft.provider,
      ...form.value.fields.filter((f) => f.resets).map((f) => infraValues.value[f.path]),
    ] as unknown[],
  ([provider, ...now], before) => {
    const [oldProvider, ...old] = before ?? [];
    if (provider !== oldProvider) return;
    const changed = form.value.fields
      .filter((f) => f.resets)
      .filter((_, i) => !isEmpty(old[i]) && now[i] !== old[i]);
    if (changed.length === 0) return;
    for (const f of changed) for (const p of f.resets!) infraValues.value[p] = '';
    void loadLists();
  },
);
watch(
  () => draft.mode,
  (m) => {
    if (m === 'all-in-one') draft.cp.replicas = 1;
  },
);

const sizes = computed(() => lists[form.value.machine.sizeLookup] ?? []);
const images = computed(() => lists.images ?? []);
/** FP5-F-20: a failed credential check that breaks the bastion (OpenStack: Neutron paging). */
const pagingWarning = computed(() => {
  const id = form.value.bastion?.blockingCheck;
  const c = id ? credential.value?.lastTest?.checks.find((x) => x.id === id) : undefined;
  return c && !c.ok ? c.message : undefined;
});
const volumeTypes = computed<LookupOption[]>(() => {
  const types = form.value.machine.rootVolume.types;
  return 'lookup' in types
    ? (lists[types.lookup] ?? [])
    : types.options.map((v) => ({ value: v, label: v }));
});

// FP5-F-19: "same root disk for all groups" mirrors the control plane settings.
watch(
  () => [draft.sameRootDisk, draft.cp.rootVolumeSizeGB, draft.cp.rootVolumeType] as const,
  ([same, size, type]) => {
    if (!same) return;
    for (const p of draft.pools) {
      p.rootVolumeSizeGB = size;
      p.rootVolumeType = type;
    }
  },
);

// ---- spec from the draft ----
function kv(list: string[]): Record<string, string> | undefined {
  const entries = list.map((l) => l.split('=')).filter(([k]) => k);
  return entries.length > 0
    ? Object.fromEntries(entries.map(([k, ...v]) => [k!.trim(), v.join('=').trim()]))
    : undefined;
}
function group(g: Group) {
  const c = g.customization;
  const hasCustom = c.files.length + c.preCommands.length + c.postCommands.length > 0;
  return {
    machineSize: g.machineSize,
    ...(g.image ? { image: g.image } : {}),
    ...(g.rootVolumeSizeGB ? { rootVolumeSizeGB: Number(g.rootVolumeSizeGB) } : {}),
    ...(g.rootVolumeType && (!form.value.machine.rootVolume.typeNeedsSize || g.rootVolumeSizeGB)
      ? { rootVolumeType: g.rootVolumeType }
      : {}),
    ...(hasCustom ? { customization: c } : {}),
  };
}
const spec = computed<ClusterSpecInput>(() => ({
  name: draft.name.trim(),
  namespace: draft.namespace.trim(),
  ...(kv(draft.labels) ? { labels: kv(draft.labels) } : {}),
  kubernetes: {
    flavor: draft.flavor,
    version: draft.version,
    podCidr: draft.podCidr.trim(),
    serviceCidr: draft.serviceCidr.trim(),
    ...(flavorPlugin.value?.installsPackages && draft.packageRepository.trim()
      ? { packageRepository: draft.packageRepository.trim() }
      : {}),
    ...(flavorPlugin.value?.installsPackages && draft.binaryDownloads.trim()
      ? { binaryDownloads: draft.binaryDownloads.trim() }
      : {}),
  },
  topology: {
    mode: draft.mode,
    controlPlane: { ...group(draft.cp), replicas: draft.cp.replicas },
    workerPools:
      draft.mode === 'standard'
        ? draft.pools.map((p) => ({
            ...group(p),
            name: p.name.trim(),
            replicas: Number(p.replicas),
            ...(kv(p.nodeLabels) ? { nodeLabels: kv(p.nodeLabels) } : {}),
          }))
        : [],
  },
  rollout: { maxSurge: Number(draft.maxSurge), maxUnavailable: Number(draft.maxUnavailable) },
  addons: {
    cloudControllerManager: draft.addons.ccm,
    csiDriver: draft.addons.csi,
    ...(draft.addons.reboot ? { rebootDaemon: true } : {}),
    ...(flavorPlugin.value?.needsCni && !draft.cni ? { cni: 'none' as const } : {}),
  },
  sshPublicKeys: draft.sshKeys
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean),
  infrastructure: infraFromValues(
    draft.provider,
    form.value,
    infraValues.value,
    draft.credential,
    draft.bastion,
  ) as ClusterSpecInput['infrastructure'],
}));

// ---- validation per step with the shared schema (FP5-F-02) ----
const issues = computed(() => {
  const r = ClusterSpecSchema.safeParse(spec.value);
  return r.success ? [] : stepIssues(r.error.issues, form.value);
});
/** Steps the user has left once; only their issues are shown (no errors on an empty form). */
const visited = ref(new Set<number>());
watch(step, (_, previous) => {
  visited.value = new Set([...visited.value, previous]);
});
const issuesFor = (s: number) => visibleIssues(issues.value, s, visited.value);
const firstInvalidStep = computed(() => Math.min(...issues.value.map((i) => i.step), 99));

// ---- preview and create (steps 7 and 8) ----
const preview = ref<ClusterPreview | null>(null);
const previewError = ref<unknown>(null);
const busy = ref(false);

async function loadPreview(): Promise<void> {
  if (!connections.activeName) return;
  busy.value = true;
  previewError.value = null;
  preview.value = null;
  try {
    preview.value = await clusters.preview(connections.activeName, {
      spec: spec.value as never,
      grantCredentialNamespace: draft.grantNamespace,
    });
  } catch (err) {
    previewError.value = err;
  } finally {
    busy.value = false;
  }
}
watch(step, (s) => {
  if (s === 7) void loadPreview();
});
watch(
  () => draft.grantNamespace,
  () => step.value === 7 && loadPreview(),
);

async function createCluster(): Promise<void> {
  if (!connections.activeName) return;
  busy.value = true;
  previewError.value = null;
  try {
    const created = await clusters.create(connections.activeName, {
      spec: spec.value as never,
      grantCredentialNamespace: draft.grantNamespace,
    });
    await router.push({
      name: 'cluster',
      params: { namespace: created.namespace, name: created.name },
    });
  } catch (err) {
    previewError.value = err;
  } finally {
    busy.value = false;
  }
}

const steps = computed(() => [
  t('wizard.steps.basics'),
  t('wizard.steps.topology'),
  t('wizard.steps.infrastructure'),
  t('wizard.steps.addons'),
  t('wizard.steps.customization'),
  t('wizard.steps.advanced'),
  t('wizard.steps.preview'),
  t('wizard.steps.create'),
]);
const presets = computed(() => [
  ...ADDON_PRESETS.filter(
    (p) =>
      p.provider === draft.provider ||
      (p.id === 'kured' && draft.addons.reboot) ||
      (p.kind === 'cni' && !!flavorPlugin.value?.needsCni && draft.cni),
  ),
  // FP25-F-08: add-ons delivered as manifest by ClusterResourceSet instead of a chart.
  ...MANIFEST_ADDONS.filter((a) => a.provider === draft.provider).map((a) => ({
    id: a.id,
    displayName: a.displayName,
    chartName: a.file,
    version: a.version,
  })),
]);
const canPreview = computed(() => issues.value.length === 0);
</script>

<template>
  <v-container>
    <h1 class="page-title">{{ t('wizard.title') }}</h1>
    <p class="text-body-2 text-medium-emphasis mt-1 mb-4">{{ t('wizard.subtitle') }}</p>

    <v-alert v-if="!connections.active" type="info" variant="tonal">{{
      t('providers.noConnection')
    }}</v-alert>
    <v-stepper
      v-else
      v-model="step"
      :items="steps"
      hide-actions
      alt-labels
      editable
      data-testid="wizard"
    >
      <!-- 1 Basics -->
      <template #[`item.1`]>
        <v-row>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="draft.name"
              :label="t('wizard.name')"
              :hint="t('wizard.nameHint')"
              persistent-hint
              data-testid="name"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-if="allowedNamespaces === 'all'"
              v-model="draft.namespace"
              :label="t('wizard.namespace')"
              :hint="t('wizard.namespaceHint')"
              persistent-hint
            />
            <v-select
              v-else
              v-model="draft.namespace"
              :items="allowedNamespaces"
              :label="t('wizard.namespace')"
              :hint="t('wizard.namespaceLimited')"
              persistent-hint
              data-testid="namespace-select"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="draft.flavor"
              :items="[
                { title: 'RKE2', value: 'rke2' },
                { title: 'k0s', value: 'k0s' },
                { title: t('wizard.kubeadmExperimental'), value: 'kubeadm' },
              ]"
              data-testid="wizard-flavor"
              :label="t('wizard.distribution')"
              :hint="t('wizard.distributionHint')"
              persistent-hint
            />
            <!-- FP10-F-08: experimental, with its trade-offs before creation -->
            <v-alert
              v-if="flavorPlugin?.experimental"
              type="warning"
              variant="tonal"
              density="compact"
              class="mt-3"
              data-testid="wizard-experimental"
            >
              <div class="font-weight-medium">{{ t('wizard.experimentalTitle') }}</div>
              <div class="text-body-2">{{ t('wizard.kubeadmTradeoffs') }}</div>
            </v-alert>
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="draft.version"
              :items="
                distributionCatalog(draft.flavor)!.versions.map((v) => ({
                  title:
                    v.version +
                    (v.default
                      ? ` (${t('wizard.default')})`
                      : v.untested
                        ? ` (${t('wizard.untested')})`
                        : ''),
                  value: v.version,
                }))
              "
              :label="t('wizard.version')"
              :hint="t('wizard.versionHint', { cp: cpKind })"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-btn-toggle
              v-model="draft.provider"
              mandatory
              color="primary"
              variant="outlined"
              divided
            >
              <v-btn
                v-for="p in providers"
                :key="p.id"
                :value="p.id"
                :data-testid="`provider-${p.id}`"
                >{{ p.name }}</v-btn
              >
            </v-btn-toggle>
            <div class="text-caption text-medium-emphasis mt-1">{{ t('wizard.providerHint') }}</div>
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="draft.credential"
              :items="
                credentials.map((c) => ({
                  title:
                    (c.displayName || c.name) +
                    (c.lastTest?.ok ? '' : ` – ${t('wizard.notTested')}`),
                  value: c.name,
                }))
              "
              :label="t('wizard.credential')"
              :hint="t('wizard.credentialHint')"
              persistent-hint
              :no-data-text="t('wizard.noCredentials')"
              data-testid="credential"
            />
          </v-col>
          <v-col cols="12">
            <v-combobox
              v-model="draft.labels"
              :label="t('wizard.labels')"
              :hint="t('wizard.labelsHint')"
              persistent-hint
              multiple
              chips
              closable-chips
            />
          </v-col>
        </v-row>
        <ErrorAlert v-if="listError" :error="listError" class="mt-3" />
      </template>

      <!-- 2 Topology -->
      <template #[`item.2`]>
        <v-radio-group v-model="draft.mode" inline :hint="t('wizard.modeHint')" persistent-hint>
          <v-radio :label="t('wizard.modeStandard')" value="standard" />
          <v-radio :label="t('wizard.modeAio')" value="all-in-one" data-testid="mode-aio" />
        </v-radio-group>
        <v-card border class="mt-4 pa-4">
          <div class="d-flex align-center mb-2">
            <div class="text-subtitle-1">{{ t('wizard.controlPlane') }}</div>
            <v-spacer />
            <span class="text-body-2 text-medium-emphasis mr-3">{{ t('wizard.cpNodes') }}</span>
            <v-btn-toggle
              v-model="draft.cp.replicas"
              mandatory
              density="compact"
              variant="outlined"
              :disabled="draft.mode === 'all-in-one'"
              :aria-label="t('wizard.cpNodes')"
            >
              <v-btn :value="1">1</v-btn>
              <v-btn :value="3">3</v-btn>
              <v-btn :value="5">5</v-btn>
            </v-btn-toggle>
          </div>
          <div class="text-caption text-medium-emphasis mb-3">
            {{ t('wizard.cpHint', { cp: cpKind }) }}
          </div>
          <v-alert
            v-if="cpReplacementWarning"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-3"
            data-testid="cp-replacement-warning"
            >{{ cpReplacementWarning }}</v-alert
          >
          <MachineGroupEditor
            v-model="draft.cp"
            :provider="draft.provider"
            :sizes="sizes"
            :images="images"
            :volume-types="volumeTypes"
            :sizes-loading="listLoading"
            role="control-plane"
          />
          <v-switch
            v-if="draft.mode === 'standard'"
            v-model="draft.sameRootDisk"
            :label="t('wizard.sameRootDisk')"
            :hint="t('wizard.sameRootDiskHint')"
            persistent-hint
            class="mt-3"
            data-testid="same-root-disk"
          />
        </v-card>
        <template v-if="draft.mode === 'standard'">
          <v-card v-for="(pool, i) in draft.pools" :key="i" border class="mt-4 pa-4">
            <div class="d-flex flex-wrap ga-3 align-start mb-2">
              <v-text-field
                v-model="pool.name"
                :label="t('wizard.poolName')"
                :hint="t('wizard.poolNameHint')"
                persistent-hint
                style="max-width: 220px"
              />
              <v-text-field
                v-model.number="pool.replicas"
                type="number"
                min="0"
                :label="t('wizard.replicas')"
                :hint="t('wizard.replicasHint')"
                persistent-hint
                style="max-width: 160px"
              />
              <v-combobox
                v-model="pool.nodeLabels"
                :label="t('wizard.nodeLabels')"
                :hint="t('wizard.nodeLabelsHint')"
                persistent-hint
                multiple
                chips
                closable-chips
                style="min-width: 240px; flex: 1"
              />
              <v-btn
                icon="mdi-delete"
                variant="text"
                color="error"
                :disabled="draft.pools.length === 1"
                :aria-label="t('common.delete')"
                @click="draft.pools.splice(i, 1)"
              />
            </div>
            <MachineGroupEditor
              v-model="draft.pools[i]!"
              :provider="draft.provider"
              :sizes="sizes"
              :images="images"
              :volume-types="volumeTypes"
              :sizes-loading="listLoading"
              :root-disk-locked="draft.sameRootDisk"
              role="worker"
            />
          </v-card>
          <v-btn
            class="mt-3"
            variant="tonal"
            prepend-icon="mdi-plus"
            @click="
              draft.pools.push({
                name: `pool${draft.pools.length + 1}`,
                replicas: 1,
                machineSize: draft.pools[0]?.machineSize ?? '',
                ...(draft.sameRootDisk
                  ? {
                      rootVolumeSizeGB: draft.cp.rootVolumeSizeGB,
                      rootVolumeType: draft.cp.rootVolumeType,
                    }
                  : {}),
                customization: emptyCustomization(),
                nodeLabels: [],
              })
            "
          >
            {{ t('wizard.addPool') }}
          </v-btn>
        </template>
      </template>

      <!-- 3 Infrastructure -->
      <template #[`item.3`]>
        <InfraFields
          v-model="draft.infra[draft.provider]"
          :form="form"
          :lists="lists"
          :loading="listLoading"
        />
        <v-card v-if="form.bastion" border class="pa-4 mt-4">
          <div class="text-subtitle-1 mb-1">{{ t('bastion.title') }}</div>
          <BastionEditor
            v-model="draft.bastion"
            :provider="draft.provider"
            :sizes="sizes"
            :paging-warning="pagingWarning"
            :has-key-pair="!!form.keyPairField && !isEmpty(infraValues[form.keyPairField])"
          />
        </v-card>
      </template>

      <!-- 4 Add-ons -->
      <template #[`item.4`]>
        <v-switch
          v-model="draft.addons.ccm"
          color="primary"
          :label="t('wizard.ccm')"
          :hint="t('wizard.ccmHint')"
          persistent-hint
        />
        <v-switch
          v-model="draft.addons.csi"
          color="primary"
          :label="t('wizard.csi')"
          :hint="t('wizard.csiHint')"
          persistent-hint
          class="mt-2"
        />
        <v-switch
          v-if="flavorPlugin?.needsCni"
          v-model="draft.cni"
          color="primary"
          :label="t('wizard.cni')"
          :hint="t('wizard.cniHint')"
          persistent-hint
          class="mt-2"
          data-testid="wizard-cni"
        />
        <v-switch
          v-model="draft.addons.reboot"
          color="primary"
          :label="t('wizard.reboot')"
          :hint="t('wizard.rebootHint')"
          persistent-hint
          class="mt-2"
          data-testid="wizard-reboot-daemon"
        />
        <v-table density="compact" class="mt-4">
          <thead>
            <tr>
              <th>{{ t('wizard.addon') }}</th>
              <th>Chart</th>
              <th>{{ t('wizard.chartVersion') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in presets" :key="p.id">
              <td>{{ p.displayName }}</td>
              <td class="font-monospace text-caption">{{ p.chartName }}</td>
              <td>{{ p.version }}</td>
            </tr>
          </tbody>
        </v-table>
        <div class="text-caption text-medium-emphasis mt-2">{{ t('wizard.addonValuesLater') }}</div>
      </template>

      <!-- 5 Node customization -->
      <template #[`item.5`]>
        <v-alert type="warning" variant="tonal" density="compact" class="mb-4">{{
          t('wizard.customWarning')
        }}</v-alert>
        <v-expansion-panels variant="accordion">
          <v-expansion-panel :title="t('wizard.controlPlane')">
            <v-expansion-panel-text
              ><CustomizationEditor v-model="draft.cp.customization" :flavor="draft.flavor"
            /></v-expansion-panel-text>
          </v-expansion-panel>
          <template v-if="draft.mode === 'standard'">
            <v-expansion-panel
              v-for="(pool, i) in draft.pools"
              :key="i"
              :title="t('wizard.poolTitle', { name: pool.name })"
            >
              <v-expansion-panel-text
                ><CustomizationEditor
                  v-model="draft.pools[i]!.customization"
                  :flavor="draft.flavor"
              /></v-expansion-panel-text>
            </v-expansion-panel>
          </template>
        </v-expansion-panels>
      </template>

      <!-- 6 Advanced -->
      <template #[`item.6`]>
        <v-row>
          <template v-if="flavorPlugin?.installsPackages">
            <v-col cols="12" md="6"
              ><v-text-field
                v-model="draft.packageRepository"
                :label="t('wizard.packageRepository')"
                :hint="t('wizard.packageRepositoryHint')"
                persistent-hint
                placeholder="https://pkgs.k8s.io"
            /></v-col>
            <v-col cols="12" md="6"
              ><v-text-field
                v-model="draft.binaryDownloads"
                :label="t('wizard.binaryDownloads')"
                :hint="t('wizard.binaryDownloadsHint')"
                persistent-hint
                placeholder="https://github.com"
            /></v-col>
          </template>
          <v-col cols="12" md="6"
            ><v-text-field
              v-model="draft.podCidr"
              :label="t('wizard.podCidr')"
              :hint="t('wizard.podCidrHint')"
              persistent-hint
          /></v-col>
          <v-col cols="12" md="6"
            ><v-text-field
              v-model="draft.serviceCidr"
              :label="t('wizard.serviceCidr')"
              :hint="t('wizard.serviceCidrHint')"
              persistent-hint
          /></v-col>
          <v-col cols="12"
            ><v-textarea
              v-model="draft.sshKeys"
              :label="t('wizard.sshPublicKeys')"
              :hint="t('wizard.sshPublicKeysHint')"
              persistent-hint
              rows="2"
              auto-grow
              class="font-monospace"
          /></v-col>
          <v-col cols="12" md="6"
            ><v-text-field
              v-model.number="draft.maxSurge"
              type="number"
              min="0"
              :label="t('wizard.maxSurge')"
              :hint="t('wizard.maxSurgeHint')"
              persistent-hint
          /></v-col>
          <v-col cols="12" md="6"
            ><v-text-field
              v-model.number="draft.maxUnavailable"
              type="number"
              min="0"
              :label="t('wizard.maxUnavailable')"
              :hint="t('wizard.maxUnavailableHint')"
              persistent-hint
          /></v-col>
        </v-row>
      </template>

      <!-- 7 Preview -->
      <template #[`item.7`]>
        <v-progress-linear v-if="busy && !preview" indeterminate class="mb-3" />
        <ErrorAlert v-if="previewError" :error="previewError" class="mb-3" />
        <template v-if="preview">
          <v-alert
            v-for="b in preview.blockers"
            :key="b"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-2"
            data-testid="blocker"
            >{{ b }}</v-alert
          >
          <v-checkbox
            v-if="preview.credentialNamespaceMissing"
            v-model="draft.grantNamespace"
            :label="
              t('wizard.grantNamespace', { ns: draft.namespace, credential: draft.credential })
            "
            density="compact"
            data-testid="grant-namespace"
          />
          <v-alert
            v-for="w in preview.warnings"
            :key="w"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-2"
            >{{ w }}</v-alert
          >
          <p class="my-2">{{ t('wizard.previewText', { n: preview.objects.length }) }}</p>
          <YamlViewer
            :value="preview.yaml"
            height="460px"
            :filename="`${draft.name || 'cluster'}.yaml`"
          />
        </template>
      </template>

      <!-- 8 Create -->
      <template #[`item.8`]>
        <v-alert type="info" variant="tonal" class="mb-3">{{
          t('wizard.createText', { name: draft.name, provider: draft.provider })
        }}</v-alert>
        <ErrorAlert v-if="previewError" :error="previewError" class="mb-3" />
        <v-btn
          color="primary"
          size="large"
          :loading="busy"
          :disabled="!preview || preview.blockers.length > 0"
          prepend-icon="mdi-rocket-launch"
          data-testid="create"
          @click="createCluster"
        >
          {{ t('wizard.create') }}
        </v-btn>
      </template>
    </v-stepper>

    <!-- Problems of the current step and navigation -->
    <div v-if="connections.active" class="mt-4">
      <v-alert
        v-if="issuesFor(step).length > 0"
        type="error"
        variant="tonal"
        density="compact"
        class="mb-3"
        data-testid="step-issues"
      >
        <div v-for="i in issuesFor(step)" :key="i.path">
          <template v-if="i.labelKey">{{ t(i.labelKey) }}</template>
          <span v-else class="font-monospace text-caption">{{ i.path }}</span
          >: {{ i.message }}
        </div>
      </v-alert>
      <div class="d-flex">
        <v-btn
          :disabled="step === 1"
          variant="text"
          prepend-icon="mdi-arrow-left"
          @click="step--"
          >{{ t('common.back') }}</v-btn
        >
        <v-spacer />
        <v-btn
          v-if="step < 6"
          color="primary"
          append-icon="mdi-arrow-right"
          data-testid="next"
          @click="step++"
          >{{ t('wizard.next') }}</v-btn
        >
        <v-btn
          v-else-if="step === 6"
          color="primary"
          append-icon="mdi-arrow-right"
          :disabled="!canPreview"
          data-testid="to-preview"
          @click="canPreview ? (step = 7) : (step = firstInvalidStep)"
        >
          {{ t('wizard.toPreview') }}
        </v-btn>
        <v-btn
          v-else-if="step === 7"
          color="primary"
          append-icon="mdi-arrow-right"
          :disabled="!preview || preview.blockers.length > 0"
          data-testid="to-create"
          @click="step = 8"
        >
          {{ t('wizard.next') }}
        </v-btn>
      </div>
      <div v-if="!canPreview && step === 6" class="text-caption text-error mt-2">
        {{ t('wizard.fixFirst', { step: firstInvalidStep }) }}
      </div>
    </div>
  </v-container>
</template>
