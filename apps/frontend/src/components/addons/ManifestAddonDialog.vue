<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  checkManifests,
  describeManifestObject,
  MANIFEST_EXAMPLES,
  ManifestAddonSpecSchema,
  type AddonPreview,
  type ManifestAddonSpec,
  type ManifestAddonSpecInput,
  type ManifestChartStatus,
} from '@capi-navigator/shared';
import ChangeDialog from '../ChangeDialog.vue';
import YamlViewer from '../YamlViewer.vue';
import ClusterSelectorField from './ClusterSelectorField.vue';
import ManifestChartAlert from './ManifestChartAlert.vue';
import ValuesEditor from './ValuesEditor.vue';
import { selectorLabels, selectorRows, type SelectorRow } from './selector.js';
import { useAddonsStore } from '../../stores/addons.js';
import FieldHelp from '../FieldHelp.vue';

/**
 * Create or edit a manifest add-on (FP30-F-04 to F-09): plain manifests rolled out through CAAPH
 * with the generic chart; preview and dry run before apply (hard rule 6).
 */
const props = defineProps<{
  connection: string;
  /** Existing add-on to edit; name, namespace and strategy are then fixed. */
  initial?: ManifestAddonSpec;
  /** Namespaces with workload clusters, offered for new add-ons. */
  namespaces: string[];
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ applied: [] }>();
const { t } = useI18n();
const addons = useAddonsStore();

const editing = computed(() => !!props.initial);
const name = ref('');
const namespace = ref('');
const manifests = ref('');
const releaseNamespace = ref('default');
const selector = ref<SelectorRow[]>([]);
const reconcileStrategy = ref<'Continuous' | 'InstallOnce'>('Continuous');
const wait = ref(true);
const timeout = ref('10m0s');
const createNamespace = ref(true);
const chart = ref<ManifestChartStatus | null>(null);
const chartError = ref<unknown>(null);

watch(
  open,
  async (o) => {
    if (!o) return;
    const i = props.initial;
    name.value = i?.name ?? '';
    namespace.value = i?.namespace ?? props.namespaces[0] ?? '';
    manifests.value = i?.manifests ?? '';
    releaseNamespace.value = i?.releaseNamespace ?? 'default';
    selector.value = selectorRows(i?.clusterSelector);
    reconcileStrategy.value = i?.reconcileStrategy ?? 'Continuous';
    wait.value = i?.options.wait ?? true;
    timeout.value = i?.options.timeout ?? '10m0s';
    createNamespace.value = i?.options.createNamespace ?? true;
    chart.value = null;
    chartError.value = null;
    try {
      chart.value = await addons.manifestChart(props.connection);
    } catch (err) {
      chartError.value = err;
    }
  },
  { immediate: true },
);

const spec = (): ManifestAddonSpecInput => ({
  name: name.value.trim(),
  namespace: namespace.value.trim(),
  manifests: manifests.value,
  releaseNamespace: releaseNamespace.value.trim() || 'default',
  clusterSelector: selectorLabels(selector.value),
  reconcileStrategy: reconcileStrategy.value,
  options: {
    wait: wait.value,
    timeout: timeout.value.trim(),
    createNamespace: createNamespace.value,
  },
});
const parsed = computed(() => ManifestAddonSpecSchema.safeParse(spec()));
const fieldErrors = (path: string) =>
  parsed.value.success
    ? []
    : parsed.value.error.issues.filter((i) => i.path.join('.') === path).map((i) => i.message);
/** FP30-F-05: the objects of the manifest while typing, or what is wrong with it. */
const check = computed(() => (manifests.value.trim() ? checkManifests(manifests.value) : null));

const lastPreview = ref<AddonPreview | null>(null);
async function preview() {
  lastPreview.value = await addons.previewManifests(props.connection, spec());
  return lastPreview.value;
}
const apply = (takeOver: boolean) => addons.applyManifests(props.connection, spec(), takeOver);

const hcpField = (field: string) => t('addons.mapsTo', { field });
/** Passed as parameters: braces in messages are vue-i18n syntax. */
const TEMPLATE_HELP = {
  name: '{{ .Cluster.metadata.name }}',
  label: '{{ .Cluster.metadata.labels.env }}',
  open: '{{',
  escaped: '{{ "{{" }}',
};
</script>

