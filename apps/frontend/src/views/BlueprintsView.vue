<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ClusterListSchema,
  distributionCatalog,
  INFRA_PLUGINS,
  type BlueprintParameters,
  type ClusterBlueprint,
  type ClusterBlueprintSpecInput,
  type ClusterPreview,
  type ClusterSpec,
  type ClusterSummary,
} from '@capi-navigator/shared';
import { api } from '../api/client.js';
import ErrorAlert from '../components/ErrorAlert.vue';
import YamlViewer from '../components/YamlViewer.vue';
import { useBlueprintsStore } from '../stores/blueprints.js';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';

/**
 * Cluster blueprints (FP34-F-11, ADR-0035): a blueprint takes the spec of an existing cluster and
 * offers a few parameters. Clusters are created from it through the API, e.g. by a service broker.
 */
const { t } = useI18n();
const store = useBlueprintsStore();
const clusterStore = useClustersStore();
const connections = useConnectionsStore();
const loadError = ref<unknown>(null);
store.load().catch((err: unknown) => (loadError.value = err));

const headers = computed(() => [
  { title: t('blueprints.name'), key: 'name' },
  { title: t('blueprints.target'), key: 'target', sortable: false },
  { title: t('blueprints.cluster'), key: 'cluster', sortable: false },
  { title: t('blueprints.parameters'), key: 'parameters', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
]);

const parameterSummary = (b: ClusterBlueprint): string => {
  const p = b.spec.parameters;
  const parts = [
    ...p.workerCounts.map((w) => t('blueprints.summaryWorkers', w)),
    ...p.machineSizes.map((m) =>
      t('blueprints.summarySizes', { pool: m.pool, n: m.choices.length }),
    ),
    ...(p.kubernetesVersions
      ? [t('blueprints.summaryVersions', { n: p.kubernetesVersions.length })]
      : []),
  ];
  return parts.join(' · ') || t('blueprints.noParameters');
};

// ---- clusters of a blueprint (expanded row) ----
const expanded = ref<string[]>([]);
const usedBy = ref<Record<string, ClusterSummary[] | 'error'>>({});
watch(expanded, (names) => {
  for (const name of names) {
    if (usedBy.value[name]) continue;
    store
      .clusters(name)
      .then((list) => (usedBy.value[name] = list))
      .catch(() => (usedBy.value[name] = 'error'));
  }
});

// ---- form ----
interface PoolParams {
  name: string;
  size: string;
  replicas: number;
  countOn: boolean;
  min: number;
  max: number;
  sizesOn: boolean;
  sizes: string[];
}
const open = ref(false);
const editing = ref<ClusterBlueprint | null>(null);
const name = ref('');
const displayName = ref('');
const description = ref('');
const connection = ref<string | null>(null);
const sourceCluster = ref<string | null>(null);
const sourceClusters = ref<ClusterSummary[]>([]);
const base = ref<ClusterSpec | null>(null);
const pools = ref<PoolParams[]>([]);
const versionsOn = ref(false);
const versions = ref<string[]>([]);
/** FP34-F-14: address pool for providers where every cluster needs own addresses. */
// A text field with comma-separated ranges: a combobox lost typed ranges without Enter.
const addressPoolText = ref('');
const addressPool = computed(() => addressPoolText.value.split(/[\s,]+/).filter(Boolean));
const needsPool = computed(
  () => !!base.value && !!INFRA_PLUGINS[base.value.infrastructure.provider].addressPool,
);
const formError = ref<unknown>(null);
const preview = ref<ClusterPreview | null>(null);
const previewedFor = ref('');
const busy = ref(false);

const catalogVersions = computed(() =>
  base.value
    ? (distributionCatalog(base.value.kubernetes.flavor)?.versions.map((v) => v.version) ?? [])
    : [],
);

function setBase(spec: ClusterSpec, params?: BlueprintParameters): void {
  base.value = spec;
  pools.value = spec.topology.workerPools.map((p) => {
    const count = params?.workerCounts.find((w) => w.pool === p.name);
    const size = params?.machineSizes.find((m) => m.pool === p.name);
    return {
      name: p.name,
      size: p.machineSize,
      replicas: p.replicas,
      countOn: !!count,
      min: count?.min ?? Math.min(1, p.replicas),
      max: count?.max ?? Math.max(p.replicas, 3),
      sizesOn: !!size,
      sizes: size?.choices ?? [p.machineSize],
    };
  });
  versionsOn.value = !!params?.kubernetesVersions;
  versions.value = params?.kubernetesVersions ?? [spec.kubernetes.version];
}

function openForm(b?: ClusterBlueprint): void {
  editing.value = b ?? null;
  name.value = b?.name ?? '';
  displayName.value = b?.spec.displayName ?? '';
  description.value = b?.spec.description ?? '';
  connection.value = b?.spec.connection ?? connections.activeName;
  sourceCluster.value = null;
  base.value = null;
  pools.value = [];
  addressPoolText.value = (b?.spec.addressPool ?? []).join(', ');
  if (b) setBase(b.spec.cluster, b.spec.parameters);
  formError.value = null;
  preview.value = null;
  open.value = true;
}

// Clusters of the connection that can serve as base: created by the app, not from a blueprint.
watch([open, connection], async ([isOpen, conn]) => {
  sourceClusters.value = [];
  if (!isOpen || !conn || editing.value) return;
  try {
    const list = await api(
      'GET',
      `/api/connections/${encodeURIComponent(conn)}/clusters`,
      ClusterListSchema,
    );
    sourceClusters.value = list.filter((c) => c.managed && !c.blueprint && !c.deletion);
  } catch (err) {
    formError.value = err;
  }
});

async function takeSpec(key: string | null): Promise<void> {
  if (!key || !connection.value) return;
  const [ns, n] = key.split('/') as [string, string];
  formError.value = null;
  try {
    setBase(await clusterStore.getSpec(connection.value, ns, n));
  } catch (err) {
    formError.value = err;
  }
}

const request = computed((): { name: string; spec: ClusterBlueprintSpecInput } | null => {
  if (!base.value || !connection.value) return null;
  return {
    name: name.value.trim(),
    spec: {
      displayName: displayName.value.trim(),
      description: description.value.trim(),
      connection: connection.value,
      cluster: base.value,
      parameters: {
        workerCounts: pools.value
          .filter((p) => p.countOn)
          .map((p) => ({ pool: p.name, min: Number(p.min), max: Number(p.max) })),
        machineSizes: pools.value
          .filter((p) => p.sizesOn)
          .map((p) => ({ pool: p.name, choices: p.sizes })),
        ...(versionsOn.value ? { kubernetesVersions: versions.value } : {}),
      },
      ...(needsPool.value ? { addressPool: addressPool.value } : {}),
    },
  };
});
const requestKey = computed(() => JSON.stringify(request.value));
/** FP34-F-04: saving only after a check of exactly this blueprint without blockers. */
const canSave = computed(
  () =>
    !!preview.value &&
    preview.value.blockers.length === 0 &&
    previewedFor.value === requestKey.value,
);

async function check(): Promise<void> {
  if (!request.value) return;
  busy.value = true;
  formError.value = null;
  preview.value = null;
  try {
    const key = requestKey.value;
    preview.value = await store.preview({
      ...request.value,
      name: editing.value?.name ?? (request.value.name || 'draft'),
    });
    previewedFor.value = key;
  } catch (err) {
    formError.value = err;
  } finally {
    busy.value = false;
  }
}

async function save(): Promise<void> {
  if (!request.value) return;
  busy.value = true;
  formError.value = null;
  try {
    if (editing.value) await store.update(editing.value.name, request.value.spec);
    else await store.create(request.value);
    open.value = false;
  } catch (err) {
    formError.value = err;
  } finally {
    busy.value = false;
  }
}

// ---- delete ----
const deleting = ref<ClusterBlueprint | null>(null);
const deleteError = ref<unknown>(null);
async function confirmDelete(): Promise<void> {
  deleteError.value = null;
  try {
    await store.remove(deleting.value!.name);
    deleting.value = null;
  } catch (err) {
    deleteError.value = err;
  }
}
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <div>
        <h1 class="page-title">{{ t('blueprints.title') }}</h1>
        <p class="text-body-medium text-medium-emphasis mt-1">{{ t('blueprints.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn
        color="primary"
        prepend-icon="mdi-plus"
        data-testid="add-blueprint"
        @click="openForm()"
        >{{ t('blueprints.add') }}</v-btn
      >
    </div>
    <ErrorAlert v-if="loadError" :error="loadError" class="mb-4" />

    <v-data-table
      v-model:expanded="expanded"
      :headers="headers"
      :items="store.blueprints"
      :loading="store.loading"
      item-value="name"
      show-expand
      :no-data-text="t('blueprints.empty')"
      data-testid="blueprints-table"
    >
      <template #[`item.name`]="{ item }">
        <div class="font-weight-medium">{{ item.spec.displayName || item.name }}</div>
        <!-- The name below only when the display name differs from it. -->
        <div
          v-if="item.spec.displayName && item.spec.displayName !== item.name"
          class="text-body-small text-medium-emphasis"
        >
          {{ item.name }}
        </div>
      </template>
      <template #[`item.target`]="{ item }">
        {{ item.spec.connection }} / {{ item.spec.cluster.namespace }}
      </template>
      <template #[`item.cluster`]="{ item }">
        {{ item.spec.cluster.infrastructure.provider }} · {{ item.spec.cluster.kubernetes.flavor }}
        {{ item.spec.cluster.kubernetes.version }}
      </template>
      <template #[`item.parameters`]="{ item }">{{ parameterSummary(item) }}</template>
      <template #[`item.actions`]="{ item }">
        <v-btn
          icon="mdi-pencil"
          variant="text"
          size="small"
          :title="t('common.edit')"
          :data-testid="`edit-blueprint-${item.name}`"
          @click="openForm(item)"
        />
        <v-btn
          icon="mdi-delete-outline"
          variant="text"
          size="small"
          :title="t('common.delete')"
          :data-testid="`delete-blueprint-${item.name}`"
          @click="
            deleting = item;
            deleteError = null;
          "
        />
      </template>
      <template #expanded-row="{ columns, item }">
        <tr>
          <td :colspan="columns.length" class="py-3">
            <p v-if="item.spec.description" class="mb-2">{{ item.spec.description }}</p>
            <div class="text-label-large mb-1">{{ t('blueprints.clusters') }}</div>
            <v-progress-linear v-if="!usedBy[item.name]" indeterminate class="mb-2" />
            <div v-else-if="usedBy[item.name] === 'error'" class="text-error">
              {{ t('blueprints.clustersError') }}
            </div>
            <div
              v-else-if="!(usedBy[item.name] as ClusterSummary[]).length"
              class="text-medium-emphasis"
            >
              {{ t('blueprints.noClusters') }}
            </div>
            <v-chip
              v-for="c in usedBy[item.name] as ClusterSummary[]"
              v-else
              :key="`${c.namespace}/${c.name}`"
              size="small"
              class="mr-1 mb-1"
              :to="`/clusters/${c.namespace}/${c.name}`"
              >{{ c.namespace }}/{{ c.name }}</v-chip
            >
            <div class="text-label-large mt-3 mb-1">{{ t('blueprints.schema') }}</div>
            <p class="text-body-small text-medium-emphasis mb-1">
              {{ t('blueprints.schemaHint') }}
            </p>
            <YamlViewer
              :value="JSON.stringify(item.parametersSchema, null, 2)"
              height="200px"
              :filename="`${item.name}-parameters.json`"
            />
          </td>
        </tr>
      </template>
    </v-data-table>

    <v-dialog v-model="open" max-width="900" scrollable>
      <v-card :title="editing ? t('blueprints.edit', { name: editing.name }) : t('blueprints.add')">
        <v-card-text>
          <v-row dense>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="name"
                :label="t('blueprints.name')"
                :hint="t('blueprints.nameHint')"
                persistent-hint
                :disabled="!!editing"
                data-testid="blueprint-name"
              />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="displayName"
                :label="t('blueprints.displayName')"
                :hint="t('blueprints.displayNameHint')"
                persistent-hint
                data-testid="blueprint-display-name"
              />
            </v-col>
            <v-col cols="12">
              <v-textarea
                v-model="description"
                :label="t('blueprints.description')"
                :hint="t('blueprints.descriptionHint')"
                persistent-hint
                rows="2"
                auto-grow
              />
            </v-col>
          </v-row>

          <template v-if="!editing">
            <div class="text-title-small mt-4 mb-1">{{ t('blueprints.base') }}</div>
            <p class="text-body-small text-medium-emphasis mb-2">{{ t('blueprints.baseHint') }}</p>
            <v-row dense>
              <v-col cols="12" md="6">
                <v-select
                  v-model="connection"
                  :items="connections.connections.map((c) => c.name)"
                  :label="t('blueprints.connection')"
                  data-testid="blueprint-connection"
                />
              </v-col>
              <v-col cols="12" md="6">
                <v-select
                  v-model="sourceCluster"
                  :items="sourceClusters.map((c) => `${c.namespace}/${c.name}`)"
                  :label="t('blueprints.sourceCluster')"
                  :no-data-text="t('blueprints.noSource')"
                  data-testid="blueprint-source"
                  @update:model-value="takeSpec"
                />
              </v-col>
            </v-row>
          </template>

          <template v-if="base">
            <v-alert type="info" variant="tonal" density="compact" class="my-3">{{
              t('blueprints.baseSummary', {
                namespace: base.namespace,
                provider: base.infrastructure.provider,
                flavor: base.kubernetes.flavor,
                version: base.kubernetes.version,
                credential: base.infrastructure.credentialRef,
                example: base.name,
              })
            }}</v-alert>

            <v-text-field
              v-if="needsPool"
              v-model="addressPoolText"
              :label="t('blueprints.addressPool')"
              :hint="
                t('blueprints.addressPoolHint', {
                  cidr:
                    (base.infrastructure as { network?: { nodeCidr?: string } }).network
                      ?.nodeCidr ?? '',
                })
              "
              persistent-hint
              class="mb-4"
              data-testid="blueprint-address-pool"
            />
            <div class="text-title-small mt-2 mb-1">{{ t('blueprints.parameters') }}</div>
            <p class="text-body-small text-medium-emphasis mb-2">
              {{ t('blueprints.parametersHint') }}
            </p>
            <v-card v-for="p in pools" :key="p.name" border class="mb-2">
              <v-card-item
                :title="t('blueprints.pool', { pool: p.name })"
                :subtitle="`${p.replicas} × ${p.size}`"
              />
              <v-card-text>
                <v-switch
                  v-model="p.countOn"
                  :label="t('blueprints.countOn')"
                  color="primary"
                  density="compact"
                  hide-details
                  :data-testid="`blueprint-count-${p.name}`"
                />
                <v-row v-if="p.countOn" dense>
                  <v-col cols="6">
                    <v-text-field
                      v-model.number="p.min"
                      type="number"
                      :label="t('blueprints.min')"
                      :hint="t('blueprints.minHint', { n: p.replicas })"
                      persistent-hint
                    />
                  </v-col>
                  <v-col cols="6">
                    <v-text-field
                      v-model.number="p.max"
                      type="number"
                      :label="t('blueprints.max')"
                      :hint="t('blueprints.maxHint')"
                      persistent-hint
                    />
                  </v-col>
                </v-row>
                <v-switch
                  v-model="p.sizesOn"
                  :label="t('blueprints.sizesOn')"
                  color="primary"
                  density="compact"
                  hide-details
                  class="mt-2"
                />
                <v-combobox
                  v-if="p.sizesOn"
                  v-model="p.sizes"
                  :label="t('blueprints.sizes')"
                  :hint="t('blueprints.sizesHint', { size: p.size })"
                  persistent-hint
                  multiple
                  chips
                  closable-chips
                />
              </v-card-text>
            </v-card>
            <v-card border class="mb-2">
              <v-card-text>
                <v-switch
                  v-model="versionsOn"
                  :label="t('blueprints.versionsOn')"
                  :disabled="!!base.airGapped"
                  :hint="
                    base.airGapped
                      ? t('blueprints.versionsAirGapped')
                      : t('blueprints.versionsHint')
                  "
                  persistent-hint
                  color="primary"
                  density="compact"
                />
                <v-select
                  v-if="versionsOn"
                  v-model="versions"
                  :items="catalogVersions"
                  :label="t('blueprints.versions')"
                  multiple
                  chips
                  closable-chips
                  class="mt-2"
                />
              </v-card-text>
            </v-card>
          </template>

          <ErrorAlert v-if="formError" :error="formError" class="mt-3" />
          <template v-if="preview">
            <v-alert
              v-for="b in preview.blockers"
              :key="b"
              type="error"
              variant="tonal"
              density="compact"
              class="mt-3"
              >{{ b }}</v-alert
            >
            <v-alert
              v-for="w in preview.warnings"
              :key="w"
              type="warning"
              variant="tonal"
              density="compact"
              class="mt-3"
              >{{ w }}</v-alert
            >
            <div class="text-title-small mt-4 mb-1">{{ t('blueprints.previewTitle') }}</div>
            <YamlViewer :value="preview.yaml" height="320px" no-download />
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="open = false">{{ t('common.cancel') }}</v-btn>
          <v-btn
            variant="tonal"
            :disabled="!request || busy"
            :loading="busy && !canSave"
            data-testid="blueprint-check"
            @click="check"
            >{{ t('blueprints.check') }}</v-btn
          >
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!canSave || busy"
            data-testid="blueprint-save"
            @click="save"
            >{{ t('common.save') }}</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="!!deleting" max-width="520" @update:model-value="deleting = null">
      <v-card :title="t('blueprints.deleteTitle', { name: deleting?.name })">
        <v-card-text>
          {{ t('blueprints.deleteText') }}
          <ErrorAlert v-if="deleteError" :error="deleteError" class="mt-3" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleting = null">{{ t('common.cancel') }}</v-btn>
          <v-btn
            color="error"
            variant="flat"
            data-testid="confirm-delete-blueprint"
            @click="confirmDelete"
            >{{ t('common.delete') }}</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
