<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import {
  ADDON_PRESETS,
  ClusterSpecSchema,
  distributionCatalog,
  type ClusterPreview,
  type ClusterSpecInput,
  type Credential,
  type LookupOption,
} from '@capi-navigator/shared';
import ErrorAlert from '../components/ErrorAlert.vue';
import YamlViewer from '../components/YamlViewer.vue';
import CustomizationEditor from '../components/wizard/CustomizationEditor.vue';
import MachineGroupEditor from '../components/wizard/MachineGroupEditor.vue';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';
import { useCredentialsStore } from '../stores/credentials.js';

/** Cluster wizard (FP-5): eight steps, validated with the shared schema (FP5-F-02). */
const { t } = useI18n();
const router = useRouter();
const connections = useConnectionsStore();
const credentialsStore = useCredentialsStore();
const clusters = useClustersStore();

const step = ref(1);
const rke2 = distributionCatalog('rke2')!;
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
  customization: Custom;
};

const draft = reactive({
  name: '',
  namespace: 'default',
  labels: [] as string[],
  version: rke2.versions.find((v) => v.default)!.version,
  provider: 'openstack' as 'openstack' | 'aws',
  credential: '',
  mode: 'standard' as 'standard' | 'all-in-one',
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
  os: {
    image: '',
    externalNetwork: '',
    nodeCidr: '10.6.0.0/24',
    dns: '1.1.1.1, 8.8.8.8',
    apiLb: true,
    failureDomain: '' as string | null,
    sshKeyName: '' as string | null,
  },
  aws: {
    region: '',
    image: '',
    vpcCidr: '10.0.0.0/16',
    azCount: 1,
    sshKeyName: '' as string | null,
  },
  addons: { ccm: true, csi: true },
  podCidr: '10.42.0.0/16',
  serviceCidr: '10.43.0.0/16',
  sshKeys: '',
  maxSurge: 1,
  maxUnavailable: 0,
  grantNamespace: false,
});

// ---- credentials and selection lists (FP4-F-05, FP4-F-10) ----
const credentials = computed(() =>
  credentialsStore.credentials.filter((c) => c.provider === draft.provider),
);
const credential = computed<Credential | undefined>(() =>
  credentials.value.find((c) => c.name === draft.credential),
);
const lists = reactive<Record<string, LookupOption[]>>({});
const listLoading = ref(false);
const listError = ref<unknown>(null);

onMounted(async () => {
  if (connections.activeName)
    await credentialsStore.load(connections.activeName).catch(() => undefined);
});

async function loadLists(): Promise<void> {
  const c = credential.value;
  if (!c) return;
  listLoading.value = true;
  listError.value = null;
  const region = draft.provider === 'aws' ? draft.aws.region || c.summary.region : undefined;
  const kinds =
    draft.provider === 'openstack'
      ? ['flavors', 'images', 'externalNetworks', 'availabilityZones', 'keyPairs']
      : ['instanceTypes', 'images', 'keyPairs', 'regions'];
  try {
    await Promise.all(
      kinds.map(async (kind) => {
        lists[kind] = (await credentialsStore.lookup(c, kind, region)).options;
      }),
    );
    applyDefaults();
  } catch (err) {
    listError.value = err;
  } finally {
    listLoading.value = false;
  }
}

/** Sensible defaults from the lists: Ubuntu 24.04, the only/first external network. */
function applyDefaults(): void {
  const ubuntu = (lists.images ?? []).find((i) => /ubuntu.*24\.04/i.test(i.label));
  if (draft.provider === 'openstack') {
    if (!draft.os.image && ubuntu) draft.os.image = ubuntu.value;
    const nets = lists.externalNetworks ?? [];
    if (!draft.os.externalNetwork && nets.length > 0) {
      draft.os.externalNetwork = (nets.find((n) => /float/i.test(n.label)) ?? nets[0]!).value;
    }
  } else {
    if (!draft.aws.region && credential.value?.summary.region)
      draft.aws.region = credential.value.summary.region;
    if (!draft.aws.image && ubuntu) draft.aws.image = ubuntu.value;
  }
}

watch(
  () => draft.credential,
  () => {
    for (const k of Object.keys(lists)) delete lists[k];
    draft.os.image = '';
    draft.aws.image = '';
    draft.aws.region = '';
    void loadLists();
  },
);
watch(
  () => draft.provider,
  () => (draft.credential = credentials.value[0]?.name ?? ''),
);
watch(
  () => draft.aws.region,
  (r, old) => {
    if (old && r !== old) {
      draft.aws.image = '';
      void loadLists();
    }
  },
);
watch(
  () => draft.mode,
  (m) => {
    if (m === 'all-in-one') draft.cp.replicas = 1;
  },
);

