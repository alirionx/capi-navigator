<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  AddonSpecSchema,
  VALUES_TEMPLATE_EXAMPLE,
  type AddonPreview,
  type AddonSpec,
  type AddonSpecInput,
  type ChartSummary,
  type ChartVersion,
} from '@capi-navigator/shared';
import ChangeDialog from '../ChangeDialog.vue';
import ErrorAlert from '../ErrorAlert.vue';
import YamlViewer from '../YamlViewer.vue';
import ClusterSelectorField from './ClusterSelectorField.vue';
import ValuesEditor from './ValuesEditor.vue';
import { selectorLabels as labelsOf, selectorRows, type SelectorRow } from './selector.js';
import { useAddonsStore } from '../../stores/addons.js';
import { useHelmRepositoriesStore } from '../../stores/helm-repositories.js';
import FieldHelp from '../FieldHelp.vue';

/**
 * Create or edit a Helm add-on (FP8-F-05 to F-10): the form maps 1:1 onto a CAAPH
 * HelmChartProxy; preview and dry run before apply (hard rule 6).
 */
const props = defineProps<{
  connection: string;
  /** Existing add-on to edit; name, namespace and strategy are then fixed. */
  initial?: AddonSpec;
  /** Namespaces with workload clusters, offered for new add-ons. */
  namespaces: string[];
  /** Preset selector for "assign" flows, e.g. from a cluster's labels. */
  presetNamespace?: string;
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ applied: [] }>();
const { t } = useI18n();
const addons = useAddonsStore();
const repos = useHelmRepositoriesStore();

const editing = computed(() => !!props.initial);
const name = ref('');
const namespace = ref('');
const repository = ref<string | null>(null);
const chartName = ref('');
const version = ref('');
const releaseName = ref('');
const releaseNamespace = ref('default');
const valuesTemplate = ref('');
const selector = ref<SelectorRow[]>([]);
const reconcileStrategy = ref<'Continuous' | 'InstallOnce'>('Continuous');
const wait = ref(true);
const timeout = ref('10m0s');
const createNamespace = ref(true);

watch(
  open,
  (o) => {
    if (!o) return;
    const i = props.initial;
    name.value = i?.name ?? '';
    namespace.value = i?.namespace ?? props.presetNamespace ?? props.namespaces[0] ?? '';
    repository.value = i?.repository ?? repos.repositories[0]?.name ?? null;
    chartName.value = i?.chartName ?? '';
    version.value = i?.version ?? '';
    releaseName.value = i?.releaseName ?? '';
    releaseNamespace.value = i?.releaseNamespace ?? 'default';
    valuesTemplate.value = i?.valuesTemplate ?? '';
    selector.value = selectorRows(i?.clusterSelector);
    reconcileStrategy.value = i?.reconcileStrategy ?? 'Continuous';
    wait.value = i?.options.wait ?? true;
    timeout.value = i?.options.timeout ?? '10m0s';
    createNamespace.value = i?.options.createNamespace ?? true;
    defaults.value = null;
    if (!repos.repositories.length) void repos.load();
  },
  { immediate: true },
);

const repo = computed(() => repos.repositories.find((r) => r.name === repository.value));

// ---- chart browser (FP8-F-04) ----
const charts = ref<ChartSummary[]>([]);
const versions = ref<ChartVersion[]>([]);
const browseError = ref<unknown>(null);
const loadingCharts = ref(false);
const loadingVersions = ref(false);
watch(
  [repository, open],
  async ([r, o]) => {
    charts.value = [];
    browseError.value = null;
    if (!o || !r || repo.value?.type !== 'http') return;
    loadingCharts.value = true;
    try {
      charts.value = await repos.charts(r);
    } catch (err) {
      browseError.value = err;
    } finally {
      loadingCharts.value = false;
    }
  },
  { immediate: true },
);
let versionTimer: ReturnType<typeof setTimeout> | undefined;
watch([repository, chartName, open], ([r, c, o]) => {
  versions.value = [];
  clearTimeout(versionTimer);
  if (!o || !r || !c) return;
  versionTimer = setTimeout(async () => {
    loadingVersions.value = true;
    try {
      versions.value = await repos.versions(r, c);
      if (!version.value && versions.value[0]) version.value = versions.value[0].version;
    } catch (err) {
      browseError.value = err;
    } finally {
      loadingVersions.value = false;
    }
  }, 400);
});
const versionItems = computed(() =>
  versions.value.map((v) => ({
    title: v.appVersion ? `${v.version} (app ${v.appVersion})` : v.version,
    value: v.version,
  })),
);