<template>
  <ChangeDialog
    v-model="open"
    :title="
      editing
        ? t('manifestAddons.editTitle', { name: initial!.name })
        : t('manifestAddons.newTitle')
    "
    :valid="parsed.success && !!chart?.available"
    :preview="preview"
    :apply="apply"
    :form-width="1100"
    @applied="emit('applied')"
  >
    <ManifestChartAlert :status="chart" :error="chartError" class="mb-3" />
    <v-row density="compact">
      <v-col cols="12" md="5">
        <v-text-field
          v-model="name"
          :label="t('addons.name')"
          :disabled="editing"
          :error-messages="name ? fieldErrors('name').slice(0, 1) : []"
          data-testid="manifest-addon-name"
        >
          <template #append-inner>
            <FieldHelp :text="`${t('manifestAddons.nameHint')} ${hcpField('metadata.name')}`" />
          </template>
        </v-text-field>
        <v-combobox
          v-model="namespace"
          :items="namespaces"
          :label="t('addons.namespace')"
          :disabled="editing"
          data-testid="manifest-addon-namespace"
        >
          <template #append-inner>
            <FieldHelp :text="`${t('addons.namespaceHint')} ${hcpField('metadata.namespace')}`" />
          </template>
        </v-combobox>
        <v-text-field
          v-model="releaseNamespace"
          :label="t('addons.releaseNamespace')"
          :error-messages="fieldErrors('releaseNamespace').slice(0, 1)"
          data-testid="manifest-addon-release-namespace"
        >
          <template #append-inner>
            <FieldHelp
              :text="`${t('manifestAddons.releaseNamespaceHint')} ${hcpField('spec.namespace')}`"
            />
          </template>
        </v-text-field>

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
              :text="`${t('manifestAddons.strategyHint')} ${hcpField('spec.reconcileStrategy')}`"
            />
          </template>
          <v-radio :label="t('manifestAddons.continuous')" value="Continuous" />
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
              :error-messages="fieldErrors('options.timeout').slice(0, 1)"
            >
              <template #append-inner>
                <FieldHelp :text="hcpField('spec.options.timeout')" />
              </template>
            </v-text-field>
          </v-col>
        </v-row>
      </v-col>

      <v-col cols="12" md="7">
        <div class="text-title-small mb-2">
          {{ t('manifestAddons.manifests') }}
          <FieldHelp
            :text="`${t('manifestAddons.manifestsHint')} ${hcpField('spec.valuesTemplate')}`"
          />
        </div>
        <ValuesEditor v-model="manifests" height="360px" data-testid="manifest-addon-manifests" />
        <!-- FP30-F-05, FP30-F-06: checked while typing, again in the backend -->
        <div v-if="check" class="mt-2" data-testid="manifest-addon-check">
          <v-alert v-if="check.errors.length" type="error" variant="tonal" density="compact">
            <div v-for="e in check.errors" :key="e">{{ e }}</div>
          </v-alert>
          <template v-else>
            <span class="text-body-small text-medium-emphasis mr-2">{{
              t('manifestAddons.objects', { count: check.objects.length })
            }}</span>
            <v-chip
              v-for="o in check.objects"
              :key="describeManifestObject(o)"
              size="x-small"
              variant="outlined"
              class="mr-1 mb-1"
              >{{ describeManifestObject(o) }}</v-chip
            >
          </template>
        </div>
        <v-alert type="info" variant="tonal" density="compact" class="mt-3">
          {{ t('manifestAddons.secretsInfo') }}
        </v-alert>
        <v-expansion-panels class="mt-3" variant="accordion">
          <v-expansion-panel
            v-for="e in MANIFEST_EXAMPLES"
            :key="e.id"
            :title="t('manifestAddons.example', { title: e.title })"
          >
            <v-expansion-panel-text>
              <YamlViewer :value="e.manifests" height="220px" no-download>
                <template #actions>
                  <v-btn
                    size="small"
                    variant="text"
                    :disabled="!!manifests.trim()"
                    :data-testid="`use-example-${e.id}`"
                    @click="manifests = e.manifests"
                    >{{ t('addons.useExample') }}</v-btn
                  >
                </template>
              </YamlViewer>
            </v-expansion-panel-text>
          </v-expansion-panel>
          <v-expansion-panel :title="t('manifestAddons.templates')">
            <v-expansion-panel-text class="text-body-medium">
              {{ t('manifestAddons.templatesHelp', TEMPLATE_HELP) }}
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
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