const sizes = computed(
  () => lists[draft.provider === 'openstack' ? 'flavors' : 'instanceTypes'] ?? [],
);
const images = computed(() => lists.images ?? []);

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
    ...(hasCustom ? { customization: c } : {}),
  };
}
const spec = computed<ClusterSpecInput>(() => ({
  name: draft.name.trim(),
  namespace: draft.namespace.trim(),
  ...(kv(draft.labels) ? { labels: kv(draft.labels) } : {}),
  kubernetes: {
    flavor: 'rke2',
    version: draft.version,
    podCidr: draft.podCidr.trim(),
    serviceCidr: draft.serviceCidr.trim(),
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
  addons: { cloudControllerManager: draft.addons.ccm, csiDriver: draft.addons.csi },
  sshPublicKeys: draft.sshKeys
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean),
  infrastructure:
    draft.provider === 'openstack'
      ? {
          provider: 'openstack',
          credentialRef: draft.credential,
          image: draft.os.image,
          externalNetwork: draft.os.externalNetwork,
          network: {
            nodeCidr: draft.os.nodeCidr.trim(),
            dnsNameservers: draft.os.dns.split(/[\s,]+/).filter(Boolean),
          },
          apiServerLoadBalancer: draft.os.apiLb,
          ...(draft.os.failureDomain ? { failureDomain: draft.os.failureDomain } : {}),
          ...(draft.os.sshKeyName ? { sshKeyName: draft.os.sshKeyName } : {}),
        }
      : {
          provider: 'aws',
          credentialRef: draft.credential,
          region: draft.aws.region,
          image: draft.aws.image,
          network: {
            vpcCidr: draft.aws.vpcCidr.trim(),
            availabilityZoneCount: Number(draft.aws.azCount),
          },
          ...(draft.aws.sshKeyName ? { sshKeyName: draft.aws.sshKeyName } : {}),
        },
}));

// ---- validation per step with the shared schema (FP5-F-02) ----
const STEP_OF: [RegExp, number][] = [
  [/^(name|namespace|labels|kubernetes\.(version|flavor)|infrastructure\.credentialRef)/, 1],
  [/customization/, 5],
  [/^topology/, 2],
  [/^infrastructure/, 3],
  [/^addons/, 4],
  [/^(kubernetes\.(podCidr|serviceCidr)|sshPublicKeys|rollout)/, 6],
];
const issues = computed(() => {
  const r = ClusterSpecSchema.safeParse(spec.value);
  if (r.success) return [];
  return r.error.issues.map((i) => {
    const path = i.path.join('.');
    return { path, message: i.message, step: STEP_OF.find(([re]) => re.test(path))?.[1] ?? 1 };
  });
});
const issuesFor = (s: number) => issues.value.filter((i) => i.step === s);
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
const presets = computed(() => ADDON_PRESETS.filter((p) => p.provider === draft.provider));
const canPreview = computed(() => issues.value.length === 0);
</script>