const defaults = ref<string | null>(null);
const loadingDefaults = ref(false);
async function loadDefaults(): Promise<void> {
  if (!repository.value || !chartName.value || !version.value) return;
  loadingDefaults.value = true;
  browseError.value = null;
  try {
    defaults.value = (await repos.values(repository.value, chartName.value, version.value)).values;
  } catch (err) {
    browseError.value = err;
  } finally {
    loadingDefaults.value = false;
  }
}

const selectorLabels = computed(() => labelsOf(selector.value));

const spec = (): AddonSpecInput => ({
  name: name.value.trim(),
  namespace: namespace.value.trim(),
  repository: repository.value ?? '',
  chartName: chartName.value.trim(),
  version: version.value.trim(),
  ...(releaseName.value.trim() ? { releaseName: releaseName.value.trim() } : {}),
  releaseNamespace: releaseNamespace.value.trim() || 'default',
  valuesTemplate: valuesTemplate.value,
  clusterSelector: selectorLabels.value,
  reconcileStrategy: reconcileStrategy.value,
  options: {
    wait: wait.value,
    timeout: timeout.value.trim(),
    createNamespace: createNamespace.value,
  },
});
const parsed = computed(() => AddonSpecSchema.safeParse(spec()));
const fieldError = (path: string) =>
  parsed.value.success
    ? []
    : parsed.value.error.issues
        .filter((i) => i.path.join('.') === path)
        .map((i) => i.message)
        .slice(0, 1);

const lastPreview = ref<AddonPreview | null>(null);
async function preview() {
  lastPreview.value = await addons.preview(props.connection, spec());
  return lastPreview.value;
}
const apply = (takeOver: boolean) => addons.apply(props.connection, spec(), takeOver);

const hcpField = (field: string) => t('addons.mapsTo', { field });
</script>