<template>
  <v-container>
    <h1 class="text-h4 mb-1">{{ t('wizard.title') }}</h1>
    <p class="text-medium-emphasis mb-4">{{ t('wizard.subtitle') }}</p>

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
              v-model="draft.namespace"
              :label="t('wizard.namespace')"
              :hint="t('wizard.namespaceHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              :model-value="'rke2'"
              :items="[
                { title: 'RKE2', value: 'rke2' },
                { title: t('wizard.k0sLater'), value: 'k0s', props: { disabled: true } },
                { title: t('wizard.kubeadmLater'), value: 'kubeadm', props: { disabled: true } },
              ]"
              :label="t('wizard.distribution')"
              :hint="t('wizard.distributionHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="draft.version"
              :items="
                rke2.versions.map((v) => ({
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
              :hint="t('wizard.versionHint')"
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
              <v-btn value="openstack" data-testid="provider-openstack">OpenStack</v-btn>
              <v-btn value="aws" data-testid="provider-aws">AWS</v-btn>
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
        <v-card variant="outlined" class="mt-4 pa-4">
          <div class="d-flex align-center mb-2">
            <div class="text-subtitle-1">{{ t('wizard.controlPlane') }}</div>
            <v-spacer />
            <v-btn-toggle
              v-model="draft.cp.replicas"
              mandatory
              density="compact"
              variant="outlined"
              :disabled="draft.mode === 'all-in-one'"
            >
              <v-btn :value="1">1</v-btn>
              <v-btn :value="3">3</v-btn>
              <v-btn :value="5">5</v-btn>
            </v-btn-toggle>
          </div>
          <div class="text-caption text-medium-emphasis mb-3">{{ t('wizard.cpHint') }}</div>
          <MachineGroupEditor
            v-model="draft.cp"
            :provider="draft.provider"
            :sizes="sizes"
            :images="images"
            :sizes-loading="listLoading"
            role="control-plane"
          />
        </v-card>
        <template v-if="draft.mode === 'standard'">
          <v-card v-for="(pool, i) in draft.pools" :key="i" variant="outlined" class="mt-4 pa-4">
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
              :sizes-loading="listLoading"
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
        <v-row v-if="draft.provider === 'openstack'">
          <v-col cols="12" md="6">
            <v-autocomplete
              v-model="draft.os.image"
              :items="images"
              item-title="label"
              item-value="value"
              :loading="listLoading"
              :label="t('wizard.image')"
              :hint="t('wizard.imageHint')"
              persistent-hint
              data-testid="image"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="draft.os.externalNetwork"
              :items="lists.externalNetworks ?? []"
              item-title="label"
              item-value="value"
              :label="t('wizard.externalNetwork')"
              :hint="t('wizard.externalNetworkHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model="draft.os.nodeCidr"
              :label="t('wizard.nodeCidr')"
              :hint="t('wizard.nodeCidrHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model="draft.os.dns"
              :label="t('wizard.dns')"
              :hint="t('wizard.dnsHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-switch
              v-model="draft.os.apiLb"
              color="primary"
              :label="t('wizard.apiLb')"
              :hint="t('wizard.apiLbHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="draft.os.failureDomain"
              :items="lists.availabilityZones ?? []"
              item-title="label"
              item-value="value"
              clearable
              :label="t('wizard.az')"
              :hint="t('wizard.azHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="draft.os.sshKeyName"
              :items="lists.keyPairs ?? []"
              item-title="label"
              item-value="value"
              clearable
              :label="t('wizard.sshKey')"
              :hint="t('wizard.sshKeyHint')"
              persistent-hint
            />
          </v-col>
        </v-row>
        <v-row v-else>
          <v-col cols="12" md="4">
            <v-autocomplete
              v-model="draft.aws.region"
              :items="lists.regions ?? []"
              item-title="label"
              item-value="value"
              :label="t('wizard.region')"
              :hint="t('wizard.regionHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="8">
            <v-autocomplete
              v-model="draft.aws.image"
              :items="images"
              item-title="label"
              item-value="value"
              :loading="listLoading"
              :label="t('wizard.ami')"
              :hint="t('wizard.amiHint')"
              persistent-hint
              data-testid="image"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model="draft.aws.vpcCidr"
              :label="t('wizard.vpcCidr')"
              :hint="t('wizard.vpcCidrHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-select
              v-model="draft.aws.azCount"
              :items="[1, 2, 3]"
              :label="t('wizard.azCount')"
              :hint="t('wizard.azCountHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-select
              v-model="draft.aws.sshKeyName"
              :items="lists.keyPairs ?? []"
              item-title="label"
              item-value="value"
              clearable
              :label="t('wizard.sshKey')"
              :hint="t('wizard.sshKeyHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12">
            <v-alert type="info" variant="tonal" density="compact">{{
              t('wizard.awsLbInfo')
            }}</v-alert>
          </v-col>
        </v-row>
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
              ><CustomizationEditor v-model="draft.cp.customization"
            /></v-expansion-panel-text>
          </v-expansion-panel>
          <template v-if="draft.mode === 'standard'">
            <v-expansion-panel
              v-for="(pool, i) in draft.pools"
              :key="i"
              :title="t('wizard.poolTitle', { name: pool.name })"
            >
              <v-expansion-panel-text
                ><CustomizationEditor v-model="draft.pools[i]!.customization"
              /></v-expansion-panel-text>
            </v-expansion-panel>
          </template>
        </v-expansion-panels>
      </template>

      <!-- 6 Advanced -->
      <template #[`item.6`]>
        <v-row>
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
          <span class="font-monospace text-caption">{{ i.path }}</span
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