<template>
  <ChangeDialog
    v-model="open"
    :title="editing ? t('addons.editTitle', { name: initial!.name }) : t('addons.newTitle')"
    :valid="parsed.success"
    :preview="preview"
    :apply="apply"
    :form-width="1000"
    @applied="emit('applied')"
  >
    <v-row density="compact">
      <v-col cols="12" md="5">
        <v-text-field
          v-model="name"
          :label="t('addons.name')"
          :disabled="editing"
          :error-messages="name ? fieldError('name') : []"
          data-testid="addon-name"
        >
          <template #append-inner>
            <FieldHelp :text="`${t('addons.nameHint')} ${hcpField('metadata.name')}`" />
          </template>
        </v-text-field>
        <v-combobox
          v-model="namespace"
          :items="namespaces"
          :label="t('addons.namespace')"
          :disabled="editing"
          data-testid="addon-namespace"
        >
          <template #append-inner>
            <FieldHelp :text="`${t('addons.namespaceHint')} ${hcpField('metadata.namespace')}`" />
          </template>
        </v-combobox>
        <v-select
          v-model="repository"
          :items="repos.repositories"
          item-title="name"
          item-value="name"
          :label="t('addons.repository')"
          data-testid="addon-repository"
        >
          <template #append-inner>
            <FieldHelp
              :text="repo ? `${repo.url} ${hcpField('spec.repoURL')}` : t('addons.noRepositories')"
            />
          </template>
          <template #item="{ props: p, internalItem: item }">
            <v-list-item v-bind="p" :subtitle="item.raw.url" />
          </template>
        </v-select>
        <v-autocomplete
          v-if="repo?.type === 'http'"
          v-model="chartName"
          :items="charts"
          item-title="name"
          item-value="name"
          :loading="loadingCharts"
          :label="t('addons.chart')"
          data-testid="addon-chart"
        >
          <template #append-inner>
            <FieldHelp :text="hcpField('spec.chartName')" />
          </template>
          <template #item="{ props: p, internalItem: item }">
            <v-list-item
              v-bind="p"
              :subtitle="[item.raw.latestVersion, item.raw.description].filter(Boolean).join(' · ')"
            />
          </template>
        </v-autocomplete>
        <v-text-field
          v-else
          v-model="chartName"
          :label="t('addons.chart')"
          data-testid="addon-chart"
        >
          <template #append-inner>
            <FieldHelp :text="`${t('addons.ociChartHint')} ${hcpField('spec.chartName')}`" />
          </template>
        </v-text-field>
        <v-combobox
          v-model="version"
          :items="versionItems"
          :return-object="false"
          :loading="loadingVersions"
          :label="t('addons.version')"
          data-testid="addon-version"
        >
          <template #append-inner>
            <FieldHelp :text="`${t('addons.versionHint')} ${hcpField('spec.version')}`" />
          </template>
        </v-combobox>
        <v-row density="compact" class="mt-1">
          <v-col cols="6">
            <v-text-field
              v-model="releaseName"
              :label="t('addons.releaseName')"
              :placeholder="chartName"
              :error-messages="releaseName ? fieldError('releaseName') : []"
            >
              <template #append-inner>
                <FieldHelp
                  :text="`${t('addons.releaseNameHint')} ${hcpField('spec.releaseName')}`"
                />
              </template>
            </v-text-field>
          </v-col>
          <v-col cols="6">
            <v-text-field
              v-model="releaseNamespace"
              :label="t('addons.releaseNamespace')"
              :error-messages="fieldError('releaseNamespace')"
              data-testid="addon-release-namespace"
            >
              <template #append-inner>
                <FieldHelp
                  :text="`${t('addons.releaseNamespaceHint')} ${hcpField('spec.namespace')}`"
                />
              </template>
            </v-text-field>
          </v-col>
        </v-row>

        <ClusterSelectorField
          v-model="selector"
          :connection="connection"
          :namespace="namespace"
          :active="open"
        />

        <v-radio-group v-model="reconcileStrategy" :disabled="editing" class="mt-3">
          <template #label>
            {{ t('addons.strategy') }}
            <FieldHelp
              :text="`${t('addons.strategyHint')} ${hcpField('spec.reconcileStrategy')}`"
            />
          </template>
          <v-radio :label="t('addons.continuous')" value="Continuous" />
          <v-radio :label="t('addons.installOnce')" value="InstallOnce" />
        </v-radio-group>
        <v-row density="compact" class="mt-1">
          <v-col cols="6">
            <v-checkbox v-model="wait" :label="t('addons.wait')" hide-details density="compact" />
            <v-checkbox
              v-model="createNamespace"
              :label="t('addons.createNamespace')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6">
            <v-text-field
              v-model="timeout"
              :label="t('addons.timeout')"
              density="compact"
              :error-messages="fieldError('options.timeout')"
            >
              <template #append-inner>
                <FieldHelp :text="hcpField('spec.options.timeout')" />
              </template>
            </v-text-field>
          </v-col>
        </v-row>
      </v-col>

      <v-col cols="12" md="7">
        <div class="d-flex align-center mb-1">
          <div class="text-title-small">
            {{ t('addons.values') }}
            <FieldHelp :text="`${t('addons.valuesHint')} ${hcpField('spec.valuesTemplate')}`" />
          </div>
          <v-spacer />
          <v-btn
            size="small"
            variant="text"
            prepend-icon="mdi-file-document-outline"
            :disabled="!chartName || !version"
            :loading="loadingDefaults"
            data-testid="load-defaults"
            @click="loadDefaults"
            >{{ t('addons.showDefaults') }}</v-btn
          >
        </div>
        <ValuesEditor v-model="valuesTemplate" height="340px" />
        <v-expansion-panels class="mt-3" variant="accordion">
          <v-expansion-panel :title="t('addons.templateExample')">
            <v-expansion-panel-text>
              <YamlViewer :value="VALUES_TEMPLATE_EXAMPLE" height="170px" no-download>
                <template #actions>
                  <v-btn
                    size="small"
                    variant="text"
                    :disabled="!!valuesTemplate"
                    @click="valuesTemplate = VALUES_TEMPLATE_EXAMPLE"
                    >{{ t('addons.useExample') }}</v-btn
                  >
                </template>
              </YamlViewer>
            </v-expansion-panel-text>
          </v-expansion-panel>
          <v-expansion-panel
            v-if="defaults !== null"
            :title="t('addons.defaults', { chart: chartName, version })"
          >
            <v-expansion-panel-text>
              <YamlViewer
                :value="defaults || '# (empty)'"
                height="260px"
                :filename="`${chartName}-values.yaml`"
              >
                <template #actions>
                  <v-btn
                    size="small"
                    variant="text"
                    :disabled="!!valuesTemplate"
                    @click="valuesTemplate = defaults ?? ''"
                    >{{ t('addons.useDefaults') }}</v-btn
                  >
                </template>
              </YamlViewer>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
        <ErrorAlert v-if="browseError" :error="browseError" class="mt-3" />
      </v-col>
    </v-row>

    <template #preview>
      <v-alert
        v-if="lastPreview && lastPreview.matchingClusters.length"
        type="success"
        variant="tonal"
        density="compact"
        class="mb-2"
        data-testid="preview-matching"
      >
        {{ t('addons.installsOn', { clusters: lastPreview.matchingClusters.join(', ') }) }}
      </v-alert>
    </template>
  </ChangeDialog>
</template>
